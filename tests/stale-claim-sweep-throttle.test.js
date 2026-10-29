import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  releaseStaleWorkspaceTodoClaimsThrottled,
  resetStaleClaimSweepThrottle,
} from '../lib/workspace-watcher.js';
import { getExternalJobTimings, resetExternalJobTimings } from '../lib/periodic-job-runner.js';

test('stale-claim sweep runs once per interval per workspace', async () => {
  resetStaleClaimSweepThrottle();
  resetExternalJobTimings();
  const ws = '/tmp/throttle-ws-a';
  const first = await releaseStaleWorkspaceTodoClaimsThrottled({ workspaceFolder: ws, now: 1000, loadDelegations: () => [] });
  assert.ok(first);
  assert.equal(await releaseStaleWorkspaceTodoClaimsThrottled({ workspaceFolder: ws, now: 30_000, loadDelegations: () => [] }), null);
  assert.ok(await releaseStaleWorkspaceTodoClaimsThrottled({ workspaceFolder: ws, now: 61_001, loadDelegations: () => [] }));
  assert.ok(await releaseStaleWorkspaceTodoClaimsThrottled({ workspaceFolder: '/tmp/throttle-ws-b', now: 1500, loadDelegations: () => [] }));
  const row = getExternalJobTimings().find((r) => r.id === 'releaseStaleWorkspaceTodoClaims');
  assert.equal(row.runs, 3);
  assert.equal(row.skipped, 1);
});

test('throttled skip keeps a stale claim; unthrottled sweep releases it', async () => {
  const { ISOLATED_DATA_DIR: dataDir } = await import('./helpers/isolated-data-dir.js');
  const { addTodo, getTodoById } = await import('../lib/persist/todos-persist.js');
  const { claimWorkspaceTodo, releaseStaleWorkspaceTodoClaims } = await import('../lib/workspace-watcher.js');
  resetStaleClaimSweepThrottle();
  const ws = dataDir;
  const todo = addTodo(dataDir, ws, { title: 'Stale', status: 'ready' }).item;
  const now = Date.now();
  const claim = await claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: todo.id, expectedUpdatedAt: todo.updatedAt, claimedByChatId: 'dead-owner', now, ttlMs: 1000 });
  assert.equal(claim.claimed, true);
  const gone = { known: true, busy: false, reason: 'idle' };
  const opts = { dataDir, workspaceFolder: ws, probeChatRunLiveness: () => gone, getChat: () => ({ archived: true }) };
  // First throttled call has nothing to skip: it records the sweep time and releases.
  // Re-claim, then verify the second (skipped) call leaves the claim alone.
  await releaseStaleWorkspaceTodoClaimsThrottled({ ...opts, now: now + 2000 });
  assert.equal(getTodoById(dataDir, ws, todo.id).status, 'ready');
  const again = getTodoById(dataDir, ws, todo.id);
  await claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: todo.id, expectedUpdatedAt: again.updatedAt, claimedByChatId: 'dead-owner', now, ttlMs: 1000 });
  assert.equal(await releaseStaleWorkspaceTodoClaimsThrottled({ ...opts, now: now + 3000 }), null);
  assert.equal(getTodoById(dataDir, ws, todo.id).status, 'doing', 'skipped sweep must not release');
  await releaseStaleWorkspaceTodoClaims({ ...opts, now: now + 3000 });
  assert.equal(getTodoById(dataDir, ws, todo.id).status, 'ready', 'unthrottled sweep releases');
});
