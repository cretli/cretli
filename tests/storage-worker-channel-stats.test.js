import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-handlers.js', import.meta.url));

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-chstats-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function startHost() {
  const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

// The blocker must outlive the short deadline by a wide margin so a slow CI box cannot let a queued request
// reach the worker before it expires; the tests also assert the blocker is still running when expiry lands.
const BLOCKER_MS = 800;
const SHORT_DEADLINE_MS = 30;

describe('storage worker host channel stats', () => {
  it('counts messages and approximate bytes per kind:name channel', async () => {
    const host = await startHost();
    await host.command('put', { k: 'a', v: 'one' });
    await host.query('get', { k: 'a' });
    const stats = host.getChannelStats();
    assert.equal(stats['command:put'].sent, 1);
    assert.ok(stats['command:put'].sentBytes > 0);
    assert.equal(stats['query:get'].received, 1);
    assert.ok(stats['query:get'].receivedBytes > 0);
  });

  it('coalesces identical queued reads and gives each caller its own object', async () => {
    const host = await startHost();
    await host.command('put', { k: 'a', v: 'one' });
    // The first read is dispatched at once; the next two queue behind it and share one round trip.
    const reads = [host.query('row', { k: 'a' }), host.query('row', { k: 'a' }), host.query('row', { k: 'a' })];
    const [, second, third] = await Promise.all(reads);
    assert.deepEqual(second, { k: 'a', v: 'one' });
    second.v = 'mutated';
    assert.deepEqual(third, { k: 'a', v: 'one' });
    const stats = host.getChannelStats()['query:row'];
    assert.equal(stats.coalesced, 1);
    assert.equal(stats.sent, 2);
    const { counters } = host.getMetrics();
    assert.equal(counters.joinedCompleted, 1);
    assert.equal(counters.joinedFailed, 0);
  });

  it('never joins a read across a write and the later read sees the write', async () => {
    const host = await startHost();
    await host.command('put', { k: 'a', v: 'one' });
    const blocker = host.command('spin', { ms: 100 });
    const before = host.query('get', { k: 'w' });
    const write = host.command('put', { k: 'w', v: 'new' });
    const after = host.query('get', { k: 'w' });
    await blocker;
    assert.deepEqual(await Promise.all([before, write, after]).then((r) => [r[0], r[2]]), [null, 'new']);
    assert.equal(host.getChannelStats()['query:get'].coalesced, 0);
  });

  it('does not join reads with different deadlines', async () => {
    const host = await startHost();
    const blocker = host.command('spin', { ms: 100 });
    const a = host.query('get', { k: 'z' });
    const b = host.query('get', { k: 'z' }, { deadlineMs: 5000 });
    await blocker;
    await Promise.all([a, b]);
    assert.equal(host.getChannelStats()['query:get'].coalesced, 0);
  });

  it('rejects joiners when the host request expires and raises no unhandledRejection for dropped ones', async () => {
    const host = await startHost();
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let blockerDone = false;
      const blocker = host.command('spin', { ms: BLOCKER_MS }).then(() => { blockerDone = true; });
      void host.query('get', { k: 'x' }, { deadlineMs: SHORT_DEADLINE_MS });
      const awaited = host.query('get', { k: 'x' }, { deadlineMs: SHORT_DEADLINE_MS });
      void host.query('get', { k: 'x' }, { deadlineMs: SHORT_DEADLINE_MS });
      let err;
      try { await awaited; } catch (e) { err = e; }
      assert.equal(err?.details?.operation, 'deadline');
      assert.equal(blockerDone, false, 'expiry must happen while the blocker still runs');
      await blocker;
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(unhandled, []);
      assert.equal(host.getChannelStats()['query:get'].coalesced, 2);
      const { counters } = host.getMetrics();
      assert.equal(counters.joinedFailed, 2);
      assert.equal(counters.joinedCompleted, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
