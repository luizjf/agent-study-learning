import { get, post, store } from '../api.js';
import { h, icon, toast, pct, sourceLabel, timeAgo } from '../ui.js';
import { savePrefs } from '../focus.js';
import { removeStudy } from './study.js';

export function welcomeView(ctx) {
  let role = 'aluno';
  const name = h('input', { type: 'text', id: 'nome', autocomplete: 'nickname', placeholder: 'Como quer ser chamado?', maxlength: 40, required: true });
  const roleSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Papel' });
  const drawRole = () => roleSeg.replaceChildren(...['aluno', 'professor'].map(r =>
    h('button', { type: 'button', 'aria-pressed': String(role === r), onclick: () => { role = r; drawRole(); } }, r === 'aluno' ? 'Vou estudar' : 'Vou dar aula')));
  drawRole();
  const form = h('form', {
    class: 'card stack',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await post('/users', { name: name.value, role });
        store.token = r.token;
        ctx.setUser(r.user);
        savePrefs({}, false);
        ctx.route();
      } catch (err) { toast(err.message, 'bad'); }
    },
  },
  h('div', {}, h('label', { for: 'nome' }, 'Seu nome'), name),
  h('div', {}, h('label', {}, 'Você está aqui para…'), roleSeg),
  h('button', { class: 'btn', type: 'submit' }, 'Começar'),
  h('p', { class: 'muted', style: { fontSize: '.8rem', margin: 0 } }, 'Sem senha nem e-mail: é um protótipo. Seus dados ficam só neste servidor.'));

  return h('section', { class: 'welcome' },
    h('div', {},
      h('h1', {}, 'Assistiu, leu… ', h('span', { class: 'hl' }, 'mas entendeu?')),
      h('p', { style: { fontSize: '1.1rem', maxWidth: '46ch' } }, 'Cole um vídeo do YouTube, um PDF ou um texto. A Trilha monta uma prova com perguntas de múltipla escolha, de raciocínio, de código e uma de entrevista.'),
      h('ol', { class: 'steps' },
        h('li', {}, h('b', {}, 'Fonte. '), 'Vídeo, PDF ou artigo — o que você estiver estudando.'),
        h('li', {}, h('b', {}, 'Prova em rodadas curtas. '), 'Uma pergunta por vez, resposta na hora, sem distração.'),
        h('li', {}, h('b', {}, '75% para passar. '), 'Passando ou não, você vê onde errou e o que rever, do básico ao avançado.'),
        h('li', {}, h('b', {}, 'Mapa do que você sabe. '), 'Cada conceito acende conforme você domina.'))),
    form);
}

export async function homeView(ctx) {
  const { studies, rooms } = await get('/studies');
  const u = ctx.user;
  const code = h('input', { type: 'text', placeholder: 'Código da turma', maxlength: 8, style: { textTransform: 'uppercase', maxWidth: '180px' }, 'aria-label': 'Código da turma' });
  const join = async (e) => {
    e.preventDefault();
    try {
      const { room } = await post(`/rooms/${code.value.trim().toUpperCase()}/join`);
      toast(`Você entrou na turma ${room.name}.`);
      ctx.go('/turma/' + room.code);
    } catch (err) { toast(err.message, 'bad'); }
  };
  const due = studies.reduce((a, s) => a + (s.due || 0), 0);

  return h('div', {},
    h('div', { class: 'row between', style: { marginBottom: '22px' } },
      h('div', {},
        h('h1', { style: { marginBottom: '4px' } }, `Oi, ${u.name.split(' ')[0]}.`),
        h('p', { class: 'muted', style: { margin: 0 } }, due
          ? `Você tem ${due} conceito(s) pedindo revisão hoje. Dez minutos já resolvem.`
          : studies.length ? 'Escolha um estudo para continuar de onde parou.' : 'Comece trazendo algo que você quer aprender.')),
      h('form', { class: 'row', onsubmit: join }, code, h('button', { class: 'btn soft', type: 'submit' }, 'Entrar na turma'))),
    h('div', { class: 'grid cards' },
      h('a', { class: 'new-card', href: '#/novo', html: `<div>${icon.plus.replace('<svg', '<svg width="28" height="28"')}<div>Novo estudo</div><small class="muted">vídeo, PDF ou texto</small></div>` }),
      studies.map(s => h('div', { class: 'card-wrap' },
        h('button', {
          class: 'card-del', html: icon.trash, title: s.isOwner ? 'Excluir estudo' : 'Tirar da minha mesa',
          'aria-label': (s.isOwner ? 'Excluir o estudo ' : 'Tirar da mesa o estudo ') + s.title,
          onclick: async () => { if (await removeStudy({ ...s, isOwner: !!s.isOwner }, ctx)) ctx.route(); },
        }),
        h('a', { class: 'index-card', href: `#/estudo/${s.id}` },
        h('h3', {}, s.title),
        h('div', { class: 'meta' },
          h('span', { class: 'chip' }, sourceLabel(s.sourceType)),
          s.technical ? h('span', { class: 'chip ink' }, 'com código') : null,
          s.best != null ? h('span', { class: 'chip ' + (s.best >= 0.75 ? 'ok' : 'bad') }, 'melhor ' + pct(s.best)) : h('span', { class: 'chip' }, 'ainda sem prova'),
          s.due ? h('span', { class: 'chip warn' }, `${s.due} p/ revisar`) : null,
          !s.isOwner ? h('span', { class: 'chip' }, 'da turma') : null))))),
    !studies.length ? h('div', { class: 'empty', html: icon.emptyDesk + '<p>Sua mesa está vazia. Que tal um vídeo que você assistiu e não tem certeza se entendeu?</p>' }) : null,
    rooms.length ? h('section', { style: { marginTop: '36px' } },
      h('h2', {}, 'Turmas'),
      h('div', { class: 'grid cards' }, rooms.map(r => h('a', { class: 'card', href: `#/turma/${r.code}`, style: { textDecoration: 'none', color: 'inherit' } },
        h('div', { class: 'row between' }, h('b', {}, r.name), h('span', { class: 'chip ' + (r.isOwner ? 'ink' : '') }, r.isOwner ? 'você é o professor' : 'aluno')),
        h('p', { class: 'muted', style: { margin: '6px 0 0' } }, `${r.members} participante(s) · código ${r.code}`))))) : null,
  );
}

export { timeAgo };
