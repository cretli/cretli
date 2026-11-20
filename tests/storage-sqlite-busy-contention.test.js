import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { StorageError } from '../lib/storage/errors.js';
import { executeCommand } from '../lib/storage/command-receipts.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';

/**
 * A second PROCESS holds the SQLite write lock while the storage worker tries
 * to commit. Contract (docs/storage-contract.md, receipts.md): the worker's
 * busy handler gives up after `busyTimeoutMs`, the request fails closed with a
 * retryable `busy` + `commitState: 'not_committed'`, nothing is applied, and a
 * retry with the same commandId succeeds exactly once after the lock is gone.
 */

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-group-handlers.js', import.meta.url));
const HOLDER_PATH = fileURLToPath(new URL('./fixtures/storage-lock-holder-child.js', import.meta.url));
const GEN = 'gen-1';
/** Short busy timeout so the busy path is reached quickly. */
const BUSY_TIMEOUT_MS = 30;

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;
/** @type {Array<{ release: () => Promise<void> }>} */
let holders;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-busy-'));
  hosts = [];
  holders = [];
});

afterEach(async () => {
  for (const holder of holders) await holder.release().catch(() => {});
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function startHost() {
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    writeGate: WRITE_GATE_TEST_EXEMPTION,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    restartBackoffMs: { initial: 10, max: 100 },
  });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

/**
 * Spawn a process that holds the write lock until `release()`.
 */
async function holdWriteLock() {
  const child = spawn(process.execPath, ['--no-warnings', HOLDER_PATH, path.join(root, DEFAULT_STORAGE_DB_FILENAME)], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('lock holder exited before locking')));
    child.stdout.once('data', (chunk) => {
      if (String(chunk).includes('locked')) resolve(undefined);
    });
  });
  let released = false;
  const holder = {
    async release() {
      if (released) return;
      released = true;
      child.stdin.end();
      await exited;
    },
  };
  holders.push(holder);
  return holder;
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
 * @param {string} commandId
 * @param {string} k
 */
function put(commandId, k) {
  return { datasetGeneration: GEN, commandId, name: 'put', payload: { k, v: '1' } };
}

/**
 * Integrity and content check through an independent read-only connection.
 *
 * @param {string[]} expectedKeys
 */
function assertDbIntact(expectedKeys) {
  const db = new DatabaseSync(path.join(root, DEFAULT_STORAGE_DB_FILENAME), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const keys = db.prepare('SELECT k FROM test_kv ORDER BY k').all().map((r) => r.k);
    assert.deepEqual(keys, [...expectedKeys].sort());
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM test_apply_log').get().n), expectedKeys.length);
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM command_receipts').get().n), expectedKeys.length);
  } finally {
    db.close();
  }
}

/**
 * @param {any} err
 */
function assertBusyFailClosed(err) {
  assert.ok(err instanceof StorageError, `expected StorageError, got ${err}`);
  assert.equal(err.code, 'busy');
  assert.equal(err.retryable, true);
  assert.equal(err.details.commitState, 'not_committed');
}

describe('SQLite busy contention with a second process holding the write lock', () => {
  it('fails closed with retryable busy, applies nothing, and the retry applies exactly once', async () => {
    const host = await startHost();
    await executeCommand(host, put('base', 'base'));
    const holder = await holdWriteLock();

    const args = put('busy-1', 'b1');
    assertBusyFailClosed(await rejection(executeCommand(host, args)));
    assert.equal(await host.query('applyCount', { k: 'b1' }), 0, 'nothing applied while the lock is held');
    assert.equal(await host.query('get', { k: 'b1' }), null);

    // Reads still work under a writer lock in WAL mode (no corruption, no stall).
    assert.equal(await host.query('get', { k: 'base' }), '1');

    await holder.release();
    const ok = await executeCommand(host, args);
    assert.equal(ok.replayed, false);
    assert.equal(await host.query('applyCount', { k: 'b1' }), 1);
    const again = await executeCommand(host, args);
    assert.equal(again.replayed, true, 'a further retry only replays');
    assert.equal(await host.query('applyCount', { k: 'b1' }), 1);

    await host.close();
    assertDbIntact(['base', 'b1']);
  });

  it('group commit: busy batch is retried with backoff and fails closed with retryable busy, then succeeds after release', async () => {
    const host = await startHost();
    const holder = await holdWriteLock();
    // Manual flush, injected immediate timers: attempts are bounded by maxFlushAttempts and do not depend on the wall clock.
    const timers = [];
    const gc = createGroupCommitter({
      host,
      maxFlushAttempts: 2,
      retryDelayMs: 1,
      setTimer: (fn) => {
        timers.push(fn);
        queueMicrotask(() => {
          const idx = timers.indexOf(fn);
          if (idx >= 0) {
            timers.splice(idx, 1);
            fn();
          }
        });
        return fn;
      },
      clearTimer: (h) => {
        const idx = timers.indexOf(h);
        if (idx >= 0) timers.splice(idx, 1);
      },
    });
    const members = [put('g-1', 'g1'), put('g-2', 'g2')];
    const pending = members.map((m) => rejection(gc.submit(m)));
    await gc.flush();
    for (const err of await Promise.all(pending)) assertBusyFailClosed(err);
    assert.equal(await host.query('receiptCount', {}), 0, 'no receipts while the lock is held');

    await holder.release();
    const retried = members.map((m) => gc.submit(m));
    await gc.flush();
    assert.deepEqual((await Promise.all(retried)).map((r) => r.replayed), [false, false]);
    assert.equal(await host.query('applyCount', { k: 'g1' }), 1);
    assert.equal(await host.query('applyCount', { k: 'g2' }), 1);

    await gc.close();
    await host.close();
    assertDbIntact(['g1', 'g2']);
  });

  it('a lock released within the busy timeout is waited out: no error, applied once', async () => {
    // Long busy timeout; the holder is released while the worker is waiting.
    const host = createStorageWorkerHost({
      dbDir: root,
      handlersPath: HANDLERS_PATH,
      writeGate: WRITE_GATE_TEST_EXEMPTION,
      busyTimeoutMs: 10000,
    });
    hosts.push(host);
    await host.start();
    await host.command('setup', {});
    const holder = await holdWriteLock();
    const args = put('wait-1', 'w1');
    const inFlight = executeCommand(host, args);
    // The request is blocked behind the foreign lock; it must not settle yet.
    let settled = false;
    inFlight.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, 'write waits for the lock instead of failing early');
    await holder.release();
    const result = await inFlight;
    assert.equal(result.replayed, false);
    assert.equal(await host.query('applyCount', { k: 'w1' }), 1);
    await host.close();
    assertDbIntact(['w1']);
  });
});
