import { h } from './ui.js';

// Editor de código leve: numeração de linhas, Tab = 2 espaços, auto-indentação e
// botão "Rodar" para JavaScript (num Web Worker isolado, com tempo limite).
export function codeEditor({ lang = 'javascript', value = '', onInput } = {}) {
  const gutter = h('div', { class: 'gutter', 'aria-hidden': 'true' }, '1');
  const ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': `Seu código em ${lang}`, placeholder: lang === 'python' ? '# escreva seu código aqui' : '// escreva seu código aqui' });
  ta.value = value;
  const lines = () => { gutter.textContent = Array.from({ length: Math.max(1, ta.value.split('\n').length) }, (_, i) => i + 1).join('\n'); };
  ta.addEventListener('input', () => { lines(); onInput?.(ta.value); });
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const before = ta.value.slice(0, ta.selectionStart);
      const indent = (before.split('\n').pop().match(/^\s*/) || [''])[0] + (/[{[(:]\s*$/.test(before) ? '  ' : '');
      e.preventDefault();
      ta.setRangeText('\n' + indent, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  lines();
  const consoleEl = h('div', { class: 'console', hidden: true, 'aria-live': 'polite' });
  let worker = null;
  const run = () => {
    worker?.terminate();
    consoleEl.hidden = false;
    consoleEl.replaceChildren(h('div', { class: 'muted' }, '▶ rodando…'));
    worker = new Worker('/js/runner.worker.js');
    const kill = setTimeout(() => { worker.terminate(); consoleEl.append(h('div', { class: 'err' }, 'Parado: passou de 3 segundos (loop infinito?).')); }, 3000);
    worker.onmessage = ({ data }) => {
      if (data.kind === 'done') { clearTimeout(kill); worker.terminate(); if (consoleEl.children.length === 1) consoleEl.append(h('div', { class: 'muted' }, '(sem saída — use console.log)')); return; }
      consoleEl.append(h('div', { class: data.kind === 'log' ? '' : 'err' }, data.text));
    };
    worker.onerror = (e) => { clearTimeout(kill); consoleEl.append(h('div', { class: 'err' }, 'Não consegui rodar: ' + (e.message || 'erro no executor'))); };
    worker.postMessage({ code: ta.value });
  };
  const el = h('div', {},
    h('div', { class: 'code-editor' }, gutter, ta),
    lang === 'javascript' ? h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { type: 'button', class: 'btn soft small', onclick: run }, '▶ Rodar no navegador'),
      h('small', { class: 'muted' }, 'roda isolado, só para você testar')) : null,
    consoleEl);
  return { el, get value() { return ta.value; }, focus: () => ta.focus(), destroy: () => worker?.terminate() };
}
