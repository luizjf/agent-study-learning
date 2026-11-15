// SQLite nativo do Node (node:sqlite) — sem dependência extra, arquivo único.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'aluno',
  token TEXT UNIQUE NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0, last_day TEXT, prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, source_type TEXT NOT NULL, source_url TEXT, video_id TEXT,
  lang TEXT, technical INTEGER NOT NULL DEFAULT 0, code_lang TEXT, word_count INTEGER,
  summary TEXT, sentences TEXT NOT NULL, graph TEXT NOT NULL, trace TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, type TEXT NOT NULL, kind TEXT, prompt TEXT NOT NULL,
  highlight TEXT, options TEXT, answer INTEGER, rubric TEXT, concepts TEXT NOT NULL,
  source TEXT, explanation TEXT, weight REAL NOT NULL DEFAULT 1, level INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, edited_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_questions_study ON questions(study_id, idx);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE, room_id TEXT,
  mode TEXT NOT NULL DEFAULT 'full', question_ids TEXT NOT NULL, perms TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER, score REAL, passed INTEGER,
  combo INTEGER NOT NULL DEFAULT 0, best_combo INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0, result TEXT, trace TEXT
);
CREATE INDEX IF NOT EXISTS ix_attempts_user ON attempts(user_id, study_id);
CREATE INDEX IF NOT EXISTS ix_attempts_room ON attempts(room_id);
-- placar da turma: sem este índice o JOIN era O(membros × tentativas) — 17,9 ms → 1,2 ms com 300 alunos
CREATE INDEX IF NOT EXISTS ix_attempts_room_user ON attempts(room_id, user_id);
CREATE TABLE IF NOT EXISTS answers (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, response TEXT, score REAL NOT NULL, detail TEXT,
  hint_used INTEGER NOT NULL DEFAULT 0, ms INTEGER, override REAL, answered_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS mastery (
  user_id TEXT NOT NULL, study_id TEXT NOT NULL, concept_id TEXT NOT NULL,
  score REAL NOT NULL, seen INTEGER NOT NULL DEFAULT 0, box INTEGER NOT NULL DEFAULT 1, due TEXT,
  PRIMARY KEY (user_id, study_id, concept_id)
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  concept_id TEXT, text TEXT NOT NULL, ts REAL, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notes ON notes(user_id, study_id);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS badges (
  user_id TEXT NOT NULL, badge TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, badge)
);
CREATE TABLE IF NOT EXISTS hint_uses (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS teach_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, study_id TEXT NOT NULL, concept_id TEXT NOT NULL,
  text TEXT NOT NULL, score REAL NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS llm_usage (day TEXT NOT NULL, user_id TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER);
CREATE INDEX IF NOT EXISTS ix_usage ON llm_usage(day, user_id);
`);

// Apagar é apagar: páginas liberadas são zeradas no arquivo (estudo excluído não fica recuperável).
db.exec('PRAGMA secure_delete = ON');

// Migrações aditivas (bancos criados antes destas colunas continuam funcionando)
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('questions', 'origin', "TEXT NOT NULL DEFAULT 'local'"); // local | examinador
addColumn('questions', 'archived', 'INTEGER NOT NULL DEFAULT 0');   // substituída por uma geração nova
addColumn('studies', 'deep_status', 'TEXT');                        // null | running | done | failed
addColumn('studies', 'deep_info', 'TEXT');
addColumn('llm_cache', 'study_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS ix_cache_study ON llm_cache(study_id)');
// servidor reiniciado no meio de uma geração: ela não vai terminar
db.exec("UPDATE studies SET deep_status = 'failed', deep_info = json_set(COALESCE(deep_info, '{}'), '$.error', 'interrompido: o servidor reiniciou') WHERE deep_status = 'running'");

// Cache de statements: o código chama db.prepare(sql) dentro das rotas; sem cache, o SQLite
// recompilava o mesmo SQL a cada requisição (achado no teste de carga).
const stmtCache = new Map();
const rawPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  let st = stmtCache.get(sql);
  if (!st) {
    st = rawPrepare(sql);
    if (stmtCache.size < 500) stmtCache.set(sql, st);
  }
  return st;
};

export const J = s => (s == null ? null : JSON.parse(s));
export const S = v => (v == null ? null : JSON.stringify(v));

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
