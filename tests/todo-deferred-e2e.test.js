/**
 * End-to-end lifecycle of the `deferred` todo status: create, defer, Watcher
 * skip, sequential siblings, container cascade, restore, old-client view.
 * Uses the isolated data dir helper and the real persistence layer; no HTTP.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { listReadyTodoLeaves } from '../lib/todo-tree.js';
import { pickNextWorkspaceReadyTodo } from '../lib/workspace-watcher.js';
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

const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-deferred-e2e-'));
const dataDir = path.join(cwd, 'data');
const row = (id) => loadTodosData(dataDir, cwd).items.find((it) => it.id === id);
const watcherPick = () => {
  const items = loadTodosData(dataDir, cwd).items;
  return pickNextWorkspaceReadyTodo({ items });
};
/** What a client that predates `deferred` does with a stored status. */
const oldClientStatus = (status) => (['idea', 'ready', 'doing', 'done'].includes(status) ? status : 'idea');

runCase('create, defer with reason/date, Watcher skips it', () => {
  const todo = addTodo(dataDir, cwd, { title: 'Park me', status: 'ready' }).item;
  assert.equal(watcherPick()?.id, todo.id);
  updateTodo(dataDir, cwd, todo.id, {
    status: 'deferred',
    deferredUntil: '2030-01-02T00:00:00.000Z',
    deferredReason: 'user decision',
  });
  const stored = row(todo.id);
  assert.equal(stored.status, 'deferred');
  assert.equal(stored.deferredReason, 'user decision');
  assert.ok(stored.deferredUntil);
  assert.equal(watcherPick(), null);
  assert.deepEqual(listReadyTodoLeaves(loadTodosData(dataDir, cwd).items).map((r) => r.id), []);
});

runCase('restore from deferred: only idea/ready, metadata dropped, Watcher sees it again', () => {
  const todo = addTodo(dataDir, cwd, { title: 'Restore me', status: 'deferred', deferredReason: 'later' }).item;
  assert.throws(() => updateTodo(dataDir, cwd, todo.id, { status: 'doing' }), /restored to idea or ready/);
  assert.throws(() => updateTodo(dataDir, cwd, todo.id, { status: 'done' }), /restored to idea or ready/);
  updateTodo(dataDir, cwd, todo.id, { status: 'ready' });
  const stored = row(todo.id);
  assert.equal(stored.status, 'ready');
  assert.equal(stored.deferredReason, undefined);
  assert.equal(stored.deferredUntil, undefined);
  assert.ok(listReadyTodoLeaves(loadTodosData(dataDir, cwd).items).some((r) => r.id === todo.id));
  assert.throws(() => updateTodo(dataDir, cwd, addTodo(dataDir, cwd, { title: 'Done', status: 'done' }).item.id, { status: 'deferred' }), /done todo cannot be deferred/);
});

runCase('a deferred sibling does not block the next sequential sibling', () => {
  const parent = addTodo(dataDir, cwd, { title: 'Seq parent', status: 'ready' }).item;
  const a = addTodo(dataDir, cwd, { title: 'A', parentId: parent.id, status: 'ready' }).item;
  const b = addTodo(dataDir, cwd, { title: 'B', parentId: parent.id, status: 'ready' }).item;
  const ready = () => listReadyTodoLeaves(loadTodosData(dataDir, cwd).items).map((r) => r.id);
  assert.ok(ready().includes(a.id));
  assert.ok(!ready().includes(b.id), 'B waits for the open sibling A');
  updateTodo(dataDir, cwd, a.id, { status: 'deferred' });
  assert.ok(ready().includes(b.id), 'B is released once A is deferred');
  assert.ok(!ready().includes(a.id));
});

runCase('deferred parent cascades to open children; restore brings them back as drafts', () => {
  const parent = addTodo(dataDir, cwd, { title: 'Container', status: 'ready' }).item;
  const open = addTodo(dataDir, cwd, { title: 'Open child', parentId: parent.id, status: 'ready' }).item;
  const draft = addTodo(dataDir, cwd, { title: 'Draft child', parentId: parent.id, status: 'idea' }).item;
  const finished = addTodo(dataDir, cwd, { title: 'Finished child', parentId: parent.id, status: 'done' }).item;
  updateTodo(dataDir, cwd, parent.id, { status: 'deferred', deferredReason: 'park the tree' });
  assert.equal(row(parent.id).status, 'deferred');
  assert.equal(row(open.id).status, 'deferred');
  assert.equal(row(draft.id).status, 'deferred');
  assert.equal(row(finished.id).status, 'done');
  assert.ok(!listReadyTodoLeaves(loadTodosData(dataDir, cwd).items).some((r) => [open.id, draft.id].includes(r.id)));
  updateTodo(dataDir, cwd, parent.id, { status: 'ready' });
  assert.equal(row(open.id).status, 'idea');
  assert.equal(row(draft.id).status, 'idea');
  assert.equal(row(finished.id).status, 'done');
  assert.equal(row(open.id).deferredReason, undefined);
});

runCase('a container whose children are all done or deferred derives deferred; a doing child blocks deferral', () => {
  const parent = addTodo(dataDir, cwd, { title: 'Derived', status: 'ready' }).item;
  const x = addTodo(dataDir, cwd, { title: 'X', parentId: parent.id, status: 'done' }).item;
  const y = addTodo(dataDir, cwd, { title: 'Y', parentId: parent.id, status: 'ready' }).item;
  updateTodo(dataDir, cwd, y.id, { status: 'deferred' });
  assert.equal(row(x.id).status, 'done');
  assert.equal(row(parent.id).status, 'deferred');
  const busy = addTodo(dataDir, cwd, { title: 'Busy parent', status: 'ready' }).item;
  const run = addTodo(dataDir, cwd, { title: 'Running', parentId: busy.id, status: 'doing' }).item;
  assert.throws(() => updateTodo(dataDir, cwd, busy.id, { status: 'deferred' }), /in progress/);
  assert.equal(row(run.id).status, 'doing');
});

runCase('old client: deferred is shown as idea, and an idea patch restores it', () => {
  const todo = addTodo(dataDir, cwd, { title: 'Seen by old client', status: 'deferred', deferredReason: 'x' }).item;
  assert.equal(oldClientStatus(row(todo.id).status), 'idea');
  updateTodo(dataDir, cwd, todo.id, { status: oldClientStatus(row(todo.id).status) });
  assert.equal(row(todo.id).status, 'idea');
  assert.equal(row(todo.id).deferredReason, undefined);
});

removeIsolatedDataDir();
if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
