/**
 * Test-only handler registry for tests/storage-command-receipts.test.js.
 * Loaded inside the storage worker thread by absolute path; never used in
 * production.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { RECEIPT_HANDLER_MARK, RECEIPT_QUERIES, withReceipt } from '../../lib/storage/command-receipts.js';

const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS test_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS test_apply_log (id INTEGER PRIMARY KEY, k TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS test_blob (id INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT;
`;

/** Request id whose handler body really ran (not a replay); see afterCommit. */
let executedRequestId = null;
/** Request id whose COMMIT the commitFault hook below fails, and how. */
let commitFault = { requestId: null, mode: null };

/**
 * Arm a simulated COMMIT failure for this request, once per marker file (so a
 * retry with the same payload, hence the same digest, commits normally).
 *
 * @param {any} ctx
 * @param {{ faultMarker: string }} payload
 * @param {'commit' | 'rollback'} mode
 */
function armCommitFault(ctx, payload, mode) {
  if (fs.existsSync(payload.faultMarker)) return;
  fs.writeFileSync(payload.faultMarker, mode);
  commitFault = { requestId: ctx.requestId, mode };
}

/**
 * Upsert plus one apply-log row per real execution, so tests can count how
 * often the mutation ran.
 *
 * @param {any} ctx
 * @param {{ k: string, v: string }} payload
 */
function applyPut(ctx, payload) {
  ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(payload.k, payload.v);
  const { lastInsertRowid } = ctx.prepare('INSERT INTO test_apply_log (k) VALUES (?)').run(payload.k);
  return { k: payload.k, v: payload.v, applySeq: Number(lastInsertRowid) };
}

export default {
  commands: {
    setup(ctx) {
      ctx.db.exec(SETUP_SQL);
      return { ok: true };
    },
    // Not receipt-wrapped on purpose: executeCommand must refuse its reply.
    // It reads the executeCommand envelope's payload so the mutation commits.
    plainPut(ctx, envelope) {
      return applyPut(ctx, envelope.payload);
    },
    // Per-connection page limit of the worker connection (full-disk tests).
    limitPages(ctx) {
      const { page_count: pages } = ctx.prepare('PRAGMA page_count').get();
      ctx.db.exec(`PRAGMA max_page_count = ${Number(pages)}`);
      return { pages: Number(pages) };
    },
    // Not receipt-wrapped but forges the worker's receipt marker (F30): the
    // worker lets it through, so executeCommand must detect receipt_missing.
    forgedMarkPut: Object.defineProperty(function forgedMarkPut(ctx, envelope) {
      return applyPut(ctx, envelope.payload);
    }, RECEIPT_HANDLER_MARK, { value: true }),
    put: withReceipt(applyPut),
    putThenThrow: withReceipt((ctx, payload) => {
      applyPut(ctx, payload);
      throw new Error('handler failed after its mutation');
    }),
    // Crash before COMMIT: the thread ends inside the open transaction. Only
    // the first run crashes (marker file outside the database, named in the
    // payload so a retry keeps the same digest); later runs apply normally.
    putThenExit: withReceipt((ctx, payload) => {
      const result = applyPut(ctx, payload);
      if (!fs.existsSync(payload.crashMarker)) {
        fs.writeFileSync(payload.crashMarker, 'crashed');
        process.exit(1);
      }
      return result;
    }),
    // Crash after COMMIT, before the reply: afterCommit below ends the thread,
    // but only when the handler body ran in this request (a replay does not).
    putCommitThenExit: withReceipt((ctx, payload) => {
      executedRequestId = ctx.requestId;
      return applyPut(ctx, payload);
    }),
    putBigResult: withReceipt((ctx, payload) => {
      applyPut(ctx, payload);
      return 'x'.repeat(Number(payload.bytes));
    }, { maxResultBytes: 1024 }),
    fillBlob: withReceipt((ctx, payload) => {
      ctx.prepare('INSERT INTO test_blob (b) VALUES (randomblob(?))').run(Number(payload.bytes));
      return { filled: payload.bytes };
    }),
    // Ends the transaction itself: the guarded context refuses the COMMIT,
    // so the handler throws inside the open transaction (rolled back).
    selfCommitPut: withReceipt((ctx, payload) => {
      const result = applyPut(ctx, payload);
      ctx.db.exec('COMMIT');
      return result;
    }),
    // Hits SQLITE_FULL (SQLite rolls the transaction back), swallows it and
    // writes again: the guard refuses the autocommit write.
    swallowFullThenPut: withReceipt((ctx, payload) => {
      try {
        ctx.prepare('INSERT INTO test_blob (b) VALUES (randomblob(?))').run(Number(payload.bytes));
      } catch {
        // Deliberately swallowed (the footgun under test).
      }
      return applyPut(ctx, payload);
    }),
    // Same, but also swallows the guard's refusal and returns normally.
    swallowAllThenReturn: withReceipt((ctx, payload) => {
      try {
        ctx.prepare('INSERT INTO test_blob (b) VALUES (randomblob(?))').run(Number(payload.bytes));
      } catch {
        // Swallowed.
      }
      try {
        applyPut(ctx, payload);
      } catch {
        // Swallowed too.
      }
      return { swallowed: true };
    }),
    putCommitFault: withReceipt((ctx, payload) => {
      armCommitFault(ctx, payload, 'commit');
      return applyPut(ctx, payload);
    }),
    putRollbackFault: withReceipt((ctx, payload) => {
      armCommitFault(ctx, payload, 'rollback');
      return applyPut(ctx, payload);
    }),
    // Blocks the worker thread in native code (a child process), which
    // terminate() cannot interrupt: stands in for a thread stuck in COMMIT.
    sleepNative(_ctx, payload) {
      spawnSync('sleep', [String(payload.seconds)]);
      return { slept: payload.seconds };
    },
    spinPut: withReceipt((ctx, payload) => {
      const until = Date.now() + Number(payload.ms);
      while (Date.now() < until) {
        // Keeps the worker busy so concurrent callers queue up behind it.
      }
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
    blobCount(ctx) {
      return Number(ctx.prepare('SELECT count(*) AS n FROM test_blob').get().n);
    },
  },
  // Active only when the host is created with the `faultInjection` test seam.
  faultInjection: {
    afterCommit(ctx, name) {
      if (name === 'putCommitThenExit' && executedRequestId === ctx.requestId) process.exit(1);
    },
    commitFault(ctx) {
      return commitFault.requestId === ctx.requestId ? commitFault.mode : null;
    },
    // The barrier fails for as long as the marker file named by the env var exists.
    durabilityBarrierFault() {
      const marker = process.env.CRETLI_TEST_BARRIER_FAIL;
      return Boolean(marker) && fs.existsSync(marker);
    },
  },
};
