// Utilitários de texto: idioma, limpeza, tokenização, radicalização leve e segmentação.
// Tudo local, sem modelo pago — é a base do motor "zero token".

const STOP_PT = `a à ao aos as às até com como da das de dela dele deles desta deste disso disto do dos e é ela elas ele eles em entre era eram essa essas esse esses esta está estão estas este estes eu foi foram há isso isto já lá mais mas me mesmo meu minha muito na nas não nem no nos nós num numa o os ou para pela pelas pelo pelos por porque qual quando que quem se sem ser será seu seus sua suas são só também te tem têm tu tua um uma umas uns você vocês vai vamos ter tá então aí aqui ali onde cada pode podem fazer faz feito vez vezes sobre ainda bem assim agora depois antes durante após sobre contra desde perante outro outra outros outras todo toda todos todas tudo nada algo alguém coisa coisas tipo né gente pessoal galera ok beleza sim seja sendo sido estar estou estava estamos fica ficar dá dar vem ver vou veja olha só lo la los las lhe lhes num nessa nesse nesta neste dessa desse daquele daquela pra pro pras pros nossa nosso nossas nossos sua qualquer quais quanto quanta quantos mesma mesmos porém pois logo apenas cerca dentro fora sempre nunca menos tão tanto exemplo forma parte jeito maneira caso hora momento dia vídeo aula curso canal`.split(/\s+/);

const STOP_EN = `a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just let me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours also get got gonna going like really thing things lot okay yeah well right actually basically kind sort way example video lesson course channel guys`.split(/\s+/);

export const STOPWORDS = new Set([...STOP_PT, ...STOP_EN]);
// Conectores aceitos no meio de um termo composto ("fila de tarefas", "event loop of ...")
export const CONNECTORS = new Set(['de', 'do', 'da', 'dos', 'das', 'of', 'e']);

const FILLER_RE = /\[(m[uú]sica|music|aplausos|applause|risos|laughter)\]|\b(n[ée]h?|hum+|ahn+|é{2,}|uh+m?|hmm+|tipo assim)\b[,.]?/gi;

export function detectLang(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  let pt = 0, en = 0;
  const ptSet = new Set(STOP_PT), enSet = new Set(STOP_EN);
  for (const w of words.slice(0, 3000)) {
    if (ptSet.has(w)) pt++;
    if (enSet.has(w)) en++;
  }
  return en > pt * 1.3 ? 'en' : 'pt';
}

export function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(FILLER_RE, ' ')
    .replace(/-\n(\p{Ll})/gu, '$1') // hifenização de PDF
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Radical leve PT/EN: suficiente para casar "funções" ~ "função", "promises" ~ "promise".
export function stem(word) {
  let w = stripAccents(word.toLowerCase());
  if (w.length <= 3 || /[._$()/]/.test(w)) return w;
  if (w.endsWith('coes')) return w.slice(0, -4) + 'cao';
  if (w.endsWith('oes') || w.endsWith('aes')) return w.slice(0, -3) + 'ao';
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('ais') && w.length > 5) return w.slice(0, -3) + 'al';
  if (w.endsWith('eis') && w.length > 5) return w.slice(0, -3) + 'el';
  if (w.endsWith('ns')) return w.slice(0, -2) + 'm';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 5 && /[rz]es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const TOKEN_RE = /[\p{L}\p{N}_$#+]+(?:[.\-/][\p{L}\p{N}_$#+]+)*(?:\(\))?/gu;

export function tokenize(text) {
  return (text.match(TOKEN_RE) || []);
}

export function isStop(word) {
  return STOPWORDS.has(word.toLowerCase());
}

export function isCodeToken(tok) {
  return /[a-z][A-Z]/.test(tok) // camelCase
    || /_/.test(tok.replace(/^_+|_+$/g, '')) // snake_case
    || /\(\)$/.test(tok) // chamada()
    || /^[\p{L}_$][\p{L}\p{N}_$]*\.[\p{L}_$]/u.test(tok); // obj.metodo
}

export const CODE_KEYWORDS = {
  javascript: ['const', 'let', 'var', 'function', 'return', 'async', 'await', 'promise', 'then', 'catch', 'console.log', '=>', 'null', 'undefined', 'array', 'object', 'callback', 'json', 'fetch', 'npm', 'node', 'react', 'typescript', 'javascript'],
  python: ['def', 'import', 'print', 'self', 'elif', 'none', 'lambda', 'list', 'dict', 'tuple', 'python', 'pip', 'pandas', 'numpy'],
  sql: ['select', 'from', 'where', 'join', 'insert', 'update', 'delete', 'group by', 'order by', 'tabela', 'table', 'sql', 'índice', 'index'],
  java: ['public', 'static', 'void', 'class', 'interface', 'extends', 'implements', 'java', 'spring'],
  csharp: ['namespace', 'using', 'public', 'class', 'linq', 'c#', '.net', 'dotnet'],
};
const TECH_HINTS = ['código', 'code', 'função', 'function', 'variável', 'variable', 'método', 'method', 'classe', 'class', 'api', 'loop', 'array', 'objeto', 'object', 'programação', 'programming', 'algoritmo', 'algorithm', 'compilador', 'framework', 'biblioteca', 'library', 'servidor', 'server', 'banco de dados', 'database', 'query', 'string', 'booleano', 'boolean', 'retorna', 'returns', 'parâmetro', 'parameter', 'erro', 'exception'];

export function detectTechnical(text) {
  const lower = text.toLowerCase();
  const toks = tokenize(text);
  const codeToks = toks.filter(isCodeToken).length;
  let hints = 0;
  for (const h of TECH_HINTS) hints += lower.split(h).length - 1;
  const scores = {};
  for (const [lang, kws] of Object.entries(CODE_KEYWORDS)) {
    scores[lang] = kws.reduce((acc, k) => acc + (k.length <= 3
      ? (lower.match(new RegExp(`(^|[^\\p{L}])${escapeRe(k)}([^\\p{L}]|$)`, 'gu')) || []).length
      : lower.split(k).length - 1), 0);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const density = (codeToks * 3 + hints) / Math.max(1, toks.length) * 100;
  const technical = density > 1.2 || codeToks >= 6;
  return { technical, codeLang: technical && best[1] > 0 ? best[0] : (technical ? 'javascript' : null), density: +density.toFixed(2) };
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Separa em frases. Transcrições automáticas quase não têm pontuação:
// nesse caso, criamos janelas de ~24 palavras quebrando antes de conectores naturais.
const BREAK_WORDS = new Set(['então', 'porque', 'mas', 'agora', 'depois', 'quando', 'ou seja', 'so', 'because', 'but', 'now', 'then', 'when', 'basicamente', 'primeiro', 'segundo', 'por exemplo', 'for example']);

export function splitSentences(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const punct = (text.match(/[.!?;](\s|$)/g) || []).length;
  if (words === 0) return [];
  if (punct / words * 100 >= 1.5) {
    return text
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?;])\s+(?=[\p{Lu}\p{N}"“(])/u)
      .map(s => s.trim())
      .filter(s => s.split(/\s+/).length >= 4);
  }
  return windowSplit(text, 24);
}

export function windowSplit(text, size = 24) {
  const toks = text.split(/\s+/).filter(Boolean);
  const out = [];
  let cur = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].toLowerCase();
    const two = (w + ' ' + (toks[i + 1] || '')).toLowerCase();
    const isBreak = BREAK_WORDS.has(w) || BREAK_WORDS.has(two);
    if (cur.length >= size || (isBreak && cur.length >= size * 0.6)) {
      out.push(cur.join(' '));
      cur = [];
    }
    cur.push(toks[i]);
  }
  if (cur.length) {
    if (cur.length < 6 && out.length) out[out.length - 1] += ' ' + cur.join(' ');
    else out.push(cur.join(' '));
  }
  return out.map(s => s.charAt(0).toUpperCase() + s.slice(1));
}

export function wordCount(text) {
  return (text.match(/\S+/g) || []).length;
}

export function fmtTime(sec) {
  if (sec == null) return null;
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
}

// Gerador pseudoaleatório com semente: a mesma fonte gera sempre a mesma prova.
export function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
