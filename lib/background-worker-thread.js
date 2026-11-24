/** worker_threads entry point for `background-worker.js`. */
import { parentPort } from 'node:worker_threads';
import { runBackgroundTask } from './background-worker-tasks.js';

parentPort.on('message', ({ id, task, payload }) => {
  try {
    parentPort.postMessage({ id, result: runBackgroundTask(task, payload) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
