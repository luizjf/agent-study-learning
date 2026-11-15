// Vídeo falado: o motor local deve perguntar sobre o CONTEÚDO, não sobre a conversa.
// Fixture sintética (tests/fixtures/fala-sono.txt): tem propaganda, gírias, vocativos e o nome do apresentador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { splitSentences } from '../server/nlp/text.js';
import { scrub, isPromo, prepareSpoken, looksSpoken } from '../server/nlp/spoken.js';
import { analyze } from '../server/nlp/analyze.js';
import { copyMeter } from '../server/agents/normalize.js';

const raw = fs.readFileSync(new URL('./fixtures/fala-sono.txt', import.meta.url), 'utf8');
const sentences = splitSentences(raw).map((text, i) => ({ text, start: i * 12 }));
const a = await analyze({ id: 'fala', sentences, sourceType: 'youtube' });
const labels = a.graph.nodes.map(n => n.label.toLowerCase());
const allText = a.questions.map(q => [q.prompt, ...(q.options || [])].join(' ')).join('\n').toLowerCase();

test('limpa vícios de linguagem sem perder o conteúdo', () => {
  assert.equal(scrub('Cara, a consolidação da memória é o processo em que uma lembrança vira estável, tá ligado?'),
    'A consolidação da memória é o processo em que uma lembrança vira estável.');
  assert.equal(scrub('Então, mano, o hipocampo registra o que você vive, entendeu?'), 'O hipocampo registra o que você vive.');
  assert.ok(looksSpoken(sentences));
});

test('propaganda, abertura e encerramento saem antes da análise', () => {
  assert.ok(isPromo('cupom Rodrigo na Lumina, o link tá aqui na descrição'));
  assert.ok(isPromo('deixa o like e se inscreve no canal'));
  const { sentences: kept, ignore } = prepareSpoken(sentences);
  const keptText = kept.map(s => s.text).join(' ').toLowerCase();
  assert.ok(!keptText.includes('travesseiro'), 'bloco do patrocinador (marca citada perto do cupom) deveria sair');
  assert.ok(!keptText.includes('inscreve'));
  assert.ok(ignore.has('rodrigo'), 'nome do apresentador vira palavra ignorada');
  assert.ok(kept.every(s => s.start != null), 'cada frase mantém o minuto do vídeo');
  assert.ok(a.trace.some(t => t.node === 'limpar'), 'o subgrafo passa pelo nó limpar');
});

test('conceitos são do assunto, não da conversa', () => {
  for (const must of ['hipocampo', 'sono profundo', 'consolidação da memória']) assert.ok(labels.includes(must), `faltou ${must}: ${labels.join(', ')}`);
  for (const bad of ['cara', 'mano', 'galera', 'entendeu', 'rodrigo', 'lumina', 'cupom', 'canal', 'like']) {
    assert.ok(!labels.some(l => l.split(' ').includes(bad)), `"${bad}" não é conceito: ${labels.join(', ')}`);
  }
});

test('perguntas são sobre o conteúdo: sem propaganda, sem bate-papo e sem "complete a frase"', () => {
  for (const bad of ['cupom', 'lumina', 'inscreve', 'rodrigo', 'tá ligado', 'entendeu?']) assert.ok(!allText.includes(bad), `pergunta com "${bad}"`);
  const mc = a.questions.filter(q => q.type === 'mc');
  assert.ok(mc.length >= 2);
  for (const q of mc) {
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options).size, 4);
    assert.ok(q.answer >= 0 && q.answer < 4);
  }
  // entrevista de conteúdo não técnico não fala em "projeto real"
  const boss = a.questions.find(q => q.type === 'interview');
  assert.ok(boss && !boss.prompt.includes('projeto real'));
});

test('nenhuma pergunta local pede para completar frase do conteúdo (fala nem texto escrito)', async () => {
  const written = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');
  const b = await analyze({ id: 'texto', sentences: splitSentences(written).map(text => ({ text })), sourceType: 'text' });
  for (const study of [a, b]) {
    const copied = copyMeter(study.sentences);
    for (const q of study.questions) {
      assert.ok(!/_{3,}/.test(q.prompt), `lacuna: ${q.prompt}`);
      assert.ok(!['cloze', 'number', 'statement', 'prerequisite'].includes(q.kind), q.kind);
      if (q.type === 'mc') assert.ok(copied(q.prompt) < 20, `enunciado colado da fonte: ${q.prompt}`);
    }
  }
});
