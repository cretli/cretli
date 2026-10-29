/**
 * Dead container: a `doing` todo whose open children are all `idea`.
 * Unit table (input state -> decision) plus a tick run for the once-per-episode
 * push and the optional auto-ready of the first idea child.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  deadContainerSignature,
  findWorkspaceWatcherDeadContainers,
  planDeadContainerAutoReady,
} from '../lib/workspace-watcher-guardrails.js';
import { tickWorkspaceWatcher } from '../lib/workspace-watcher.js';

const todo = (id, status, extra = {}) => ({ id, title: `T-${id}`, status, ...extra });
const ids = (items) => findWorkspaceWatcherDeadContainers(items).map((c) => c.id);

try {
  // Detector table.
  const dead = [todo('p', 'doing'), todo('a', 'idea', { parentId: 'p', siblingIndex: 1 }), todo('b', 'idea', { parentId: 'p', siblingIndex: 0 }), todo('d', 'done', { parentId: 'p' })];
  assert.deepEqual(findWorkspaceWatcherDeadContainers(dead), [
    { id: 'p', title: 'T-p', idleChildren: [{ id: 'b', title: 'T-b' }, { id: 'a', title: 'T-a' }] },
  ]);
  assert.deepEqual(ids([todo('p', 'doing'), todo('a', 'idea', { parentId: 'p' }), todo('r', 'ready', { parentId: 'p' })]), [], 'ready child');
  assert.deepEqual(ids([todo('p', 'doing'), todo('a', 'idea', { parentId: 'p' }), todo('r', 'doing', { parentId: 'p' })]), [], 'doing child');
  assert.deepEqual(ids([todo('p', 'doing'), todo('a', 'idea', { parentId: 'p' }), todo('r', 'deferred', { parentId: 'p' })]), [], 'deferred child');
  assert.deepEqual(ids([todo('p', 'doing'), todo('d', 'done', { parentId: 'p' })]), [], 'only done children');
  assert.deepEqual(ids([todo('p', 'doing')]), [], 'no children');
  assert.deepEqual(ids([todo('p', 'ready'), todo('a', 'idea', { parentId: 'p' })]), [], 'container not doing');
  assert.equal(deadContainerSignature([]), '');
  assert.notEqual(deadContainerSignature(findWorkspaceWatcherDeadContainers(dead)), deadContainerSignature(findWorkspaceWatcherDeadContainers(dead.slice(0, 2))));

  // Auto-ready planning.
  const approved = [todo('root', 'doing', { plan: { markdown: 'x', approvedAt: '2026-10-23T00:00:00Z' } }), todo('p', 'doing', { parentId: 'root' }), todo('a', 'idea', { parentId: 'p', siblingIndex: 1 }), todo('b', 'idea', { parentId: 'p', siblingIndex: 0 })];
  assert.deepEqual(planDeadContainerAutoReady(approved, { autoReadyDeadContainerChild: true }), [{ containerId: 'p', childId: 'b' }]);
  assert.deepEqual(planDeadContainerAutoReady(approved, {}), [], 'policy off');
  assert.deepEqual(planDeadContainerAutoReady(dead, { autoReadyDeadContainerChild: true }), [], 'no approved plan');

  // Tick: once per episode, re-armed after the episode ends.
  const cwd = ISOLATED_DATA_DIR;
  const dataDir = ISOLATED_DATA_DIR;
  const parent = addTodo(dataDir, cwd, { title: 'Container', status: 'doing' }).item;
  const c1 = addTodo(dataDir, cwd, { title: 'First', status: 'idea', parentId: parent.id }).item;
  addTodo(dataDir, cwd, { title: 'Second', status: 'idea', parentId: parent.id });
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { autoReadyDeadContainerChild: false } }, { dataDir });
  const pushes = [];
  const tick = async (n) => await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: Date.now() + n * 1000, token: 't', notify: (m) => pushes.push(m), notifyDeps: {} });
  await tick(0);
  await tick(1);
  const deadPushes = () => pushes.filter((m) => String(m.tag).includes('dead_container'));
  assert.equal(deadPushes().length, 1, 'one push per episode');
  assert.match(deadPushes()[0].body, /First/);
  assert.match(deadPushes()[0].body, /Second/);
  const w = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok(w.decisions.some((d) => d.kind === 'dead_container' && d.reason === 'dead_container'));
  assert.equal(getTodoById(dataDir, cwd, c1.id).status, 'idea', 'policy off keeps idea');

  updateTodo(dataDir, cwd, c1.id, { status: 'ready' });
  await tick(2);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).notified?.dead_container || '', '', 'episode ended');
  // Auto-ready through the tick: policy on + approved plan on the container.
  const cwd2 = `${ISOLATED_DATA_DIR}/ws2`;
  const p2 = addTodo(dataDir, cwd2, { title: 'C2', status: 'doing' }).item;
  const k1 = addTodo(dataDir, cwd2, { title: 'K1', status: 'idea', parentId: p2.id }).item;
  upsertWorkspaceWatcher(cwd2, { mode: 'observe', policy: { autoReadyDeadContainerChild: true } }, { dataDir });
  await tickWorkspaceWatcher({ workspaceFolder: cwd2, dataDir, now: Date.now(), token: 't', notify: () => false, notifyDeps: {} });
  assert.equal(getTodoById(dataDir, cwd2, k1.id).status, 'idea', 'no approved plan -> untouched');
  updateTodo(dataDir, cwd2, p2.id, { plan: { markdown: 'plan', approvedAt: new Date().toISOString() } });
  await tickWorkspaceWatcher({ workspaceFolder: cwd2, dataDir, now: Date.now() + 1000, token: 't', notify: () => false, notifyDeps: {} });
  assert.equal(getTodoById(dataDir, cwd2, k1.id).status, 'ready', 'approved plan + policy -> ready');
  console.log('OK: workspace-watcher-stuck-container');
} finally {
  removeIsolatedDataDir();
}
