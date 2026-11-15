// Teste de carga: N usuários simultâneos fazendo o fluxo completo.
//   node scripts/loadtest.js [baseUrl] [usuarios] [pensarMs] [criadoresPct]
// Ex.: node scripts/loadtest.js http://localhost:3000 100 250 20
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:3000') + '/api';
const USERS = Number(process.argv[3] || 100);
const THINK = Number(process.argv[4] ?? 250);       // "tempo pensando" médio entre respostas (ms)
const CREATORS = Number(process.argv[5] ?? 20);     // % de usuários que também criam um estudo
const text = fs.readFileSync(new URL('../tests/fixtures/async-js.txt', import.meta.url), 'utf8');

const stats = new Map(); // rota → [ms]
const server = new Map(); // rota → [ms gastos dentro do servidor]
const errors = new Map(); // "rota status msg" → n
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => (THINK ? THINK * (0.4 + Math.random() * 1.2) : 0);

async function call(method, path, token, body, label) {
  const name = label || `${method} ${path.replace(/\/rooms\/[A-Z0-9]{6}/, '/rooms/:code').replace(/\/[A-Za-z0-9_-]{12}(\.q\d+)?(?=\/|$)/g, '/:id')}`;
  const t0 = performance.now();
  let res, data = null;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    data = res.status === 204 ? null : await res.json().catch(() => null);
  } catch (e) {
    const k = `${name} REDE ${e.cause?.code || e.message}`;
    errors.set(k, (errors.get(k) || 0) + 1);
    throw e;
  }
  const ms = performance.now() - t0;
  if (!stats.has(name)) stats.set(name, []);
  stats.get(name).push(ms);
  const st = Number((res.headers.get('server-timing') || '').match(/dur=([\d.]+)/)?.[1]);
  if (!Number.isNaN(st)) { if (!server.has(name)) server.set(name, []); server.get(name).push(st); }
  if (!res.ok) {
    const k = `${name} ${res.status} ${data?.error || ''}`;
    errors.set(k, (errors.get(k) || 0) + 1);
    const err = new Error(k); err.status = res.status; throw err;
  }
  return data;
}

// Cliente SSE mínimo: conta eventos recebidos.
function listen(code, token) {
  const ctrl = new AbortController();
  const counter = { events: 0, ok: false };
  fetch(`${BASE}/rooms/${code}/events?token=${token}`, { signal: ctrl.signal }).then(async res => {
    counter.ok = res.ok;
    const dec = new TextDecoder();
    for await (const chunk of res.body) counter.events += (dec.decode(chunk).match(/^event:/gm) || []).length;
  }).catch(() => {});
  return { counter, close: () => ctrl.abort() };
}

const pctl = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function student(i, code, studyId, key) {
  const { token } = await call('POST', '/users', null, { name: `Aluno ${i}` });
  await call('POST', `/rooms/${code}/join`, token);
  const sse = listen(code, token);
  try {
    await call('GET', `/studies/${studyId}`, token);
    if (i % Math.round(100 / Math.max(1, CREATORS)) === 0) {
      await call('POST', '/studies', token, { type: 'text', text: text + `\n\nObservação do aluno ${i}: revisar o event loop e a fila de microtasks.` });
    }
    const { attempt } = await call('POST', `/studies/${studyId}/attempts`, token, { roomCode: code });
    const skill = Math.random(); // cada aluno tem um "nível" diferente
    for (const q of attempt.questions) {
      await sleep(jitter());
      const k = key.get(q.id);
      let response;
      if (q.type === 'mc') response = Math.random() < skill ? q.options.indexOf(k.options[k.answer]) : Math.floor(Math.random() * 4);
      else if (q.type === 'code') response = 'const [a, b] = await Promise.all([buscarPerfil(id), buscarPedidos(id)]);\nconsole.log(a, b);';
      else response = Math.random() < skill ? k.rubric.keywords.map(x => x.term).join(', ') + '. Por exemplo, num projeto real; mas com cuidado com erros.' : 'não sei direito';
      await call('POST', `/attempts/${attempt.id}/answer`, token, { questionId: q.id, response }, 'POST /attempts/:id/answer');
    }
    const { result } = await call('POST', `/attempts/${attempt.id}/finish`, token, undefined, 'POST /attempts/:id/finish');
    await call('GET', `/attempts/${attempt.id}`, token, undefined, 'GET /attempts/:id');
    await call('POST', `/studies/${studyId}/notes`, token, { text: `Nota do aluno ${i}`, conceptId: result.review[0]?.id || null });
    await call('GET', `/studies/${studyId}/concepts/${result.review[0]?.id || 'c0'}`, token, undefined, 'GET /studies/:id/concepts/:c');
    await call('GET', `/rooms/${code}`, token, undefined, 'GET /rooms/:code');
    return { passed: result.passed, score: result.score, sse: sse.counter };
  } finally {
    setTimeout(() => sse.close(), 1500);
  }
}

async function main() {
  const health0 = await call('GET', '/health?reset=1');
  const prof = await call('POST', '/users', null, { name: 'Professora', role: 'professor' });
  const { study } = await call('POST', '/studies', prof.token, { type: 'text', text, title: 'Carga' });
  const { room } = await call('POST', '/rooms', prof.token, { studyId: study.id, name: 'Turma de carga' });
  const { questions } = await call('GET', `/studies/${study.id}/questions`, prof.token);
  const key = new Map(questions.map(q => [q.id, q]));
  const teacherSse = listen(room.code, prof.token);
  stats.clear(); errors.clear(); server.clear();

  console.log(`→ ${USERS} usuários simultâneos · pensar ~${THINK}ms · ${CREATORS}% criam estudo · ${questions.length} questões cada`);
  const t0 = performance.now();
  // todos começam juntos (rajada de entrada), como uma turma recebendo o código ao mesmo tempo
  const results = await Promise.allSettled(Array.from({ length: USERS }, (_, i) => student(i + 1, room.code, study.id, key)));
  const wall = (performance.now() - t0) / 1000;
  await sleep(1800);
  const health1 = await call('GET', '/health');
  const view = await call('GET', `/rooms/${room.code}`, prof.token);
  teacherSse.close();

  const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected');
  const total = [...stats.values()].reduce((a, v) => a + v.length, 0);
  console.log(`\nConcluíram: ${ok.length}/${USERS}  ·  falharam: ${failed.length}  ·  tempo total: ${wall.toFixed(1)}s  ·  ${total} requisições (${(total / wall).toFixed(0)} req/s)`);
  console.log(`Aprovados: ${ok.filter(r => r.passed).length}  ·  nota média: ${(ok.reduce((a, r) => a + r.score, 0) / Math.max(1, ok.length) * 100).toFixed(0)}%`);
  console.log(`SSE: ${ok.filter(r => r.sse.ok).length} conexões abertas · eventos recebidos por aluno (mín/méd): ${Math.min(...ok.map(r => r.sse.events))}/${(ok.reduce((a, r) => a + r.sse.events, 0) / Math.max(1, ok.length)).toFixed(0)} · professor: ${teacherSse.counter.events}`);
  console.log(`Placar da turma: ${view.room.members} membros · taxa de aprovação ${Math.round((view.room.passRate ?? 0) * 100)}% · respostas abertas p/ revisar: ${view.room.toReview.length}`);
  console.log(`Memória do servidor: ${health0.memMB} MB → ${health1.memMB} MB  ·  atraso do event loop do servidor p50/p99/máx: ${health1.eventLoop.p50}/${health1.eventLoop.p99}/${health1.eventLoop.max} ms`);
  console.log('\nRota'.padEnd(40) + 'n'.padStart(6) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'máx'.padStart(9) + '  servidor p50/p95');
  for (const [name, arr] of [...stats.entries()].sort()) {
    console.log(name.padEnd(39) + String(arr.length).padStart(6) + [0.5, 0.95, 0.99, 1].map(p => (pctl(arr, p).toFixed(0) + 'ms').padStart(9)).join('') + (server.get(name) ? `   ${pctl(server.get(name), 0.5).toFixed(1)}/${pctl(server.get(name), 0.95).toFixed(1)}ms` : ''));
  }
  if (errors.size) {
    console.log('\nErros:');
    for (const [k, n] of errors) console.log(`  ${n}× ${k}`);
  } else console.log('\nNenhum erro HTTP.');
  const report = { users: USERS, think: THINK, wall, ok: ok.length, failed: failed.length, errors: Object.fromEntries(errors), mem: [health0.memMB, health1.memMB], eventLoop: health1.eventLoop,
    routes: Object.fromEntries([...stats].map(([k, v]) => [k, { n: v.length, p50: pctl(v, 0.5), p95: pctl(v, 0.95), p99: pctl(v, 0.99), max: pctl(v, 1), serverP50: server.get(k) && pctl(server.get(k), 0.5), serverP95: server.get(k) && pctl(server.get(k), 0.95) }])) };
  if (process.env.LOAD_REPORT) fs.writeFileSync(process.env.LOAD_REPORT, JSON.stringify(report, null, 2));
  process.exit(failed.length || errors.size ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
