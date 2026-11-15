// Extração de conceitos + grafo de conhecimento (base → topo), 100% local.
import { tokenize, stem, isStop, isCodeToken, CONNECTORS, stripAccents, escapeRe, clamp } from './text.js';
import { SPOKEN_WORDS, SPOKEN_PHRASES } from './spoken.js';

const GENERIC = new Set(['coisa', 'exemplo', 'forma', 'vez', 'parte', 'pessoa', 'gente', 'tempo', 'lado', 'ponto', 'questão', 'problema', 'caso', 'tipo', 'nome', 'número', 'resultado', 'final', 'início', 'informação', 'longo', 'curto', 'alto', 'baixo', 'máximo', 'mínimo', 'total', 'ideal', 'maneira', 'thing', 'example', 'way', 'time', 'part', 'point', 'people', 'case', 'name', 'number', 'result', 'end', 'start', 'aqui', 'isso', 'importante', 'diferente', 'simples', 'grande', 'pequeno', 'primeiro', 'segundo', 'terceiro', 'novo', 'nova', 'melhor', 'certo', 'errado', 'possível', 'good', 'new', 'first', 'second', 'important', 'different', 'simple', 'big', 'small', 'possible', 'quer', 'precisa', 'usar', 'usa', 'uso', 'usamos', 'funciona', 'existe', 'acontece', 'chama', 'chamado', 'chamada', 'want', 'need', 'use', 'used', 'using', 'works', 'mundo', 'world', 'conteúdo', 'content', 'pdf', 'página', 'page']);

const DEF_VERBS = new Set(['é', 'são', 'significa', 'significam', 'representa', 'representam', 'consiste', 'serve', 'servem', 'define', 'is', 'are', 'means', 'refers', 'represents', 'consists']);
const SOFT_VERBS = new Set(['permite', 'permitem', 'funciona', 'garante', 'garantem', 'resolve', 'evita', 'allows', 'lets', 'enables', 'ensures', 'avoids', 'prevents']);

function sentenceTokens(text) {
  const surface = tokenize(text);
  const lower = surface.map(t => t.toLowerCase());
  const stems = lower.map(stem);
  return { surface, lower, stems, joined: ' ' + stems.join(' ') + ' ' };
}

const GENERIC_EDGE = new Set(['exemplo', 'coisa', 'forma', 'vez', 'parte', 'gente', 'tipo', 'caso', 'example', 'thing', 'way', 'lot',
  'possível', 'melhor', 'pior', 'maior', 'menor', 'longo', 'curto', 'recente', 'antigo', 'novo', 'nova', 'grande', 'pequeno', 'mesmo', 'mesma', 'certo', 'certa', 'best', 'worst', 'same', 'possible']);
// números por extenso nunca são conceito
const NUMBER_WORDS = new Set(['dois', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'vinte', 'trinta', 'cem', 'mil', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand']);
// "sistema de arquivos" ≈ "sistemas de arquivo": mesmas palavras até o radical
function similarKey(a, b) {
  const x = a.split(' '), y = b.split(' ');
  if (x.length !== y.length || x.length < 2 || a === b) return false;
  return x.every((w, i) => {
    if (/[._$()]/.test(w + y[i])) return w === y[i]; // código: Promise.all ≠ Promise.allSettled
    const k = Math.min(5, w.length, y[i].length);
    return w.slice(0, k) === y[i].slice(0, k);
  });
}

// Advérbios em -mente e verbos conjugados ("entendeu", "falando") nunca são conceito sozinhos.
const ADVERB_RE = /\p{L}{3,}mente$/u;
const VERB_RE = /\p{L}{3,}(ou|eu|iu|ando|endo|indo|aram|eram|iram|avam|íamos|ávamos)$/u;

function validUnigram(surf, low, single = true, opts = {}) {
  if (isStop(low) || CONNECTORS.has(low) || (single ? GENERIC : GENERIC_EDGE).has(low)) return false;
  if (opts.ignore?.has(low) || NUMBER_WORDS.has(low)) return false;
  if (opts.spoken && SPOKEN_WORDS.has(low)) return false;
  if (/^\d+([.,]\d+)?$/.test(low)) return false;
  if (/^[A-Z0-9#+]{2,6}$/.test(surf)) return true; // siglas: API, SQL, C#
  if (isCodeToken(surf)) return true;
  if (ADVERB_RE.test(low)) return false;
  if (single && low === surf && VERB_RE.test(low)) return false;
  // em fala, verbo no infinitivo solto ("estudar", "treinar") é ação, não conceito
  if (single && opts.spoken && low === surf && /\p{L}{3,}(ar|er|ir)$/u.test(low)) return false;
  return low.length >= 4;
}

export function extractConcepts(sentences, { maxConcepts, spoken = false, ignore = new Set() } = {}) {
  const opts = { spoken, ignore };
  const prepared = sentences.map(s => ({ ...s, tk: sentenceTokens(s.text) }));
  const totalWords = prepared.reduce((a, s) => a + s.tk.surface.length, 0);
  const cand = new Map();

  prepared.forEach((s, si) => {
    const { surface, lower, stems } = s.tk;
    const seenHere = new Set();
    for (let i = 0; i < surface.length; i++) {
      for (let n = 1; n <= 3 && i + n <= surface.length; n++) {
        const lw = lower.slice(i, i + n);
        const first = lw[0], last = lw[n - 1];
        if (!validUnigram(surface[i], first, n === 1, opts) || !validUnigram(surface[i + n - 1], last, n === 1, opts)) {
          // palavra genérica sozinha não vira conceito, mas pode iniciar um composto
          if (n === 1 && !validUnigram(surface[i], first, false, opts)) break;
          continue;
        }
        let ok = true, connectors = 0;
        for (let k = 1; k < n - 1; k++) {
          if (CONNECTORS.has(lw[k])) connectors++;
          else if (isStop(lw[k]) || GENERIC_EDGE.has(lw[k]) || (spoken && SPOKEN_WORDS.has(lw[k])) || ignore.has(lw[k])) { ok = false; break; }
        }
        if (!ok || connectors > 1 || (n === 4 && connectors === 0)) continue;
        if (n > 1 && SPOKEN_PHRASES.includes(lw.join(' '))) continue;
        const key = stems.slice(i, i + n).join(' ');
        if (seenHere.has(key)) continue;
        seenHere.add(key);
        let c = cand.get(key);
        if (!c) {
          c = { key, n, freq: 0, sentences: [], surfaces: new Map(), first: si, code: false, acronym: false, info: 0, midCaps: 0 };
          cand.set(key, c);
        }
        c.freq++;
        c.info += s.info ?? 8;
        c.sentences.push(si);
        const surf = surface.slice(i, i + n).join(' ');
        c.surfaces.set(surf, (c.surfaces.get(surf) || 0) + 1);
        if (surface.slice(i, i + n).some(isCodeToken)) c.code = true;
        if (/^[A-Z0-9#+]{2,6}$/.test(surface[i])) c.acronym = true;
        if (i > 0 && /^\p{Lu}/u.test(surface[i])) c.midCaps++;
      }
    }
  });

  const minFreq = totalWords < 400 ? 1 : 2;
  let list = [...cand.values()].filter(c => c.freq >= minFreq || c.code);
  for (const c of list) {
    const spread = new Set(c.sentences).size / Math.max(1, prepared.length);
    c.label = [...c.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // maiúscula só por estar no começo da frase ("Cochilos curtos…") não faz nome próprio
    if (!c.midCaps && !c.acronym && !c.code && /^\p{Lu}\p{Ll}+(\s|$)/u.test(c.label)) c.label = c.label.charAt(0).toLowerCase() + c.label.slice(1);
    // unigramas comuns em minúsculas ("código", "função") valem menos que termos marcados
    const plainWord = c.n === 1 && !c.code && !c.acronym && !/\p{Lu}/u.test(c.label.slice(1)) && !/^\p{Lu}/u.test(c.label);
    c.plain = plainWord;
    // termos de frases que EXPLICAM algo valem mais que termos de bate-papo (texto escrito: fator 1)
    const teach = 0.55 + 0.45 * Math.min(1, (c.info / c.freq) / 8);
    c.score = c.freq * (1 + 0.6 * (c.n - 1)) * (c.code ? 1.5 : 1) * (c.acronym ? 1.3 : 1) * (1 + spread * 2) * (plainWord ? 0.7 : 1) * teach;
  }
  // Subsunção: se "event loop" quase sempre aparece junto, "loop" sozinho sai.
  const byKey = new Map(list.map(c => [c.key, c]));
  for (const c of list) {
    if (c.n < 2) continue;
    const parts = c.key.split(' ');
    for (let len = 1; len < parts.length; len++) {
      for (let st = 0; st + len <= parts.length; st++) {
        const sub = byKey.get(parts.slice(st, st + len).join(' '));
        if (sub && c.freq >= sub.freq * 0.6) sub.subsumed = true;
      }
    }
    if (c.n >= 3) {
      // trigramas raros e longos que não superam o bigrama perdem a vez
      const sub = byKey.get(parts.slice(0, 2).join(' ')) || byKey.get(parts.slice(1).join(' '));
      if (sub && c.freq < sub.freq * 0.6) c.subsumed = true;
    }
  }
  list = list.filter(c => !c.subsumed).sort((a, b) => b.score - a.score);

  // fala é menos densa que texto escrito: menos conceitos por palavra
  const K = maxConcepts || (spoken ? clamp(Math.round(totalWords / 150), 8, 18) : clamp(Math.round(totalWords / 60), 8, 24));
  const chosen = [];
  for (const c of list) {
    if (chosen.length >= K) break;
    // evita quase-duplicatas (um contido no outro)
    // quase-duplicatas saem; exceção: composto frequente que contém uma palavra comum já escolhida
    // ("consolidação da memória" ⊃ "memória") — são conceitos diferentes, e um é pai do outro
    const dup = chosen.some(o => {
      if (similarKey(o.key, c.key) || (' ' + o.key + ' ').includes(' ' + c.key + ' ')) return true;
      if (!(' ' + c.key + ' ').includes(' ' + o.key + ' ')) return false;
      return !(o.plain && c.n >= 2 && c.freq >= 2);
    });
    if (dup) continue;
    chosen.push(c);
  }

  const concepts = chosen.map((c, idx) => ({
    id: 'c' + idx,
    key: c.key,
    label: c.label,
    n: c.n,
    freq: c.freq,
    code: c.code,
    plain: !!c.plain,
    score: +c.score.toFixed(2),
    first: c.first,
    sentences: [...new Set(c.sentences)],
  }));

  findDefinitions(concepts, prepared);
  return { concepts, prepared };
}

function findDefinitions(concepts, prepared) {
  for (const c of concepts) {
    let best = null;
    const parts = c.key.split(' ');
    for (const si of c.sentences) {
      const { surface, lower, stems } = prepared[si].tk;
      for (let i = 0; i + parts.length <= stems.length; i++) {
        if (stems.slice(i, i + parts.length).join(' ') !== c.key) continue;
        if (i > 2) break; // o termo precisa ser o sujeito (início da frase)
        for (let j = i + parts.length; j < Math.min(stems.length, i + parts.length + 3); j++) {
          const strong = DEF_VERBS.has(lower[j]);
          const soft = SOFT_VERBS.has(lower[j]);
          if (!strong && !soft) continue;
          const text = prepared[si].text;
          const occ = surface.slice(i, j + 1).map(escapeRe).join('[^\\p{L}\\p{N}]+');
          const m = text.match(new RegExp(occ + '\\s+(.{12,})$', 'iu'));
          if (!m) continue;
          const predicate = m[1].replace(/[\s.;:!?]+$/, '');
          // "X é um/uma/o..." logo após o termo é a forma clássica de definição
          const direct = j === i + parts.length && /^(um|uma|o|a|os|as|the|an?)\s/i.test(predicate);
          const quality = (strong ? 2 : 1) + (direct ? 1.5 : 0) - Math.abs(predicate.length - 90) / 300;
          if (!strong && !direct) continue;
          if (!direct && ['é', 'são', 'is', 'are', 'serve', 'servem'].includes(lower[j])) continue;
          // "é rejeitada", "são entregues": voz passiva descreve, não define
          if (!direct && /^\p{L}+(ad|id|it|gu|st)[oae]s?(?![\p{L}])/u.test(predicate)) continue;
          if (!best || quality > best.quality) best = { sentence: si, text, verb: lower[j], predicate, quality };
          break;
        }
      }
    }
    if (best && best.predicate.length <= 260) {
      c.definition = { sentence: best.sentence, verb: best.verb, predicate: best.predicate, strong: DEF_VERBS.has(best.verb) };
    }
  }
}

// Grafo: arestas por coocorrência; árvore "base → topo" escolhendo, para cada
// conceito, o pai mais ligado entre os que já foram apresentados antes dele.
export function buildGraph(concepts, prepared) {
  const index = new Map();
  prepared.forEach((s, si) => {
    const present = concepts.filter(c => s.tk.joined.includes(' ' + c.key + ' ')).map(c => c.id);
    index.set(si, present);
  });
  const w = new Map();
  const add = (a, b, v) => {
    if (a === b) return;
    const k = a < b ? a + '|' + b : b + '|' + a;
    w.set(k, (w.get(k) || 0) + v);
  };
  for (let si = 0; si < prepared.length; si++) {
    const here = index.get(si);
    for (let x = 0; x < here.length; x++) for (let y = x + 1; y < here.length; y++) add(here[x], here[y], 1);
    const next = index.get(si + 1) || [];
    for (const a of here) for (const b of next) add(a, b, 0.3);
  }
  const edges = [...w.entries()].map(([k, weight]) => {
    const [a, b] = k.split('|');
    return { a, b, weight: +weight.toFixed(2) };
  }).filter(e => e.weight >= 0.6);

  const weight = (a, b) => w.get(a < b ? a + '|' + b : b + '|' + a) || 0;
  const degree = new Map(concepts.map(c => [c.id, 0]));
  for (const e of edges) {
    degree.set(e.a, degree.get(e.a) + e.weight);
    degree.set(e.b, degree.get(e.b) + e.weight);
  }
  // Base = entre os conceitos mais importantes, o que é apresentado primeiro.
  // (Conteúdo didático costuma introduzir o fundamento antes do que depende dele.)
  const maxScore = Math.max(...concepts.map(c => c.score), 1);
  const top = [...concepts].sort((a, b) => b.score - a.score).slice(0, Math.min(5, concepts.length));
  const root = top.filter(c => !c.plain).sort((a, b) => a.first - b.first || b.score - a.score)[0] || top[0];

  const nodes = new Map(concepts.map(c => [c.id, { ...c, parent: null, level: 0, degree: +degree.get(c.id).toFixed(2) }]));
  if (root) {
    const placed = [root.id];
    const order = concepts.filter(c => c.id !== root.id).sort((a, b) => a.first - b.first || b.score - a.score);
    for (const c of order) {
      let bestP = root.id, bestW = 0;
      for (const p of placed) {
        const pn = nodes.get(p);
        // pai forte = muito ligado E relevante; palavras genéricas quase nunca viram pai
        const ww = weight(p, c.id) * (0.4 + pn.score / maxScore) * (pn.plain ? 0.35 : 1) * (p === root.id ? 0.85 : 1);
        if (ww > bestW) { bestW = ww; bestP = p; }
      }
      const node = nodes.get(c.id);
      node.parent = bestP;
      node.level = nodes.get(bestP).level + 1;
      placed.push(c.id);
    }
  }
  const TIERS = ['Base', 'Fundamentos', 'Aplicação', 'Avançado'];
  for (const n of nodes.values()) n.tier = TIERS[Math.min(n.level, 3)];
  return { root: root?.id || null, nodes: [...nodes.values()], edges };
}

export function neighbors(graph, id) {
  return graph.edges
    .filter(e => e.a === id || e.b === id)
    .map(e => ({ id: e.a === id ? e.b : e.a, weight: e.weight }))
    .sort((a, b) => b.weight - a.weight);
}

// Resumo extrativo: frases com mais "massa de conceito" e que explicam algo, na ordem original.
export function summarize(prepared, concepts, n = 5) {
  const scoreOf = new Map(concepts.map(c => [c.key, c.score]));
  const scored = prepared.map((s, i) => {
    let sc = 0;
    for (const [k, v] of scoreOf) if (s.tk.joined.includes(' ' + k + ' ')) sc += v;
    const len = s.tk.surface.length;
    const teach = s.info == null ? 1 : Math.max(0.1, Math.min(1.6, s.info / 8));
    return { i, sc: sc / Math.sqrt(Math.max(8, len)) * teach, len };
  }).filter(x => x.len >= 8 && x.len <= 60 && !/\?\s*$/.test(prepared[x.i].text) && (prepared[x.i].info == null || prepared[x.i].info >= 7));
  return scored.sort((a, b) => b.sc - a.sc).slice(0, n).sort((a, b) => a.i - b.i).map(x => x.i);
}

export function normalizeForMatch(s) {
  return stripAccents(String(s).toLowerCase());
}
