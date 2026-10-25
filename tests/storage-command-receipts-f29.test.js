/**
 * F29: durability barrier after a COMMIT failure (split out of storage-command-receipts.test.js so that file can
 * stay exactly as the working tree has it). Same fixtures, same real worker threads; synthetic data only.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { executeCommand, resolveUnknown } from '../lib/storage/command-receipts.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-receipt-handlers.js', import.meta.url));
const GEN = 'gen-1';

/** @type {string} */
let root;
/** @type {Array<ReturnType<typeof createStorageWorkerHost>>} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-f29-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {Record<string, unknown>} [extra] */
async function startHost(extra = {}) {
  const host = createStorageWorkerHost({
    dbDir: root,
    handlersPath: HANDLERS_PATH,
    restartBackoffMs: { initial: 10, max: 100 },
    writeGate: WRITE_GATE_TEST_EXEMPTION,
    ...extra,
  });
  hosts.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

/** @param {Promise<unknown>} promise @returns {Promise<any>} */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

describe('F29 durability barrier after a COMMIT failure', () => {
  const walPath = () => path.join(root, `${DEFAULT_STORAGE_DB_FILENAME}-wal`);
  /** @param {string} name */
  const failingArgs = (name) => ({
    datasetGeneration: GEN, commandId: `cmd-${name}`, name,
    payload: { k: name, v: '1', faultMarker: path.join(root, `fault-${name}`) },
  });
  afterEach(() => { delete process.env.CRETLI_TEST_BARRIER_FAIL; });

  it('checkpoints (TRUNCATE) the WAL before the replacement worker is ready', async () => {
    const host = await startHost({ faultInjection: true });
    const args = failingArgs('putCommitFault');
    assert.ok(fs.existsSync(walPath()) && fs.statSync(walPath()).size > 0, 'WAL holds frames before the fault');
    await rejection(executeCommand(host, args));
    const resolved = await resolveUnknown(host, args);
    assert.equal(resolved.outcome, 'committed');
    assert.equal(fs.statSync(walPath()).size, 0, 'frames were moved into the database file and fsynced before ready');
  });

  it('does not report ready or answer resolveUnknown while the barrier fails, then recovers', async () => {
    const marker = path.join(root, 'barrier-fail');
    const host = await startHost({ faultInjection: true, maxStartAttempts: 50 });
    // Armed after the first start: every worker start now runs the barrier.
    fs.writeFileSync(marker, '1');
    process.env.CRETLI_TEST_BARRIER_FAIL = marker;
    const args = failingArgs('putCommitFault');
    await rejection(executeCommand(host, args));
    let settled = false;
    const pending = resolveUnknown(host, args).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(settled, false, 'no answer from a connection that did not pass the barrier');
    assert.notEqual(host.getMetrics().state, 'ready');
    fs.rmSync(marker);
    assert.equal((await pending).outcome, 'committed');
    assert.equal(fs.statSync(walPath()).size, 0);
  });

  it('fails stopped (no further ACK) when the barrier never holds', async () => {
    const marker = path.join(root, 'barrier-fail-forever');
    const host = await startHost({ faultInjection: true, maxStartAttempts: 2 });
    // Armed after the first start: every worker start now runs the barrier.
    fs.writeFileSync(marker, '1');
    process.env.CRETLI_TEST_BARRIER_FAIL = marker;
    const args = failingArgs('putCommitFault');
    await rejection(executeCommand(host, args));
    await assert.rejects(resolveUnknown(host, args));
    const next = await rejection(executeCommand(host, { datasetGeneration: GEN, commandId: 'cmd-after', name: 'put', payload: { k: 'after', v: '1' } }));
    assert.notEqual(next.code, undefined);
    assert.equal(host.getMetrics().state, 'failed');
  });
});

describe('F29 durability barrier across a process restart (real child process)', () => {
  const CHILD = fileURLToPath(new URL('./fixtures/storage-barrier-crash-child.js', import.meta.url));
  const walPath = () => path.join(root, `${DEFAULT_STORAGE_DB_FILENAME}-wal`);
  const crashArgs = () => ({
    datasetGeneration: GEN, commandId: 'cmd-crash', name: 'putCommitFault',
    payload: { k: 'crash', v: '1', faultMarker: path.join(root, 'fault-crash') },
  });
  afterEach(() => { delete process.env.CRETLI_TEST_BARRIER_FAIL; });

  /** Runs the child to its SIGKILL; a fresh host never saw the failure. */
  async function crashChild() {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [CHILD, root, HANDLERS_PATH, 'cmd-crash'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(res.signal, 'SIGKILL', `child must die by SIGKILL: ${res.stderr}`);
    assert.ok(fs.existsSync(path.join(root, 'fault-crash')), 'the simulated COMMIT fault really fired in the child');
  }

  it('a fresh host after a killed process checkpoints the WAL before ready and resolves authoritatively', async () => {
    await crashChild();
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, faultInjection: true, restartBackoffMs: { initial: 10, max: 100 }, writeGate: WRITE_GATE_TEST_EXEMPTION });
    hosts.push(host);
    await host.start();
    assert.equal(fs.existsSync(walPath()) ? fs.statSync(walPath()).size : 0, 0, 'barrier ran at startup without any host memory of the failure');
    const resolved = await resolveUnknown(host, crashArgs());
    assert.equal(resolved.outcome, 'committed');
    assert.equal(await host.query('get', { k: 'crash' }), '1');
  });

  it('while the barrier fails the fresh host is not ready, resolveUnknown and every later write are refused, then recovery is authoritative', async () => {
    await crashChild();
    const marker = path.join(root, 'barrier-fail-restart');
    fs.writeFileSync(marker, '1');
    process.env.CRETLI_TEST_BARRIER_FAIL = marker;
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, faultInjection: true, maxStartAttempts: 50, restartBackoffMs: { initial: 10, max: 50 }, writeGate: WRITE_GATE_TEST_EXEMPTION });
    hosts.push(host);
    let ready = false;
    const starting = host.start().then(() => { ready = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(ready, false, 'start() must not resolve before the barrier holds');
    let writeSettled = false;
    const write = executeCommand(host, { datasetGeneration: GEN, commandId: 'cmd-later', name: 'put', payload: { k: 'later', v: '1' } })
      .then((v) => { writeSettled = true; return v; });
    let resolveSettled = false;
    const pending = resolveUnknown(host, crashArgs()).then((v) => { resolveSettled = true; return v; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(writeSettled, false, 'no write is served or ACKed before the barrier');
    assert.equal(resolveSettled, false, 'no resolveUnknown answer before the barrier');
    fs.rmSync(marker);
    await starting;
    assert.equal((await pending).outcome, 'committed');
    assert.equal((await write).replayed, false);
  });

  it('a barrier that never holds fails the fresh host stopped: start, resolveUnknown and writes are rejected', async () => {
    await crashChild();
    const marker = path.join(root, 'barrier-fail-forever-restart');
    fs.writeFileSync(marker, '1');
    process.env.CRETLI_TEST_BARRIER_FAIL = marker;
    const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, faultInjection: true, maxStartAttempts: 2, restartBackoffMs: { initial: 10, max: 20 }, writeGate: WRITE_GATE_TEST_EXEMPTION });
    hosts.push(host);
    await assert.rejects(host.start());
    assert.equal(host.getMetrics().state, 'failed');
    await assert.rejects(resolveUnknown(host, crashArgs()));
    await assert.rejects(executeCommand(host, { datasetGeneration: GEN, commandId: 'cmd-after', name: 'put', payload: { k: 'after', v: '1' } }));
  });
});
