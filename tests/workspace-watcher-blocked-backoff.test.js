import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWorkspaceWatcherAction, pickNextWorkspaceReadyTodo } from '../lib/workspace-watcher.js';
import { nextWorkspaceWatcherBlockedBackoff } from '../lib/workspace-watcher-guardrails.js';
import { buildWorkspaceWatcherCycleClosePatch } from '../lib/workspace-watcher-cycle-close.js';
import { isWorkspaceWatcherLeafBehindWorktreeAncestor } from '../lib/workspace-watcher-pool.js';
import { normalizeWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';

const now = Date.parse('2026-01-01T00:00:00Z');
const policy = { maxParallel: 2, requirePlanApproval: false, executionMode: 'project', cooldownMs: 180_000, backoffBaseMs: 60_000, backoffCapMs: 3_600_000 };
const root = { id: 'root', status: 'doing', executionMode: 'worktree' };
const gatedLeaf = { id: 'gated', status: 'ready', parentId: 'root', executionMode: 'inherit' };
const freeLeaf = { id: 'free', status: 'ready' };

function decide(readyLeaves, watcherPatch = {}) {
  return decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy, ...watcherPatch },
    snapshot: { readyTodoCount: readyLeaves.length, readyLeaves, items: [root, ...readyLeaves], activeAgentCount: 0, errors: [] },
    now,
  });
}

test('a project-pool leaf under a worktree ancestor is never picked', () => {
  assert.equal(isWorkspaceWatcherLeafBehindWorktreeAncestor(gatedLeaf, [root, gatedLeaf], policy), true);
  assert.equal(isWorkspaceWatcherLeafBehindWorktreeAncestor(freeLeaf, [root, freeLeaf], policy), false);
  const skipped = decide([gatedLeaf, freeLeaf]);
  assert.equal(skipped.kind, 'start_cycle');
  assert.equal(skipped.nextTodoId, freeLeaf.id);
  const idle = decide([gatedLeaf]);
  assert.equal(idle.kind, 'idle_no_work');
  assert.equal(idle.reason, 'ancestor_requires_worktree');
});

test('a leaf the watcher itself runs in a worktree is not held back by the ancestor rule', () => {
  const ownWorktree = { ...gatedLeaf, executionMode: 'worktree' };
  assert.equal(isWorkspaceWatcherLeafBehindWorktreeAncestor(ownWorktree, [root, ownWorktree], policy), false);
  assert.equal(isWorkspaceWatcherLeafBehindWorktreeAncestor(gatedLeaf, [root, gatedLeaf], { ...policy, executionMode: 'worktree' }), false);
});

test('blocked backoff doubles per consecutive blocked close and is capped', () => {
  const first = nextWorkspaceWatcherBlockedBackoff({ policy, now });
  assert.deepEqual(first, { count: 1, until: new Date(now + 360_000).toISOString() });
  const second = nextWorkspaceWatcherBlockedBackoff({ previous: first, policy, now });
  assert.equal(Date.parse(second.until) - now, 720_000);
  const capped = nextWorkspaceWatcherBlockedBackoff({ previous: { count: 20 }, policy, now });
  assert.equal(Date.parse(capped.until) - now, policy.backoffCapMs);
});

test('a blocked close starts the backoff, the pick honours it, and success clears it', () => {
  const row = normalizeWorkspaceWatcherRow({ workspaceFolder: '/tmp/my-app', mode: 'autopilot', policy });
  const cycle = { cycleId: 'c1', todoIds: [freeLeaf.id] };
  const blocked = buildWorkspaceWatcherCycleClosePatch({ row, cycle, outcome: 'blocked', now });
  assert.equal(blocked.blockedBackoff[freeLeaf.id].count, 1);
  assert.equal(blocked.failures[freeLeaf.id], undefined);
  const stored = normalizeWorkspaceWatcherRow({ ...row, ...blocked });
  assert.equal(stored.blockedBackoff[freeLeaf.id].count, 1);
  const waiting = decide([freeLeaf], { blockedBackoff: stored.blockedBackoff });
  assert.equal(waiting.kind, 'idle_no_work');
  assert.equal(waiting.reason, 'blocked_backoff');
  const until = Date.parse(stored.blockedBackoff[freeLeaf.id].until);
  assert.equal(pickNextWorkspaceReadyTodo({ readyLeaves: [freeLeaf], blockedBackoff: stored.blockedBackoff, now: until - 1 }), null);
  assert.equal(pickNextWorkspaceReadyTodo({ readyLeaves: [freeLeaf], blockedBackoff: stored.blockedBackoff, now: until }).id, freeLeaf.id);
  const done = buildWorkspaceWatcherCycleClosePatch({ row: stored, cycle, outcome: 'success', now });
  assert.deepEqual(done.blockedBackoff, {});
});

test('a blocked plan-only cycle does not delay the leaf behind its plan approval', () => {
  const row = normalizeWorkspaceWatcherRow({ workspaceFolder: '/tmp/my-app', mode: 'autopilot', policy });
  const patch = buildWorkspaceWatcherCycleClosePatch({ row, cycle: { cycleId: 'c2', todoIds: [freeLeaf.id], planOnly: true }, outcome: 'blocked', now });
  assert.deepEqual(patch.blockedBackoff, {});
});
