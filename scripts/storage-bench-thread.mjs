/**
 * Benchmark-only worker thread for scripts/storage-chat-history-bench.mjs. Not
 * part of the production storage runtime: it never serves requests from the
 * app, only opens temp stores named by the benchmark's `workerData`.
 *
 * Two roles, selected by `workerData.role`:
 *  - `reopen` (frozen A1 method, docs/storage-baseline.md): the thread already
 *    exists and holds an open production store. `measure` closes it, then times
 *    the production `openStorageDb()` (read-only integrity/FK checks, WAL +
 *    synchronous=FULL, migrations) and the production durability barrier
 *    (`runWalTruncateBarrier`, the same helper the storage worker runs before
 *    `ready`), then the first cold page read through the production
 *    `history.readLatest` handler. Thread spawn is excluded by construction.
 *    The thread's own initial open deliberately does NOT run the barrier, and
 *    the copy's WAL is checkpointed away by the clean close that precedes the
 *    timed reopen, so the barrier here is nearly free; the WAL-present cost is
 *    taken from the real worker's `ready` phases instead (see the bench script).
 *  - `checkpointer`: a side connection in its own thread that runs
 *    `wal_checkpoint(FULL)` on request, so the benchmark's event loop is never
 *    blocked by it and the checkpoint can overlap the storage worker's writes.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { openStorageDb, runWalTruncateBarrier, DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { createGuardedConnection } from '../lib/storage/handler-sql-guard.js';
import { queries } from '../lib/storage/chat-history-store.js';

/** @param {import('../lib/storage/db-lifecycle.js').StorageDbHandle} handle @param {object} payload */
function coldReadLatest(handle, payload) {
  const ctx = createGuardedConnection(handle.db, (sql) => handle.db.prepare(sql));
  handle.db.exec('PRAGMA query_only = ON');
  handle.db.exec('BEGIN');
  try {
    return queries['history.readLatest'](ctx, payload);
  } finally {
    handle.db.exec('ROLLBACK');
    handle.db.exec('PRAGMA query_only = OFF');
  }
}

if (workerData.role === 'reopen') {
  let handle = openStorageDb({ dir: workerData.dir });
  parentPort.on('message', (msg) => {
    if (msg.type !== 'measure') return;
    const closeStarted = performance.now();
    handle.close();
    const openStarted = performance.now();
    handle = openStorageDb({ dir: workerData.dir });
    const barrierStarted = performance.now();
    runWalTruncateBarrier(handle.db);
    const coldStarted = performance.now();
    const page = coldReadLatest(handle, msg.payload);
    const done = performance.now();
    // Attribution only (warm, after the timed phases): the O(size) checks that
    // openStorageDb already ran once inside openMs.
    const integrityStarted = performance.now();
    handle.db.prepare('PRAGMA integrity_check').all();
    const foreignKeyStarted = performance.now();
    handle.db.prepare('PRAGMA foreign_key_check').all();
    const attributionDone = performance.now();
    parentPort.postMessage({
      type: 'measured',
      closeMs: openStarted - closeStarted,
      openMs: barrierStarted - openStarted,
      barrierMs: coldStarted - barrierStarted,
      coldReadMs: done - coldStarted,
      coldReadEvents: page.events.length,
      integrityCheckMs: foreignKeyStarted - integrityStarted,
      foreignKeyCheckMs: attributionDone - foreignKeyStarted,
    });
  });
  parentPort.on('close', () => handle.close());
} else if (workerData.role === 'checkpointer') {
  const side = new DatabaseSync(path.join(workerData.dir, DEFAULT_STORAGE_DB_FILENAME), { timeout: 5000 });
  parentPort.on('message', (msg) => {
    if (msg.type === 'checkpoint') {
      const started = performance.now();
      let busy = 1;
      try {
        busy = Number(side.prepare('PRAGMA wal_checkpoint(FULL)').get().busy);
      } catch {
        busy = 1;
      }
      parentPort.postMessage({ type: 'checkpointed', id: msg.id, ms: performance.now() - started, busy });
    } else if (msg.type === 'stop') {
      side.close();
      parentPort.close();
    }
  });
}
