import { get } from '../api.js';
import { h, highlight, gauge, sourceLink, badgeIcon, pct } from '../ui.js';

export async function resultView(ctx, [attemptId]) {
  const { result: r } = await get('/attempts/' + attemptId);
  const study = { videoId: r.videoId, sourceUrl: r.sourceUrl };
  const wrong = r.items.filter(i => i.score < 0.75);
  const gap = Math.max(0, Math.round(r.passMark * 100) - Math.round(r.score * 100));

  const mistake = (it) => {
    const body = h('div', { class: 'body' });
    if (it.type === 'mc') {
      body.append(
        it.chosen != null && it.chosen >= 0 ? h('div', { class: 'answer-line mine' }, h('b', {}, 'Você: '), it.options[it.chosen]) : h('div', { class: 'answer-line mine' }, 'Sem resposta'),
        h('div', { class: 'answer-line right' }, h('b', {}, 'Certa: '), it.options[it.correctOption]),
        it.explanation ? h('p', { class: 'muted', style: { margin: '8px 0 0' } }, it.explanation) : null);
    } else {
      body.append(
        h('div', { class: 'answer-line mine', style: { whiteSpace: 'pre-wrap', fontFamily: it.type === 'code' ? 'var(--mono)' : 'inherit', fontSize: it.type === 'code' ? '.82rem' : 'inherit' } }, it.response || 'Sem resposta'),
        it.feedback ? h('p', { style: { margin: '8px 0' } }, it.feedback) : null,
        it.missing?.length ? h('div', { class: 'tag-line' }, it.missing.map(m => h('span', { class: 'chip bad' }, 'faltou: ' + m))) : null,
        it.expected ? h('div', { class: 'answer-line right' }, h('b', {}, 'A fonte diz: '), it.expected) : null,
        it.overridden ? h('small', { class: 'muted' }, 'nota ajustada pelo professor') : null);
    }
    const link = sourceLink(it.source, study);
    if (link) body.append(h('p', { style: { margin: '8px 0 0' } }, link));
    return h('details', { class: 'mistake' },
      h('summary', {},
        h('span', { class: 'score-dot' + (it.score >= 0.4 ? ' mid' : '') }, Math.round(it.score * 100)),
        h('span', {}, h('small', { class: 'muted' }, it.concepts.map(c => c.label).join(' · ')), h('br'),
          h('span', { html: highlight(it.prompt.split('\n')[0], it.highlight) }))),
      body);
  };

  return h('div', {},
    h('div', { class: 'result-head' },
      h('div', { html: gauge(r.score ?? 0, r.passMark) }),
      h('div', { class: 'verdict ' + (r.passed ? 'ok' : 'bad') }, r.passed ? 'Aprovado.' : `Ainda não — faltaram ${gap} ponto${gap === 1 ? '' : 's'}.`),
      r.mentor ? h('p', { class: 'mentor' }, r.mentor.message, r.mentor.by && r.mentor.by !== 'local' ? h('small', { class: 'muted' }, ` (${r.mentor.by})`) : null) : null,
      h('div', { class: 'tag-line', style: { justifyContent: 'center' } },
        h('span', { class: 'chip ok' }, `+${r.xp} XP`),
        r.bestCombo >= 2 ? h('span', { class: 'chip warn' }, `melhor sequência: ${r.bestCombo}`) : null,
        r.streak ? h('span', { class: 'chip' }, `${r.streak} dia(s) seguidos`) : null,
        h('span', { class: 'chip' }, `${r.items.length - wrong.length} de ${r.items.length} acima de 75%`)),
      r.badges?.length ? h('div', {}, r.badges.map(b => h('span', { class: 'badge-new', html: badgeIcon(b.id).replace('<svg', '<svg width="34" height="34"') + `<span><b>${b.name}</b><br><small>${b.desc}</small></span>` }))) : null),

    h('div', { class: 'row', style: { justifyContent: 'center', margin: '10px 0 30px' } },
      r.review.length ? h('a', { class: 'btn accent', href: `#/prova/${r.studyId}?modo=revisao` }, 'Refazer só o que ficou fraco') : null,
      h('a', { class: 'btn soft', href: `#/mapa/${r.studyId}` }, 'Ver no mapa'),
      h('a', { class: 'btn ghost', href: `#/estudo/${r.studyId}` }, 'Voltar ao estudo')),

    h('div', { class: 'grid cols-2' },
      h('section', {},
        h('h2', {}, wrong.length ? 'Onde você errou' : 'Nenhum erro'),
        wrong.length ? h('p', { class: 'muted' }, 'Toque para ver sua resposta, a certa e o trecho da fonte.') : h('p', {}, 'Tudo acima de 75%. Que tal ensinar um conceito de volta para fixar?'),
        wrong.map(mistake)),
      h('section', {},
        h('h2', {}, 'O que rever'),
        r.review.length ? h('p', { class: 'muted' }, 'Na ordem certa: do básico para o avançado. Firmar a base primeiro deixa o resto mais fácil.') : h('p', { class: 'muted' }, 'Nada pendente nesta prova.'),
        h('ol', { class: 'review-list' }, r.review.map(c => h('li', {},
          h('div', { class: 'row between' }, h('b', {}, c.label), h('span', { class: 'chip ' + (c.mastery >= 0.4 ? 'warn' : 'bad') }, `${c.tier} · ${pct(c.mastery)}`)),
          c.definition ? h('p', { style: { margin: '4px 0' } }, c.definition) : null,
          c.source ? h('p', { class: 'excerpt', style: { margin: '6px 0' } }, '“' + c.source.text + '” ', sourceLink(c.source, study)) : null,
          h('a', { href: `#/ensinar/${r.studyId}?c=${c.id}`, style: { fontSize: '.85rem' } }, 'explicar com minhas palavras →')))))),

    r.trace ? h('details', { style: { marginTop: '30px' } },
      h('summary', { class: 'muted' }, 'Como essa nota foi calculada'),
      h('ol', { class: 'pipeline' }, r.trace.map(t => h('li', { class: 'done' }, h('span', { class: 'dot' }), t.label, t.agent !== 'local' ? h('small', { class: 'muted' }, ' · ' + t.agent) : null, h('span', { class: 'ms' }, t.ms + ' ms'))))) : null);
}
