/**
 * Child process that holds the Workspace Watcher singleton lease.
 *
 * Usage:
 *   node tests/helpers/workspace-watcher-lease-child.js \
 *     <dataDir> <workspaceFolder> <holdMs> <token> [ttlMs]
 *
 * It acquires the real persist lease through the real cross-process lock and
 * CAS path, prints one `LEASED <json>` line and keeps the lease until `holdMs`
 * elapses. The parent uses this to prove a second process cannot drive the same
 * workspace while the lease is live, and can start exactly one watcher after it
 * expires.
 */

import fs from 'node:fs';
import {
  acquireWorkspaceWatcherLease,
  mutateWorkspaceWatcherRow,
} from '../../lib/persist/workspace-watchers-persist.js';

const [dataDir, workspaceFolder, holdMsRaw, token, ttlMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw);
const ttlMs = Number(ttlMsRaw);

if (!dataDir || !workspaceFolder || !Number.isFinite(holdMs) || holdMs < 0 || !token) {
  console.error('usage: workspace-watcher-lease-child.js <dataDir> <workspaceFolder> <holdMs> <token> [ttlMs]');
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

const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
  const attempt = acquireWorkspaceWatcherLease(row, {
    ownerPid: process.pid,
    token,
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60_000,
  });
  return attempt.acquired ? { lease: attempt.lease } : null;
}, { dataDir });

// fd 1 is written synchronously so the parent can never miss the ready line,
// even if it kills this process right after reading it.
fs.writeSync(1, `LEASED ${JSON.stringify({
  ok: result.ok === true,
  reason: result.reason || '',
  pid: process.pid,
  lease: result.row?.lease || null,
})}\n`);

if (result.ok !== true) process.exit(3);

sleepSync(holdMs);
console.log('RELEASED');
