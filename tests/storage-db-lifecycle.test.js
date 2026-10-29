import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_STORAGE_DB_FILENAME,
  MAX_STORAGE_BUSY_TIMEOUT_MS,
  openStorageDb,
  runWalTruncateBarrier,
  runWalTruncateBarrierBounded,
  CHECKPOINT_BLOCKED_BY_READER,
  STORAGE_BUSY_TIMEOUT_MS,
} from '../lib/storage/db-lifecycle.js';
import { applyMigrations, CORE_MIGRATIONS, readSchemaVersion } from '../lib/storage/migrations.js';
import { STORAGE_APPLICATION_ID } from '../lib/storage/schema/0001-core.js';
import { toStorageError } from '../lib/storage/sqlite-errors.js';
import { StorageError } from '../lib/storage/errors.js';

/** @type {string} */
let root;
/** @type {string} */
let dir;
/** @type {Array<{ close: () => void }>} */
let handles;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-db-'));
  dir = path.join(root, 'store');
  fs.mkdirSync(dir);
  handles = [];
});

afterEach(() => {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Already closed or failed; the directory is removed anyway.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {Record<string, unknown>} [extra]
 */
function open(extra = {}) {
  const handle = openStorageDb({ dir, ...extra });
  handles.push(handle);
  return handle;
}

/**
 * @param {string} sqlitePath
 * @returns {DatabaseSync}
 */
function rawOpen(sqlitePath) {
  const db = new DatabaseSync(sqlitePath);
  handles.push(db);
  return db;
}

/**
 * @param {() => unknown} fn
 * @returns {StorageError}
 */
function captureStorageError(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof StorageError, `expected StorageError, got ${err}`);
    return err;
  }
  assert.fail('expected a StorageError');
}

/**
 * @param {string} file
 * @returns {string}
 */
function digestFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {DatabaseSync} db
 * @param {string} name
 * @returns {boolean}
 */
function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

const fkFixtureMigration = Object.freeze({
  version: CORE_MIGRATIONS.length + 1,
  name: 'fk-fixture',
  sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));`,
});

const insertReceiptSql = `INSERT INTO command_receipts
  (dataset_generation, command_id, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?)`;

describe('openStorageDb pragmas and lifecycle', () => {
  it('applies and verifies WAL, FULL, foreign keys and busy_timeout', () => {
    const handle = open();
    const { db } = handle;
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(Number(db.prepare('PRAGMA synchronous').get().synchronous), 2);
    assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
    assert.equal(Number(db.prepare('PRAGMA busy_timeout').get().timeout), STORAGE_BUSY_TIMEOUT_MS);
    assert.equal(handle.schemaVersion, CORE_MIGRATIONS.length);
    assert.equal(handle.filename, DEFAULT_STORAGE_DB_FILENAME);
    assert.equal(path.dirname(handle.filePath), fs.realpathSync(dir));
  });

  it('reopens idempotently without re-applying migrations', () => {
    const first = open({ now: () => 1000 });
    first.db.prepare(insertReceiptSql).run('g1', 'c1', 'd1', '{"ok":true}', 1);
    first.close();
    const second = open({ now: () => 2000 });
    const rows = second.db.prepare('SELECT version, applied_at FROM schema_version').all();
    assert.deepEqual(rows.map((r) => [r.version, r.applied_at]), CORE_MIGRATIONS.map((m) => [m.version, 1000]));
    assert.equal(second.db.prepare('SELECT count(*) AS n FROM command_receipts').get().n, 1);
  });

  it('opens one connection per handle (no singleton)', () => {
    const a = open();
    const b = open();
    assert.notEqual(a.db, b.db);
    a.close();
    assert.equal(b.db.prepare('SELECT 1 AS one').get().one, 1);
  });

  it('close is idempotent and the handle refuses use afterwards', () => {
    const handle = open();
    handle.close();
    handle.close();
    assert.equal(handle.isClosed(), true);
    assert.equal(captureStorageError(() => handle.db).code, 'io');
  });

  it('bounds busy_timeout and validates dir/filename', () => {
    assert.throws(() => openStorageDb({ dir, busyTimeoutMs: MAX_STORAGE_BUSY_TIMEOUT_MS + 1 }), TypeError);
    assert.throws(() => openStorageDb({ dir, busyTimeoutMs: 1.5 }), TypeError);
    assert.throws(() => openStorageDb({ dir: 'relative/dir' }), TypeError);
    for (const filename of ['../escape.sqlite', 'a/b.sqlite', '.hidden', '', ':memory:']) {
      assert.throws(() => openStorageDb({ dir, filename }), TypeError, filename);
    }
  });

  it('fails with missing for an absent dir (injected fs) and never creates it', () => {
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const fakeFs = {
      statSync: () => { throw enoent; },
      lstatSync: fs.lstatSync,
      realpathSync: fs.realpathSync,
    };
    const err = captureStorageError(() => openStorageDb({ dir: path.join(root, 'absent'), fs: fakeFs }));
    assert.equal(err.code, 'missing');
    assert.equal(captureStorageError(() => openStorageDb({ dir: path.join(root, 'absent2') })).code, 'missing');
    assert.deepEqual(fs.readdirSync(root), ['store']);
  });

  it('refuses a symlinked database file so nothing is written outside dir', () => {
    const outside = path.join(root, 'outside.sqlite');
    fs.writeFileSync(outside, '');
    fs.symlinkSync(outside, path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    assert.equal(captureStorageError(() => open()).code, 'io');
    assert.equal(fs.statSync(outside).size, 0);
  });

  it('fails when a pragma does not take effect', () => {
    class NoWalDatabase extends DatabaseSync {
      /** @param {string} sql */
      prepare(sql) {
        if (sql === 'PRAGMA journal_mode') return { get: () => ({ journal_mode: 'delete' }) };
        return super.prepare(sql);
      }
    }
    const err = captureStorageError(() => open({ loadSqlite: () => ({ DatabaseSync: NoWalDatabase }) }));
    assert.equal(err.code, 'io');
    assert.equal(err.details.operation, 'pragma_journal_mode');
  });

  it('runs the runtime gate first and propagates unsupported_runtime', () => {
    const err = captureStorageError(() => openStorageDb({
      dir,
      checkRuntime: () => { throw new StorageError('unsupported_runtime'); },
    }));
    assert.equal(err.code, 'unsupported_runtime');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('leaves no files outside the given dir', () => {
    const handle = open();
    handle.db.prepare(insertReceiptSql).run('g', 'c', 'd', '{}', 0);
    handle.close();
    assert.deepEqual(fs.readdirSync(root), ['store']);
    const allowed = new Set([DEFAULT_STORAGE_DB_FILENAME, `${DEFAULT_STORAGE_DB_FILENAME}-wal`, `${DEFAULT_STORAGE_DB_FILENAME}-shm`, `${DEFAULT_STORAGE_DB_FILENAME}.clean`]);
    for (const name of fs.readdirSync(dir)) assert.ok(allowed.has(name), name);
  });
});

describe('openStorageDb integrity', () => {
  it('rejects a non-database file as corrupt and leaves its bytes unchanged', () => {
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    fs.writeFileSync(file, Buffer.alloc(8192, 0x5a));
    const before = digestFile(file);
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'corrupt');
    assert.equal(digestFile(file), before);
    assert.equal(fs.statSync(file).size, 8192);
  });

  it('rejects a damaged b-tree page as corrupt without rewriting the file', () => {
    const handle = open();
    const insert = handle.db.prepare(insertReceiptSql);
    handle.db.exec('BEGIN');
    for (let i = 0; i < 2000; i += 1) insert.run('g', `cmd-${i}`, `digest-${i}`, JSON.stringify({ i, pad: 'x'.repeat(64) }), i);
    handle.db.exec('COMMIT');
    handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const pageSize = Number(handle.db.prepare('PRAGMA page_size').get().page_size);
    handle.close();
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length > pageSize * 8);
    // Keep page 1 (header + schema) intact and scramble interior pages.
    for (let offset = pageSize * 3; offset < pageSize * 6; offset += 1) bytes[offset] = (offset * 31) & 0xff;
    fs.writeFileSync(file, bytes);
    const before = digestFile(file);
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'corrupt');
    assert.equal(digestFile(file), before);
  });

  it('rejects foreign_key_check violations as corrupt', () => {
    const migrations = [...CORE_MIGRATIONS, fkFixtureMigration];
    open({ migrations }).close();
    const raw = rawOpen(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    raw.exec('PRAGMA foreign_keys = OFF; INSERT INTO child (id, parent_id) VALUES (1, 42);');
    raw.close();
    assert.equal(captureStorageError(() => open({ migrations })).code, 'corrupt');
  });
});

/**
 * DatabaseSync subclass that records every prepared/executed SQL string.
 *
 * @param {string[]} log
 */
function recordingSqlite(log) {
  class RecordingDatabase extends DatabaseSync {
    /** @param {string} sql */
    prepare(sql) {
      log.push(sql);
      return super.prepare(sql);
    }

    /** @param {string} sql */
    exec(sql) {
      log.push(sql);
      return super.exec(sql);
    }
  }
  return () => ({ DatabaseSync: RecordingDatabase });
}

/**
 * Copy the store and its WAL siblings (when present) into `targetDir`.
 *
 * @param {string} targetDir
 */
function copyStoreFiles(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const source = path.join(dir, `${DEFAULT_STORAGE_DB_FILENAME}${suffix}`);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetDir, `${DEFAULT_STORAGE_DB_FILENAME}${suffix}`));
  }
}

describe('openStorageDb check cost', () => {
  it('reports clean-marker result, reason and per-step timings through onDiag', () => {
    const diags = [];
    const run = (o = {}) => open({ onDiag: (d) => diags.push(d), ...o }).close();
    run(); // new file
    run(); // clean marker present
    run({ fullCheck: true });
    fs.unlinkSync(path.join(dir, `${DEFAULT_STORAGE_DB_FILENAME}.clean`));
    run(); // marker missing
    assert.deepEqual(diags.map((d) => [d.marker, d.reason, d.fullCheckRan]), [
      ['unclean', 'new_file', false],
      ['clean', 'ok', false],
      ['clean', 'ok', true],
      ['unclean', 'marker_missing', true],
    ]);
    assert.equal(typeof diags[3].timings.integrityMs, 'number');
    assert.equal(diags[1].timings.integrityMs, undefined);
    for (const key of ['openRoMs', 'schemaMs', 'openRwMs', 'walMs', 'migrateMs', 'totalMs']) assert.equal(typeof diags[1].timings[key], 'number', key);
  });

  it('skips integrity_check after a clean close, but not after a crash, marker mismatch or fullCheck', () => {
    open().close();
    const count = (o) => { const log = []; open({ loadSqlite: recordingSqlite(log), ...o }).close(); return log.filter((q) => q === 'PRAGMA integrity_check').length; };
    const marker = path.join(dir, `${DEFAULT_STORAGE_DB_FILENAME}.clean`);
    assert.ok(fs.existsSync(marker));
    assert.equal(count({}), 0);
    assert.equal(count({ fullCheck: true }), 1);
    // Unclean: open and never close, marker is already consumed.
    const crashed = open();
    assert.equal(fs.existsSync(marker), false);
    crashed.close();
    fs.unlinkSync(marker);
    assert.equal(count({}), 1);
    // A marker that does not match the file (size/mtime mismatch) is ignored.
    fs.writeFileSync(marker, JSON.stringify({ size: 1, mtimeMs: 1 }));
    assert.equal(count({}), 1);
  });

  it('forces a full check for a matching marker with leftover -wal, malformed or aged markers, env override, abandon and dirty close', () => {
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const marker = `${file}.clean`;
    const count = (o) => { const log = []; open({ loadSqlite: recordingSqlite(log), ...o }).close(); return log.filter((q) => q === 'PRAGMA integrity_check').length; };
    open().close();
    const good = fs.readFileSync(marker, 'utf8');
    fs.writeFileSync(`${file}-wal`, 'x');
    assert.equal(count({}), 1);
    fs.rmSync(`${file}-wal`, { force: true });
    open().close();
    fs.writeFileSync(marker, '{not json');
    assert.equal(count({}), 1);
    fs.writeFileSync(marker, good);
    const aged = JSON.parse(good);
    aged.lastFullCheckAt = Date.now() - 8 * 24 * 3600 * 1000;
    fs.writeFileSync(marker, JSON.stringify(aged));
    assert.equal(count({}), 1);
    open().close();
    process.env.CRETLI_STORAGE_FULL_CHECK = '1';
    try { assert.equal(count({}), 1); } finally { delete process.env.CRETLI_STORAGE_FULL_CHECK; }
    open().close();
    assert.equal(count({}), 0);
    open().close();
    open().close({ clean: false });
    assert.equal(fs.existsSync(marker), false);
    const tainted = open();
    tainted.markDirty();
    tainted.close();
    assert.equal(fs.existsSync(marker), false);
    assert.equal(count({}), 1);
  });

  it('still detects corruption introduced behind a stale clean marker', () => {
    const handle = open();
    handle.db.exec('BEGIN');
    const insert = handle.db.prepare(insertReceiptSql);
    for (let i = 0; i < 2000; i += 1) insert.run('g', `cmd-${i}`, `digest-${i}`, JSON.stringify({ i, pad: 'x'.repeat(64) }), i);
    handle.db.exec('COMMIT');
    handle.close();
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const bytes = fs.readFileSync(file);
    for (let offset = 4096 * 3; offset < 4096 * 6; offset += 1) bytes[offset] = (offset * 31) & 0xff;
    fs.writeFileSync(file, bytes);
    assert.equal(captureStorageError(() => open()).code, 'corrupt');
  });

  it('runs integrity_check once on an existing store and skips the post-migration FK check when nothing ran', () => {
    open().close();
    const log = [];
    open({ loadSqlite: recordingSqlite(log), fullCheck: true }).close();
    assert.equal(log.filter((sql) => sql === 'PRAGMA integrity_check').length, 1);
    assert.equal(log.filter((sql) => sql === 'PRAGMA foreign_key_check').length, 1);
    assert.equal(log.filter((sql) => sql === 'BEGIN IMMEDIATE').length, 0);
  });

  it('runs foreign_key_check after migrations only when one was applied', () => {
    const fresh = [];
    open({ loadSqlite: recordingSqlite(fresh) }).close();
    // A new file has nothing to check before the migration; the FK check runs once after it.
    assert.equal(fresh.filter((sql) => sql === 'PRAGMA integrity_check').length, 0);
    assert.equal(fresh.filter((sql) => sql === 'PRAGMA foreign_key_check').length, 1);
    const upgrade = [];
    open({ loadSqlite: recordingSqlite(upgrade), fullCheck: true, migrations: [...CORE_MIGRATIONS, fkFixtureMigration] }).close();
    assert.equal(upgrade.filter((sql) => sql === 'PRAGMA integrity_check').length, 1);
    assert.equal(upgrade.filter((sql) => sql === 'PRAGMA foreign_key_check').length, 2);
    assert.equal(upgrade.filter((sql) => sql === 'BEGIN IMMEDIATE').length, 1);
  });
});

describe('openStorageDb recovery and journal modes', () => {
  it('reopens a crash copy with hot -wal/-shm and keeps committed rows', () => {
    const live = open();
    const insert = live.db.prepare(insertReceiptSql);
    for (let i = 0; i < 50; i += 1) insert.run('g', `c${i}`, 'd', '{}', i);
    const walPath = path.join(dir, `${DEFAULT_STORAGE_DB_FILENAME}-wal`);
    assert.ok(fs.statSync(walPath).size > 0, 'writes must still be in the WAL');
    const crashDir = path.join(root, 'crash');
    copyStoreFiles(crashDir);
    live.close();
    const copy = open({ dir: crashDir });
    assert.equal(copy.db.prepare('SELECT count(*) AS n FROM command_receipts').get().n, 50);
  });

  it('converts an existing DELETE-journal store to WAL and keeps its data', () => {
    open().close();
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const raw = rawOpen(file);
    assert.equal(raw.prepare('PRAGMA journal_mode = DELETE').get().journal_mode, 'delete');
    raw.prepare(insertReceiptSql).run('g', 'legacy', 'd', '{"v":1}', 1);
    raw.close();
    assert.equal(fs.existsSync(`${file}-wal`), false);
    const handle = open();
    assert.equal(handle.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(handle.db.prepare('SELECT result_json FROM command_receipts WHERE command_id = ?').get('legacy').result_json, '{"v":1}');
  });

  it('rolls back a hot rollback journal (DELETE-mode crash copy) before checking', () => {
    open().close();
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const setup = rawOpen(file);
    setup.exec('PRAGMA journal_mode = DELETE');
    setup.prepare(insertReceiptSql).run('g', 'committed', 'd', '{}', 1);
    setup.close();
    const writer = rawOpen(file);
    // A tiny cache forces SQLite to spill uncommitted pages into the main file.
    writer.exec('PRAGMA cache_size = 1; BEGIN IMMEDIATE');
    const insert = writer.prepare(insertReceiptSql);
    for (let i = 0; i < 500; i += 1) insert.run('g', `uncommitted-${i}`, 'd', JSON.stringify({ pad: 'x'.repeat(200) }), i);
    assert.ok(fs.existsSync(`${file}-journal`));
    const crashDir = path.join(root, 'crash-journal');
    copyStoreFiles(crashDir);
    writer.exec('ROLLBACK');
    const copy = open({ dir: crashDir });
    const ids = copy.db.prepare('SELECT command_id FROM command_receipts').all().map((r) => r.command_id);
    assert.deepEqual(ids, ['committed']);
  });

  it('refuses a corrupt main file with WAL frames and leaves the main file and -wal bytes unchanged', () => {
    const live = open();
    const insert = live.db.prepare(insertReceiptSql);
    live.db.exec('BEGIN');
    for (let i = 0; i < 2000; i += 1) insert.run('g', `cmd-${i}`, `digest-${i}`, JSON.stringify({ i, pad: 'x'.repeat(64) }), i);
    live.db.exec('COMMIT');
    live.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    insert.run('g', 'zz-in-wal', 'd', '{}', 1);
    const pageSize = Number(live.db.prepare('PRAGMA page_size').get().page_size);
    const crashDir = path.join(root, 'crash-corrupt');
    copyStoreFiles(crashDir);
    live.close();
    const file = path.join(crashDir, DEFAULT_STORAGE_DB_FILENAME);
    const bytes = fs.readFileSync(file);
    for (let offset = pageSize * 3; offset < pageSize * 6; offset += 1) bytes[offset] = (offset * 31) & 0xff;
    fs.writeFileSync(file, bytes);
    const before = { db: digestFile(file), wal: digestFile(`${file}-wal`) };
    assert.ok(fs.statSync(`${file}-wal`).size > 0);
    const err = captureStorageError(() => open({ dir: crashDir }));
    assert.equal(err.code, 'corrupt');
    // The checks ran on a read-only connection, which never checkpoints on
    // close; only the -shm index may be rebuilt.
    assert.deepEqual({ db: digestFile(file), wal: digestFile(`${file}-wal`) }, before);
  });
});

describe('openStorageDb concurrent first creation', () => {
  it('two threads creating the same store apply the schema once without error', async () => {
    const dbModule = new URL('../lib/storage/db-lifecycle.js', import.meta.url).href;
    const workerSource = `
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        const { openStorageDb } = await import(workerData.dbModule);
        const gate = new Int32Array(workerData.barrier);
        Atomics.add(gate, 0, 1);
        while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, Atomics.load(gate, 0), 50);
        try {
          const handle = openStorageDb({ dir: workerData.dir, busyTimeoutMs: 30000 });
          const version = handle.schemaVersion;
          handle.close();
          parentPort.postMessage({ ok: true, version });
        } catch (err) {
          parentPort.postMessage({ ok: false, error: String(err && err.stack || err) });
        }
      })();
    `;
    for (let round = 0; round < 5; round += 1) {
      const roundDir = path.join(root, `race-${round}`);
      fs.mkdirSync(roundDir);
      const barrier = new SharedArrayBuffer(4);
      const results = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
        const worker = new Worker(workerSource, { eval: true, workerData: { dir: roundDir, dbModule, barrier } });
        worker.once('message', resolve);
        worker.once('error', reject);
      })));
      for (const result of results) assert.deepEqual(result, { ok: true, version: CORE_MIGRATIONS.length }, JSON.stringify(result));
      const raw = rawOpen(path.join(roundDir, DEFAULT_STORAGE_DB_FILENAME));
      assert.deepEqual(raw.prepare('SELECT version FROM schema_version').all().map((r) => r.version), CORE_MIGRATIONS.map((m) => m.version));
      raw.close();
    }
  });
});

describe('openStorageDb path types and create:false', () => {
  it('refuses a directory at the database path with typed io', () => {
    fs.mkdirSync(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'io');
    assert.equal(err.retryable, false);
  });

  it('refuses a FIFO at the database path with typed io', (t) => {
    const fifo = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      t.skip('mkfifo is not available');
      return;
    }
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'io');
    assert.equal(err.retryable, false);
  });

  it('create:false reports missing for an absent or zero-length file and creates nothing', () => {
    assert.equal(captureStorageError(() => open({ create: false })).code, 'missing');
    assert.deepEqual(fs.readdirSync(dir), []);
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    fs.writeFileSync(file, '');
    assert.equal(captureStorageError(() => open({ create: false })).code, 'missing');
    assert.equal(fs.statSync(file).size, 0);
    assert.deepEqual(fs.readdirSync(dir), [DEFAULT_STORAGE_DB_FILENAME]);
  });

  it('create:false opens an existing store', () => {
    open().close();
    assert.equal(open({ create: false }).schemaVersion, CORE_MIGRATIONS.length);
  });
});

describe('openStorageDb store identity', () => {
  it('brands the file with application_id and mirrors the version in user_version', () => {
    const { db } = open();
    assert.equal(Number(db.prepare('PRAGMA application_id').get().application_id), STORAGE_APPLICATION_ID);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), CORE_MIGRATIONS.length);
  });

  it('refuses a file with another non-zero application_id as conflict without touching it', () => {
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const foreign = rawOpen(file);
    foreign.exec('PRAGMA application_id = 42; CREATE TABLE other (id INTEGER PRIMARY KEY);');
    foreign.close();
    const before = digestFile(file);
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.operation, 'open_application_id');
    assert.equal(digestFile(file), before);
  });

  it('reports conflict, not corrupt, for a newer store whose schema this build cannot parse', () => {
    open().close();
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const raw = rawOpen(file);
    const probeSql = 'CREATE TABLE zz_future_probe (id INTEGER PRIMARY KEY)';
    raw.exec(`PRAGMA user_version = 9; ${probeSql};`);
    raw.close();
    // Patch the stored DDL in place (same length) so this build cannot parse it.
    const bytes = fs.readFileSync(file);
    const at = bytes.indexOf(probeSql);
    assert.ok(at > 0);
    bytes.write('CREATE TABLE zz_future_probe (id FUTURE!SYNTAX@@@@@@)', at, 'latin1');
    fs.writeFileSync(file, bytes);
    const probe = rawOpen(file);
    assert.throws(() => probe.prepare('SELECT count(*) FROM sqlite_schema').get());
    probe.close();
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.actualRevision, 9);
  });

  it('reports a gap in schema_version as corrupt', () => {
    const migrations = [
      ...CORE_MIGRATIONS,
      { version: CORE_MIGRATIONS.length + 1, name: 'two', sql: 'CREATE TABLE two (id INTEGER PRIMARY KEY) STRICT;' },
      { version: CORE_MIGRATIONS.length + 2, name: 'three', sql: 'CREATE TABLE three (id INTEGER PRIMARY KEY) STRICT;' },
    ];
    open({ migrations }).close();
    const raw = rawOpen(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    raw.exec('DELETE FROM schema_version WHERE version = 2');
    raw.close();
    const err = captureStorageError(() => open({ migrations }));
    assert.equal(err.code, 'corrupt');
    assert.equal(err.details.actualRevision, 3);
  });

  it('reports a schema_version name mismatch as conflict', () => {
    open().close();
    const raw = rawOpen(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    raw.prepare("UPDATE schema_version SET name = 'someone-else' WHERE version = 1").run();
    raw.close();
    assert.equal(captureStorageError(() => open()).code, 'conflict');
  });
});

describe('schema migrations', () => {
  it('refuses a newer-than-known schema with conflict and keeps it', () => {
    open().close();
    const file = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
    const raw = rawOpen(file);
    raw.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (99, ?, 0)').run('future');
    raw.close();
    const err = captureStorageError(() => open());
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.actualRevision, 99);
    const check = rawOpen(file);
    assert.equal(readSchemaVersion(check), 99);
  });

  it('applies a failing migration batch atomically (fresh database)', () => {
    const migrations = [
      { version: 1, name: 'one', sql: 'CREATE TABLE one (id INTEGER PRIMARY KEY) STRICT;' },
      {
        version: 2,
        name: 'two',
        up: (/** @type {DatabaseSync} */ db) => {
          db.exec('CREATE TABLE two (id INTEGER PRIMARY KEY) STRICT;');
          throw new Error('injected failure mid-migration');
        },
      },
    ];
    const failure = captureStorageError(() => open({ migrations }));
    assert.equal(failure.code, 'io');
    assert.equal(failure.retryable, false);
    const raw = rawOpen(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    assert.equal(readSchemaVersion(raw), 0);
    assert.equal(hasTable(raw, 'one'), false);
    assert.equal(hasTable(raw, 'two'), false);
    assert.equal(hasTable(raw, 'schema_version'), false);
  });

  it('keeps the previous version when a later migration fails', () => {
    open().close();
    const failing = [
      ...CORE_MIGRATIONS,
      { version: CORE_MIGRATIONS.length + 1, name: 'ok', sql: 'CREATE TABLE extra_ok (id INTEGER PRIMARY KEY) STRICT;' },
      { version: CORE_MIGRATIONS.length + 2, name: 'bad', sql: 'CREATE TABLE extra_bad (id INTEGER PRIMARY KEY) STRICT; SELECT * FROM no_such_table;' },
    ];
    captureStorageError(() => open({ migrations: failing }));
    const raw = rawOpen(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    assert.equal(readSchemaVersion(raw), CORE_MIGRATIONS.length);
    assert.equal(hasTable(raw, 'extra_ok'), false);
    assert.equal(hasTable(raw, 'extra_bad'), false);
  });

  it('rejects malformed migration lists', () => {
    const db = rawOpen(':memory:');
    assert.throws(() => applyMigrations(db, { migrations: [] }), TypeError);
    assert.throws(() => applyMigrations(db, { migrations: [{ version: 2, name: 'x', sql: '' }] }), TypeError);
    assert.throws(() => applyMigrations(db, { migrations: [{ version: 1, name: 'x' }] }), TypeError);
    assert.throws(() => applyMigrations(db, { migrations: [{ version: 1, name: 'x', sql: '', up: () => {} }] }), TypeError);
  });

  it('creates infrastructure and pilot history tables in the core schema', () => {
    const { db } = open();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables, [
      'chat_history_dedupe', 'chat_history_epochs', 'chat_history_event_extra', 'chat_history_events', 'chat_history_meta',
      'chat_history_producers', 'chat_history_stage', 'chat_history_stage_fragment', 'chat_history_state', 'command_receipts', 'decision_meta', 'decisions', 'schema_version', 'storage_dataset_binding', 'storage_fencing', 'todo_docs', 'todos',
    ]);
  });

  it('upgrades the A2 schema without replacing durable receipts or fencing', () => {
    const previous = open({ migrations: CORE_MIGRATIONS.slice(0, 2) });
    previous.db.prepare(insertReceiptSql).run('g1', 'before-upgrade', 'digest', '{"seq":1}', 1);
    previous.db.exec('UPDATE storage_fencing SET hwm = 7 WHERE id = 1');
    previous.close();
    const upgraded = open();
    assert.equal(upgraded.schemaVersion, CORE_MIGRATIONS.length);
    assert.equal(upgraded.db.prepare('SELECT result_json FROM command_receipts WHERE command_id = ?').get('before-upgrade').result_json, '{"seq":1}');
    assert.equal(upgraded.db.prepare('SELECT hwm FROM storage_fencing WHERE id = 1').get().hwm, 7);
    assert.equal(hasTable(upgraded.db, 'chat_history_events'), true);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

describe('command_receipts constraints', () => {
  it('rejects a duplicate (dataset_generation, command_id) even with another digest', () => {
    const { db } = open();
    const insert = db.prepare(insertReceiptSql);
    insert.run('g1', 'c1', 'digest-a', '{"r":1}', 1);
    const err = toStorageError(captureThrown(() => insert.run('g1', 'c1', 'digest-b', '{"r":2}', 2)), 'receipt');
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.constraintKind, 'primary_key');
    // Same command id in another dataset generation is a different receipt.
    insert.run('g2', 'c1', 'digest-b', '{"r":2}', 2);
    const row = db.prepare('SELECT request_digest, result_json FROM command_receipts WHERE dataset_generation = ? AND command_id = ?').get('g1', 'c1');
    assert.deepEqual({ ...row }, { request_digest: 'digest-a', result_json: '{"r":1}' });
  });

  it('rejects invalid JSON, empty or blank ids and negative timestamps', () => {
    const { db } = open();
    const insert = db.prepare(insertReceiptSql);
    const bad = [
      [['g', 'c', 'd', '{not json', 0], 'check'],
      [['', 'c', 'd', '{}', 0], 'check'],
      [['g', '', 'd', '{}', 0], 'check'],
      [['g', '   ', 'd', '{}', 0], 'check'],
      [['g', 'c', '', '{}', 0], 'check'],
      [['g', 'c', 'd', '{}', -1], 'check'],
      [['g', 'c', 'd', null, 0], 'not_null'],
      [['g', 'c'.repeat(201), 'd', '{}', 0], 'check'],
    ];
    for (const [args, kind] of bad) {
      const err = toStorageError(captureThrown(() => insert.run(...args)), 'receipt');
      assert.equal(err.code, 'conflict', JSON.stringify(args));
      assert.equal(err.retryable, false);
      assert.equal(err.details.constraintKind, kind, JSON.stringify(args));
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM command_receipts').get().n, 0);
  });

  it('enforces STRICT column types (datatype, 3091)', () => {
    const { db } = open();
    const err = toStorageError(captureThrown(() => db.prepare(insertReceiptSql).run('g', 'c', 'd', '{}', 'not-a-number')), 'receipt');
    assert.equal(err.details.sqliteCode, 3091);
    assert.equal(err.details.constraintKind, 'datatype');
    assert.equal(err.code, 'conflict');
  });

  it('maps a real foreign key violation (787)', () => {
    const migrations = [...CORE_MIGRATIONS, fkFixtureMigration];
    const { db } = open({ migrations });
    const err = toStorageError(captureThrown(() => db.exec('INSERT INTO child (id, parent_id) VALUES (1, 42)')), 'insert');
    assert.equal(err.details.sqliteCode, 787);
    assert.equal(err.details.constraintKind, 'foreign_key');
    assert.equal(err.retryable, false);
  });
});

describe('chat history schema constraints', () => {
  it('retains producer identities after trimming events and rotating the chat generation', () => {
    const { db } = open();
    db.exec(`
      INSERT INTO chat_history_state VALUES ('chat', 'g1', 'e1', 1, 2, 100, 0, 1);
      INSERT INTO chat_history_epochs VALUES ('chat', 'g1', 'e1', 1);
      INSERT INTO chat_history_producers VALUES ('g1', 'chat', 'p1', 'e1', 'active', 1, NULL);
      INSERT INTO chat_history_events VALUES ('g1', 'chat', 1, 'e1', 'p1', 1, 'message', '{}', 1, 1);
      INSERT INTO chat_history_dedupe VALUES ('g1', 'chat', 'p1', 1, 'e1', 1, 'digest', '{"seq":1}', 1);
      DELETE FROM chat_history_events WHERE chat_id = 'chat';
      UPDATE chat_history_state SET dataset_generation = 'g2', chat_epoch = 'e2' WHERE chat_id = 'chat';
    `);
    assert.equal(db.prepare('SELECT event_seq FROM chat_history_dedupe').get().event_seq, 1);
    assert.equal(db.prepare('SELECT chat_epoch FROM chat_history_epochs').get().chat_epoch, 'e1');
    assert.throws(() => db.exec("INSERT INTO chat_history_epochs VALUES ('chat', 'g1', 'e1', 2)"), /UNIQUE constraint failed/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.exec('DELETE FROM chat_history_producers'), /FOREIGN KEY constraint failed/);
    assert.throws(() => db.exec("UPDATE chat_history_state SET next_seq = 0"), /CHECK constraint failed/);
    assert.throws(() => db.exec("UPDATE chat_history_dedupe SET result_json = 'invalid'"), /CHECK constraint failed/);
  });
});

describe('toStorageError mapping', () => {
  /**
   * @param {number} errcode
   */
  const sqliteErr = (errcode) => Object.assign(new Error('sqlite'), { code: 'ERR_SQLITE_ERROR', errcode });

  it('maps SQLite primary and extended result codes', () => {
    const cases = [
      [5, 'busy'], [6, 'busy'], [517, 'busy'],
      [13, 'full_disk'],
      [14, 'io'], [10, 'io'], [266, 'io'],
      [26, 'corrupt'], [11, 'corrupt'], [267, 'corrupt'],
      [19, 'conflict'], [1555, 'conflict'], [275, 'conflict'],
      [1, 'io'], [21, 'io'], [8, 'io'], [250, 'io'],
    ];
    for (const [errcode, code] of cases) {
      const err = toStorageError(sqliteErr(errcode));
      assert.equal(err.code, code, String(errcode));
      assert.equal(err.details.sqliteCode, errcode);
    }
  });

  it('marks only lock contention and real I/O failures retryable', () => {
    const retryable = [5, 6, 517, 10, 266, 7];
    const deterministic = [1, 21, 8, 14, 11, 26, 13, 19, 787, 250];
    for (const errcode of retryable) assert.equal(toStorageError(sqliteErr(errcode)).retryable, true, String(errcode));
    for (const errcode of deterministic) assert.equal(toStorageError(sqliteErr(errcode)).retryable, false, String(errcode));
    assert.equal(toStorageError(new Error('migration code threw')).retryable, false);
    assert.equal(toStorageError(Object.assign(new Error('x'), { code: 'EIO' })).retryable, true);
    assert.equal(toStorageError(Object.assign(new Error('x'), { code: 'EACCES' })).retryable, false);
  });

  it('exposes the constraint kind in safe details', () => {
    const kinds = [[1555, 'primary_key'], [2067, 'unique'], [275, 'check'], [1299, 'not_null'], [787, 'foreign_key'], [3091, 'datatype'], [1811, 'other']];
    for (const [errcode, kind] of kinds) {
      const json = toStorageError(sqliteErr(errcode), 'receipt').toJSON();
      assert.equal(json.code, 'conflict');
      assert.equal(json.retryable, false);
      assert.deepEqual(json.details, { operation: 'receipt', sqliteCode: errcode, constraintKind: kind });
    }
    assert.equal(toStorageError(sqliteErr(10)).details.constraintKind, undefined);
  });

  it('maps filesystem errno codes and passes StorageError through', () => {
    assert.equal(toStorageError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code, 'full_disk');
    assert.equal(toStorageError(Object.assign(new Error('x'), { code: 'ENOENT' })).code, 'missing');
    assert.equal(toStorageError(new Error('plain')).code, 'io');
    const original = new StorageError('busy');
    assert.equal(toStorageError(original), original);
    assert.equal(toStorageError(original.toJSON()).code, 'busy');
  });

  it('does not leak paths through toJSON', () => {
    const err = toStorageError(Object.assign(new Error('open /secret/path/db failed'), { errcode: 14 }), 'open');
    const json = JSON.stringify(err);
    assert.ok(!json.includes('/secret/path'));
    assert.equal(err.toJSON().details.operation, 'open');
  });

  it('maps a real lock timeout to busy when a migration is pending', () => {
    const holder = open({ busyTimeoutMs: 0 });
    holder.db.exec('BEGIN IMMEDIATE');
    const pending = [...CORE_MIGRATIONS, { version: CORE_MIGRATIONS.length + 1, name: 'extra', sql: 'CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT;' }];
    // Only a pending migration takes the write lock, so this open sees the holder.
    const err = captureStorageError(() => open({ busyTimeoutMs: 0, migrations: pending }));
    assert.equal(err.code, 'busy');
    assert.equal(err.retryable, true);
    holder.db.exec('ROLLBACK');
    open({ busyTimeoutMs: 0, migrations: pending }).close();
  });

  it('opens an up-to-date store without taking the write lock', () => {
    const holder = open({ busyTimeoutMs: 0 });
    holder.db.exec('BEGIN IMMEDIATE');
    const second = open({ busyTimeoutMs: 0 });
    assert.equal(second.schemaVersion, CORE_MIGRATIONS.length);
    holder.db.exec('ROLLBACK');
  });
});

/**
 * @param {() => unknown} fn
 * @returns {unknown}
 */
function captureThrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw');
}

describe('runWalTruncateBarrier', () => {
  it('checkpoints every WAL frame and resets the WAL file', () => {
    const handle = open();
    handle.db.exec('CREATE TABLE barrier_probe (v TEXT)');
    for (let index = 0; index < 20; index += 1) handle.db.prepare('INSERT INTO barrier_probe VALUES (?)').run(`row-${index}`);
    const walPath = path.join(dir, `${DEFAULT_STORAGE_DB_FILENAME}-wal`);
    assert.ok(fs.statSync(walPath).size > 0);
    const result = runWalTruncateBarrier(handle.db);
    assert.equal(result.busy, 0);
    assert.equal(result.checkpointed, result.log);
    assert.equal(fs.statSync(walPath).size, 0);
  });

  it('throws when a reader keeps the checkpoint from completing', () => {
    const handle = open();
    handle.db.exec('CREATE TABLE barrier_probe (v TEXT)');
    handle.db.prepare('INSERT INTO barrier_probe VALUES (?)').run('a');
    const reader = new DatabaseSync(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM barrier_probe').all();
      handle.db.prepare('INSERT INTO barrier_probe VALUES (?)').run('b');
      handle.db.exec('PRAGMA busy_timeout = 0');
      assert.throws(() => runWalTruncateBarrier(handle.db), /did not complete|locked|busy/i);
    } finally {
      reader.close();
    }
  });
});

describe('runWalTruncateBarrierBounded with a reader in another process', () => {
  /** Spawns a process holding a read transaction until stdin closes. */
  async function spawnReader(holdMs) {
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN');
      db.prepare('SELECT * FROM barrier_probe').all();
      process.stdout.write('held\\n');
      process.stdin.resume();
      process.stdin.on('end', () => { db.close(); process.exit(0); });
      if (Number(process.argv[2]) > 0) setTimeout(() => { db.close(); process.exit(0); }, Number(process.argv[2]));
    `;
    const child = spawn(process.execPath, ['-e', script, path.join(dir, DEFAULT_STORAGE_DB_FILENAME), String(holdMs ?? 0)], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    return { release: () => { child.stdin.end(); return exited; } };
  }

  function prepare() {
    const handle = open();
    handle.db.exec('CREATE TABLE barrier_probe (v TEXT)');
    handle.db.prepare('INSERT INTO barrier_probe VALUES (?)').run('a');
    return handle;
  }

  it('waits for the reader and succeeds after it releases', async () => {
    const handle = prepare();
    const reader = await spawnReader(400);
    handle.db.prepare('INSERT INTO barrier_probe VALUES (?)').run('b');
    handle.db.exec('PRAGMA busy_timeout = 0');
    // The blocking sleep also blocks this thread, so the reader releases itself.
    const started = Date.now();
    let sleeps = 0;
    const result = await new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(runWalTruncateBarrierBounded(handle.db, { maxWaitMs: 10000, sleep: () => { sleeps += 1; const t = Date.now() + 50; while (Date.now() < t) { /* spin */ } } }));
        } catch (err) { reject(err); }
      });
    });
    assert.equal(result.busy, 0);
    assert.ok(sleeps > 0, 'the barrier must have waited for the reader');
    assert.ok(Date.now() - started >= 300 - 50);
    assert.ok(Date.now() - started < 10000);
    await reader.release();
  });

  it('fails closed with a non-retryable explicit code when the reader outlives the wait', async () => {
    const handle = prepare();
    const reader = await spawnReader();
    handle.db.prepare('INSERT INTO barrier_probe VALUES (?)').run('b');
    handle.db.exec('PRAGMA busy_timeout = 0');
    try {
      const err = captureThrown(() => runWalTruncateBarrierBounded(handle.db, { maxWaitMs: 300 }));
      assert.ok(err instanceof StorageError);
      assert.equal(err.details.operation, CHECKPOINT_BLOCKED_BY_READER);
      // Non-retryable: the host fails at once instead of burning maxStartAttempts.
      assert.equal(err.retryable, false);
    } finally {
      await reader.release();
    }
  });

  it('completes on the first attempt without readers (F29 unchanged)', () => {
    const handle = prepare();
    let sleeps = 0;
    const result = runWalTruncateBarrierBounded(handle.db, { sleep: () => { sleeps += 1; } });
    assert.equal(result.busy, 0);
    assert.equal(sleeps, 0);
  });
});
