/**
 * Runs pure, CPU-bound background computations off the HTTP/WS thread in a
 * worker_thread, with an in-process fallback when the worker cannot start or
 * fails. Tasks are named and registered in `background-worker-tasks.js`, so
 * only structured-cloneable payloads cross the message interface.
 */
import { Worker } from 'node:worker_threads';
import { runBackgroundTask } from './background-worker-tasks.js';

const WORKER_URL = new URL('./background-worker-thread.js', import.meta.url);
const IDLE_MS = 30_000;

/** @type {{ worker: Worker, pending: Map<number, { resolve: Function, reject: Function }>, timer: NodeJS.Timeout | null } | null} */
let state = null;
let nextId = 1;

function ensureWorker() {
  if (state) return state;
  const worker = new Worker(WORKER_URL);
  const next = { worker, pending: new Map(), timer: null };
  const failAll = (error) => {
    for (const entry of next.pending.values()) entry.reject(error);
    next.pending.clear();
    if (state === next) state = null;
  };
  worker.on('message', (msg) => {
    const entry = next.pending.get(msg?.id);
    if (!entry) return;
    next.pending.delete(msg.id);
    if (msg.error) entry.reject(Object.assign(new Error(String(msg.error)), { taskError: true }));
    else entry.resolve(msg.result);
    if (!next.pending.size) {
      worker.unref();
      next.timer = setTimeout(() => { if (state === next) { state = null; worker.terminate(); } }, IDLE_MS);
      next.timer.unref();
    }
  });
  worker.on('error', failAll);
  worker.on('exit', () => failAll(new Error('background worker exited')));
  state = next;
  return next;
}

/**
 * @param {string} task registered task name
 * @param {unknown} payload structured-cloneable input
 * @param {{ inProcess?: boolean }} [options]
 * @returns {Promise<any>}
 */
export async function runInBackgroundWorker(task, payload, options = {}) {
  if (options.inProcess || process.env.CRETLI_BACKGROUND_WORKER === '0') {
    return runBackgroundTask(task, payload);
  }
  try {
    const current = ensureWorker();
    if (current.timer) { clearTimeout(current.timer); current.timer = null; }
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      current.pending.set(id, { resolve, reject });
      current.worker.ref(); // keep the process alive while a request is in flight
      current.worker.postMessage({ id, task, payload });
    });
  } catch (error) {
    // A task-level error is real; a worker failure degrades to in-process.
    if (error?.taskError) throw error;
    return runBackgroundTask(task, payload);
  }
}

/** Test hook: stop the worker. */
export async function resetBackgroundWorker() {
  const current = state;
  state = null;
  if (current) await current.worker.terminate();
}
