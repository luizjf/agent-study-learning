// Turmas: o professor cria a partir de um estudo, os alunos entram com um código.
// Tempo real por Server-Sent Events (sem dependência): presença, progresso e placar.
import crypto from 'node:crypto';
import { db, J } from './db.js';
import { newId } from './pipelines.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L
const channels = new Map(); // code -> Map(res -> userId)

function makeCode() {
  for (let t = 0; t < 20; t++) {
    const bytes = crypto.randomBytes(6);
    const code = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('');
    if (!db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code)) return code;
  }
  throw new Error('Não consegui gerar um código de turma.');
}

export function createRoom(user, studyId, name) {
  const s = db.prepare('SELECT owner_id, title FROM studies WHERE id = ?').get(studyId);
  if (!s) return null;
  if (s.owner_id !== user.id) { const e = new Error('Só quem criou o estudo pode abrir uma turma com ele.'); e.status = 403; throw e; }
  const room = { id: newId(), code: makeCode(), study_id: studyId, owner_id: user.id, name: String(name || s.title).slice(0, 80), created_at: Date.now() };
  db.prepare('INSERT INTO rooms (id, code, study_id, owner_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(room.id, room.code, room.study_id, room.owner_id, room.name, room.created_at);
  return room;
}

export function roomByCode(code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(code || '').toUpperCase());
}

export function joinRoom(user, code) {
  const room = roomByCode(code);
  if (!room) return null;
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(room.id, user.id, Date.now());
  queueEvent(room.code, { type: 'presence' });
  return room;
}

export function myRooms(userId) {
  return db.prepare(`SELECT r.code, r.name, r.study_id AS studyId, r.owner_id = ? AS isOwner,
      (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members
    FROM rooms r WHERE r.owner_id = ? OR r.id IN (SELECT room_id FROM room_members WHERE user_id = ?)
    ORDER BY r.created_at DESC`).all(userId, userId, userId);
}

function online(code) {
  return new Set((channels.get(code) || new Map()).values());
}


export function roomView(user, code) {
  const room = roomByCode(code);
  if (!room) return null;
  const isOwner = room.owner_id === user.id;
  const study = db.prepare('SELECT id, title, graph FROM studies WHERE id = ?').get(room.study_id);
  const on = online(room.code);
  const board = boardFor(room).map(r => ({ ...r, me: r.id === user.id }));
  const out = {
    code: room.code, name: room.name, isOwner, study: { id: study.id, title: study.title },
    members: board.length, online: on.size, board,
  };
  if (isOwner) {
    // Painel do professor: conceitos que a turma mais erra + respostas abertas para revisar
    const nodes = new Map(J(study.graph).nodes.map(n => [n.id, n]));
    const sums = new Map();
    const rows = db.prepare('SELECT result FROM attempts WHERE room_id = ? AND finished_at IS NOT NULL').all(room.id);
    for (const r of rows) {
      for (const [cid, v] of Object.entries(J(r.result)?.conceptMastery || {})) {
        const s = sums.get(cid) || { t: 0, n: 0 };
        s.t += v; s.n++;
        sums.set(cid, s);
      }
    }
    out.weakConcepts = [...sums.entries()].map(([id, s]) => ({ id, label: nodes.get(id)?.label, level: nodes.get(id)?.level, avg: +(s.t / s.n).toFixed(2), n: s.n }))
      .sort((a, b) => a.avg - b.avg).slice(0, 8);
    out.passRate = rows.length ? +(db.prepare('SELECT AVG(passed) AS p FROM attempts WHERE room_id = ? AND finished_at IS NOT NULL').get(room.id).p).toFixed(2) : null;
    out.toReview = db.prepare(`SELECT a.id AS attemptId, u.name, q.id AS questionId, q.type, q.prompt, ans.response, ans.score, ans.override
      FROM answers ans JOIN attempts a ON a.id = ans.attempt_id JOIN users u ON u.id = a.user_id JOIN questions q ON q.id = ans.question_id
      WHERE a.room_id = ? AND q.type != 'mc' ORDER BY (ans.override IS NOT NULL), ABS(ans.score - 0.6) LIMIT 30`).all(room.id);
  }
  return out;
}

// Placar: melhor nota finalizada na turma + XP ganho nas provas da turma.
// Micro-cache de 1 s: quando a turma inteira termina junto e abre o placar, a consulta roda
// uma vez por segundo, não uma vez por aluno.
const boardCache = new Map(); // roomId -> { at, rows }
function boardFor(room) {
  const hit = boardCache.get(room.id);
  const on = online(room.code);
  if (hit && Date.now() - hit.at < 1000) return hit.rows.map(r => ({ ...r, online: on.has(r.id) }));
  const rows = queryBoard(room);
  boardCache.set(room.id, { at: Date.now(), rows });
  if (boardCache.size > 1000) boardCache.delete(boardCache.keys().next().value);
  return rows.map(r => ({ ...r, online: on.has(r.id) }));
}

function queryBoard(room) {
  return db.prepare(`SELECT u.id, u.name,
      MAX(a.score) AS best, SUM(COALESCE(a.xp, 0)) AS xp, COUNT(a.id) AS attempts,
      MAX(a.passed) AS passed
    FROM room_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN attempts a ON a.user_id = u.id AND a.room_id = m.room_id
    WHERE m.room_id = ? GROUP BY u.id ORDER BY xp DESC, best DESC LIMIT 200`).all(room.id)
    .map(r => ({ id: r.id, name: r.name, best: r.best, xp: r.xp || 0, attempts: r.attempts, passed: !!r.passed }));
}

// ---------------- eventos agrupados
// Antes: cada resposta virava 1 evento para CADA aluno conectado (O(N²): ~1.200 eventos por
// aluno com 100 alunos, e cada evento fazia o navegador recarregar o placar).
// Agora: os eventos de uma turma se acumulam e saem num único "tick" a cada 1,5 s, já com o
// placar calculado uma vez para todos.
const TICK_MS = 1500;
const pending = new Map(); // code -> { feed: [], timer }

export function queueEvent(code, item) {
  if (!channels.has(code)) return;
  let p = pending.get(code);
  if (!p) {
    p = { feed: [], timer: setTimeout(() => flush(code), TICK_MS) };
    p.timer.unref?.();
    pending.set(code, p);
  }
  // progresso: só a última posição de cada aluno importa
  if (item.type === 'progress') {
    const i = p.feed.findIndex(f => f.type === 'progress' && f.userId === item.userId);
    if (i >= 0) p.feed.splice(i, 1);
  }
  if (item.type === 'presence') return; // só garante que um tick sai com a contagem nova
  p.feed.push(item);
  if (p.feed.length > 40) p.feed.shift();
}

function flush(code) {
  const p = pending.get(code);
  pending.delete(code);
  if (!p || !channels.has(code)) return;
  const room = roomByCode(code);
  if (!room) return;
  const board = boardFor(room);
  broadcast(code, 'tick', { feed: p.feed, board, members: board.length, online: online(code).size });
}

// ---------------- SSE
const MAX_CONN_PER_USER = 3; // abas abertas de um mesmo usuário na mesma turma
const MAX_CONN_PER_USER_TOTAL = 10;
export function subscribe(code, userId, res) {
  if (!channels.has(code)) channels.set(code, new Map());
  const ch = channels.get(code);
  if ([...ch.values()].filter(u => u === userId).length >= MAX_CONN_PER_USER) return false;
  // teto por usuário somando todas as turmas (ele pode criar turmas nos próprios estudos)
  let total = 0;
  for (const c of channels.values()) for (const u of c.values()) if (u === userId) total++;
  if (total >= MAX_CONN_PER_USER_TOTAL) return false;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 4000\n\n');
  ch.set(res, userId);
  queueEvent(code, { type: 'presence' });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    ch.delete(res);
    if (!ch.size) channels.delete(code);
    else queueEvent(code, { type: 'presence' });
  });
  return true;
}

export function broadcast(code, event, data) {
  const ch = channels.get(code);
  if (!ch) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of ch.keys()) res.write(msg);
}

export function channelStats() {
  let subs = 0;
  for (const ch of channels.values()) subs += ch.size;
  return { rooms: channels.size, subscribers: subs };
}
