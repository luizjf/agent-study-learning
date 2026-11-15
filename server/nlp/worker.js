import { parentPort } from 'node:worker_threads';
import { analyze } from './analyze.js';

parentPort.on('message', async ({ jobId, input }) => {
  try {
    parentPort.postMessage({ jobId, result: await analyze(input) });
  } catch (err) {
    parentPort.postMessage({ jobId, error: { message: err.message, status: err.status || 500 } });
  }
});
