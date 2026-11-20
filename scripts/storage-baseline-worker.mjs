/**
 * A1 storage baseline worker — runs the incremental SQLite variant off the
 * main thread. Reports per-task queue wait (enqueue → worker start) so the
 * parent can compute a queue-age proxy, and supports `reopen` (startup /
 * replay measurement) and `stats` (a process-wide cpuUsage delta used only as a
 * cross-check of the parent's own delta) ops.
 *
 * @see docs/storage-baseline.md
 */

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const dbPath = String(workerData?.dbPath || '');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

let db = null;
let insert = null;
let selectPage = null;

/**
 * @returns {{ db: object, insert: object, selectPage: object }}
 */
function openDb() {
  const handle = new DatabaseSync(dbPath);
  handle.exec('PRAGMA journal_mode=WAL;');
  handle.exec('PRAGMA synchronous=FULL;');
  handle.exec('PRAGMA foreign_keys=ON;');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS chat_events (
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (chat_id, seq)
    );
  `);
  return {
    db: handle,
    insert: handle.prepare('INSERT INTO chat_events (chat_id, seq, payload) VALUES (?, ?, ?)'),
    selectPage: handle.prepare(
      'SELECT seq, payload FROM chat_events WHERE chat_id = ? ORDER BY seq DESC LIMIT 50'
    ),
  };
}

const opened = openDb();
db = opened.db;
insert = opened.insert;
selectPage = opened.selectPage;
// Snapshot for the `stats` op. process.cpuUsage() is process-wide, so this is the
// baseline of the whole process at worker-init time, not of this thread alone.
const cpuAtInit = process.cpuUsage();

parentPort?.postMessage({ ready: true });

parentPort?.on('message', (msg) => {
  try {
    if (!msg || typeof msg !== 'object') return;
    const queueWaitMs = Number.isFinite(msg.enqueuedAt)
      ? Math.max(0, Date.now() - msg.enqueuedAt)
      : null;
    if (msg.op === 'insert') {
      insert.run(String(msg.chatId), Number(msg.seq), String(msg.payload));
      parentPort?.postMessage({ id: msg.chatId, seq: msg.seq, ok: true, queueWaitMs });
      return;
    }
    if (msg.op === 'selectPage') {
      const rows = selectPage.all(String(msg.chatId));
      parentPort?.postMessage({ op: 'selectPage', chatId: msg.chatId, count: rows.length, queueWaitMs });
      return;
    }
    if (msg.op === 'checkpoint') {
      db.exec('PRAGMA wal_checkpoint(FULL);');
      parentPort?.postMessage({ op: 'checkpoint', ok: true });
      return;
    }
    if (msg.op === 'reopen') {
      // Startup/replay proxy: close the handle and reopen from disk.
      db.close();
      const t0 = performance.now();
      const reopened = openDb();
      db = reopened.db;
      insert = reopened.insert;
      selectPage = reopened.selectPage;
      parentPort?.postMessage({ op: 'reopen', ok: true, reopenMs: Number((performance.now() - t0).toFixed(3)) });
      return;
    }
    if (msg.op === 'stats') {
      // process.cpuUsage() is process-wide even inside a worker thread, so this delta
      // covers every thread over the worker's lifetime. The parent uses it only to
      // cross-check its own delta over the same window; the two must not be summed.
      const delta = process.cpuUsage(cpuAtInit);
      parentPort?.postMessage({
        op: 'stats',
        ok: true,
        scope: 'process-wide',
        cpuDeltaTotalMs: (delta.user + delta.system) / 1000,
      });
      return;
    }
  } catch (err) {
    parentPort?.postMessage({
      id: msg?.chatId,
      seq: msg?.seq,
      op: msg?.op,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
