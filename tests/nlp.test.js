import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clean, splitSentences, stem, detectTechnical, wordCount, windowSplit } from '../server/nlp/text.js';
import { extractConcepts, buildGraph } from '../server/nlp/knowledge.js';
import { generateQuestions, questionPlan } from '../server/nlp/questions.js';
import { gradeMC, gradeOpen, gradeCode, aggregate, checkSyntax } from '../server/nlp/grader.js';
import { StateGraph, END } from '../server/graph/engine.js';
import { parseCaptionXml, captionsToSentences, youtubeId } from '../server/ingest/index.js';

const text = clean(fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8'));
const sentences = splitSentences(text).map((t, i) => ({ text: t, i }));
const { concepts, prepared } = extractConcepts(sentences);
const graph = buildGraph(concepts, prepared);
const tech = detectTechnical(text);
const questions = generateQuestions({ graph, prepared, technical: tech.technical, codeLang: tech.codeLang, words: wordCount(text), seed: 't' });

test('radical leve junta singular e plural', () => {
  assert.equal(stem('Promises'), stem('Promise'));
  assert.equal(stem('funções'), stem('função'));
  assert.equal(stem('callbacks'), stem('callback'));
  assert.equal(stem('classes'), 'class');
});

test('transcrição sem pontuação vira janelas de frases', () => {
  const raw = Array.from({ length: 120 }, (_, i) => (i % 15 === 0 ? 'então' : 'palavra' + i)).join(' ');
  const out = windowSplit(raw, 24);
  assert.ok(out.length >= 4);
  assert.ok(out.every(s => s.split(' ').length <= 30));
});

test('detecta conteúdo técnico e a linguagem', () => {
  assert.equal(tech.technical, true);
  assert.equal(tech.codeLang, 'javascript');
  assert.equal(detectTechnical('A fotossíntese transforma luz em energia química nas folhas das plantas verdes.').technical, false);
});

test('extrai os conceitos centrais', () => {
  const labels = concepts.map(c => c.label.toLowerCase());
  for (const must of ['event loop', 'call stack', 'promise', 'callback hell', 'promise.all']) {
    assert.ok(labels.includes(must), `faltou o conceito ${must}: ${labels.join(', ')}`);
  }
});

test('definições encontradas são do tipo "X é um/uma/o..."', () => {
  const ev = graph.nodes.find(n => n.label === 'event loop');
  assert.match(ev.definition.predicate, /^o mecanismo/);
  for (const n of graph.nodes) if (n.definition) assert.ok(n.definition.predicate.length > 12);
});

test('mapa é uma árvore com uma única base', () => {
  const roots = graph.nodes.filter(n => !n.parent);
  assert.equal(roots.length, 1);
  for (const n of graph.nodes) {
    if (n.parent) assert.equal(n.level, graph.nodes.find(p => p.id === n.parent).level + 1);
  }
});

test('plano de questões escala com o tamanho e inclui código quando técnico', () => {
  assert.deepEqual(questionPlan(500, false), { mc: 6, reasoning: 2, code: 0, interview: 1 });
  assert.equal(questionPlan(4000, true).mc, 14);
  const types = questions.map(q => q.type);
  assert.ok(types.filter(t => t === 'mc').length >= 6);
  assert.ok(types.includes('reasoning'));
  assert.ok(types.includes('code'));
  assert.equal(types[types.length - 1], 'interview');
});

test('toda MC tem 4 opções distintas e gabarito válido', () => {
  for (const q of questions.filter(q => q.type === 'mc')) {
    assert.equal(q.options.length, 4, q.prompt);
    assert.equal(new Set(q.options).size, 4, q.prompt);
    assert.ok(q.answer >= 0 && q.answer < 4);
  }
});

test('MC vai do nível base para o avançado', () => {
  const lv = questions.filter(q => q.type === 'mc').map(q => q.level);
  assert.deepEqual(lv, [...lv].sort((a, b) => a - b));
});

test('geração é determinística pela semente', () => {
  const again = generateQuestions({ graph, prepared, technical: true, codeLang: 'javascript', words: wordCount(text), seed: 't' });
  assert.deepEqual(again.map(q => q.prompt), questions.map(q => q.prompt));
});

test('correção MC', () => {
  const q = questions.find(q => q.type === 'mc');
  assert.equal(gradeMC(q, q.answer).score, 1);
  assert.equal(gradeMC(q, (q.answer + 1) % 4).score, 0);
});

test('correção aberta premia cobertura de conceitos', () => {
  const q = questions.find(q => q.type === 'reasoning');
  const terms = q.rubric.keywords.map(k => k.term).join(', ');
  const good = gradeOpen(q, `Na minha visão, ${terms} trabalham juntos: um coordena o outro, e isso explica por que o código não trava enquanto espera uma resposta da rede ou do disco.`);
  const bad = gradeOpen(q, 'Não sei.');
  assert.ok(good.score >= 0.75, JSON.stringify(good));
  assert.ok(bad.score <= 0.1);
  assert.ok(bad.missing.length > 0);
});

test('código: sintaxe JS é só compilada, nunca executada', () => {
  globalThis.__rodou = false;
  assert.equal(checkSyntax('globalThis.__rodou = true', 'javascript').ok, true);
  assert.equal(globalThis.__rodou, false);
  assert.equal(checkSyntax('const x = ;', 'javascript').ok, false);
  const q = questions.find(q => q.type === 'code');
  const r = gradeCode(q, 'const [a, b] = await Promise.all([buscarPerfil(1), buscarPedidos(1)]);\nconsole.log(a, b);');
  assert.ok(r.syntax.ok);
  assert.ok(r.score > 0.6, JSON.stringify(r));
});

test('agregação aplica a linha de 75% e ordena revisão do básico ao topo', () => {
  const qs = questions;
  const all = Object.fromEntries(qs.map(q => [q.id, { score: 1 }]));
  assert.equal(aggregate(qs, all, graph).passed, true);
  const half = Object.fromEntries(qs.map((q, i) => [q.id, { score: i % 2 ? 1 : 0 }]));
  const agg = aggregate(qs, half, graph);
  assert.equal(agg.passed, false);
  const lv = agg.review.map(r => r.level);
  assert.deepEqual(lv, [...lv].sort((a, b) => a - b));
});

test('motor de grafo: arestas condicionais e trace', async () => {
  const g = new StateGraph('t')
    .addNode('a', s => ({ n: s.n + 1 }))
    .addNode('par', () => ({ r: 'par' }))
    .addNode('impar', () => ({ r: 'impar' }))
    .setEntry('a')
    .addConditionalEdges('a', s => (s.n % 2 ? 'i' : 'p'), { i: 'impar', p: 'par' })
    .addEdge('par', END).addEdge('impar', END)
    .compile();
  const { state, trace } = await g.invoke({ n: 1 });
  assert.equal(state.r, 'par');
  assert.deepEqual(trace.map(t => t.node), ['a', 'par']);
  assert.throws(() => new StateGraph('x').addNode('a', () => {}).setEntry('a').addEdge('a', 'nada').compile());
});

test('legendas do YouTube: parse e tempo por frase', () => {
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  const xml = '<transcript><text start="0.5" dur="2">o event loop &amp;amp; a fila</text><text start="3.1" dur="2">de tarefas trabalham juntos então</text><text start="6" dur="2">a call stack precisa ficar vazia para</text><text start="9" dur="2">que a próxima tarefa entre</text></transcript>';
  const caps = parseCaptionXml(xml);
  assert.equal(caps.length, 4);
  assert.equal(caps[0].text, 'o event loop & a fila');
  const s = captionsToSentences(caps);
  assert.ok(s.length >= 1);
  assert.equal(s[0].start, 0.5);
});
