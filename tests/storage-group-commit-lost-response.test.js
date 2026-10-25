import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { executeCommand, resolveUnknown } from '../lib/storage/command-receipts.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';

/**
 * Integration of group commit + worker host when the reply is lost AFTER the
 * batch COMMIT (the worker thread exits between COMMIT and the reply). The
 * data is durable, the caller only sees `unknown_commit`; a retry with the
 * same commandId must return the stored receipt and never add a second delta.
 */

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-group-handlers.js', import.meta.url));
const GEN = 'gen-1';

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-lost-response-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function startHost() {
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    writeGate: WRITE_GATE_TEST_EXEMPTION,
    restartBackoffMs: { initial: 10, max: 100 },
    faultInjection: true,
  });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

/**
 * @param {string} commandId
 * @param {Record<string, unknown>} payload
 * @param {string} [name]
 */
function cmd(commandId, payload, name = 'put') {
  return { datasetGeneration: GEN, commandId, name, payload };
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
 * Committer with a manual flush only: the window timer never fires, so the
 * test does not depend on wall-clock time.
 *
 * @param {any} host
 */
function committer(host) {
  return createGroupCommitter({ host, setTimer: () => ({}), clearTimer: () => {} });
}

describe('group commit: reply lost after COMMIT', () => {
  it('retry with the same commandId returns the same receipt and creates no second delta', async () => {
    const host = await startHost();
    const marker = path.join(root, 'exit-marker');
    const other = cmd('lr-1', { k: 'lr1', v: '1' });
    const lost = cmd('lr-2', { k: 'lr2', v: '1', marker }, 'putExitAfterCommit');

    const gc = committer(host);
    const submitted = [gc.submit(other), gc.submit(lost)];
    await gc.flush();
    for (const p of submitted) assert.equal((await rejection(p)).code, 'unknown_commit', 'reply was lost, outcome unknown');

    // The mutation is durable although no member got an ACK.
    assert.equal(await host.query('applyCount', { k: 'lr2' }), 1);
    const receiptsBefore = await host.query('receiptCount', {});
    assert.equal(receiptsBefore, 2);

    const reconciled = await resolveUnknown(host, lost);
    assert.equal(reconciled.outcome, 'committed');

    // Retry through a fresh committer (the first one is irrelevant after the loss).
    const retryGc = committer(host);
    const retried = [retryGc.submit(other), retryGc.submit(lost)];
    await retryGc.flush();
    const [retryOther, retryLost] = await Promise.all(retried);
    assert.equal(retryLost.replayed, true);
    assert.equal(retryOther.replayed, true);
    assert.deepEqual(retryLost.result, /** @type {any} */ (reconciled).result, 'same receipt as resolveUnknown reported');
    assert.equal(/** @type {any} */ (retryLost.result).k, 'lr2');

    // A third retry (direct command, not batched) sees the very same receipt.
    const direct = await executeCommand(host, lost);
    assert.equal(direct.replayed, true);
    assert.deepEqual(direct.result, retryLost.result);

    // No second delta: one apply-log row per key, receipts unchanged.
    assert.equal(await host.query('applyCount', { k: 'lr1' }), 1);
    assert.equal(await host.query('applyCount', { k: 'lr2' }), 1);
    assert.equal(await host.query('receiptCount', {}), receiptsBefore);
    assert.equal(await host.query('get', { k: 'lr2' }), '1');
  });

  it('a blind retry without resolveUnknown still replays instead of applying twice', async () => {
    const host = await startHost();
    const marker = path.join(root, 'exit-marker-blind');
    const lost = cmd('lr-blind', { k: 'blind', v: '1', marker }, 'putExitAfterCommit');

    const gc = committer(host);
    const first = gc.submit(lost);
    await gc.flush();
    assert.equal((await rejection(first)).code, 'unknown_commit');

    const retryGc = committer(host);
    const retried = retryGc.submit(lost);
    await retryGc.flush();
    const { result, replayed } = await retried;
    assert.equal(replayed, true);
    assert.equal(/** @type {any} */ (result).k, 'blind');
    assert.equal(await host.query('applyCount', { k: 'blind' }), 1);
    assert.equal(await host.query('receiptCount', {}), 1);
  });

  it('keeps the receipt result stable across repeated retries (same applySeq)', async () => {
    const host = await startHost();
    const marker = path.join(root, 'exit-marker-stable');
    const lost = cmd('lr-stable', { k: 'stable', v: '1', marker }, 'putExitAfterCommit');
    const gc = committer(host);
    const first = gc.submit(lost);
    await gc.flush();
    await rejection(first);
    const seqs = new Set();
    for (let i = 0; i < 3; i += 1) {
      const retryGc = committer(host);
      const p = retryGc.submit(lost);
      await retryGc.flush();
      const r = await p;
      assert.equal(r.replayed, true);
      seqs.add(/** @type {any} */ (r.result).applySeq);
    }
    assert.equal(seqs.size, 1);
    assert.equal(await host.query('applyCount', { k: 'stable' }), 1);
  });
});
