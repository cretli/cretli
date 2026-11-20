/**
 * Test-only handler registry for tests/storage-group-commit.test.js. Loaded
 * inside the storage worker thread by absolute path; never used in production.
 */
import fs from 'node:fs';
import { RECEIPT_QUERIES, withReceipt } from '../../lib/storage/command-receipts.js';

const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS test_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS test_apply_log (id INTEGER PRIMARY KEY, k TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS test_blob (id INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT;
`;

/** Batch request id whose COMMIT the commitFault hook fails, and how. */
let commitFault = { batchId: null, mode: null };
/** Batch request id after whose COMMIT the thread exits (afterCommit hook). */
let exitAfterCommitBatch = null;
/** commandId of the batch member whose worker SAVEPOINT fails (once). */
let savepointFaultCommandId = null;

/**
 * Batch member request ids are `<batch request id>:<index>`.
 *
 * @param {any} ctx
 * @returns {string}
 */
function batchIdOf(ctx) {
  return String(ctx.requestId).split(':')[0];
}

/**
 * True the first time a marker file (named in the payload, so a retry keeps
 * the same digest) is seen; creates it.
 *
 * @param {string} marker
 * @returns {boolean}
 */
function firstTime(marker) {
  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(marker, '1');
  return true;
}

/**
 * @param {any} ctx
 * @param {{ k: string, v: string }} payload
 */
function applyPut(ctx, payload) {
  ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(payload.k, payload.v);
  const { lastInsertRowid } = ctx.prepare('INSERT INTO test_apply_log (k) VALUES (?)').run(payload.k);
  return { k: payload.k, applySeq: Number(lastInsertRowid) };
}

export default {
  commands: {
    setup(ctx) {
      ctx.db.exec(SETUP_SQL);
      return { ok: true };
    },
    plainPut(ctx, envelope) {
      return applyPut(ctx, envelope.payload);
    },
    // Per-connection page limit of the worker connection (full-disk test).
    limitPages(ctx) {
      const { page_count: pages } = ctx.prepare('PRAGMA page_count').get();
      ctx.db.exec(`PRAGMA max_page_count = ${Number(pages)}`);
      return { pages: Number(pages) };
    },
    // Raises the page limit set by limitPages again.
    unlimitPages(ctx) {
      ctx.db.exec('PRAGMA max_page_count = 1073741823');
      return { ok: true };
    },
    // Busy-waits on the worker thread: normal host traffic for priority tests.
    spin(_ctx, payload) {
      const until = performance.now() + Number(payload.ms);
      while (performance.now() < until) {
        // Spin.
      }
      return { spun: payload.ms };
    },
    // Arms savepointFault for one batch member (by commandId).
    armSavepointFault(_ctx, payload) {
      savepointFaultCommandId = payload.commandId;
      return { ok: true };
    },
    put: withReceipt(applyPut),
    // Result padded with `pad` characters (shared reply budget tests).
    putBig: withReceipt((ctx, payload) => ({ ...applyPut(ctx, payload), pad: String(payload.ch).repeat(Number(payload.n)) })),
    // Tries to end the worker's member savepoint through ctx.db (refused).
    releaseSavepoint: withReceipt((ctx, payload) => {
      applyPut(ctx, payload);
      ctx.db.exec(`${payload.sql} cretli_gc_member`);
      return null;
    }),
    // Swallows SQLITE_FULL (SQLite rolled the batch back) and the guard's
    // refusal, then returns normally: the transaction ended inside it.
    swallowFullThenReturn: withReceipt((ctx, payload) => {
      try {
        ctx.prepare('INSERT INTO test_blob (b) VALUES (randomblob(?))').run(Number(payload.bytes));
      } catch {
        // Deliberately swallowed (the footgun under test).
      }
      try {
        applyPut(ctx, payload);
      } catch {
        // Swallowed too.
      }
      return { swallowed: true };
    }),
    // SQLITE_FULL: SQLite rolls the whole (batch) transaction back by itself.
    fillBlob: withReceipt((ctx, payload) => {
      ctx.prepare('INSERT INTO test_blob (b) VALUES (randomblob(?))').run(Number(payload.bytes));
      return { filled: payload.bytes };
    }),
    putThenThrow: withReceipt((ctx, payload) => {
      applyPut(ctx, payload);
      throw new Error('member failed after its mutation');
    }),
    // Constraint violation of one statement inside the member.
    putNull: withReceipt((ctx, payload) => {
      applyPut(ctx, payload);
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, NULL)').run(`${payload.k}-null`);
      return null;
    }),
    // Thread ends inside the open batch transaction (first run only).
    putThenExit: withReceipt((ctx, payload) => {
      const result = applyPut(ctx, payload);
      if (firstTime(payload.marker)) process.exit(1);
      return result;
    }),
    // Thread ends after the batch COMMIT, before the reply (first run only).
    putExitAfterCommit: withReceipt((ctx, payload) => {
      if (firstTime(payload.marker)) exitAfterCommitBatch = batchIdOf(ctx);
      return applyPut(ctx, payload);
    }),
    // The batch COMMIT fails after the transaction ended (first run only).
    putCommitFault: withReceipt((ctx, payload) => {
      if (firstTime(payload.marker)) commitFault = { batchId: batchIdOf(ctx), mode: payload.mode };
      return applyPut(ctx, payload);
    }),
  },
  queries: {
    ...RECEIPT_QUERIES,
    get(ctx, payload) {
      const row = ctx.prepare('SELECT v FROM test_kv WHERE k = ?').get(payload.k);
      return row ? row.v : null;
    },
    applyCount(ctx, payload) {
      return Number(ctx.prepare('SELECT count(*) AS n FROM test_apply_log WHERE k = ?').get(payload.k).n);
    },
    receiptCount(ctx) {
      return Number(ctx.prepare('SELECT count(*) AS n FROM command_receipts').get().n);
    },
  },
  faultInjection: {
    afterCommit(ctx) {
      if (exitAfterCommitBatch && exitAfterCommitBatch === ctx.requestId) process.exit(1);
    },
    commitFault(ctx) {
      return commitFault.batchId === ctx.requestId ? commitFault.mode : null;
    },
    savepointFault(ctx) {
      if (!savepointFaultCommandId || ctx.commandId !== savepointFaultCommandId) return false;
      savepointFaultCommandId = null;
      return true;
    },
  },
};
