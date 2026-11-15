import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config, ROOT } from './config.js';
import { db, J, S } from './db.js';
import * as P from './pipelines.js';
import * as rooms from './rooms.js';
import * as game from './game.js';
import { agentsInfo, llmEnabled, findClaudeBin, agentQueue, usedToday, PROVIDER_LABEL } from './agents/index.js';
import { IngestError } from './ingest/index.js';
import { poolStats } from './nlp/pool.js';

export const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.json({ limit: '2mb' }));

// ---------------- Server-Timing: quanto tempo o servidor gastou (separa da latência de rede/cliente)
app.use((req, res, next) => {
  const t0 = performance.now();
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${(performance.now() - t0).toFixed(1)}`);
    return writeHead.apply(this, args);
  };
  next();
});

// ---------------- segurança básica
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    // frame-ancestors impede clickjacking; object-src/base-uri/form-action fecham vetores clássicos de injeção
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});

// Limite de requisições — janela de 1 minuto.
// Logado: por usuário (token). Anônimo (só o cadastro): por IP, com teto maior, porque uma
// turma inteira costuma sair pelo MESMO IP (NAT da escola). Achado no teste de carga.
const buckets = new Map();
// Token só vale na URL para o canal de tempo real (EventSource não envia cabeçalhos).
// Em qualquer outra rota ele ficaria exposto em logs, histórico e Referer.
const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || (req.path.endsWith('/events') ? String(req.query.token || '') : '');
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  // Só token VÁLIDO ganha cota própria. Antes, um token inventado a cada requisição
  // contornava o limite (inclusive para criar contas sem fim).
  const token = tokenOf(req);
  const valid = token && userFromToken(token);
  const key = valid ? 't:' + valid.id : 'ip:' + req.ip;
  const limit = valid ? config.rateLimitPerMin : config.rateLimitPerMin * 5;
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, t: now };
  if (now - b.t > 60000) { b.n = 0; b.t = now; }
  b.n++;
  buckets.set(key, b);
  if (b.n > limit) {
    res.set('Retry-After', String(Math.ceil((60000 - (now - b.t)) / 1000)));
    return res.status(429).json({ error: 'Muitas requisições. Respire um pouco e tente de novo.' });
  }
  next();
});
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 120000) buckets.delete(k); }, 60000).unref();

// ---------------- autenticação leve (protótipo): nome + token aleatório
function userFromToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM users WHERE token = ?').get(token) || null;
}
const auth = (req, res, next) => {
  const user = userFromToken(tokenOf(req));
  if (!user) return res.status(401).json({ error: 'Entre com seu nome para continuar.' });
  req.user = user;
  next();
};
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (res, what = 'Não encontrado.') => res.status(404).json({ error: what });

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, xp: u.xp, streak: u.streak, prefs: J(u.prefs) || {}, ...game.levelOf(u.xp) };
}

// Atraso do event loop: se sobe, alguém está bloqueando a thread principal.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
// Detalhes operacionais (fila, memória, reset das métricas) só para quem está NESTA máquina.
const isLoopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
app.get('/api/health', (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) return res.json({ ok: true });
  const ms = v => +(v / 1e6).toFixed(1);
  const eventLoop = { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) };
  if (req.query.reset) loopDelay.reset();
  res.json({ ok: true, llm: config.llm, agents: agentQueue(), sse: rooms.channelStats(), workers: poolStats(), eventLoop, uptime: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1048576) });
});

app.post('/api/users', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Escolha um nome com pelo menos 2 letras.' });
  const role = req.body?.role === 'professor' ? 'professor' : 'aluno';
  const u = { id: P.newId(), token: crypto.randomBytes(24).toString('base64url') };
  db.prepare('INSERT INTO users (id, name, role, token, created_at) VALUES (?, ?, ?, ?, ?)').run(u.id, name, role, u.token, Date.now());
  res.status(201).json({ token: u.token, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user), badges: game.badgesFor(req.user.id), allBadges: game.BADGES, llm: llmEnabled() });
});

app.patch('/api/me', auth, (req, res) => {
  const { role, prefs } = req.body || {};
  if (role === 'aluno' || role === 'professor') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.user.id);
  if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) {
    const merged = { ...(J(req.user.prefs) || {}), ...prefs };
    // recusa em vez de cortar: JSON cortado no meio travaria a conta (J() falharia em toda requisição)
    if (S(merged).length > 4000) return res.status(400).json({ error: 'Preferências grandes demais.' });
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(S(merged), req.user.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

app.get('/api/agents', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = token ? db.prepare('SELECT id FROM users WHERE token = ?').get(token) : null;
  res.json({
    mode: config.llm, provider: PROVIDER_LABEL[config.llm] || config.llm, agents: agentsInfo(),
    claudeCode: config.llm === 'claude-code' ? { found: !!findClaudeBin() } : undefined,
    budget: llmEnabled() && config.llm !== 'ollama' ? { daily: config.dailyTokenBudget, used: user ? usedToday(user.id) : 0 } : null,
  });
});

app.get('/api/graphs', (req, res) => {
  res.json({ estudo: P.studyGraph.describe(), analise: P.describeAnalysis(), resposta: P.answerGraph.describe(), finalizar: P.finishGraph.describe() });
});

// ---------------- estudos
app.get('/api/studies', auth, (req, res) => {
  const rows = db.prepare(`SELECT s.id, s.title, s.source_type AS sourceType, s.technical, s.word_count AS words, s.created_at AS createdAt, s.owner_id = ? AS isOwner,
      (SELECT MAX(score) FROM attempts a WHERE a.study_id = s.id AND a.user_id = ?) AS best,
      (SELECT COUNT(*) FROM mastery m WHERE m.study_id = s.id AND m.user_id = ? AND m.due <= date('now')) AS due
    FROM studies s
    WHERE s.owner_id = ? OR s.id IN (SELECT r.study_id FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?)
    ORDER BY s.created_at DESC LIMIT 100`).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json({ studies: rows, rooms: rooms.myRooms(req.user.id) });
});

app.post('/api/studies', auth, wrap(async (req, res) => {
  const { type, url, text, title, deep } = req.body || {};
  if (!['url', 'text'].includes(type)) return res.status(400).json({ error: 'Envie um link ou um texto.' });
  const study = await P.createStudy(req.user, { type, url, text, title, deep: deep !== false });
  res.status(201).json({ study });
}));

app.post('/api/studies/pdf', auth, express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
  const study = await P.createStudy(req.user, { type: 'pdf', buffer: req.body, title: String(req.query.title || '').slice(0, 160) || undefined, deep: req.query.deep !== '0' });
  res.status(201).json({ study });
}));

function canSee(user, studyId) {
  const s = P.studyRow(studyId);
  if (!s) return null;
  if (s.owner_id === user.id) return s;
  const inRoom = db.prepare('SELECT 1 FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE r.study_id = ? AND m.user_id = ?').get(studyId, user.id);
  return inRoom ? s : null;
}

app.get('/api/studies/:id', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res, 'Estudo não encontrado.');
  res.json({ study: P.getStudy(req.params.id, req.user.id) });
});

// Dono: apaga o estudo inteiro (provas, anotações, turmas, cache dos agentes).
// Participante de turma: tira o estudo da própria mesa (só os próprios dados).
app.delete('/api/studies/:id', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res, 'Estudo não encontrado.');
  res.json(P.deleteStudy(req.user, req.params.id));
});

// Os agentes leem o conteúdo inteiro e refazem mapa + prova (em segundo plano).
app.post('/api/studies/:id/deepen', auth, (req, res) => {
  const s = P.studyRow(req.params.id);
  if (!s || s.owner_id !== req.user.id) return notFound(res);
  res.status(202).json(P.deepenStudy(req.user, s.id));
});

app.get('/api/studies/:id/concepts/:cid', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res);
  const c = P.conceptDetail(req.params.id, req.params.cid, req.user.id);
  c ? res.json({ concept: c }) : notFound(res);
});

// Modo professor: ver/editar o gabarito
app.get('/api/studies/:id/questions', auth, (req, res) => {
  const s = P.studyRow(req.params.id);
  if (!s || s.owner_id !== req.user.id) return notFound(res);
  res.json({ questions: db.prepare('SELECT * FROM questions WHERE study_id = ? AND archived = 0 ORDER BY idx').all(s.id).map(P.rowToQuestion) });
});

app.patch('/api/questions/:id', auth, (req, res) => {
  const q = db.prepare('SELECT q.*, s.owner_id FROM questions q JOIN studies s ON s.id = q.study_id WHERE q.id = ?').get(req.params.id);
  if (!q || q.owner_id !== req.user.id) return notFound(res);
  const { prompt, options, answer, enabled, explanation } = req.body || {};
  if (prompt != null && (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 4000)) return res.status(400).json({ error: 'Enunciado inválido (5 a 4.000 caracteres).' });
  if (options != null && (!Array.isArray(options) || options.length < 2 || options.length > 6 || options.some(o => typeof o !== 'string' || !o.trim() || o.length > 600))) return res.status(400).json({ error: 'Opções inválidas.' });
  if (explanation != null && (typeof explanation !== 'string' || explanation.length > 2000)) return res.status(400).json({ error: 'Explicação grande demais.' });
  const opts = options ?? J(q.options);
  const ans = answer ?? q.answer;
  if (q.type === 'mc' && !(ans >= 0 && ans < opts.length)) return res.status(400).json({ error: 'Gabarito fora das opções.' });
  db.prepare('UPDATE questions SET prompt = ?, options = ?, answer = ?, enabled = ?, explanation = ?, edited_by = ? WHERE id = ?')
    .run(prompt ?? q.prompt, S(opts), ans, enabled == null ? q.enabled : (enabled ? 1 : 0), explanation ?? q.explanation, req.user.id, q.id);
  res.json({ question: P.rowToQuestion(db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id)) });
});

// ---------------- provas
app.post('/api/studies/:id/attempts', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res);
  const attempt = P.startAttempt(req.user, req.params.id, { mode: req.body?.mode === 'review' ? 'review' : 'full', roomCode: req.body?.roomCode });
  res.status(201).json({ attempt });
});

app.post('/api/attempts/:id/answer', auth, wrap(async (req, res) => {
  const out = await P.answerQuestion(req.user, req.params.id, req.body || {});
  if (!out) return notFound(res);
  const { result, attempt } = out;
  if (attempt.room_id) {
    const room = db.prepare('SELECT code FROM rooms WHERE id = ?').get(attempt.room_id);
    rooms.queueEvent(room.code, { type: 'progress', userId: req.user.id, name: req.user.name, answered: result.answered, total: result.total, combo: result.combo });
  }
  res.json({ result, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
}));

app.get('/api/attempts/:id/hint/:qid', auth, (req, res) => {
  const h = P.hintFor(req.user, req.params.id, req.params.qid);
  h ? res.json(h) : notFound(res);
});

app.post('/api/attempts/:id/finish', auth, wrap(async (req, res) => {
  const r = await P.finishAttempt(req.user, req.params.id);
  if (!r) return notFound(res);
  const a = db.prepare('SELECT room_id FROM attempts WHERE id = ?').get(req.params.id);
  if (a.room_id) {
    const room = db.prepare('SELECT code FROM rooms WHERE id = ?').get(a.room_id);
    rooms.queueEvent(room.code, { type: 'finished', userId: req.user.id, name: req.user.name, score: r.score, passed: r.passed });
  }
  res.json({ result: r, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
}));

app.get('/api/attempts/:id', auth, (req, res) => {
  let r = P.attemptResult(req.user, req.params.id);
  if (!r) {
    // professor da turma ou dono do estudo pode ver a prova do aluno
    const a = db.prepare('SELECT a.room_id, s.owner_id FROM attempts a JOIN studies s ON s.id = a.study_id WHERE a.id = ?').get(req.params.id);
    const roomOwner = a?.room_id ? db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(a.room_id)?.owner_id : null;
    if (a && (a.owner_id === req.user.id || roomOwner === req.user.id)) r = P.attemptResult(req.user, req.params.id, { asTeacher: true });
  }
  r ? res.json({ result: r }) : notFound(res);
});

app.patch('/api/attempts/:id/answers/:qid', auth, (req, res) => {
  const r = P.overrideAnswer(req.user, req.params.id, req.params.qid, req.body?.score);
  r ? res.json({ result: r }) : notFound(res);
});

// ---------------- ensinar de volta
app.post('/api/studies/:id/teach', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res);
  const text = String(req.body?.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'Escreva sua explicação.' });
  const r = P.teachBack(req.user, req.params.id, req.body?.conceptId, text);
  r ? res.json(r) : notFound(res);
});

// ---------------- anotações
app.get('/api/studies/:id/notes', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res);
  res.json({ notes: db.prepare('SELECT * FROM notes WHERE user_id = ? AND study_id = ? ORDER BY created_at DESC').all(req.user.id, req.params.id) });
});

app.post('/api/studies/:id/notes', auth, (req, res) => {
  if (!canSee(req.user, req.params.id)) return notFound(res);
  const text = String(req.body?.text || '').trim().slice(0, 5000);
  if (!text) return res.status(400).json({ error: 'A anotação está vazia.' });
  const id = P.newId();
  const now = Date.now();
  const ts = req.body?.ts == null ? null : Number(req.body.ts);
  db.prepare('INSERT INTO notes (id, user_id, study_id, concept_id, text, ts, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.params.id, req.body?.conceptId || null, text, Number.isFinite(ts) ? ts : null, String(req.body?.color || 'amarelo').slice(0, 12), now, now);
  const count = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?').get(req.user.id).n;
  const badge = count >= 5 ? game.award(req.user.id, 'anotador') : null;
  res.status(201).json({ note: db.prepare('SELECT * FROM notes WHERE id = ?').get(id), badge });
});

app.patch('/api/notes/:id', auth, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!n) return notFound(res);
  const text = req.body?.text != null ? String(req.body.text).trim().slice(0, 5000) : n.text;
  if (!text) return res.status(400).json({ error: 'A anotação está vazia.' });
  db.prepare('UPDATE notes SET text = ?, concept_id = ?, updated_at = ? WHERE id = ?').run(text, req.body?.conceptId !== undefined ? req.body.conceptId : n.concept_id, Date.now(), n.id);
  res.json({ note: db.prepare('SELECT * FROM notes WHERE id = ?').get(n.id) });
});

app.delete('/api/notes/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  r.changes ? res.status(204).end() : notFound(res);
});

// ---------------- turmas
app.post('/api/rooms', auth, (req, res) => {
  const room = rooms.createRoom(req.user, req.body?.studyId, req.body?.name);
  room ? res.status(201).json({ room: { code: room.code, name: room.name } }) : notFound(res);
});

app.post('/api/rooms/:code/join', auth, (req, res) => {
  const room = rooms.joinRoom(req.user, req.params.code);
  room ? res.json({ room: { code: room.code, name: room.name, studyId: room.study_id } }) : notFound(res, 'Código de turma não encontrado.');
});

app.get('/api/rooms/:code', auth, (req, res) => {
  const room = rooms.roomByCode(req.params.code);
  if (!room) return notFound(res);
  const member = room.owner_id === req.user.id || db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Entre na turma primeiro.' });
  res.json({ room: rooms.roomView(req.user, req.params.code) });
});

app.get('/api/rooms/:code/events', auth, (req, res) => {
  const room = rooms.roomByCode(req.params.code);
  if (!room) return notFound(res);
  // Só professor e membros ouvem a turma (antes, qualquer logado com o código via nomes e notas).
  const member = room.owner_id === req.user.id || db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Entre na turma primeiro.' });
  if (!rooms.subscribe(room.code, req.user.id, res)) return res.status(429).json({ error: 'Conexões demais abertas para esta turma.' });
});

// ---------------- arquivos estáticos
const fontDirs = {
  atkinson: '@fontsource/atkinson-hyperlegible/files',
  fraunces: '@fontsource-variable/fraunces/files',
  mono: '@fontsource/jetbrains-mono/files',
};
for (const [k, dir] of Object.entries(fontDirs)) {
  app.use(`/fonts/${k}`, express.static(path.join(ROOT, 'node_modules', dir), { maxAge: '30d', immutable: true }));
}
// O executor de código do aluno roda num Web Worker isolado: pode usar eval, mas não tem rede nem DOM.
app.get('/js/runner.worker.js', (req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'");
  next();
});
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------------- erros
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo grande demais.' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'JSON inválido.' });
  const status = err.status || (err instanceof IngestError ? 422 : 500);
  if (status >= 500) console.error(`[erro] ${req.method} ${req.path}`, err.graph ? `(grafo ${err.graph}, nó ${err.node})` : '', err);
  res.status(status).json({ error: status >= 500 ? 'Algo deu errado do nosso lado.' : err.message, hint: err.hint });
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'server', 'index.js');
if (isMain) {
  // A assinatura do Claude é pessoal: exposta na rede, qualquer um nela gastaria o seu limite.
  if (config.llm === 'claude-code' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    console.error('Recusado: o modo claude-code (sua assinatura) só roda em localhost. Para turmas na rede, use ANTHROPIC_API_KEY (TRILHA_LLM=claude).');
    process.exit(1);
  }
  app.listen(config.port, config.host, () => {
    const cc = config.llm === 'claude-code' ? (findClaudeBin() ? ` — Claude Code: ${findClaudeBin()}` : ' — ATENÇÃO: Claude Code não encontrado (defina TRILHA_CLAUDE_BIN)') : '';
    console.log(`Trilha rodando em http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}  (agentes: ${PROVIDER_LABEL[config.llm] || config.llm}${cc})`);
  });
}
