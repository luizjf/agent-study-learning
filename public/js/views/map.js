import { get } from '../api.js';
import { h, sourceLink, pct } from '../ui.js';
import { drawMap } from '../mindmap.js';
import { notesPanel } from './study.js';

export async function mapView(ctx, [studyId], query) {
  const { study } = await get('/studies/' + studyId);
  const wrap = h('div', { class: 'map-wrap' });
  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Detalhes do conceito' });
  const total = study.graph.nodes.length;
  const ok = study.graph.nodes.filter(n => n.mastery?.score >= 0.75).length;

  const openConcept = async (n) => {
    drawer.classList.add('open');
    drawer.replaceChildren(h('p', { class: 'muted' }, 'Carregando…'));
    const { concept: c } = await get(`/studies/${studyId}/concepts/${n.id}`);
    drawer.replaceChildren(h('div', {},
      h('div', { class: 'row between' }, h('span', { class: 'chip' }, c.tier), h('button', { class: 'icon-btn', onclick: () => drawer.classList.remove('open'), 'aria-label': 'Fechar' }, 'fechar ✕')),
      h('h2', { style: { marginTop: '12px' } }, c.label),
      c.mastery ? h('p', {}, h('span', { class: 'chip ' + (c.mastery.score >= 0.75 ? 'ok' : c.mastery.score >= 0.5 ? 'warn' : 'bad') }, 'domínio ' + pct(c.mastery.score)),
        h('small', { class: 'muted' }, `  próxima revisão: ${c.mastery.due?.split('-').reverse().join('/')}`)) : h('p', { class: 'muted' }, 'Ainda não caiu em nenhuma prova sua.'),
      c.definition ? h('p', { style: { fontSize: '1.05rem' } }, c.definition) : null,
      c.parent ? h('p', {}, h('small', { class: 'muted' }, 'apoia-se em '), h('button', { class: 'chip', onclick: () => api.select(c.parent.id) }, c.parent.label)) : h('p', {}, h('small', { class: 'muted' }, 'é a base deste conteúdo')),
      c.children.length ? h('p', {}, h('small', { class: 'muted' }, 'sustenta '), c.children.map(k => h('button', { class: 'chip', style: { margin: '2px' }, onclick: () => api.select(k.id) }, k.label))) : null,
      h('h3', { style: { marginTop: '18px' } }, 'Onde aparece'),
      h('div', {}, c.excerpts.map(e => h('div', { class: 'excerpt' }, e.text, ' ', sourceLink(e, study)))),
      h('div', { class: 'row', style: { margin: '16px 0' } },
        h('a', { class: 'btn small', href: `#/ensinar/${studyId}?c=${c.id}` }, 'Ensinar de volta'),
        h('a', { class: 'btn soft small', href: `#/prova/${studyId}?modo=revisao` }, 'Revisar fracos')),
      h('h3', {}, 'Minhas anotações'),
      notesPanel(study, { conceptId: c.id, compact: true })));
  };

  const api = drawMap(wrap, study, { onSelect: openConcept });
  wrap.append(
    h('div', { class: 'map-tools' },
      h('button', { class: 'btn soft small', onclick: api.zoomIn, 'aria-label': 'Aproximar' }, '+'),
      h('button', { class: 'btn soft small', onclick: api.zoomOut, 'aria-label': 'Afastar' }, '−'),
      h('button', { class: 'btn soft small', onclick: api.fit }, 'ajustar')),
    h('div', { class: 'map-legend' },
      h('span', { class: 'chip' }, '◌ não avaliado'), h('span', { class: 'chip bad' }, 'fraco'), h('span', { class: 'chip warn' }, 'quase'), h('span', { class: 'chip ok' }, 'dominado')));
  document.body.append(drawer);
  ctx.onLeave(() => drawer.remove());
  const onKey = e => { if (e.key === 'Escape') drawer.classList.remove('open'); };
  document.addEventListener('keydown', onKey);
  ctx.onLeave(() => document.removeEventListener('keydown', onKey));
  if (query.get('c')) setTimeout(() => api.select(query.get('c')), 50);

  return h('div', {},
    h('a', { href: `#/estudo/${studyId}`, class: 'muted', style: { fontSize: '.85rem' } }, '← ' + study.title),
    h('div', { class: 'row between', style: { margin: '6px 0 14px' } },
      h('div', {}, h('h1', { style: { margin: 0 } }, 'Mapa do que você sabe'),
        h('p', { class: 'muted', style: { margin: 0 } }, `Da base (embaixo) ao topo. ${ok} de ${total} conceitos dominados. Arraste para mover, role para aproximar, clique num conceito.`)),
      h('div', { style: { minWidth: '200px' } }, h('div', { class: 'bar' }, h('i', { style: { width: (ok / Math.max(1, total)) * 100 + '%', background: 'var(--ok)' } })))),
    wrap);
}
