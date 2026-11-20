import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import './fixtures/fake-transport.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTodosStore } from '../lib/persist/todos-store.js';
import { withRollbackStateLockSync } from '../lib/persist/todos-backend-rollback.js';
import { openTodosRuntime } from '../lib/persist/todos-runtime.js';
import {
  readTodosBackendMarker, TODOS_BACKEND_MARKER_FILE, TODOS_SQLITE_FILE, writeTodosBackendMarker,
} from '../lib/persist/todos-backend-marker.js';
import {
  activateTodosRollback, applyTodosMigration, assertTodosRollbackSource, canonicalDocsHash, exportTodosRollback, planTodosMigration,
  verifyTodosRollbackExport,
} from '../lib/storage/todos-migration.js';
import { diffDocuments } from '../lib/persist/todos-backend-sqlite.js';
import { upsertWorkspaceWatcher, getWorkspaceWatcher, loadWorkspaceWatchersDocument } from '../lib/persist/workspace-watchers-persist.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { openSqliteTodosBackend, TODOS_GENERATION } from './fixtures/todos-sqlite-harness.js';
import { bootstrapHistoryStore } from '../lib/storage/dataset-binding.js';

const hex = (name) => createHash('sha256').update(name).digest('hex');
const KEYS = { a: hex('ws-a'), b: hex('ws-b'), c: hex('ws-c'), d: hex('ws-d') };
const ts = (n) => `2026-01-0${n}T00:00:00.000Z`;

/** Fixture documents: unknown item fields, unknown top-level field, an old document without version/idempotency, an empty one. */
function fixtureDocs() {
  return {
    [KEYS.a]: {
      version: 3, updatedAt: ts(3), futureDocField: { keep: 'me' },
      items: [
        { id: 'p', title: 'Parent', body: 'hello', status: 'idea', createdAt: ts(1), updatedAt: ts(1), siblingIndex: 0, plan: { markdown: '# plan' }, futureField: { x: 1 } },
        { id: 'c', title: 'Child', body: '', status: 'ready', createdAt: ts(1), updatedAt: ts(2), parentId: 'p', siblingIndex: 0, changelog: [{ kind: 'note', text: 'n', at: ts(2) }], unknown: [1, 2, 3] },
        { id: 'o', title: 'Other', body: 'x'.repeat(500), status: 'done', createdAt: ts(1), updatedAt: ts(3), siblingIndex: 1 },
      ],
      idempotency: { k1: { hash: 'h1', todoId: 'c' } },
    },
    [KEYS.b]: { version: 3, updatedAt: ts(2), items: [{ id: 'b1', title: 'B one', body: '', status: 'idea', createdAt: ts(1), updatedAt: ts(2), siblingIndex: 0 }], idempotency: {} },
    [KEYS.c]: { updatedAt: ts(1), items: [{ id: 'old1', title: 'Old', body: '', status: 'idea', createdAt: ts(1), updatedAt: ts(1) }] },
    [KEYS.d]: { version: 3, updatedAt: ts(1), items: [], idempotency: {} },
  };
}

/** @param {string} dataDir */
function writeFixture(dataDir) {
  const docs = fixtureDocs();
  fs.mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
  for (const [key, doc] of Object.entries(docs)) fs.writeFileSync(path.join(dataDir, 'todos', `${key}.json`), JSON.stringify(doc));
  return docs;
}

/** @param {string} dir */
function hashDir(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')]));
}

/** @type {string} */ let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-sqlite-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const migrate = (dataDir, extra = {}) => {
  const plan = planTodosMigration({ dataDir, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 });
  return { plan, result: applyTodosMigration({ dataDir, datasetGeneration: TODOS_GENERATION, minQuietMs: 0, confirmPlanHash: plan.planHash, ...extra }) };
};

describe('backend marker', () => {
  it('no marker selects the legacy JSON backend and creates nothing', async () => {
    const runtime = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION });
    assert.equal(runtime.backendKind, 'legacy');
    assert.deepEqual(fs.readdirSync(root), []);
    await runtime.close();
  });

  it('a sqlite marker without a store file fails closed and never creates an empty store', async () => {
    writeTodosBackendMarker(root, { backend: 'sqlite', datasetGeneration: TODOS_GENERATION, storeFile: TODOS_SQLITE_FILE }, { expectedRevision: 0 });
    await assert.rejects(openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION }), (e) => e.code === 'todos_store_missing');
    assert.equal(fs.existsSync(path.join(root, TODOS_SQLITE_FILE)), false);
    fs.writeFileSync(path.join(root, TODOS_SQLITE_FILE), '');
    await assert.rejects(openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION }), (e) => e.code === 'todos_store_missing');
  });

  it('an unreadable or inconsistent marker refuses instead of defaulting to legacy', () => {
    fs.writeFileSync(path.join(root, TODOS_BACKEND_MARKER_FILE), '{not json');
    assert.throws(() => readTodosBackendMarker(root), (e) => e.code === 'todos_marker_invalid');
    fs.writeFileSync(path.join(root, TODOS_BACKEND_MARKER_FILE), JSON.stringify({ schema: 'cretli-todos-backend-v1', backend: 'sqlite', revision: 1 }));
    assert.throws(() => readTodosBackendMarker(root), (e) => e.code === 'todos_marker_invalid');
  });

  it('marker writes are compare-and-swap on the revision', () => {
    writeTodosBackendMarker(root, { backend: 'sqlite', datasetGeneration: TODOS_GENERATION, storeFile: TODOS_SQLITE_FILE }, { expectedRevision: 0 });
    assert.throws(
      () => writeTodosBackendMarker(root, { backend: 'sqlite', datasetGeneration: TODOS_GENERATION, storeFile: TODOS_SQLITE_FILE }, { expectedRevision: 0 }),
      (e) => e.code === 'todos_marker_conflict',
    );
  });

  it('a store bound to another dataset generation is refused', async () => {
    bootstrapHistoryStore({ dbDir: root, filename: TODOS_SQLITE_FILE, datasetGeneration: 'other-gen' });
    writeTodosBackendMarker(root, { backend: 'sqlite', datasetGeneration: TODOS_GENERATION, storeFile: TODOS_SQLITE_FILE }, { expectedRevision: 0 });
    await assert.rejects(openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION }), (e) => e.code === 'todo_generation_mismatch');
  });
});

describe('cache publication only after commit', () => {
  /** @param {'before' | 'after'} where */
  async function openDelayed(where) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const entered = new Promise((resolve) => { reached = resolve; });
    const nudges = [];
    const opened = await openSqliteTodosBackend({
      dataDir: root,
      nudge: (...args) => nudges.push(args),
      // Wrap the worker facade used by the backend: delay the commit (or its acknowledgement).
      wrapStore: (real) => ({
        ...real,
        batch: async (args) => {
          reached();
          if (where === 'before') await gate;
          const result = await real.batch(args);
          if (where === 'after') await gate;
          return result;
        },
      }),
    });
    return { opened, release, entered, nudges };
  }

  it('commit delayed: the pending write is invisible to readers, unacknowledged and not nudged', async () => {
    const { opened, release, entered, nudges } = await openDelayed('before');
    try {
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
      const store = createTodosStore(opened.backend);
      assert.deepEqual((await store.listTodos(root, cwd)).items, []);
      let settled = false;
      const pending = store.addTodo(root, cwd, { title: 'Pending', status: 'ready' }).then((r) => { settled = true; return r; });
      await entered;
      // The private overlay holds the item, but no shared state does.
      assert.deepEqual((await store.listTodos(root, cwd)).items, [], 'readers only see committed rows');
      assert.equal(opened.backend.cacheStats().entries <= 1, true);
      assert.equal(settled, false, 'no success before commit');
      assert.equal(nudges.length, 0, 'no watcher nudge before commit');
      release();
      const doc = await pending;
      assert.equal(doc.items.length, 1);
      assert.equal(nudges.length, 1, 'the nudge is published after commit');
      assert.equal((await store.listTodos(root, cwd)).items[0].title, 'Pending');
    } finally {
      release();
      await opened.close();
    }
  });

  it('committed but not yet acknowledged: still no nudge and no success; the cache is rebuilt from rows afterwards', async () => {
    const { opened, release, entered, nudges } = await openDelayed('after');
    try {
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
      const store = createTodosStore(opened.backend);
      let settled = false;
      const pending = store.addTodo(root, cwd, { title: 'Acked late' }).then((r) => { settled = true; return r; });
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false);
      assert.equal(nudges.length, 0);
      release();
      await pending;
      assert.equal(nudges.length, 1);
    } finally {
      release();
      await opened.close();
    }
  });

  it('a rejected command (CAS) publishes nothing: no nudge, no cache entry for the failed state', async () => {
    const nudges = [];
    const opened = await openSqliteTodosBackend({ dataDir: root, nudge: (...args) => nudges.push(args) });
    try {
      const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
      const store = createTodosStore(opened.backend);
      const id = (await store.addTodo(root, cwd, { title: 'x' })).items[0].id;
      nudges.length = 0;
      await assert.rejects(store.updateTodo(root, cwd, id, { title: 'y', expectedUpdatedAt: 'stale' }), (e) => e.code === 'CONFLICT');
      assert.equal((await store.getTodo(root, cwd, id)).title, 'x');
      assert.equal(nudges.length, 0, 'no nudge for a rejected command');
    } finally {
      await opened.close();
    }
  });

  it('cache is invalidated after each command and rebuilt after a restart', async () => {
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    let opened = await openSqliteTodosBackend({ dataDir: root, nudge: () => {} });
    let store = createTodosStore(opened.backend);
    await store.listTodos(root, cwd);
    assert.equal(opened.backend.cacheStats().entries, 1);
    const id = (await store.addTodo(root, cwd, { title: 'Persisted' })).items[0].id;
    assert.equal(opened.backend.cacheStats().entries, 0, 'invalidated by the command');
    await opened.close();
    opened = await openSqliteTodosBackend({ dataDir: root, bootstrap: false, nudge: () => {} });
    store = createTodosStore(opened.backend);
    assert.equal(opened.backend.cacheStats().entries, 0);
    assert.equal((await store.getTodo(root, cwd, id)).title, 'Persisted');
    await opened.close();
  });
});

describe('diffDocuments', () => {
  it('turns a legacy save into item operations and falls back to import for a reorder', () => {
    const raw = { version: 3, updatedAt: 'T1', idempotency: {}, items: [{ id: 'a', updatedAt: 'T1', title: 'a' }, { id: 'b', updatedAt: 'T1', title: 'b' }] };
    const post = { ...raw, updatedAt: 'T2', items: [{ id: 'a', updatedAt: 'T2', title: 'a2', extra: 1 }, { id: 'c', updatedAt: 'T2', title: 'c' }] };
    const diff = diffDocuments('k', raw, post);
    assert.deepEqual(diff.ops.map((o) => o.op), ['delete', 'update', 'add']);
    assert.deepEqual(diff.ops[1].set, { updatedAt: 'T2', title: 'a2', extra: 1 });
    assert.equal(diff.needsImport, false);
    assert.equal(diffDocuments('k', raw, { ...raw, items: [...raw.items].reverse() }).needsImport, true);
    assert.equal(diffDocuments('k', raw, JSON.parse(JSON.stringify(raw))).changed, false);
  });
});

describe('migration JSON -> SQLite -> JSON on a fixture', () => {
  it('dry run (plan) writes nothing; apply verifies counts and canonical hash and publishes the marker last', () => {
    writeFixture(root);
    const before = hashDir(path.join(root, 'todos'));
    const plan = planTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 });
    assert.equal(plan.totals.files, 4);
    assert.equal(plan.totals.items, 5);
    assert.equal(plan.files.find((f) => f.key === KEYS.a).idempotencyKeys, 1);
    assert.deepEqual(fs.readdirSync(root).sort(), ['todos'], 'plan leaves no marker and no store');
    const { result } = migrate(root);
    assert.equal(result.verification.workspaces, 4);
    assert.equal(result.verification.items, 5);
    assert.equal(result.verification.canonicalHash, canonicalDocsHash(fixtureDocs()));
    assert.equal(readTodosBackendMarker(root).backend, 'sqlite');
    assert.ok(fs.statSync(path.join(root, TODOS_SQLITE_FILE)).size > 0);
    assert.deepEqual(hashDir(path.join(root, 'todos')), before, 'JSON bytes untouched');
    for (const name of fs.readdirSync(path.join(root, 'todos'))) assert.equal(fs.statSync(path.join(root, 'todos', name)).mode & 0o222, 0, `${name} is read-only`);
    assert.equal(fs.existsSync(path.join(root, 'todos-migration.partial')), false);
  });

  it('round trip: migrate, run on sqlite, export, activate rollback; counts and canonical hash match', async () => {
    const docs = writeFixture(root);
    migrate(root);
    const runtime = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION });
    assert.equal(runtime.backendKind, 'sqlite');
    await runtime.close();
    const exportDir = path.join(root, 'rollback-1');
    const exported = exportTodosRollback({ dataDir: root, outDir: exportDir });
    assert.equal(exported.manifest.totals.items, 5);
    assert.equal(exported.manifest.docsHash, canonicalDocsHash(docs), 'a store without writes exports exactly the imported documents');
    verifyTodosRollbackExport({ exportDir, dataDir: root });
    const activated = activateTodosRollback({ dataDir: root, exportDir });
    assert.equal(activated.marker.backend, 'legacy-rollback');
    const live = {};
    for (const name of fs.readdirSync(path.join(root, 'todos'))) live[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(root, 'todos', name), 'utf8'));
    assert.equal(canonicalDocsHash(live), canonicalDocsHash(docs));
    assert.ok(fs.existsSync(activated.preservedDirectory), 'the previous todos directory is preserved');
    const reopened = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION, fence: 1 });
    assert.equal(reopened.backendKind, 'legacy-rollback');
  });

  it('a source file changed while the tool ran voids the migration: no store, no marker', () => {
    writeFixture(root);
    const file = path.join(root, 'todos', `${KEYS.b}.json`);
    const plan = planTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 });
    assert.throws(() => applyTodosMigration({
      dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0, confirmPlanHash: plan.planHash,
      afterImport: () => fs.writeFileSync(file, JSON.stringify({ ...fixtureDocs()[KEYS.b], updatedAt: ts(9) })),
    }), (e) => e.code === 'todos_source_changed');
    assert.equal(fs.existsSync(path.join(root, TODOS_SQLITE_FILE)), false);
    assert.equal(readTodosBackendMarker(root).backend, 'legacy');
    // The leftover staging directory does not block a re-plan and re-run.
    const again = planTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 });
    applyTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0, confirmPlanHash: again.planHash });
    assert.equal(readTodosBackendMarker(root).backend, 'sqlite');
  });

  it('refuses a recently written source (writers not quiesced), a bad plan hash and an invalid document', () => {
    writeFixture(root);
    assert.throws(() => planTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 60_000 }), (e) => e.code === 'todos_source_not_quiet');
    assert.throws(() => applyTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0, confirmPlanHash: 'nope' }), (e) => e.code === 'todos_plan_mismatch');
    fs.writeFileSync(path.join(root, 'todos', `${hex('bad')}.json`), JSON.stringify({ items: [{ title: 'no id' }] }));
    assert.throws(() => planTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 }), (e) => e.code === 'todos_source_invalid');
  });

  it('a second migration is refused once the marker or store exists', () => {
    writeFixture(root);
    migrate(root);
    assert.throws(() => planTodosMigration({ dataDir: root, datasetGeneration: TODOS_GENERATION, minQuietMs: 0 }), (e) => e.code === 'todos_already_migrated');
  });
});

describe('rollback source after the first durable ACK', () => {
  it('the original JSON is acceptable before any ACK and rejected as a rollback source afterwards; a fresh export is accepted until the next write', async () => {
    writeFixture(root);
    migrate(root);
    // Copy of the original JSON, as an operator's backup.
    const backup = path.join(root, 'backup');
    fs.mkdirSync(path.join(backup, 'todos'), { recursive: true });
    for (const name of fs.readdirSync(path.join(root, 'todos'))) fs.copyFileSync(path.join(root, 'todos', name), path.join(backup, 'todos', name));
    assert.equal(assertTodosRollbackSource({ dataDir: root, sourceDir: backup }).kind, 'original-json');

    // First durable ACK: a command through the sqlite backend.
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    let runtime = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION });
    await createTodosStore(runtime.backend).addTodo(root, cwd, { title: 'After ACK' });
    await runtime.close();

    assert.throws(() => assertTodosRollbackSource({ dataDir: root, sourceDir: backup }), (e) => e.code === 'todos_rollback_source_stale');
    const exportDir = path.join(root, 'fresh-export');
    exportTodosRollback({ dataDir: root, outDir: exportDir });
    assert.equal(assertTodosRollbackSource({ dataDir: root, sourceDir: exportDir }).kind, 'fresh-export');
    const receipts = JSON.parse(fs.readFileSync(path.join(exportDir, 'rollback-control', 'receipts.json'), 'utf8'));
    assert.ok(receipts.length >= 1, 'the sidecar carries the receipts');
    // The export contains the post-ACK write.
    const total = fs.readdirSync(path.join(exportDir, 'todos')).map((n) => JSON.parse(fs.readFileSync(path.join(exportDir, 'todos', n), 'utf8')).items.length).reduce((a, b) => a + b, 0);
    assert.equal(total, 6);

    // Another durable write makes that export stale too.
    runtime = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION });
    await createTodosStore(runtime.backend).addTodo(root, cwd, { title: 'Newer' });
    await runtime.close();
    assert.throws(() => assertTodosRollbackSource({ dataDir: root, sourceDir: exportDir }), (e) => e.code === 'todos_rollback_export_stale');
    assert.throws(() => activateTodosRollback({ dataDir: root, exportDir }), (e) => e.code === 'todos_rollback_export_stale');
    assert.equal(readTodosBackendMarker(root).backend, 'sqlite', 'a refused activation leaves the marker alone');
  });

  it('a tampered export is rejected at startup of the legacy-rollback runtime', async () => {
    writeFixture(root);
    migrate(root);
    const exportDir = path.join(root, 'export');
    exportTodosRollback({ dataDir: root, outDir: exportDir });
    activateTodosRollback({ dataDir: root, exportDir });
    fs.appendFileSync(path.join(exportDir, 'todos', `${KEYS.b}.json`), ' ');
    await assert.rejects(openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION, fence: 1 }), (e) => e.code === 'todos_rollback_export_corrupt');
  });
});

describe('watcher command on the sqlite backend', () => {
  it('commits the todo and the watcher row; a rejected watcher write compensates the todo', async () => {
    const cwd = `/example/l4-${process.pid}-${Date.now()}`;
    const dataDir = ISOLATED_DATA_DIR;
    const opened = await openSqliteTodosBackend({ dataDir, nudge: () => {} });
    try {
      const store = createTodosStore(opened.backend);
      const todo = (await store.addTodo(dataDir, cwd, { title: 'Leaf', status: 'ready' })).items[0];
      const row = upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
      const revision = () => loadWorkspaceWatchersDocument({ dataDir }).revision;
      const command = (extra = {}) => ({
        todoId: todo.id, expectedTodoUpdatedAt: todo.updatedAt, expectedWatcherUpdatedAt: row.updatedAt, expectedWatcherRevision: revision(),
        decide: () => ({ todoPatch: { status: 'doing' }, watcherPatch: { mode: 'autopilot' } }), ...extra,
      });
      // The watcher write is rejected (the row moved after the checks): the todo change must be rolled back.
      const bad = await store.commitWatcherTodoCommand(dataDir, cwd, command({
        beforeWatcherWrite: () => upsertWorkspaceWatcher(cwd, { paused: true }, { dataDir }),
      }));
      assert.deepEqual(bad, { ok: false, reason: 'watcher_conflict' });
      assert.equal((await store.getTodo(dataDir, cwd, todo.id)).status, 'ready', 'todo restored');
      assert.equal(getWorkspaceWatcher(cwd, { dataDir }).mode, 'observe');
      const fresh = getWorkspaceWatcher(cwd, { dataDir });
      const todoNow = await store.getTodo(dataDir, cwd, todo.id);
      const ok = await store.commitWatcherTodoCommand(dataDir, cwd, command({
        expectedWatcherUpdatedAt: fresh.updatedAt, expectedTodoUpdatedAt: todoNow.updatedAt,
      }));
      assert.equal(ok.ok, true);
      assert.equal((await store.getTodo(dataDir, cwd, todo.id)).status, 'doing');
      assert.equal(getWorkspaceWatcher(cwd, { dataDir }).mode, 'autopilot');
      const after = getWorkspaceWatcher(cwd, { dataDir });
      assert.deepEqual(await store.commitWatcherTodoCommand(dataDir, cwd, command({
        expectedTodoUpdatedAt: 'stale', expectedWatcherUpdatedAt: after.updatedAt,
      })), { ok: false, reason: 'todo_conflict' });
    } finally {
      await opened.close();
    }
  });
});

describe('legacy-rollback runtime honours the sidecar', () => {
  /** Migrate, ACK one command on sqlite, export and activate; returns the export dir and the sidecar receipts. */
  async function activated() {
    writeFixture(root);
    migrate(root);
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const runtime = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION });
    await createTodosStore(runtime.backend).addTodo(root, cwd, { title: 'ACKed' });
    await runtime.close();
    const exportDir = path.join(root, 'export');
    exportTodosRollback({ dataDir: root, outDir: exportDir });
    activateTodosRollback({ dataDir: root, exportDir });
    const receipts = JSON.parse(fs.readFileSync(path.join(exportDir, 'rollback-control', 'receipts.json'), 'utf8'));
    return { exportDir, cwd, receipts };
  }
  const open = (fence) => openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION, fence });

  it('a modified live document is rejected at startup; so is a missing or extra one', async () => {
    await activated();
    const file = path.join(root, 'todos', `${KEYS.b}.json`);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('B one', 'B two'));
    await assert.rejects(open(1), (e) => e.code === 'todos_rollback_export_mismatch');
    fs.writeFileSync(file, original);
    fs.rmSync(file);
    await assert.rejects(open(1), (e) => e.code === 'todos_rollback_export_mismatch');
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(root, 'todos', `${hex('extra')}.json`), original);
    await assert.rejects(open(1), (e) => e.code === 'todos_rollback_export_mismatch');
    fs.rmSync(path.join(root, 'todos', `${hex('extra')}.json`));
    assert.equal((await open(1)).backendKind, 'legacy-rollback');
  });

  it('a missing state file, a missing fence and a stale fence fail closed; the mark stays monotonic', async () => {
    await activated();
    await assert.rejects(open(undefined), (e) => e.code === 'todos_rollback_fence_required');
    const first = await open(5);
    await assert.rejects(open(5), (e) => e.code === 'todos_rollback_fenced');
    await assert.rejects(open(3), (e) => e.code === 'todos_rollback_fenced');
    const second = await open(6);
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    // The older owner is fenced out per command; the newer one writes.
    assert.throws(() => first.backend.addTodo(root, cwd, { title: 'old writer' }), (e) => e.code === 'todos_rollback_fenced');
    assert.ok(second.backend.addTodo(root, cwd, { title: 'new writer' }));
    await assert.rejects(open(6), (e) => e.code === 'todos_rollback_fenced');
    assert.equal((await open(7)).backendKind, 'legacy-rollback');
    fs.rmSync(path.join(root, 'todos-rollback-state.json'));
    await assert.rejects(open(8), (e) => e.code === 'todos_rollback_state_missing');
  });

  it('writes made under rollback survive a restart; a write behind the runtime back does not', async () => {
    await activated();
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const first = await open(1);
    first.backend.addTodo(root, cwd, { title: 'kept' });
    assert.equal((await open(2)).backendKind, 'legacy-rollback');
    const files = fs.readdirSync(path.join(root, 'todos'));
    const victim = path.join(root, 'todos', files[0]);
    fs.writeFileSync(victim, `${fs.readFileSync(victim, 'utf8')} `);
    await assert.rejects(open(3), (e) => e.code === 'todos_rollback_export_mismatch');
  });

  it('a replayed receipt returns the recorded result and does not apply twice', async () => {
    const { receipts } = await activated();
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const { backend } = await open(1);
    const sidecar = receipts[0];
    const before = hashDirFiles();
    const replay = backend.command(
      { datasetGeneration: sidecar.dataset_generation, commandId: sidecar.command_id, requestDigest: sidecar.request_digest },
      'addTodo', [root, cwd, { title: 'must not apply' }],
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, JSON.parse(sidecar.result_json));
    assert.deepEqual(hashDirFiles(), before, 'no document changed');
    assert.throws(() => backend.command(
      { datasetGeneration: sidecar.dataset_generation, commandId: sidecar.command_id, requestDigest: 'sha256:other' },
      'addTodo', [root, cwd, { title: 'x' }],
    ), (e) => e.code === 'receipt_digest_mismatch');
    // A new command applies once; its replay (also after a restart) returns the first result.
    const cmd = { datasetGeneration: 'g', commandId: 'rb-1', requestDigest: 'sha256:d1' };
    const first = backend.command(cmd, 'addTodo', [root, cwd, { title: 'once' }]);
    assert.equal(first.replayed, false);
    const again = (await open(2)).backend.command(cmd, 'addTodo', [root, cwd, { title: 'once' }]);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'todos', fs.readdirSync(path.join(root, 'todos')).find((n) => n !== `${KEYS.a}.json` && JSON.parse(fs.readFileSync(path.join(root, 'todos', n), 'utf8')).items.some((i) => i.title === 'once'))), 'utf8'));
    assert.equal(doc.items.filter((i) => i.title === 'once').length, 1);
  });

  it('a tampered manifest or receipts sidecar is refused', async () => {
    const { exportDir } = await activated();
    const manifest = path.join(exportDir, 'rollback-control', 'manifest.json');
    const originalManifest = fs.readFileSync(manifest, 'utf8');
    fs.writeFileSync(manifest, originalManifest.replace(/"fenceHighWater": \d+/, '"fenceHighWater": 0 '));
    await assert.rejects(open(1), (e) => e.code === 'todos_rollback_export_mismatch');
    fs.writeFileSync(manifest, originalManifest);
    const receiptsFile = path.join(exportDir, 'rollback-control', 'receipts.json');
    fs.writeFileSync(receiptsFile, '[]');
    await assert.rejects(open(1), (e) => e.code === 'todos_rollback_export_corrupt');
  });
});

function hashDirFiles() {
  const dir = path.join(root, 'todos');
  return Object.fromEntries(fs.readdirSync(dir).map((n) => [n, createHash('sha256').update(fs.readFileSync(path.join(dir, n))).digest('hex')]));
}

describe('rollback runtime: facade receipts and cross-process fencing', () => {
  const CHILD = fileURLToPath(new URL('./fixtures/todos-rollback-child.mjs', import.meta.url));
  async function activatedRuntime() {
    writeFixture(root);
    migrate(root);
    const exportDir = path.join(root, 'export');
    exportTodosRollback({ dataDir: root, outDir: exportDir });
    activateTodosRollback({ dataDir: root, exportDir });
    return exportDir;
  }
  /** @returns {{ done: Promise<{ lines: any[] }>, lines: any[] }} */
  function child(mode, fence, cwd = '') {
    const proc = spawn(process.execPath, [CHILD, root, mode, String(fence), cwd], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = [];
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    return { lines, done: new Promise((resolve) => proc.on('close', () => resolve({ lines }))) };
  }
  const stateFence = () => JSON.parse(fs.readFileSync(path.join(root, 'todos-rollback-state.json'), 'utf8')).fence;

  it('public facade mutations replay a recorded receipt, refuse a digest change and apply new commands once', async () => {
    await activatedRuntime();
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const { backend } = await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION, fence: 1 });
    const store = createTodosStore(backend);
    const cmd = { datasetGeneration: 'g', commandId: 'facade-1', requestDigest: 'sha256:a' };
    const first = await store.withCommand(cmd, () => store.addTodo(root, cwd, { title: 'once' }));
    const again = await store.withCommand(cmd, () => store.addTodo(root, cwd, { title: 'once' }));
    assert.deepEqual(again, JSON.parse(JSON.stringify(first)), 'the recorded result is returned');
    assert.equal((await store.listTodos(root, cwd)).items.length, 1, 'not applied twice');
    await assert.rejects(store.withCommand({ ...cmd, requestDigest: 'sha256:b' }, () => store.addTodo(root, cwd, { title: 'x' })), (e) => e.code === 'receipt_digest_mismatch');
    // update and delete go through the same choke point
    const id = first.items[0].id;
    const upd = { datasetGeneration: 'g', commandId: 'facade-2', requestDigest: 'sha256:u' };
    await store.withCommand(upd, () => store.updateTodo(root, cwd, id, { title: 'renamed' }));
    await store.withCommand(upd, () => store.updateTodo(root, cwd, id, { title: 'renamed again' }));
    assert.equal((await store.getTodo(root, cwd, id)).title, 'renamed');
    // a batch under one command: every op has its own ledger entry, replay applies none
    const batch = { datasetGeneration: 'g', commandId: 'facade-3', requestDigest: 'sha256:batch' };
    const ops = [{ op: 'add', input: { title: 'b1' } }, { op: 'add', input: { title: 'b2' } }];
    await store.withCommand(batch, () => store.batch(root, cwd, ops));
    await store.withCommand(batch, () => store.batch(root, cwd, ops));
    assert.equal((await store.listTodos(root, cwd)).items.length, 3);
    // no command identity: keeps working, no ledger entry
    await store.addTodo(root, cwd, { title: 'plain' });
    assert.equal((await store.listTodos(root, cwd)).items.length, 4);
    // the ledger survives a restart
    const reopened = createTodosStore((await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION, fence: 2 })).backend);
    await reopened.withCommand(cmd, () => reopened.addTodo(root, cwd, { title: 'once' }));
    assert.equal((await reopened.listTodos(root, cwd)).items.length, 4);
  });

  it('fence publication is serialized by a cross-process lock', async () => {
    await activatedRuntime();
    // Take the lock, start a child that wants to publish a fence, and hold the lock long enough for it to try.
    let c;
    let during;
    withRollbackStateLockSync(root, () => {
      c = child('open', 5);
      const until = Date.now() + 2000;
      while (Date.now() < until) { /* hold */ }
      during = { fence: stateFence(), lines: [...c.lines] };
    });
    const result = { c, during };
    assert.deepEqual(result.during.lines, [], "no output while the lock was held"); assert.equal(result.during.fence, 0, 'the child did not publish while the lock was held');
    const { lines } = await result.c.done;
    assert.deepEqual(lines, [{ ok: true }]);
    assert.equal(stateFence(), 5);
  });

  it('parallel opens with different fences never leave a lower mark; a stale writer is fenced mid-run', async () => {
    await activatedRuntime();
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const writer = child('writer', 3, cwd);
    while (!writer.lines.some((l) => l.ready)) await new Promise((r) => setTimeout(r, 20));
    const a = child('open', 8);
    const b = child('open', 9);
    const [ra, rb, rw] = await Promise.all([a.done, b.done, writer.done]);
    const ok = (r) => r.lines.at(-1);
    assert.equal(ok(rb).ok || ok(ra).ok, true);
    assert.equal(stateFence(), ok(rb).ok ? 9 : 8);
    if (!ok(ra).ok) assert.equal(ok(ra).code, 'todos_rollback_fenced');
    // the writer was fenced out and every write it acknowledged is on disk exactly once
    const last = rw.lines.at(-1);
    assert.equal(last.code, 'todos_rollback_fenced');
    const key = fs.readdirSync(path.join(root, 'todos')).find((n) => JSON.parse(fs.readFileSync(path.join(root, 'todos', n), 'utf8')).items.some((i) => i.title === 'w0'));
    const items = JSON.parse(fs.readFileSync(path.join(root, 'todos', key), 'utf8')).items;
    assert.equal(items.length, last.acked);
    // and the ledger matches the live documents (no torn state): a fresh open above the mark succeeds
    assert.equal((await openTodosRuntime({ dataDir: root, writeGate: WRITE_GATE_TEST_EXEMPTION, fence: 20 })).backendKind, 'legacy-rollback');
  });

  describe('lock ownership', () => {
    const lockPath = () => path.join(root, 'todos-rollback-state.lock');
    const LOCK_CHILD = fileURLToPath(new URL('./fixtures/todos-lock-child.mjs', import.meta.url));

    it('a live owner older than the old stale threshold is never robbed; the contender times out', () => {
      fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, token: 'live-owner', startId: null, at: Date.now() - 3_600_000 }));
      const old = new Date(Date.now() - 3_600_000);
      fs.utimesSync(lockPath(), old, old);
      assert.throws(() => withRollbackStateLockSync(root, () => assert.fail('must not enter'), { timeoutMs: 300 }), (e) => e.code === 'todos_rollback_lock_timeout');
      assert.equal(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).token, 'live-owner');
    });

    it('a displaced owner releases nothing: the new owner lock survives', () => {
      withRollbackStateLockSync(root, () => {
        // Simulate a takeover while this owner is still inside: another owner now holds the lock.
        fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, token: 'newer-owner', startId: null }));
      });
      assert.equal(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).token, 'newer-owner');
      fs.rmSync(lockPath());
      withRollbackStateLockSync(root, () => {});
      assert.equal(fs.existsSync(lockPath()), false, 'a normal release removes its own lock');
    });

    it('a reused PID (different start identity) is stale; a dead PID is taken over exactly once by racing contenders', async () => {
      const dead = spawn(process.execPath, ['-e', '0']);
      await new Promise((resolve) => dead.on('close', resolve));
      fs.writeFileSync(lockPath(), JSON.stringify({ pid: dead.pid, token: 'dead-owner', startId: null }));
      const log = path.join(root, 'lock.log');
      const run = () => new Promise((resolve) => spawn(process.execPath, [LOCK_CHILD, root, log], { stdio: 'inherit' }).on('close', resolve));
      await Promise.all([run(), run(), run()]);
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(lines.filter((l) => l.startsWith('takeover')).length, 1, 'taken over exactly once');
      const sections = lines.filter((l) => !l.startsWith('takeover')).map((l) => l.split(' ')[0]);
      assert.deepEqual(sections, ['enter', 'exit', 'enter', 'exit', 'enter', 'exit'], 'critical sections never overlap');
      assert.equal(fs.existsSync(lockPath()), false);
      if (process.platform === 'linux') {
        fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, token: 'reused', startId: '1' }));
        let took = 0;
        withRollbackStateLockSync(root, () => {}, { onTakeover: () => { took += 1; } });
        assert.equal(took, 1, 'a live PID with another start identity is a different process');
      }
    });
  });
});


/** A normalized-valid todo that carries ~440 KB of heavy fields (the largest legal row). */
function heavyItem(i) {
  const at = ts(1);
  return {
    id: `heavy-${String(i).padStart(2, '0')}`, title: `Heavy ${i}`, body: 'b'.repeat(8000), status: 'ready', createdAt: at, updatedAt: at, siblingIndex: i,
    plan: { markdown: 'p'.repeat(32000), updatedAt: at, markdownUpdatedAt: at },
    changelog: Array.from({ length: 100 }, () => ({ kind: 'note', text: 'c'.repeat(4000), at })),
  };
}

describe('large workspace: no whole-document worker result', () => {
  const HEAVY_ROWS = 12; // ~5.3 MB, above the 4 MiB worker result cap
  const cwd = () => path.join(root, 'ws');

  /** Seed row by row (each command is far below every limit); returns the opened backend and its workspace key. */
  async function openHeavy(extra = {}) {
    fs.mkdirSync(cwd(), { recursive: true });
    const opened = await openSqliteTodosBackend({ dataDir: root, nudge: () => {}, ...extra });
    const { workspaceKeyFromCwd } = await import('../lib/persist/todos-persist.js');
    const key = workspaceKeyFromCwd(cwd());
    for (let i = 0; i < HEAVY_ROWS; i += 1) await opened.store.addTodo({ commandId: `seed-${i}`, workspaceKey: key, item: heavyItem(i) });
    await opened.store.docMeta({ commandId: 'seed-meta', workspaceKey: key, meta: { version: 3, updatedAt: ts(1), idempotency: {} } });
    return { opened, key };
  }

  it('the single-result export is refused by the worker cap while the paged export and the facade read it', async () => {
    const { opened, key } = await openHeavy();
    try {
      await assert.rejects(opened.store.exportDocument({ workspaceKey: key }), (err) => err.details?.operation === 'result_too_large');
      const doc = await opened.store.exportDocumentPaged({ workspaceKey: key });
      assert.equal(doc.items.length, HEAVY_ROWS);
      assert.deepEqual(doc.items.map((row) => row.id), Array.from({ length: HEAVY_ROWS }, (_, i) => heavyItem(i).id));
      assert.deepEqual(doc.items[3], heavyItem(3), 'heavy fields survive the paged round trip');
      const list = await opened.backend.listTodos(root, cwd());
      assert.equal(list.items.length, HEAVY_ROWS);
      assert.equal((await opened.backend.getTodo(root, cwd(), 'heavy-11')).title, 'Heavy 11');
      assert.equal((await opened.backend.exportSnapshot(root, cwd())).items.length, HEAVY_ROWS);
    } finally { await opened.close(); }
  });

  it('exportPage is byte-bounded, ordered and resumable; the document head rides the first page only', async () => {
    const { opened, key } = await openHeavy();
    try {
      const seen = [];
      let after;
      let pages = 0;
      let heads = 0;
      do {
        const page = await opened.store.exportPage({ workspaceKey: key, ...(after === undefined ? {} : { afterPosition: after }) });
        pages += 1;
        if (page.head) heads += 1;
        assert.ok(page.items.length >= 1 && page.items.length <= 3, `1 MiB budget fits at most 3 rows of ~440 KB (got ${page.items.length})`);
        seen.push(...page.items.map((row) => row.id));
        after = page.nextAfterPosition ?? undefined;
      } while (after !== undefined);
      assert.equal(heads, 1);
      assert.ok(pages >= HEAVY_ROWS / 3);
      assert.equal(new Set(seen).size, HEAVY_ROWS);
      assert.equal(await opened.store.exportPage({ workspaceKey: hex('absent') }), null);
      // A row larger than the budget is still returned alone instead of stalling the cursor.
      const tiny = await opened.store.exportPage({ workspaceKey: key, maxBytes: 1 });
      assert.equal(tiny.items.length, 1);
    } finally { await opened.close(); }
  });

  it('a mutation on a >4 MiB workspace commits row-wise and a no-op command submits nothing', async () => {
    const batches = [];
    const { opened } = await openHeavy({
      wrapStore: (real) => ({ ...real, batch: async (args) => { batches.push(args); return real.batch(args); } }),
    });
    try {
      batches.length = 0;
      await opened.backend.updateTodo(root, cwd(), 'heavy-05', { title: 'Renamed' });
      assert.equal(batches.length, 1);
      const ops = batches[0].ops;
      assert.deepEqual(ops.filter((op) => op.op === 'update').map((op) => op.id), ['heavy-05']);
      assert.ok(Buffer.byteLength(JSON.stringify(batches[0])) < 8 * 1024, 'the commit carries the changed fields, not the 5 MB document');
      assert.equal((await opened.backend.getTodo(root, cwd(), 'heavy-05')).title, 'Renamed');

      // Link once (a real change), then repeat it: the domain layer resolves the repeat without a write.
      await opened.backend.updateTodo(root, cwd(), 'heavy-05', { linkedChatId: 'chat-1' });
      await opened.backend.updateTodo(root, cwd(), 'heavy-05', { linkedChatId: 'chat-1' }); // rebuilds the scratch once
      const revision = await opened.backend.getRevision(root, cwd());
      const before = opened.backend.workStats();
      batches.length = 0;
      for (let i = 0; i < 3; i += 1) await opened.backend.updateTodo(root, cwd(), 'heavy-05', { linkedChatId: 'chat-1' });
      const after = opened.backend.workStats();
      assert.equal(batches.length, 0, 'no worker transaction for a no-op');
      assert.equal(await opened.backend.getRevision(root, cwd()), revision);
      assert.equal(after.scratchWrites, before.scratchWrites, 'the overlay is not rewritten for a no-op');
      assert.equal(after.overlayReads, before.overlayReads);
      assert.equal(after.pagedExports, before.pagedExports, 'the committed document is not re-read for a no-op');
      assert.equal(after.noopCommands - before.noopCommands, 3);
    } finally { await opened.close(); }
  });

  it('a writer that interleaves with a paged read restarts it instead of returning a torn document', async () => {
    const { opened, key } = await openHeavy();
    try {
      let injected = false;
      const real = opened.store;
      const racing = {
        ...real,
        exportPage: async (args) => {
          const page = await real.exportPage(args);
          if (!injected && args.afterPosition !== undefined) {
            injected = true;
            await real.updateTodo({ commandId: 'race', workspaceKey: key, id: 'heavy-00', set: { title: 'Raced', updatedAt: ts(2) } });
            await real.docMeta({ commandId: 'race-meta', workspaceKey: key, meta: { updatedAt: ts(2) } });
          }
          return page;
        },
      };
      // Rebuild the facade over the racing reads (same host) and read through its paged export.
      const { createTodosStore } = await import('../lib/storage/todos-store.js');
      const probe = createTodosStore({ host: { query: (name, args) => (name === 'todos.exportPage' ? racing.exportPage(args) : opened.host.query(name, args)) }, datasetGeneration: TODOS_GENERATION });
      const doc = await probe.exportDocumentPaged({ workspaceKey: key });
      assert.equal(injected, true);
      assert.equal(doc.items.find((row) => row.id === 'heavy-00').title, 'Raced', 'the restarted read sees the writer');
      assert.equal(doc.updatedAt, ts(2));
    } finally { await opened.close(); }
  });

  it('a row write that keeps docUpdatedAt and count but bumps docVersion restarts the paged read', async () => {
    const { opened, key } = await openHeavy();
    try {
      const real = opened.store;
      const before = await real.revision({ workspaceKey: key });
      let injected = false;
      let firstStamp = null;
      let pagesSeen = 0;
      const { createTodosStore } = await import('../lib/storage/todos-store.js');
      const probe = createTodosStore({ host: { query: async (name, args) => {
        const out = await opened.host.query(name, args);
        if (name === 'todos.exportPage') {
          pagesSeen += 1;
          if (!injected && args.afterPosition !== undefined) {
            injected = true;
            // Same updatedAt and row count as the document: only docVersion moves.
            await real.updateTodo({ commandId: 'race-same-ts', workspaceKey: key, id: 'heavy-00', set: { title: 'Raced same ts', updatedAt: before.docUpdatedAt } });
            await real.docMeta({ commandId: 'race-same-ts-meta', workspaceKey: key, meta: { version: before.docVersion + 1 } });
            const mid = await real.revision({ workspaceKey: key });
            firstStamp = mid;
          }
        }
        return out;
      } }, datasetGeneration: TODOS_GENERATION });
      const doc = await probe.exportDocumentPaged({ workspaceKey: key });
      assert.equal(injected, true);
      assert.equal(firstStamp.docUpdatedAt, before.docUpdatedAt, 'precondition: docUpdatedAt unchanged');
      assert.equal(firstStamp.count, before.count);
      assert.ok(firstStamp.docVersion > before.docVersion, 'precondition: docVersion bumped');
      assert.equal(doc.items.find((row) => row.id === 'heavy-00').title, 'Raced same ts', 'the restarted read sees the writer');
      assert.ok(pagesSeen > 2, 'the read restarted');
    } finally { await opened.close(); }
  });
});
