import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, CORE_MIGRATIONS, inspectSchemaVersions, readHeaderSchemaVersion } from '../lib/storage/migrations.js';
import { openStorageDb } from '../lib/storage/db-lifecycle.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { fileURLToPath } from 'node:url';
import { openChatsDb, tempDir } from './fixtures/storage-chats-helpers.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-chats-handlers.js', import.meta.url));
const LIST_INDEXES = ['chats_global_live', 'chats_global_archived', 'chats_folder_live', 'chats_folder_archived',
  'chats_file_live', 'chats_file_archived', 'chats_widget_live', 'chats_widget_archived'];

/** @type {string} */ let dir;
beforeEach(() => { dir = tempDir('cretli-chats-schema-'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('schema 0009', () => {
  it('is the ninth core migration and pins the migration count', () => {
    assert.equal(CORE_MIGRATIONS.length, 10);
    assert.deepEqual(CORE_MIGRATIONS.slice(7, 10).map((m) => [m.version, m.name]), [[8, 'decisions'], [9, 'chats'], [10, 'initiatives']]);
  });

  it('upgrades a v8 store in place and creates a fresh v9 store', () => {
    const file = path.join(dir, 'upgrade.sqlite');
    const old = new DatabaseSync(file);
    assert.deepEqual(applyMigrations(old, { migrations: CORE_MIGRATIONS.slice(0, 8) }).applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(old.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'chats'").get().n, 0);
    const up = applyMigrations(old, { migrations: CORE_MIGRATIONS.slice(0, 9) });
    assert.deepEqual({ previous: up.previousVersion, version: up.version, applied: up.applied }, { previous: 8, version: 9, applied: [9] });
    assert.equal(readHeaderSchemaVersion(old), 9);
    assert.deepEqual(old.prepare('SELECT id, format_version, store_revision, row_count, next_position FROM chat_store_meta').all().map((r) => ({ ...r })),
      [{ id: 1, format_version: 1, store_revision: 0, row_count: 0, next_position: 0 }]);
    old.close();
    const fresh = openChatsDb();
    assert.equal(inspectSchemaVersions(fresh), CORE_MIGRATIONS.length);
    for (const table of ['chats', 'chat_details', 'chat_scope_counts', 'chat_store_meta']) {
      assert.equal(fresh.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table).strict, 1, `${table} is STRICT`);
    }
  });

  it('refuses a newer schema and an older binary after migration', () => {
    const db = openChatsDb();
    db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (11, ?, 0)').run('future');
    assert.throws(() => inspectSchemaVersions(db), (err) => err.code === 'conflict');
    const file = path.join(dir, 'v9.sqlite');
    const store = new DatabaseSync(file);
    applyMigrations(store, { migrations: CORE_MIGRATIONS.slice(0, 9) });
    // A binary that only knows migrations 1..8 must not write to a v9 store.
    assert.throws(() => applyMigrations(store, { migrations: CORE_MIGRATIONS.slice(0, 8) }), (err) => err.code === 'conflict');
    store.close();
  });

  it('opens chats.sqlite through the filename option of the storage lifecycle and of the worker host', async () => {
    const handle = openStorageDb({ dir, filename: 'chats.sqlite', create: true });
    assert.equal(handle.schemaVersion, CORE_MIGRATIONS.length);
    handle.close();
    const host = createStorageWorkerHost({ dbDir: dir, filename: 'chats.sqlite', handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
    try {
      await host.start();
      assert.deepEqual((await host.query('chats.counts', {})).total, 0);
    } finally {
      await host.close({ timeoutMs: 1000 });
    }
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')), ['chats.sqlite']);
  });

  it('keeps the index budget: 8 list index definitions, at most 4 list indexes per row, no counters index on chats', () => {
    const db = openChatsDb();
    const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'chats' AND sql IS NOT NULL ORDER BY name").all();
    const names = indexes.map((i) => i.name);
    const list = names.filter((n) => LIST_INDEXES.includes(n));
    assert.deepEqual([...list].sort(), [...LIST_INDEXES].sort());
    // Everything else is a relation index; none of them serves counters.
    assert.deepEqual(names.filter((n) => !LIST_INDEXES.includes(n)).sort(), ['chats_by_cursor_session', 'chats_by_parent', 'chats_by_todo']);
    assert.ok(indexes.every((i) => !/count/i.test(i.name)));
    // Worst-case row (widget + folder + file): the live/archived halves are exclusive, so one index per scope.
    const worst = ['chats_global', 'chats_folder', 'chats_file', 'chats_widget'];
    for (const half of ['live', 'archived']) {
      assert.equal(worst.filter((prefix) => list.includes(`${prefix}_${half}`)).length, 4);
    }
    const predicates = Object.fromEntries(indexes.map((i) => [i.name, i.sql]));
    for (const prefix of worst) {
      assert.match(predicates[`${prefix}_live`], /archived_at = ''/);
      assert.match(predicates[`${prefix}_archived`], /archived_at <> ''/);
    }
    // Table and index set of the counters.
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'chat_scope_counts' AND sql IS NOT NULL").all(), []);
    const pk = db.prepare("SELECT name FROM pragma_table_info('chat_scope_counts') WHERE pk > 0 ORDER BY pk").all().map((r) => r.name);
    assert.deepEqual(pk, ['workspace_file', 'workspace_folder', 'archived']);
  });
});
