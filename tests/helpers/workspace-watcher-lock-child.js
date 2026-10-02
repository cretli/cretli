/**
 * Child process for the cross-process workspace watcher lock tests.
 *
 * Usage:
 *   node tests/helpers/workspace-watcher-lock-child.js <dataDir> hold <holdMs>
 *
 * `hold` enters the real document critical section, reports LOCKED, keeps it
 * for holdMs and then releases it and exits. The parent either waits for the
 * release (a live holder must be waited out, never stolen) or SIGKILLs the
 * child (a crashed holder must release the lock without any cleanup).
 */

import fs from 'node:fs';
import { withWorkspaceWatchersFileLock } from '../../lib/persist/workspace-watchers-persist.js';

const [dataDir, mode, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw);

if (!dataDir || mode !== 'hold' || !Number.isFinite(holdMs) || holdMs < 0) {
  console.error('usage: workspace-watcher-lock-child.js <dataDir> hold <holdMs>');
  process.exit(2);
}

/**
 * @param {number} ms
 * @returns {void}
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

withWorkspaceWatchersFileLock(() => {
  // fd 1 is written synchronously: a buffered log line could otherwise still
  // be pending when the parent kills this process.
  fs.writeSync(1, 'LOCKED\n');
  sleepSync(holdMs);
}, { dataDir });

console.log('RELEASED');
