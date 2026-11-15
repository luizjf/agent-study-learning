// Auditoria: análise que estoura o prazo é encerrada e a thread é reposta (nada prende o pool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TRILHA_JOB_DEADLINE_MS = '1';
process.env.TRILHA_WORKERS = '1';
const { runAnalysis, poolStats } = await import('../server/nlp/pool.js');
const { splitSentences } = await import('../server/nlp/text.js');

test('tarefa acima do prazo é recusada com 422 e o pool continua com o mesmo tamanho', async () => {
  const text = fs.readFileSync(new URL('./fixtures/async-js.txt', import.meta.url), 'utf8');
  const sentences = splitSentences(text).map(t => ({ text: t }));
  await assert.rejects(runAnalysis({ id: 'x', sentences }), e => e.status === 422);
  assert.equal(poolStats().size, 1);
  assert.equal(poolStats().queued, 0);
});
