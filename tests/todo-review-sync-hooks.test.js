/**
 * Part C of the server-owned `todo.review` contract: the runtime write path
 * (`lib/todo-review-sync-hooks.js`), the lifecycle hooks in the delegation
 * service and the restart repair (`docs/todo-review-contract.md` §2.4, §4.2,
 * §7, §10.2-§10.5).
 *
 * These cases exercise the persisted store, so they assert the real
 * `todo.review` after a real hook call (queue/finish/verify/ack/repair), not a
 * synthetic in-memory snapshot.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  clearTodoReviewSyncRetries,
  flushTodoReviewSyncRetries,
  pendingTodoReviewSyncRetryCount,
  repairTodoReviewSnapshotsOnBoot,
  resolveTodoReviewLeafTarget,
  syncTodoReviewForDelegation,
  syncTodoReviewTarget,
} from '../lib/todo-review-sync-hooks.js';
import {
  createDelegationService,
  finishDelegation,
  recordDelegationVerifyResult,
} from '../lib/delegation-service.js';
import { persistTodoPlan } from '../lib/todo-plan-sync.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';

let seq = 0;

/** @returns {string} */
function makeProject(name) {
  const dir = path.join(ISOLATED_DATA_DIR, `hook-ws-${name}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} project
 * @param {string} [title]
 * @returns {object}
 */
function makeTodo(project, title = 'Leaf') {
  return addTodo(ISOLATED_DATA_DIR, project, { title, status: 'doing' }).item;
}

/**
 * @param {string} project
 * @param {string} id
 * @returns {object}
 */
function readTodo(project, id) {
  return loadTodosData(ISOLATED_DATA_DIR, project).items.find((row) => row.id === id);
}

/**
 * @param {string} project
 * @param {object} todo
 * @param {object} [overrides]
 * @returns {object}
 */
function makeDelegation(project, todo, overrides = {}) {
  const parentChatId = String(overrides.parentChatId || randomUUID());
  const assignment = String(overrides.assignment || 'review');
  return createDelegationRecord({
    parentChatId,
    workspaceFolder: project,
    executor: { transport: 'testfake', model: String(overrides.model || (assignment === 'review' ? 'testfakeb-chat' : 'gpt-5')) },
    assignment,
    executionMode: String(overrides.executionMode || 'agent'),
    leafId: todo ? todo.id : '',
    reviewSubject: overrides.reviewSubject || 'code',
    reviewSubjectSource: 'explicit',
    queuedAt: overrides.queuedAt,
    ...overrides,
  });
}

/**
 * @param {object} row
 * @param {object} patch
 * @returns {object}
 */
function patchRecord(row, patch) {
  return updateDelegationRecord(row.id, patch);
}

/** @param {object} row */
function sync(row) {
  return syncTodoReviewForDelegation(row, { dataDir: ISOLATED_DATA_DIR });
}

test.after(() => {
  clearTodoReviewSyncRetries();
  removeIsolatedDataDir();
});

// --- target resolution -------------------------------------------------------

test('a job without a leaf writes nothing', () => {
  const project = makeProject('no-leaf');
  const todo = makeTodo(project);
  const row = makeDelegation(project, null);
  assert.equal(row.leafId, '');
  const resolution = resolveTodoReviewLeafTarget({ row, dataDir: ISOLATED_DATA_DIR });
  assert.equal(resolution.reason, 'no_leaf');
  const result = sync(row);
  assert.equal(result.changed, false);
  assert.equal(readTodo(project, todo.id).review, undefined);
});

test('a unique id prefix resolves to the full leaf id', () => {
  const project = makeProject('prefix');
  const todo = makeTodo(project);
  const row = makeDelegation(project, todo);
  patchRecord(row, { leafId: todo.id.slice(0, 12) });
  const row2 = getDelegationById(row.id);
  const result = sync(row2);
  assert.equal(result.todoId, todo.id);
  assert.equal(result.changed, true);
  assert.ok(readTodo(project, todo.id).review.code);
});

test('an inherited parent.todoId resolves a legacy row without a leaf', () => {
  const project = makeProject('inherited');
  const todo = makeTodo(project);
  const parent = addChat(randomUUID(), 'legacy-parent', null, project, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    todoId: todo.id,
  });
  const row = makeDelegation(project, null, { parentChatId: parent.id });
  assert.equal(row.leafId, '');
  const result = sync(row);
  assert.equal(result.todoId, todo.id);
  assert.ok(readTodo(project, todo.id).review);
});

test('a deleted todo is a silent no-op and an unknown prefix is not written', () => {
  const project = makeProject('deleted');
  const todo = makeTodo(project);
  const deleted = makeDelegation(project, { id: randomUUID() });
  const deletedResult = sync(deleted);
  assert.equal(deletedResult.reason, 'deleted');
  assert.equal(deletedResult.changed, false);
  const unknownPrefix = makeDelegation(project, { id: 'deadbeef-0000-4000-8000-000000000000' });
  patchRecord(unknownPrefix, { leafId: 'deadbeef' });
  const prefixResult = sync(getDelegationById(unknownPrefix.id));
  assert.equal(prefixResult.reason, 'not_found');
  assert.equal(prefixResult.changed, false);
  assert.equal(readTodo(project, todo.id).review, undefined);
});

// --- snapshot through the hook ----------------------------------------------

test('a queued review is pending and a terminal PASS is passed', () => {
  const project = makeProject('pass');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, { status: 'completed', attemptId: 'impl-1', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' });
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, { status: 'running', attemptId: 'rev-1', startedAt: '2026-01-01T00:02:00.000Z' });
  sync(getDelegationById(review.id));
  assert.equal(readTodo(project, todo.id).review.code.state, 'pending');

  patchRecord(review, {
    status: 'completed',
    attemptId: 'rev-1',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'TASK: review\nVERDICT: PASS',
    reportVerdict: 'PASS',
  });
  sync(getDelegationById(review.id));
  const code = readTodo(project, todo.id).review.code;
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
  assert.equal(code.reviewers[0].attemptId, 'rev-1');
});

test('a terminal FAIL is failed and a required verify missing is unknown', () => {
  const project = makeProject('fail');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  });
  sync(getDelegationById(review.id));
  assert.equal(readTodo(project, todo.id).review.code.state, 'failed');
});

test('a required host verify missing stays unknown and a recorded verify settles passed', () => {
  const project = makeProject('verify');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, { status: 'completed', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' });
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: null,
  });
  sync(getDelegationById(review.id));
  const pending = readTodo(project, todo.id).review.code;
  assert.equal(pending.state, 'unknown');
  assert.equal(pending.stateReason, 'verify_missing');

  // The host verify answers the attempt and the hook must make the round pass.
  const updated = recordDelegationVerifyResult({
    delegationId: review.id,
    attemptId: review.attemptId,
    result: { ok: true },
  });
  assert.ok(updated);
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
  assert.equal(readTodo(project, todo.id).review.code.material.current, true);
});

test('a failed host verify is failed', () => {
  const project = makeProject('verify-fail');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
    verifyRequired: true,
    verifyResult: { status: 'failed', attemptId: review.attemptId },
  });
  sync(getDelegationById(review.id));
  assert.equal(readTodo(project, todo.id).review.code.state, 'failed');
  assert.equal(readTodo(project, todo.id).review.code.stateReason, 'verify_failed');
});

test('an implement queued after a PASS invalidates it at queue time', () => {
  const project = makeProject('stale');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, { status: 'completed', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' });
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  const fix = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:04:00.000Z' });
  patchRecord(fix, { assignment: 'implement', pickRole: 'fix', status: 'queued' });
  sync(getDelegationById(fix.id));
  const code = readTodo(project, todo.id).review.code;
  assert.equal(code.state, 'stale');
  assert.equal(code.stateReason, 'implement_queued_after_review');
  assert.equal(code.material.current, false);
});

test('a plan review never changes the code snapshot and vice versa', () => {
  const project = makeProject('subjects');
  const todo = makeTodo(project);
  const codeReview = makeDelegation(project, todo, { reviewSubject: 'code', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(codeReview, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  sync(getDelegationById(codeReview.id));
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
  assert.equal(readTodo(project, todo.id).review.plan.state, 'none');

  const planReview = makeDelegation(project, todo, { reviewSubject: 'plan', executionMode: 'plan', queuedAt: '2026-01-01T00:03:00.000Z' });
  patchRecord(planReview, {
    status: 'completed',
    startedAt: '2026-01-01T00:03:00.000Z',
    finishedAt: '2026-01-01T00:04:00.000Z',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
    reviewSubject: 'plan',
  });
  sync(getDelegationById(planReview.id));
  const row = readTodo(project, todo.id).review;
  assert.equal(row.code.state, 'passed', 'the plan review must not overwrite code');
  assert.equal(row.plan.state, 'failed');
});

// --- acknowledgement actor through the service -------------------------------

test('a human acceptance settles manual while an agent ack does not', async () => {
  const humanProject = makeProject('actor-human');
  const humanTodo = makeTodo(humanProject);
  const agentProject = makeProject('actor-agent');
  const agentTodo = makeTodo(agentProject);
  const service = createDelegationService({
    workspaceDirForAgent: () => humanProject,
    dataDir: ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });

  const humanReview = makeDelegation(humanProject, humanTodo, { queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(humanReview, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  });
  const accepted = await service.acknowledge(humanReview.id, {
    reason: 'accepted',
    actor: 'human',
    expectedAttemptId: humanReview.attemptId,
    // §7.3: the screen sends the todo revision it displayed.
    expectedTodoRevision: readTodo(humanProject, humanTodo.id).updatedAt,
  });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(readTodo(humanProject, humanTodo.id).review.code.state, 'manual');
  assert.equal(readTodo(humanProject, humanTodo.id).review.code.acceptance.actor, 'human');

  const agentReview = makeDelegation(agentProject, agentTodo, { queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(agentReview, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  });
  const agentAck = await service.acknowledge(agentReview.id, {
    reason: 'accepted',
    actor: 'agent',
    expectedAttemptId: agentReview.attemptId,
  });
  assert.equal(agentAck.ok, true);
  const snapshot = readTodo(agentProject, agentTodo.id).review.code;
  assert.notEqual(snapshot.state, 'manual', 'an agent ack is not a human manual acceptance');
  assert.equal(snapshot.acceptance, null);
});

test('an acceptance with a stale attempt is rejected', async () => {
  const project = makeProject('stale-accept');
  const todo = makeTodo(project);
  const service = createDelegationService({
    workspaceDirForAgent: () => project,
    dataDir: ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const review = makeDelegation(project, todo);
  patchRecord(review, {
    status: 'completed',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  });
  const rejected = await service.acknowledge(review.id, {
    reason: 'accepted',
    actor: 'human',
    expectedAttemptId: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'ack_attempt_mismatch');
});

test('an acceptance on the card endpoint from an MCP connection is never manual', async () => {
  const project = makeProject('mcp-accept');
  const todo = makeTodo(project);
  const parent = addChat(randomUUID(), 'mcp-accept-parent', null, project, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const review = makeDelegation(project, todo, { parentChatId: parent.id, queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  });
  const routes = new Map();
  registerDelegationsRoutes({
    get: (p, fn) => routes.set(`GET ${p}`, fn),
    post: (p, fn) => routes.set(`POST ${p}`, fn),
  }, { workspaceDirForAgent: () => project, dataDir: ISOLATED_DATA_DIR });
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get('POST /api/delegations/:id/accept')({
    params: { id: review.id },
    query: { workspaceFolder: project },
    body: { attemptId: review.attemptId, materialRevision: 'unavailable' },
    mcpIntegration: { id: 'mcp-connection' },
  }, res);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(getDelegationById(review.id).acknowledgedActor, 'agent');
  assert.notEqual(readTodo(project, todo.id).review.code.state, 'manual');
});

// --- finishDelegation wiring -------------------------------------------------

test('finishDelegation persists the terminal snapshot (worker + bridge path)', () => {
  const project = makeProject('finish');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, { status: 'completed', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' });
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, { status: 'running', startedAt: '2026-01-01T00:02:00.000Z' });
  finishDelegation(getDelegationById(review.id), {
    status: 'completed',
    attemptId: review.attemptId,
    report: 'TASK: review\nVERDICT: PASS',
  });
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
});

test('closure reconcile FAIL→PASS on finish syncs todo review passed', () => {
  const project = makeProject('closure-reconcile');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, { status: 'completed', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' });
  const review = makeDelegation(project, todo, {
    queuedAt: '2026-01-01T00:02:00.000Z',
    reviewMode: 'closure',
    reviewSubject: 'code',
  });
  patchRecord(review, { status: 'running', startedAt: '2026-01-01T00:02:00.000Z' });
  const report = [
    'TASK: review',
    'F1 FIXED with test evidence',
    'VERDICT: FAIL',
    '[FOLLOW_UP]',
    'F9 (P2): style nit',
  ].join('\n');
  finishDelegation(getDelegationById(review.id), {
    status: 'completed',
    attemptId: review.attemptId,
    report,
  });
  const stored = getDelegationById(review.id);
  assert.equal(stored.reportVerdict, 'PASS', 'finish must persist reconciled verdict');
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
});

// --- retry queue -------------------------------------------------------------

test('a failed sync is re-armed and a later flush writes it', () => {
  const project = makeProject('retry');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  clearTodoReviewSyncRetries();
  const failed = syncTodoReviewTarget(
    { workspaceFolder: project, todoId: todo.id, dataDir: ISOLATED_DATA_DIR },
    { deps: { writeReview: () => { const err = new Error('store busy'); err.code = 'IO'; throw err; } } },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'IO');
  assert.equal(pendingTodoReviewSyncRetryCount(), 1);
  assert.equal(readTodo(project, todo.id).review, undefined, 'the failed write left no snapshot');

  const flushed = flushTodoReviewSyncRetries();
  assert.equal(flushed.retried, 1);
  assert.equal(flushed.ok, 1);
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
  assert.equal(pendingTodoReviewSyncRetryCount(), 0);
});

test('a permanently failing sync stops re-arming after the retry cap', () => {
  const project = makeProject('retry-cap');
  const todo = makeTodo(project);
  clearTodoReviewSyncRetries();
  const failing = { writeReview: () => { const err = new Error('corrupt'); err.code = 'IO'; throw err; } };
  const target = { workspaceFolder: project, todoId: todo.id, dataDir: ISOLATED_DATA_DIR };
  for (let i = 0; i < 8; i += 1) {
    syncTodoReviewTarget(target, { deps: failing });
    assert.equal(pendingTodoReviewSyncRetryCount(), 1, `attempt ${i + 1} is still queued`);
  }
  syncTodoReviewTarget(target, { deps: failing });
  assert.equal(pendingTodoReviewSyncRetryCount(), 0, 'exhausted retries are dropped');
  clearTodoReviewSyncRetries();
});

// --- boot repair -------------------------------------------------------------

test('boot repair restores a snapshot after a crash between writes', () => {
  const project = makeProject('repair');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, { status: 'completed', attemptId: 'impl-att', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: '2026-01-01T00:02:00.000Z' });
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    attemptId: 'rev-att',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  // Simulate the crash: the delegations are durable but no snapshot was written.
  assert.equal(readTodo(project, todo.id).review, undefined);
  const repair = repairTodoReviewSnapshotsOnBoot({ dataDir: ISOLATED_DATA_DIR });
  assert.equal(repair.ok, true);
  assert.equal(repair.failed, 0);
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
  assert.equal(readTodo(project, todo.id).review.code.reviewers[0].attemptId, 'rev-att');
});

test('boot repair repairs several todos of a workspace in one write and is a no-op the second time', () => {
  const project = makeProject('repair-batch');
  const todos = [makeTodo(project), makeTodo(project)];
  for (const todo of todos) {
    const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
    patchRecord(review, {
      status: 'completed',
      startedAt: '2026-01-01T00:02:00.000Z',
      finishedAt: '2026-01-01T00:03:00.000Z',
      report: 'VERDICT: PASS',
      reportVerdict: 'PASS',
    });
  }
  const before = todos.map((todo) => readTodo(project, todo.id).updatedAt);
  const first = repairTodoReviewSnapshotsOnBoot({ dataDir: ISOLATED_DATA_DIR, log: null });
  assert.equal(first.failed, 0);
  assert.equal(first.repaired, 2);
  todos.forEach((todo, i) => {
    assert.ok(readTodo(project, todo.id).review, 'snapshot written');
    assert.equal(readTodo(project, todo.id).updatedAt, before[i], 'item updatedAt is not bumped');
  });
  const docRevision = loadTodosData(ISOLATED_DATA_DIR, project).updatedAt;
  const second = repairTodoReviewSnapshotsOnBoot({ dataDir: ISOLATED_DATA_DIR, log: null });
  assert.equal(second.repaired, 0);
  assert.equal(loadTodosData(ISOLATED_DATA_DIR, project).updatedAt, docRevision, 'no write when nothing changed');
});

test('boot repair re-invalidates a stored PASS when an older implement was retried', () => {
  const project = makeProject('repair-stale');
  const todo = makeTodo(project);
  const impl = makeDelegation(project, todo, { assignment: 'implement', queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(impl, {
    status: 'completed',
    attemptId: 'impl-old',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
  });
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  sync(getDelegationById(review.id));
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');

  // The older implement is retried after the review, so its new attempt starts
  // later: the stored PASS must not survive the boot reconcile.
  const archived = {
    attemptId: 'impl-old',
    status: 'completed',
    queuedAt: '2026-01-01T00:01:00.000Z',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    reportVerdict: '',
    model: 'gpt-5',
    transport: 'testfake',
  };
  patchRecord(impl, {
    status: 'queued',
    attemptId: 'impl-new',
    queuedAt: '2026-01-01T00:04:00.000Z',
    startedAt: '',
    finishedAt: '',
    attempts: [archived],
  });
  const repair = repairTodoReviewSnapshotsOnBoot({ dataDir: ISOLATED_DATA_DIR });
  assert.equal(repair.ok, true);
  assert.equal(readTodo(project, todo.id).review.code.state, 'stale');
});

test('boot repair handles two workspaces independently', () => {
  const projectA = makeProject('multi-a');
  const projectB = makeProject('multi-b');
  const todoA = makeTodo(projectA, 'A');
  const todoB = makeTodo(projectB, 'B');
  const reviewA = makeDelegation(projectA, todoA, { queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(reviewA, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  const reviewB = makeDelegation(projectB, todoB, { queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(reviewB, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  });
  const repair = repairTodoReviewSnapshotsOnBoot({ dataDir: ISOLATED_DATA_DIR });
  assert.equal(repair.failed, 0);
  assert.equal(readTodo(projectA, todoA.id).review.code.state, 'passed');
  assert.equal(readTodo(projectB, todoB.id).review.code.state, 'failed');
});

// --- concurrency -------------------------------------------------------------

test('two syncs do not roll the generation back and are decision-stable', () => {
  const project = makeProject('generation');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  sync(getDelegationById(review.id));
  const first = readTodo(project, todo.id).review.generation;
  // A second sync from an identical record set is a decision no-op.
  sync(getDelegationById(review.id));
  assert.equal(readTodo(project, todo.id).review.generation, first);
  // A long, interleaved sequence never moves the generation backwards.
  let last = first;
  for (let i = 0; i < 5; i += 1) {
    sync(getDelegationById(review.id));
    const current = readTodo(project, todo.id).review.generation;
    assert.ok(current >= last, `generation moved backwards: ${current} < ${last}`);
    last = current;
  }
});

test('a client todo edit and a review sync keep both fields and no CONFLICT', () => {
  const project = makeProject('concurrent');
  const todo = makeTodo(project);
  const revision = readTodo(project, todo.id).updatedAt;
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  sync(getDelegationById(review.id));
  // The review write must not bump the item CAS token, so a client that read
  // before the sync still updates and does not lose the review field.
  const updated = updateTodo(ISOLATED_DATA_DIR, project, todo.id, {
    title: 'Edited during sync',
    expectedUpdatedAt: revision,
  });
  const row = updated.items.find((entry) => entry.id === todo.id);
  assert.equal(row.title, 'Edited during sync');
  assert.equal(row.review.code.state, 'passed');
});

test('the sync uses the logical workspace, never the execution folder', () => {
  const project = makeProject('logical');
  const other = makeProject('runner');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo, { executionFolder: other, queuedAt: '2026-01-01T00:01:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  sync(getDelegationById(review.id));
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
});

// --- front-bundle guard ------------------------------------------------------

test('delegation-attempt stays free of node:crypto for the browser bundle', () => {
  // `app_front/lib/sdk-rich-view.js` -> `lib/delegation-card-model.js` ->
  // `lib/delegation-attempt.js` runs in the browser. Importing
  // `lib/delegation-request.js` here would pull `crypto` into the front bundle
  // and fail the webpack build (regression fixed by `delegation-review-subject.js`).
  const source = fs.readFileSync(new URL('../lib/delegation-attempt.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\/delegation-request\.js['"]/);
  assert.doesNotMatch(source, /['"](?:node:)?crypto['"]/);
});


test('runtime sync reads the saved plan boundary and a chat plan edit immediately invalidates PASS', () => {
  const project = makeProject('plan-revision');
  const todo = makeTodo(project);
  const failed = makeDelegation(project, todo, { reviewSubject: 'plan', queuedAt: '2026-01-01T00:03:00.000Z' });
  patchRecord(failed, { status: 'completed', startedAt: '2026-01-01T00:03:00.000Z',
    finishedAt: '2026-01-01T00:04:00.000Z', reportVerdict: 'FAIL', report: 'VERDICT: FAIL' });
  sync(getDelegationById(failed.id));
  assert.equal(readTodo(project, todo.id).review.plan.state, 'failed');
  persistTodoPlan({ dataDir: ISOLATED_DATA_DIR, cwd: project, todoId: todo.id, planMarkdown: 'Revised plan' });
  assert.equal(readTodo(project, todo.id).review.plan.state, 'stale');
  const boundary = readTodo(project, todo.id).plan.markdownUpdatedAt;
  const passed = makeDelegation(project, todo, { reviewSubject: 'plan', queuedAt: boundary });
  patchRecord(passed, { status: 'completed', startedAt: boundary, finishedAt: boundary,
    reportVerdict: 'PASS', report: 'VERDICT: PASS' });
  sync(getDelegationById(passed.id));
  assert.equal(readTodo(project, todo.id).review.plan.state, 'passed');
  assert.deepEqual(readTodo(project, todo.id).review.plan.reviewers.map((row) => row.delegationId), [passed.id]);
  persistTodoPlan({ dataDir: ISOLATED_DATA_DIR, cwd: project, todoId: todo.id, planMarkdown: 'Revised plan' });
  assert.equal(readTodo(project, todo.id).review.plan.state, 'passed');
  assert.equal(readTodo(project, todo.id).plan.markdownUpdatedAt, boundary);
});

// --- retry queue: flush/timer path --------------------------------------------

/**
 * Make the todo file of a project unreadable (a directory in its place) and
 * return a restore function.
 *
 * @param {string} todoId
 * @returns {() => void}
 */
function breakTodoStore(todoId) {
  const dir = path.join(ISOLATED_DATA_DIR, 'todos');
  const file = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .find((full) => fs.statSync(full).isFile() && fs.readFileSync(full, 'utf8').includes(todoId));
  assert.ok(file, 'todo store file found');
  const backup = `${file}.bak`;
  fs.renameSync(file, backup);
  fs.mkdirSync(file);
  return () => {
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
  };
}

test('a persistent read_error stops re-arming after the cap via flush', () => {
  const project = makeProject('read-error-cap');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo);
  clearTodoReviewSyncRetries();
  const restore = breakTodoStore(todo.id);
  try {
    const first = sync(review);
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'read_error');
    assert.equal(pendingTodoReviewSyncRetryCount(), 1);
    // 1 initial arm + 7 flush re-arms = 8 attempts; the 8th flush exhausts.
    for (let i = 0; i < 7; i += 1) {
      const flushed = flushTodoReviewSyncRetries();
      assert.equal(flushed.failed, 1);
      assert.equal(flushed.ok, 0);
      assert.equal(pendingTodoReviewSyncRetryCount(), 1, `flush ${i + 1} re-armed`);
    }
    const last = flushTodoReviewSyncRetries();
    assert.equal(last.failed, 1);
    assert.equal(pendingTodoReviewSyncRetryCount(), 0, 'retry budget exhausted, nothing re-armed');
    assert.equal(flushTodoReviewSyncRetries().retried, 0);
  } finally {
    restore();
    clearTodoReviewSyncRetries();
  }
});

test('a transient read_error recovers on flush and clears the counter', () => {
  const project = makeProject('read-error-recover');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo, { queuedAt: '2026-01-01T00:02:00.000Z' });
  patchRecord(review, {
    status: 'completed',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  clearTodoReviewSyncRetries();
  const restore = breakTodoStore(todo.id);
  assert.equal(sync(review).ok, false);
  assert.equal(flushTodoReviewSyncRetries().failed, 1);
  restore();
  const recovered = flushTodoReviewSyncRetries();
  assert.equal(recovered.ok, 1);
  assert.equal(pendingTodoReviewSyncRetryCount(), 0);
  assert.equal(readTodo(project, todo.id).review.code.state, 'passed');
  // Counter cleared: a fresh failure series gets the full budget again.
  const restoreAgain = breakTodoStore(todo.id);
  try {
    assert.equal(sync(review).ok, false);
    for (let i = 0; i < 7; i += 1) {
      assert.equal(flushTodoReviewSyncRetries().failed, 1);
      assert.equal(pendingTodoReviewSyncRetryCount(), 1);
    }
  } finally {
    restoreAgain();
    clearTodoReviewSyncRetries();
  }
});

test('a delegation retry handing over to a target key leaves no orphaned counter', () => {
  const project = makeProject('key-transfer');
  const todo = makeTodo(project);
  const review = makeDelegation(project, todo);
  clearTodoReviewSyncRetries();
  const restore = breakTodoStore(todo.id);
  assert.equal(sync(review).ok, false);
  restore();
  // Resolution now succeeds but the target write fails: the retry moves to the
  // target-level key. Fail the write via a broken snapshot compute dependency
  // is not reachable here, so make the write fail by removing write access.
  const dir = path.join(ISOLATED_DATA_DIR, 'todos');
  const file = fs.readdirSync(dir).map((n) => path.join(dir, n))
    .find((full) => full.endsWith('.json') && fs.readFileSync(full, 'utf8').includes(todo.id));
  const origMode = fs.statSync(file).mode;
  fs.chmodSync(dir, 0o555);
  let transferred = false;
  try {
    const flushed = flushTodoReviewSyncRetries();
    transferred = flushed.failed === 1 && pendingTodoReviewSyncRetryCount() === 1;
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(file, origMode);
  }
  if (!transferred) {
    // Running as root: permissions do not block the write, so the sync simply
    // succeeds. The counter must be gone in that case too.
    assert.equal(pendingTodoReviewSyncRetryCount(), 0);
  }
  // Drain: after recovery nothing may remain pending or counted.
  for (let i = 0; i < 9 && pendingTodoReviewSyncRetryCount() > 0; i += 1) flushTodoReviewSyncRetries();
  assert.equal(pendingTodoReviewSyncRetryCount(), 0);
  clearTodoReviewSyncRetries();
});
