import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { StorageError } from '../lib/storage/errors.js';
import { executeCommand, RECEIPT_LOOKUP_QUERY, resolveUnknown } from '../lib/storage/command-receipts.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-group-handlers.js', import.meta.url));
const GEN = 'gen-1';
/** A1 gate: priority classes never starved > 500 ms (docs/storage-gates.md). */
const PRIORITY_GATE_MS = 500;

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-group-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {Record<string, unknown>} [extra]
 */
async function startHost(extra = {}) {
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    restartBackoffMs: { initial: 10, max: 100 },
    faultInjection: true,
    writeGate: WRITE_GATE_TEST_EXEMPTION,
    ...extra,
  });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

/**
 * Manual clock: timers fire only through `advance`.
 */
function fakeClock() {
  let t = 0;
  /** @type {Set<{ at: number, fn: () => void }>} */
  const timers = new Set();
  return {
    now: () => t,
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimer(fn, ms) {
      const h = { at: t + ms, fn };
      timers.add(h);
      return h;
    },
    /** @param {any} h */
    clearTimer(h) {
      timers.delete(h);
    },
    /** @param {number} ms */
    advance(ms) {
      t += ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        due.fn();
      }
    },
  };
}

/**
 * @param {any} host
 * @param {ReturnType<typeof fakeClock>} clock
 * @param {Record<string, unknown>} [extra]
 */
function committer(host, clock, extra = {}) {
  return createGroupCommitter({ host, writeGate: WRITE_GATE_TEST_EXEMPTION, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra });
}

/**
 * @param {string} commandId
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [extra]
 */
function cmd(commandId, payload, extra = {}) {
  return { datasetGeneration: GEN, commandId, name: 'put', payload, ...extra };
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

/**
 * @param {any} host
 * @param {string} k
 */
async function applied(host, k) {
  return host.query('applyCount', { k });
}

/**
 * Let pending promise reactions and the host reply settle.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function until(predicate, timeoutMs = 2000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) assert.fail('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Host double whose batch requests stay pending until the test settles them.
 */
function controlledHost() {
  /** @type {Array<{ ids: string[], priority: string, resolve: (v: unknown) => void, reject: (e: unknown) => void }>} */
  const calls = [];
  return {
    calls,
    /**
     * @param {any[]} members
     * @param {any} opts
     */
    commandBatch(members, opts) {
      return new Promise((resolve, reject) => calls.push({ ids: members.map((m) => m.commandId), priority: opts.priority, resolve, reject }));
    },
  };
}

/**
 * @param {Promise<unknown>} promise
 */
function quiet(promise) {
  promise.catch(() => {});
  return promise;
}

describe('group commit flush triggers', () => {
  it('flushes on the 40 ms window as one transaction', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const before = host.getMetrics().counters.completed;
    const all = Promise.all(['a', 'b', 'c'].map((k) => gc.submit(cmd(`w-${k}`, { k, v: '1' }))));
    clock.advance(39);
    assert.equal(gc.getMetrics().counters.batches, 0, 'held for the window');
    assert.equal(gc.getMetrics().buffered, 3);
    clock.advance(1);
    assert.equal(gc.getMetrics().counters.batches, 1);
    assert.equal(gc.getMetrics().counters.flushByWindow, 1);
    const results = await all;
    assert.deepEqual(results.map((r) => r.replayed), [false, false, false]);
    assert.deepEqual(results.map((r) => /** @type {any} */ (r.result).k), ['a', 'b', 'c']);
    assert.equal(host.getMetrics().counters.completed - before, 1, 'one worker request for three members');
    assert.equal(await host.query('receiptCount', {}), 3, 'one receipt per member');
  });

  it('flushes at once when the buffer fills maxBatchBytes and never overshoots it', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const big = 'x'.repeat(300);
    const probe = committer({ commandBatch: () => new Promise(() => {}) }, clock);
    probe.submit(cmd('s-0', { k: 's0', v: big })).catch(() => {});
    const entry = probe.getMetrics().bufferedBytes;
    // Room for two entries plus the frame, not for three.
    const maxBatchBytes = 2 * entry + 14 + Math.floor(entry / 2);
    /** @type {number[]} */
    const sent = [];
    const measuring = {
      /**
       * @param {any[]} members
       * @param {any} opts
       */
      commandBatch(members, opts) {
        const text = `{"members":[${members.map((m) => `{"name":${JSON.stringify(m.name)},"commandId":${JSON.stringify(m.commandId)},"payload":${m.payloadJson}}`).join(',')}]}`;
        sent.push(Buffer.byteLength(text));
        return host.commandBatch(members, opts);
      },
    };
    const gc = committer(measuring, clock, { maxBatchBytes });
    const p1 = gc.submit(cmd('s-1', { k: 's1', v: big }));
    const p2 = gc.submit(cmd('s-2', { k: 's2', v: big }));
    assert.equal(gc.getMetrics().counters.batches, 0);
    const p3 = gc.submit(cmd('s-3', { k: 's3', v: big }));
    assert.equal(gc.getMetrics().counters.batches, 1, 'no clock advance needed');
    assert.equal(gc.getMetrics().counters.flushBySize, 1);
    assert.equal(gc.getMetrics().inFlight, 2, 'the third member does not fit');
    assert.equal(gc.getMetrics().buffered, 1);
    await Promise.all([p1, p2]);
    clock.advance(40);
    await p3;
    assert.equal(await host.query('receiptCount', {}), 3);
    assert.equal(sent.length, 2);
    for (const bytes of sent) assert.ok(bytes <= maxBatchBytes, `batch of ${bytes} bytes within ${maxBatchBytes}`);
  });

  it('ships a single member larger than maxBatchBytes alone', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock, { maxBatchBytes: 600, maxMemberBytes: 4096 });
    const small = gc.submit(cmd('o-1', { k: 'o1', v: '1' }));
    const huge = gc.submit(cmd('o-2', { k: 'o2', v: 'z'.repeat(1000) }));
    assert.equal(gc.getMetrics().inFlight, 1, 'the small member goes first, alone');
    await small;
    assert.equal(gc.getMetrics().inFlight, 1, 'the oversized member ships alone');
    await huge;
    assert.equal(gc.getMetrics().counters.batches, 2);
  });

  it('flushes at maxBatchCount and splits a larger buffer into batches', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock, { maxBatchCount: 2 });
    const all = ['a', 'b', 'c', 'd', 'e'].map((k) => gc.submit(cmd(`n-${k}`, { k, v: '1' })));
    assert.equal(gc.getMetrics().counters.flushByCount, 1);
    await Promise.all(all.slice(0, 4));
    clock.advance(40);
    await all[4];
    assert.equal(gc.getMetrics().counters.batches, 3);
  });

  it('flushes priority classes immediately, ahead of normal members, within the 500 ms gate', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    for (const priority of ['stop', 'claim', 'intent', 'final']) {
      const normal = gc.submit(cmd(`p-n-${priority}`, { k: `n-${priority}`, v: '1' }));
      const started = performance.now();
      const urgent = gc.submit(cmd(`p-${priority}`, { k: priority, v: '1' }, { priority }));
      // The idle main lane takes the priority member and the buffered normal one.
      assert.equal(gc.getMetrics().inFlightBatches, 1, `${priority} dispatched without waiting for the window`);
      assert.equal(gc.getMetrics().inFlight, 2, 'one batch carries both members');
      assert.equal(gc.getMetrics().buffered, 0);
      const [n, u] = await Promise.all([normal, urgent]);
      assert.ok(performance.now() - started < PRIORITY_GATE_MS);
      assert.ok(/** @type {any} */ (u.result).applySeq < /** @type {any} */ (n.result).applySeq, 'priority member ran first');
    }
    assert.equal(gc.getMetrics().counters.flushByPriority, 4);
    assert.equal(gc.getMetrics().counters.flushByWindow, 0);
  });

  it('dispatches a priority member at once on the priority lane while a batch is in flight', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const first = gc.submit(cmd('q-1', { k: 'q1', v: '1' }));
    const pending = gc.flush();
    const second = gc.submit(cmd('q-2', { k: 'q2', v: '1' }, { priority: 'stop' }));
    const third = gc.submit(cmd('q-3', { k: 'q3', v: '1' }));
    assert.equal(gc.getMetrics().inFlightBatches, 2, 'main lane busy, priority lane took the stop member');
    assert.equal(gc.getMetrics().buffered, 1, 'a normal member never uses the priority lane');
    await Promise.all([first, second, third, pending]);
    assert.equal(gc.getMetrics().counters.batches, 3);
    assert.equal(gc.getMetrics().counters.priorityLaneBatches, 1);
  });

  it('commits a final member within 500 ms although normal traffic is queued in the host ahead of an in-flight normal batch', async () => {
    const host = await startHost();
    const gc = createGroupCommitter({ host });
    // ~750 ms of normal work queued in the host before the normal batch.
    const backlog = Array.from({ length: 5 }, () => host.command('spin', { ms: 150 }));
    const normal = gc.submit(cmd('hb-n', { k: 'hbn', v: '1' }));
    const flushed = gc.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gc.getMetrics().inFlightBatches, 1, 'the normal batch waits in the host queue');
    for (const priority of ['final', 'stop']) {
      const started = performance.now();
      const urgent = await gc.submit(cmd(`hb-${priority}`, { k: `hb-${priority}`, v: '1' }, { priority }));
      const elapsed = performance.now() - started;
      assert.equal(urgent.replayed, false);
      assert.ok(elapsed < PRIORITY_GATE_MS, `${priority} committed after ${Math.round(elapsed)} ms`);
    }
    await Promise.all([...backlog, normal, flushed]);
    assert.ok(/** @type {any} */ ((await normal).result).applySeq > 1, 'the normal member still commits');
  });
});

describe('group commit receipts and replay', () => {
  it('keeps one receipt per member and replays a resubmitted commandId', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const a = gc.submit(cmd('r-a', { k: 'ra', v: '1' }));
    const b = gc.submit(cmd('r-b', { k: 'rb', v: '1' }));
    const dup = gc.submit(cmd('r-a', { k: 'ra', v: '1' }));
    await gc.flush();
    const [ra, rb, rdup] = await Promise.all([a, b, dup]);
    assert.equal(ra.replayed, false);
    assert.equal(rb.replayed, false);
    assert.equal(rdup.replayed, true, 'same commandId in the same batch replays');
    assert.deepEqual(rdup.result, ra.result);
    for (const commandId of ['r-a', 'r-b']) {
      const row = await host.query(RECEIPT_LOOKUP_QUERY, { datasetGeneration: GEN }, { commandId });
      assert.match(row.requestDigest, /^sha256:/);
    }
    const again = gc.submit(cmd('r-a', { k: 'ra', v: '1' }));
    clock.advance(40);
    assert.equal((await again).replayed, true);
    assert.equal((await executeCommand(host, cmd('r-b', { k: 'rb', v: '1' }))).replayed, true, 'executeCommand sees the same receipt');
    assert.equal(await applied(host, 'ra'), 1);
    assert.equal(await applied(host, 'rb'), 1);
    const changed = gc.submit(cmd('r-a', { k: 'ra', v: 'other' }));
    clock.advance(40);
    const err = await rejection(changed);
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.conflictKind, 'receipt_digest_mismatch');
    assert.equal(err.details.commandId, 'r-a');
  });

  it('snapshots the payload at submit', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const payload = { k: 'snap', v: 'before' };
    const p = gc.submit(cmd('snap-1', payload));
    payload.v = 'after';
    await gc.flush();
    await p;
    assert.equal(await host.query('get', { k: 'snap' }), 'before');
  });
});

describe('group commit partial failure', () => {
  it('rolls back only the failing member (worker savepoint) and commits the others', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const ok1 = gc.submit(cmd('pf-1', { k: 'pf1', v: '1' }));
    const bad = gc.submit({ ...cmd('pf-2', { k: 'pf2', v: '1' }), name: 'putThenThrow' });
    const badSql = gc.submit({ ...cmd('pf-3', { k: 'pf3', v: '1' }), name: 'putNull' });
    const unwrapped = gc.submit({ ...cmd('pf-4', { k: 'pf4', v: '1' }), name: 'plainPut' });
    const missing = gc.submit({ ...cmd('pf-5', { k: 'pf5', v: '1' }), name: 'noSuchHandler' });
    const ok2 = gc.submit(cmd('pf-6', { k: 'pf6', v: '1' }));
    await gc.flush();
    assert.equal((await ok1).replayed, false);
    assert.equal((await ok2).replayed, false);
    for (const [promise, operation] of [[bad, null], [badSql, null], [unwrapped, 'receipt_required'], [missing, 'unknown_handler']]) {
      const err = await rejection(promise);
      assert.ok(err instanceof StorageError);
      assert.equal(err.details.commitState, 'not_committed');
      assert.notEqual(err.code, 'unknown_commit');
      if (operation) assert.equal(err.details.operation, operation);
    }
    assert.equal(gc.getMetrics().counters.batches, 1);
    for (const k of ['pf2', 'pf3', 'pf4', 'pf5']) assert.equal(await host.query('get', { k }), null, `${k} rolled back`);
    assert.equal(await applied(host, 'pf1'), 1);
    assert.equal(await applied(host, 'pf6'), 1);
    assert.equal(await host.query('receiptCount', {}), 2);
    // A failed member left no receipt: retrying it with the same id runs it again.
    const retry = gc.submit(cmd('pf-2', { k: 'pf2', v: '1' }));
    clock.advance(40);
    assert.equal((await retry).replayed, false, 'a failed member left no receipt, so the same commandId runs fresh');
  });
});

describe('group commit failures', () => {
  it('aborts the whole batch when SQLite rolls the transaction back (full disk): nothing durable', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    await host.command('limitPages', {});
    const before = gc.submit(cmd('fd-1', { k: 'fd1', v: '1' }));
    const fill = gc.submit({ ...cmd('fd-2', { bytes: 1024 * 1024 }), name: 'fillBlob' });
    const after = gc.submit(cmd('fd-3', { k: 'fd3', v: '1' }));
    await gc.flush();
    for (const p of [before, fill, after]) {
      const err = await rejection(p);
      assert.equal(err.code, 'full_disk');
      assert.equal(err.details.commitState, 'not_committed');
    }
    assert.equal(gc.getMetrics().counters.requeued, 0, 'full_disk is not retryable');
    assert.equal(await host.query('get', { k: 'fd1' }), null, 'earlier member rolled back with the batch');
    assert.equal(await host.query('receiptCount', {}), 0);
  });

  it('keeps the buffer and stable commandIds across a failed flush, then commits once', async () => {
    const host = await startHost();
    const clock = fakeClock();
    /** @type {string[][]} */
    const seen = [];
    let failures = 1;
    const flaky = {
      /**
       * @param {any[]} members
       * @param {any} opts
       */
      commandBatch(members, opts) {
        seen.push(members.map((m) => m.commandId));
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new StorageError('busy', 'Storage is busy', { details: { operation: 'deadline', commitState: 'not_committed' } }));
        }
        return host.commandBatch(members, opts);
      },
    };
    const gc = committer(flaky, clock, { retryDelayMs: 25 });
    const all = Promise.all([gc.submit(cmd('f-1', { k: 'f1', v: '1' })), gc.submit(cmd('f-2', { k: 'f2', v: '1' }))]);
    clock.advance(40);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gc.getMetrics().buffered, 2, 'members kept after the failed flush');
    assert.equal(gc.getMetrics().counters.requeued, 2);
    clock.advance(24);
    assert.equal(seen.length, 1, 'retry waits for the backoff');
    clock.advance(1);
    await all;
    assert.deepEqual(seen, [['f-1', 'f-2'], ['f-1', 'f-2']]);
    assert.equal(await applied(host, 'f1'), 1);
    assert.equal(await applied(host, 'f2'), 1);
  });

  it('rejects with the retryable error once flush attempts are exhausted', async () => {
    const clock = fakeClock();
    let calls = 0;
    const down = {
      commandBatch() {
        calls += 1;
        return Promise.reject(new StorageError('busy', 'Storage is busy', { details: { operation: 'queue_depth', commitState: 'not_committed' } }));
      },
    };
    const gc = committer(down, clock, { maxFlushAttempts: 3, retryDelayMs: 10 });
    const p = gc.submit(cmd('x-1', { k: 'x1', v: '1' }));
    clock.advance(40);
    for (const step of [10, 20]) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(step);
    }
    const err = await rejection(p);
    assert.equal(calls, 3);
    assert.equal(err.code, 'busy');
    assert.equal(err.retryable, true);
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(err.details.commandId, 'x-1');
    assert.equal(gc.getMetrics().heldCount, 0);
  });

  it('reports a worker crash mid-batch as unknown_commit for every member, then resolveUnknown per member', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const marker = path.join(root, 'crash-marker');
    const args = [
      cmd('c-1', { k: 'c1', v: '1' }),
      { ...cmd('c-2', { k: 'c2', v: '1', marker }), name: 'putThenExit' },
      cmd('c-3', { k: 'c3', v: '1' }),
    ];
    const promises = args.map((a) => gc.submit(a));
    await gc.flush();
    for (const p of promises) {
      const err = await rejection(p);
      assert.equal(err.code, 'unknown_commit');
      assert.equal(err.details.commitState, 'unknown');
      assert.equal(err.details.operation, 'worker_lost');
    }
    assert.deepEqual((await Promise.all(promises.map((p) => rejection(p)))).map((e) => e.details.commandId), ['c-1', 'c-2', 'c-3']);
    for (const a of args) assert.deepEqual(await resolveUnknown(host, a), { outcome: 'not_committed' });
    const retried = await Promise.all(args.map((a) => gc.submit(a)).concat([gc.flush()]));
    assert.deepEqual(retried.slice(0, 3).map((r) => /** @type {any} */ (r).replayed), [false, false, false]);
    for (const k of ['c1', 'c2', 'c3']) assert.equal(await applied(host, k), 1);
  });

  it('reports a crash after the batch COMMIT as unknown_commit; resolveUnknown says committed', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const marker = path.join(root, 'exit-marker');
    const args = [cmd('e-1', { k: 'e1', v: '1' }), { ...cmd('e-2', { k: 'e2', v: '1', marker }), name: 'putExitAfterCommit' }];
    const promises = args.map((a) => gc.submit(a));
    await gc.flush();
    for (const p of promises) assert.equal((await rejection(p)).code, 'unknown_commit');
    for (const a of args) assert.equal((await resolveUnknown(host, a)).outcome, 'committed');
    assert.equal(await applied(host, 'e1'), 1);
  });

  for (const [mode, expected] of [['commit', 'committed'], ['rollback', 'not_committed']]) {
    it(`recycles the worker after a COMMIT-time failure (${mode}); members are unknown until resolved`, async () => {
      const host = await startHost();
      const clock = fakeClock();
      const gc = committer(host, clock);
      const marker = path.join(root, `fault-${mode}`);
      const args = [cmd(`cf-${mode}-1`, { k: `cf-${mode}-1`, v: '1' }), { ...cmd(`cf-${mode}-2`, { k: `cf-${mode}-2`, v: '1', marker, mode }), name: 'putCommitFault' }];
      const promises = args.map((a) => gc.submit(a));
      await gc.flush();
      for (const p of promises) {
        const err = await rejection(p);
        assert.equal(err.code, 'unknown_commit');
        assert.equal(err.details.operation, 'commit');
        assert.notEqual(err.details.reconcilable, false);
      }
      for (const a of args) assert.equal((await resolveUnknown(host, a)).outcome, expected);
      assert.equal(host.getMetrics().counters.workerLost, 1, 'the connection was recycled');
    });
  }
});

describe('group commit priority lane and anti-starvation', () => {
  it('includes an aged normal member in the next main batch despite a priority backlog', async () => {
    const clock = fakeClock();
    const host = controlledHost();
    const gc = committer(host, clock, { maxBatchCount: 4, maxNormalWaitMs: 200 });
    const stop = (/** @type {number} */ i) => quiet(gc.submit(cmd(`sp-${i}`, { k: `sp${i}`, v: '1' }, { priority: 'stop' })));
    stop(0);
    stop(1);
    await until(() => host.calls.length === 2);
    assert.deepEqual(host.calls.map((c) => c.ids), [['sp-0'], ['sp-1']], 'main lane, then priority lane');
    const normal = quiet(gc.submit(cmd('sn-1', { k: 'sn1', v: '1' })));
    for (let i = 2; i < 10; i += 1) stop(i);
    const failed = () => new StorageError('io', 'x', { retryable: false, details: { commitState: 'not_committed' } });
    clock.advance(100);
    host.calls[0].reject(failed());
    await until(() => host.calls.length === 3);
    assert.deepEqual(host.calls[2].ids, ['sp-2', 'sp-3', 'sp-4', 'sp-5'], 'not aged yet: priority first');
    clock.advance(100);
    host.calls[2].reject(failed());
    await until(() => host.calls.length === 4);
    assert.equal(host.calls[3].ids[0], 'sn-1', 'the aged normal member leads the next main batch');
    assert.deepEqual(host.calls[3].ids, ['sn-1', 'sp-6', 'sp-7', 'sp-8']);
    host.calls[3].reject(failed());
    assert.equal((await rejection(normal)).details.commandId, 'sn-1');
  });
});

describe('group commit shared reply budget', () => {
  it('defers members that only miss the shared budget and commits them in the next batch', async () => {
    const host = await startHost({ maxResultBytes: 3000 });
    const clock = fakeClock();
    const gc = committer(host, clock);
    const big = (/** @type {string} */ id, /** @type {number} */ n, ch = 'x') => ({ ...cmd(id, { k: id, v: '1', n, ch }), name: 'putBig' });
    const a = gc.submit(big('rb-a', 1600));
    const b = gc.submit(big('rb-b', 1600));
    const c = gc.submit(big('rb-c', 10));
    const tooLarge = gc.submit(big('rb-d', 5000));
    await gc.flush();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.deepEqual([ra, rb, rc].map((r) => r.replayed), [false, false, false]);
    assert.equal(gc.getMetrics().counters.deferred, 3, 'b, c and d were deferred once (nothing runs after a deferral)');
    assert.equal(gc.getMetrics().counters.requeued, 3);
    assert.ok(/** @type {any} */ (rb.result).applySeq > /** @type {any} */ (ra.result).applySeq);
    const err = await rejection(tooLarge);
    assert.equal(err.details.operation, 'result_too_large', 'a result over the per-member cap stays permanent');
    assert.equal(err.retryable, false);
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(await host.query('get', { k: 'rb-d' }), null);
    for (const k of ['rb-a', 'rb-b', 'rb-c']) assert.equal(await applied(host, k), 1);
  });

  it('charges the budget with the escaped bytes embedded in the reply', async () => {
    const host = await startHost({ maxResultBytes: 3000 });
    const clock = fakeClock();
    const gc = committer(host, clock);
    // ~1.6 KB of raw result JSON, ~3 KB once embedded as a JSON string.
    const quotes = gc.submit({ ...cmd('eb-a', { k: 'eb-a', v: '1', n: 700, ch: '"' }), name: 'putBig' });
    const small = gc.submit({ ...cmd('eb-b', { k: 'eb-b', v: '1', n: 10, ch: 'x' }), name: 'putBig' });
    await gc.flush();
    await Promise.all([quotes, small]);
    assert.equal(gc.getMetrics().counters.deferred, 1, 'the second member no longer fits the escaped budget');
    assert.equal(gc.getMetrics().counters.batches, 2);
  });
});

describe('group commit worker transaction edges', () => {
  for (const sql of ['RELEASE', 'ROLLBACK TO']) {
    it(`refuses a handler's ${sql} of the worker savepoint and rolls back only that member`, async () => {
      const host = await startHost();
      const clock = fakeClock();
      const gc = committer(host, clock);
      const ok1 = gc.submit(cmd('sv-ok1', { k: 'svok1', v: '1' }));
      const bad = gc.submit({ ...cmd('sv-bad', { k: 'svbad', v: '1', sql }), name: 'releaseSavepoint' });
      const ok2 = gc.submit(cmd('sv-ok2', { k: 'svok2', v: '1' }));
      await gc.flush();
      await Promise.all([ok1, ok2]);
      const err = await rejection(bad);
      assert.equal(err.details.operation, 'transaction_control');
      assert.equal(err.details.commitState, 'not_committed');
      assert.equal(await host.query('get', { k: 'svbad' }), null);
      assert.equal(await applied(host, 'svok1'), 1);
      assert.equal(await applied(host, 'svok2'), 1);
      assert.equal(await host.query('receiptCount', {}), 2);
    });
  }

  it('handler_transaction: offender not reconcilable, earlier members unknown, later members re-buffered', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    await host.command('limitPages', {});
    const args = [
      cmd('ht-1', { k: 'ht1', v: '1' }),
      { ...cmd('ht-2', { k: 'ht2', v: '1', bytes: 256 * 1024 }), name: 'swallowFullThenReturn' },
      cmd('ht-3', { k: 'ht3', v: '1' }),
    ];
    const [before, offender, after] = args.map((a) => gc.submit(a));
    gc.flush();
    const e1 = await rejection(before);
    assert.equal(e1.code, 'unknown_commit');
    assert.notEqual(e1.details.reconcilable, false, 'its receipt was in the same transaction');
    const e2 = await rejection(offender);
    assert.equal(e2.code, 'unknown_commit');
    assert.equal(e2.details.operation, 'handler_transaction');
    assert.equal(e2.details.reconcilable, false);
    assert.equal(gc.getMetrics().buffered, 1, 'the member after it never ran and was re-buffered');
    assert.equal(gc.getMetrics().counters.requeued, 1);
    await host.command('unlimitPages', {});
    clock.advance(25);
    assert.equal((await after).replayed, false);
    assert.deepEqual(await resolveUnknown(host, args[0]), { outcome: 'not_committed' });
  });

  it('a failed worker SAVEPOINT aborts the batch: nothing durable, every member not_committed', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    await host.command('armSavepointFault', { commandId: 'sf-2' });
    const promises = ['sf-1', 'sf-2', 'sf-3'].map((id) => gc.submit(cmd(id, { k: id, v: '1' })));
    await gc.flush();
    for (const p of promises) {
      const err = await rejection(p);
      assert.equal(err.details.commitState, 'not_committed');
      assert.notEqual(err.code, 'unknown_commit');
    }
    assert.equal(await host.query('receiptCount', {}), 0);
    assert.equal(await host.query('get', { k: 'sf-1' }), null);
  });

  it('a COMMIT that fails with the transaction still open is not_committed and re-buffered, then commits', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const marker = path.join(root, 'commit-busy');
    const promises = [
      gc.submit(cmd('cb-1', { k: 'cb1', v: '1' })),
      gc.submit({ ...cmd('cb-2', { k: 'cb2', v: '1', marker, mode: 'busy' }), name: 'putCommitFault' }),
    ];
    gc.flush();
    await until(() => gc.getMetrics().counters.requeued === 2);
    assert.equal(gc.getMetrics().buffered, 2);
    assert.equal(await host.query('receiptCount', {}), 0, 'rolled back');
    clock.advance(25);
    assert.deepEqual((await Promise.all(promises)).map((r) => r.replayed), [false, false]);
    assert.equal(await applied(host, 'cb1'), 1);
    assert.equal(host.getMetrics().counters.workerLost, 0, 'no recycle for a COMMIT that never ran');
  });

  it('a BEGIN that fails on a held write lock is re-buffered, then commits', async () => {
    const host = await startHost({ busyTimeoutMs: 20 });
    const clock = fakeClock();
    const gc = committer(host, clock);
    const other = new DatabaseSync(path.join(root, DEFAULT_STORAGE_DB_FILENAME), { timeout: 0 });
    try {
      other.exec('BEGIN IMMEDIATE');
      const promises = [gc.submit(cmd('bg-1', { k: 'bg1', v: '1' })), gc.submit(cmd('bg-2', { k: 'bg2', v: '1' }))];
      gc.flush();
      await until(() => gc.getMetrics().counters.requeued === 2);
      other.exec('ROLLBACK');
      clock.advance(25);
      assert.deepEqual((await Promise.all(promises)).map((r) => r.replayed), [false, false]);
    } finally {
      other.close();
    }
  });
});

describe('group commit malformed replies and rejections', () => {
  /** @type {Array<[string, (ids: string[]) => unknown]>} */
  const replies = [
    ['wrong member count', () => ({ committed: true, error: null, members: [] })],
    ['committed entry without error', (ids) => ({ committed: true, error: null, members: ids.map(() => ({ ok: false })) })],
    ['committed entry without result', (ids) => ({ committed: true, error: null, members: ids.map(() => ({ ok: true })) })],
    ['committed entry with unparsable result', (ids) => ({ committed: true, error: null, members: ids.map(() => ({ ok: true, resultJson: '{' })) })],
    ['missing committed flag', (ids) => ({ members: ids.map(() => ({ ok: true, resultJson: '{}' })) })],
  ];
  for (const [label, reply] of replies) {
    it(`treats a ${label} as unknown_commit`, async () => {
      const clock = fakeClock();
      const host = { commandBatch: (/** @type {any[]} */ members) => Promise.resolve(reply(members.map((m) => m.commandId))) };
      const gc = committer(host, clock);
      const p = gc.submit(cmd('mr-1', { k: 'mr1', v: '1' }));
      await gc.flush();
      const err = await rejection(p);
      assert.equal(err.code, 'unknown_commit');
      assert.equal(err.details.commitState, 'unknown');
      assert.equal(err.details.commandId, 'mr-1');
    });
  }

  it('a malformed entry of a rolled-back batch stays not_committed', async () => {
    const clock = fakeClock();
    const error = new StorageError('io', 'x', { retryable: false, details: { commitState: 'not_committed' } }).toJSON();
    const host = { commandBatch: () => Promise.resolve({ committed: false, error, members: [{ garbage: true }] }) };
    const gc = committer(host, clock);
    const p = gc.submit(cmd('mr-2', { k: 'mr2', v: '1' }));
    await gc.flush();
    assert.equal((await rejection(p)).details.commitState, 'not_committed');
  });

  it('settles every member when the rejection is error-shaped without details or throws while read', async () => {
    const clock = fakeClock();
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const hostile = Object.defineProperty({ name: 'StorageError', code: 'busy' }, 'details', {
        get() {
          throw new Error('hostile getter');
        },
      });
      for (const reason of [{ name: 'StorageError', code: 'busy' }, hostile, 'not an error']) {
        const gc = committer({ commandBatch: () => Promise.reject(reason) }, clock);
        const promises = [gc.submit(cmd('h-1', { k: 'h1', v: '1' })), gc.submit(cmd('h-2', { k: 'h2', v: '1' }))];
        await gc.flush();
        for (const p of promises) assert.equal((await rejection(p)).code, 'unknown_commit');
        assert.equal(gc.getMetrics().heldCount, 0);
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not raise unhandledRejection when a dropped submit fails after the host expired its batch', async () => {
    const host = await startHost();
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const gc = createGroupCommitter({ host, windowMs: 1, deadlineMs: 30, maxFlushAttempts: 1 });
      const blocker = host.command('spin', { ms: 300 });
      void gc.submit(cmd('drop-1', { k: 'drop1', v: '1' }));
      await blocker;
      await gc.flush();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(unhandled, []);
      assert.equal(host.getMetrics().counters.expired, 1);
      await gc.close();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('uses a monotonic default clock (a frozen Date.now still flushes on the window)', async () => {
    /** @type {string[][]} */
    const seen = [];
    const host = { writeGate: WRITE_GATE_TEST_EXEMPTION, commandBatch: (/** @type {any[]} */ members) => (seen.push(members.map((m) => m.commandId)), new Promise(() => {})) };
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      const gc = createGroupCommitter({ host, windowMs: 10 });
      quiet(gc.submit(cmd('mc-1', { k: 'mc1', v: '1' })));
      await until(() => seen.length === 1, 1000);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('group commit backpressure and close', () => {
  it('refuses with busy when the buffer is full and with payload_too_large for an oversized member', async () => {
    const clock = fakeClock();
    const idle = { writeGate: WRITE_GATE_TEST_EXEMPTION, commandBatch: () => new Promise(() => {}) };
    const gc = committer(idle, clock, { maxBufferedCount: 2, maxMemberBytes: 512, maxBufferedBytes: 4096 });
    gc.submit(cmd('b-1', { k: 'b1', v: '1' }));
    gc.submit(cmd('b-2', { k: 'b2', v: '1' }));
    const busy = await rejection(gc.submit(cmd('b-3', { k: 'b3', v: '1' })));
    assert.equal(busy.code, 'busy');
    assert.equal(busy.retryable, true);
    assert.equal(busy.details.operation, 'group_buffer');
    assert.equal(busy.details.commitState, 'not_committed');
    assert.equal(busy.details.commandId, 'b-3');
    const big = await rejection(gc.submit(cmd('b-4', { k: 'b4', v: 'x'.repeat(600) })));
    assert.equal(big.details.operation, 'payload_too_large');
    assert.equal(big.retryable, false);
    // In-flight members still count against the bound.
    clock.advance(40);
    assert.equal(gc.getMetrics().inFlight, 2);
    assert.equal((await rejection(gc.submit(cmd('b-5', { k: 'b5', v: '1' })))).code, 'busy');
    const probe = committer(idle, clock);
    probe.submit(cmd('bb-0', { k: 'bb0', v: 'y'.repeat(100) }));
    const entry = probe.getMetrics().bufferedBytes;
    const bytes = createGroupCommitter({ host: idle, maxBufferedBytes: entry + 10, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    bytes.submit(cmd('bb-1', { k: 'bb1', v: 'y'.repeat(100) }));
    assert.equal((await rejection(bytes.submit(cmd('bb-2', { k: 'bb2', v: 'y'.repeat(100) })))).details.operation, 'group_buffer');
  });

  it('close() flushes buffered members, then refuses new ones', async () => {
    const host = await startHost();
    const clock = fakeClock();
    const gc = committer(host, clock);
    const promises = [gc.submit(cmd('cl-1', { k: 'cl1', v: '1' })), gc.submit(cmd('cl-2', { k: 'cl2', v: '1' }))];
    assert.equal(gc.getMetrics().counters.batches, 0);
    await gc.close();
    assert.deepEqual((await Promise.all(promises)).map((r) => r.replayed), [false, false]);
    const after = await rejection(gc.submit(cmd('cl-3', { k: 'cl3', v: '1' })));
    assert.equal(after.details.operation, 'shutdown');
    assert.equal(after.details.commitState, 'not_committed');
    assert.equal(gc.getMetrics().state, 'closed');
  });

  it('close() rejects undispatched members deterministically after its timeout', async () => {
    const clock = fakeClock();
    const stuck = { commandBatch: () => new Promise(() => {}) };
    const gc = committer(stuck, clock);
    const inFlight = gc.submit(cmd('t-1', { k: 't1', v: '1' }, { priority: 'stop' }));
    const queued = gc.submit(cmd('t-2', { k: 't2', v: '1' }));
    const closing = gc.close({ timeoutMs: 100 });
    assert.equal(closing, gc.close(), 'concurrent close calls share one shutdown');
    clock.advance(100);
    await closing;
    const err = await rejection(queued);
    assert.equal(err.details.operation, 'shutdown');
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(err.details.commandId, 't-2');
    let settled = false;
    inFlight.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the in-flight batch settles only with its real outcome');
  });

  it('close() during a retry backoff dispatches at once', async () => {
    const host = await startHost();
    const clock = fakeClock();
    let calls = 0;
    const flaky = {
      /**
       * @param {any[]} members
       * @param {any} opts
       */
      commandBatch(members, opts) {
        calls += 1;
        if (calls === 1) return Promise.reject(new StorageError('busy', 'Storage is busy', { details: { commitState: 'not_committed' } }));
        return host.commandBatch(members, opts);
      },
    };
    const gc = committer(flaky, clock, { retryDelayMs: 1000 });
    const p = gc.submit(cmd('cb-close', { k: 'cbclose', v: '1' }));
    clock.advance(40);
    await until(() => gc.getMetrics().counters.requeued === 1);
    await gc.close();
    assert.equal(calls, 2, 'no clock advance: the backoff is skipped while closing');
    assert.equal((await p).replayed, false);
  });

  it('does not retry a retryable failure while closing', async () => {
    const clock = fakeClock();
    let calls = 0;
    const down = {
      commandBatch() {
        calls += 1;
        return Promise.reject(new StorageError('busy', 'Storage is busy', { details: { commitState: 'not_committed' } }));
      },
    };
    const gc = committer(down, clock);
    const p = gc.submit(cmd('d-1', { k: 'd1', v: '1' }));
    await gc.close();
    assert.equal((await rejection(p)).code, 'busy');
    assert.equal(calls, 1);
  });
});

describe('host batch request validation', () => {
  it('refuses malformed batches before anything is queued', async () => {
    const host = await startHost();
    assert.equal((await rejection(host.commandBatch([]))).details.operation, 'invalid_request');
    assert.equal((await rejection(host.commandBatch([{ name: 'bad name', commandId: 'a', payloadJson: '{}' }]))).code, 'io');
    assert.equal((await rejection(host.commandBatch([{ name: 'put', commandId: 'a', payloadJson: '{}' }], { commandId: 'x' }))).details.operation, 'invalid_request');
    assert.equal((await rejection(host.command('batch', {}, {}))).code, 'io', 'the batch kind is not reachable through command()');
    // A member snapshot is spliced verbatim: anything but one JSON object is refused.
    const injected = '{}}]},{"members":[{"name":"put","commandId":"evil","payload":{}';
    for (const payloadJson of [injected, '{}]}', '[1]', 'null', '1', '']) {
      const err = await rejection(host.commandBatch([{ name: 'put', commandId: 'a', payloadJson }]));
      assert.equal(err.details.operation, 'invalid_request', payloadJson);
    }
  });
});
