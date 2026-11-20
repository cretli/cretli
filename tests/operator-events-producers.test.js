/**
 * State-event producers: real transitions write `operator_events` rows. No
 * test here inserts an event row by hand.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listOperatorEventsSince } from '../lib/persist/operator-journal-persist.js';
import { addTodo } from '../lib/persist/todos-legacy-adapter.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { syncTodoReviewTarget } from '../lib/todo-review-sync-hooks.js';
import { applyWorkspaceWatcherBlockedEscalation, storeWorkspaceWatcherScopeRequest } from '../lib/workspace-watcher-cycle-close.js';
import { applyWorkspaceWatcherPatch, clearWorkspaceWatcherStop } from '../lib/workspace-watcher-control.js';
import { suspendWorkspaceAfterFrontendSmokeFailure } from '../lib/workspace-watcher-integration.js';
import { tickWorkspaceWatcher } from '../lib/workspace-watcher.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-operator-producers-'));
function setup() {
  const suffix = Math.random().toString(36).slice(2);
  const dataDir = path.join(root, `data-${suffix}`);
  const cwd = path.join(root, `ws-${suffix}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { dataDir, cwd };
}
const events = (f, kinds) => listOperatorEventsSince(f.cwd, { kinds }, { dataDir: f.dataDir }).events;

test('review sync with a failed verdict writes review_failed once', async () => {
  const f = setup();
  const todo = addTodo(f.dataDir, f.cwd, { title: 'leaf', status: 'doing' }).item;
  const deps = {
    readTodo: async () => ({ id: todo.id, updatedAt: 'x', review: { generation: 0 } }),
    computeSnapshot: async () => ({ code: { state: 'failed', stateReason: 'review_failed' } }),
    writeReview: async () => ({ changed: true, generation: 1 }),
  };
  const target = { dataDir: f.dataDir, workspaceFolder: f.cwd, todoId: todo.id };
  const result = await syncTodoReviewTarget(target, { deps, env: {} });
  assert.equal(result.ok, true);
  const rows = events(f, ['review_failed']);
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, new RegExp(`leaf ${todo.id},`));
  // An unchanged write is not a transition.
  await syncTodoReviewTarget(target, { deps: { ...deps, writeReview: async () => ({ changed: false }) }, env: {} });
  assert.equal(events(f, ['review_failed']).length, 1);
  // A passed snapshot writes nothing.
  await syncTodoReviewTarget(target, { deps: { ...deps, computeSnapshot: async () => ({ code: { state: 'passed' } }) }, env: {} });
  assert.equal(events(f, ['review_failed']).length, 1);
});

test('a scope request (needs_rescope) writes needs_rescope', async () => {
  const f = setup();
  const todo = addTodo(f.dataDir, f.cwd, { title: 'leaf', status: 'doing', body: 'x\n\n## Leaf scope\n- `lib/a.js`\n' }).item;
  const stored = await storeWorkspaceWatcherScopeRequest({ dataDir: f.dataDir, workspaceFolder: f.cwd, todoId: todo.id, files: ['lib/b.js'] });
  assert.equal(stored.stored, true);
  const rows = events(f, ['needs_rescope']);
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, new RegExp(`leaf ${todo.id},`));
  // Replaying the same proposal is not a transition: still exactly one event.
  await storeWorkspaceWatcherScopeRequest({ dataDir: f.dataDir, workspaceFolder: f.cwd, todoId: todo.id, files: ['lib/b.js'] });
  assert.equal(events(f, ['needs_rescope']).length, 1);
  // Nothing new to request: no event.
  await storeWorkspaceWatcherScopeRequest({ dataDir: f.dataDir, workspaceFolder: f.cwd, todoId: todo.id, files: ['lib/a.js'] });
  assert.equal(events(f, ['needs_rescope']).length, 1);
});

test('blocked escalation writes needs_human or blocked', async () => {
  const f = setup();
  const human = addTodo(f.dataDir, f.cwd, { title: 'h', status: 'ready' }).item;
  const dated = addTodo(f.dataDir, f.cwd, { title: 'd', status: 'ready' }).item;
  assert.equal(await applyWorkspaceWatcherBlockedEscalation({ workspaceFolder: f.cwd, dataDir: f.dataDir, todoId: human.id, escalation: { action: 'idea' }, message: 'm', code: 'needs_human' }), true);
  assert.equal(await applyWorkspaceWatcherBlockedEscalation({ workspaceFolder: f.cwd, dataDir: f.dataDir, todoId: dated.id, escalation: { action: 'defer', until: '2099-01-01' }, message: 'm', code: 'waits_for_date' }), true);
  assert.equal(events(f, ['needs_human']).length, 1);
  assert.equal(events(f, ['blocked']).length, 1);
  // A refused escalation (todo no longer ready) writes nothing.
  assert.equal(await applyWorkspaceWatcherBlockedEscalation({ workspaceFolder: f.cwd, dataDir: f.dataDir, todoId: human.id, escalation: { action: 'idea' }, code: 'needs_human' }), false);
  assert.equal(events(f, ['needs_human']).length, 1);
});

test('manual stop and clear write watcher_stopped and watcher_stop_cleared', async () => {
  const f = setup();
  upsertWorkspaceWatcher(f.cwd, { mode: 'observe' }, { dataDir: f.dataDir });
  applyWorkspaceWatcherPatch({ dataDir: f.dataDir, workspaceFolder: f.cwd, patch: { stopReason: 'maintenance' } });
  await clearWorkspaceWatcherStop({ dataDir: f.dataDir, workspaceFolder: f.cwd });
  const rows = events(f, ['watcher_stopped', 'watcher_stop_cleared']);
  assert.deepEqual(rows.map((row) => row.kind), ['watcher_stopped', 'watcher_stop_cleared']);
  assert.match(rows[0].summary, /manual, reason maintenance/);
  // Re-sending the same empty stop is not a transition.
  applyWorkspaceWatcherPatch({ dataDir: f.dataDir, workspaceFolder: f.cwd, patch: { stopReason: '' } });
  assert.equal(events(f, ['watcher_stop_cleared']).length, 1);
});

test('the loop guard stopping the watcher writes watcher_stopped (automatic)', async () => {
  const f = setup();
  const todo = addTodo(f.dataDir, f.cwd, { title: 'stuck', status: 'ready' }).item;
  upsertWorkspaceWatcher(f.cwd, { mode: 'autopilot', policy: { maxConsecutiveFailures: 1 }, failures: { [todo.id]: 1 } }, { dataDir: f.dataDir });
  await tickWorkspaceWatcher({ workspaceFolder: f.cwd, dataDir: f.dataDir, now: Date.parse('2026-01-01T00:00:00.000Z'), token: 'loop-stop' });
  const rows = events(f, ['watcher_stopped']);
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, /automatic, reason loop_/);
});

test('the smoke-test stop emits once for the same stopReason', async () => {
  const f = setup();
  const todo = addTodo(f.dataDir, f.cwd, { title: 'leaf', status: 'doing' }).item;
  upsertWorkspaceWatcher(f.cwd, { mode: 'autopilot' }, { dataDir: f.dataDir });
  const run = () => suspendWorkspaceAfterFrontendSmokeFailure(
    { dataDir: f.dataDir, workspaceFolder: f.cwd, todo, reason: 'boom', result: { cycleId: 'c1' } },
    { notify: async () => ({ created: true, id: 'n1' }), createTodo: async () => ({ item: { id: 't' } }), broadcast: () => {} },
  );
  await run().catch(() => {});
  await run().catch(() => {});
  const rows = events(f, ['watcher_stopped']);
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, /automatic, reason /);
});
