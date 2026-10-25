/**
 * A leaf working in its tree's shared worktree has no integration result of
 * its own. A verified PASS must close it as done (work waits for root-level
 * integration) instead of `cycle_incomplete`, without counting a failure.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { loadTodosData, updateTodo, writeTodoReview } from '../lib/persist/todos-persist.js';
import {
  acquireWorkspaceWatcherLease,
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { reportWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { listReadyTodoLeaves } from '../lib/todo-tree.js';
import {
  buildTreeIntegrationWaitDecision,
  buildWorkspaceWatcherCycleClosePatch,
  resolveWorkspaceWatcherCycleCloseOutcome,
} from '../lib/workspace-watcher-cycle-close.js';
import { markTreeWorktreeLeafDone, resolveTreeWorktreeLeaf } from '../lib/workspace-watcher-integration.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-tree-wt-close-'));

function setupTree() {
  const dataDir = path.join(tmpRoot, `data-${Math.random().toString(36).slice(2)}`);
  const cwd = path.join(tmpRoot, `ws-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const root = addTodo(dataDir, cwd, { title: 'root', status: 'ready' }).item;
  const leaf1 = addTodo(dataDir, cwd, { title: 'leaf 1', status: 'ready', parentId: root.id }).item;
  const leaf2 = addTodo(dataDir, cwd, { title: 'leaf 2', status: 'ready', parentId: root.id }).item;
  mutateWorktreeRegistry((doc) => {
    doc.items[root.id] = {
      todoId: root.id,
      workspaceFolder: cwd,
      worktreePath: path.join(cwd, '.wt', root.id),
      branch: `cretli/todo/${root.id}`,
      baseCommit: 'abc123',
      creationState: 'ready',
      executionState: 'active',
    };
    return doc;
  }, { dataDir });
  return { dataDir, cwd, root, leaf1, leaf2 };
}

test('close outcome: tree worktree PASS is a success, not cycle_incomplete', () => {
  const todo = { id: 'l1', status: 'doing', review: { code: { state: 'passed' } } };
  const base = { cycle: {}, row: {}, todo, reportedOutcomeRaw: 'success', leafOutcomes: { primaryOutcome: 'attempted' } };
  assert.deepEqual(
    resolveWorkspaceWatcherCycleCloseOutcome(base),
    { closeOutcome: 'failure', countIncompleteFailure: true, closeReason: 'cycle_incomplete' },
  );
  assert.deepEqual(
    resolveWorkspaceWatcherCycleCloseOutcome({ ...base, treeWorktreeWait: true }),
    { closeOutcome: 'success', countIncompleteFailure: false, closeReason: 'cycle_success' },
  );
});

test('close outcome: only a passed review qualifies for the tree wait', () => {
  for (const state of ['failed', 'unknown', 'none', 'pending', 'stale', 'manual', '']) {
    const result = resolveWorkspaceWatcherCycleCloseOutcome({
      cycle: {},
      row: {},
      todo: { id: 'l1', status: 'doing', review: { code: { state } } },
      reportedOutcomeRaw: 'success',
      leafOutcomes: { primaryOutcome: 'attempted' },
      treeWorktreeWait: true,
    });
    assert.notEqual(result.closeReason, 'cycle_success', state);
  }
  const gated = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: {}, row: {}, todo: { id: 'l1', status: 'doing' },
    reportedOutcomeRaw: 'success', leafOutcomes: { primaryOutcome: 'attempted' },
    treeWorktreeWait: true, reviewGateUnsatisfied: true,
  });
  assert.equal(gated.closeOutcome, 'blocked');
});

test('sequential tree in a tree worktree: leaf 1 PASS -> done, no failure, leaf 2 can start', () => {
  const ctx = setupTree();
  updateTodo(ctx.dataDir, ctx.cwd, ctx.leaf1.id, { status: 'doing', claimedByChatId: 'chat-1' });
  const found = resolveTreeWorktreeLeaf({ workspaceFolder: ctx.cwd, dataDir: ctx.dataDir, todoId: ctx.leaf1.id });
  assert.equal(found?.rootId, ctx.root.id);
  // Before the close only the claimed leaf 1 blocks leaf 2 (sequential tree).
  assert.equal(
    listReadyTodoLeaves(loadTodosData(ctx.dataDir, ctx.cwd).items).some((row) => row.id === ctx.leaf2.id),
    false,
  );

  const todo = getTodoById(ctx.dataDir, ctx.cwd, ctx.leaf1.id);
  const { closeOutcome, closeReason } = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: {}, row: {}, todo: { ...todo, review: { code: { state: 'passed' } } },
    reportedOutcomeRaw: 'success', leafOutcomes: { primaryOutcome: 'attempted' }, treeWorktreeWait: true,
  });
  assert.equal(closeOutcome, 'success');
  assert.equal(markTreeWorktreeLeafDone({
    workspaceFolder: ctx.cwd, dataDir: ctx.dataDir, todoId: ctx.leaf1.id, rootId: found.rootId,
  }), true);

  const at = '2026-10-23T10:00:00.000Z';
  const patch = buildWorkspaceWatcherCycleClosePatch({
    row: { failures: { [ctx.leaf1.id]: 1 }, decisions: [], activeCycles: [{ cycleId: 'c1', chatId: 'chat-1', todoIds: [ctx.leaf1.id] }] },
    cycle: { cycleId: 'c1', chatId: 'chat-1', todoIds: [ctx.leaf1.id] },
    outcome: closeOutcome,
    decisionReason: closeReason,
    extraDecisions: [buildTreeIntegrationWaitDecision({ at, todoId: ctx.leaf1.id, rootId: found.rootId })],
    todoIds: [ctx.leaf1.id],
    now: Date.parse(at),
    at,
    closeSource: 'report',
    workspaceFolder: ctx.cwd,
    dataDir: ctx.dataDir,
    todo,
  });
  assert.equal(patch.failures?.[ctx.leaf1.id], undefined, 'no failure is counted');
  assert.ok(patch.decisions.some((d) => d.reason === 'waiting_for_tree_integration'), 'Why? names the wait');

  const after = loadTodosData(ctx.dataDir, ctx.cwd).items;
  assert.equal(after.find((row) => row.id === ctx.leaf1.id).status, 'done');
  assert.equal(after.find((row) => row.id === ctx.leaf1.id).claimedByChatId ?? null, null);
  assert.equal(listReadyTodoLeaves(after).some((row) => row.id === ctx.leaf2.id), true, 'leaf 2 is startable');
});

test('a leaf outside any live tree worktree is not a tree-worktree leaf', () => {
  const ctx = setupTree();
  const stray = addTodo(ctx.dataDir, ctx.cwd, { title: 'stray', status: 'ready' }).item;
  assert.equal(resolveTreeWorktreeLeaf({ workspaceFolder: ctx.cwd, dataDir: ctx.dataDir, todoId: stray.id }), null);
});

const T0 = Date.parse('2026-10-23T10:00:00.000Z');

/** Claim leaf 1 and open a live cycle for it, as the Watcher does at start. */
function startLeafCycle(ctx, reviewState) {
  upsertWorkspaceWatcher(ctx.cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, maxParallel: 5, maxConsecutiveFailures: 3 },
  }, { dataDir: ctx.dataDir });
  updateTodo(ctx.dataDir, ctx.cwd, ctx.leaf1.id, {
    status: 'doing',
    claimedByChatId: 'orch-tree',
    expectedUpdatedAt: getTodoById(ctx.dataDir, ctx.cwd, ctx.leaf1.id).updatedAt,
  });
  if (reviewState) {
    writeTodoReview(ctx.dataDir, ctx.cwd, ctx.leaf1.id, { code: { state: reviewState, subject: 'code' } });
  }
  mutateWorkspaceWatcherRow(ctx.cwd, ({ row }) => ({
    failures: { [ctx.leaf1.id]: 1 },
    activeCycle: {
      cycleId: 'c-tree', todoIds: [ctx.leaf1.id], startedAt: new Date(T0).toISOString(),
      chatId: 'orch-tree', runId: 'run-seed', phase: 'running', mode: 'implement', planOnly: false,
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir: ctx.dataDir });
}

const report = (ctx) => reportWorkspaceWatcherCycle({
  workspaceFolder: ctx.cwd,
  dataDir: ctx.dataDir,
  now: T0,
  sourceChatId: 'orch-tree',
  outcome: 'success',
  todoIds: [ctx.leaf1.id],
  cycleId: 'c-tree',
  reportId: 'c-tree',
});

test('report path: tree-worktree leaf with review PASS closes done, no failure, Why? names the wait', async () => {
  const ctx = setupTree();
  startLeafCycle(ctx, 'passed');
  const result = await report(ctx);
  assert.equal(result.closed, true, result.reason);
  const items = loadTodosData(ctx.dataDir, ctx.cwd).items;
  assert.equal(items.find((row) => row.id === ctx.leaf1.id).status, 'done');
  assert.equal(items.find((row) => row.id === ctx.leaf1.id).claimedByChatId ?? null, null);
  assert.equal(listReadyTodoLeaves(items).some((row) => row.id === ctx.leaf2.id), true, 'leaf 2 is startable');
  const watcher = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.equal(watcher.failures?.[ctx.leaf1.id], undefined, 'failure counter is cleared');
  assert.ok(watcher.decisions.some((d) => d.reason === 'waiting_for_tree_integration'));
  assert.ok(!watcher.decisions.some((d) => d.reason === 'cycle_incomplete'));
});

test('report path: a tree-worktree leaf without a review PASS is still not closed as done', async () => {
  const ctx = setupTree();
  startLeafCycle(ctx, null);
  const result = await report(ctx);
  assert.equal(result.closed, true, result.reason);
  assert.notEqual(getTodoById(ctx.dataDir, ctx.cwd, ctx.leaf1.id).status, 'done');
  const watcher = getWorkspaceWatcher(ctx.cwd, { dataDir: ctx.dataDir });
  assert.ok(!watcher.decisions.some((d) => d.reason === 'waiting_for_tree_integration'));
});
