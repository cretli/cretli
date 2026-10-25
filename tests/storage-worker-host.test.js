import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { StorageError } from '../lib/storage/errors.js';
import { CHECKPOINT_BLOCKED_BY_READER, DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { CORE_MIGRATIONS } from '../lib/storage/migrations.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-handlers.js', import.meta.url));
const ASYNC_HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-async-handlers.js', import.meta.url));
const FLAKY_HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-flaky-handlers.js', import.meta.url));
const REAL_WORKER_URL = new URL('../lib/storage/sqlite-worker.js', import.meta.url);

/** A1 gates (docs/storage-gates.md). */
/** Event-loop check is relative: share of burst time and factor over an idle baseline. */
const EVENT_LOOP_MAX_SHARE = 0.25;
const EVENT_LOOP_P99_SHARE = 0.05;
const EVENT_LOOP_BASELINE_FACTOR = 10;
const EVENT_LOOP_BASELINE_TICKS = 200;
const EVENT_LOOP_BASELINE_SLEEP_MS = 50;
const GATE_QUEUE_AGE_P95_MS = 200;
const GATE_QUEUE_BURST_MAX_MS = 2000;
/** A1 burst probe size (CRETLI_BASELINE_BURST_N default). */
const A1_BURST_N = 200;
/** Literal A1 gate numbers depend on the disk (fsync); measured only on request. */
const MEASURE_GATES = process.env.STORAGE_GATE === '1';
/** Host scheduling overhead allowed per request on top of worker execute time. */
const PER_REQUEST_OVERHEAD_MS = 2;

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-worker-'));
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
  const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, ...extra });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
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
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) assert.fail('condition not reached in time');
    await sleep(5);
  }
}

/**
 * @param {string} code
 * @param {string} operation
 * @returns {(err: any) => boolean}
 */
function storageError(code, operation) {
  return (err) => {
    assert.ok(err instanceof StorageError, `expected StorageError, got ${err}`);
    assert.equal(err.code, code);
    assert.equal(err.details.operation, operation);
    assert.equal(err.details.commitState, 'not_committed');
    return true;
  };
}

describe('storage worker host roundtrip', () => {
  it('runs commands, queries and control ops in the worker', async () => {
    const host = await startHost();
    assert.deepEqual(await host.command('put', { k: 'a', v: 'one' }, { commandId: 'cmd-1' }), { k: 'a', commandId: 'cmd-1' });
    assert.equal(await host.query('get', { k: 'a' }), 'one');
    assert.equal(await host.query('get', { k: 'missing' }), null);
    assert.equal(await host.query('count', {}), 1);
    assert.deepEqual(await host.control('ping'), { schemaVersion: CORE_MIGRATIONS.length });
    const checkpoint = await host.control('checkpoint');
    assert.equal(typeof checkpoint.log, 'number');
    const metrics = host.getMetrics();
    assert.equal(metrics.state, 'ready');
    const phases = metrics.lastStart;
    for (const key of ['spawnToReadyMs', 'registryMs', 'openMs', 'barrierMs', 'threadOverheadMs']) {
      assert.ok(Number.isFinite(phases[key]) && phases[key] >= 0, key);
    }
    assert.ok(phases.spawnToReadyMs >= phases.openMs + phases.barrierMs);
    assert.equal(metrics.counters.completed, 7);
    assert.equal(metrics.queue.depth, 0);
    assert.doesNotMatch(JSON.stringify(metrics), /one|cmd-1|put|test_kv|cretli-storage-worker/);
  });

  it('serializes typed errors across postMessage with explicit commit state', async () => {
    const host = await startHost();
    await host.command('put', { k: 'dup', v: 'x' });

    const conflict = await rejection(host.command('put', { k: 'dup', v: 'y' }, { commandId: 'cmd-dup' }));
    assert.ok(conflict instanceof StorageError);
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.retryable, false);
    assert.equal(conflict.details.constraintKind, 'primary_key');
    assert.equal(conflict.details.sqliteCode, 1555);
    assert.equal(conflict.details.commitState, 'not_committed');
    assert.equal(conflict.details.commandId, 'cmd-dup', 'worker-side errors keep the commandId');

    const check = await rejection(host.command('put', { k: 'empty', v: '' }));
    assert.equal(check.code, 'conflict');
    assert.equal(check.details.constraintKind, 'check');

    const thrown = await rejection(host.command('putThenThrow', { k: 'rolled', v: 'x' }, { commandId: 'cmd-throw' }));
    assert.equal(thrown.code, 'io');
    assert.equal(thrown.details.commitState, 'not_committed');
    assert.equal(thrown.details.commandId, 'cmd-throw');
    assert.doesNotMatch(JSON.stringify(thrown), /secret/);
    assert.equal(await host.query('get', { k: 'rolled' }), null, 'failed command must roll back');

    const readOnly = await rejection(host.query('tryWrite', {}));
    assert.equal(readOnly.details.commitState, 'not_committed');
    assert.equal(await host.query('get', { k: 'query-write' }), null, 'query must not write');

    const thenable = await rejection(host.command('returnsThenable', {}));
    assert.equal(thenable.details.operation, 'handler_async');
    assert.equal(thenable.details.commitState, 'not_committed');

    const unclonable = await rejection(host.command('unclonable', {}));
    assert.equal(unclonable.details.operation, 'result_invalid');
    assert.equal(unclonable.details.commitState, 'not_committed');

    // The guarded handler context refuses transaction control, so a handler
    // cannot end the request transaction: the refusal rolls it back.
    const selfCommit = await rejection(host.command('commitItself', {}, { commandId: 'cmd-self' }));
    assert.equal(selfCommit.code, 'io');
    assert.equal(selfCommit.retryable, false);
    assert.equal(selfCommit.details.operation, 'transaction_control');
    assert.equal(selfCommit.details.commitState, 'not_committed');
    assert.equal(selfCommit.details.commandId, 'cmd-self');

    const commitThenThrow = await rejection(host.command('putCommitThenThrow', { k: 'self-committed', v: 'x' }));
    assert.equal(commitThenThrow.details.operation, 'transaction_control');
    assert.equal(commitThenThrow.details.commitState, 'not_committed');
    assert.equal(await host.query('get', { k: 'self-committed' }), null, 'the refused COMMIT rolled the row back');

    const unknown = await rejection(host.command('notRegistered', {}));
    assert.equal(unknown.details.operation, 'unknown_handler');
    assert.equal(await host.query('count', {}), 1);
  });

  it('rejects invalid requests before queueing with typed errors', async () => {
    const host = await startHost();
    const circular = { k: 'c' };
    circular.self = circular;
    await assert.rejects(host.command('put', { k: 'a', v: 1n }), storageError('io', 'payload_invalid'));
    await assert.rejects(host.command('put', circular), storageError('io', 'payload_invalid'));
    await assert.rejects(host.command('put', { k: 'a', v: new Map() }), storageError('io', 'payload_invalid'));
    await assert.rejects(host.command('put', { k: 'a', v: () => 1 }), storageError('io', 'payload_invalid'));
    await assert.rejects(host.command('put', {}, { priority: 'urgent' }), storageError('io', 'invalid_request'));
    await assert.rejects(host.command('', {}), storageError('io', 'invalid_request'));
    // Handler names are checked on the host too, so SQL never reaches the worker.
    await assert.rejects(host.command('DROP TABLE test_kv', {}), storageError('io', 'invalid_request'));
    await assert.rejects(host.control('vacuum'), storageError('io', 'invalid_request'));
    await assert.rejects(host.command('put', {}, { commandId: 'a/b' }), storageError('io', 'invalid_request'));
    await assert.rejects(host.command('put', {}, { commandId: 'x'.repeat(129) }), storageError('io', 'invalid_request'));
    await assert.rejects(host.command('put', {}, { commandId: 42 }), storageError('io', 'invalid_request'));
    assert.equal(host.getMetrics().queue.counters.enqueued, 1);
    assert.equal(host.getMetrics().counters.rejectedInvalid, 11);
  });

  it('refuses a non-AbortSignal option without leaving a queued request behind', async () => {
    const host = await startHost();
    const err = await rejection(host.command('put', { k: 'bad-signal', v: 'x' }, { signal: { aborted: false } }));
    assert.ok(err instanceof StorageError);
    assert.equal(err.details.operation, 'invalid_request');
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(host.getMetrics().queue.depth, 0);
    await host.control('ping');
    assert.equal(await host.query('get', { k: 'bad-signal' }), null, 'refused request must never commit');
  });

  it('commits the payload snapshot taken at enqueue, not later caller mutations', async () => {
    const host = await startHost();
    const blocker = host.command('spin', { ms: 100 });
    const payload = { k: 'snap', v: 'original', nested: { list: [1, 2] } };
    const echoed = host.command('echo', payload);
    const written = host.command('put', payload);
    payload.v = 'mutated';
    payload.nested.list.push(3);
    payload.extra = 'added';
    await blocker;
    assert.deepEqual(await echoed, { k: 'snap', v: 'original', nested: { list: [1, 2] } });
    await written;
    assert.equal(await host.query('get', { k: 'snap' }), 'original');
  });
});

describe('storage worker host failures', () => {
  it('rejects an in-flight write as unknown_commit when the worker dies and restarts', async () => {
    const host = await startHost({ restartBackoffMs: { initial: 10, max: 100 } });
    const crashing = host.command('putThenExit', { k: 'crash', v: 'x' }, { commandId: 'cmd-crash' });
    // Queued behind the crash: never dispatched to the dead worker.
    const queuedWrite = host.command('put', { k: 'after', v: 'x' });
    const queuedRead = host.query('count', {});
    const err = await rejection(crashing);
    assert.ok(err instanceof StorageError);
    assert.equal(err.code, 'unknown_commit');
    assert.equal(err.retryable, false);
    assert.deepEqual(err.details, { operation: 'worker_lost', commitState: 'unknown', commandId: 'cmd-crash' });
    assert.deepEqual(await queuedWrite, { k: 'after', commandId: null });
    assert.equal(await queuedRead, 1);
    assert.equal(await host.query('get', { k: 'crash' }), null, 'uncommitted crash write must not be visible');
    const metrics = host.getMetrics();
    assert.equal(metrics.restarts, 1);
    assert.equal(metrics.counters.workerLost, 1);
    assert.equal(metrics.counters.unknownCommit, 1);
    assert.equal(metrics.state, 'ready');
  });

  it('reports unknown_commit when the worker dies after COMMIT, and the row is durable', async () => {
    const host = await startHost({ faultInjection: true, restartBackoffMs: { initial: 10, max: 100 } });
    const err = await rejection(host.command('putCommitThenExit', { k: 'durable', v: 'x' }, { commandId: 'cmd-after-commit' }));
    assert.equal(err.code, 'unknown_commit');
    assert.deepEqual(err.details, { operation: 'worker_lost', commitState: 'unknown', commandId: 'cmd-after-commit' });
    assert.equal(await host.query('get', { k: 'durable' }), 'x', 'committed row must survive the crash');
    assert.equal(host.getMetrics().restarts, 1);
  });

  it('ignores the fault-injection hook unless the host enables it', async () => {
    const host = await startHost();
    assert.deepEqual(await host.command('putCommitThenExit', { k: 'no-hook', v: 'x' }), { k: 'no-hook' });
    assert.equal(host.getMetrics().restarts, 0);
  });

  it('classifies write-lock contention as retryable busy, not committed', async () => {
    const host = await startHost({ busyTimeoutMs: 50 });
    const other = new DatabaseSync(path.join(root, DEFAULT_STORAGE_DB_FILENAME), { timeout: 0 });
    try {
      other.exec('BEGIN IMMEDIATE');
      const err = await rejection(host.command('put', { k: 'locked', v: 'x' }, { commandId: 'cmd-locked' }));
      assert.equal(err.code, 'busy');
      assert.equal(err.retryable, true);
      assert.equal(err.details.commitState, 'not_committed');
      assert.equal(err.details.commandId, 'cmd-locked');
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
    await host.command('put', { k: 'locked', v: 'x' });
    assert.equal(await host.query('get', { k: 'locked' }), 'x');
  });

  it('rolls back a command whose result exceeds maxResultBytes', async () => {
    const host = await startHost({ maxResultBytes: 1024 });
    const err = await rejection(host.command('putBigResult', { k: 'big-result', v: 'x', bytes: 4096 }));
    assert.equal(err.code, 'io');
    assert.equal(err.retryable, false);
    assert.equal(err.details.operation, 'result_too_large');
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(await host.query('get', { k: 'big-result' }), null);
    assert.equal((await host.command('bigResult', { bytes: 100 })).length, 100);
  });

  it('refuses an async handler when the registry loads', async () => {
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: ASYNC_HANDLERS_PATH });
    hosts.push(host);
    const err = await rejection(host.start());
    assert.ok(err instanceof StorageError);
    assert.equal(err.retryable, false);
    assert.equal(host.getMetrics().state, 'failed');
  });

  it('terminates a handler that exceeds maxExecutionMs and keeps serving', async () => {
    const host = await startHost({ maxExecutionMs: 200, restartBackoffMs: { initial: 10, max: 100 } });
    const err = await rejection(host.command('spin', { ms: 5000 }));
    assert.equal(err.code, 'unknown_commit');
    assert.equal(err.details.operation, 'worker_lost');
    await host.command('put', { k: 'alive', v: 'x' });
    assert.equal(await host.query('get', { k: 'alive' }), 'x');
  });

  it('fails start permanently on a corrupt store and rejects later requests', async () => {
    fs.writeFileSync(path.join(root, 'cretli-store.sqlite'), Buffer.alloc(8192, 0x5a));
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH });
    hosts.push(host);
    const pendingBeforeReady = host.command('put', { k: 'a', v: 'x' });
    const err = await rejection(host.start());
    assert.equal(err.code, 'corrupt');
    const queuedErr = await rejection(pendingBeforeReady);
    assert.equal(queuedErr.code, 'corrupt');
    assert.equal(queuedErr.details.commitState, 'not_committed');
    const later = await rejection(host.command('put', { k: 'b', v: 'x' }));
    assert.equal(later.code, 'corrupt');
    assert.equal(host.getMetrics().state, 'failed');
  });

  it('fails start when the handler module cannot be loaded', async () => {
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: path.join(root, 'missing-handlers.js') });
    hosts.push(host);
    const err = await rejection(host.start());
    assert.ok(err instanceof StorageError);
    assert.equal(host.getMetrics().state, 'failed');
  });

  it('rejects a relative handlersPath or dbDir synchronously', () => {
    assert.throws(() => createStorageWorkerHost({ dbDir: root, handlersPath: 'tests/fixtures/storage-worker-handlers.js' }), TypeError);
    assert.throws(() => createStorageWorkerHost({ dbDir: 'data', handlersPath: HANDLERS_PATH }), TypeError);
  });

  it('retries a retryable start failure and then serves', async () => {
    fs.writeFileSync(path.join(root, 'flaky.json'), JSON.stringify({ failTimes: 2, loads: 0 }));
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: FLAKY_HANDLERS_PATH, restartBackoffMs: { initial: 10, max: 50 } });
    hosts.push(host);
    const queued = host.command('setup', {});
    await host.start();
    await queued;
    assert.equal(host.getMetrics().restarts, 2);
    assert.equal(host.getMetrics().startAttempts, 0);
  });

  it('fails after maxStartAttempts retryable start failures', async () => {
    fs.writeFileSync(path.join(root, 'flaky.json'), JSON.stringify({ failTimes: 100, loads: 0 }));
    const host = createStorageWorkerHost({
      dbDir: root,
      handlersPath: FLAKY_HANDLERS_PATH,
      maxStartAttempts: 3,
      restartBackoffMs: { initial: 10, max: 50 },
    });
    hosts.push(host);
    const queued = rejection(host.command('setup', {}, { commandId: 'cmd-flaky' }));
    const err = await rejection(host.start());
    assert.equal(err.code, 'io');
    assert.equal(err.retryable, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'flaky.json'), 'utf8')).loads, 3);
    const queuedErr = await queued;
    assert.equal(queuedErr.details.commitState, 'not_committed');
    assert.equal(queuedErr.details.commandId, 'cmd-flaky');
    assert.equal(host.getMetrics().state, 'failed');
  });

  it('rejects start() with a typed error when the worker cannot be spawned', async () => {
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, workerUrl: new URL('https://example.com/worker.js') });
    hosts.push(host);
    const queued = rejection(host.command('setup', {}));
    const err = await rejection(host.start());
    assert.ok(err instanceof StorageError);
    assert.equal(err.details.operation, 'worker_spawn');
    assert.equal((await queued).details.operation, 'worker_spawn');
    assert.equal(host.getMetrics().state, 'failed');
  });

  it('treats a spawn failure during restart as a failed start with backoff', async () => {
    let spawns = 0;
    const host = await startHost({
      maxStartAttempts: 2,
      restartBackoffMs: { initial: 10, max: 50 },
      workerUrl: () => {
        spawns += 1;
        return spawns === 1 ? REAL_WORKER_URL : new URL('https://example.com/worker.js');
      },
    });
    const crash = rejection(host.command('putThenExit', { k: 'c', v: 'x' }));
    const queued = rejection(host.command('put', { k: 'q', v: 'x' }));
    assert.equal((await crash).code, 'unknown_commit');
    const queuedErr = await queued;
    assert.equal(queuedErr.details.operation, 'worker_spawn');
    assert.equal(queuedErr.details.commitState, 'not_committed');
    assert.equal(host.getMetrics().state, 'failed');
    assert.equal(spawns, 3);
  });

  it('fails the host on a crash loop instead of restarting forever', async () => {
    const host = await startHost({ maxWorkerLosses: 2, restartBackoffMs: { initial: 10, max: 50 } });
    assert.equal((await rejection(host.command('putThenExit', { k: 'l1', v: 'x' }))).code, 'unknown_commit');
    await host.control('ping');
    assert.equal((await rejection(host.command('putThenExit', { k: 'l2', v: 'x' }))).code, 'unknown_commit');
    await waitFor(() => host.getMetrics().state === 'failed');
    const later = await rejection(host.command('put', { k: 'after-loop', v: 'x' }, { commandId: 'cmd-loop' }));
    assert.equal(later.details.operation, 'worker_crash_loop');
    assert.equal(later.details.commitState, 'not_committed');
    assert.equal(later.details.commandId, 'cmd-loop');
    assert.equal(host.getMetrics().restarts, 1);
  });

  it('keeps serving after a failed dispatch', async () => {
    const host = await startHost();
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function patched(message, ...rest) {
      if (message?.commandId === 'cmd-dispatch-fail') throw new Error('DataCloneError: simulated');
      return original.call(this, message, ...rest);
    };
    try {
      const blocker = host.command('spin', { ms: 50 });
      const failing = rejection(host.command('put', { k: 'f', v: 'x' }, { commandId: 'cmd-dispatch-fail' }));
      const next = host.command('put', { k: 'after-fail', v: 'x' });
      await blocker;
      const err = await failing;
      assert.equal(err.details.operation, 'dispatch');
      assert.equal(err.details.commitState, 'not_committed');
      assert.deepEqual(await next, { k: 'after-fail', commandId: null });
    } finally {
      Worker.prototype.postMessage = original;
    }
    assert.equal(host.getMetrics().counters.dispatchFailed, 1);
  });
});

describe('storage worker host queue control', () => {
  it('returns busy immediately on queue overflow instead of growing', async () => {
    const host = await startHost({ maxQueueDepth: 10 });
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => host.command('put', { k: `k${i}`, v: 'x' })),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // One dispatched at once plus a full queue of ten.
    assert.equal(fulfilled.length, 11);
    for (const r of rejected) {
      assert.equal(r.reason.code, 'busy');
      assert.equal(r.reason.retryable, true);
      assert.equal(r.reason.details.commitState, 'not_committed');
    }
    assert.equal(await host.query('count', {}), 11);
    assert.equal(host.getMetrics().counters.rejectedBusy, 39);
  });

  it('enforces the payload byte budget with retryable busy', async () => {
    const host = await startHost({ maxQueueBytes: 1024 });
    const blocker = host.command('spin', { ms: 100 });
    const first = host.command('put', { k: 'a', v: 'x'.repeat(600) });
    const second = await rejection(host.command('put', { k: 'b', v: 'x'.repeat(600) }));
    assert.equal(second.code, 'busy');
    assert.equal(second.retryable, true);
    assert.equal(second.details.operation, 'queue_bytes');
    await blocker;
    await first;
  });

  it('refuses a payload that can never fit with a non-retryable error, even on an empty queue', async () => {
    const host = await startHost({ maxQueueBytes: 1024 });
    const big = await rejection(host.command('put', { k: 'big', v: 'x'.repeat(2000) }, { commandId: 'cmd-big' }));
    assert.equal(big.code, 'io');
    assert.equal(big.retryable, false);
    assert.deepEqual(big.details, { operation: 'payload_too_large', commitState: 'not_committed', commandId: 'cmd-big' });
    const capped = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, maxRequestBytes: 100 });
    hosts.push(capped);
    await assert.rejects(capped.command('put', { k: 'x', v: 'x'.repeat(200) }), storageError('io', 'payload_too_large'));
  });

  it('cancels queued requests by AbortSignal and deadline before dispatch', async () => {
    const host = await startHost();
    const blocker = host.command('spin', { ms: 300 });
    const controller = new AbortController();
    const aborted = host.command('put', { k: 'aborted', v: 'x' }, { signal: controller.signal });
    const expired = host.command('put', { k: 'expired', v: 'x' }, { deadlineMs: 50 });
    const preAborted = AbortSignal.abort();
    await assert.rejects(host.command('put', { k: 'pre', v: 'x' }, { signal: preAborted }), (e) => e === preAborted.reason);
    await sleep(10);
    controller.abort();
    const abortErr = await rejection(aborted);
    assert.equal(abortErr, controller.signal.reason);
    const deadlineErr = await rejection(expired);
    assert.equal(deadlineErr.code, 'busy');
    assert.equal(deadlineErr.details.operation, 'deadline');
    assert.equal(deadlineErr.details.commitState, 'not_committed');
    await blocker;
    assert.equal(await host.query('get', { k: 'aborted' }), null);
    assert.equal(await host.query('get', { k: 'expired' }), null);
    const counters = host.getMetrics().counters;
    assert.equal(counters.aborted, 1);
    assert.equal(counters.expired, 1);
  });

  it('does not raise unhandledRejection when a dropped request expires in the queue', async () => {
    const host = await startHost();
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const blocker = host.command('spin', { ms: 300 });
      // Fire-and-forget callers: nobody holds or awaits these promises.
      void host.command('put', { k: 'dropped-command', v: 'x' }, { deadlineMs: 50 });
      void host.query('get', { k: 'dropped-query' }, { deadlineMs: 50 });
      await blocker;
      await sleep(50);
      assert.deepEqual(unhandled, []);
      assert.equal(host.getMetrics().counters.expired, 2);
      assert.equal(await host.query('get', { k: 'dropped-command' }), null);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not cancel a request that is already in flight', async () => {
    const host = await startHost();
    const controller = new AbortController();
    const running = host.command('spin', { ms: 150 }, { signal: controller.signal });
    await sleep(30);
    controller.abort();
    assert.deepEqual(await running, { spun: 150 });
    assert.equal(host.getMetrics().counters.aborted, 0);
  });

  it('drains queued work on graceful shutdown and refuses new requests', async () => {
    const host = await startHost();
    const writes = Array.from({ length: 20 }, (_, i) => host.command('put', { k: `d${i}`, v: 'x' }));
    const closing = host.close({ timeoutMs: 5000 });
    const refused = await rejection(host.command('put', { k: 'late', v: 'x' }));
    assert.equal(refused.details.operation, 'shutdown');
    assert.equal(refused.details.commitState, 'not_committed');
    await closing;
    assert.equal((await Promise.allSettled(writes)).filter((r) => r.status === 'fulfilled').length, 20);
    assert.equal(host.getMetrics().state, 'closed');
    assert.equal(host.getMetrics().counters.workerLost, 0);
    const reopened = await startHost();
    assert.equal(await reopened.query('count', {}), 20);
  });

  it('shares one shutdown between concurrent close() calls', async () => {
    const host = await startHost();
    const writes = Array.from({ length: 5 }, (_, i) => host.command('put', { k: `c${i}`, v: 'x' }));
    const first = host.close({ timeoutMs: 2000 });
    const second = host.close({ timeoutMs: 2000 });
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal((await Promise.allSettled(writes)).filter((r) => r.status === 'fulfilled').length, 5);
    assert.equal(host.getMetrics().state, 'closed');
    await assert.rejects(host.start(), storageError('io', 'shutdown'));
  });

  it('rejects queued requests at once when closing a never-started host', async () => {
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH });
    hosts.push(host);
    const queued = rejection(host.command('put', { k: 'never', v: 'x' }));
    const started = Date.now();
    await host.close({ timeoutMs: 5000 });
    assert.ok(Date.now() - started < 1000, 'close waited for a worker that never comes');
    const err = await queued;
    assert.equal(err.details.operation, 'shutdown');
    assert.equal(err.details.commitState, 'not_committed');
  });

  it('closes cleanly while a restart is pending', async () => {
    const host = await startHost({ restartBackoffMs: { initial: 300, max: 300 } });
    assert.equal((await rejection(host.command('putThenExit', { k: 'r', v: 'x' }))).code, 'unknown_commit');
    const queued = rejection(host.command('put', { k: 'during-restart', v: 'x' }));
    await waitFor(() => host.getMetrics().state === 'restarting');
    await host.close({ timeoutMs: 50 });
    const err = await queued;
    assert.equal(err.details.operation, 'shutdown');
    assert.equal(err.details.commitState, 'not_committed');
    assert.equal(host.getMetrics().state, 'closed');
    await sleep(350);
    assert.equal(host.getMetrics().restarts, 0, 'restart timer must not fire after close');
  });

  it('times out a stuck drain: queued not_committed, in-flight unknown_commit', async () => {
    const host = await startHost();
    const inFlight = rejection(host.command('spin', { ms: 3000 }));
    await sleep(20);
    const queued = rejection(host.command('put', { k: 'q', v: 'x' }));
    await host.close({ timeoutMs: 100 });
    const inFlightErr = await inFlight;
    assert.equal(inFlightErr.code, 'unknown_commit');
    const queuedErr = await queued;
    assert.equal(queuedErr.details.operation, 'shutdown');
    assert.equal(queuedErr.details.commitState, 'not_committed');
  });
});

describe('storage worker host A1 gates', () => {
  it('keeps the event loop responsive under a 2000-request burst (relative thresholds, no wall-clock budget)', async () => {
    const host = await startHost({ maxQueueDepth: 4096, maxQueueAgeMs: 60000 });
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    // Baseline: the same main-thread conditions (host started, worker idle) without the burst.
    histogram.enable();
    for (let i = 0; i < EVENT_LOOP_BASELINE_TICKS; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await sleep(EVENT_LOOP_BASELINE_SLEEP_MS);
    histogram.disable();
    const baselineP99 = histogram.percentile(99) / 1e6;
    const baselineMax = histogram.max / 1e6;
    histogram.reset();

    histogram.enable();
    const started = performance.now();
    // Mixed interactive burst: every tenth request is a FULL-durability write.
    const results = await Promise.allSettled(Array.from({ length: 2000 }, (_, i) => (i % 10 === 0
      ? host.command('put', { k: `b${i}`, v: 'x' }, { priority: i % 100 === 0 ? 'claim' : 'normal' })
      : host.query('get', { k: `b${i - (i % 10)}` }))));
    histogram.disable();
    const elapsedMs = performance.now() - started;
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0);
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    const age = host.getMetrics().queue.queueAgeMs;
    console.log(`[storage-worker gate] 2000 burst: elapsed=${elapsedMs.toFixed(0)}ms eventLoop p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms (resolution 1ms) baseline p99=${baselineP99.toFixed(2)}ms max=${baselineMax.toFixed(2)}ms queueAge p95=${age.p95.toFixed(1)}ms max=${age.max.toFixed(1)}ms`);
    // The main thread only posts messages; the writes run in the worker. A
    // single stall must stay a small share of the whole burst, and the tail
    // may exceed the idle baseline only by a bounded factor. Both scale with
    // the machine (disk fsync, CPU contention) instead of a fixed budget.
    assert.ok(max <= Math.max(elapsedMs * EVENT_LOOP_MAX_SHARE, baselineMax * EVENT_LOOP_BASELINE_FACTOR), `event loop max ${max} ms of ${elapsedMs} ms (baseline ${baselineMax} ms)`);
    assert.ok(p99 <= Math.max(elapsedMs * EVENT_LOOP_P99_SHARE, baselineP99 * EVENT_LOOP_BASELINE_FACTOR), `event loop p99 ${p99} ms of ${elapsedMs} ms (baseline ${baselineP99} ms)`);
  });

  it('adds only bounded host overhead to the worker time under a write burst (disk-independent)', async () => {
    // Expiry must not be what fails this test on a slow disk.
    const burst = await startHost({ maxQueueAgeMs: 120000 });
    const before = burst.getMetrics();
    await Promise.all(Array.from({ length: A1_BURST_N }, (_, i) => burst.command('put', { k: `x${i}`, v: 'x' })));
    const after = burst.getMetrics();
    assert.equal(after.queue.counters.dispatched - before.queue.counters.dispatched, A1_BURST_N);
    assert.equal(after.counters.completed - before.counters.completed, A1_BURST_N);
    const executeSum = after.executeMs.sum - before.executeMs.sum;
    // FIFO single worker: the last request waited for every earlier one. Its
    // queue age may exceed their execute time only by scheduling overhead.
    const bound = executeSum + A1_BURST_N * PER_REQUEST_OVERHEAD_MS + 50;
    console.log(`[storage-worker] burst(${A1_BURST_N} writes) queueAge max=${after.queue.queueAgeMs.max.toFixed(1)}ms executeSum=${executeSum.toFixed(1)}ms bound=${bound.toFixed(1)}ms requestMs p95=${after.requestMs.p95.toFixed(1)} p99=${after.requestMs.p99.toFixed(1)}`);
    assert.ok(after.queue.queueAgeMs.max <= bound, `queue age max ${after.queue.queueAgeMs.max} ms > ${bound} ms`);
  });

  it('measures the literal A1 queue-age gates (opt-in: STORAGE_GATE=1)', { skip: !MEASURE_GATES && 'disk-dependent; set STORAGE_GATE=1' }, async () => {
    const steady = await startHost();
    for (let i = 0; i < 100; i += 1) {
      steady.command('put', { k: `s${i}`, v: 'x' });
      await sleep(15);
    }
    await steady.query('count', {});
    const steadyAge = steady.getMetrics().queue.queueAgeMs;
    const steadyRequest = steady.getMetrics().requestMs;
    await steady.close();

    const burst = await startHost({ maxQueueAgeMs: 120000 });
    await Promise.all(Array.from({ length: A1_BURST_N }, (_, i) => burst.command('put', { k: `x${i}`, v: 'x' })));
    const burstAge = burst.getMetrics().queue.queueAgeMs;
    console.log(`[storage-worker gate] steady queueAge p95=${steadyAge.p95.toFixed(2)}ms max=${steadyAge.max.toFixed(2)}ms wait+execute p95=${steadyRequest.p95.toFixed(2)}ms p99=${steadyRequest.p99.toFixed(2)}ms; burst(${A1_BURST_N} writes) queueAge p95=${burstAge.p95.toFixed(1)}ms max=${burstAge.max.toFixed(1)}ms`);
    assert.ok(steadyAge.p95 <= GATE_QUEUE_AGE_P95_MS, `steady queue age p95 ${steadyAge.p95} ms`);
    assert.ok(burstAge.max <= GATE_QUEUE_BURST_MAX_MS, `burst queue age max ${burstAge.max} ms`);
  });
});

describe('startup with a foreign reader holding the WAL', () => {
  /** Creates the store, then a process holding a read transaction. */
  async function prepareWithReader(holdMs) {
    const seed = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH });
    await seed.start();
    await seed.close({ timeoutMs: 1000 });
    const dbPath = path.join(root, DEFAULT_STORAGE_DB_FILENAME);
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN');
      db.prepare('SELECT name FROM sqlite_master').all();
      process.stdout.write('held\\n');
      setTimeout(() => { db.close(); process.exit(0); }, Number(process.argv[2]));
    `;
    const child = spawn(process.execPath, ['-e', script, dbPath, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
    // A write after the reader's snapshot leaves frames the TRUNCATE cannot reset.
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA busy_timeout = 0');
    writer.exec('CREATE TABLE IF NOT EXISTS reader_probe (v TEXT)');
    writer.prepare('INSERT INTO reader_probe VALUES (?)').run('x');
    writer.close();
    return { exited, kill: () => child.kill() };
  }

  it('fails closed with CHECKPOINT_BLOCKED_BY_READER after ONE start attempt', async () => {
    const reader = await prepareWithReader(60000);
    try {
      const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, checkpointWaitMs: 300, busyTimeoutMs: 50, maxStartAttempts: 5 });
      hosts.push(host);
      const err = await rejection(host.start());
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'busy');
      assert.equal(err.details.operation, CHECKPOINT_BLOCKED_BY_READER);
      assert.equal(host.getMetrics().startAttempts, 1);
    } finally {
      reader.kill();
      await reader.exited;
    }
  });

  it('becomes ready when the reader releases inside the wait', async () => {
    const reader = await prepareWithReader(500);
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, checkpointWaitMs: 8000, busyTimeoutMs: 50 });
    hosts.push(host);
    await host.start();
    assert.equal(host.getMetrics().startAttempts, 0);
    await reader.exited;
  });
});
