// Executa o JavaScript do aluno isolado (sem DOM, sem rede pela CSP). A página encerra após 3s.
const fmt = v => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, (k, x) => (typeof x === 'function' ? `[função ${x.name || 'anônima'}]` : x)); } catch { return String(v); }
};
self.onmessage = async ({ data }) => {
  const out = (kind, args) => self.postMessage({ kind, text: args.map(fmt).join(' ') });
  const console = { log: (...a) => out('log', a), info: (...a) => out('log', a), warn: (...a) => out('warn', a), error: (...a) => out('error', a) };
  try {
    const fn = new Function('console', `return (async () => {\n${data.code}\n})()`);
    await fn(console);
    // dá uma chance a timers e promises pendentes
    await new Promise(r => setTimeout(r, 300));
    self.postMessage({ kind: 'done' });
  } catch (e) {
    self.postMessage({ kind: 'error', text: `${e.name}: ${e.message}` });
    self.postMessage({ kind: 'done' });
  }
};
