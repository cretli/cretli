import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './fixtures/fake-transport.js';
import { createLegacyJsonTodosBackend, createTodosStore, TODOS_STORE_ERROR_CODES } from '../lib/persist/todos-store.js';

/** Backends the facade contract runs against; add a worker-backed one here later. */
const BACKENDS = [{ name: 'legacy-json', create: () => createLegacyJsonTodosBackend() }];

for (const { name, create } of BACKENDS) {
  describe(`todos-store contract (${name})`, () => {
    /** @type {string} */ let dataDir;
    /** @type {string} */ let cwd;
    /** @type {ReturnType<typeof createTodosStore>} */ let store;

    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-store-data-'));
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-store-cwd-'));
      store = createTodosStore(create());
    });
    afterEach(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it('methods return Promises', async () => {
      const pending = store.listTodos(dataDir, cwd);
      assert.ok(pending instanceof Promise);
      assert.deepEqual((await pending).items, []);
    });

    it('add, get, list and update round-trip', async () => {
      const doc = await store.addTodo(dataDir, cwd, { title: 'First', status: 'ready' });
      const id = doc.items[0].id;
      assert.equal((await store.getTodo(dataDir, cwd, id)).title, 'First');
      assert.equal(await store.getTodo(dataDir, cwd, 'missing'), null);
      const updated = await store.updateTodo(dataDir, cwd, id, { title: 'Renamed' });
      assert.equal(updated.items.find((row) => row.id === id).title, 'Renamed');
      assert.equal((await store.listTodos(dataDir, cwd)).items.length, 1);
    });

    it('rejects a stale expectedUpdatedAt with CONFLICT', async () => {
      const doc = await store.addTodo(dataDir, cwd, { title: 'CAS' });
      const id = doc.items[0].id;
      await assert.rejects(
        store.updateTodo(dataDir, cwd, id, { title: 'x', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }),
        (err) => err.code === TODOS_STORE_ERROR_CODES.CONFLICT,
      );
    });

    it('rejects unknown ids with NOT_FOUND', async () => {
      await assert.rejects(store.updateTodo(dataDir, cwd, 'nope', { title: 'x' }), (err) => err.code === TODOS_STORE_ERROR_CODES.NOT_FOUND);
      await assert.rejects(store.deleteTodo(dataDir, cwd, 'nope'), (err) => err.code === TODOS_STORE_ERROR_CODES.NOT_FOUND);
    });

    it('deleteTodo removes the subtree and reports it', async () => {
      const root = (await store.addTodo(dataDir, cwd, { title: 'Root' })).items[0].id;
      await store.addTodo(dataDir, cwd, { title: 'Child', parentId: root });
      const result = await store.deleteTodo(dataDir, cwd, root);
      assert.equal(result.removedItems.length, 2);
      assert.deepEqual((await store.listTodos(dataDir, cwd)).items, []);
    });

    it('moveTodo moves a subtree to another workspace and honors CAS', async () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-store-target-'));
      try {
        const doc = await store.addTodo(dataDir, cwd, { title: 'Move me' });
        const item = doc.items[0];
        await assert.rejects(
          store.moveTodo({ dataDir, sourceFolder: cwd, targetFolder: target, todoId: item.id, expectedUpdatedAt: 'stale' }),
          (err) => err.code === TODOS_STORE_ERROR_CODES.CONFLICT,
        );
        const moved = await store.moveTodo({ dataDir, sourceFolder: cwd, targetFolder: target, todoId: item.id, expectedUpdatedAt: item.updatedAt });
        assert.deepEqual(moved.movedIds, [item.id]);
        assert.equal((await store.listTodos(dataDir, target)).items.length, 1);
        assert.equal((await store.listTodos(dataDir, cwd)).items.length, 0);
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });

    it('batch runs in order and stops at the first failure', async () => {
      const results = await store.batch(dataDir, cwd, [
        { op: 'add', input: { title: 'A' } },
        { op: 'add', input: { title: 'B' } },
      ]);
      assert.equal(results.length, 2);
      const id = results[0].items[0].id;
      await assert.rejects(
        store.batch(dataDir, cwd, [{ op: 'update', id, patch: { title: 'A2' } }, { op: 'delete', id: 'nope' }, { op: 'add', input: { title: 'C' } }]),
        (err) => err.code === TODOS_STORE_ERROR_CODES.NOT_FOUND,
      );
      const titles = (await store.listTodos(dataDir, cwd)).items.map((row) => row.title).sort();
      assert.deepEqual(titles, ['A2', 'B']);
      await assert.rejects(store.batch(dataDir, cwd, [{ op: 'bogus' }]), (err) => err.code === TODOS_STORE_ERROR_CODES.VALIDATION);
    });
  });
}
