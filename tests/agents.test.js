import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Liga os agentes apontando para um servidor que não existe: o sistema deve
// escalar só na zona cinzenta e, com o agente fora do ar, manter a nota local.
process.env.TRILHA_DB = ':memory:';
process.env.TRILHA_LLM = 'ollama';
process.env.TRILHA_AUTO_DEEP = '0'; // aqui o foco é a correção; o estudo pelos agentes tem testes próprios
process.env.OLLAMA_URL = 'http://127.0.0.1:9';

const { db } = await import('../server/db.js');
const P = await import('../server/pipelines.js');
const { skillPrompt, agentsInfo, AGENTS, MODELS } = await import('../server/agents/index.js');

const text = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');
db.prepare("INSERT INTO users (id, name, role, token, created_at) VALUES ('u1', 'Teste', 'aluno', 't1', 0)").run();
const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get();

test('skill de cada agente vira o prompt de sistema (sem o frontmatter)', () => {
  for (const id of Object.keys(AGENTS)) {
    const p = skillPrompt(id);
    assert.ok(p.length > 200, id);
    assert.ok(!p.startsWith('---'), id);
    assert.match(p, /0,75|75%|75/, `${id} deve conhecer o critério de aprovação`);
  }
});

test('cada agente tem o modelo do seu nível', () => {
  assert.equal(MODELS[AGENTS.corretor.tier], 'claude-haiku-5-5');
  assert.equal(MODELS[AGENTS['revisor-codigo'].tier], 'claude-sonnet-5-5');
  assert.equal(MODELS[AGENTS.entrevistador.tier], 'claude-opus-5-5');
  assert.ok(agentsInfo().every(a => a.active));
  // tarefas curtas têm saída curta
  assert.ok(AGENTS.corretor.maxTokens <= 500);
  assert.ok(AGENTS.mentor.maxTokens <= 500);
});

test('MC nunca escala; aberta na zona cinzenta escala e cai para a nota local se o agente falhar', async () => {
  const study = await P.createStudy(user, { type: 'text', text });
  const attempt = P.startAttempt(user, study.id);
  const mc = attempt.questions.find(q => q.type === 'mc');
  const r1 = await P.answerQuestion(user, attempt.id, { questionId: mc.id, response: 0 });
  const t1 = JSON.parse(db.prepare('SELECT detail FROM answers WHERE question_id = ?').get(mc.id).detail).trace;
  assert.deepEqual(t1.map(t => t.node), ['corrigir', 'pontuar']);
  assert.equal(r1.result.by, 'local');

  const open = attempt.questions.find(q => q.type === 'reasoning');
  // resposta mediana: cita um termo, tamanho ok → nota local "média"
  const r2 = await P.answerQuestion(user, attempt.id, { questionId: open.id, response: 'A fila de tarefas guarda o que vai rodar depois, e quando a pilha esvazia algo pega dessa fila para executar o próximo passo do programa.' });
  const t2 = JSON.parse(db.prepare('SELECT detail FROM answers WHERE question_id = ?').get(open.id).detail).trace;
  assert.deepEqual(t2.map(t => t.node), ['corrigir', 'escalar', 'pontuar'], 'deveria ter tentado o agente');
  assert.equal(r2.result.by, 'local', 'agente fora do ar → nota local');
  assert.ok(r2.result.score > 0);

  const fin = await P.finishAttempt(user, attempt.id);
  assert.equal(fin.mentor.by, 'local');
  assert.ok(fin.trace.some(t => t.node === 'mentor'));
});
