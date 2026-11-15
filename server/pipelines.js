// Os três grafos do sistema (graph engineering):
//   1. studyGraph  — fonte → conceitos → mapa → perguntas (→ agente Examinador, opcional)
//   2. answerGraph — correção local → (zona cinzenta? escala para agente) → XP/combo
//   3. finishGraph — agrega → decide 75% → aprovado | revisão → mentor → domínio → recompensa
import crypto from 'node:crypto';
import { StateGraph, END } from './graph/engine.js';
import { loadSource } from './ingest/index.js';
import { fmtTime, shuffle, rng, clamp } from './nlp/text.js';
import { neighbors } from './nlp/knowledge.js';
import { runAnalysis } from './nlp/pool.js';
import { describeAnalysis } from './nlp/analyze.js';
import { gradeLocal, gradeOpen, aggregate, PASS_MARK } from './nlp/grader.js';
import { callAgent, llmEnabled, GRADER_FOR, PROVIDER_LABEL } from './agents/index.js';
import { numberedContent, graphFromConcepts, questionsFromExam, essentialsFrom, lengthCues, longestShare, applyAudit } from './agents/normalize.js';
import { questionPlan } from './nlp/questions.js';
import { config } from './config.js';
import { db, J, S, tx } from './db.js';
import * as game from './game.js';

export { describeAnalysis };
export const newId = (n = 9) => crypto.randomBytes(n).toString('base64url');

// ---------------------------------------------------------------- 1. estudo
export const studyGraph = new StateGraph('estudo')
  .addNode('carregar', async (s) => ({ source: await loadSource(s.input), _note: 'fonte lida' }), { label: 'Lendo a fonte' })
  // Subgrafo analisar → conceitos → mapa → resumo → perguntas (server/nlp/analyze.js),
  // executado numa worker thread: o event loop segue livre para quem está fazendo prova.
  .addNode('analise', async (s) => {
    const { trace, ...out } = await runAnalysis({ id: s.id, sentences: s.source.sentences, sourceType: s.source.sourceType });
    return { ...out, _trace: trace, _note: `${out.questions.length} questões` };
  }, { label: 'Análise completa (em segundo plano)', agent: 'worker thread' })
  .setEntry('carregar')
  .addEdge('carregar', 'analise')
  .addEdge('analise', END)
  .compile();

function insertQuestions(studyId, questions, prefix = '') {
  const ins = db.prepare(`INSERT INTO questions (id, study_id, idx, type, kind, prompt, highlight, options, answer, rubric, concepts, source, explanation, weight, level, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const q of questions) {
    ins.run(`${studyId}.${prefix}${q.id}`, studyId, q.idx, q.type, q.kind, q.prompt, S(q.highlight), S(q.options), q.answer ?? null, S(q.rubric), S(q.concepts), S(q.source), q.explanation || null, q.weight, q.level, q.origin || 'local');
  }
}

export async function createStudy(user, input) {
  const id = newId();
  const { state, trace } = await studyGraph.invoke({ id, input }, { userId: user.id });
  const { source, graph, questions, sentences } = state;
  const deep = llmEnabled() && config.autoDeep && input.deep !== false && !userHasDeep(user.id);
  tx(() => {
    db.prepare(`INSERT INTO studies (id, owner_id, title, source_type, source_url, video_id, lang, technical, code_lang, word_count, summary, sentences, graph, trace, created_at, deep_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, user.id, String(source.title).slice(0, 160), source.sourceType, source.sourceUrl, source.videoId || null, state.lang,
        state.tech.technical ? 1 : 0, state.tech.codeLang, state.words, S(state.summary), S(sentences), S(graph), S(trace), Date.now(), deep ? 'running' : null);
    insertQuestions(id, questions);
  });
  // A prova local fica pronta na hora; os agentes leem tudo e trocam as perguntas em segundo plano.
  if (deep) deepenStudy(user, id, { alreadyMarked: true });
  return getStudy(id, user.id);
}

// ---------------------------------------------------------------- 1b. aprofundar (agentes leem o conteúdo inteiro)
const SOURCE_NAME = { youtube: 'vídeo (transcrição automática das legendas)', pdf: 'PDF', web: 'artigo da web', text: 'texto colado' };

function contextHeader(s) {
  return [
    `TÍTULO: ${s.title}`,
    `FONTE: ${SOURCE_NAME[s.source_type] || s.source_type}`,
    `IDIOMA: ${s.lang === 'en' ? 'inglês (escreva a prova em português do Brasil)' : 'português'}`,
    `CONTEÚDO TÉCNICO: ${s.technical ? `sim — linguagem principal: ${s.code_lang}` : 'não'}`,
  ].join('\n');
}

// etapa atual, para a tela mostrar "estudando o conteúdo" → "escrevendo as perguntas"
function setStage(id, stage) {
  const row = studyRow(id);
  if (row) db.prepare('UPDATE studies SET deep_info = ? WHERE id = ?').run(S({ ...(J(row.deep_info) || {}), stage }), id);
}

export const deepGraph = new StateGraph('aprofundar')
  .addNode('preparar', (s) => {
    const { text, sampled } = numberedContent(s.sentences);
    const plan = questionPlan(s.sentences.reduce((a, x) => a + x.text.split(/\s+/).length, 0), !!s.study.technical);
    return { content: text, plan, _note: `${s.sentences.length} frases${sampled ? ' (amostra uniforme: conteúdo longo)' : ''}` };
  }, { label: 'Preparando o conteúdo inteiro, numerado' })
  .addNode('mapear', async (s, ctx) => {
    setStage(s.study.id, 'estudar');
    const local = s.localGraph.nodes.map(n => n.label).join(', ');
    const r = await callAgent('cartografo', [
      contextHeader(s.study),
      `CONCEITOS QUE O MOTOR LOCAL ACHOU (podem ter ruído; use só como pista): ${local}`,
      'CONTEÚDO NUMERADO (cada linha: [índice · minuto/página] frase):',
      s.content,
    ].join('\n\n'), { userId: ctx.userId, studyId: s.study.id, heavy: true });
    const graph = r && graphFromConcepts(r.data.concepts, s.sentences, s.localGraph);
    if (!graph) return { graph: s.localGraph, mapBy: 'local', _note: 'cartógrafo indisponível: mantido o mapa local' };
    return { graph, mapBy: r.model, essentials: essentialsFrom(r.data.essentials, s.sentences), _note: `${graph.nodes.length} conceitos · ${r.model}${r.cached ? ' (cache)' : ''}` };
  }, { label: 'Mapa de conceitos', agent: 'cartógrafo · Sonnet' })
  .addNode('examinar', async (s, ctx) => {
    setStage(s.study.id, 'perguntar');
    const mapa = s.graph.nodes.map(n => `${n.id} · ${n.label} · nível ${n.level} (${n.tier})${n.parent ? ' · depende de ' + n.parent : ' · BASE'}`).join('\n');
    const r = await callAgent('examinador', [
      contextHeader(s.study),
      `PLANO DA PROVA: ${s.plan.mc} de múltipla escolha, ${s.plan.reasoning} de raciocínio, ${s.plan.code} de código, 1 de entrevista.`,
      `MAPA DE CONCEITOS (id · rótulo · nível · pré-requisito):\n${mapa}`,
      'CONTEÚDO NUMERADO (cada linha: [índice · minuto/página] frase):',
      s.content,
    ].join('\n\n'), { userId: ctx.userId, studyId: s.study.id, heavy: true });
    if (!r) return { exam: null, _note: 'examinador indisponível' };
    const stats = {};
    const exam = questionsFromExam(r.data, { graph: s.graph, sentences: s.sentences, technical: !!s.study.technical, codeLang: s.study.code_lang }, stats);
    const why = `descartadas: ${stats.blank} lacuna, ${stats.copy} copiada da fala, ${stats.cue} com pista de tamanho, ${stats.invalid} inválida; certa = mais longa em ${stats.longestRight}% das MC`;
    if (!exam) return { exam: null, _note: `prova do examinador reprovada na validação (${r.data.questions?.length || 0} recebidas; ${why})` };
    return { exam, examBy: r.model, _note: `${exam.length} questões válidas de ${r.data.questions.length} (${why}) · ${r.model}${r.cached ? ' (cache)' : ''}` };
  }, { label: 'Escrevendo a prova', agent: 'examinador · Sonnet' })
  // Auditoria de forma: se a certa costuma ser a mais longa, quem chuta "a maior" passa sem estudar.
  .addNode('auditar', async (s, ctx) => {
    setStage(s.study.id, 'auditar');
    const before = longestShare(s.exam);
    const flagged = lengthCues(s.exam);
    const r = await callAgent('auditor', {
      questoes: flagged.map(q => ({ id: q.id, pergunta: q.prompt, alternativas: q.options, certa: q.answer, trecho_fonte: q.source?.text || '' })),
    }, { userId: ctx.userId, studyId: s.study.id, heavy: true });
    if (!r) return { _note: `auditor indisponível; certa = mais longa em ${Math.round(before * 100)}% das MC` };
    const { questions, fixed } = applyAudit(s.exam, r.data);
    return { exam: questions, _note: `${fixed} de ${flagged.length} reescritas · certa = mais longa: ${Math.round(before * 100)}% → ${Math.round(longestShare(questions) * 100)}% · ${r.model}` };
  }, { label: 'Auditando a forma das alternativas', agent: 'auditor · Haiku' })
  .addNode('salvar', (s) => {
    const gen = Date.now().toString(36);
    tx(() => {
      db.prepare('UPDATE questions SET archived = 1 WHERE study_id = ? AND archived = 0').run(s.study.id);
      insertQuestions(s.study.id, s.exam, gen + '.');
      db.prepare('UPDATE studies SET graph = ? WHERE id = ?').run(S(s.graph), s.study.id);
      if (s.essentials) db.prepare('UPDATE studies SET summary = ? WHERE id = ?').run(S(s.essentials), s.study.id);
    });
    return { _note: `${s.exam.length} questões ativas` };
  }, { label: 'Trocando a prova local pela nova' })
  .setEntry('preparar')
  .addEdge('preparar', 'mapear')
  .addEdge('mapear', 'examinar')
  .addConditionalEdges('examinar', (s) => (!s.exam ? 'falhou' : longestShare(s.exam) > 0.25 ? 'pista' : 'ok'), { ok: 'salvar', pista: 'auditar', falhou: END })
  .addEdge('auditar', 'salvar')
  .addEdge('salvar', END)
  .compile();

const deepRunning = new Set();
// Um "aprofundar" por vez por usuário (auditoria): uma conta não enche a fila de LLM
// nem empurra a correção dos outros alunos para o modo local.
const deepByUser = new Map();
export const userHasDeep = userId => (deepByUser.get(userId) || 0) > 0;

/** Dispara os agentes em segundo plano. Não espera: o status fica em studies.deep_status. */
export function deepenStudy(user, studyId, { alreadyMarked = false } = {}) {
  const s = studyRow(studyId);
  if (!s) return null;
  if (!llmEnabled()) { const e = new Error('Os agentes estão desligados (modo local). Veja como ligar no README.'); e.status = 409; throw e; }
  if (deepRunning.has(studyId)) { const e = new Error('Os agentes já estão trabalhando neste estudo.'); e.status = 409; throw e; }
  if (userHasDeep(user.id)) { const e = new Error('Os agentes já estão estudando outro conteúdo seu. Aguarde terminar.'); e.status = 409; throw e; }
  deepRunning.add(studyId);
  deepByUser.set(user.id, (deepByUser.get(user.id) || 0) + 1);
  const startedAt = Date.now();
  const info = { startedAt, provider: config.llm };
  if (!alreadyMarked) db.prepare("UPDATE studies SET deep_status = 'running', deep_info = ? WHERE id = ?").run(S(info), studyId);
  else db.prepare('UPDATE studies SET deep_info = ? WHERE id = ?').run(S(info), studyId);
  (async () => {
    let status = 'failed', extra = {};
    try {
      const { state, trace } = await deepGraph.invoke({ study: s, sentences: J(s.sentences), localGraph: J(s.graph) }, { userId: user.id });
      if (state.exam) { status = 'done'; extra = { questions: state.exam.length, mapBy: state.mapBy, examBy: state.examBy }; }
      else extra = { error: 'Os agentes não devolveram uma prova válida. As perguntas locais continuam valendo.' };
      extra.trace = trace;
    } catch (err) {
      console.error('[aprofundar]', err); // detalhe só no log do servidor
      extra = { error: 'Falha inesperada ao gerar com os agentes. Tente "Refazer com os agentes".' };
    } finally {
      deepRunning.delete(studyId);
      deepByUser.set(user.id, Math.max(0, (deepByUser.get(user.id) || 1) - 1));
      // estudo excluído no meio do caminho: nada do que os agentes produziram pode sobrar
      if (!studyRow(studyId)) db.prepare('DELETE FROM llm_cache WHERE study_id = ?').run(studyId);
      if (studyRow(studyId)) {
        db.prepare('UPDATE studies SET deep_status = ?, deep_info = ? WHERE id = ?')
          .run(status, S({ ...info, finishedAt: Date.now(), ...extra }), studyId);
      }
    }
  })();
  return { status: 'running' };
}

// ---------------------------------------------------------------- excluir
/** Dono: apaga o estudo e tudo que veio dele. Participante de turma: tira da própria mesa. */
export function deleteStudy(user, studyId) {
  const s = studyRow(studyId);
  if (!s) return null;
  if (s.owner_id === user.id) {
    tx(() => {
      for (const t of ['mastery', 'teach_sessions', 'llm_cache']) db.prepare(`DELETE FROM ${t} WHERE study_id = ?`).run(studyId);
      // perguntas, provas (e respostas), anotações e turmas saem em cascata
      db.prepare('DELETE FROM studies WHERE id = ?').run(studyId);
    });
    return { deleted: 'all' };
  }
  tx(() => {
    for (const t of ['mastery', 'teach_sessions', 'notes', 'attempts']) db.prepare(`DELETE FROM ${t} WHERE study_id = ? AND user_id = ?`).run(studyId, user.id);
    db.prepare('DELETE FROM room_members WHERE user_id = ? AND room_id IN (SELECT id FROM rooms WHERE study_id = ?)').run(user.id, studyId);
  });
  return { deleted: 'mine' };
}

export function rowToQuestion(r) {
  return {
    id: r.id, idx: r.idx, type: r.type, kind: r.kind, prompt: r.prompt, highlight: J(r.highlight) || [],
    options: J(r.options), answer: r.answer, rubric: J(r.rubric), concepts: J(r.concepts), source: J(r.source),
    explanation: r.explanation, weight: r.weight, level: r.level, enabled: !!r.enabled, origin: r.origin,
  };
}

export function studyRow(id) {
  return db.prepare('SELECT * FROM studies WHERE id = ?').get(id);
}

export function getStudy(id, userId) {
  const s = studyRow(id);
  if (!s) return null;
  const graph = J(s.graph);
  const sentences = J(s.sentences);
  const mastery = Object.fromEntries(db.prepare('SELECT concept_id, score, box, due, seen FROM mastery WHERE user_id = ? AND study_id = ?').all(userId, id)
    .map(m => [m.concept_id, { score: m.score, box: m.box, due: m.due, seen: m.seen }]));
  const counts = db.prepare('SELECT type, COUNT(*) AS n FROM questions WHERE study_id = ? AND enabled = 1 AND archived = 0 GROUP BY type').all(id);
  const origin = db.prepare('SELECT origin FROM questions WHERE study_id = ? AND archived = 0 LIMIT 1').get(id)?.origin || 'local';
  const deepInfo = J(s.deep_info) || {};
  const attempts = db.prepare('SELECT id, score, passed, mode, started_at, finished_at FROM attempts WHERE user_id = ? AND study_id = ? ORDER BY started_at DESC LIMIT 10').all(userId, id);
  const noteCounts = Object.fromEntries(db.prepare('SELECT concept_id, COUNT(*) AS n FROM notes WHERE user_id = ? AND study_id = ? AND concept_id IS NOT NULL GROUP BY concept_id').all(userId, id).map(r => [r.concept_id, r.n]));
  return {
    id: s.id, ownerId: s.owner_id, isOwner: s.owner_id === userId, title: s.title, sourceType: s.source_type, sourceUrl: s.source_url, videoId: s.video_id,
    lang: s.lang, technical: !!s.technical, codeLang: s.code_lang, words: s.word_count, createdAt: s.created_at,
    // resumo local = índices de frases; resumo do Cartógrafo = { text, i } (ideia reescrita + frase de origem)
    summary: (J(s.summary) || []).map(x => (typeof x === 'number'
      ? { ...sentences[x], i: x, at: fmtTime(sentences[x]?.start) }
      : { text: x.text, i: x.i, start: sentences[x.i]?.start ?? null, page: sentences[x.i]?.page ?? null, at: fmtTime(sentences[x.i]?.start), rewritten: true })),
    graph: {
      root: graph.root, edges: graph.edges,
      nodes: graph.nodes.map(n => ({
        id: n.id, label: n.label, level: n.level, tier: n.tier, parent: n.parent, score: n.score, code: n.code,
        definition: n.definition ? cap(n.definition.predicate) : null,
        firstAt: sentences[n.first] ? { ...sentences[n.first], at: fmtTime(sentences[n.first].start) } : null,
        mastery: mastery[n.id] || null, notes: noteCounts[n.id] || 0,
      })),
    },
    questionCounts: Object.fromEntries(counts.map(c => [c.type, c.n])),
    questionsBy: origin === 'examinador' ? (deepInfo.examBy || 'examinador') : 'local',
    mapBy: graph.by === 'cartografo' ? (deepInfo.mapBy || 'cartógrafo') : 'local',
    deep: {
      status: s.deep_status, stage: deepInfo.stage || null, error: deepInfo.error || null, startedAt: deepInfo.startedAt || null, finishedAt: deepInfo.finishedAt || null,
      trace: deepInfo.trace || null, available: llmEnabled(), provider: PROVIDER_LABEL[config.llm],
    },
    attempts, trace: J(s.trace),
  };
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export function conceptDetail(studyId, conceptId, userId) {
  const s = studyRow(studyId);
  if (!s) return null;
  const graph = J(s.graph);
  const sentences = J(s.sentences);
  const node = graph.nodes.find(n => n.id === conceptId);
  if (!node) return null;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return {
    id: node.id, label: node.label, tier: node.tier, level: node.level,
    definition: node.definition ? cap(node.definition.predicate) : null,
    parent: node.parent ? { id: node.parent, label: byId.get(node.parent)?.label } : null,
    children: graph.nodes.filter(n => n.parent === node.id).map(n => ({ id: n.id, label: n.label })),
    related: neighbors(graph, node.id).slice(0, 5).map(x => ({ id: x.id, label: byId.get(x.id)?.label, weight: x.weight })),
    excerpts: node.sentences.slice(0, 4).map(i => ({ ...sentences[i], i, at: fmtTime(sentences[i].start) })),
    mastery: db.prepare('SELECT score, box, due, seen FROM mastery WHERE user_id = ? AND study_id = ? AND concept_id = ?').get(userId, studyId, conceptId) || null,
    notes: db.prepare('SELECT * FROM notes WHERE user_id = ? AND study_id = ? AND concept_id = ? ORDER BY created_at').all(userId, studyId, conceptId),
  };
}

// ---------------------------------------------------------------- 2. resposta
export const answerGraph = new StateGraph('resposta')
  .addNode('corrigir', (s) => ({ grade: gradeLocal(s.question, s.response) }), { label: 'Correção local' })
  .addNode('escalar', async (s, ctx) => {
    const q = s.question;
    const agentId = GRADER_FOR[q.type];
    const payload = {
      pergunta: q.prompt,
      resposta: String(s.response).slice(0, 4000),
      trecho_fonte: q.rubric?.expected?.slice(0, 1200),
      termos_esperados: (q.rubric?.keywords || []).map(k => k.term),
      ...(q.type === 'code' ? { linguagem: q.rubric.lang, elementos_esperados: q.rubric.codeTokens } : {}),
      nota_local: s.grade.score,
    };
    // studyId no cache: excluir o estudo apaga também as correções guardadas (que citam a resposta do aluno)
    const r = await callAgent(agentId, payload, { userId: ctx.userId, studyId: ctx.studyId });
    if (!r) return { _note: 'sem agente, vale a nota local' };
    const score = +clamp(Number(r.data.score) || 0, 0, 1).toFixed(2);
    // saída do modelo vira texto limitado, qualquer que seja o provedor
    const txt = (v, n = 600) => (typeof v === 'string' ? v.slice(0, n) : '');
    const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 5).map(x => x.slice(0, 200)) : []);
    return {
      grade: {
        ...s.grade, score, correct: score >= PASS_MARK, confidence: 'alta',
        feedback: txt(r.data.feedback) || s.grade.feedback,
        missing: list(r.data.missing).length ? list(r.data.missing) : s.grade.missing,
        strengths: list(r.data.strengths), improve: list(r.data.improve),
        by: r.model, localScore: s.grade.score,
      },
      _note: `${agentId} → ${r.model}${r.cached ? ' (cache)' : ''}`,
    };
  }, { label: 'Segunda opinião', agent: 'corretor·Haiku / revisor·Sonnet / entrevistador·Opus' })
  .addNode('pontuar', (s) => {
    const correct = s.grade.score >= PASS_MARK;
    const combo = correct ? s.combo + 1 : 0;
    const reward = game.xpForAnswer(s.question, { ...s.grade, correct }, { combo, hintUsed: s.hintUsed });
    return { combo, reward };
  }, { label: 'XP e combo' })
  .setEntry('corrigir')
  .addConditionalEdges('corrigir', (s) => (s.question.type !== 'mc' && s.grade.confidence === 'média' && llmEnabled() ? 'duvida' : 'ok'),
    { duvida: 'escalar', ok: 'pontuar' })
  .addEdge('escalar', 'pontuar')
  .addEdge('pontuar', END)
  .compile();

function loadAttempt(id) {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
  if (!a) return null;
  return { ...a, question_ids: J(a.question_ids), perms: J(a.perms) || {}, result: J(a.result) };
}

function questionsByIds(ids) {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT * FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(rowToQuestion);
  const m = new Map(rows.map(q => [q.id, q]));
  return ids.map(i => m.get(i)).filter(Boolean);
}

// Versão para o aluno: sem gabarito, opções embaralhadas por tentativa.
function publicQuestion(q, perm) {
  const base = { id: q.id, type: q.type, kind: q.kind, prompt: q.prompt, highlight: q.highlight, level: q.level, weight: q.weight, concepts: q.concepts };
  if (q.type === 'mc') base.options = perm.map(i => q.options[i]);
  if (q.type === 'code') base.lang = q.rubric?.lang;
  if (q.rubric?.minWords) base.minWords = q.rubric.minWords;
  return base;
}

export function startAttempt(user, studyId, { mode = 'full', roomCode } = {}) {
  const s = studyRow(studyId);
  if (!s) return null;
  // primeiro estudar, depois perguntar: com os agentes trabalhando, a prova ainda não existe
  if (s.deep_status === 'running') { const e = new Error('Os agentes ainda estão estudando o conteúdo. A prova abre assim que as perguntas ficarem prontas.'); e.status = 409; throw e; }
  let room = null;
  if (roomCode) {
    room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(roomCode).toUpperCase());
    if (!room || room.study_id !== studyId) { const e = new Error('Turma inválida para este estudo.'); e.status = 400; throw e; }
    // só quem é da turma (ou o professor) entra no placar e no feed dela
    if (room.owner_id !== user.id && !db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, user.id)) {
      const e = new Error('Entre na turma antes de fazer a prova dela.'); e.status = 403; throw e;
    }
  }
  let qs = db.prepare('SELECT * FROM questions WHERE study_id = ? AND enabled = 1 AND archived = 0 ORDER BY idx').all(studyId).map(rowToQuestion);
  if (mode === 'review') {
    // Revisão: só questões dos conceitos fracos (domínio < 75%), do básico ao avançado
    const weak = new Set(db.prepare('SELECT concept_id FROM mastery WHERE user_id = ? AND study_id = ? AND score < ?').all(user.id, studyId, PASS_MARK).map(r => r.concept_id));
    const picked = qs.filter(q => q.concepts.some(c => weak.has(c)));
    qs = picked.length ? picked : qs.filter(q => q.type === 'mc').slice(0, 5);
  }
  const rand = rng(user.id + Date.now());
  const perms = {};
  for (const q of qs) if (q.type === 'mc') perms[q.id] = shuffle(q.options.map((_, i) => i), rand);
  const id = newId();
  db.prepare('INSERT INTO attempts (id, user_id, study_id, room_id, mode, question_ids, perms, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, studyId, room?.id || null, mode, S(qs.map(q => q.id)), S(perms), Date.now());
  game.touchStreak(user.id);
  return { id, studyId, mode, roomCode: room?.code || null, passMark: PASS_MARK, questions: qs.map(q => publicQuestion(q, perms[q.id])) };
}

export async function answerQuestion(user, attemptId, { questionId, response, hintUsed = false, ms = null }) {
  const a = loadAttempt(attemptId);
  if (!a || a.user_id !== user.id) return null;
  if (a.finished_at) { const e = new Error('Essa prova já foi finalizada.'); e.status = 409; throw e; }
  if (!a.question_ids.includes(questionId)) { const e = new Error('Questão não pertence a esta prova.'); e.status = 400; throw e; }
  const prev = db.prepare('SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?').get(attemptId, questionId);
  if (prev) { const e = new Error('Questão já respondida.'); e.status = 409; throw e; }
  const [q] = questionsByIds([questionId]);
  // MC: traduz a opção embaralhada de volta para o índice original
  const resp = q.type === 'mc' ? a.perms[q.id]?.[Number(response)] ?? -1 : String(response ?? '').slice(0, 8000);
  // dica conta pelo registro do servidor (o cliente não consegue "esquecer" que pediu)
  const usedHint = !!hintUsed || !!db.prepare('SELECT 1 FROM hint_uses WHERE attempt_id = ? AND question_id = ?').get(attemptId, questionId);
  const { state, trace } = await answerGraph.invoke({ question: q, response: resp, combo: a.combo, hintUsed: usedHint }, { userId: user.id, studyId: a.study_id });
  const { grade, combo, reward } = state;
  // Entre a verificação acima e aqui houve um await: um clique duplo (ou a finalização) pode ter chegado antes.
  const inserted = tx(() => {
    if (db.prepare('SELECT finished_at FROM attempts WHERE id = ?').get(attemptId)?.finished_at) return 'finished';
    const r = db.prepare('INSERT OR IGNORE INTO answers (attempt_id, question_id, response, score, detail, hint_used, ms, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(attemptId, questionId, String(resp), grade.score, S({ ...grade, trace }), usedHint ? 1 : 0, ms, Date.now());
    if (!r.changes) return false;
    db.prepare('UPDATE attempts SET combo = ?, best_combo = MAX(best_combo, ?), xp = xp + ? WHERE id = ?').run(combo, combo, reward.xp, attemptId);
    game.addXp(user.id, reward.xp);
    return true;
  });
  if (inserted === 'finished') { const e = new Error('Essa prova já foi finalizada.'); e.status = 409; throw e; }
  if (!inserted) { const e = new Error('Questão já respondida.'); e.status = 409; throw e; }
  const answered = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE attempt_id = ?').get(attemptId).n;
  const out = {
    questionId, score: grade.score, correct: grade.score >= PASS_MARK, feedback: grade.feedback, by: grade.by,
    xp: reward.xp, chest: reward.chest, combo, answered, total: a.question_ids.length,
    found: grade.found, missing: grade.missing, syntax: grade.syntax, strengths: grade.strengths, improve: grade.improve,
    source: q.source,
  };
  if (q.type === 'mc') {
    out.correctOption = a.perms[q.id].indexOf(q.answer);
    out.explanation = q.explanation;
  } else {
    out.expected = q.rubric?.expected;
  }
  return { result: out, attempt: a, user };
}

// Dica sem custo de token e sem entregar a resposta.
//  - Múltipla escolha: elimina duas alternativas erradas ("50/50") e diz onde o assunto aparece.
//  - Abertas: mostra o trecho-fonte com os termos apagados.
export function hintFor(user, attemptId, questionId) {
  const a = loadAttempt(attemptId);
  if (!a || a.user_id !== user.id || !a.question_ids.includes(questionId)) return null;
  if (!a.finished_at) db.prepare('INSERT OR IGNORE INTO hint_uses (attempt_id, question_id, at) VALUES (?, ?, ?)').run(attemptId, questionId, Date.now());
  const [q] = questionsByIds([questionId]);
  const where = q.source?.at ? `por volta de ${q.source.at}` : q.source?.page ? `na página ${q.source.page}` : null;
  if (q.type === 'mc') {
    const perm = a.perms[q.id] || q.options.map((_, i) => i);
    const wrong = perm.map((orig, shown) => ({ orig, shown })).filter(x => x.orig !== q.answer);
    const r = rng(attemptId + questionId);
    const eliminate = shuffle(wrong, r).slice(0, 2).map(x => x.shown).sort();
    const about = q.highlight?.length ? `«${q.highlight[0]}»` : 'esse ponto';
    return { hint: `Tirei duas alternativas erradas. O conteúdo fala de ${about}${where ? ' ' + where : ''}.`, eliminate, at: q.source?.at, page: q.source?.page };
  }
  const src = q.source?.text || '';
  let text = src;
  for (const term of q.highlight || []) text = text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '▢▢▢');
  if (q.kind === 'cloze') text = 'Pense no conceito que completa a frase. Ele aparece no trecho sobre ' + (q.source?.at ? `o minuto ${q.source.at}` : 'esse assunto') + '.';
  return { hint: text || 'Releia o enunciado com calma: a resposta está nos termos destacados.', at: q.source?.at, page: q.source?.page };
}

// ---------------------------------------------------------------- 3. finalização
function localMentor(score, passed, review, graphNodes) {
  const pct = Math.round(score * 100);
  if (passed && !review.length) return `Você fechou com ${pct}%. Tudo que caiu na prova está firme.`;
  if (passed) return `Aprovado com ${pct}%. Para deixar sólido, dê uma olhada em ${review.slice(0, 2).map(r => '«' + r.label + '»').join(' e ')}.`;
  const first = review[0];
  const child = first && graphNodes.find(n => n.parent === first.id);
  const gap = Math.max(1, Math.round(PASS_MARK * 100) - pct);
  return `Faltaram ${gap} pontos para os 75%. Comece por «${first?.label || 'o básico'}»${child ? `, que sustenta «${child.label}»` : ''}. Depois refaça só o que errou — leva poucos minutos.`;
}

export const finishGraph = new StateGraph('finalizar')
  .addNode('agregar', (s) => ({ agg: aggregate(s.questions, s.grades, s.graph) }), { label: 'Somando a nota' })
  .addNode('aprovado', (s, ctx) => {
    const badges = [game.award(ctx.userId, 'aprovado')];
    if (s.agg.score >= 0.999) badges.push(game.award(ctx.userId, 'nota-maxima'));
    if (s.hadFailedBefore) badges.push(game.award(ctx.userId, 'persistente'));
    return { bonus: 100, badges: badges.filter(Boolean) };
  }, { label: 'Aprovado (≥ 75%)' })
  .addNode('revisao', () => ({ bonus: 0, badges: [] }), { label: 'Plano de revisão' })
  .addNode('mentor', async (s, ctx) => {
    const local = localMentor(s.agg.score, s.agg.passed, s.agg.review, s.graph.nodes);
    if (!llmEnabled() || !s.agg.review.length) return { mentor: { message: local, by: 'local' } };
    const r = await callAgent('mentor', {
      nota: Math.round(s.agg.score * 100), meta: 75, aprovado: s.agg.passed,
      conceitos_fracos: s.agg.review.slice(0, 5).map(c => ({ conceito: c.label, nivel: c.tier, dominio: c.mastery })),
    }, { userId: ctx.userId, studyId: s.studyId });
    const plan = Array.isArray(r?.data.plan) ? r.data.plan.slice(0, 4).filter(p => p && typeof p.concept === 'string' && typeof p.action === 'string')
      .map(p => ({ concept: p.concept.slice(0, 80), action: p.action.slice(0, 240) })) : [];
    return { mentor: r && typeof r.data.message === 'string' ? { message: r.data.message.slice(0, 800), plan, by: r.model } : { message: local, by: 'local' } };
  }, { label: 'Mensagem do mentor', agent: 'mentor · Haiku' })
  .addNode('dominio', (s, ctx) => { game.updateMastery(ctx.userId, s.studyId, s.agg.conceptMastery); }, { label: 'Atualizando o mapa de domínio' })
  .addNode('recompensa', (s, ctx) => {
    const badges = [...s.badges, game.award(ctx.userId, 'primeiro-passo')];
    if (s.bestCombo >= 5) badges.push(game.award(ctx.userId, 'combo-5'));
    for (const q of s.questions) {
      const g = s.grades[q.id];
      if (!g || g.score < PASS_MARK) continue;
      if (q.type === 'interview') badges.push(game.award(ctx.userId, 'entrevistado'));
      if (q.type === 'code') badges.push(game.award(ctx.userId, 'codigo-limpo'));
    }
    const streak = game.touchStreak(ctx.userId);
    if (streak >= 3) badges.push(game.award(ctx.userId, 'sequencia-3'));
    const bonus = s.bonus + 20; // terminar já vale: esforço é recompensado
    game.addXp(ctx.userId, bonus);
    return { bonus, streak, badges: badges.filter(Boolean) };
  }, { label: 'XP e conquistas' })
  .setEntry('agregar')
  .addConditionalEdges('agregar', (s) => (s.agg.passed ? 'passou' : 'nao'), { passou: 'aprovado', nao: 'revisao' })
  .addEdge('aprovado', 'mentor').addEdge('revisao', 'mentor')
  .addEdge('mentor', 'dominio').addEdge('dominio', 'recompensa').addEdge('recompensa', END)
  .compile();

function gradesOf(attemptId) {
  const rows = db.prepare('SELECT question_id, score, override, detail, response, hint_used FROM answers WHERE attempt_id = ?').all(attemptId);
  return Object.fromEntries(rows.map(r => [r.question_id, { score: r.override ?? r.score, detail: J(r.detail), response: r.response, hintUsed: !!r.hint_used, overridden: r.override != null }]));
}

export async function finishAttempt(user, attemptId) {
  const a = loadAttempt(attemptId);
  if (!a || a.user_id !== user.id) return null;
  if (a.finished_at) return attemptResult(user, attemptId);
  // Reivindica a finalização de forma atômica ANTES de dar recompensas: dois "finalizar"
  // simultâneos não aplicam bônus em dobro, e nenhuma resposta entra depois daqui.
  const claimed = db.prepare('UPDATE attempts SET finished_at = ? WHERE id = ? AND finished_at IS NULL').run(Date.now(), attemptId).changes;
  if (!claimed) return attemptResult(user, attemptId);
  try {
    const s = studyRow(a.study_id);
    const graph = J(s.graph);
    const questions = questionsByIds(a.question_ids);
    const grades = gradesOf(attemptId);
    const hadFailedBefore = !!db.prepare('SELECT 1 FROM attempts WHERE user_id = ? AND study_id = ? AND passed = 0 AND id != ?').get(user.id, a.study_id, attemptId);
    const { state, trace } = await finishGraph.invoke({ studyId: a.study_id, questions, grades, graph, bestCombo: a.best_combo, hadFailedBefore }, { userId: user.id });
    const result = { ...state.agg, mentor: state.mentor, bonus: state.bonus, badges: state.badges, streak: state.streak };
    db.prepare('UPDATE attempts SET finished_at = ?, score = ?, passed = ?, result = ?, trace = ?, xp = xp + ? WHERE id = ?')
      .run(Date.now(), state.agg.score, state.agg.passed ? 1 : 0, S(result), S(trace), state.bonus, attemptId);
  } catch (err) {
    db.prepare('UPDATE attempts SET finished_at = NULL WHERE id = ? AND result IS NULL').run(attemptId); // deixa tentar de novo
    throw err;
  }
  return attemptResult(user, attemptId);
}

export function attemptResult(user, attemptId, { asTeacher = false } = {}) {
  const a = loadAttempt(attemptId);
  if (!a || (!asTeacher && a.user_id !== user.id)) return null;
  const s = studyRow(a.study_id);
  const sentences = J(s.sentences);
  const graph = J(s.graph);
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const questions = questionsByIds(a.question_ids);
  const grades = gradesOf(attemptId);
  const items = questions.map(q => {
    const g = grades[q.id];
    const perm = a.perms[q.id];
    const item = {
      id: q.id, type: q.type, kind: q.kind, prompt: q.prompt, highlight: q.highlight, weight: q.weight,
      score: g?.score ?? 0, answered: !!g, overridden: g?.overridden || false,
      feedback: g?.detail?.feedback, by: g?.detail?.by, found: g?.detail?.found, missing: g?.detail?.missing,
      source: q.source, concepts: q.concepts.map(c => ({ id: c, label: nodes.get(c)?.label })),
    };
    // Prova em andamento: o gabarito só aparece para o que já foi respondido.
    const reveal = asTeacher || a.finished_at || g;
    if (q.type === 'mc') {
      item.options = perm.map(i => q.options[i]);
      item.chosen = g ? perm.indexOf(Number(g.response)) : null;
      if (reveal) { item.correctOption = perm.indexOf(q.answer); item.explanation = q.explanation; }
    } else {
      item.response = g?.response ?? '';
      if (reveal) item.expected = q.rubric?.expected;
    }
    return item;
  });
  const result = a.result || {};
  // cada conceito a rever aponta para o trecho onde ele aparece (vídeo: minuto; PDF: página)
  const review = (result.review || []).map(r => {
    const n = nodes.get(r.id);
    const sent = n ? sentences[n.definition?.sentence ?? n.first] : null;
    return { ...r, definition: n?.definition ? cap(n.definition.predicate) : null, source: sent ? { text: sent.text, start: sent.start, page: sent.page, at: fmtTime(sent.start) } : null };
  });
  return {
    id: a.id, studyId: a.study_id, studyTitle: s.title, videoId: s.video_id, sourceType: s.source_type, sourceUrl: s.source_url,
    mode: a.mode, finished: !!a.finished_at, score: a.score, passed: !!a.passed, passMark: PASS_MARK,
    xp: a.xp, bestCombo: a.best_combo, startedAt: a.started_at, finishedAt: a.finished_at,
    mentor: result.mentor, badges: result.badges || [], streak: result.streak, review, items,
    trace: J(a.trace),
  };
}

// Professor ajusta a nota de uma resposta aberta → recalcula a prova.
export function overrideAnswer(teacher, attemptId, questionId, score) {
  const a = loadAttempt(attemptId);
  if (!a) return null;
  const s = studyRow(a.study_id);
  const room = a.room_id ? db.prepare('SELECT owner_id FROM rooms WHERE id = ?').get(a.room_id) : null;
  if (s.owner_id !== teacher.id && room?.owner_id !== teacher.id) { const e = new Error('Só o professor do estudo ou da turma pode ajustar notas.'); e.status = 403; throw e; }
  if (score === null || score === '' || !Number.isFinite(Number(score))) { const e = new Error('Nota inválida: use um número de 0 a 1.'); e.status = 400; throw e; }
  const v = clamp(Number(score), 0, 1);
  const r = db.prepare('UPDATE answers SET override = ? WHERE attempt_id = ? AND question_id = ?').run(v, attemptId, questionId);
  if (!r.changes) return null;
  if (a.finished_at) {
    const agg = aggregate(questionsByIds(a.question_ids), gradesOf(attemptId), J(s.graph));
    const result = { ...(a.result || {}), ...agg };
    db.prepare('UPDATE attempts SET score = ?, passed = ?, result = ? WHERE id = ?').run(agg.score, agg.passed ? 1 : 0, S(result), attemptId);
  }
  return attemptResult(teacher, attemptId, { asTeacher: true });
}

// ---------------------------------------------------------------- Ensinar de volta (Feynman)
export function teachBack(user, studyId, conceptId, text) {
  const s = studyRow(studyId);
  if (!s) return null;
  const graph = J(s.graph);
  const node = graph.nodes.find(n => n.id === conceptId);
  if (!node) return null;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const rel = neighbors(graph, conceptId).slice(0, 3).map(x => byId.get(x.id)).filter(Boolean);
  const q = { type: 'reasoning', rubric: { minWords: 30, keywords: [{ term: node.label, key: node.key, weight: 2 }, ...rel.map(n => ({ term: n.label, key: n.key, weight: 1 }))] } };
  const g = gradeOpen(q, text);
  let reply;
  if (g.words < 12) reply = 'Hmm, foi rápido demais pra mim. Pode explicar de novo, com um exemplo do dia a dia?';
  else if (g.score >= PASS_MARK) reply = `Agora fez sentido! Então «${node.label}» tem tudo a ver com ${g.found.filter(f => f !== node.label).slice(0, 2).map(f => '«' + f + '»').join(' e ') || 'o que você contou'}. Valeu!`;
  else if (g.missing.length) reply = `Entendi a parte de ${g.found.slice(0, 2).map(f => '«' + f + '»').join(' e ') || 'começo'}… mas onde entra «${g.missing[0]}» nessa história?`;
  else reply = 'Acho que entendi, mas pode me dar um exemplo concreto?';
  const xp = Math.round(30 * g.score);
  game.addXp(user.id, xp);
  const badge = g.score >= PASS_MARK ? game.award(user.id, 'professor') : null;
  db.prepare('INSERT INTO teach_sessions (id, user_id, study_id, concept_id, text, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId(), user.id, studyId, conceptId, text.slice(0, 6000), g.score, Date.now());
  return { score: g.score, reply, found: g.found, missing: g.missing, xp, badge };
}
