// Pool de worker threads para a análise de texto.
// Achado do teste de carga: com 20 estudos sendo criados ao mesmo tempo, o processamento
// (até ~100 ms cada) bloqueava o event loop e todos os outros alunos esperavam na fila.
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { analyze } from './analyze.js';

const SIZE = Number(process.env.TRILHA_WORKERS ?? Math.max(1, Math.min(4, os.availableParallelism() - 1)));
const MAX_QUEUE = 200;
// Prazo por tarefa (auditoria de segurança): uma análise que passa disso é encerrada e a
// thread é substituída — nenhum envio prende uma thread compartilhada indefinidamente.
const JOB_DEADLINE_MS = Number(process.env.TRILHA_JOB_DEADLINE_MS || 30000);

const workers = [];
const idle = [];
const queue = [];
const jobs = new Map();
let nextId = 1;

function spawn() {
  const w = new Worker(new URL('./worker.js', import.meta.url));
  w.on('message', ({ jobId, result, error }) => {
    const job = jobs.get(jobId);
    jobs.delete(jobId);
    clearTimeout(w.deadline);
    w.busy = null;
    w.unref(); // ocioso: não impede o processo de encerrar
    if (job) {
      if (error) { const e = new Error(error.message); e.status = error.status; job.reject(e); } else job.resolve(result);
    }
    idle.push(w);
    pump();
  });
  w.on('error', (err) => replace(w, err));
  // unref DEPOIS dos listeners: registrar 'message' religa a porta e prenderia o processo
  w.unref();
  workers.push(w);
  return w;
}

// worker morreu ou estourou o prazo: falha o trabalho atual e repõe o worker
function replace(w, err) {
  if (w.replaced) return;
  w.replaced = true;
  clearTimeout(w.deadline);
  const job = w.busy && jobs.get(w.busy);
  if (job) { jobs.delete(w.busy); job.reject(err); }
  const k = workers.indexOf(w);
  if (k >= 0) workers.splice(k, 1);
  const i = idle.indexOf(w);
  if (i >= 0) idle.splice(i, 1);
  w.terminate().catch(() => {});
  idle.push(spawn());
  pump();
}

function pump() {
  while (idle.length && queue.length) {
    const w = idle.pop();
    const { jobId, input } = queue.shift();
    w.busy = jobId;
    w.ref(); // ocupado: mantém o processo vivo até responder
    w.deadline = setTimeout(() => {
      const e = new Error('O conteúdo demorou demais para ser analisado. Tente um trecho menor.');
      e.status = 422;
      replace(w, e);
    }, JOB_DEADLINE_MS);
    w.postMessage({ jobId, input });
  }
}

export function runAnalysis(input) {
  if (SIZE === 0) return analyze(input); // modo sem threads (depuração)
  if (!workers.length) for (let i = 0; i < SIZE; i++) idle.push(spawn());
  if (queue.length >= MAX_QUEUE) {
    const e = new Error('O servidor está montando muitas provas agora. Tente em alguns segundos.');
    e.status = 503;
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const jobId = nextId++;
    jobs.set(jobId, { resolve, reject });
    queue.push({ jobId, input });
    pump();
  });
}

export function poolStats() {
  return { size: SIZE, busy: workers.length - idle.length, queued: queue.length };
}
