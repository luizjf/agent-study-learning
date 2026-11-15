import { get, store } from '../api.js';
import { h, badgeIcon, toast } from '../ui.js';
import { prefs, savePrefs } from '../focus.js';

export async function profileView(ctx) {
  const [{ user, badges, allBadges }, { mode, agents }] = await Promise.all([get('/me'), get('/agents')]);
  const earned = new Set(badges.map(b => b.id));
  const P = prefs();

  const toggle = (key, label, desc) => {
    const input = h('input', { type: 'checkbox', checked: !!P[key], onchange: () => { savePrefs({ [key]: input.checked }); toast('Preferência salva.'); } });
    return h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', fontWeight: 400 } }, input, h('span', {}, h('b', {}, label), h('br'), h('small', { class: 'muted' }, desc)));
  };
  const select = (key, label, options) => {
    const sel = h('select', { onchange: () => { savePrefs({ [key]: isNaN(sel.value) ? sel.value : Number(sel.value) }); toast('Preferência salva.'); } },
      options.map(([v, l]) => h('option', { value: v, selected: String(P[key]) === String(v) }, l)));
    return h('div', {}, h('label', {}, label), sel);
  };

  return h('div', {},
    h('h1', {}, user.name),
    h('div', { class: 'tag-line' },
      h('span', { class: 'chip ink' }, `Nível ${user.level}`),
      h('span', { class: 'chip' }, `${user.xp} XP`),
      h('span', { class: 'chip warn' }, `${user.streak} dia(s) seguidos`),
      h('span', { class: 'chip' }, user.role === 'professor' ? 'professor' : 'aluno')),
    h('div', { class: 'grid cols-2', style: { marginTop: '18px' } },
      h('section', { class: 'card' },
        h('h2', {}, 'Conquistas'),
        h('div', { class: 'badges' }, Object.entries(allBadges).map(([id, b]) => h('div', { class: 'badge' + (earned.has(id) ? '' : ' locked'), html: badgeIcon(id, earned.has(id)) + `<b>${b.name}</b><small class="muted">${b.desc}</small>` })))),
      h('section', { class: 'stack' },
        h('div', { class: 'card stack' },
          h('h2', {}, 'Do seu jeito'),
          h('p', { class: 'muted', style: { margin: 0 } }, 'Ajuste o ritmo e os estímulos. Cada cabeça foca de um jeito.'),
          select('roundSize', 'Perguntas por rodada', [[3, '3 — bem curtinho'], [5, '5 — padrão'], [8, '8 — quero embalar']]),
          select('breakSeconds', 'Pausa entre rodadas', [[0, 'sem pausa'], [20, '20 segundos'], [45, '45 segundos'], [90, '1 min e meio']]),
          toggle('sound', 'Sons de acerto', 'Um tom curto ao acertar. Recompensa imediata ajuda a manter o ritmo.'),
          toggle('timer', 'Mostrar tempo da rodada', 'Ajuda quem perde a noção do tempo. Desligue se der ansiedade.'),
          toggle('voice', 'Botão "Ouvir"', 'Lê a pergunta em voz alta.'),
          toggle('motion', 'Animações', 'Desligue para uma tela mais calma.'),
          select('size', 'Tamanho da letra', [['normal', 'Normal'], ['grande', 'Grande']]),
          select('theme', 'Tema', [['auto', 'Seguir o sistema'], ['light', 'Claro'], ['dark', 'Escuro']])),
        h('div', { class: 'card' },
          h('h2', {}, 'Agentes'),
          h('p', { class: 'muted' }, mode === 'local'
            ? 'Modo 100% local: nenhuma chamada paga. Os agentes abaixo entram só se você configurar uma chave Claude (ou um modelo Ollama).'
            : `Modo ${mode}: cada agente só é chamado quando o motor local fica em dúvida, com cache e teto diário de tokens.`),
          h('table', {}, h('tbody', {}, agents.map(a => h('tr', {},
            h('td', {}, h('b', {}, a.name), h('br'), h('small', { class: 'muted' }, a.role)),
            h('td', {}, h('span', { class: 'chip ' + (a.tier === 'opus' ? 'warn' : a.tier === 'sonnet' ? 'ink' : '') }, a.model))))))),
        h('button', { class: 'btn ghost small', onclick: () => { if (confirm('Sair deste perfil? Sem e-mail não há como recuperar.')) { store.token = null; ctx.user = null; try { for (const k of Object.keys(localStorage)) if (k.startsWith('trilha.')) localStorage.removeItem(k); } catch { /* modo privado */ } location.hash = '#/'; location.reload(); } } }, 'Sair'))));
}
