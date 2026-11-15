// Correção local. MC é exata; abertas usam cobertura de conceitos + estrutura.
// Quando a nota local fica "na zona cinzenta", o grafo pode escalar para um agente LLM.
import vm from 'node:vm';
import { tokenize, stem, clamp, wordCount } from './text.js';

export const PASS_MARK = 0.75;

const EXAMPLE_RE = /por exemplo|exemplo|imagine|cenário|num projeto|no caso de|quando eu|for example|for instance|e\.g\.|```|=>|\(\)/i;
const TRADEOFF_RE = /\bmas\b|porém|contudo|entretanto|cuidado|limita|desvantagem|trade-?off|risco|custo|however|\bbut\b|downside|careful|caveat|evitar|atenção/i;

function joinedStems(text) {
  return ' ' + tokenize(text).map(t => stem(t.toLowerCase())).join(' ') + ' ';
}

export function gradeMC(q, response) {
  const choice = Number(response);
  const correct = choice === q.answer;
  return {
    score: correct ? 1 : 0, correct, confidence: 'alta',
    feedback: correct ? 'Certo!' : `A resposta certa era: “${q.options[q.answer]}”.`,
    correctAnswer: q.answer, explanation: q.explanation, by: 'local',
  };
}

export function gradeOpen(q, text) {
  const r = q.rubric || {};
  const joined = joinedStems(text);
  const words = wordCount(text);
  const found = [], missing = [];
  let got = 0, total = 0;
  for (const kw of r.keywords || []) {
    total += kw.weight;
    if (joined.includes(' ' + kw.key + ' ')) { got += kw.weight; found.push(kw.term); } else missing.push(kw.term);
  }
  const coverage = total ? got / total : 0;
  const lengthF = r.minWords ? clamp(words / r.minWords, 0, 1) : 1;
  let score, structure = {};
  if (q.type === 'interview') {
    structure.example = EXAMPLE_RE.test(text);
    structure.tradeoff = r.needsTradeoff ? TRADEOFF_RE.test(text) : true;
    score = 0.55 * coverage + 0.2 * lengthF + 0.125 * structure.example + 0.125 * structure.tradeoff;
  } else {
    score = 0.7 * coverage + 0.3 * lengthF;
  }
  if (words < 5) score = Math.min(score, 0.1);
  score = +clamp(score, 0, 1).toFixed(2);
  const tips = [];
  if (missing.length) tips.push(`Faltou falar de: ${missing.map(m => '«' + m + '»').join(', ')}.`);
  if (lengthF < 1) tips.push(`Desenvolva um pouco mais (você escreveu ${words} palavras; o ideal é a partir de ${r.minWords}).`);
  if (q.type === 'interview' && !structure.example) tips.push('Em entrevista, um exemplo concreto pesa muito.');
  if (q.type === 'interview' && !structure.tradeoff) tips.push('Mostre senioridade citando uma limitação ou cuidado.');
  return {
    score, correct: score >= PASS_MARK, found, missing, words, structure,
    confidence: score < 0.3 || score > 0.8 ? 'alta' : 'média',
    feedback: tips.length ? tips.join(' ') : 'Resposta completa. Boa!',
    expected: r.expected, by: 'local',
  };
}

export function checkSyntax(code, lang) {
  if (!code.trim()) return { ok: false, message: 'Nenhum código enviado.' };
  if (lang === 'javascript') {
    try {
      // Só compila, nunca executa no servidor.
      new vm.Script(`(async () => {\n${code}\n})`, { filename: 'resposta.js' });
      return { ok: true, message: 'Sintaxe válida.' };
    } catch (e) {
      return { ok: false, message: 'Erro de sintaxe: ' + String(e.message).split('\n')[0] };
    }
  }
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (const ch of code.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (Object.values(pairs).includes(ch) && stack.pop() !== ch) return { ok: false, message: `Parênteses/chaves desbalanceados perto de “${ch}”.` };
  }
  return stack.length ? { ok: false, message: 'Algum parêntese/chave ficou aberto.' } : { ok: true, message: 'Estrutura balanceada.' };
}

export function gradeCode(q, code) {
  const r = q.rubric || {};
  const lower = code.toLowerCase();
  const found = [], missing = [];
  for (const t of r.codeTokens || []) (lower.includes(t.toLowerCase()) ? found : missing).push(t);
  const coverage = (r.codeTokens || []).length ? found.length / r.codeTokens.length : 0;
  const syntax = checkSyntax(code, r.lang);
  const lines = code.split('\n').filter(l => l.trim()).length;
  const nonTrivial = lines >= 2 && code.trim().length >= 30;
  let score = 0.6 * coverage + 0.25 * syntax.ok + 0.15 * nonTrivial;
  if (!code.trim()) score = 0;
  score = +clamp(score, 0, 1).toFixed(2);
  const tips = [];
  if (missing.length) tips.push(`Elementos que o conteúdo usa e não apareceram: ${missing.map(m => '`' + m + '`').join(', ')}.`);
  if (!syntax.ok) tips.push(syntax.message);
  if (!nonTrivial) tips.push('O código está curto demais para demonstrar a ideia.');
  return {
    score, correct: score >= PASS_MARK, found, missing, syntax,
    confidence: score < 0.3 || score > 0.85 ? 'alta' : 'média',
    feedback: tips.length ? tips.join(' ') : 'Código coerente com o conteúdo.',
    expected: r.expected, by: 'local',
  };
}

export function gradeLocal(q, response) {
  if (q.type === 'mc') return gradeMC(q, response);
  if (q.type === 'code') return gradeCode(q, String(response ?? ''));
  return gradeOpen(q, String(response ?? ''));
}

// Resultado final: média ponderada, linha de corte 75%, pontos de revisão base → topo.
export function aggregate(questions, gradesById, graph) {
  let got = 0, total = 0;
  const conceptAcc = new Map();
  const wrong = [];
  for (const q of questions) {
    const g = gradesById[q.id];
    const s = g ? g.score : 0;
    got += s * q.weight;
    total += q.weight;
    for (const cid of q.concepts) {
      const a = conceptAcc.get(cid) || { got: 0, total: 0 };
      a.got += s * q.weight; a.total += q.weight;
      conceptAcc.set(cid, a);
    }
    if (!g || s < PASS_MARK) wrong.push({ questionId: q.id, score: s, unanswered: !g });
  }
  const score = total ? got / total : 0;
  const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const review = [...conceptAcc.entries()]
    .map(([id, a]) => ({ id, label: nodes.get(id)?.label || id, level: nodes.get(id)?.level ?? 0, tier: nodes.get(id)?.tier, mastery: +(a.got / a.total).toFixed(2) }))
    .filter(c => c.mastery < PASS_MARK)
    .sort((a, b) => a.level - b.level || a.mastery - b.mastery);
  return { score: +score.toFixed(4), passed: score >= PASS_MARK, wrong, review, conceptMastery: Object.fromEntries([...conceptAcc].map(([id, a]) => [id, +(a.got / a.total).toFixed(2)])) };
}
