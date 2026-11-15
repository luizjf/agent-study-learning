import { get, store } from './api.js';
import { h, icon, toast } from './ui.js';
import { applyPrefs, savePrefs, stopSpeaking } from './focus.js';
import { welcomeView, homeView } from './views/home.js';
import { newStudyView } from './views/new-study.js';
import { studyView } from './views/study.js';
import { quizView } from './views/quiz.js';
import { resultView } from './views/result.js';
import { mapView } from './views/map.js';
import { teachView } from './views/teach.js';
import { roomView } from './views/room.js';
import { editorView } from './views/editor.js';
import { profileView } from './views/profile.js';

const routes = [
  [/^\/$/, homeView],
  [/^\/novo$/, newStudyView],
  [/^\/estudo\/([\w-]+)$/, studyView],
  [/^\/prova\/([\w-]+)$/, quizView],
  [/^\/resultado\/([\w-]+)$/, resultView],
  [/^\/mapa\/([\w-]+)$/, mapView],
  [/^\/ensinar\/([\w-]+)$/, teachView],
  [/^\/turma\/([A-Za-z0-9]+)$/, roomView],
  [/^\/questoes\/([\w-]+)$/, editorView],
  [/^\/perfil$/, profileView],
];

export const ctx = {
  user: null,
  cleanups: [],
  onLeave(fn) { this.cleanups.push(fn); },
  setUser(u) { this.user = u; renderTopbar(); },
  async refreshUser() {
    const { user } = await get('/me');
    // preferências de foco viajam com o perfil (outro navegador, outro aparelho)
    if (user.prefs && Object.keys(user.prefs).length && !store.local('prefs', null)) savePrefs(user.prefs, false);
    this.setUser(user);
    return user;
  },
  go(path) { location.hash = '#' + path; },
};

function renderTopbar() {
  const bar = document.getElementById('topbar');
  const u = ctx.user;
  bar.hidden = !u;
  if (!u) return;
  const pctLevel = Math.min(100, ((u.xp - u.current) / Math.max(1, u.next - u.current)) * 100);
  // replaceChildren transformaria null em texto "null": h() descarta vazios
  bar.replaceChildren(...[
    h('a', { class: 'brand', href: '#/', html: icon.logo + '<span>Trilha</span>' }),
    h('span', { class: 'spacer' }),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Papel' },
      ['aluno', 'professor'].map(r => h('button', {
        'aria-pressed': String(u.role === r),
        onclick: async () => {
          const { patch } = await import('./api.js');
          const { user } = await patch('/me', { role: r });
          ctx.setUser(user);
          toast(r === 'professor' ? 'Modo professor: você pode editar questões e abrir turmas.' : 'Modo aluno.');
          route();
        },
      }, r === 'aluno' ? 'Aluno' : 'Professor'))),
    u.streak > 0 ? h('span', { class: 'streak', title: `${u.streak} dia(s) seguidos`, html: icon.flame + u.streak }) : null,
    h('div', { class: 'xpbar', title: `${u.xp} XP — faltam ${u.next - u.xp} para o nível ${u.level + 1}` },
      h('span', { class: 'lvl' }, 'Nv ' + u.level),
      h('span', { class: 'meter' }, h('i', { style: { width: pctLevel + '%' } })),
      h('span', {}, u.xp + ' XP')),
    h('a', { class: 'avatar', href: '#/perfil', title: 'Perfil e conquistas', 'aria-label': 'Perfil' }, u.name.slice(0, 1).toUpperCase()),
  ].filter(Boolean));
}

let routing = 0;
async function route() {
  const my = ++routing;
  for (const fn of ctx.cleanups.splice(0)) { try { fn(); } catch { /* ignora */ } }
  stopSpeaking();
  const app = document.getElementById('app');
  app.className = '';
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  if (!store.token) {
    app.replaceChildren(welcomeView(ctx));
    return;
  }
  if (!ctx.user) {
    try { await ctx.refreshUser(); } catch { store.token = null; return route(); }
  }
  const found = routes.find(([re]) => re.test(path));
  if (!found) { app.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Página não encontrada'), h('a', { href: '#/' }, 'Voltar para a mesa'))); return; }
  const [re, view] = found;
  const params = path.match(re).slice(1);
  app.replaceChildren(h('div', { class: 'empty' }, 'Carregando…'));
  try {
    const el = await view(ctx, params, query);
    if (my !== routing) return; // o usuário já navegou para outra página
    app.replaceChildren(el);
    app.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    if (my !== routing) return;
    app.replaceChildren(h('div', { class: 'empty' },
      h('h2', {}, 'Não deu certo'), h('p', {}, err.message), err.hint ? h('p', { class: 'muted' }, err.hint) : null,
      h('a', { class: 'btn soft', href: '#/' }, 'Voltar para a mesa')));
  }
}

applyPrefs();
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
ctx.route = route;
ctx.savePrefs = savePrefs;
