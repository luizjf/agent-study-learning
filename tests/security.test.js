// Segurança: SSRF, controle de acesso, limite de requisições, token na URL e cabeçalhos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

process.env.TRILHA_DB = ':memory:';
process.env.TRILHA_LLM = 'local';
process.env.TRILHA_RATE_LIMIT = '30';
const { app } = await import('../server/index.js');
const { isPrivateAddress, assertPublicUrl, fetchWithLimit, loadSource } = await import('../server/ingest/index.js');

let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(method, path, token, body, { query = '' } = {}) {
  const res = await fetch(base + path + query, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: res.status === 204 ? null : await res.json().catch(() => null) };
}

test('SSRF: endereços internos são bloqueados em qualquer forma', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.ok(isPrivateAddress(ip), `${ip} deveria ser bloqueado`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateAddress(ip), `${ip} é público`);
  // formas alternativas que o parser de URL normaliza para 127.0.0.1
  for (const url of ['http://localhost/x', 'http://127.0.0.1:3000/api', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://meu.servidor.internal/', 'file:///etc/passwd', 'http://user:pass@example.com/']) {
    assert.throws(() => assertPublicUrl(url), /rede interna|http\(s\)|usuário e senha|inválido/, url);
  }
  // mesmo um serviço de verdade escutando em localhost não é alcançado
  const target = http.createServer((q, s) => s.end('segredo interno')).listen(0, '127.0.0.1');
  await new Promise(r => target.once('listening', r));
  await assert.rejects(fetchWithLimit(`http://127.0.0.1:${target.address().port}/`), /rede interna/);
  await assert.rejects(loadSource({ type: 'url', url: `http://localhost:${target.address().port}/` }), /rede interna/);
  target.close();
});

test('SSRF: o bloqueio vale no momento da conexão (nome que resolve para rede interna)', async () => {
  // "localhost." (com ponto final) escapa de filtros por nome, mas resolve para 127.0.0.1
  await assert.rejects(fetchWithLimit('http://localhost.:9/'), /rede interna/);
});

test('turma: só membros ouvem o tempo real; token na URL só vale no canal de eventos', async () => {
  const prof = (await call('POST', '/users', null, { name: 'Prof', role: 'professor' })).data.token;
  const intruso = (await call('POST', '/users', null, { name: 'Intruso' })).data.token;
  const text = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');
  const study = (await call('POST', '/studies', prof, { type: 'text', text })).data.study;
  const { room } = (await call('POST', '/rooms', prof, { studyId: study.id })).data;

  const ev = await fetch(`${base}/rooms/${room.code}/events?token=${intruso}`);
  assert.equal(ev.status, 403, 'quem não entrou na turma não recebe nomes e notas');
  await ev.body?.cancel();

  // token na URL fora do canal de eventos não autentica (vazaria em logs e histórico)
  assert.equal((await call('GET', '/me', null, null, { query: `?token=${prof}` })).status, 401);
  // e o professor não lê o estudo de outra pessoa nem apaga
  assert.equal((await call('GET', `/studies/${study.id}`, intruso)).status, 404);
  assert.equal((await call('DELETE', `/studies/${study.id}`, intruso)).status, 404);
  assert.equal((await call('POST', `/studies/${study.id}/deepen`, intruso)).status, 404);
  assert.equal((await call('GET', `/studies/${study.id}/questions`, intruso)).status, 404);
});

test('preferências grandes são recusadas (antes eram cortadas e travavam a conta)', async () => {
  const u = await call('POST', '/users', null, { name: 'Pref' });
  const T = u.data.token;
  assert.equal((await call('PATCH', '/me', T, { prefs: { x: 'a'.repeat(5000) } })).status, 400);
  assert.equal((await call('GET', '/me', T)).status, 200, 'a conta continua funcionando');
});

test('limite de requisições: token inventado não ganha cota nova', async () => {
  let blocked = false;
  // limite anônimo = 30 × 5 = 150/min por IP; com tokens falsos, antes cada um tinha cota própria
  for (let i = 0; i < 170 && !blocked; i++) {
    const r = await call('GET', '/me', 'falso-' + i);
    if (r.status === 429) { blocked = true; assert.ok(r.headers.get('retry-after')); }
  }
  assert.ok(blocked, 'tokens falsos deveriam cair no limite por IP');
});

test('cabeçalhos de segurança', async () => {
  const r = await fetch(base.replace('/api', '/'));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

// ---------------- regressões da auditoria (cloudflare/security-audit-skill, run-1)
test('auditoria: HTML malicioso é removido em tempo linear (antes: regex quadrática na thread principal)', async () => {
  const { htmlToText } = await import('../server/ingest/index.js');
  for (const evil of ['<svg '.repeat(200000), 'a<'.repeat(500000), '<script>'.repeat(100000)]) {
    const t = Date.now();
    htmlToText(evil);
    assert.ok(Date.now() - t < 1000, `entrada de ${evil.length} bytes levou ${Date.now() - t} ms`);
  }
  const r = htmlToText('<title>T &amp; U</title><script>x="<p>"</script><nav>menu</nav><p>Um &#233; dois.</p><div>Três<br/>quatro</div> &#99999999; fim');
  assert.equal(r.title, 'T & U');
  assert.ok(r.text.includes('Um é dois.') && r.text.includes('Três') && !r.text.includes('menu') && !r.text.includes('x='));
});

test('auditoria: detecção de propaganda em fala é quase linear (antes: ~N·P²)', async () => {
  const { prepareSpoken } = await import('../server/nlp/spoken.js');
  const P = 3000;
  const sentences = [...Array.from({ length: P }, () => ({ text: 'Inscreva no canal e deixa o like aí galera.' })),
    ...Array.from({ length: P }, (_, i) => ({ text: `O hipocampo registra a memória número ${i} durante o sono profundo.` }))];
  const t = Date.now();
  prepareSpoken(sentences);
  assert.ok(Date.now() - t < 2000, `levou ${Date.now() - t} ms`);
  // semântica preservada: frase presa entre duas propagandas próximas sai; longe delas fica
  const small = ['Inscreva no canal agora mesmo galera.', 'A memória de trabalho guarda poucos itens por vez.', 'Deixa o like e compartilha com a galera.',
    'O sono profundo consolida a memória de longo prazo no córtex.', 'O hipocampo reativa as lembranças durante a noite inteira.',
    'As ondas lentas acompanham a reativação no sono profundo.', 'O sono REM ajuda nas memórias emocionais e na criatividade.',
    'Adultos devem dormir de sete a nove horas por noite.', 'A cafeína bloqueia a adenosina e atrasa o sono profundo.'].map(text => ({ text }));
  const kept = prepareSpoken(small).sentences.map(s => s.text);
  assert.ok(!kept.some(t => t.includes('memória de trabalho')), 'entre duas propagandas sai');
  assert.ok(kept.some(t => t.includes('cafeína')), 'longe da propaganda fica');
});

test('auditoria: SSRF cobre IPv6 especiais e o YouTube exige o host certo', async () => {
  for (const ip of ['2002:7f00:1::', '2001:0:1::1', '::7f00:1', '64:ff9b:1::a00:1']) assert.ok(isPrivateAddress(ip), ip);
  const { youtubeId } = await import('../server/ingest/index.js');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeId('https://evil.example/?u=youtube.com/watch?v=abcdefghijk'), null);
});

test('auditoria: turma exige ser membro; finalizar é atômico; dica é registrada no servidor; nota inválida é recusada', async () => {
  const P = await import('../server/pipelines.js');
  const { db } = await import('../server/db.js');
  const rooms = await import('../server/rooms.js');
  const mk = (id) => { db.prepare("INSERT INTO users (id, name, role, token, created_at) VALUES (?, ?, 'aluno', ?, 0)").run(id, id, 'tk-' + id); return db.prepare('SELECT * FROM users WHERE id = ?').get(id); };
  const prof = mk('aud-prof'), aluno = mk('aud-aluno'), estranho = mk('aud-estranho');
  const text = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');
  const study = await P.createStudy(prof, { type: 'text', text });
  const room = rooms.createRoom(prof, study.id, 'T');
  rooms.joinRoom(aluno, room.code);
  rooms.joinRoom(estranho, room.code);
  db.prepare('DELETE FROM room_members WHERE user_id = ?').run('aud-estranho'); // saiu da turma
  db.prepare("INSERT INTO rooms (id, code, study_id, owner_id, name, created_at) VALUES ('rx', 'ZZZZZZ', ?, 'aud-prof', 'outra', 0)").run(study.id);
  assert.throws(() => P.startAttempt(aluno, study.id, { roomCode: 'ZZZZZZ' }), /Entre na turma/);

  const att = P.startAttempt(aluno, study.id, { roomCode: room.code });
  const mc = att.questions.find(q => q.type === 'mc');
  P.hintFor(aluno, att.id, mc.id);
  await P.answerQuestion(aluno, att.id, { questionId: mc.id, response: 0, hintUsed: false });
  assert.equal(db.prepare('SELECT hint_used FROM answers WHERE attempt_id = ? AND question_id = ?').get(att.id, mc.id).hint_used, 1, 'dica conta mesmo se o cliente omitir');

  const xp0 = db.prepare('SELECT xp FROM users WHERE id = ?').get('aud-aluno').xp;
  const [r1, r2] = await Promise.all([P.finishAttempt(aluno, att.id), P.finishAttempt(aluno, att.id)]);
  assert.ok(r1 && r2, 'as duas chamadas respondem');
  assert.notEqual(db.prepare('SELECT score FROM attempts WHERE id = ?').get(att.id).score, null, 'a prova termina com nota gravada');
  const bonus = db.prepare('SELECT xp FROM users WHERE id = ?').get('aud-aluno').xp - xp0;
  assert.ok(bonus > 0 && bonus <= 150, `bônus aplicado uma vez só (${bonus})`);
  await assert.rejects(P.answerQuestion(aluno, att.id, { questionId: att.questions.at(-1).id, response: 'x' }), /finalizada/);

  const open = att.questions.find(q => q.type !== 'mc');
  assert.throws(() => P.overrideAnswer(prof, att.id, open.id, undefined), /Nota inválida/);
});
