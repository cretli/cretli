import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { executeCommand } from '../lib/storage/command-receipts.js';
import { WriteGateRegistry, assertFence } from '../lib/storage/maintenance-coordinator.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { writeControlState } from '../lib/backup/offline/control-dir.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-receipt-handlers.js', import.meta.url));

let root;
let controlDir;
let host;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-write-gates-'));
  controlDir = path.join(root, 'control');
  host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, restartBackoffMs: { initial: 10, max: 100 } });
  await host.start();
  await host.command('setup', {});
});

afterEach(async () => {
  await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

function storeRegistry(unknownGaps = []) {
  return { stores: [{ id: 's1', writers: { unknownGaps } }] };
}

function rowCount() {
  const db = new DatabaseSync(path.join(root, DEFAULT_STORAGE_DB_FILENAME));
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM test_apply_log').get().n
      + db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get().n;
  } finally { db.close(); }
}

function args(gate, id) {
  return { datasetGeneration: 'gen-1', commandId: id, name: 'put', payload: { k: 'a', v: '1' }, writeGate: gate };
}

function gate(registry, over = {}) {
  return { controlDir, registry, writerId: 'w1', fence: 3, ...over };
}

function okRegistry() {
  const reg = new WriteGateRegistry({ registry: storeRegistry() });
  reg.startWriter('w1', 's1');
  return reg;
}

async function rejectGrouped(writeGate, id, code) {
  const committer = createGroupCommitter({ host, writeGate, windowMs: 1 });
  const before = rowCount();
  try {
    await assert.rejects(committer.submit(args(undefined, id)), (error) => error.code === code);
    assert.equal(rowCount(), before);
  } finally {
    await committer.close();
  }
}

describe('storage write gates', () => {
  it('stale fence rejects the write with zero DB changes', async () => {
    writeControlState(controlDir, { fence: 5 });
    assert.throws(() => assertFence(controlDir, 3), (e) => e.code === 'FENCE_STALE');
    const before = rowCount();
    await assert.rejects(executeCommand(host, args(gate(okRegistry()), 'cmd-stale')), (e) => e.code === 'FENCE_STALE');
    assert.equal(rowCount(), before);
  });

  it('restore pause rejects the write without a partial commit', async () => {
    writeControlState(controlDir, { fence: 3, paused: true, pauseReason: 'restore' });
    const before = rowCount();
    await assert.rejects(executeCommand(host, args(gate(okRegistry()), 'cmd-paused')), (e) => e.code === 'RESTORE_PAUSED');
    assert.equal(rowCount(), before);
  });

  it('unregistered writer cannot write', async () => {
    writeControlState(controlDir, { fence: 3 });
    const before = rowCount();
    await assert.rejects(executeCommand(host, args(gate(okRegistry(), { writerId: 'ghost' }), 'cmd-ghost')), (e) => e.code === 'WRITER_NOT_REGISTERED');
    assert.equal(rowCount(), before);
  });

  it('unknownGaps > 0 blocks writer start', () => {
    const reg = new WriteGateRegistry({ registry: storeRegistry(['mystery writer']) });
    assert.throws(() => reg.startWriter('w1', 's1'), (e) => e.code === 'UNKNOWN_WRITER_GAPS');
    assert.equal(reg.isRegistered('w1'), false);
  });

  it('a registered writer with the current fence writes', async () => {
    writeControlState(controlDir, { fence: 3 });
    const res = await executeCommand(host, args(gate(okRegistry()), 'cmd-ok'));
    assert.equal(res.replayed, false);
    assert.equal(rowCount(), 2);
  });

  it('fails closed when the plain or group-commit path has no gate', async () => {
    const before = rowCount();
    await assert.rejects(executeCommand(host, args(undefined, 'cmd-no-gate')), (error) => error.code === 'WRITE_GATE_REQUIRED');
    await rejectGrouped(undefined, 'group-no-gate', 'WRITE_GATE_REQUIRED');
    assert.equal(rowCount(), before);
  });

  it('group commit rejects a stale fence with zero DB changes', async () => {
    writeControlState(controlDir, { fence: 5 });
    await rejectGrouped(gate(okRegistry()), 'group-stale', 'FENCE_STALE');
  });

  it('group commit rejects restore pause with zero DB changes', async () => {
    writeControlState(controlDir, { fence: 3, paused: true, pauseReason: 'restore' });
    await rejectGrouped(gate(okRegistry()), 'group-paused', 'RESTORE_PAUSED');
  });

  it('group commit rejects an unregistered writer with zero DB changes', async () => {
    writeControlState(controlDir, { fence: 3 });
    await rejectGrouped(gate(okRegistry(), { writerId: 'ghost' }), 'group-ghost', 'WRITER_NOT_REGISTERED');
  });
});
