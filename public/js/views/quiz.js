import { get, post, store } from '../api.js';
import { h, icon, highlight, toast, words, sourceLink } from '../ui.js';
import { prefs, savePrefs, sound, speak, stopSpeaking, watchReturn, floatXp } from '../focus.js';
import { codeEditor } from '../code.js';

const KIND_LABEL = {
  cloze: 'Complete', statement: 'Verdadeiro ou não?', definition: 'Definição', relation: 'Conexões', prerequisite: 'O que vem antes',
  cause: 'Por quê?', consequence: 'Consequência', number: 'Números', explain: 'Explique', why: 'Raciocínio', write: 'Código', boss: 'Entrevista',
  // escritas pelo Examinador
  definicao: 'Definição', compreensao: 'Compreensão', aplicacao: 'Aplicação', analise: 'Análise', causa: 'Por quê?',
  comparacao: 'Comparação', numero: 'Números', cenario: 'Cenário', codigo: 'Código', entrevista: 'Entrevista',
};
const TYPE_LABEL = { mc: 'Múltipla escolha', reasoning: 'Raciocínio', code: 'Código', interview: 'Entrevista' };

export async function quizView(ctx, [studyId], query) {
  const { study } = await get('/studies/' + studyId);
  const mode = query.get('modo') === 'revisao' ? 'review' : 'full';
  const roomCode = query.get('turma') || undefined;
  const saveKey = `attempt.${studyId}.${mode}`;
  const root = h('div', {});
  document.getElementById('app').className = 'focus';

  // ---- retomar prova interrompida (fechou a aba, acabou a bateria…)
  const saved = store.local(saveKey, null);
  if (saved && Date.now() - saved.at < 6 * 3600 * 1000) {
    try {
      const { result } = await get('/attempts/' + saved.attempt.id);
      if (!result.finished) {
        const answered = result.items.filter(i => i.answered).length;
        root.append(h('div', { class: 'card stack', style: { textAlign: 'center' } },
          h('h2', {}, 'Você tinha parado no meio.'),
          h('p', {}, `Já respondeu ${answered} de ${result.items.length}. Quer continuar daí?`),
          h('div', { class: 'row', style: { justifyContent: 'center' } },
            h('button', { class: 'btn accent', onclick: () => run(saved.attempt, result.items) }, 'Continuar'),
            h('button', { class: 'btn ghost', onclick: () => { store.setLocal(saveKey, null); start(); } }, 'Começar de novo'))));
        return root;
      }
    } catch { /* tentativa antiga sumiu: começa outra */ }
  }
  await start();
  return root;

  async function start() {
    const { attempt } = await post(`/studies/${studyId}/attempts`, { mode, roomCode });
    store.setLocal(saveKey, { attempt, at: Date.now() });
    run(attempt, []);
  }

  function run(attempt, priorItems) {
    const P = prefs();
    const qs = attempt.questions;
    const results = new Map();
    for (const it of priorItems) if (it.answered) results.set(it.id, { score: it.score, correct: it.score >= 0.75 });
    let idx = qs.findIndex(q => !results.has(q.id));
    if (idx < 0) idx = qs.length;
    let combo = 0;
    let roundStart = Date.now();
    let busy = false;
    let hintUsed = false;
    let qStart = Date.now();
    let editor = null;
    let keyHandler = null;
    let tick = null;

    const progress = h('div', { class: 'progress', 'aria-hidden': 'true' });
    const comboEl = h('div', { class: 'combo', 'aria-live': 'polite' });
    const timerEl = h('small', { class: 'muted mono' });
    const stage = h('div', {});
    const head = h('div', { class: 'quiz-head' },
      h('a', { href: `#/estudo/${studyId}`, class: 'icon-btn', title: 'Sair (o progresso fica salvo)', html: icon.back }),
      progress, P.timer ? timerEl : null, comboEl);
    root.replaceChildren(head, stage);

    const paintProgress = () => {
      progress.replaceChildren(...qs.map((q, i) => {
        const r = results.get(q.id);
        const cls = r ? (r.score >= 0.75 ? 'ok' : r.score >= 0.4 ? 'mid' : 'bad') : i === idx ? 'cur' : '';
        return h('i', { class: cls + (i > 0 && i % P.roundSize === 0 ? ' gap' : '') });
      }));
      comboEl.textContent = combo >= 2 ? `×${combo}` : '';
      comboEl.title = combo >= 2 ? `${combo} acertos seguidos` : '';
    };
    if (P.timer) {
      tick = setInterval(() => { const s = Math.floor((Date.now() - roundStart) / 1000); timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} na rodada`; }, 1000);
    }

    const stopReturn = watchReturn((secs) => {
      if (idx >= qs.length) return;
      const q = qs[idx];
      const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'card stack' },
          h('h2', {}, 'De volta!'),
          h('p', {}, `Você ficou ${Math.round(secs / 60) >= 1 ? Math.round(secs / 60) + ' min' : Math.round(secs) + ' s'} fora. Tudo certo — você está na questão ${idx + 1} de ${qs.length}.`),
          q.highlight?.length ? h('p', { class: 'muted' }, 'Ela é sobre ', h('mark', {}, q.highlight[0]), '.') : null,
          h('button', { class: 'btn', onclick: () => ov.remove() }, 'Continuar')));
      document.body.append(ov);
      ov.querySelector('button').focus();
    });
    ctx.onLeave(() => { stopReturn(); clearInterval(tick); if (keyHandler) document.removeEventListener('keydown', keyHandler); editor?.destroy(); stopSpeaking(); document.querySelectorAll('.overlay').forEach(o => o.remove()); });

    const setKeys = (fn) => {
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      keyHandler = (e) => {
        if (document.querySelector('.overlay')) return;
        const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName);
        fn(e, typing);
      };
      document.addEventListener('keydown', keyHandler);
    };

    const next = () => {
      idx++;
      stopSpeaking();
      const roundDone = idx % P.roundSize === 0 && idx < qs.length;
      if (idx >= qs.length) return finish();
      if (roundDone && P.breakSeconds > 0) return showBreak();
      if (qs[idx].type === 'interview') return showBoss();
      show();
    };

    function showBreak() {
      const lastRound = qs.slice(idx - P.roundSize, idx);
      const right = lastRound.filter(q => (results.get(q.id)?.score ?? 0) >= 0.75).length;
      let left = P.breakSeconds;
      const count = h('div', { class: 'breath' }, String(left));
      const iv = setInterval(() => { left--; count.textContent = left > 0 ? String(left) : '✓'; if (left <= 0) { clearInterval(iv); go(); } }, 1000);
      const go = () => { clearInterval(iv); roundStart = Date.now(); qs[idx].type === 'interview' ? showBoss() : show(); };
      ctx.onLeave(() => clearInterval(iv));
      paintProgress();
      stage.replaceChildren(h('div', { class: 'card break' },
        h('h2', {}, `Rodada ${Math.ceil(idx / P.roundSize)} concluída`),
        h('p', {}, right === lastRound.length ? 'Todas certas. Que embalo!' : `${right} de ${lastRound.length} certas.`, ' Respire junto com o círculo, ou alongue os ombros.'),
        count,
        h('button', { class: 'btn', onclick: go }, 'Pular a pausa ', h('span', { class: 'kbd' }, 'Enter'))));
      setKeys((e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    }

    function showBoss() {
      paintProgress();
      stage.replaceChildren(h('div', { class: 'card break' },
        h('h2', {}, 'Última: a pergunta de entrevista'),
        h('p', { style: { maxWidth: '46ch', margin: '0 auto 20px' } }, 'Responda como se estivesse falando com alguém da área. Explique, dê um exemplo e mostre um cuidado ou limitação. Não precisa ser perfeito.'),
        h('button', { class: 'btn accent', onclick: show }, 'Estou pronto ', h('span', { class: 'kbd' }, 'Enter'))));
      setKeys((e) => { if (e.key === 'Enter') { e.preventDefault(); show(); } });
    }

    function show() {
      const q = qs[idx];
      hintUsed = false;
      qStart = Date.now();
      editor?.destroy();
      editor = null;
      paintProgress();
      const prompt = h('div', { class: 'prompt', html: highlight(q.prompt, q.highlight) });
      const hintBox = h('div', {});
      const tools = h('div', { class: 'toolbar' },
        P.voice && 'speechSynthesis' in window ? h('button', { class: 'icon-btn', title: 'Ouvir a pergunta (L)', html: icon.speak + 'Ouvir', onclick: () => speak(q.prompt + (q.options ? '. Opções: ' + q.options.map((o, i) => 'ABCD'[i] + ', ' + o).join('. ') : '')) }) : null,
        h('button', { class: 'icon-btn', title: q.type === 'mc' ? 'Dica: tira duas alternativas erradas (vale metade do XP) — tecla H' : 'Dica: mostra o trecho da fonte com os termos apagados (vale metade do XP) — tecla H', html: icon.bulb + 'Estou travado', onclick: hint }),
        h('span', { class: 'spacer' }),
        h('small', { class: 'muted' }, `${idx + 1} de ${qs.length}`));
      async function hint() {
        if (hintUsed) return;
        hintUsed = true;
        try {
          const r = await get(`/attempts/${attempt.id}/hint/${encodeURIComponent(q.id)}`);
          hintBox.replaceChildren(h('div', { class: 'feedback' }, h('b', {}, 'Dica: '), r.hint));
          // 50/50: risca duas alternativas erradas
          for (const i of r.eliminate || []) { const o = stage.querySelectorAll('.opt')[i]; if (o) { o.classList.add('eliminated'); o.disabled = true; o.setAttribute('aria-disabled', 'true'); } }
        } catch (err) { toast(err.message, 'bad'); }
      }

      const card = h('div', { class: 'card qcard' + (q.type === 'interview' ? ' boss' : '') },
        h('div', { class: 'kind' }, TYPE_LABEL[q.type], ' · ', KIND_LABEL[q.kind] || ''),
        prompt);

      if (q.type === 'mc') {
        const opts = q.options.map((o, i) => h('button', { class: 'opt', onclick: () => answer(i, opts) },
          h('span', { class: 'letter' }, 'ABCD'[i]), h('span', {}, o)));
        card.append(h('div', { class: 'options', role: 'group', 'aria-label': 'Alternativas' }, opts), hintBox, tools);
        setKeys((e, typing) => {
          if (typing || busy) return;
          const k = e.key.toLowerCase();
          const n = '1234'.indexOf(k) >= 0 ? '1234'.indexOf(k) : 'abcd'.indexOf(k);
          if (n >= 0 && n < opts.length && !opts[n].disabled) { e.preventDefault(); answer(n, opts); }
          else if (k === 'l') speak(q.prompt);
          else if (k === 'h') hint();
        });
        stage.replaceChildren(card);
        opts[0].focus({ preventScroll: true });
      } else {
        let input;
        const counter = h('div', { class: 'wordcount' });
        const updateCount = (v) => {
          if (!q.minWords) return;
          const w = words(v);
          counter.replaceChildren(h('span', { class: 'meter' }, h('i', { style: { width: Math.min(100, w / q.minWords * 100) + '%', background: w >= q.minWords ? 'var(--ok)' : 'var(--accent)' } })),
            `${w} / ${q.minWords} palavras`);
        };
        if (q.type === 'code') {
          editor = codeEditor({ lang: q.lang });
          input = editor;
          card.append(editor.el);
        } else {
          const ta = h('textarea', { rows: q.type === 'interview' ? 9 : 6, placeholder: q.type === 'interview' ? 'Fale como numa conversa: o que é, quando usar, um exemplo e um cuidado…' : 'Explique com suas palavras…', 'aria-label': 'Sua resposta' });
          ta.addEventListener('input', () => updateCount(ta.value));
          input = { get value() { return ta.value; }, focus: () => ta.focus() };
          card.append(ta, counter);
          updateCount('');
        }
        const send = h('button', { class: 'btn', onclick: () => answerOpen(input.value, send) }, 'Enviar resposta ', h('span', { class: 'kbd' }, 'Ctrl+Enter'));
        card.append(h('div', { class: 'toolbar' }, send), hintBox, tools);
        setKeys((e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); answerOpen(input.value, send); } });
        stage.replaceChildren(card);
        input.focus();
      }

      async function answer(choice, opts) {
        if (busy) return;
        busy = true;
        opts.forEach(o => { o.disabled = true; });
        try {
          const { result, user } = await post(`/attempts/${attempt.id}/answer`, { questionId: q.id, response: choice, hintUsed, ms: Date.now() - qStart });
          ctx.setUser(user);
          results.set(q.id, result);
          combo = result.combo;
          opts.forEach((o, i) => { if (i === result.correctOption) o.classList.add('right'); else if (i === choice) o.classList.add('wrong'); else o.classList.add('dim'); });
          reward(result, opts[choice]);
          showFeedback(card, result, q);
        } catch (err) {
          toast(err.message, 'bad');
          opts.forEach(o => { if (!o.classList.contains('eliminated')) o.disabled = false; });
        } finally { busy = false; }
      }

      async function answerOpen(value, btn) {
        if (busy) return;
        if (!String(value).trim()) { toast('Escreva algo antes de enviar — mesmo que incompleto.'); return; }
        busy = true;
        btn.disabled = true;
        btn.textContent = 'Corrigindo…';
        try {
          const { result, user } = await post(`/attempts/${attempt.id}/answer`, { questionId: q.id, response: value, hintUsed, ms: Date.now() - qStart });
          ctx.setUser(user);
          results.set(q.id, result);
          combo = result.combo;
          btn.remove();
          reward(result, card);
          showFeedback(card, result, q);
        } catch (err) {
          toast(err.message, 'bad');
          btn.disabled = false;
          btn.textContent = 'Enviar resposta';
        } finally { busy = false; }
      }
    }

    function reward(result, anchor) {
      paintProgress();
      if (result.correct) {
        sound(result.chest ? 'chest' : combo >= 3 ? 'combo' : 'ok');
        if (combo >= 2) { comboEl.classList.remove('pop'); void comboEl.offsetWidth; comboEl.classList.add('pop'); }
      } else sound('bad');
      if (anchor) floatXp(anchor, `+${result.xp} XP`);
      if (result.chest) toast(`Baú surpresa: +${result.chest} XP extras!`);
    }

    function showFeedback(card, r, q) {
      const kind = r.score >= 0.75 ? 'ok' : r.score >= 0.4 ? 'mid' : 'bad';
      const title = q.type === 'mc'
        ? (r.correct ? pick(['Isso!', 'Certo.', 'Exato.', 'Na mosca.']) : 'Não foi dessa vez.')
        : (r.score >= 0.75 ? `Boa resposta (${Math.round(r.score * 100)}%).` : r.score >= 0.4 ? `Quase lá (${Math.round(r.score * 100)}%).` : `Precisa de mais (${Math.round(r.score * 100)}%).`);
      const fb = h('div', { class: 'feedback ' + kind, role: 'status' },
        h('h4', {}, title, combo >= 3 && r.correct ? h('small', { class: 'muted' }, `  ${combo} seguidas`) : null),
        q.type !== 'mc' ? h('p', { style: { margin: 0 } }, r.feedback) : null,
        r.found?.length ? h('div', { class: 'tag-line', style: { marginTop: '8px' } }, r.found.map(f => h('span', { class: 'chip ok' }, '✓ ' + f)), (r.missing || []).map(m => h('span', { class: 'chip bad' }, '— ' + m))) : null,
        r.strengths?.length ? h('p', { style: { margin: '8px 0 0' } }, h('b', {}, 'Pontos fortes: '), r.strengths.join('; ')) : null,
        q.type === 'mc' && r.explanation ? h('div', { class: 'src' }, r.explanation, ' ', sourceLink(r.source, study)) : null,
        q.type !== 'mc' && r.expected ? h('details', {}, h('summary', {}, 'Ver o que a fonte diz'), h('p', { style: { margin: '6px 0 0' } }, r.expected), sourceLink(r.source, study)) : null,
        r.by && r.by !== 'local' ? h('small', { class: 'muted' }, `corrigido com ${r.by}`) : null);
      const cont = h('button', { class: 'btn', onclick: next }, idx + 1 >= qs.length ? 'Ver resultado ' : 'Continuar ', h('span', { class: 'kbd' }, 'Enter'));
      card.querySelectorAll('.toolbar').forEach(t => t.remove());
      card.append(fb, h('div', { class: 'toolbar' }, cont));
      cont.focus({ preventScroll: true });
      fb.scrollIntoView({ block: 'nearest', behavior: prefs().motion ? 'smooth' : 'auto' });
      setKeys((e, typing) => { if (e.key === 'Enter' && (!typing || e.ctrlKey)) { e.preventDefault(); next(); } });
    }

    async function finish() {
      if (keyHandler) document.removeEventListener('keydown', keyHandler);
      clearInterval(tick);
      stage.replaceChildren(h('div', { class: 'card break' }, h('h2', {}, 'Somando tudo…')));
      try {
        const { result, user } = await post(`/attempts/${attempt.id}/finish`);
        ctx.setUser(user);
        store.setLocal(saveKey, null);
        sound('done');
        ctx.go('/resultado/' + result.id);
      } catch (err) { toast(err.message, 'bad'); }
    }

    if (idx >= qs.length) finish();
    else if (qs[idx].type === 'interview') showBoss();
    else show();
  }
}

const pick = a => a[Math.floor(Math.random() * a.length)];
export { savePrefs };
