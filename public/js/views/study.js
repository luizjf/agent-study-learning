import { get, post, del } from '../api.js';
import { h, icon, toast, pct, sourceLabel, sourceLink, fmtTime, timeAgo, confirmDialog } from '../ui.js';

// Aviso dos agentes (Cartógrafo + Examinador) lendo o conteúdo inteiro em segundo plano.
function agentBanner(study, ctx) {
  const d = study.deep;
  if (!d?.status || (d.status === 'done' && Date.now() - (d.finishedAt || 0) > 10 * 60 * 1000)) return null;
  if (d.status === 'running') {
    const min = d.startedAt ? Math.max(0, Math.round((Date.now() - d.startedAt) / 60000)) : 0;
    const order = ['estudar', 'perguntar', 'auditar'];
    const step = (key, label) => h('li', { class: d.stage === key ? 'doing' : order.indexOf(key) < order.indexOf(d.stage) ? 'done' : '' }, h('span', { class: 'dot' }), label);
    return h('div', { class: 'agent-banner', role: 'status' }, h('span', { class: 'pulse' }),
      h('div', {}, h('b', {}, 'Primeiro estudar, depois perguntar'),
        h('ol', { class: 'pipeline', style: { margin: '6px 0' } },
          step('estudar', 'Cartógrafo estuda o conteúdo inteiro: conceitos, pré-requisitos e o essencial'),
          step('perguntar', 'Examinador escreve as perguntas sobre o que foi estudado'),
          d.stage === 'auditar' ? step('auditar', 'Auditor confere se nenhuma alternativa se entrega pela forma') : null),
        h('p', {}, `A prova abre assim que as perguntas ficarem prontas (1 a 3 min${min ? `; já foram ${min}` : ''}), via ${d.provider}. Enquanto isso, assista ao vídeo ou faça anotações — esta página se atualiza sozinha.`)));
  }
  if (d.status === 'failed') {
    return h('div', { class: 'agent-banner failed', role: 'status' }, h('span', { class: 'pulse' }),
      h('div', {}, h('b', {}, 'Os agentes não conseguiram estudar o conteúdo'),
        h('p', {}, (d.error || 'Erro desconhecido.') + ' Abaixo está a versão básica, feita sem IA: perguntas só sobre definições e justificativas encontradas no texto. Tente "Refazer com os agentes".')));
  }
  return h('div', { class: 'agent-banner done', role: 'status' }, h('span', { class: 'pulse' }),
    h('div', {}, h('b', {}, 'Conteúdo estudado, prova escrita'),
      h('p', {}, `O Cartógrafo (${study.mapBy}) estudou o conteúdo inteiro; o Examinador (${study.questionsBy}) escreveu as perguntas sobre ele e o Auditor conferiu que nenhuma alternativa se entrega pela forma.`)));
}

async function removeStudy(study, ctx) {
  const own = study.isOwner;
  const ok = await confirmDialog({
    title: own ? 'Excluir este estudo?' : 'Tirar este estudo da sua mesa?',
    body: own
      ? `“${study.title}” some de vez: perguntas, provas feitas, anotações, mapa e turmas ligadas a ele. Não dá para desfazer.`
      : 'Suas provas, anotações e progresso neste estudo serão apagados, e você sai da turma. O estudo continua existindo para o professor.',
    confirm: own ? 'Excluir de vez' : 'Tirar da mesa', danger: true,
  });
  if (!ok) return false;
  await del('/studies/' + study.id);
  toast(own ? 'Estudo excluído.' : 'Estudo tirado da sua mesa.');
  return true;
}
export { removeStudy };

export function notesPanel(study, { conceptId = null, getTime = null, compact = false } = {}) {
  const list = h('div', { class: 'notes' });
  const input = h('textarea', { rows: compact ? 3 : 4, placeholder: 'Anote com suas palavras… (Ctrl+Enter salva)', 'aria-label': 'Nova anotação' });
  const conceptSel = h('select', { 'aria-label': 'Ligar a um conceito' },
    h('option', { value: '' }, 'sem conceito'),
    study.graph.nodes.map(n => h('option', { value: n.id, selected: n.id === conceptId }, n.label)));
  const labelOf = id => study.graph.nodes.find(n => n.id === id)?.label;

  const draw = (notes) => list.replaceChildren(...(notes.length ? notes : []).map(n => h('div', { class: 'note' },
    n.text,
    h('div', { class: 'meta' },
      n.concept_id ? h('span', { class: 'chip' }, labelOf(n.concept_id)) : null,
      n.ts != null && study.videoId ? h('a', { class: 'ts-link', href: `https://www.youtube.com/watch?v=${study.videoId}&t=${Math.floor(n.ts)}s`, target: '_blank', rel: 'noopener' }, fmtTime(n.ts)) : null,
      h('span', {}, timeAgo(n.created_at)),
      h('button', { onclick: async () => { await del('/notes/' + n.id); load(); } }, 'apagar')))));
  const load = async () => {
    const { notes } = await get(`/studies/${study.id}/notes`);
    draw(conceptId ? notes.filter(n => n.concept_id === conceptId) : notes);
  };
  const save = async () => {
    if (!input.value.trim()) return;
    const ts = getTime ? getTime() : null;
    const r = await post(`/studies/${study.id}/notes`, { text: input.value, conceptId: conceptSel.value || conceptId || null, ts });
    if (r.badge) toast(`Conquista: ${r.badge.name}!`);
    input.value = '';
    load();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
  load();
  return h('div', { class: 'stack' },
    input,
    h('div', { class: 'row' }, conceptId ? null : conceptSel, h('button', { class: 'btn small', onclick: save }, 'Guardar anotação'),
      getTime ? h('small', { class: 'muted' }, 'marca o minuto do vídeo') : null),
    list);
}

export async function studyView(ctx, [id]) {
  const { study } = await get('/studies/' + id);
  const teacher = ctx.user.role === 'professor' && study.isOwner;
  const total = Object.values(study.questionCounts).reduce((a, b) => a + b, 0);
  const minutes = Math.max(5, Math.round(total * 1.2));
  const known = study.graph.nodes.filter(n => n.mastery?.score >= 0.75).length;
  const weak = study.graph.nodes.filter(n => n.mastery && n.mastery.score < 0.75).length;

  let player = null;
  let startedAt = null;
  if (study.videoId) {
    player = h('iframe', { class: 'video', src: `https://www.youtube-nocookie.com/embed/${study.videoId}?rel=0`, title: study.title, allow: 'encrypted-media; picture-in-picture', allowfullscreen: true, loading: 'lazy' });
    startedAt = Date.now();
  }
  const seekTo = (sec) => { if (player) { player.src = `https://www.youtube-nocookie.com/embed/${study.videoId}?rel=0&autoplay=1&start=${Math.floor(sec)}`; startedAt = Date.now() - sec * 1000; } };
  // Estimativa simples do minuto atual (sem API do player, que exigiria script externo)
  const getTime = player ? () => Math.max(0, (Date.now() - startedAt) / 1000) : null;

  const deepBtn = study.isOwner && study.deep?.available && study.deep.status !== 'running'
    ? h('button', {
      class: 'btn soft small', html: icon.spark + ' Refazer com os agentes',
      title: 'Cartógrafo e Examinador leem o conteúdo inteiro e escrevem mapa e prova novos',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await post(`/studies/${study.id}/deepen`); ctx.route(); } catch (err) { toast(err.message, 'bad'); e.currentTarget.disabled = false; }
      },
    }) : null;
  const studying = study.deep?.status === 'running';
  const basic = study.questionsBy === 'local';
  const actions = studying ? h('div', { class: 'card stack' },
    h('h2', {}, 'A prova está sendo escrita'),
    h('p', { class: 'muted', style: { margin: 0 } }, 'As perguntas serão sobre o conteúdo — conceitos, porquês e aplicações —, não sobre frases do vídeo.'),
    h('button', { class: 'btn accent', disabled: true }, 'Aguardando o Examinador…'),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'btn ghost small danger-text', html: icon.trash + (study.isOwner ? ' Excluir estudo' : ' Tirar da minha mesa'),
        onclick: async () => { if (await removeStudy(study, ctx)) ctx.go('/'); },
      }))) : h('div', { class: 'card stack' },
    h('h2', {}, 'Pronto para provar?'),
    basic ? h('p', { class: 'muted', style: { margin: 0, fontSize: '.85rem' } }, study.deep?.available
      ? 'Versão básica (sem IA). Para perguntas de compreensão, use "Refazer com os agentes".'
      : 'Versão básica (sem IA): perguntas sobre definições e justificativas do texto. Para o sistema estudar o conteúdo e perguntar sobre ele, ligue os agentes (npm run start:pro).') : null,
    h('p', { class: 'muted', style: { margin: 0 } }, `${total} perguntas · uns ${minutes} min · em rodadas de 5 com pausa curta`),
    h('div', { class: 'tag-line', style: { margin: 0 } },
      study.questionCounts.mc ? h('span', { class: 'chip' }, `${study.questionCounts.mc} múltipla escolha`) : null,
      study.questionCounts.reasoning ? h('span', { class: 'chip' }, `${study.questionCounts.reasoning} raciocínio`) : null,
      study.questionCounts.code ? h('span', { class: 'chip ink' }, `${study.questionCounts.code} código`) : null,
      study.questionCounts.interview ? h('span', { class: 'chip warn' }, '1 entrevista') : null),
    h('a', { class: 'btn accent', href: `#/prova/${study.id}`, html: icon.play + ' Começar a prova' }),
    weak ? h('a', { class: 'btn soft', href: `#/prova/${study.id}?modo=revisao` }, `Revisar só os ${weak} pontos fracos`) : null,
    h('div', { class: 'row' },
      h('a', { class: 'btn ghost small', href: `#/mapa/${study.id}`, html: icon.map + ' Mapa mental' }),
      h('a', { class: 'btn ghost small', href: `#/ensinar/${study.id}` }, 'Ensinar de volta')),
    teacher ? h('div', { class: 'stack', style: { borderTop: '1.5px dashed var(--line)', paddingTop: '14px' } },
      h('b', {}, 'Professor'),
      h('div', { class: 'row' },
        h('a', { class: 'btn soft small', href: `#/questoes/${study.id}` }, 'Revisar questões'),
        h('button', {
          class: 'btn soft small',
          onclick: async () => {
            const { room } = await post('/rooms', { studyId: study.id, name: study.title });
            ctx.go('/turma/' + room.code);
          },
        }, 'Abrir turma'))) : null,
    deepBtn ? h('div', { class: 'row' }, deepBtn) : null,
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'btn ghost small danger-text', html: icon.trash + (study.isOwner ? ' Excluir estudo' : ' Tirar da minha mesa'),
        onclick: async () => { if (await removeStudy(study, ctx)) ctx.go('/'); },
      })));

  const attempts = study.attempts.length ? h('div', { class: 'card' },
    h('h3', {}, 'Suas tentativas'),
    h('table', {}, h('tbody', {}, study.attempts.map(a => h('tr', {},
      h('td', {}, a.finished_at ? h('a', { href: `#/resultado/${a.id}` }, timeAgo(a.started_at)) : timeAgo(a.started_at) + ' (não terminada)'),
      h('td', {}, a.mode === 'review' ? 'revisão' : 'completa'),
      h('td', {}, a.score != null ? h('span', { class: 'chip ' + (a.passed ? 'ok' : 'bad') }, pct(a.score)) : '—')))))) : null;

  const root = h('div', {},
    h('a', { href: '#/', class: 'muted', style: { fontSize: '.85rem' } }, '← mesa'),
    h('h1', { style: { marginTop: '6px' } }, study.title),
    h('div', { class: 'tag-line' },
      h('span', { class: 'chip' }, sourceLabel(study.sourceType)),
      h('span', { class: 'chip' }, `${study.words} palavras`),
      studying ? null : h('span', { class: 'chip' }, `${study.graph.nodes.length} conceitos`),
      known ? h('span', { class: 'chip ok' }, `${known} dominados`) : null,
      study.technical ? h('span', { class: 'chip ink' }, `código: ${study.codeLang}`) : null,
      study.sourceUrl ? h('a', { class: 'chip', href: study.sourceUrl, target: '_blank', rel: 'noopener' }, 'abrir fonte ↗') : null,
      studying ? null : h('span', { class: 'chip' + (!basic ? ' ok' : ''), title: 'Quem escreveu as perguntas' }, !basic ? 'perguntas: Examinador' : 'perguntas: versão básica')),
    agentBanner(study, ctx),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'stack' },
        player,
        studying ? h('div', { class: 'card' }, h('h2', {}, 'O essencial'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'Aparece aqui assim que o Cartógrafo terminar de estudar o conteúdo, com o minuto de cada ideia.')) : null,
        studying ? null : h('div', { class: 'card' },
          h('h2', {}, study.summary.some(s => s.rewritten) ? 'O essencial' : 'O essencial em 5 frases'),
          h('ol', { style: { paddingLeft: '1.2em', margin: 0 } }, study.summary.map(s => h('li', { style: { marginBottom: '8px' } }, s.text, ' ',
            s.start != null && player ? h('button', { class: 'ts-link', onclick: () => seekTo(s.start) }, s.at) : sourceLink(s, study))))),
        studying ? null : h('div', { class: 'card' },
          h('h2', {}, 'Conceitos, do básico ao topo'),
          h('div', { class: 'tag-line' }, [...study.graph.nodes].sort((a, b) => a.level - b.level).map(n =>
            h('a', { class: 'chip ' + (!n.mastery ? '' : n.mastery.score >= 0.75 ? 'ok' : n.mastery.score >= 0.5 ? 'warn' : 'bad'), href: `#/mapa/${study.id}?c=${n.id}`, title: n.tier }, n.label))))),
      h('div', { class: 'stack' },
        actions,
        h('div', { class: 'card' }, h('h3', {}, 'Anotações'), notesPanel(study, { getTime })),
        attempts)));

  // Enquanto os agentes trabalham, confere a cada 5 s; quando terminam, redesenha a página.
  if (study.deep?.status === 'running') {
    const timer = setInterval(async () => {
      if (!document.body.contains(root)) return clearInterval(timer);
      try {
        const { study: now } = await get('/studies/' + id);
        if (now.deep?.status !== 'running') {
          clearInterval(timer);
          toast(now.deep?.status === 'done' ? 'Prova pronta: o Examinador terminou as perguntas.' : 'Os agentes não conseguiram; ficou a versão básica.', now.deep?.status === 'done' ? '' : 'bad');
          ctx.route();
        } else if (now.deep?.stage !== study.deep.stage) {
          clearInterval(timer);
          ctx.route(); // mudou de etapa: estudar → perguntar
        }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
  }
  return root;
}
