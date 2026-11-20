/**
 * Child process for the cross-process workspace watcher CAS test.
 *
 * Usage:
 *   node tests/helpers/workspace-watcher-cas-child.js \
 *     <dataDir> <childIndex> <iterations> <startAtMs> <sharedWorkspace> <ownWorkspace> \
 *     [witnessPath] [criticalMs]
 *
 * Every mutation goes through the real persist API, so a lost update or an
 * exhausted CAS retry shows up as a failure on stdout.
 *
 * With `witnessPath` the child also runs a timed critical section through the
 * document lock and brackets it with E/X records written *inside* the lock.
 * Correct mutual exclusion makes those records alternate strictly; two
 * processes sharing the critical section show up as E E X X.
 */

import fs from 'node:fs';
import {
  acquireWorkspaceWatcherLease,
  mutateWorkspaceWatcherRow,
  withWorkspaceWatchersFileLock,
} from '../../lib/persist/workspace-watchers-persist.js';

const [
  dataDir,
  childIndexRaw,
  iterationsRaw,
  startAtRaw,
  sharedWorkspace,
  ownWorkspace,
  witnessPath,
  criticalMsRaw,
] = process.argv.slice(2);
const childIndex = Number(childIndexRaw);
const iterations = Number(iterationsRaw);
const startAt = Number(startAtRaw);
const criticalMs = Number.isFinite(Number(criticalMsRaw)) ? Math.max(0, Number(criticalMsRaw)) : 0;

if (
  !dataDir
  || !Number.isInteger(childIndex)
  || !Number.isInteger(iterations)
  || !Number.isFinite(startAt)
  || !sharedWorkspace
  || !ownWorkspace
) {
  console.error(
    'usage: workspace-watcher-cas-child.js <dataDir> <childIndex> <iterations> <startAtMs> <sharedWorkspace> <ownWorkspace> [witnessPath] [criticalMs]',
  );
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

// Barrier so the children really overlap instead of running one after another.
const waitMs = startAt - Date.now();
if (waitMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

const token = `child-${childIndex}`;
const stats = {
  childIndex,
  pid: process.pid,
  iterations,
  failures: [],
  leaseAborts: 0,
};

for (let i = 0; i < iterations; i += 1) {
  const counter = mutateWorkspaceWatcherRow(sharedWorkspace, ({ row }) => ({
    cycleCount: (Number(row.cycleCount) || 0) + 1,
  }), { dataDir });
  if (!counter.ok) stats.failures.push({ op: 'shared-counter', reason: counter.reason });

  const ownLease = mutateWorkspaceWatcherRow(ownWorkspace, ({ row }) => {
    const attempt = acquireWorkspaceWatcherLease(row, {
      ownerPid: process.pid,
      token,
      ttlMs: 60_000,
    });
    return attempt.acquired ? { lease: attempt.lease } : null;
  }, { dataDir });
  if (!ownLease.ok) stats.failures.push({ op: 'own-lease', reason: ownLease.reason });

  const ownDecisions = mutateWorkspaceWatcherRow(ownWorkspace, ({ row }) => ({
    decisions: [...row.decisions, {
      at: new Date().toISOString(),
      kind: 'child_write',
      reason: `${token}-${i}`,
      readyTodoCount: 0,
      activeAgentCount: 0,
      shouldNotify: false,
    }],
  }), { dataDir });
  if (!ownDecisions.ok) stats.failures.push({ op: 'own-decisions', reason: ownDecisions.reason });

  const sharedLease = mutateWorkspaceWatcherRow(sharedWorkspace, ({ row }) => {
    const attempt = acquireWorkspaceWatcherLease(row, {
      ownerPid: process.pid,
      token,
      ttlMs: 60_000,
    });
    if (!attempt.acquired) return null;
    return { lease: attempt.lease };
  }, { dataDir });
  if (!sharedLease.ok) {
    if (sharedLease.reason === 'aborted') stats.leaseAborts += 1;
    else stats.failures.push({ op: 'shared-lease', reason: sharedLease.reason });
  }

  if (witnessPath) {
    withWorkspaceWatchersFileLock(() => {
      fs.appendFileSync(witnessPath, `E ${childIndex} ${process.pid}\n`);
      sleepSync(criticalMs);
      fs.appendFileSync(witnessPath, `X ${childIndex} ${process.pid}\n`);
    }, { dataDir });
  }
}

console.log(JSON.stringify(stats));
