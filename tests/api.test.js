import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TRILHA_DB = ':memory:';
process.env.TRILHA_LLM = 'local';
const { app } = await import('../server/index.js');

let server, base;
const text = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

test('fluxo completo: professor cria, aluno faz prova na turma, professor ajusta nota', async () => {
  const prof = await call('POST', '/users', null, { name: 'Ana', role: 'professor' });
  assert.equal(prof.status, 201);
  const T = prof.data.token;

  assert.equal((await call('POST', '/studies', T, { type: 'text', text: 'curto demais' })).status, 422);

  const st = await call('POST', '/studies', T, { type: 'text', text, title: 'Async JS' });
  assert.equal(st.status, 201, JSON.stringify(st.data));
  const study = st.data.study;
  assert.ok(study.graph.nodes.length >= 8);
  assert.ok(study.questionCounts.mc >= 6);
  assert.ok(study.trace.some(t => t.node === 'perguntas'));

  const gab = await call('GET', `/studies/${study.id}/questions`, T);
  assert.equal(gab.status, 200);
  const answerKey = new Map(gab.data.questions.map(q => [q.id, q]));

  const room = await call('POST', '/rooms', T, { studyId: study.id, name: 'Turma A' });
  assert.equal(room.status, 201);
  const code = room.data.room.code;

  const aluno = await call('POST', '/users', null, { name: 'Bia' });
  const A = aluno.data.token;
  assert.equal((await call('GET', `/studies/${study.id}`, A)).status, 404, 'aluno de fora não vê o estudo');
  assert.equal((await call('GET', `/studies/${study.id}/questions`, A)).status, 404, 'aluno não vê gabarito');
  assert.equal((await call('POST', `/rooms/${code}/join`, A)).status, 200);
  assert.equal((await call('GET', `/studies/${study.id}`, A)).status, 200);

  const att = await call('POST', `/studies/${study.id}/attempts`, A, { roomCode: code });
  assert.equal(att.status, 201);
  const { attempt } = att.data;
  assert.ok(attempt.questions.every(q => q.options == null || q.answer === undefined), 'gabarito não vaza');

  // responde tudo errado nas MC (para provar a reprovação e o plano de revisão)
  let interviewId;
  for (const q of attempt.questions) {
    const key = answerKey.get(q.id);
    let response;
    if (q.type === 'mc') {
      const correctText = key.options[key.answer];
      response = q.options.findIndex(o => o !== correctText);
    } else if (q.type === 'code') response = 'const x = await Promise.all([a(), b()]);\nconsole.log(x);';
    else { response = 'não lembro'; if (q.type === 'interview') interviewId = q.id; }
    const r = await call('POST', `/attempts/${attempt.id}/answer`, A, { questionId: q.id, response });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (q.type === 'mc') {
      assert.equal(r.data.result.correct, false);
      assert.equal(q.options[r.data.result.correctOption], key.options[key.answer], 'opção correta mapeada pela permutação');
    }
  }
  const dup = await call('POST', `/attempts/${attempt.id}/answer`, A, { questionId: attempt.questions[0].id, response: 0 });
  assert.equal(dup.status, 409);

  const fin = await call('POST', `/attempts/${attempt.id}/finish`, A);
  assert.equal(fin.status, 200);
  const res = fin.data.result;
  assert.equal(res.passed, false);
  assert.ok(res.score < 0.75);
  assert.ok(res.review.length > 0, 'mostra o que rever');
  assert.ok(res.review[0].source?.text, 'cada ponto de revisão aponta o trecho');
  assert.ok(res.items.some(i => i.chosen !== i.correctOption && i.type === 'mc'));
  assert.ok(res.mentor.message.includes('75%'));
  assert.ok(res.badges.some(b => b.id === 'primeiro-passo'));

  // professor vê o painel e ajusta a nota da entrevista
  const view = await call('GET', `/rooms/${code}`, T);
  assert.equal(view.status, 200);
  assert.ok(view.data.room.weakConcepts.length > 0);
  assert.ok(view.data.room.toReview.length > 0);
  const ov = await call('PATCH', `/attempts/${attempt.id}/answers/${interviewId}`, T, { score: 1 });
  assert.equal(ov.status, 200);
  assert.ok(ov.data.result.score > res.score);
  assert.equal((await call('PATCH', `/attempts/${attempt.id}/answers/${interviewId}`, A, { score: 1 })).status, 403);

  // revisão: só conceitos fracos
  const rev = await call('POST', `/studies/${study.id}/attempts`, A, { mode: 'review' });
  assert.equal(rev.status, 201);
  assert.ok(rev.data.attempt.questions.length > 0);

  // segunda tentativa, agora acertando tudo → aprovado + "persistente"
  const att2 = (await call('POST', `/studies/${study.id}/attempts`, A, {})).data.attempt;
  for (const q of att2.questions) {
    const key = answerKey.get(q.id);
    let response;
    if (q.type === 'mc') response = q.options.indexOf(key.options[key.answer]);
    else if (q.type === 'code') response = `// ${key.rubric.codeTokens.join(' ')}\nconst [perfil, pedidos] = await Promise.all([buscarPerfil(id), buscarPedidos(id)]);\nconsole.log(perfil, pedidos);`;
    else response = `${key.rubric.keywords.map(k => k.term).join(', ')}. Por exemplo, num projeto real eu usaria isso ao buscar dados; mas é preciso cuidado com erros e com o que acontece quando algo falha, porque isso muda o comportamento do sistema inteiro e a experiência de quem usa a tela.`;
    await call('POST', `/attempts/${att2.id}/answer`, A, { questionId: q.id, response });
  }
  const fin2 = (await call('POST', `/attempts/${att2.id}/finish`, A)).data.result;
  assert.equal(fin2.passed, true, `nota ${fin2.score}`);
  assert.ok(fin2.badges.some(b => b.id === 'aprovado'));
  assert.ok(fin2.badges.some(b => b.id === 'persistente'));
});

test('anotações, ensinar de volta e conceito', async () => {
  const u = (await call('POST', '/users', null, { name: 'Caio' })).data.token;
  const study = (await call('POST', '/studies', u, { type: 'text', text })).data.study;
  const cid = study.graph.root;
  const n = await call('POST', `/studies/${study.id}/notes`, u, { text: 'Lembrar: microtasks antes de tarefas', conceptId: cid, ts: 30 });
  assert.equal(n.status, 201);
  const c = await call('GET', `/studies/${study.id}/concepts/${cid}`, u);
  assert.equal(c.data.concept.notes.length, 1);
  const t = await call('POST', `/studies/${study.id}/teach`, u, { conceptId: cid, text: 'É tipo uma fila.' });
  assert.equal(t.status, 200);
  assert.ok(t.data.reply.length > 10);
  assert.equal((await call('DELETE', `/notes/${n.data.note.id}`, u)).status, 204);
});

test('não autenticado recebe 401 e rotas de grafo descrevem os fluxos', async () => {
  assert.equal((await call('GET', '/studies')).status, 401);
  const g = await call('GET', '/graphs');
  assert.match(g.data.finalizar, /aprovado/);
  const ag = await call('GET', '/agents');
  assert.equal(ag.data.agents.find(a => a.id === 'entrevistador').model, 'claude-opus-5-5');
  assert.equal(ag.data.agents.find(a => a.id === 'corretor').model, 'claude-haiku-5-5');
});
