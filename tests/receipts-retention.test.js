import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { executeCommand } from '../lib/storage/command-receipts.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { createReceiptsRetention, findPruneBackups, RECEIPT_RETENTION_MS } from '../lib/storage/receipts-retention.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-receipt-handlers.js', import.meta.url));
const GEN = 'gen-1';
const DAY = 24 * 60 * 60 * 1000;

let root;
let backupDir;
let host;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(ISOLATED_DATA_DIR, 'retention-'));
  backupDir = path.join(root, 'backups', 'storage');
  host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  await host.start();
  await host.command('setup', {});
});

afterEach(async () => {
  await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const dbPath = () => path.join(root, DEFAULT_STORAGE_DB_FILENAME);
const put = (commandId, k = commandId) => executeCommand(host, { datasetGeneration: GEN, commandId, name: 'put', payload: { k, v: '1' } });

/** Run `fn` on a side connection (WAL), e.g. to age receipts. */
function sql(fn) {
  const db = new DatabaseSync(dbPath());
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}
const receiptIds = () => sql((db) => db.prepare('SELECT command_id FROM command_receipts ORDER BY command_id').all().map((r) => r.command_id));
const age = (ids, days) => sql((db) => {
  for (const id of ids) db.prepare('UPDATE command_receipts SET created_at = ? WHERE command_id = ?').run(Date.now() - days * DAY, id);
});
const retention = (extra = {}) => createReceiptsRetention({ host, dbPath: dbPath(), backupDir, writeGate: WRITE_GATE_TEST_EXEMPTION, log: () => {}, ...extra });

describe('command_receipts retention', () => {
  it('removes only receipts older than the window and keeps in-window dedupe', async () => {
    for (const id of ['old-1', 'old-2', 'new-1', 'new-2', 'new-3', 'new-4', 'new-5', 'new-6', 'new-7', 'new-8', 'new-9', 'new-10']) await put(id);
    age(['old-1', 'old-2'], 8);
    const outcome = await retention({ batchRows: 1 }).runOnce();
    assert.equal(outcome.deleted, 2);
    assert.ok(!receiptIds().includes('old-1') && !receiptIds().includes('old-2'));
    const replay = await put('new-1');
    assert.equal(replay.replayed, true, 'a retry inside the window still deduplicates');
    assert.equal(receiptIds().length, 10);
  });

  it('writes a verified copy before the first prune that removes more than 10% and keeps it', async () => {
    for (const id of ['a', 'b', 'c']) await put(id);
    age(['a', 'b'], 30);
    await retention().runOnce();
    const copies = findPruneBackups(backupDir, DEFAULT_STORAGE_DB_FILENAME);
    assert.equal(copies.length, 1);
    const copy = new DatabaseSync(path.join(backupDir, copies[0]), { readOnly: true });
    try {
      assert.equal(Number(copy.prepare('SELECT count(*) AS n FROM test_kv').get().n), 3);
      assert.equal(Number(copy.prepare('SELECT count(*) AS n FROM command_receipts').get().n), 3, 'copy predates the prune');
    } finally {
      copy.close();
    }
    assert.deepEqual(receiptIds(), ['c']);
    assert.equal(fs.readdirSync(backupDir).some((n) => n.endsWith('.tmp')), false);
  });

  it('does not prune when the backup cannot be made', async () => {
    for (const id of ['a', 'b']) await put(id);
    age(['a', 'b'], 30);
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.writeFileSync(backupDir, 'not a directory');
    await assert.rejects(() => retention().runOnce());
    assert.deepEqual(receiptIds(), ['a', 'b']);
  });

  it('worker refuses a prune that requires a copy when none exists', async () => {
    await put('a');
    age(['a'], 30);
    await assert.rejects(
      () => host.control('receipts.prune', {}, { cutoff: Date.now(), requireBackup: { dir: backupDir, filename: DEFAULT_STORAGE_DB_FILENAME } }),
      (err) => err.code === 'conflict' && err.details?.conflictKind === 'receipts_backup_missing',
    );
    assert.deepEqual(receiptIds(), ['a']);
  });

  it('a small prune (<=10%) needs no copy and one batch stays fast', async () => {
    for (let i = 0; i < 20; i += 1) await put(`r${i}`);
    age(['r0'], 30);
    await retention().runOnce();
    assert.equal(findPruneBackups(backupDir, DEFAULT_STORAGE_DB_FILENAME).length, 0);
    sql((db) => {
      const ins = db.prepare("INSERT INTO command_receipts VALUES ('gen-1', ?, 'sha256:x', '{}', 1)");
      db.exec('BEGIN');
      for (let i = 0; i < 5000; i += 1) ins.run(`bulk-${i}`);
      db.exec('COMMIT');
    });
    const started = performance.now();
    const batch = await host.control('receipts.prune', {}, { cutoff: Date.now() - RECEIPT_RETENTION_MS, batchRows: 5000 });
    const ms = performance.now() - started;
    assert.equal(batch.deleted, 5000);
    assert.ok(ms < 1000, `batch took ${ms}ms`);
  });
});

describe('batch cost and plan', () => {
  it('uses the generations from the plan and removes only those', async () => {
    await put('a');
    age(['a'], 30);
    const batch = await host.control('receipts.prune', {}, { cutoff: Date.now(), generations: ['other-gen'] });
    assert.equal(batch.deleted, 0, 'a generation outside the plan list is not scanned');
    const all = await host.control('receipts.prune', {}, { cutoff: Date.now(), generations: [GEN] });
    assert.equal(all.deleted, 1);
  });
});
