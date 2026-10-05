/**
 * Hard gates for delegations started from a Workspace Watcher orchestrator.
 *
 * The guard is the code half of "the Approval Broker cannot be bypassed": a
 * plan-only cycle, an unapproved plan, an allow-list mismatch and an active
 * harness usage limit all reject an implementation delegation before the
 * executor is ever started. The parent chat is read from the default chat store
 * (isolated by the helper), so that is where the orchestrator chat is created.
 */
import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import {
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { noteHarnessUsageLimit, clearHarnessUsageLimit } from '../lib/harness-usage-limits.js';
import { validateWorkspaceWatcherParentDelegation } from '../lib/workspace-watcher-delegation-guard.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-guard-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const cwd = path.join(tmpRoot, 'ws');
fs.mkdirSync(cwd, { recursive: true });
const parentChatId = 'orch-guard';
const todo = addTodo(dataDir, cwd, { title: 'guarded work', status: 'doing' }).item;

addChat('guard-session', 'guard orchestrator', '', cwd, 'mock', { id: parentChatId });
upsertWorkspaceWatcher(cwd, {
  mode: 'autopilot',
  policy: { requirePlanApproval: true, maxCyclesPerDay: 5 },
}, { dataDir });
mutateWorkspaceWatcherRow(cwd, () => ({
  activeCycle: {
    cycleId: 'guard-cycle',
    chatId: parentChatId,
    todoIds: [todo.id],
    phase: 'running',
    planOnly: false,
  },
}), { dataDir });

after(() => {
  removeIsolatedDataDir();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function approvePlan() {
  const current = getTodoById(dataDir, cwd, todo.id);
  updateTodo(dataDir, cwd, todo.id, {
    plan: { markdown: '# approved', approvedAt: new Date().toISOString() },
    expectedUpdatedAt: current.updatedAt,
  });
}

function setPlanOnly(value) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: { ...row.activeCycle, planOnly: value },
  }), { dataDir });
}

function setAllowedHarnesses(list) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    policy: { ...row.policy, allowedHarnesses: list },
  }), { dataDir });
}

test('the delegation guard rejects an implement delegation before plan approval', () => {
  clearHarnessUsageLimit('mock', '', dataDir);
  const planOnlyCycle = validateWorkspaceWatcherParentDelegation({
    parentChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(planOnlyCycle.ok, false);
  assert.equal(planOnlyCycle.code, 'watcher_plan_not_approved');

  // Planning itself is still allowed while the plan is pending.
  const planOk = validateWorkspaceWatcherParentDelegation({
    parentChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'plan',
    dataDir,
  });
  assert.equal(planOk.ok, true);

  approvePlan();
  const approved = validateWorkspaceWatcherParentDelegation({
    parentChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(approved.ok, true);
});

test('an approved ancestor plan lets a leaf with its own draft be implemented', () => {
  clearHarnessUsageLimit('mock', '', dataDir);
  const treeCwd = path.join(tmpRoot, 'ws-ancestor');
  fs.mkdirSync(treeCwd, { recursive: true });
  const root = addTodo(dataDir, treeCwd, { title: 'module', status: 'doing' }).item;
  updateTodo(dataDir, treeCwd, root.id, {
    plan: { markdown: '# module', approvedAt: new Date().toISOString() },
  });
  const phase = addTodo(dataDir, treeCwd, {
    title: 'phase',
    status: 'ready',
    parentId: root.id,
  }).item;
  updateTodo(dataDir, treeCwd, phase.id, { plan: { markdown: '# phase draft' } });
  const leaf = addTodo(dataDir, treeCwd, {
    title: 'leaf',
    status: 'ready',
    parentId: phase.id,
  }).item;
  updateTodo(dataDir, treeCwd, leaf.id, { plan: { markdown: '# leaf draft' } });
  const treeChatId = 'orch-ancestor';
  addChat('guard-session', 'ancestor orchestrator', '', treeCwd, 'mock', { id: treeChatId });
  upsertWorkspaceWatcher(treeCwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: true, maxCyclesPerDay: 5 },
  }, { dataDir });
  mutateWorkspaceWatcherRow(treeCwd, () => ({
    activeCycle: {
      cycleId: 'ancestor-cycle',
      chatId: treeChatId,
      todoIds: [leaf.id],
      phase: 'running',
      planOnly: false,
    },
  }), { dataDir });
  const allowed = validateWorkspaceWatcherParentDelegation({
    parentChatId: treeChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(allowed.ok, true);
});

test('the delegation guard enforces the allow-list, plan-only and usage limits', () => {
  setAllowedHarnesses(['deepseek']);
  const denied = validateWorkspaceWatcherParentDelegation({
    parentChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'watcher_harness_denied');
  setAllowedHarnesses([]);

  setPlanOnly(true);
  const planOnly = validateWorkspaceWatcherParentDelegation({
    parentChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(planOnly.ok, false);
  assert.equal(planOnly.code, 'watcher_plan_only');
  setPlanOnly(false);

  noteHarnessUsageLimit({
    harness: 'mock',
    source: 'rate-limit-event',
    status: 'rejected',
    resetAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    dataDir,
  });
  const limited = validateWorkspaceWatcherParentDelegation({
    parentChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'watcher_usage_limit');
});

test('the delegation guard only gates the cycle orchestrator chat', () => {
  addChat('other-session', 'someone else', '', cwd, 'mock', { id: 'someone-else' });
  const foreign = validateWorkspaceWatcherParentDelegation({
    parentChatId: 'someone-else',
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(foreign.ok, true);
});

test('the delegation guard authorizes per live slot and never leaks a sibling plan gate', () => {
  // The previous test leaves an active usage limit for `mock`; clear it so this
  // case isolates the per-slot plan gate.
  clearHarnessUsageLimit('mock', '', dataDir);
  const multiCwd = path.join(tmpRoot, 'ws-multi');
  fs.mkdirSync(multiCwd, { recursive: true });
  const planChatId = 'multi-plan-orch';
  const implChatId = 'multi-impl-orch';
  addChat('multi-plan-session', 'multi plan orchestrator', '', multiCwd, 'mock', { id: planChatId });
  addChat('multi-impl-session', 'multi impl orchestrator', '', multiCwd, 'mock', { id: implChatId });
  const planTodo = addTodo(dataDir, multiCwd, { title: 'plan slot', status: 'doing' }).item;
  const implTodo = addTodo(dataDir, multiCwd, { title: 'impl slot', status: 'doing' }).item;
  upsertWorkspaceWatcher(multiCwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, maxParallel: 2 },
  }, { dataDir });
  mutateWorkspaceWatcherRow(multiCwd, () => ({
    activeCycles: [
      { cycleId: 'plan-slot', chatId: planChatId, todoIds: [planTodo.id], phase: 'running', planOnly: true },
      { cycleId: 'impl-slot', chatId: implChatId, todoIds: [implTodo.id], phase: 'running', planOnly: false },
    ],
  }), { dataDir });

  // The plan-only slot is gated by its own flag...
  const planSlotBlocked = validateWorkspaceWatcherParentDelegation({
    parentChatId: planChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(planSlotBlocked.ok, false);
  assert.equal(planSlotBlocked.code, 'watcher_plan_only');

  // ...and the sibling slot is not affected by it.
  const siblingAllowed = validateWorkspaceWatcherParentDelegation({
    parentChatId: implChatId,
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(siblingAllowed.ok, true);

  // A chat that owns no live slot is never treated as a watcher orchestrator.
  addChat('no-slot-session', 'no slot', '', multiCwd, 'mock', { id: 'no-slot-chat' });
  const noSlot = validateWorkspaceWatcherParentDelegation({
    parentChatId: 'no-slot-chat',
    executor: { transport: 'mock', model: 'cheap' },
    assignment: 'implement',
    dataDir,
  });
  assert.equal(noSlot.ok, true);
});
