/**
 * "Move to later" for deferred leaves: pure decisions (input state -> decision)
 * and the persistence path (shared root created once, origin recorded, restore).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { decideDeferredMove, decideRestoreToTree, TODO_LATER_ROOT_TITLE } from '../lib/todo-tree.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const D = (extra) => ({ status: 'deferred', ...extra });

runCase('decision: root, container and non-deferred are skipped', () => {
  const items = [{ id: 'r', title: 'R', status: 'idea' }, D({ id: 'l', parentId: 'r' }), D({ id: 'p', parentId: 'r' }), { id: 'c', parentId: 'p', status: 'idea' }];
  assert.equal(decideDeferredMove(items, { id: 'r', status: 'deferred' }).reason, 'is_root');
  assert.equal(decideDeferredMove(items, items[2]).reason, 'not_leaf');
  assert.equal(decideDeferredMove(items, { id: 'l', parentId: 'r', status: 'idea' }).reason, 'not_deferred');
});

runCase('decision: shared root created when missing, reused when present', () => {
  const items = [{ id: 'r', title: 'R', status: 'idea' }, D({ id: 'l', parentId: 'r' })];
  assert.deepEqual(decideDeferredMove(items, items[1]), { action: 'move', targetId: '', createRoot: true, fromParentId: 'r' });
  const withLater = [...items, { id: 'L', title: TODO_LATER_ROOT_TITLE, status: 'deferred' }];
  assert.deepEqual(decideDeferredMove(withLater, items[1]), { action: 'move', targetId: 'L', createRoot: false, fromParentId: 'r' });
  const inLater = [{ id: 'L', title: TODO_LATER_ROOT_TITLE }, D({ id: 'x', parentId: 'L' })];
  assert.equal(decideDeferredMove(inLater, inLater[1]).reason, 'already_in_later');
});

runCase('decision: explicit target must be a different existing root', () => {
  const items = [{ id: 'r', title: 'R' }, { id: 'o', title: 'O' }, { id: 'k', parentId: 'o', title: 'K' }, D({ id: 'l', parentId: 'r' })];
  assert.equal(decideDeferredMove(items, items[3], 'o').targetId, 'o');
  assert.equal(decideDeferredMove(items, items[3], 'zz').reason, 'target_missing');
  assert.equal(decideDeferredMove(items, items[3], 'k').reason, 'target_not_root');
  assert.equal(decideDeferredMove(items, items[3], 'r').reason, 'same_parent');
});

runCase('decision: restore needs an existing origin', () => {
  const items = [{ id: 'r' }, { id: 'L', title: TODO_LATER_ROOT_TITLE }, D({ id: 'l', parentId: 'L', sourceTodoId: 'r' })];
  assert.deepEqual(decideRestoreToTree(items, items[2]), { action: 'restore', parentId: 'r' });
  assert.equal(decideRestoreToTree([items[1], items[2]], items[2]).reason, 'origin_missing');
  assert.equal(decideRestoreToTree(items, { id: 'x', parentId: 'L' }).reason, 'no_origin');
});

const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-deferred-move-'));
const dataDir = path.join(cwd, 'data');
const row = (id) => loadTodosData(dataDir, cwd).items.find((it) => it.id === id);

runCase('persist: move creates the shared root once, records origin, parent can finish', () => {
  const root = addTodo(dataDir, cwd, { title: 'Tree', status: 'idea' }).item;
  const a = addTodo(dataDir, cwd, { title: 'A', status: 'ready', parentId: root.id }).item;
  const b = addTodo(dataDir, cwd, { title: 'B', status: 'ready', parentId: root.id }).item;
  const c = addTodo(dataDir, cwd, { title: 'C', status: 'ready', parentId: root.id }).item;
  updateTodo(dataDir, cwd, a.id, { status: 'deferred', moveToLater: true });
  updateTodo(dataDir, cwd, b.id, { status: 'deferred', moveToLater: true });
  const laters = loadTodosData(dataDir, cwd).items.filter((it) => it.title === TODO_LATER_ROOT_TITLE);
  assert.equal(laters.length, 1);
  assert.equal(row(a.id).parentId, laters[0].id);
  assert.equal(row(b.id).parentId, laters[0].id);
  assert.equal(row(a.id).sourceTodoId, root.id);
  assert.match(row(a.id).changelog.at(-1).text, /Moved to later/);
  updateTodo(dataDir, cwd, c.id, { status: 'done' });
  assert.equal(row(root.id).status, 'done');
  // Restore: back under the old parent, reopened as a draft.
  updateTodo(dataDir, cwd, a.id, { status: 'idea', restoreToTree: true });
  assert.equal(row(a.id).parentId, root.id);
  assert.equal(row(a.id).sourceTodoId, undefined);
  assert.notEqual(row(root.id).status, 'done');
});

runCase('persist: restore fails with CONFLICT when the old parent is gone', () => {
  const root = addTodo(dataDir, cwd, { title: 'T2', status: 'idea' }).item;
  const x = addTodo(dataDir, cwd, { title: 'X', status: 'ready', parentId: root.id }).item;
  updateTodo(dataDir, cwd, x.id, { status: 'deferred', moveToLater: true });
  updateTodo(dataDir, cwd, x.id, { sourceTodoId: 'missing-parent' });
  assert.throws(() => updateTodo(dataDir, cwd, x.id, { status: 'idea', restoreToTree: true }), (e) => e.code === 'CONFLICT');
});

removeIsolatedDataDir();
if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
