/**
 * Process-wide job queue used by the host verify path. Lazily created on first
 * use under `<data>/job-queue/`, so importing this module opens nothing.
 *
 * `CRETLI_VERIFY_QUEUE=0` disables it, and any failure to open the store or
 * take its owner lease degrades to `null`: the caller then runs the raw
 * runner, so a broken queue can never block a verify.
 */
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';
import { createJobQueue } from './job-queue.js';
import { createQueuedVerifyRunner } from './verify-runner.js';

/** @type {{ queue: ReturnType<typeof createJobQueue>, runner: Function } | null} */
let instance = null;
let failed = false;

/** @returns {boolean} false when CRETLI_VERIFY_QUEUE is off */
export function isVerifyQueueEnabled() {
  const raw = String(process.env.CRETLI_VERIFY_QUEUE ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * @param {Pick<Parameters<typeof createQueuedVerifyRunner>[0], 'runStep' | 'resolveCatalog'>} deps
 * @returns {ReturnType<typeof createQueuedVerifyRunner> | null} null when the queue is disabled or unavailable
 */
export function getDefaultVerifyRunner(deps) {
  if (!isVerifyQueueEnabled() || failed) return null;
  if (instance) return /** @type {any} */ (instance.runner);
  try {
    const queue = createJobQueue({ dir: path.join(resolveDataPath(), 'job-queue') });
    const runner = createQueuedVerifyRunner({ queue, ...deps });
    instance = { queue, runner };
    return runner;
  } catch (error) {
    failed = true;
    console.warn(`[job-queue] verify queue unavailable, running verify directly: ${String(/** @type {any} */ (error)?.message || error)}`);
    return null;
  }
}

/** Test-only: close and forget the shared queue. */
export function resetDefaultJobQueueForTests() {
  try { instance?.queue.close(); } catch { /* already closed */ }
  instance = null;
  failed = false;
}
