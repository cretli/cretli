import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-worker-handlers.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-expiry-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function startHost(extra = {}) {
  const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, ...extra });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

describe('storage worker queue expiry strategy', () => {
  it('re-queues an expired protected-class request instead of failing it, while normal requests still expire', async () => {
    const host = await startHost();
    const blocker = host.command('spin', { ms: 300 });
    const ack = host.command('put', { k: 'ack', v: 'x' }, { priority: 'final', deadlineMs: 120 });
    const background = host.command('put', { k: 'bg', v: 'x' }, { priority: 'normal', deadlineMs: 50 });
    await assert.rejects(background, (e) => e.code === 'busy' && e.details.operation === 'deadline');
    await blocker;
    await ack;
    assert.equal(await host.query('get', { k: 'ack' }), 'x');
    assert.equal(await host.query('get', { k: 'bg' }), null);
    const m = host.getMetrics();
    assert.ok(m.counters.expiryRetried >= 1);
    assert.equal(m.byPriority.final.expired, 0);
    assert.equal(m.byPriority.final.dispatched >= 1, true);
    assert.equal(m.byPriority.normal.expired, 1);
    assert.ok(m.byPriority.final.waitMaxMs >= 120);
  });

  it('surfaces the expiry once the retry budget is exhausted', async () => {
    const host = await startHost({ protectedExpiryRetries: 1 });
    const blocker = host.command('spin', { ms: 400 });
    const ack = host.command('put', { k: 'late', v: 'x' }, { priority: 'claim', deadlineMs: 40 });
    await assert.rejects(ack, (e) => e.code === 'busy' && e.details.operation === 'deadline');
    await blocker;
    await sleep(10);
    const m = host.getMetrics();
    assert.equal(m.counters.expiryRetried, 1);
    assert.equal(m.byPriority.claim.expired, 1);
  });
});
