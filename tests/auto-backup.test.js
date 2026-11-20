import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createAutoBackup, lastSqliteBackupAt, pruneAutoBackups } from '../lib/backup/auto-backup.js';
import { guardJsonShrink } from '../lib/backup/shrink-guard.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

test('auto backup writes a manifest with hashes, sizes and JSON record counts using private modes', async () => {
  fs.mkdirSync(path.join(ISOLATED_DATA_DIR, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: [{ id: 'a' }, { id: 'b' }] }));
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'todos', 'x.json'), JSON.stringify({ items: [{ id: 'x' }] }));
  const { path: backup } = await createAutoBackup({ dataDir: ISOLATED_DATA_DIR, includeSqlite: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.find((e) => e.path === 'chats.json').records, 2);
  for (const entry of manifest.entries) assert.equal(fs.statSync(path.join(backup, entry.path)).size, entry.size);
  assert.equal(fs.statSync(backup).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(backup, 'manifest.json')).mode & 0o077, 0);
});

test('retention prunes old backup directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-backups-'));
  try {
    for (let i = 0; i < 27; i += 1) fs.mkdirSync(path.join(root, `b${i}`));
    const removed = pruneAutoBackups(root);
    assert.equal(removed, 3);
    assert.equal(fs.readdirSync(root).length, 24);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('shrink guard preserves a large record loss before writes', () => {
  const file = path.join(ISOLATED_DATA_DIR, 'chats.json');
  fs.writeFileSync(file, JSON.stringify({ chats: Array.from({ length: 100 }, (_, id) => ({ id })) }));
  const alerts = [];
  const backup = guardJsonShrink(file, { chats: Array.from({ length: 40 }, (_, id) => ({ id })) }, { logger: { error: (msg) => alerts.push(msg) } });
  assert.ok(backup && fs.existsSync(backup));
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).chats.length, 100);
  assert.equal(alerts.length, 1);
});

test('small record drops do not create a pre-shrink copy', () => {
  for (const name of fs.readdirSync(ISOLATED_DATA_DIR).filter((entry) => entry.includes('.pre-shrink-'))) fs.rmSync(path.join(ISOLATED_DATA_DIR, name), { force: true });
  const file = path.join(ISOLATED_DATA_DIR, 'chats.json');
  fs.writeFileSync(file, JSON.stringify({ chats: Array.from({ length: 30 }, (_, id) => ({ id })) }));
  const backup = guardJsonShrink(file, { chats: Array.from({ length: 20 }, (_, id) => ({ id })) });
  assert.equal(backup, null);
  assert.deepEqual(fs.readdirSync(ISOLATED_DATA_DIR).filter((name) => name.includes('.pre-shrink-')), []);
});

test('SQLite snapshot uses the worker and excludes WAL, SHM, and journal sidecars', async () => {
  const dbFile = path.join(ISOLATED_DATA_DIR, 'recovery.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY); INSERT INTO sample VALUES (1)');
  db.close();
  for (const suffix of ['-wal', '-shm', '-journal']) fs.writeFileSync(`${dbFile}${suffix}`, '');
  const { path: backup, manifest } = await createAutoBackup({ dataDir: ISOLATED_DATA_DIR, includeSqlite: true });
  assert.ok(manifest.entries.some((entry) => entry.path === 'recovery.sqlite'));
  assert.ok(!manifest.entries.some((entry) => /-(?:wal|shm|journal)$/.test(entry.path)));
  assert.deepEqual(fs.readdirSync(backup).filter((name) => /-(?:wal|shm|journal)$/.test(name)), []);
  const copied = new DatabaseSync(path.join(backup, 'recovery.sqlite'), { readOnly: true });
  assert.equal(copied.prepare('SELECT COUNT(*) AS n FROM sample').get().n, 1);
  copied.close();
});

test('JSON snapshot is published when a SQLite backup fails and records the error', async () => {
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: [{ id: 'kept' }] }));
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'recovery.sqlite'), 'not a sqlite database');
  const { path: backup, manifest, errors } = await createAutoBackup({ dataDir: ISOLATED_DATA_DIR, includeSqlite: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'chats.json'), 'utf8')).chats[0].id, 'kept');
  assert.ok(errors.some((error) => error.path === 'recovery.sqlite'));
  assert.ok(manifest.errors.some((error) => error.path === 'recovery.sqlite'));
  assert.ok(fs.existsSync(path.join(backup, 'manifest.json')));
});

test('restore command defaults to dry-run and leaves the destination unchanged', async () => {
  const file = path.join(ISOLATED_DATA_DIR, 'chats.json');
  fs.writeFileSync(file, JSON.stringify({ chats: [{ id: 'backup' }] }));
  const { path: backup } = await createAutoBackup({ dataDir: ISOLATED_DATA_DIR, includeSqlite: false });
  fs.writeFileSync(file, JSON.stringify({ chats: [{ id: 'current' }] }));
  const before = fs.readFileSync(file, 'utf8');
  const timestamp = path.basename(backup);
  const run = spawnSync(process.execPath, ['scripts/backup-restore.mjs', '--restore', timestamp, '--only', 'chats.json'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CRETLI_DATA_DIR: ISOLATED_DATA_DIR },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Dry run only/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('only the two newest backups keep their SQLite copies', async () => {
  // Own data dir: backups left by earlier tests would be newer than these and take the two slots.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-backup-sqlite-keep-'));
  try {
    const db = new DatabaseSync(path.join(dataDir, 'recovery.sqlite'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    const made = [];
    for (let i = 0; i < 3; i += 1) {
      const { path: backup } = await createAutoBackup({ dataDir, includeSqlite: true, now: new Date(Date.now() - (3 - i) * 60_000) });
      made.push(backup);
    }
    assert.equal(fs.existsSync(path.join(made[0], 'recovery.sqlite')), false, 'the oldest backup drops its SQLite copy');
    assert.equal(fs.existsSync(path.join(made[0], 'manifest.json')), true, 'its JSON state and manifest stay');
    assert.equal(fs.existsSync(path.join(made[1], 'recovery.sqlite')), true);
    assert.equal(fs.existsSync(path.join(made[2], 'recovery.sqlite')), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the last SQLite backup time is read back from the manifests after a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-backup-last-sqlite-'));
  try {
    assert.equal(lastSqliteBackupAt(dataDir), 0);
    fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({ chats: [] }));
    await createAutoBackup({ dataDir, includeSqlite: false });
    assert.equal(lastSqliteBackupAt(dataDir), 0, 'a JSON-only backup does not count');
    const db = new DatabaseSync(path.join(dataDir, 'recovery.sqlite'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    const at = new Date(Date.now() - 3_600_000);
    await createAutoBackup({ dataDir, includeSqlite: true, now: at });
    assert.equal(lastSqliteBackupAt(dataDir), at.getTime());
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
