/**
 * Test-only registry whose import fails with a retryable error (EAGAIN) for
 * the first `failTimes` loads, counted in `<dbDir>/flaky.json`. Exercises the
 * retryable start_failed path and `maxStartAttempts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workerData } from 'node:worker_threads';
import handlers from './storage-worker-handlers.js';

const statePath = path.join(workerData.dir, 'flaky.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.loads += 1;
fs.writeFileSync(statePath, JSON.stringify(state));
if (state.loads <= state.failTimes) {
  throw Object.assign(new Error('transient handler load failure'), { code: 'EAGAIN' });
}

export default handlers;
