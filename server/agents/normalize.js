// Converte (e valida) o que o Cartógrafo e o Examinador devolvem para o formato da Trilha.
// Regra: nada do LLM entra sem checagem. Pergunta com gabarito inválido, opções repetidas,
// trecho-fonte inexistente ou conceito desconhecido é corrigida ou descartada.
import { tokenize, stem, fmtTime, isCodeToken, isStop } from '../nlp/text.js';

const keyOf = t => tokenize(String(t)).map(w => stem(w.toLowerCase())).join(' ');
const joinedOf = t => ' ' + keyOf(t) + ' ';
const TIERS = ['Base', 'Fundamentos', 'Aplicação', 'Avançado', 'Topo'];

/**
 * Texto numerado que os agentes leem: "[12 · 3:45] frase". Conteúdo longo é amostrado
 * de forma uniforme (o começo, o meio e o fim entram), respeitando `maxChars`.
 */
export function numberedContent(sentences, maxChars = 90000) {
  const lines = sentences.map((s, i) => `[${i}${s.start != null ? ' · ' + fmtTime(s.start) : s.page != null ? ' · p.' + s.page : ''}] ${s.text}`);
  const total = lines.reduce((a, l) => a + l.length + 1, 0);
  if (total <= maxChars) return { text: lines.join('\n'), sampled: false };
  const keep = Math.max(0.05, maxChars / total);
  const out = [];
  let acc = 0;
  lines.forEach((l, i) => { acc += keep; if (acc >= 1) { acc -= 1; out.push(l); } else if (i === 0) out.push(l); });
  return { text: out.join('\n'), sampled: true };
}

/** Mapa do Cartógrafo → grafo da Trilha. Reaproveita o id de conceitos que já existiam (mesmas notas/domínio). */
export function graphFromConcepts(concepts, sentences, previous = null) {
  const joined = sentences.map(s => joinedOf(s.text));
  const prevByKey = new Map((previous?.nodes || []).map(n => [n.key, n.id]));
  const seen = new Set();
  const list = [];
  for (const c of concepts || []) {
    const label = String(c.label || '').trim().slice(0, 80);
    const key = keyOf(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    const evidence = (c.evidence || []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < sentences.length);
    const mentions = joined.map((j, i) => (j.includes(' ' + key + ' ') ? i : -1)).filter(i => i >= 0);
    const sents = [...new Set([...evidence, ...mentions])].sort((a, b) => a - b);
    if (!sents.length) continue; // conceito que não aparece no conteúdo: inventado, fora
    list.push({ raw: c, label, key, sents, evidence });
  }
  if (list.length < 4) return null;

  const ids = new Map();
  const used = new Set();
  list.forEach((c, i) => {
    let id = prevByKey.get(c.key) || 'k' + i;
    while (used.has(id)) id += 'x';
    used.add(id);
    ids.set(String(c.raw.id), id);
    ids.set(c.label.toLowerCase(), id);
  });
  const nodes = list.map(c => ({
    id: ids.get(String(c.raw.id)), key: c.key, label: c.label, n: c.label.split(/\s+/).length,
    freq: c.sents.length, code: tokenize(c.label).some(isCodeToken), plain: false,
    score: +(c.sents.length + (c.evidence.length ? 2 : 0)).toFixed(2),
    first: c.sents[0], sentences: c.sents,
    definition: c.raw.definition ? { sentence: c.evidence[0] ?? c.sents[0], verb: 'é', predicate: String(c.raw.definition).trim().slice(0, 260), strong: true } : undefined,
    parentRef: String(c.raw.parent || '').trim(),
  }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    const p = ids.get(n.parentRef) || ids.get(n.parentRef.toLowerCase());
    n.parent = p && p !== n.id ? p : null;
    delete n.parentRef;
  }
  // uma só raiz: a primeira sem pai na ordem do Cartógrafo; as outras penduram nela
  const root = nodes.find(n => !n.parent) || nodes[0];
  root.parent = null;
  for (const n of nodes) if (n !== root && !n.parent) n.parent = root.id;
  // quebra ciclos e calcula o nível (profundidade)
  for (const n of nodes) {
    const path = new Set([n.id]);
    let cur = n;
    while (cur.parent) {
      if (path.has(cur.parent)) { cur.parent = root.id; break; }
      path.add(cur.parent);
      cur = byId.get(cur.parent) || root;
    }
  }
  const depth = n => { let d = 0, cur = n; while (cur.parent && d < 10) { cur = byId.get(cur.parent); d++; } return d; };
  // profundidade máxima 4: quem passa disso pendura no ancestral de nível 3 (corrente vira árvore)
  for (const n of nodes) {
    while (depth(n) > 4) {
      let anc = byId.get(n.parent);
      while (anc && depth(anc) > 3) anc = byId.get(anc.parent);
      n.parent = anc ? anc.id : root.id;
    }
  }
  for (const n of nodes) { n.level = depth(n); n.tier = TIERS[Math.min(n.level, 4)]; }

  // arestas: pai–filho + coocorrência na mesma frase
  const w = new Map();
  const add = (a, b, v) => { if (a === b) return; const k = a < b ? a + '|' + b : b + '|' + a; w.set(k, (w.get(k) || 0) + v); };
  for (const n of nodes) if (n.parent) add(n.id, n.parent, 1);
  sentences.forEach((_, si) => {
    const here = nodes.filter(n => n.sentences.includes(si)).map(n => n.id);
    for (let x = 0; x < here.length; x++) for (let y = x + 1; y < here.length; y++) add(here[x], here[y], 1);
  });
  const edges = [...w.entries()].map(([k, weight]) => { const [a, b] = k.split('|'); return { a, b, weight }; });
  const degree = new Map();
  for (const e of edges) { degree.set(e.a, (degree.get(e.a) || 0) + e.weight); degree.set(e.b, (degree.get(e.b) || 0) + e.weight); }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;
  return { root: root.id, nodes, edges, by: 'cartografo' };
}

// Maior sequência de palavras copiada literalmente da transcrição. Pergunta que cola a fala
// ("complete a frase", enunciado = trecho do vídeo) mede memória, não entendimento.
const plainWords = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];
export function copyMeter(sentences) {
  const tw = plainWords(sentences.map(s => s.text).join(' '));
  const index = new Map();
  tw.forEach((w, i) => { if (!index.has(w)) index.set(w, []); index.get(w).push(i); });
  return (text) => {
    const w = plainWords(text);
    let best = 0;
    for (let i = 0; i < w.length; i++) {
      for (const start of index.get(w[i]) || []) {
        let k = 0;
        while (i + k < w.length && tw[start + k] === w[i + k]) k++;
        if (k > best) best = k;
      }
    }
    return best;
  };
}
export const MAX_COPY = 12;
const BLANK_RE = /_{3,}|\.{4,}|\(\s*\)|\[\s*\]/;

// ---------- auditoria de forma: a alternativa certa não pode se entregar pelo tamanho
const lenRatio = q => q.options[q.answer].length / Math.max(1, ...q.options.filter((_, i) => i !== q.answer).map(o => o.length));
/** MC em que a certa é a mais longa de todas (pista para quem chuta "a maior"). */
export function lengthCues(questions) {
  return questions.filter(q => q.type === 'mc' && lenRatio(q) > 1);
}
/** Parte das MC em que a certa é estritamente a mais longa (0–1). Acaso: 0,25. */
export function longestShare(questions) {
  const mc = questions.filter(q => q.type === 'mc');
  return mc.length ? mc.filter(q => lenRatio(q) > 1).length / mc.length : 0;
}
/**
 * Aplica a reescrita do Auditor: só aceita quando a questão continua íntegra (4 opções distintas,
 * gabarito 0–3, a certa preservada no sentido — conferido pelo vocabulário) e a pista diminui de fato.
 */
export function applyAudit(questions, data) {
  const byId = new Map((data?.questions || []).map(q => [String(q.id), q]));
  let fixed = 0;
  const out = questions.map(q => {
    const r = byId.get(String(q.id));
    if (!r || q.type !== 'mc') return q;
    const options = (r.options || []).map(o => String(o).trim());
    const answer = Number(r.answer);
    if (options.length !== 4 || options.some(o => !o) || new Set(options.map(o => o.toLowerCase())).size !== 4) return q;
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) return q;
    // a certa reescrita precisa manter as palavras de conteúdo da original (mesmo sentido, mais enxuta)
    const before = new Set(plainWords(q.options[q.answer]).filter(w => w.length > 4));
    const after = new Set(plainWords(options[answer]).filter(w => w.length > 4));
    const kept = [...after].filter(w => before.has(w)).length / Math.max(1, Math.min(before.size, after.size));
    if (before.size && kept < 0.5) return q;
    const nq = { ...q, options, answer };
    if (lenRatio(nq) >= lenRatio(q) || lenRatio(nq) > 1.25) return q;
    fixed++;
    return nq;
  });
  return { questions: out, fixed };
}

const LANGS = { js: 'javascript', javascript: 'javascript', 'node.js': 'javascript', node: 'javascript', typescript: 'javascript', ts: 'javascript',
  python: 'python', py: 'python', sql: 'sql', java: 'java', 'c#': 'csharp', csharp: 'csharp' };
/** "O essencial": ideias-chave do Cartógrafo, cada uma presa a uma frase do conteúdo (minuto/página). */
export function essentialsFrom(list, sentences) {
  const out = [];
  for (const e of list || []) {
    const text = String(e.text || '').trim().replace(/\s+/g, ' ');
    const i = (e.evidence || []).map(Number).find(x => Number.isInteger(x) && x >= 0 && x < sentences.length);
    if (text.length < 20 || text.length > 320 || i == null) continue;
    out.push({ text, i });
    if (out.length >= 6) break;
  }
  return out.length >= 3 ? out : null;
}

const WEIGHT = { mc: 1, reasoning: 2, code: 2, interview: 3 };
const LIMIT = { mc: 16, reasoning: 4, code: 2, interview: 1 };

/** Prova do Examinador → questões da Trilha. Devolve `null` se não sobrar o mínimo para uma prova. */
export function questionsFromExam(raw, { graph, sentences, technical, codeLang }, stats = {}) {
  const nodes = graph.nodes;
  const byLabel = new Map(nodes.map(n => [n.label.toLowerCase(), n]));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const joined = sentences.map(s => joinedOf(s.text));
  const conceptsIn = text => { const j = joinedOf(text); return nodes.filter(n => j.includes(' ' + n.key + ' ')); };
  const bestSentence = (text) => {
    const kws = keyOf(text).split(' ').filter(w => w.length > 3);
    let best = -1, bestHits = 0;
    joined.forEach((j, i) => { const hits = kws.filter(k => j.includes(' ' + k + ' ')).length; if (hits > bestHits) { bestHits = hits; best = i; } });
    return bestHits >= 2 ? best : -1;
  };
  const sourceOf = si => (si >= 0 && si < sentences.length
    ? { sentence: si, text: sentences[si].text, start: sentences[si].start ?? null, page: sentences[si].page ?? null, at: sentences[si].start != null ? fmtTime(sentences[si].start) : null }
    : null);

  const out = [];
  const rejected = { blank: 0, copy: 0, invalid: 0, cue: 0 };
  let longestRight = 0;
  const copied = copyMeter(sentences);
  const count = { mc: 0, reasoning: 0, code: 0, interview: 0 };
  for (const q of raw?.questions || []) {
    const type = q.type;
    if (!WEIGHT[type] || count[type] >= LIMIT[type]) continue;
    if (type === 'code' && !technical) continue;
    const prompt = String(q.prompt || '').trim();
    if (prompt.length < 12) { rejected.invalid++; continue; }
    // sobre o conteúdo, não sobre as frases: nada de lacuna nem enunciado/resposta colados da fala
    if (BLANK_RE.test(prompt)) { rejected.blank++; continue; }
    const correctText = type === 'mc' ? String((q.options || [])[Number(q.answer)] || '') : '';
    if (copied(prompt) >= MAX_COPY || (correctText && copied(correctText) >= MAX_COPY)) { rejected.copy++; continue; }

    // conceitos: pelo id/rótulo citado; senão, os que aparecem no enunciado/trecho
    let cs = (q.concepts || []).map(c => byId.get(String(c)) || byLabel.get(String(c).toLowerCase())).filter(Boolean);
    let si = (q.evidence || []).map(Number).find(i => Number.isInteger(i) && i >= 0 && i < sentences.length);
    if (si == null) si = bestSentence(`${prompt} ${q.expected || ''} ${q.explanation || ''}`);
    if (!cs.length) cs = conceptsIn(`${prompt} ${(q.options || []).join(' ')} ${q.expected || ''}`);
    if (!cs.length && si >= 0) cs = nodes.filter(n => n.sentences.includes(si));
    if (!cs.length) cs = [byId.get(graph.root)];
    cs = [...new Set(cs)].slice(0, 3);
    const level = Math.max(...cs.map(c => c.level ?? 0));
    const base = {
      type, kind: q.kind || type, prompt, highlight: cs.map(c => c.label), concepts: cs.map(c => c.id),
      source: sourceOf(si), weight: WEIGHT[type], level: type === 'interview' ? 99 : level, origin: 'examinador',
    };

    if (type === 'mc') {
      const options = (q.options || []).map(o => String(o).trim().replace(/^[A-Da-d][).:-]\s+/, ''));
      const answer = Number(q.answer);
      if (options.length !== 4 || options.some(o => !o) || new Set(options.map(o => o.toLowerCase())).size !== 4) continue;
      if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue;
      // pista de forma: a certa muito mais longa que qualquer errada se entrega sozinha
      const maxWrong = Math.max(...options.filter((_, i) => i !== answer).map(o => o.length));
      if (options[answer].length > 40 && options[answer].length > 1.6 * maxWrong) { rejected.cue++; continue; }
      if (options[answer].length > maxWrong) longestRight++;
      out.push({ ...base, options, answer, explanation: String(q.explanation || '').trim() || (base.source ? `No conteúdo: “${base.source.text}”` : '') });
    } else {
      const terms = [...new Set([...cs.map(c => c.label), ...(q.keywords || []).map(String)])].filter(t => t.trim() && !isStop(t)).slice(0, 8);
      const keywords = terms.map(t => ({ term: t, key: keyOf(t), weight: cs.some(c => c.label === t) ? 2 : 1 })).filter(k => k.key);
      const expected = String(q.expected || '').trim() || (base.source?.text ?? '');
      if (!keywords.length || !expected) continue;
      const rubric = { keywords, expected, minWords: type === 'interview' ? 50 : type === 'code' ? 0 : 25 };
      if (type === 'interview') Object.assign(rubric, { needsExample: true, needsTradeoff: true });
      if (type === 'code') {
        rubric.lang = LANGS[String(q.lang || '').toLowerCase().trim()] || codeLang || 'javascript';
        rubric.codeTokens = (q.keywords || []).map(String).filter(k => /[A-Za-z_$]/.test(k) && !/\s/.test(k)).slice(0, 5);
        if (rubric.codeTokens.length < 1) continue;
      }
      out.push({ ...base, rubric, explanation: String(q.explanation || '') || null });
    }
    count[type]++;
  }
  Object.assign(stats, rejected, { accepted: out.length, longestRight: count.mc ? Math.round(100 * longestRight / count.mc) : 0 });
  if (count.mc < 5 || count.reasoning + count.interview < 1) return null;
  // ordem da prova: MC do básico ao avançado, depois raciocínio, código e a entrevista por último
  const order = { mc: 0, reasoning: 1, code: 2, interview: 3 };
  out.sort((a, b) => order[a.type] - order[b.type] || (a.type === 'mc' ? a.level - b.level || (a.source?.sentence ?? 0) - (b.source?.sentence ?? 0) : 0));
  return out.map((q, i) => ({ ...q, id: 'x' + i, idx: i }));
}
