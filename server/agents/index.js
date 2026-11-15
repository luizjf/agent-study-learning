// Agentes de IA. Cada agente tem um nível técnico → um modelo Claude.
// O prompt de sistema de cada agente É a sua skill (.claude/skills/<id>/SKILL.md),
// a mesma usada pelos subagentes do Claude Code: uma única fonte de verdade.
//
// Provedores (TRILHA_LLM):
//   local        — nenhum LLM; tudo pelo motor local (padrão)
//   claude-code  — usa o Claude Code instalado nesta máquina, com o login da SUA assinatura
//                  (Pro/Max). Sem chave de API e sem cobrança por token; consome o limite de uso
//                  do plano. Para uso pessoal: não sirva uma turma com a sua assinatura.
//   claude       — API da Anthropic com ANTHROPIC_API_KEY (pago por token; serve turmas)
//   ollama       — LLM local gratuito (qualidade menor)
//
// Regras para economizar tokens:
//  1. Local primeiro: correção só escala na zona cinzenta; a prova local fica pronta na hora.
//  2. Entrada mínima: correção recebe só pergunta, resposta, trecho e rubrica.
//  3. Saída estruturada (JSON Schema) e teto de saída por agente.
//  4. Cache por hash (mesma entrada = zero token) e teto diário por usuário.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, ROOT } from '../config.js';
import { db } from '../db.js';

export const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

const str = { type: 'string' };
const num = { type: 'number' };
const strArr = { type: 'array', items: str };
const numArr = { type: 'array', items: num };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const AGENTS = {
  curador: {
    name: 'Curador', role: 'Limpa e resume trechos do conteúdo; monta glossário.',
    tier: 'haiku', effort: 'low', maxTokens: 900, timeoutMs: 60000,
    schema: obj({ summary: str, glossary: { type: 'array', items: obj({ term: str, definition: str }) } }),
  },
  cartografo: {
    name: 'Cartógrafo', role: 'Lê o conteúdo inteiro e monta o mapa de conceitos do básico ao avançado.',
    tier: 'sonnet', effort: 'medium', maxTokens: 6000, timeoutMs: 240000,
    schema: obj({
      concepts: { type: 'array', items: obj({ id: str, label: str, definition: str, parent: str, evidence: numArr }) },
      essentials: { type: 'array', items: obj({ text: str, evidence: numArr }) },
    }),
  },
  examinador: {
    name: 'Examinador', role: 'Lê o conteúdo inteiro e escreve a prova: múltipla escolha, raciocínio, código e entrevista.',
    tier: 'sonnet', effort: 'medium', maxTokens: 16000, timeoutMs: 420000,
    schema: obj({
      questions: {
        type: 'array',
        items: obj({
          type: { type: 'string', enum: ['mc', 'reasoning', 'code', 'interview'] },
          kind: { type: 'string', enum: ['definicao', 'compreensao', 'aplicacao', 'analise', 'causa', 'comparacao', 'numero', 'cenario', 'codigo', 'entrevista'] },
          prompt: str, options: strArr, answer: num, explanation: str,
          concepts: strArr, evidence: numArr, expected: str, keywords: strArr, lang: str,
        }),
      },
    }),
  },
  auditor: {
    name: 'Auditor de Prova', role: 'Remove pistas de forma das alternativas (a certa não pode se entregar pelo tamanho).',
    tier: 'haiku', effort: 'low', maxTokens: 5000, timeoutMs: 120000,
    schema: obj({ questions: { type: 'array', items: obj({ id: str, options: strArr, answer: num }) } }),
  },
  corretor: {
    name: 'Corretor', role: 'Corrige respostas abertas curtas com base na rubrica.',
    tier: 'haiku', effort: 'low', maxTokens: 400, timeoutMs: 45000,
    schema: obj({ score: num, feedback: str, missing: strArr }),
  },
  'revisor-codigo': {
    name: 'Revisor de Código', role: 'Avalia respostas em código: lógica, sintaxe e uso do conceito.',
    tier: 'sonnet', effort: 'low', maxTokens: 600, timeoutMs: 60000,
    schema: obj({ score: num, feedback: str, missing: strArr, syntaxOk: { type: 'boolean' } }),
  },
  entrevistador: {
    name: 'Entrevistador', role: 'Avalia a resposta de entrevista como um entrevistador sênior.',
    tier: 'opus', effort: 'medium', maxTokens: 800, timeoutMs: 90000,
    schema: obj({ score: num, feedback: str, strengths: strArr, improve: strArr }),
  },
  mentor: {
    name: 'Mentor', role: 'Transforma os erros em um plano de revisão curto e motivador.',
    tier: 'haiku', effort: 'low', maxTokens: 500, timeoutMs: 45000,
    schema: obj({ message: str, plan: { type: 'array', items: obj({ concept: str, action: str }) } }),
  },
};

const skillCache = new Map();
export function skillPrompt(id) {
  if (skillCache.has(id)) return skillCache.get(id);
  const file = path.join(ROOT, '.claude', 'skills', id, 'SKILL.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---\s*/, ''); } catch { text = AGENTS[id]?.role || ''; }
  skillCache.set(id, text);
  return text;
}

export function llmEnabled() {
  return ['claude', 'claude-code', 'ollama'].includes(config.llm);
}

export const PROVIDER_LABEL = {
  local: 'motor local (sem IA)',
  'claude-code': 'Claude Code com a sua assinatura',
  claude: 'API da Anthropic',
  ollama: 'Ollama (LLM local)',
};

export function agentsInfo() {
  return Object.entries(AGENTS).map(([id, a]) => ({
    id, name: a.name, role: a.role, tier: a.tier,
    model: config.llm === 'ollama' ? config.ollamaModel : MODELS[a.tier],
    active: llmEnabled(),
  }));
}

// ---------------------------------------------------------------- Claude Code (assinatura)
const cmpVer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

let claudeBin;
export function findClaudeBin() {
  if (claudeBin !== undefined) return claudeBin;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = (() => {
    if (process.env.TRILHA_CLAUDE_BIN) return process.env.TRILHA_CLAUDE_BIN;
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, exe);
      if (dir && fs.existsSync(p)) return p;
    }
    const home = os.homedir();
    for (const p of [path.join(home, '.local', 'bin', exe), path.join(home, '.claude', 'local', exe)]) if (fs.existsSync(p)) return p;
    // binário que vem junto da extensão do VS Code / Cursor
    for (const ed of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
      const base = path.join(home, ed, 'extensions');
      let dirs = [];
      try { dirs = fs.readdirSync(base).filter(d => d.startsWith('anthropic.claude-code-')); } catch { continue; }
      dirs.sort((a, b) => cmpVer(b.split('-')[2] || '0', a.split('-')[2] || '0'));
      for (const d of dirs) {
        const p = path.join(base, d, 'resources', 'native-binary', exe);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  })();
  claudeBin = found;
  return found;
}

// Argumentos do modo headless: sem ferramentas, sem MCP, sem configurações do projeto e
// sem salvar sessão — o Claude Code vira só "um modelo que responde JSON validado".
export function claudeCodeArgs(agent, id) {
  return ['-p', '--model', agent.tier, '--effort', agent.effort,
    '--output-format', 'json', '--json-schema', JSON.stringify(agent.schema),
    '--system-prompt', skillPrompt(id),
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'];
}

// Pasta de trabalho privada e exclusiva deste processo (mkdtemp cria com permissão 0700).
// Uma pasta fixa em /tmp poderia ser pré-criada por outro usuário da máquina com um
// CLAUDE.md plantado para manipular os agentes.
let workDir = null;
const getWorkDir = () => (workDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'trilha-agentes-')));
async function callClaudeCode(agent, id, payload) {
  const bin = findClaudeBin();
  const model = MODELS[agent.tier];
  if (!bin) {
    console.warn('[agentes] Claude Code não encontrado. Instale-o ou defina TRILHA_CLAUDE_BIN — usando motor local');
    return { data: null, usage: { input: 0, output: 0 }, model };
  }
  return new Promise((resolve) => {
    const child = spawn(bin, claudeCodeArgs(agent, id), { cwd: getWorkDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); err += ' (tempo esgotado)'; }, agent.timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); console.warn('[agentes] falha ao iniciar o Claude Code:', e.message); resolve({ data: null, usage: { input: 0, output: 0 }, model }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        const u = r.usage || {};
        const usage = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 };
        // o Claude Code pode usar um modelo menor para tarefas internas: vale o que mais gerou saída
        const used = Object.entries(r.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0]?.[0] || model;
        if (process.env.TRILHA_DEBUG) console.log(`[agentes] ${id}:`, Object.entries(r.modelUsage || {}).map(([k, v]) => `${k} in=${v.inputTokens}+${v.cacheReadInputTokens || 0} out=${v.outputTokens}`).join(' · '));
        if (r.is_error || !r.structured_output) {
          console.warn(`[agentes] ${id}: Claude Code não devolveu resultado (${r.subtype || 'erro'}): ${String(r.result || err).slice(0, 200)}`);
          return resolve({ data: null, usage, model: used });
        }
        resolve({ data: r.structured_output, usage, model: used });
      } catch {
        console.warn(`[agentes] ${id}: resposta inesperada do Claude Code: ${(err || out).slice(0, 300)}`);
        resolve({ data: null, usage: { input: 0, output: 0 }, model });
      }
    });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------- API da Anthropic
let anthropicClient = null;
async function claude() {
  if (!anthropicClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropicClient = { Anthropic, client: new Anthropic() };
  }
  return anthropicClient;
}

async function callClaude(agent, id, payload) {
  const { Anthropic, client } = await claude();
  const model = MODELS[agent.tier];
  const params = {
    model,
    max_tokens: agent.maxTokens,
    system: [{ type: 'text', text: skillPrompt(id), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    output_config: { effort: agent.effort, format: { type: 'json_schema', schema: agent.schema } },
  };
  try {
    // Sonnet/Opus: fallback no servidor caso o pedido seja recusado; Haiku não tem esse recurso.
    const req = { timeout: agent.timeoutMs };
    const res = agent.tier === 'haiku'
      ? await client.messages.create(params, req)
      : await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, req);
    const usage = { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 };
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return { data: null, usage, model };
    const text = res.content.find(b => b.type === 'text')?.text;
    return { data: text ? JSON.parse(text) : null, usage, model: res.model || model };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.warn('[agentes] credencial Claude inválida — usando motor local');
    else if (err instanceof Anthropic.RateLimitError) console.warn('[agentes] limite de taxa atingido — usando motor local');
    else if (err instanceof Anthropic.APIError) console.warn(`[agentes] erro da API ${err.status}: ${err.message}`);
    else if (err instanceof SyntaxError) console.warn('[agentes] resposta JSON inválida');
    else console.warn('[agentes] falha:', err.message);
    return { data: null, usage: { input: 0, output: 0 }, model };
  }
}

// ---------------------------------------------------------------- Ollama
async function callOllama(agent, id, payload) {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel, stream: false, format: agent.schema,
        messages: [{ role: 'system', content: skillPrompt(id) }, { role: 'user', content: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
        options: { num_predict: agent.maxTokens },
      }),
      signal: AbortSignal.timeout(agent.timeoutMs),
    });
    const data = await res.json();
    return { data: JSON.parse(data.message.content), usage: { input: data.prompt_eval_count || 0, output: data.eval_count || 0 }, model: config.ollamaModel };
  } catch (err) {
    console.warn('[agentes] Ollama indisponível:', err.message);
    return { data: null, usage: { input: 0, output: 0 }, model: config.ollamaModel };
  }
}

// ---------------------------------------------------------------- fila
// O Claude Code abre um processo por chamada: limitamos a concorrência e, se a fila
// estiver longa, a correção não espera — vale a nota local (o aluno não fica parado).
const MAX_PARALLEL = { 'claude-code': 2, claude: 8, ollama: 1 };
let running = 0;
const waiting = [];
function acquire(maxQueue) {
  if (running < (MAX_PARALLEL[config.llm] || 4)) { running++; return Promise.resolve(true); }
  if (waiting.length >= maxQueue) return Promise.resolve(false);
  return new Promise(res => waiting.push(res));
}
function release() {
  const next = waiting.shift();
  if (next) next(true); else running--;
}
export const agentQueue = () => ({ running, waiting: waiting.length });

// ---------------------------------------------------------------- orçamento
const today = () => new Date().toISOString().slice(0, 10);

export function usedToday(userId) {
  const row = db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM llm_usage WHERE day = ? AND user_id = ?').get(today(), userId || 'anon');
  return row.t;
}

function usedTodayAll() {
  return db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM llm_usage WHERE day = ?').get(today()).t;
}
const reserved = new Map(); // userId -> tokens reservados por chamadas em andamento
let reservedAll = 0;

function recordUsage(userId, model, input, output) {
  db.prepare('INSERT INTO llm_usage (day, user_id, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)')
    .run(today(), userId || 'anon', model, input, output);
}

/**
 * Chama um agente. Devolve `null` quando não há LLM, o orçamento acabou, a fila está cheia
 * ou deu erro — quem chama sempre tem o resultado local como plano B.
 * `heavy` (gerar prova/mapa) espera na fila; correções não esperam mais que 3 na frente.
 */
export async function callAgent(id, payload, { userId, studyId = null, heavy = false } = {}) {
  const agent = AGENTS[id];
  if (!agent || !llmEnabled()) return null;
  // a skill entra na chave: melhorou a skill, a resposta antiga não é reaproveitada
  const key = crypto.createHash('sha256').update([config.llm, id, skillPrompt(id), typeof payload === 'string' ? payload : JSON.stringify(payload)].join('\n')).digest('hex');
  const hit = db.prepare('SELECT value FROM llm_cache WHERE key = ?').get(key);
  if (hit) return { ...JSON.parse(hit.value), cached: true, agent: id };
  // Orçamento com RESERVA (auditoria de segurança): o custo estimado é reservado antes da
  // chamada, então chamadas simultâneas não passam todas pela checagem. Além do teto por
  // usuário, há um teto GLOBAL do operador: criar várias contas não multiplica o gasto.
  const estimate = agent.maxTokens + Math.ceil((typeof payload === 'string' ? payload.length : JSON.stringify(payload).length) / 3);
  const user = userId || 'anon';
  if (config.llm !== 'ollama') {
    if (usedToday(user) + (reserved.get(user) || 0) + estimate > config.dailyTokenBudget) {
      console.warn(`[agentes] teto diário de tokens atingido para ${user} — usando motor local`);
      return null;
    }
    if (usedTodayAll() + reservedAll + estimate > config.globalDailyTokenBudget) {
      console.warn('[agentes] teto diário GLOBAL de tokens atingido — usando motor local');
      return null;
    }
  }
  reserved.set(user, (reserved.get(user) || 0) + estimate);
  reservedAll += estimate;
  let out;
  try {
    if (!(await acquire(heavy ? 50 : 3))) return null;
    try {
      out = config.llm === 'ollama' ? await callOllama(agent, id, payload)
        : config.llm === 'claude-code' ? await callClaudeCode(agent, id, payload)
          : await callClaude(agent, id, payload);
    } finally { release(); }
  } finally {
    reserved.set(user, Math.max(0, (reserved.get(user) || 0) - estimate));
    reservedAll = Math.max(0, reservedAll - estimate);
  }
  recordUsage(userId, out.model, out.usage.input, out.usage.output);
  if (!out.data) return null;
  const value = { data: out.data, model: out.model, usage: out.usage };
  // estudo excluído enquanto o agente trabalhava: não grava nada ligado a ele
  if (studyId && !db.prepare('SELECT 1 FROM studies WHERE id = ?').get(studyId)) return { ...value, cached: false, agent: id };
  db.prepare('INSERT OR REPLACE INTO llm_cache (key, value, created_at, study_id) VALUES (?, ?, ?, ?)').run(key, JSON.stringify(value), Date.now(), studyId);
  return { ...value, cached: false, agent: id };
}

// Roteamento: qual agente corrige qual tipo de questão.
export const GRADER_FOR = { reasoning: 'corretor', code: 'revisor-codigo', interview: 'entrevistador' };
