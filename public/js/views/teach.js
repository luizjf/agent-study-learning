import { get, post } from '../api.js';
import { h, icon, toast, words } from '../ui.js';
import { sound } from '../focus.js';

// Inversão de papéis (técnica Feynman): o aluno vira professor do "Pipoca",
// um colega que pergunta o que ficou faltando. Sem token: usa o mapa de conceitos.
export async function teachView(ctx, [studyId], query) {
  const { study } = await get('/studies/' + studyId);
  const nodes = [...study.graph.nodes].sort((a, b) => a.level - b.level);
  let current = nodes.find(n => n.id === query.get('c')) || nodes.find(n => !n.mastery || n.mastery.score < 0.75) || nodes[0];
  const chips = h('div', { class: 'tag-line' });
  const bubble = h('div', { class: 'bubble', 'aria-live': 'polite' });
  const ta = h('textarea', { rows: 7, placeholder: 'Explique como se estivesse falando com um colega que faltou na aula…', 'aria-label': 'Sua explicação' });
  const count = h('small', { class: 'muted' }, '0 palavras');
  ta.addEventListener('input', () => { count.textContent = words(ta.value) + ' palavras'; });
  const log = h('div', { class: 'stack' });

  const drawChips = () => chips.replaceChildren(...nodes.map(n => h('button', {
    class: 'chip ' + (n.id === current.id ? 'ink' : n.mastery?.score >= 0.75 ? 'ok' : ''),
    'aria-pressed': String(n.id === current.id),
    onclick: () => { current = n; drawChips(); intro(); },
  }, n.label)));
  const intro = () => {
    bubble.textContent = `Oi! Eu faltei na parte de «${current.label}». Pode me explicar com suas palavras? Não vale copiar do material, hein.`;
    log.replaceChildren();
    ta.value = '';
    count.textContent = '0 palavras';
    ta.focus();
  };
  const send = async () => {
    if (!ta.value.trim()) return;
    try {
      const r = await post(`/studies/${studyId}/teach`, { conceptId: current.id, text: ta.value });
      bubble.textContent = r.reply;
      sound(r.score >= 0.75 ? 'ok' : 'bad');
      log.prepend(h('div', { class: 'feedback ' + (r.score >= 0.75 ? 'ok' : r.score >= 0.4 ? 'mid' : 'bad') },
        h('b', {}, `Clareza: ${Math.round(r.score * 100)}%  ·  +${r.xp} XP`),
        h('div', { class: 'tag-line', style: { marginTop: '6px' } }, r.found.map(f => h('span', { class: 'chip ok' }, '✓ ' + f)), r.missing.map(m => h('span', { class: 'chip bad' }, '? ' + m)))));
      if (r.badge) toast(`Conquista: ${r.badge.name}!`);
      ctx.refreshUser();
    } catch (err) { toast(err.message, 'bad'); }
  };
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  drawChips();
  intro();

  return h('div', { style: { maxWidth: '760px', margin: '0 auto' } },
    h('a', { href: `#/estudo/${studyId}`, class: 'muted', style: { fontSize: '.85rem' } }, '← ' + study.title),
    h('h1', { style: { marginTop: '6px' } }, 'Ensinar de volta'),
    h('p', { class: 'muted' }, 'Explicar para alguém é o teste mais honesto de que você entendeu. Escolha um conceito:'),
    chips,
    h('div', { class: 'card stack', style: { marginTop: '16px' } },
      h('div', { class: 'pupil', html: icon.pupil }, bubble),
      ta,
      h('div', { class: 'row between' }, count, h('button', { class: 'btn', onclick: send }, 'Explicar ', h('span', { class: 'kbd' }, 'Ctrl+Enter')))),
    log);
}
