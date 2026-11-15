import { api, post, get } from '../api.js';
import { h, toast } from '../ui.js';

const STEPS = [
  ['carregar', 'Lendo a fonte'],
  ['analisar', 'Entendendo o tipo de conteúdo'],
  ['conceitos', 'Encontrando os conceitos'],
  ['mapa', 'Montando o mapa (base → topo)'],
  ['resumo', 'Separando as frases-chave'],
  ['perguntas', 'Criando as perguntas'],
];

export async function newStudyView(ctx, _p, query) {
  let tab = query.get('tipo') || 'video';
  const { mode, provider, claudeCode, budget } = await get('/agents');
  const llm = mode !== 'local';

  const url = h('input', { type: 'url', id: 'src-url', placeholder: 'https://www.youtube.com/watch?v=…', autocomplete: 'off' });
  const file = h('input', { type: 'file', id: 'src-file', accept: 'application/pdf' });
  const pdfUrl = h('input', { type: 'url', placeholder: 'ou um link direto para o PDF', autocomplete: 'off' });
  const text = h('textarea', { id: 'src-text', placeholder: 'Cole aqui a transcrição do vídeo, um capítulo, suas anotações de aula…', rows: 10 });
  const title = h('input', { type: 'text', id: 'src-title', placeholder: 'Opcional — usamos o título da fonte', maxlength: 160 });
  const deep = h('input', { type: 'checkbox', id: 'deep', disabled: !llm, checked: llm });
  const pipeline = h('ol', { class: 'pipeline', hidden: true });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Montar a prova');
  const panels = {
    video: h('div', {}, h('label', { for: 'src-url' }, 'Link do vídeo (YouTube) ou de um artigo'), url,
      h('p', { class: 'muted', style: { fontSize: '.85rem', marginTop: '8px' } }, 'Usamos as legendas públicas do vídeo — nenhum serviço pago. Sem legenda? Copie a transcrição do YouTube e cole na aba “Texto”.')),
    pdf: h('div', { class: 'stack' }, h('div', {}, h('label', { for: 'src-file' }, 'Arquivo PDF (até 25 MB)'), file), pdfUrl),
    texto: h('div', {}, h('label', { for: 'src-text' }, 'Texto ou transcrição'), text),
  };
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', {});
  const drawTabs = () => {
    tabs.replaceChildren(...[['video', 'Vídeo ou link'], ['pdf', 'PDF'], ['texto', 'Texto']].map(([k, l]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawTabs(); } }, l)));
    body.replaceChildren(panels[tab]);
  };
  drawTabs();

  let timer = null;
  const animate = () => {
    pipeline.hidden = false;
    let i = 0;
    const paint = () => pipeline.replaceChildren(...STEPS.map(([, label], j) =>
      h('li', { class: j < i ? 'done' : j === i ? 'doing' : '' }, h('span', { class: 'dot' }), label)));
    paint();
    timer = setInterval(() => { if (i < STEPS.length - 1) { i++; paint(); } }, tab === 'video' ? 900 : 300);
  };
  const showTrace = (trace) => {
    clearInterval(timer);
    pipeline.replaceChildren(...trace.map(t => h('li', { class: 'done' }, h('span', { class: 'dot' }), t.label, t.note ? h('small', { class: 'muted' }, ' · ' + t.note) : null, h('span', { class: 'ms' }, t.ms + ' ms'))));
  };

  const form = h('form', {
    class: 'card stack',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Montando…';
      animate();
      try {
        let res;
        if (tab === 'pdf' && file.files[0]) {
          const buf = await file.files[0].arrayBuffer();
          const t = title.value || file.files[0].name.replace(/\.pdf$/i, '');
          res = await api('POST', `/studies/pdf?title=${encodeURIComponent(t)}${deep.checked ? '' : '&deep=0'}`, undefined, { raw: buf });
        } else if (tab === 'texto') {
          res = await post('/studies', { type: 'text', text: text.value, title: title.value, deep: deep.checked });
        } else {
          const link = tab === 'pdf' ? pdfUrl.value : url.value;
          if (!link) throw new Error('Cole um link primeiro.');
          res = await post('/studies', { type: 'url', url: link, title: title.value, deep: deep.checked });
        }
        showTrace(res.study.trace);
        toast(res.study.deep?.status === 'running'
          ? 'Conteúdo carregado. Agora os agentes estudam tudo e depois escrevem as perguntas.'
          : `Pronto: ${res.study.graph.nodes.length} conceitos e ${Object.values(res.study.questionCounts).reduce((a, b) => a + b, 0)} perguntas.`);
        setTimeout(() => ctx.go('/estudo/' + res.study.id), 700);
      } catch (err) {
        clearInterval(timer);
        pipeline.hidden = true;
        toast(err.message + (err.hint ? ' ' + err.hint : ''), 'bad');
        submit.disabled = false;
        submit.textContent = 'Montar a prova';
      }
    },
  },
  tabs, body,
  h('div', {}, h('label', { for: 'src-title' }, 'Título'), title),
  h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', fontWeight: 400 } }, deep,
    h('span', {}, h('b', {}, 'Estudar o conteúdo com os agentes antes de perguntar'), h('br'),
      h('small', { class: 'muted' }, !llm
        ? 'Desligado: sem IA, a Trilha faz só a versão básica (perguntas sobre definições e justificativas do texto). Para o sistema estudar o conteúdo, rode “npm run start:pro” com a sua assinatura do Claude (veja o README).'
        : claudeCode && !claudeCode.found
          ? 'Atenção: não achei o Claude Code nesta máquina. Instale-o ou defina TRILHA_CLAUDE_BIN; até lá vale a prova local.'
          : `O Cartógrafo (Sonnet) estuda o conteúdo inteiro e o Examinador (Sonnet) escreve perguntas sobre ele — conceitos, porquês e aplicações, nunca "complete a frase". Via ${provider}; leva de 1 a 3 min.${budget ? ` Uso hoje: ${Math.round(budget.used / 1000)} de ${Math.round(budget.daily / 1000)} mil tokens.` : ''}`))),
  h('div', { class: 'row' }, submit, h('a', { class: 'btn ghost', href: '#/' }, 'Cancelar')),
  pipeline);

  return h('div', { style: { maxWidth: '720px', margin: '0 auto' } },
    h('h1', {}, 'Novo estudo'),
    h('p', { class: 'muted' }, 'Quanto maior a fonte, mais perguntas: de 6 a 14 de múltipla escolha, 2 ou 3 de raciocínio, código quando o assunto pede, e uma de entrevista no final.'),
    form);
}
