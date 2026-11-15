// Camada de jogo: XP, combo, nível, conquistas, sequência diária e repetição espaçada.
// Pensado para TDAH: recompensa imediata e frequente, esforço também conta, sem punição.
import { db } from './db.js';

export const BADGES = {
  'primeiro-passo': { name: 'Primeiro passo', desc: 'Terminou a primeira prova.' },
  'aprovado': { name: 'Aprovado', desc: 'Passou dos 75% pela primeira vez.' },
  'combo-5': { name: 'Embalado', desc: '5 acertos seguidos.' },
  'nota-maxima': { name: 'Gabaritou', desc: '100% em uma prova.' },
  'entrevistado': { name: 'Contratável', desc: 'Mandou bem na pergunta de entrevista.' },
  'codigo-limpo': { name: 'Mão no código', desc: 'Resposta em código aprovada.' },
  'professor': { name: 'Professor', desc: 'Ensinou um conceito de volta e foi entendido.' },
  'persistente': { name: 'Persistente', desc: 'Passou depois de não ter passado antes.' },
  'sequencia-3': { name: 'Três dias seguidos', desc: 'Estudou 3 dias em sequência.' },
  'anotador': { name: 'Caderno cheio', desc: 'Fez 5 anotações.' },
};

export function levelOf(xp) {
  const level = Math.floor(Math.sqrt(xp / 50)) + 1;
  return { level, xp, current: 50 * (level - 1) ** 2, next: 50 * level ** 2 };
}

export function comboMultiplier(combo) {
  return combo >= 5 ? 2 : combo >= 3 ? 1.5 : 1;
}

// XP de uma resposta. `rand` permite o "baú surpresa" (recompensa variável).
export function xpForAnswer(q, grade, { combo, hintUsed, rand = Math.random }) {
  let xp, chest = 0;
  if (q.type === 'mc') {
    xp = grade.correct ? Math.round(10 * comboMultiplier(combo)) : 2; // tentar já vale algo
    if (grade.correct && rand() < 0.12) chest = 15;
  } else {
    xp = Math.round(25 * grade.score) + (grade.score >= 0.75 ? 5 : 0) + 3;
  }
  if (hintUsed) xp = Math.ceil(xp / 2);
  return { xp: xp + chest, chest };
}

export function award(userId, badge) {
  const r = db.prepare('INSERT OR IGNORE INTO badges (user_id, badge, at) VALUES (?, ?, ?)').run(userId, badge, Date.now());
  return r.changes ? { id: badge, ...BADGES[badge] } : null;
}

export function addXp(userId, amount) {
  if (amount > 0) db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?').run(amount, userId);
}

const dayStr = d => d.toISOString().slice(0, 10);

export function touchStreak(userId) {
  const u = db.prepare('SELECT streak, last_day FROM users WHERE id = ?').get(userId);
  if (!u) return 0;
  const today = dayStr(new Date());
  const yesterday = dayStr(new Date(Date.now() - 86400000));
  if (u.last_day === today) return u.streak;
  const streak = u.last_day === yesterday ? u.streak + 1 : 1;
  db.prepare('UPDATE users SET streak = ?, last_day = ? WHERE id = ?').run(streak, today, userId);
  return streak;
}

const BOX_DAYS = [1, 2, 4, 8, 16];

// Repetição espaçada por conceito (caixas de Leitner) + domínio com média móvel.
export function updateMastery(userId, studyId, conceptMastery) {
  const get = db.prepare('SELECT score, seen, box FROM mastery WHERE user_id = ? AND study_id = ? AND concept_id = ?');
  const put = db.prepare(`INSERT INTO mastery (user_id, study_id, concept_id, score, seen, box, due) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, study_id, concept_id) DO UPDATE SET score = excluded.score, seen = excluded.seen, box = excluded.box, due = excluded.due`);
  for (const [cid, now] of Object.entries(conceptMastery)) {
    const old = get.get(userId, studyId, cid);
    const score = old ? +(old.score * 0.4 + now * 0.6).toFixed(2) : now;
    const box = now >= 0.75 ? Math.min(5, (old?.box || 0) + 1) : 1;
    const due = dayStr(new Date(Date.now() + BOX_DAYS[box - 1] * 86400000));
    put.run(userId, studyId, cid, score, (old?.seen || 0) + 1, box, due);
  }
}

export function badgesFor(userId) {
  return db.prepare('SELECT badge, at FROM badges WHERE user_id = ? ORDER BY at').all(userId)
    .map(b => ({ id: b.badge, at: b.at, ...BADGES[b.badge] }));
}
