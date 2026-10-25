import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-handlers.js', import.meta.url));
const REAL_WORKER_URL = new URL('../lib/storage/sqlite-worker.js', import.meta.url);
const WINDOW_MS = 1000;

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-restart-window-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Host with an injected clock and a spawn counter; the window is driven by the clock only.
 *
 * @param {number} maxWorkerLosses
 */
async function startHost(maxWorkerLosses) {
  const clock = { t: 0 };
  const spawns = { n: 0 };
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    maxWorkerLosses,
    workerLossWindowMs: WINDOW_MS,
    restartBackoffMs: { initial: 5, max: 20 },
    now: () => clock.t,
    workerUrl: () => {
      spawns.n += 1;
      return REAL_WORKER_URL;
    },
  });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return { host, clock, spawns };
}

/**
 * @param {ReturnType<typeof createStorageWorkerHost>} host
 * @param {string} k
 * @returns {Promise<any>}
 */
async function crashOnce(host, k) {
  try {
    await host.command('putThenExit', { k, v: 'x' });
  } catch (err) {
    return err;
  }
  return assert.fail('expected the worker to crash');
}

/**
 * @param {() => boolean} predicate
 */
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('storage worker restart window', () => {
  it('fails closed after N crashes inside the window', async () => {
    const { host, clock } = await startHost(3);
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await crashOnce(host, `in${i}`)).code, 'unknown_commit');
      clock.t += 100;
      await host.control('ping'); // waits for the replacement worker
    }
    assert.equal(host.getMetrics().state, 'ready');
    assert.equal((await crashOnce(host, 'in2')).code, 'unknown_commit');
    await waitFor(() => host.getMetrics().state === 'failed');
  });

  it('resets the counter once the window has elapsed', async () => {
    const { host, clock } = await startHost(2);
    assert.equal((await crashOnce(host, 'w1')).code, 'unknown_commit');
    await host.control('ping');
    // The first loss ages out of the window, so the second one is the only one counted.
    clock.t += WINDOW_MS + 1;
    assert.equal((await crashOnce(host, 'w2')).code, 'unknown_commit');
    await host.control('ping');
    assert.equal(host.getMetrics().state, 'ready');
    // A third loss inside the new window reaches the limit.
    clock.t += 10;
    assert.equal((await crashOnce(host, 'w3')).code, 'unknown_commit');
    await waitFor(() => host.getMetrics().state === 'failed');
  });

  it('does not spawn again when submit() hits a failed host', async () => {
    const { host, spawns } = await startHost(2);
    assert.equal((await crashOnce(host, 'l1')).code, 'unknown_commit');
    await host.control('ping');
    assert.equal((await crashOnce(host, 'l2')).code, 'unknown_commit');
    await waitFor(() => host.getMetrics().state === 'failed');
    const spawnsAtFailure = spawns.n;
    assert.equal(spawnsAtFailure, 2, 'initial worker plus the one tolerated restart');
    for (let i = 0; i < 20; i += 1) {
      const err = await crashOnce(host, `after${i}`).catch((e) => e);
      assert.equal(err.details.operation, 'worker_crash_loop');
      assert.equal(err.details.commitState, 'not_committed');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(spawns.n, spawnsAtFailure, 'submit() must not restart a failed host');
    assert.equal(host.getMetrics().restarts, 1);
  });
});
