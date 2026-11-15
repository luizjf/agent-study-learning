// Configuração por variáveis de ambiente (ou --llm=… na linha de comando). Padrão: 100% local, zero token pago.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];

// local | claude-code | claude | ollama
const llm = (arg('llm') || process.env.TRILHA_LLM || (process.env.ANTHROPIC_API_KEY ? 'claude' : 'local')).toLowerCase();

export const config = {
  port: Number(arg('port') || process.env.PORT || 3000),
  // Padrão: só este computador. Para uma turma na rede local, HOST=0.0.0.0 (e use a API, não a assinatura).
  host: process.env.HOST || '127.0.0.1',
  dbFile: process.env.TRILHA_DB || path.join(ROOT, 'data', 'trilha.db'),
  llm,
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  // Teto de tokens (entrada+saída) por usuário por dia. Gerar a prova de um vídeo de 25 min
  // pelo Examinador + Cartógrafo usa ~30–40 mil tokens; corrigir uma resposta, ~1–2 mil.
  // API: protege o seu bolso. Claude Code: protege o limite de uso da sua assinatura.
  dailyTokenBudget: Number(process.env.TRILHA_DAILY_TOKENS || (llm === 'claude-code' ? 300000 : 120000)),
  // Teto do OPERADOR somando todos os usuários: criar contas novas não multiplica o gasto.
  globalDailyTokenBudget: Number(process.env.TRILHA_GLOBAL_DAILY_TOKENS || (llm === 'claude-code' ? 600000 : 1000000)),
  // Ao criar um estudo com LLM ligado, os agentes leem o conteúdo inteiro e refazem a prova em segundo plano.
  autoDeep: process.env.TRILHA_AUTO_DEEP !== '0',
  passMark: 0.75,
  rateLimitPerMin: Number(process.env.TRILHA_RATE_LIMIT || 240),
};
