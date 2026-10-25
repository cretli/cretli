/**
 * Test-only handler registry for tests/storage-worker-host.test.js. Loaded
 * inside the storage worker thread by absolute path; never used in production.
 */

const KV_TABLE = `CREATE TABLE IF NOT EXISTS test_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL CHECK (length(v) > 0)
) STRICT`;

export default {
  commands: {
    setup(ctx) {
      ctx.db.exec(KV_TABLE);
      return { ok: true };
    },
    put(ctx, payload) {
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?)').run(payload.k, payload.v);
      return { k: payload.k, commandId: ctx.commandId };
    },
    putThenThrow(ctx, payload) {
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?)').run(payload.k, payload.v);
      throw new Error('handler failed after insert /secret/path');
    },
    putThenExit(ctx, payload) {
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?)').run(payload.k, payload.v);
      // Ends the worker thread mid-transaction (a crash before COMMIT).
      process.exit(1);
    },
    spin(_ctx, payload) {
      const until = Date.now() + Number(payload.ms);
      while (Date.now() < until) {
        // Busy handler: blocks only the worker thread.
      }
      return { spun: payload.ms };
    },
    // Sync function returning a thenable: refused at call time (an `async`
    // function would already be refused when the registry loads).
    returnsThenable() {
      return Promise.resolve({ never: true });
    },
    commitItself(ctx) {
      ctx.db.exec('COMMIT');
      return null;
    },
    putCommitThenThrow(ctx, payload) {
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?)').run(payload.k, payload.v);
      ctx.db.exec('COMMIT');
      throw new Error('handler failed after its own COMMIT');
    },
    unclonable() {
      return { fn: () => 1 };
    },
    bigResult(_ctx, payload) {
      return 'x'.repeat(Number(payload.bytes));
    },
    putBigResult(ctx, payload) {
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?)').run(payload.k, payload.v);
      return 'x'.repeat(Number(payload.bytes));
    },
    echo(_ctx, payload) {
      return payload;
    },
    // Committed by the normal path; the fault-injection hook below then ends
    // the thread before the reply is posted.
    putCommitThenExit(ctx, payload) {
      ctx.prepare('INSERT INTO test_kv (k, v) VALUES (?, ?)').run(payload.k, payload.v);
      return { k: payload.k };
    },
  },
  queries: {
    get(ctx, payload) {
      const row = ctx.prepare('SELECT v FROM test_kv WHERE k = ?').get(payload.k);
      return row ? row.v : null;
    },
    count(ctx) {
      return Number(ctx.prepare('SELECT count(*) AS n FROM test_kv').get().n);
    },
    tryWrite(ctx) {
      ctx.prepare("INSERT INTO test_kv (k, v) VALUES ('query-write', 'x')").run();
      return null;
    },
  },
  // Active only when the host is created with the `faultInjection` test seam.
  faultInjection: {
    afterCommit(_ctx, name) {
      if (name === 'putCommitThenExit') process.exit(1);
    },
  },
};
