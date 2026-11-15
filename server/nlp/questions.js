// Gerador local de perguntas. Determinístico (semente = id do estudo).
//
// Como funciona (gerar candidatos → selecionar com cobertura):
//  1. Cada construtor propõe perguntas SOBRE CONCEITOS, com uma nota de qualidade: o que é X
//     (definição), qual conceito corresponde a uma descrição, qual a justificativa de uma
//     afirmação ("porque"), consequências ("se/quando…", só texto escrito), conexões fortes.
//     Nunca "complete a frase": isso mede memória da fala, não entendimento.
//     Sem LLM o motor não "estuda" o conteúdo: com agentes ligados, quem escreve a prova é o
//     Examinador, depois de ler tudo; isto aqui é a versão básica (e o plano B).
//  2. A seleção escolhe a melhor candidata por rodada, premiando quem cobre um trecho
//     do conteúdo ainda sem pergunta (o vídeo inteiro, não só o começo), um conceito
//     ainda não cobrado e um tipo de pergunta menos repetido.
// Tipos removidos por avaliarem a ESTRUTURA do texto e não o conteúdo: "trocar a palavra
// dentro da frase" (gerava frases sem sentido) e "o que aparece antes".
import { tokenize, stem, isStop, isCodeToken, CONNECTORS, rng, shuffle, clamp, fmtTime, CODE_KEYWORDS } from './text.js';
import { neighbors } from './knowledge.js';
import { infoScore, SPOKEN_WORDS, stripLead } from './spoken.js';

const LANG_NAME = { javascript: 'JavaScript', python: 'Python', sql: 'SQL', java: 'Java', csharp: 'C#' };
const GENERIC_KW = new Set(['coisa', 'exemplo', 'forma', 'vez', 'parte', 'gente', 'aqui', 'isso', 'thing', 'example', 'way']);

export function questionPlan(words, technical) {
  return {
    mc: clamp(Math.round(words / 180), 6, 14),
    reasoning: words > 1500 ? 3 : 2,
    code: technical ? (words > 2200 ? 2 : 1) : 0,
    interview: 1,
  };
}

function sourceOf(prepared, si) {
  const s = prepared[si];
  return { sentence: si, text: s.text, start: s.start ?? null, page: s.page ?? null, at: s.start != null ? fmtTime(s.start) : null };
}

function trimText(t, max = 170) {
  t = t.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const unpunct = s => s.trim().replace(/^[,;:\s]+|[\s.,;:!?…]+$/g, '');

// Termos que a rubrica espera: primeiro outros conceitos presentes nas frases-fonte,
// depois palavras de conteúdo que se repetem (≥2x). Palavras soltas e raras ficam fora.
function contentKeywords(prepared, sentIdx, exclude, limit = 4, nodes = []) {
  const out = [];
  const excl = [...exclude].join(' ');
  for (const n of nodes) {
    if (out.length >= limit) break;
    if (n.key.split(' ').every(p => exclude.has(p)) || excl.includes(n.key)) continue;
    if (sentIdx.some(si => prepared[si].tk.joined.includes(' ' + n.key + ' '))) {
      out.push({ term: n.label, key: n.key, weight: 1 });
      n.key.split(' ').forEach(p => exclude.add(p));
    }
  }
  const freq = new Map();
  for (const si of sentIdx) {
    const { surface, lower, stems } = prepared[si].tk;
    lower.forEach((w, i) => {
      if (isStop(w) || CONNECTORS.has(w) || GENERIC_KW.has(w) || SPOKEN_WORDS.has(w) || w.length < 4 || /^\d+$/.test(w)) return;
      if (exclude.has(stems[i])) return;
      const e = freq.get(stems[i]) || { key: stems[i], term: surface[i], n: 0 };
      e.n++;
      freq.set(stems[i], e);
    });
  }
  const extra = [...freq.values()].filter(e => e.n >= 2).sort((a, b) => b.n - a.n)
    .slice(0, Math.max(0, limit - out.length)).map(e => ({ term: e.term, key: e.key, weight: 1 }));
  return [...out, ...extra];
}

// ---------- padrões de frase que carregam conteúdo
const CAUSE_RE = /^(.{25,}?)[,;]?\s+(porque|pois|j[áa] que|uma vez que|visto que|because|since)\s+(.{18,})$/iu;
const COND_RE = /^(?:.{0,30}?[\s,])?(se|quando|caso|if|when)\s+(.{12,}?),\s*(.{18,})$/iu;
const PRONOUN_START = /^(isso|isto|ele|ela|eles|elas|que|aquilo|eu|it|this|that|they|i)\b/i;
// fala sobre o próprio vídeo/aula, não sobre o assunto
const META_RE = /\b(v[íi]deo|canal|aula de hoje|explicar aqui|vou falar|vou explicar|video|channel)\b/i;
const contentCount = t => tokenize(t).filter(w => !isStop(w) && !SPOKEN_WORDS.has(w.toLowerCase()) && w.length >= 4).length;

const joinedOf = t => ' ' + tokenize(t).map(w => stem(w.toLowerCase())).join(' ') + ' ';

export function generateQuestions({ graph, prepared, technical, codeLang, words, seed, spoken = false }) {
  const rand = rng(String(seed));
  const nodes = graph.nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const plan = questionPlan(words, technical);
  const out = [];
  let qn = 0;
  const qid = () => 'q' + (qn++);
  const info = si => prepared[si].info ?? infoScore(prepared[si].text);
  const isQuestion = si => /\?\s*$/.test(prepared[si].text);
  const conceptsIn = si => nodes.filter(n => prepared[si].tk.joined.includes(' ' + n.key + ' '));
  const minInfo = spoken ? 5 : 3;

  const pool = (target, excludeIds = new Set(), sentenceJoined = '') =>
    shuffle(nodes.filter(n => n.id !== target.id && !excludeIds.has(n.id)
      && !sentenceJoined.includes(' ' + n.key + ' ')
      && !(' ' + n.key + ' ').includes(' ' + target.key + ' ')
      && !(' ' + target.key + ' ').includes(' ' + n.key + ' ')), rand)
      .sort((a, b) => (Math.abs(a.n - target.n) + (a.code !== target.code) + (a.plain !== target.plain)) - (Math.abs(b.n - target.n) + (b.code !== target.code) + (b.plain !== target.plain)));

  const mcFrom = ({ target, concepts, kind, prompt, correct, distractors, si, explanation, quality }) => {
    const opts = shuffle([correct, ...distractors.slice(0, 3)], rand);
    if (opts.length < 4 || new Set(opts.map(o => o.toLowerCase())).size < 4) return null;
    const cs = concepts || [target];
    return {
      id: null, type: 'mc', kind, prompt, highlight: cs.map(c => c.label),
      options: opts, answer: opts.indexOf(correct),
      concepts: cs.map(c => c.id),
      source: si != null ? sourceOf(prepared, si) : null,
      explanation: explanation || (si != null ? `No conteúdo: “${trimText(prepared[si].text, 240)}”` : ''),
      weight: 1, level: Math.max(...cs.map(c => c.level)), quality, si,
    };
  };

  // ---------------- candidatos de múltipla escolha
  const cands = [];
  const push = q => { if (q) cands.push(q); };

  for (const t of nodes) {
    // Definição: "X é um/uma…" encontrada no texto
    if (t.definition) {
      const others = pool(t).filter(n => n.definition);
      if (others.length >= 3) {
        const fmt = n => cap(trimText(unpunct(n.definition.predicate), 160));
        push(mcFrom({ target: t, kind: 'definition', prompt: `O que melhor descreve «${t.label}», de acordo com o conteúdo?`,
          correct: fmt(t), distractors: others.map(fmt), si: t.definition.sentence, quality: 3.2 }));
      }
    }
    // Conceito pela descrição: "qual conceito é este?" (o inverso da definição; o termo não aparece no enunciado)
    if (t.definition && !t.plain) {
      const d = pool(t, new Set(), joinedOf(t.definition.predicate));
      if (d.length >= 3) {
        push(mcFrom({ target: t, kind: 'identify', prompt: `Qual conceito o conteúdo descreve assim: ${cap(trimText(unpunct(t.definition.predicate), 200))}?`,
          correct: t.label, distractors: d.map(x => x.label), si: t.definition.sentence, quality: 2.8 }));
      }
    }
    // Sem lacunas: "complete a frase" mede se o aluno decorou a fala, não se entendeu o assunto.
    // Conexão: com qual conceito o conteúdo explica este (só ligações fortes)
    const nb = neighbors(graph, t.id).filter(x => x.weight >= 2);
    if (nb.length) {
      const linked = new Set(neighbors(graph, t.id).map(x => x.id));
      const d = pool(t, linked);
      const best = byId.get(nb[0].id);
      const si = t.sentences.find(s => prepared[s].tk.joined.includes(' ' + best.key + ' ') && !isQuestion(s));
      if (d.length >= 3 && si != null) {
        push(mcFrom({ target: t, concepts: [t, best], kind: 'relation', prompt: `No conteúdo, «${t.label}» é explicado junto com qual destes conceitos?`,
          correct: best.label, distractors: d.map(x => x.label), si, quality: 0.9,
          explanation: `«${t.label}» e «${best.label}» são tratados juntos. Ex.: “${trimText(prepared[si].text, 200)}”` }));
      }
    }
  }

  // Justificativas ("…porque…") e consequências ("se/quando…, …"): perguntas de compreensão.
  const causal = [], conditional = [];
  // cada parte precisa se sustentar sozinha: palavras de conteúdo suficientes, sem começar em pronome solto
  const part = (s, min) => { const t = cap(unpunct(stripLead(s))); return contentCount(t) >= min && !PRONOUN_START.test(t) && !META_RE.test(t) ? t : null; };
  prepared.forEach((s, si) => {
    if (isQuestion(si) || info(si) < minInfo + (spoken ? 1 : 0) || s.text.length > 320) return;
    const cs = conceptsIn(si);
    if (!cs.length) return;
    let m = s.text.match(CAUSE_RE);
    if (m) {
      const claim = part(m[1], 3), reason = part(m[3], 3);
      if (claim && reason) causal.push({ si, claim, reason, cs });
    }
    m = s.text.match(COND_RE);
    if (m) {
      const cond = unpunct(m[2]), effect = part(m[3], 4);
      if (effect && contentCount(cond) >= 2 && !META_RE.test(cond)) conditional.push({ si, word: m[1].toLowerCase(), cond, effect, cs });
    }
  });
  for (const c of causal) {
    const others = shuffle(causal.filter(o => o.si !== c.si && o.reason.toLowerCase() !== c.reason.toLowerCase()), rand)
      .sort((a, b) => Math.abs(a.reason.length - c.reason.length) - Math.abs(b.reason.length - c.reason.length));
    if (others.length < 3) break;
    push(mcFrom({ target: c.cs[0], concepts: c.cs.slice(0, 2), kind: 'cause',
      prompt: `Segundo o conteúdo, qual é a justificativa para a afirmação abaixo?\n“${cap(trimText(c.claim, 220))}”`,
      correct: cap(trimText(c.reason, 170)), distractors: others.map(o => cap(trimText(o.reason, 170))), si: c.si, quality: 2.9 }));
  }
  // em fala solta, "se/quando…" quase sempre é hipótese de conversa: só vale para texto escrito
  for (const c of spoken ? [] : conditional) {
    const others = shuffle(conditional.filter(o => o.si !== c.si && o.effect.toLowerCase() !== c.effect.toLowerCase()), rand)
      .sort((a, b) => Math.abs(a.effect.length - c.effect.length) - Math.abs(b.effect.length - c.effect.length));
    if (others.length < 3) break;
    push(mcFrom({ target: c.cs[0], concepts: c.cs.slice(0, 2), kind: 'consequence',
      prompt: `Segundo o conteúdo, o que acontece ${c.word} ${trimText(c.cond, 160)}?`,
      correct: cap(trimText(c.effect, 170)), distractors: others.map(o => cap(trimText(o.effect, 170))), si: c.si, quality: 2.6 }));
  }

  // ---------------- seleção com cobertura (trechos do conteúdo × conceitos × tipos)
  const B = Math.max(3, plan.mc);
  const bucketOf = si => Math.min(B - 1, Math.floor(si / Math.max(1, prepared.length) * B));
  const usedSent = new Set(), usedBucket = new Map(), usedConcept = new Map(), usedKind = new Map();
  const KIND_CAP = { relation: 3, definition: 6, identify: 6, cause: 5, consequence: 4 };
  const mc = [];
  while (mc.length < plan.mc) {
    let best = null, bestScore = -Infinity;
    for (const q of cands) {
      if (q.picked || (q.si != null && usedSent.has(q.si))) continue;
      if ((usedKind.get(q.kind) || 0) >= (KIND_CAP[q.kind] ?? 3)) continue;
      const main = q.concepts[0];
      if ((usedConcept.get(main) || 0) >= 2) continue;
      const bucket = q.si != null ? bucketOf(q.si) : -1;
      const score = q.quality
        + (bucket >= 0 && !usedBucket.get(bucket) ? 1.6 : -0.5 * (usedBucket.get(bucket) || 0))
        + (usedConcept.get(main) ? -1.2 : 1)
        - 0.5 * (usedKind.get(q.kind) || 0)
        + rand() * 0.2;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    if (!best) break;
    best.picked = true;
    mc.push(best);
    if (best.si != null) { usedSent.add(best.si); usedBucket.set(bucketOf(best.si), (usedBucket.get(bucketOf(best.si)) || 0) + 1); }
    usedConcept.set(best.concepts[0], (usedConcept.get(best.concepts[0]) || 0) + 1);
    usedKind.set(best.kind, (usedKind.get(best.kind) || 0) + 1);
  }
  // ordem: do básico ao avançado, e dentro do nível na ordem em que aparece no conteúdo
  mc.sort((a, b) => a.level - b.level || (a.si ?? 0) - (b.si ?? 0));
  for (const q of mc) { delete q.picked; delete q.quality; delete q.si; q.id = qid(); out.push(q); }

  // ---------------- raciocínio (abertas)
  const targets = [...nodes].sort((a, b) => (a.plain - b.plain) || b.score - a.score);
  const reasoningCount = () => out.filter(q => q.type === 'reasoning').length;
  // 1º: explicar uma justificativa do próprio conteúdo (compreensão de verdade)
  const usedCausal = new Set(mc.filter(q => q.kind === 'cause').map(q => q.source?.sentence));
  for (const c of shuffle(causal, rand).sort((a, b) => info(b.si) - info(a.si))) {
    if (reasoningCount() >= Math.min(1, plan.reasoning)) break;
    if (usedCausal.has(c.si)) continue;
    const ids = c.cs.slice(0, 2);
    out.push({
      id: qid(), type: 'reasoning', kind: 'explain',
      prompt: `O conteúdo afirma: “${cap(trimText(c.claim, 220))}”. Explique com suas palavras por que isso acontece.`,
      highlight: ids.map(n => n.label),
      rubric: {
        keywords: [...ids.map(n => ({ term: n.label, key: n.key, weight: 2 })), ...contentKeywords(prepared, [c.si], new Set(ids.flatMap(n => n.key.split(' '))), 4, nodes)],
        minWords: 25, expected: prepared[c.si].text,
      },
      concepts: ids.map(n => n.id), source: sourceOf(prepared, c.si), weight: 2, level: Math.max(...ids.map(n => n.level)),
    });
  }
  // 2º: relação entre dois conceitos fortemente ligados
  const pairs = graph.edges.filter(e => e.weight >= 1).sort((a, b) => b.weight - a.weight);
  const usedPair = new Set();
  for (const e of pairs) {
    if (reasoningCount() >= plan.reasoning) break;
    if (usedPair.has(e.a) && usedPair.has(e.b)) continue;
    const A = byId.get(e.a), B2 = byId.get(e.b);
    if (A.plain && B2.plain) continue;
    // "consolidar memória" × "consolidação da memória": quase o mesmo termo, não rende pergunta
    const pre = k => k.split(' ').filter(w => w.length > 3).map(w => w.slice(0, 5));
    if (pre(A.key).some(p => pre(B2.key).includes(p))) continue;
    const both = A.sentences.filter(s => prepared[s].tk.joined.includes(' ' + B2.key + ' ') && !isQuestion(s)).sort((x, y) => info(y) - info(x)).slice(0, 3);
    if (!both.length) continue;
    usedPair.add(e.a); usedPair.add(e.b);
    const [first, second] = A.first <= B2.first ? [A, B2] : [B2, A];
    out.push({
      id: qid(), type: 'reasoning', kind: 'relation',
      prompt: `Com base no conteúdo, explique como «${first.label}» e «${second.label}» se relacionam. Dê um exemplo concreto.`,
      highlight: [first.label, second.label],
      rubric: {
        keywords: [{ term: first.label, key: first.key, weight: 2 }, { term: second.label, key: second.key, weight: 2 },
          ...contentKeywords(prepared, both, new Set([...first.key.split(' '), ...second.key.split(' ')]), 4, nodes)],
        minWords: 25, expected: both.slice(0, 2).map(s => prepared[s].text).join(' '),
      },
      concepts: [first.id, second.id], source: sourceOf(prepared, both[0]), weight: 2, level: Math.max(A.level, B2.level),
    });
  }
  // completa com "por que importa" se faltar
  for (const t of targets) {
    if (reasoningCount() >= plan.reasoning) break;
    if (usedPair.has(t.id)) continue;
    usedPair.add(t.id);
    const ss = t.sentences.filter(s => !isQuestion(s)).sort((a, b) => info(b) - info(a)).slice(0, 3);
    if (!ss.length) continue;
    out.push({
      id: qid(), type: 'reasoning', kind: 'why',
      prompt: `Por que «${t.label}» é importante nesse assunto? Descreva uma situação em que entender isso faz diferença.`,
      highlight: [t.label],
      rubric: { keywords: [{ term: t.label, key: t.key, weight: 2 }, ...contentKeywords(prepared, ss, new Set(t.key.split(' ')), 4, nodes)], minWords: 25, expected: ss.slice(0, 2).map(s => prepared[s].text).join(' ') },
      concepts: [t.id], source: sourceOf(prepared, ss[0]), weight: 2, level: t.level,
    });
  }

  // ---------------- código (só se o conteúdo for técnico)
  if (plan.code) {
    const langKw = new Set((CODE_KEYWORDS[codeLang] || []).map(k => k.toLowerCase()));
    const codeTargets = [...nodes].sort((a, b) => (b.code - a.code) || b.score - a.score);
    for (const t of codeTargets) {
      if (out.filter(q => q.type === 'code').length >= plan.code) break;
      const toks = new Map();
      for (const si of t.sentences) {
        for (const tok of prepared[si].tk.surface) {
          const low = tok.toLowerCase();
          if ((isCodeToken(tok) || langKw.has(low)) && low !== codeLang && low.length > 1) toks.set(low, tok.replace(/\(\)$/, ''));
        }
      }
      const codeTokens = [...toks.values()].slice(0, 5);
      if (codeTokens.length < 2) continue;
      out.push({
        id: qid(), type: 'code', kind: 'write',
        prompt: `Escreva um trecho de código em ${LANG_NAME[codeLang] || codeLang} que demonstre «${t.label}» na prática. Pode comentar o código para explicar seu raciocínio.`,
        highlight: [t.label],
        rubric: { lang: codeLang, codeTokens, keywords: [{ term: t.label, key: t.key, weight: 1 }], minWords: 0, expected: t.sentences.slice(0, 2).map(s => prepared[s].text).join(' ') },
        concepts: [t.id], source: sourceOf(prepared, t.sentences[0]), weight: 2, level: t.level,
      });
    }
  }

  // ---------------- entrevista: o "chefe final"
  const root = byId.get(graph.root) || targets[0];
  if (root) {
    const kids = nodes.filter(n => n.parent === root.id && !n.plain).sort((a, b) => b.score - a.score);
    const c1 = kids[0] || targets.find(n => n.id !== root.id);
    const c2 = kids[1] || targets.find(n => n.id !== root.id && n.id !== c1?.id);
    const ids = [root, c1, c2].filter(Boolean);
    const ss = [...new Set(ids.flatMap(n => n.sentences.filter(s => !isQuestion(s)).sort((a, b) => info(b) - info(a)).slice(0, 2)))];
    const where = technical ? 'num projeto real' : 'na prática, numa situação real';
    const parts = [`“Você pode explicar o que é «${root.label}»`];
    if (c1) parts.push(` e me contar como aplicaria «${c1.label}» ${where}`);
    parts.push('?');
    if (c2) parts.push(` Que cuidado ou limitação você consideraria em relação a «${c2.label}»?`);
    parts.push('”');
    out.push({
      id: qid(), type: 'interview', kind: 'boss',
      prompt: `Pergunta de entrevista. O entrevistador diz:\n${parts.join('')}`,
      highlight: ids.map(n => n.label),
      rubric: {
        keywords: [...ids.map(n => ({ term: n.label, key: n.key, weight: 2 })), ...contentKeywords(prepared, ss, new Set(ids.flatMap(n => n.key.split(' '))), 5, nodes)],
        minWords: 50, needsExample: true, needsTradeoff: !!c2,
        expected: ss.slice(0, 3).map(s => prepared[s].text).join(' '),
      },
      concepts: ids.map(n => n.id), source: sourceOf(prepared, ss[0] ?? 0), weight: 3, level: 99,
    });
  }

  return out.map((q, i) => ({ ...q, idx: i }));
}

export function stemKey(text) {
  return tokenize(text).map(t => stem(t.toLowerCase())).join(' ');
}
