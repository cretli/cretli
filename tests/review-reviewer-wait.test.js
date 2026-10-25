import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  listActiveDelegationsForController,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { resetDelegationRuntimeHealth, tickDelegationRuntime } from '../lib/delegation-runtime-worker.js';
import {
  DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS,
  readReviewReviewerWaitMs,
  resolveEffectiveRunDeadlineEpoch,
} from '../lib/delegation-run-deadline.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { computeTodoPlanRevisionKey } from '../lib/plan-reviewer-cooperation.js';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { listDelegationsForController } from '../lib/persist/delegations-persist.js';
import { buildTodoReviewSnapshot } from '../lib/todo-review-sync.js';
import { inspectReviewRecheckWithoutChange } from '../lib/delegation-review-recheck-gate.js';
import {
  hangNextMockChatRunCancel,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
  seedMockChatRun,
} from '../lib/chat-run/mock-adapter.ts';
import {
  DELEGATION_CANCELLING_TIMEOUT_MS,
  isDelegationSlotOccupied,
  readDelegationCancellingTimeoutMs,
} from '../lib/delegation-status.js';
import { resolveDelegationParentWidth } from '../lib/delegation-width.js';

const WAIT_ENV = 'CRETLI_REVIEW_REVIEWER_WAIT_MS';
const CANCEL_ENV = 'CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS';

test.beforeEach(() => {
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
});

/**
 * @param {Record<string, string | undefined>} patch
 * @param {() => Promise<void> | void} fn
 */
async function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * @param {object} input
 * @returns {object}
 */
function runningReview(input) {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'child', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const runId = crypto.randomUUID();
  const created = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'review',
    pickRole: 'review',
    status: 'running',
    attemptId: crypto.randomUUID(),
    runId,
    leafId: input.leafId || '',
    reviewSubject: 'plan',
  });
  updateDelegationRecord(created.id, {
    startedAt: input.startedAt,
    runDefaultLimitActive: true,
    runId,
  });
  seedMockChatRun(child.id, { runId, busy: true, waitingForInput: false });
  return getDelegationById(created.id);
}

test('AC4: the two timeouts are read independently', async () => {
  await withEnv({ [WAIT_ENV]: '5000', [CANCEL_ENV]: undefined }, () => {
    assert.equal(readReviewReviewerWaitMs(), 5000);
    assert.equal(readDelegationCancellingTimeoutMs(), DELEGATION_CANCELLING_TIMEOUT_MS);
  });
  await withEnv({ [WAIT_ENV]: undefined, [CANCEL_ENV]: '7000' }, () => {
    assert.equal(readDelegationCancellingTimeoutMs(), 7000);
    assert.equal(readReviewReviewerWaitMs(), DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS);
  });
});

test('wait limit is the default hard limit of a review row only', async () => {
  const startedAt = '2026-10-12T10:00:00.000Z';
  const row = runningReview({ startedAt });
  await withEnv({ [WAIT_ENV]: '60000' }, () => {
    assert.equal(resolveEffectiveRunDeadlineEpoch(row), Date.parse(startedAt) + 60000);
  });
  finishDelegation(row, { status: 'cancelled' });
});

test('AC1: hung reviewer is cancelled at the wait limit and the round ends unknown/reviewer_timeout', async () => {
  const waitMs = 60000;
  const cancelMs = 30000;
  const leafId = 'aaaaaaaa-0000-4000-8000-00000000a001';
  const t0 = Date.parse('2026-10-12T10:00:00.000Z');
  await withEnv({ [WAIT_ENV]: String(waitMs), [CANCEL_ENV]: String(cancelMs) }, async () => {
    const hung = runningReview({ leafId, startedAt: new Date(t0).toISOString() });
    resetDelegationRuntimeHealth();
    const release = hangNextMockChatRunCancel();
    await tickDelegationRuntime({ now: t0 + waitMs - 1000, drainMailbox: false });
    assert.equal(getDelegationById(hung.id).status, 'running');
    await tickDelegationRuntime({ now: t0 + waitMs + 1, drainMailbox: false });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    const cancelling = getDelegationById(hung.id);
    assert.equal(cancelling.status, 'cancelling');
    assert.equal(cancelling.cancelCause, 'run_deadline_exceeded');
    // `cancelling` is not terminal: the round is still pending.
    const pending = buildTodoReviewSnapshot({ leafId, rows: [cancelling], now: t0 + waitMs + 2 });
    assert.equal(pending.plan.state, 'pending');
    release();
    patchMockChatRun(hung.childChatId, { busy: false, waitingForInput: false });
    await tickDelegationRuntime({ now: t0 + waitMs + cancelMs + 5000, drainMailbox: false });
    const done = getDelegationById(hung.id);
    assert.ok(['interrupted', 'cancelled'].includes(done.status), done.status);
    const snapshot = buildTodoReviewSnapshot({ leafId, rows: [done], now: t0 + waitMs + cancelMs + 6000 });
    assert.equal(snapshot.plan.state, 'unknown');
    assert.equal(snapshot.plan.stateReason, 'reviewer_timeout');
  });
});

/**
 * @param {object} overrides
 * @returns {object}
 */
function reviewAttempt(overrides) {
  return {
    id: crypto.randomUUID(),
    workspaceFolder: '/tmp/ws',
    leafId: 'leaf-1',
    parentChatId: 'p',
    assignment: 'review',
    executionMode: 'agent',
    attemptId: crypto.randomUUID(),
    queuedAt: '2026-01-01T00:02:00.000Z',
    startedAt: '2026-01-01T00:02:00.000Z',
    executor: { transport: 'opencode', model: 'm' },
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    ...overrides,
  };
}

test('timed-out reviewer is not ignorable: sibling PASS does not close the round', () => {
  const pass = reviewAttempt({
    status: 'completed', reportVerdict: 'PASS', report: 'VERDICT: PASS',
    finishedAt: '2026-01-01T00:03:00.000Z', executor: { transport: 'opencode', model: 'a' },
  });
  const timedOut = reviewAttempt({
    status: 'interrupted', interruptCode: 'cancel_unconfirmed', cancelCause: 'run_deadline_exceeded',
    metrics: { tool_calls_n: 0 }, finishedAt: '2026-01-01T00:04:00.000Z',
    executor: { transport: 'opencode', model: 'b' },
  });
  const impl = {
    ...reviewAttempt({ status: 'completed', assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' }),
    finishedAt: '2026-01-01T00:01:30.000Z',
  };
  const snap = buildTodoReviewSnapshot({
    leafId: 'leaf-1', rows: [impl, pass, timedOut], now: Date.parse('2026-01-01T00:10:00.000Z'),
  });
  assert.equal(snap.code.state, 'unknown');
  assert.equal(snap.code.stateReason, 'reviewer_timeout');
});

test('AC2: after cancel_unconfirmed no new reviewer fits until the slot is released manually', () => {
  const parentChatId = `parent-${crypto.randomUUID()}`;
  const row = createDelegationRecord({
    parentChatId,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'review',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
  });
  updateDelegationRecord(row.id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
    cancelCause: 'run_deadline_exceeded',
  });
  assert.equal(isDelegationSlotOccupied(getDelegationById(row.id)), true);
  const blocked = resolveDelegationParentWidth({
    active: listActiveDelegationsForController(parentChatId),
    incomingAssignment: 'review',
    fanout: 2,
  });
  assert.equal(blocked.ok, false);
  const service = createDelegationService({ isModelAvailable: () => true });
  assert.equal(service.confirmManualSlotRelease(row.id, { confirmation: true, note: 'killed' }).ok, true);
  const freed = resolveDelegationParentWidth({
    active: listActiveDelegationsForController(parentChatId),
    incomingAssignment: 'review',
    fanout: 2,
  });
  assert.equal(freed.ok, true);
  assert.equal(isDelegationSlotOccupied(getDelegationById(row.id)), false);
});

test('AC3: recheck without a material change is refused; implement/fix, other reviewer and override pass', () => {
  const parentChatId = `parent-${crypto.randomUUID()}`;
  const leafId = 'bbbbbbbb-0000-4000-8000-00000000b001';
  const executor = { transport: 'opencode', model: 'rev-a' };
  const review = createDelegationRecord({
    parentChatId,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor,
    assignment: 'review',
    status: 'completed',
    leafId,
    reviewSubject: 'code',
  });
  updateDelegationRecord(review.id, {
    reportVerdict: 'FAIL',
    queuedAt: new Date(Date.now() - 60000).toISOString(),
  });
  const base = { parentChatId, assignment: 'review', reviewSubject: 'code', leafId, executor };
  const refused = inspectReviewRecheckWithoutChange(base);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'review_recheck_no_material_change');
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, executor: { transport: 'opencode', model: 'rev-b' } }).ok, true);
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, allowRecheck: true }).ok, true);
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, assignment: 'implement' }).ok, true);
  createDelegationRecord({
    parentChatId,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'impl' },
    assignment: 'implement',
    status: 'queued',
    leafId,
  });
  assert.equal(inspectReviewRecheckWithoutChange(base).ok, true);
});

test('F3: timed-out reviewer with a persisted FAIL makes the round failed; PASS/no verdict stay unknown', () => {
  const failed = reviewAttempt({
    status: 'interrupted', cancelCause: 'run_deadline_exceeded', reportVerdict: 'FAIL',
    finishedAt: '2026-01-01T00:04:00.000Z',
  });
  const now = Date.parse('2026-01-01T00:10:00.000Z');
  const snapFail = buildTodoReviewSnapshot({ leafId: 'leaf-1', rows: [failed], now });
  assert.equal(snapFail.code.state, 'failed');
  const timedPass = reviewAttempt({
    status: 'interrupted', cancelCause: 'run_deadline_exceeded', reportVerdict: 'PASS',
    finishedAt: '2026-01-01T00:04:00.000Z',
  });
  const snapPass = buildTodoReviewSnapshot({ leafId: 'leaf-1', rows: [timedPass], now });
  assert.equal(snapPass.code.state, 'unknown');
  assert.equal(snapPass.code.stateReason, 'reviewer_timeout');
});

test('busy hung reviewer (review_cancel_stuck + run_deadline_exceeded) is reviewer_timeout and not ignorable', () => {
  const pass = reviewAttempt({
    status: 'completed', reportVerdict: 'PASS', report: 'VERDICT: PASS',
    finishedAt: '2026-01-01T00:03:00.000Z', executor: { transport: 'opencode', model: 'a' },
  });
  const stuck = reviewAttempt({
    status: 'interrupted', interruptCode: 'review_cancel_stuck', cancelCause: 'run_deadline_exceeded',
    metrics: { tool_calls_n: 0 }, finishedAt: '2026-01-01T00:04:00.000Z',
    executor: { transport: 'opencode', model: 'b' },
  });
  const snap = buildTodoReviewSnapshot({
    leafId: 'leaf-1', rows: [pass, stuck], now: Date.parse('2026-01-01T00:10:00.000Z'),
  });
  assert.equal(snap.code.state, 'unknown');
  assert.equal(snap.code.stateReason, 'reviewer_timeout');
});

/**
 * Start a review through the service with the shape real callers use
 * (`task_text` source), returning the start result.
 */
function recheckHarness(reviewSubject, leafId, workspace = ISOLATED_DATA_DIR) {
  const service = createDelegationService({
    workspaceDirForAgent: () => workspace,
    isModelAvailable: () => true,
  });
  const parent = addChat(crypto.randomUUID(), 'recheck parent', null, workspace, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const start = (extra) => service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: `Independent ${reviewSubject} review of ${leafId}.`,
    assignment: 'review',
    reviewSubject,
    leafId,
    executor: { transport: 'opencode', model: 'opencode/rev-a' },
    returnWhenStarting: true,
    idempotencyKey: `recheck-${crypto.randomUUID()}`,
    ...extra,
  });
  const rows = () => listDelegationsForController(parent.id);
  // Finish every live row of the parent so the next start is not queued behind it.
  const settle = (verdict) => {
    for (const row of rows()) {
      if (['completed', 'cancelled', 'failed', 'interrupted'].includes(row.status)) continue;
      finishDelegation(row, { status: verdict ? 'completed' : 'failed' });
      if (verdict) updateDelegationRecord(row.id, { reportVerdict: verdict });
    }
  };
  return { parent, start, rows, settle };
}

test('F1: plan recheck gate through createAndStart with a task_text source (T1-T6)', async () => {
  // A real todo makes the start path read the workspace Git status.
  const workspace = createTempRepo().dir;
  const todo = addTodo(ISOLATED_DATA_DIR, workspace, {
    title: 'Recheck plan root',
    body: 'Root todo whose plan is reviewed.',
    status: 'idea',
    idempotencyKey: `recheck-plan-${crypto.randomUUID()}`,
  }).item;
  updateTodo(ISOLATED_DATA_DIR, workspace, todo.id, { plan: { markdown: '# Plan\n\nVersion 1\n\n- step one' } });
  const expectedKey = computeTodoPlanRevisionKey(getTodoById(ISOLATED_DATA_DIR, workspace, todo.id));
  const { start, rows, settle } = recheckHarness('plan', todo.id, workspace);
  // T6: a previous review without a usable verdict does not block a rerun.
  const first = await start({});
  assert.notEqual(first.ok, false, JSON.stringify(first));
  // T1: the row carries the todo plan revision key, with no chat plan involved.
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].todoPlanRevisionKey, expectedKey);
  assert.equal(rows()[0].planRevision, 0);
  assert.equal(getDelegationById(rows()[0].id).todoPlanRevisionKey, expectedKey);
  settle('');
  const afterUnusable = await start({});
  assert.notEqual(afterUnusable.code, 'review_recheck_no_material_change');
  assert.equal(rows().length, 2);
  settle('FAIL');
  // T2: same reviewer, unchanged todo plan, usable verdict -> refused.
  const before = rows().length;
  const refused = await start({});
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'review_recheck_no_material_change');
  assert.equal(refused.status, 409);
  // An effort suffix is the same reviewer (pick_reason satisfies the premium-tier gate).
  const suffixed = await start({
    executor: { transport: 'opencode', model: 'opencode/rev-a::effort=high' },
    pickReason: 'effort variant of the same reviewer',
  });
  assert.equal(suffixed.ok, false);
  assert.equal(suffixed.code, 'review_recheck_no_material_change');
  assert.equal(rows().length, before, 'no row created on refusal');
  // T4: a different base model is a different reviewer.
  const other = await start({ executor: { transport: 'opencode', model: 'opencode/rev-b' } });
  assert.notEqual(other.code, 'review_recheck_no_material_change');
  assert.equal(rows().length, before + 1);
  settle('PASS');
  // T5: explicit override.
  const override = await start({ allowRecheck: true });
  assert.notEqual(override.code, 'review_recheck_no_material_change');
  assert.equal(rows().length, before + 2);
  settle('FAIL');
  // Still refused for rev-a on the unchanged plan after the override run.
  assert.equal((await start({})).code, 'review_recheck_no_material_change');
  // T3: the todo plan markdown changed -> allowed, and the new key is stored.
  updateTodo(ISOLATED_DATA_DIR, workspace, todo.id, { plan: { markdown: '# Plan\n\nVersion 2\n\n- step one\n- step two' } });
  const nextKey = computeTodoPlanRevisionKey(getTodoById(ISOLATED_DATA_DIR, workspace, todo.id));
  assert.notEqual(nextKey, expectedKey);
  const changed = await start({});
  assert.notEqual(changed.code, 'review_recheck_no_material_change');
  assert.equal(rows().length, before + 3);
  assert.equal(rows().filter((row) => row.todoPlanRevisionKey === nextKey).length, 1);
  settle('PASS');
  assert.equal((await start({})).code, 'review_recheck_no_material_change');
  settle('');
});

test('F1 fallbacks: missing todo, todo without a plan, legacy row and exchange phase are allowed', () => {
  const parentChatId = `parent-${crypto.randomUUID()}`;
  const leafId = 'eeeeeeee-0000-4000-8000-00000000e001';
  const executor = { transport: 'opencode', model: 'opencode/rev-a' };
  const seed = (todoPlanRevisionKey) => {
    const row = createDelegationRecord({
      parentChatId,
      childChatId: `child-${crypto.randomUUID()}`,
      workspaceFolder: ISOLATED_DATA_DIR,
      executor,
      assignment: 'review',
      reviewSubject: 'plan',
      status: 'completed',
      leafId,
      todoPlanRevisionKey,
    });
    updateDelegationRecord(row.id, { reportVerdict: 'FAIL' });
  };
  const gate = (extra) => inspectReviewRecheckWithoutChange({
    parentChatId, assignment: 'review', reviewSubject: 'plan', leafId, executor, ...extra,
  });
  // Legacy row without a stored key: "unchanged" cannot be proven.
  seed('');
  assert.equal(gate({ todoPlanRevisionKey: 'key-1' }).ok, true);
  seed('key-1');
  assert.equal(gate({ todoPlanRevisionKey: 'key-1' }).ok, false);
  // Todo missing or without a plan -> the start path passes an empty key.
  assert.equal(gate({ todoPlanRevisionKey: '' }).ok, true);
  assert.equal(gate({ todoPlanRevisionKey: 'key-1', planReviewerPhase: 'exchange' }).ok, true);
  assert.equal(gate({ todoPlanRevisionKey: 'key-1', exchangeOfDelegationId: 'd-1' }).ok, true);
});

test('F1: a plan review of a leaf id without a todo starts and stores no key', async () => {
  const { start, rows, settle } = recheckHarness('plan', 'eeeeeeee-0000-4000-8000-00000000e002');
  const first = await start({});
  assert.notEqual(first.ok, false, JSON.stringify(first));
  assert.equal(rows()[0].todoPlanRevisionKey, '');
  settle('FAIL');
  const second = await start({});
  assert.notEqual(second.code, 'review_recheck_no_material_change');
  settle('');
});

test('N3: code recheck gate through createAndStart with a task_text source', async () => {
  const leafId = 'eeeeeeee-0000-4000-8000-00000000e003';
  const { parent, start, rows, settle } = recheckHarness('code', leafId);
  const first = await start({});
  assert.notEqual(first.ok, false, JSON.stringify(first));
  assert.equal(rows().length, 1);
  settle('FAIL');
  const refused = await start({});
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'review_recheck_no_material_change');
  assert.equal(rows().length, 1, 'no row created on refusal');
  // A fix queued after that review changes the material.
  createDelegationRecord({
    parentChatId: parent.id,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/impl' },
    assignment: 'implement',
    workflowRole: 'fix',
    status: 'completed',
    leafId,
    queuedAt: new Date(Date.now() + 1000).toISOString(),
  });
  const afterFix = await start({});
  assert.notEqual(afterFix.code, 'review_recheck_no_material_change');
  settle('');
});

test('F4: retry clears attempt-scoped deadline evidence (cancelCause / runDeadlineCancelKey)', async () => {
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const parent = addChat(crypto.randomUUID(), 'retry parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'retry child', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'review',
    reviewSubject: 'plan',
    sourceKind: 'text',
    sourceText: 'retry me',
    executionMode: 'agent',
    status: 'failed',
    finishedAt: new Date().toISOString(),
  });
  updateDelegationRecord(row.id, {
    cancelCause: 'run_deadline_exceeded',
    runDeadlineCancelKey: 'key-1',
  });
  const result = await service.retry(row.id);
  const after = getDelegationById(row.id);
  if (result.ok === false) assert.fail(`retry refused: ${result.code}`);
  assert.equal(after.cancelCause, '');
  assert.equal(after.runDeadlineCancelKey, '');
  assert.equal(after.attempts.length, 1);
  finishDelegation(after, { status: 'cancelled' });
});

test('reviewer wait is an upper bound for review rows, not for implement rows', async () => {
  const startedAt = '2026-10-12T10:00:00.000Z';
  const startedMs = Date.parse(startedAt);
  const far = '2099-01-01T00:00:00.000Z';
  const early = new Date(startedMs + 10000).toISOString();
  const rowOf = (assignment, runDeadlineAt) => ({
    id: `row-${crypto.randomUUID()}`, assignment, startedAt, runDefaultLimitActive: true, runDeadlineAt,
  });
  await withEnv({ [WAIT_ENV]: '60000' }, () => {
    // Explicit far-future deadline on a review row is still capped by the wait.
    assert.equal(resolveEffectiveRunDeadlineEpoch(rowOf('review', far)), startedMs + 60000);
    // An explicit deadline earlier than the cap still wins.
    assert.equal(resolveEffectiveRunDeadlineEpoch(rowOf('review', early)), startedMs + 10000);
    // Implement rows keep the explicit-deadline-wins behaviour.
    assert.equal(resolveEffectiveRunDeadlineEpoch(rowOf('implement', far)), Date.parse(far));
  });
  await withEnv({ [WAIT_ENV]: '0' }, () => {
    // wait=0 disables the cap: the explicit deadline stands (or none).
    assert.equal(resolveEffectiveRunDeadlineEpoch(rowOf('review', far)), Date.parse(far));
    assert.equal(resolveEffectiveRunDeadlineEpoch(rowOf('review', '')), null);
  });
  await withEnv({ [WAIT_ENV]: '60000' }, () => {
    // Without the default-limit marker no cap applies.
    const noMarker = { ...rowOf('review', far), runDefaultLimitActive: false };
    assert.equal(resolveEffectiveRunDeadlineEpoch(noMarker), Date.parse(far));
  });
});

test('two rounds after reviewer_timeout: no quorum across rounds, FAIL is never hidden', () => {
  const now = Date.parse('2026-01-01T00:30:00.000Z');
  const impl1 = {
    ...reviewAttempt({ status: 'completed', assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' }),
    startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:01:30.000Z',
  };
  const oldPass = reviewAttempt({
    status: 'completed', reportVerdict: 'PASS', report: 'VERDICT: PASS',
    finishedAt: '2026-01-01T00:03:00.000Z', executor: { transport: 'opencode', model: 'a' },
  });
  const timedOut = reviewAttempt({
    status: 'interrupted', interruptCode: 'review_cancel_stuck', cancelCause: 'run_deadline_exceeded',
    finishedAt: '2026-01-01T00:04:00.000Z', executor: { transport: 'codex', model: 'b' },
  });
  const replacementPass = reviewAttempt({
    status: 'completed', reportVerdict: 'PASS', report: 'VERDICT: PASS',
    queuedAt: '2026-01-01T00:05:00.000Z', startedAt: '2026-01-01T00:05:00.000Z',
    finishedAt: '2026-01-01T00:06:00.000Z', executor: { transport: 'codex', model: 'b' },
  });
  // Same material: the old-round PASS plus the replacement PASS never form a
  // quorum; the timed-out attempt keeps the round unknown (observation only).
  const mixed = buildTodoReviewSnapshot({ leafId: 'leaf-1', rows: [impl1, oldPass, timedOut, replacementPass], now });
  assert.equal(mixed.code.state, 'unknown');
  assert.equal(mixed.code.stateReason, 'reviewer_timeout');
  // A genuine FAIL from the replacement is not hidden by the timeout.
  const replacementFail = reviewAttempt({
    status: 'completed', reportVerdict: 'FAIL', report: 'VERDICT: FAIL',
    queuedAt: '2026-01-01T00:05:00.000Z', startedAt: '2026-01-01T00:05:00.000Z',
    finishedAt: '2026-01-01T00:06:00.000Z', executor: { transport: 'qwen', model: 'c' },
  });
  const failed = buildTodoReviewSnapshot({ leafId: 'leaf-1', rows: [impl1, oldPass, timedOut, replacementFail], now });
  assert.equal(failed.code.state, 'failed');
  // A NEW round (new implement/fix material) is judged on its own reviewers:
  // the old-round PASS and the timed-out attempt do not leak into it.
  const impl2 = {
    ...reviewAttempt({ status: 'completed', assignment: 'implement', queuedAt: '2026-01-01T00:07:00.000Z' }),
    startedAt: '2026-01-01T00:07:00.000Z', finishedAt: '2026-01-01T00:08:00.000Z',
  };
  const newBlocked = reviewAttempt({
    status: 'completed', reportVerdict: 'BLOCKED', report: 'VERDICT: BLOCKED',
    queuedAt: '2026-01-01T00:09:00.000Z', startedAt: '2026-01-01T00:09:00.000Z',
    finishedAt: '2026-01-01T00:10:00.000Z', executor: { transport: 'codex', model: 'b' },
  });
  const round2Blocked = buildTodoReviewSnapshot({ leafId: 'leaf-1', rows: [impl1, oldPass, timedOut, impl2, newBlocked], now });
  assert.equal(round2Blocked.code.state, 'failed');
  const newPass = { ...newBlocked, id: crypto.randomUUID(), attemptId: crypto.randomUUID(), reportVerdict: 'PASS', report: 'VERDICT: PASS' };
  const round2 = buildTodoReviewSnapshot({ leafId: 'leaf-1', rows: [impl1, oldPass, timedOut, impl2, newPass], now });
  assert.equal(round2.code.state, 'passed');
  assert.equal(round2.code.reviewerCount, 1, 'only the new-round reviewer is counted');
});
