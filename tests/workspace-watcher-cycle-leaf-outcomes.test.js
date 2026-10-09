/**
 * Workspace Watcher cycle results and TODO-leaf outcomes.
 *
 * Covers the acceptance criteria of the "determine cycle and TODO-leaf
 * outcomes" leaf:
 *  - claimed ids and reported ids are separate; a foreign reported id is never
 *    counted as completed,
 *  - a reported success without a verifiable workspace state (missing todo or a
 *    read error) is a verified failure, never a success,
 *  - reported outcome and verified outcome stay separate metrics,
 *  - plan-only success is a saved plan (on the plan target), not a `done` todo,
 *  - partial completion across multiple leaves is snapshotted per leaf,
 *  - blocked reasons come from structured fields only.
 *
 * Uses a scratch data dir per case so no live project data is touched.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireWorkspaceWatcherLease,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import {
  beginWorkspaceWatcherCycleMetric,
  getWorkspaceWatcherCycleMetric,
} from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';
import {
  resolveWorkspaceWatcherCycleBlockedReasonCode,
  resolveWorkspaceWatcherCycleCloseOutcome,
  resolveWorkspaceWatcherCycleTodoOutcomes,
} from '../lib/workspace-watcher-cycle-close.js';
import { reportWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-leaf-outcomes-'));

/**
 * @param {string} name
 * @returns {string}
 */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} name
 * @returns {string}
 */
function makeWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} cwd
 * @param {string} dataDir
 * @returns {object}
 */
function setAutopilot(cwd, dataDir) {
  return upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 50,
      maxParallel: 5,
      maxConsecutiveFailures: 3,
    },
  }, { dataDir });
}

/**
 * Fabricate a live cycle slot without starting a chat run.
 *
 * @param {string} cwd
 * @param {string} dataDir
 * @param {{ cycleId: string, chatId: string, todoIds: string[], mode?: string, planTargetId?: string }} input
 * @returns {void}
 */
function seedActiveCycle(cwd, dataDir, input) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      cycleId: input.cycleId,
      todoIds: input.todoIds,
      startedAt: iso(T0),
      chatId: input.chatId,
      runId: 'run-seed',
      phase: 'running',
      mode: input.mode || 'implement',
      planOnly: input.mode === 'plan',
      ...(input.planTargetId ? { planTargetId: input.planTargetId } : {}),
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir });
}

test('multi-leaf snapshot separates claimed, reported and foreign ids', () => {
  const todos = {
    doneLeaf: { id: 'doneLeaf', status: 'done' },
    workLeaf: { id: 'workLeaf', status: 'doing' },
  };
  const outcome = resolveWorkspaceWatcherCycleTodoOutcomes({
    cycle: { todoIds: ['doneLeaf', 'workLeaf'], planOnly: false },
    reportedTodoIds: ['doneLeaf', 'ghost'],
    loadTodo: (id) => ({ found: Boolean(todos[id]), todo: todos[id] || null, readError: null }),
  });
  assert.deepEqual(outcome.claimedTodoIds, ['doneLeaf', 'workLeaf']);
  assert.deepEqual(outcome.reportedTodoIds, ['doneLeaf'], 'only a workspace-valid reported id is kept');
  assert.deepEqual(outcome.unknownReportedTodoIds, ['ghost']);
  assert.deepEqual(outcome.completedTodoIds, ['doneLeaf']);
  assert.deepEqual(outcome.attemptedTodoIds, ['workLeaf']);
  assert.equal(outcome.todoOutcomes.find((entry) => entry.todoId === 'ghost').outcome, 'unknown');
  assert.equal(outcome.primaryOutcome, 'completed');
});

test('plan-only verifies a saved plan on the plan target, not a done todo', () => {
  const cycle = { todoIds: ['leaf'], planOnly: true, planTargetId: 'root' };
  const loadPlanTargets = (id) => (id === 'root'
    ? { found: true, todo: { id: 'root', status: 'doing', plan: { markdown: '# plan' } }, readError: null }
    : { found: true, todo: { id: 'leaf', status: 'doing', plan: {} }, readError: null });

  const saved = resolveWorkspaceWatcherCycleTodoOutcomes({
    cycle,
    reportedTodoIds: ['leaf'],
    loadTodo: loadPlanTargets,
  });
  assert.equal(saved.planSaved, true);
  assert.equal(saved.primaryOutcome, 'attempted', 'the claimed leaf itself is not done');
  const closeSaved = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row: {},
    todo: { id: 'leaf', status: 'doing' },
    reportedOutcomeRaw: 'success',
    leafOutcomes: saved,
  });
  assert.equal(closeSaved.closeOutcome, 'success');
  assert.equal(closeSaved.closeReason, 'cycle_success');

  const unsaved = resolveWorkspaceWatcherCycleTodoOutcomes({
    cycle,
    reportedTodoIds: ['leaf'],
    loadTodo: (id) => ({ found: true, todo: { id, status: 'doing', plan: {} }, readError: null }),
  });
  assert.equal(unsaved.planSaved, false);
  const closeUnsaved = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row: {},
    todo: { id: 'leaf', status: 'doing' },
    reportedOutcomeRaw: 'success',
    leafOutcomes: unsaved,
  });
  assert.equal(closeUnsaved.closeOutcome, 'failure', 'a reported success without a plan is not verified');
});

test('reported success without a verifiable todo is never a success', () => {
  const cycle = { todoIds: ['gone'], planOnly: false };
  const missing = resolveWorkspaceWatcherCycleTodoOutcomes({
    cycle,
    loadTodo: () => ({ found: false, todo: null, readError: null }),
  });
  assert.equal(missing.primaryOutcome, 'unknown');
  const closeMissing = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row: {},
    todo: null,
    reportedOutcomeRaw: 'success',
    leafOutcomes: missing,
  });
  assert.equal(closeMissing.closeOutcome, 'failure');
  assert.equal(closeMissing.countIncompleteFailure, true);

  const readError = resolveWorkspaceWatcherCycleTodoOutcomes({
    cycle: { todoIds: ['busy'], planOnly: false },
    loadTodo: () => ({ found: false, todo: null, readError: 'EACCES' }),
  });
  assert.equal(readError.todoOutcomes[0].readError, 'EACCES');
  assert.equal(readError.todoOutcomes[0].outcome, 'unknown');
  const closeError = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: { todoIds: ['busy'], planOnly: false },
    row: {},
    todo: null,
    reportedOutcomeRaw: 'success',
    leafOutcomes: readError,
  });
  assert.equal(closeError.closeOutcome, 'failure');
});

test('reported and verified outcomes stay separate', () => {
  const success = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: { todoIds: ['t'], planOnly: false },
    row: {},
    todo: { id: 't', status: 'done' },
    reportedOutcomeRaw: 'success',
  });
  assert.equal(success.closeOutcome, 'success');

  const incomplete = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: { todoIds: ['t'], planOnly: false },
    row: {},
    todo: { id: 't', status: 'doing' },
    reportedOutcomeRaw: 'success',
  });
  assert.equal(incomplete.closeOutcome, 'failure');

  const blocked = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: { todoIds: ['t'], planOnly: false },
    row: {},
    todo: { id: 't', status: 'doing' },
    reportedOutcomeRaw: 'blocked',
  });
  assert.equal(blocked.closeOutcome, 'blocked');
});

test('blocked reason comes from structured fields only', () => {
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({ closeOutcome: 'success' }), null);
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'failure',
    planOnly: true,
    planSaved: false,
  }), 'plan_not_saved');
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'failure',
    planOnly: false,
    todoOutcomes: [{ outcome: 'unknown', readError: 'EACCES' }],
  }), 'todo_read_error');
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'failure',
    planOnly: false,
    todoOutcomes: [{ outcome: 'unknown', readError: null }],
  }), 'todo_missing');
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'failure',
    closeReason: 'missing_report',
    planOnly: false,
    todoOutcomes: [{ outcome: 'attempted' }],
  }), 'missing_report');
});

test('report success on a missing claimed todo persists a verified failure', () => {
  const dataDir = freshDataDir('missing-todo');
  const cwd = makeWorkspace('missing-todo');
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-missing', chatId: 'orch-missing', todoIds: ['ghost-claimed'] });
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'c-missing',
    workspaceFolder: cwd,
    mode: 'implement',
    orchestratorChatId: 'orch-missing',
    todoIds: ['ghost-claimed'],
    startedAt: iso(T0),
  });

  const result = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-missing',
    outcome: 'success',
    todoIds: ['ghost-claimed'],
    cycleId: 'c-missing',
    reportId: 'c-missing',
  });
  assert.equal(result.closed, true, result.reason);

  const record = getWorkspaceWatcherCycleMetric('c-missing', { dataDir });
  assert.equal(record.reportedOutcome, 'success', 'the model claim is preserved verbatim');
  assert.equal(record.closeOutcome, 'failure', 'the verified outcome is separate and not success');
  assert.equal(record.todoStatusAtClose, 'unknown');
  assert.deepEqual(record.claimedTodoIds, ['ghost-claimed']);
  assert.equal(record.todoOutcomes[0].outcome, 'unknown');
  assert.equal(record.blockedReasonCode, 'todo_missing');
});

test('reported partial completion across leaves counts only verified ids', () => {
  const dataDir = freshDataDir('partial');
  const cwd = makeWorkspace('partial');
  const doneLeaf = addTodo(dataDir, cwd, { title: 'done leaf', status: 'ready' }).item;
  setAutopilot(cwd, dataDir);
  updateTodo(dataDir, cwd, doneLeaf.id, {
    status: 'doing',
    claimedByChatId: 'orch-part',
    expectedUpdatedAt: getTodoById(dataDir, cwd, doneLeaf.id).updatedAt,
  });
  updateTodo(dataDir, cwd, doneLeaf.id, {
    status: 'done',
    expectedUpdatedAt: getTodoById(dataDir, cwd, doneLeaf.id).updatedAt,
  });
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-part', chatId: 'orch-part', todoIds: [doneLeaf.id] });
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'c-part',
    workspaceFolder: cwd,
    mode: 'implement',
    orchestratorChatId: 'orch-part',
    todoIds: [doneLeaf.id],
    startedAt: iso(T0),
  });

  const result = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-part',
    outcome: 'success',
    todoIds: [doneLeaf.id, 'foreign-leaf'],
    cycleId: 'c-part',
    reportId: 'c-part',
  });
  assert.equal(result.closed, true, result.reason);

  const record = getWorkspaceWatcherCycleMetric('c-part', { dataDir });
  assert.deepEqual(record.claimedTodoIds, [doneLeaf.id]);
  assert.deepEqual(record.reportedTodoIds, [doneLeaf.id], 'foreign reported ids are never validated');
  assert.deepEqual(record.unknownReportedTodoIds, ['foreign-leaf']);
  assert.deepEqual(record.completedTodoIds, [doneLeaf.id], 'only the verified done leaf counts');
  assert.equal(record.closeOutcome, 'success');
});

test('plan-only report success is verified by a saved plan on the plan target', () => {
  const dataDir = freshDataDir('plan-only');
  const cwd = makeWorkspace('plan-only');
  const root = addTodo(dataDir, cwd, { title: 'plan root', status: 'ready' }).item;
  const leaf = addTodo(dataDir, cwd, { title: 'plan leaf', status: 'ready', parentId: root.id }).item;
  setAutopilot(cwd, dataDir);
  updateTodo(dataDir, cwd, leaf.id, {
    status: 'doing',
    claimedByChatId: 'orch-plan',
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  seedActiveCycle(cwd, dataDir, {
    cycleId: 'c-plan',
    chatId: 'orch-plan',
    todoIds: [leaf.id],
    mode: 'plan',
    planTargetId: root.id,
  });
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'c-plan',
    workspaceFolder: cwd,
    mode: 'plan',
    orchestratorChatId: 'orch-plan',
    todoIds: [leaf.id],
    startedAt: iso(T0),
  });
  const before = getTodoById(dataDir, cwd, root.id);
  updateTodo(dataDir, cwd, root.id, {
    plan: { markdown: '# Root plan' },
    expectedUpdatedAt: before.updatedAt,
  });

  const result = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-plan',
    outcome: 'success',
    todoIds: [leaf.id],
    cycleId: 'c-plan',
    reportId: 'c-plan',
  });
  assert.equal(result.closed, true, result.reason);

  const record = getWorkspaceWatcherCycleMetric('c-plan', { dataDir });
  assert.equal(record.planOnly, true);
  assert.equal(record.planSaved, true);
  assert.equal(record.closeOutcome, 'success');
  assert.equal(record.todoStatusAtClose, 'doing', 'the TODO itself is not done');
});
