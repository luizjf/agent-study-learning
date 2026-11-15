import { get, patch, store } from '../api.js';
import { h, toast, pct } from '../ui.js';

export async function roomView(ctx, [code]) {
  let { room } = await get('/rooms/' + code);
  const root = h('div', {});
  const feed = h('ul', { class: 'feed', 'aria-live': 'polite' });
  const onlineEl = h('span', {});
  const membersEl = h('span', {});
  const boardBody = h('tbody', {});
  const teacherBox = h('div', {});

  const drawBoard = () => {
    boardBody.replaceChildren(...room.board.map((r, i) => h('tr', { class: r.me ? 'me' : '' },
      h('td', {}, i + 1),
      h('td', {}, r.online ? h('span', { class: 'online-dot', title: 'estudando agora' }) : null, r.name),
      h('td', {}, r.xp + ' XP'),
      h('td', {}, r.best != null ? h('span', { class: 'chip ' + (r.passed ? 'ok' : 'bad') }, pct(r.best)) : '—'),
      h('td', {}, r.attempts))));
    onlineEl.textContent = `${room.online} estudando agora`;
    membersEl.textContent = `${room.members} participante(s) · `;
  };

  const drawTeacher = () => {
    if (!room.isOwner) return;
    teacherBox.replaceChildren(h('div', { class: 'grid cols-2', style: { marginTop: '22px' } },
      h('div', { class: 'card' },
        h('h3', {}, 'Onde a turma mais erra'),
        room.passRate != null ? h('p', { class: 'muted' }, `Taxa de aprovação: ${pct(room.passRate)}`) : h('p', { class: 'muted' }, 'Ainda sem provas finalizadas.'),
        room.weakConcepts.map(c => h('div', { style: { margin: '10px 0' } },
          h('div', { class: 'row between' }, h('span', {}, c.label), h('small', { class: 'muted' }, `${pct(c.avg)} · ${c.n} prova(s)`)),
          h('div', { class: 'bar' }, h('i', { style: { width: c.avg * 100 + '%', background: c.avg >= 0.75 ? 'var(--ok)' : c.avg >= 0.5 ? 'var(--warn)' : 'var(--bad)' } }))))),
      h('div', { class: 'card' },
        h('h3', {}, 'Respostas abertas para revisar'),
        h('p', { class: 'muted' }, 'A correção automática é uma estimativa. Ajuste quando discordar — a nota do aluno é recalculada.'),
        room.toReview.length ? room.toReview.map(a => {
          const slider = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((a.override ?? a.score) * 100), 'aria-label': 'Nota' });
          const val = h('b', {}, slider.value + '%');
          slider.addEventListener('input', () => { val.textContent = slider.value + '%'; });
          return h('details', { class: 'mistake' },
            h('summary', {}, h('span', { class: 'score-dot' + ((a.override ?? a.score) >= 0.75 ? '' : ' mid'), style: (a.override ?? a.score) >= 0.75 ? { background: 'var(--ok)' } : {} }, Math.round((a.override ?? a.score) * 100)),
              h('span', {}, h('b', {}, a.name), ' — ', h('small', { class: 'muted' }, a.type), h('br'), h('small', {}, a.prompt.split('\n')[0].slice(0, 120)))),
            h('div', { class: 'body' },
              h('div', { class: 'answer-line', style: { whiteSpace: 'pre-wrap', background: 'var(--paper-2)' } }, a.response),
              h('div', { class: 'row', style: { marginTop: '8px' } }, slider, val,
                h('button', {
                  class: 'btn small', onclick: async () => {
                    await patch(`/attempts/${a.attemptId}/answers/${encodeURIComponent(a.questionId)}`, { score: slider.value / 100 });
                    toast(`Nota de ${a.name} ajustada.`);
                    refresh();
                  },
                }, 'Salvar'))));
        }) : h('p', {}, 'Nada por enquanto.'))));
  };

  const refresh = async () => { room = (await get('/rooms/' + code)).room; drawBoard(); drawTeacher(); };

  // tempo real
  const es = new EventSource(`/api/rooms/${encodeURIComponent(code)}/events?token=${encodeURIComponent(store.token)}`);
  // O servidor agrupa tudo num "tick" a cada 1,5 s, já com o placar pronto:
  // o aluno não precisa recarregar nada. Só o professor busca o painel completo, no máximo a cada 5 s.
  let refreshTimer = null, lastRefresh = 0;
  const teacherRefresh = () => {
    if (!room.isOwner || refreshTimer) return;
    const wait = Math.max(0, 5000 - (Date.now() - lastRefresh));
    refreshTimer = setTimeout(async () => { refreshTimer = null; lastRefresh = Date.now(); await refresh(); }, wait);
  };
  const me = ctx.user.id;
  es.addEventListener('tick', e => {
    const d = JSON.parse(e.data);
    room.board = d.board.map(r => ({ ...r, me: r.id === me }));
    room.members = d.members;
    room.online = d.online;
    for (const it of d.feed) {
      if (it.type === 'progress') feed.prepend(h('li', {}, `${it.name} respondeu ${it.answered}/${it.total}`, it.combo >= 3 ? ` · ${it.combo} seguidas` : ''));
      else if (it.type === 'finished') feed.prepend(h('li', {}, h('b', {}, it.name), ` terminou: ${pct(it.score)} ${it.passed ? '— aprovado' : ''}`));
    }
    while (feed.children.length > 40) feed.lastChild.remove();
    drawBoard();
    if (d.feed.some(it => it.type === 'finished')) teacherRefresh();
  });
  ctx.onLeave(() => { es.close(); clearTimeout(refreshTimer); });

  drawBoard();
  drawTeacher();
  root.append(
    h('a', { href: '#/', class: 'muted', style: { fontSize: '.85rem' } }, '← mesa'),
    h('div', { class: 'row between', style: { margin: '6px 0 18px' } },
      h('div', {}, h('h1', { style: { margin: 0 } }, room.name),
        h('p', { class: 'muted', style: { margin: 0 } }, `Estudo: ${room.study.title} · `, membersEl, onlineEl)),
      h('div', { style: { textAlign: 'right' } }, h('small', { class: 'muted' }, 'código para entrar'), h('br'),
        h('button', { class: 'code-big', title: 'Copiar', onclick: () => navigator.clipboard?.writeText(room.code).then(() => toast('Código copiado.')) }, room.code))),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Placar'),
          h('a', { class: 'btn accent small', href: `#/prova/${room.study.id}?turma=${room.code}` }, room.isOwner ? 'Testar a prova' : 'Fazer a prova da turma')),
        h('table', { style: { marginTop: '10px' } },
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Nome'), h('th', {}, 'XP'), h('th', {}, 'Melhor'), h('th', {}, 'Provas'))),
          boardBody)),
      h('div', { class: 'card' }, h('h3', {}, 'Ao vivo'), h('p', { class: 'muted', style: { fontSize: '.85rem' } }, 'Estudar sabendo que outros estão estudando junto ajuda a manter o foco.'), feed)),
    teacherBox);
  return root;
}
