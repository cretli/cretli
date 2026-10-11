/**
 * Part B of the server-owned `todo.review` contract: the pure snapshot builder
 * (`lib/todo-review-sync.js`). Covers the leaf snapshot matrix from
 * `docs/todo-review-contract.md` §2-§6, §9, §11 plus a regression gate that the
 * existing `buildDelegationQualityCycles` metrics are unchanged (P9).
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTodoReviewSnapshot, computeTodoReviewSnapshotForTodo } from '../lib/todo-review-sync.js';
import { buildDelegationQualityCycles } from '../lib/delegation-cycle-outcomes.js';
import { isIncompleteDelegationReport } from '../lib/delegation-verdict.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';

const WORKSPACE = '/tmp/leaf-snapshot-workspace';
const LEAF = 'aaaaaaaa-1111-4111-8111-111111111111';

/** @type {number} */
let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;
const t = (minute, second = 0) => `2026-01-01T00:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const NOW = Date.parse(t(50));

/**
 * @param {object} overrides
 * @returns {object}
 */
function materialRow(overrides = {}) {
  const queuedAt = overrides.queuedAt || overrides.createdAt || t(1);
  return {
    id: nextId('impl'),
    workspaceFolder: WORKSPACE,
    leafId: LEAF,
    parentChatId: 'parent-a',
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    attemptId: nextId('att'),
    queuedAt,
    createdAt: queuedAt,
    startedAt: overrides.startedAt || queuedAt,
    finishedAt: overrides.finishedAt || t(2),
    executor: { transport: 'opencode', model: 'gpt-5' },
    report: '',
    ...overrides,
  };
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function reviewRow(overrides = {}) {
  const queuedAt = overrides.queuedAt || overrides.createdAt || t(2);
  return {
    id: nextId('rev'),
    workspaceFolder: WORKSPACE,
    leafId: LEAF,
    parentChatId: 'parent-a',
    assignment: 'review',
    executionMode: 'agent',
    status: 'completed',
    attemptId: nextId('att'),
    queuedAt,
    createdAt: queuedAt,
    startedAt: overrides.startedAt || queuedAt,
    finishedAt: overrides.finishedAt || overrides.startedAt || queuedAt,
    executor: { transport: 'opencode', model: 'deepseek-chat' },
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    reportVerdict: 'PASS',
    verifyRequired: false,
    verifyResult: null,
    report: 'TASK: review\nVERDICT: PASS',
    ...overrides,
  };
}

/**
 * @param {object[]} rows
 * @param {string} [subject]
 * @param {object} [options]
 * @returns {object}
 */
function subjectSnapshot(rows, subject = 'code', options = {}) {
  const snapshot = buildTodoReviewSnapshot({ leafId: LEAF, rows, now: NOW, ...options });
  return snapshot[subject];
}

test('PASS: an implement followed by a usable review PASS is passed', () => {
  const impl = materialRow({ queuedAt: t(1), startedAt: t(1), finishedAt: t(2) });
  const review = reviewRow({ startedAt: t(3), finishedAt: t(3) });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
  assert.equal(code.material.current, true);
  assert.equal(code.implementer.delegationId, impl.id);
  assert.equal(code.implementer.attemptId, impl.attemptId);
  assert.equal(code.independence.class, 'different_base_model');
  assert.equal(code.independence.independent, true);
  assert.equal(code.reviewerCount, 1);
  assert.equal(code.reviewers[0].verdict, 'PASS');
  assert.equal(code.reviewers[0].usable, true);
});

test('FAIL: a usable FAIL settles the round as failed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({ startedAt: t(3), reportVerdict: 'FAIL', report: 'VERDICT: FAIL' });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'review_failed');
});

test('BLOCKED: a usable BLOCKED verdict settles the round as failed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({ startedAt: t(3), reportVerdict: 'BLOCKED', report: 'VERDICT: BLOCKED' });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'review_blocked');
});

test('a failed host verify settles the round as failed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({
    startedAt: t(3),
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: { status: 'failed', attemptId: 'attempt', recordedAt: t(4) },
  });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'verify_failed');
  assert.equal(code.reviewers[0].verifyStatus, 'failed');
});

test('a fix queued then cancelled without starting still invalidates the PASS', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({ startedAt: t(2) });
  const fix = materialRow({
    queuedAt: t(3),
    startedAt: '',
    status: 'queued',
    assignment: 'implement',
    pickRole: 'fix',
    finishedAt: '',
  });
  const beforeCancel = subjectSnapshot([impl, review, fix]);
  assert.equal(beforeCancel.state, 'stale');
  const cancelledFix = { ...fix, status: 'cancelled', finishedAt: t(4) };
  const afterCancel = subjectSnapshot([impl, review, cancelledFix]);
  assert.equal(afterCancel.state, 'stale', 'a queue-time invalidation is not undone by a later cancel');
  assert.equal(afterCancel.material.current, false);
});

test('fan-out PASS + cancelled sibling is unknown, never passed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const pass = reviewRow({ startedAt: t(3) });
  const cancelled = reviewRow({ startedAt: t(4), status: 'cancelled', report: 'stopped by user' });
  const code = subjectSnapshot([impl, pass, cancelled]);
  assert.equal(code.state, 'unknown');
  assert.notEqual(code.state, 'passed');
  assert.equal(code.reviewerCount, 2);
});

test('fan-out PASS + infra sibling is unknown, never passed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const pass = reviewRow({ startedAt: t(3) });
  const infra = reviewRow({ startedAt: t(4), status: 'failed', error: 'adapter_incomplete', report: '' });
  const code = subjectSnapshot([impl, pass, infra]);
  assert.equal(code.state, 'unknown');
});

test('fan-out FAIL + infra sibling stays failed (a FAIL is decisive)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const fail = reviewRow({ startedAt: t(3), reportVerdict: 'FAIL', report: 'VERDICT: FAIL' });
  const infra = reviewRow({ startedAt: t(4), status: 'failed', error: 'adapter_incomplete', report: '' });
  const code = subjectSnapshot([impl, fail, infra]);
  assert.equal(code.state, 'failed');
});

test('PASS without the required host verify is verify_missing (unknown)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({
    startedAt: t(3),
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: null,
  });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'verify_missing');
  assert.equal(code.reviewers[0].usable, false);
  assert.equal(code.reviewers[0].verifyStatus, 'required-missing');
});

test('a queued implement after a PASS makes it stale (queue-time invalidation)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({ startedAt: t(3) });
  const fix = materialRow({
    queuedAt: t(4),
    startedAt: '',
    status: 'queued',
    assignment: 'implement',
    pickRole: 'fix',
    finishedAt: '',
  });
  const code = subjectSnapshot([impl, review, fix]);
  assert.equal(code.state, 'stale');
  assert.equal(code.stateReason, 'implement_queued_after_review');
  assert.equal(code.material.current, false);
});

test('a fix queued after a human manual acceptance makes it stale', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({
    startedAt: t(2),
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
    acknowledgedAt: t(3),
    acknowledgedReason: 'accepted',
    acknowledgedActor: 'human',
    acknowledgedAttemptId: 'REVIEW_ATTEMPT',
  });
  review.attemptId = 'REVIEW_ATTEMPT';
  const beforeFix = subjectSnapshot([impl, review]);
  assert.equal(beforeFix.state, 'manual');
  assert.equal(beforeFix.acceptance.actor, 'human');
  const fix = materialRow({ queuedAt: t(4), startedAt: '', status: 'queued', finishedAt: '' });
  const afterFix = subjectSnapshot([impl, review, fix]);
  assert.equal(afterFix.state, 'stale');
});

test('passed -> new review -> fix -> cancel review does not stay passed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const oldPass = reviewRow({ id: 'rev-old-pass', startedAt: t(2) });
  const pending = reviewRow({ id: 'rev-pending', startedAt: t(3), status: 'running', reportVerdict: '' });
  const fix = materialRow({ queuedAt: t(4), startedAt: '', status: 'queued', finishedAt: '' });
  const cancelled = { ...pending, status: 'cancelled', finishedAt: t(5), report: 'cancelled' };
  const code = subjectSnapshot([impl, oldPass, fix, cancelled]);
  assert.notEqual(code.state, 'passed');
  assert.equal(code.state, 'stale');
});

test('a plan review and a code review keep separate snapshots', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const codePass = reviewRow({ id: 'rev-code', startedAt: t(2), reviewSubject: 'code' });
  const planFail = reviewRow({
    id: 'rev-plan',
    startedAt: t(3),
    reviewSubject: 'plan',
    pickRole: 'plan',
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
  });
  const snapshot = buildTodoReviewSnapshot({ leafId: LEAF, rows: [impl, codePass, planFail], now: NOW });
  assert.equal(snapshot.code.state, 'passed');
  assert.equal(snapshot.plan.state, 'failed');
});

test('a review without a reviewSubject contributes to other, never code', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const legacy = reviewRow({ startedAt: t(2) });
  delete legacy.reviewSubject;
  delete legacy.reviewSubjectSource;
  const snapshot = buildTodoReviewSnapshot({ leafId: LEAF, rows: [impl, legacy], now: NOW });
  assert.equal(snapshot.code.state, 'none');
  assert.equal(snapshot.other.state, 'passed');
  assert.equal(snapshot.other.subjectSource, 'unknown');
});

test('a review with no preceding implement is allowed and has no implementer', () => {
  const review = reviewRow({ startedAt: t(2) });
  const code = subjectSnapshot([review]);
  assert.equal(code.state, 'passed');
  assert.equal(code.implementer, null);
  assert.equal(code.independence.class, 'unknown');
  assert.equal(code.independence.reference, 'none');
});

test('cycles under different parent chats still aggregate on the leaf', () => {
  const impl1 = materialRow({ queuedAt: t(1), parentChatId: 'parent-one' });
  const review1 = reviewRow({ startedAt: t(2), parentChatId: 'parent-two' });
  const impl2 = materialRow({ queuedAt: t(3), parentChatId: 'parent-three' });
  const review2 = reviewRow({ startedAt: t(4), parentChatId: 'parent-four' });
  const code = subjectSnapshot([impl1, review1, impl2, review2]);
  assert.equal(code.state, 'passed', 'parentChatId must not scope the snapshot');
  assert.equal(code.implementer.delegationId, impl2.id, 'the latest round uses its own implementer');
  assert.equal(code.reviewerCount, 1);
  assert.equal(code.reviewers[0].delegationId, review2.id);
});

test('an old implement retried after a newer review invalidates the PASS', () => {
  const archived = {
    attemptId: 'old-attempt',
    status: 'completed',
    queuedAt: t(1),
    startedAt: t(1),
    finishedAt: t(2),
    reportVerdict: '',
    model: 'gpt-5',
    transport: 'opencode',
  };
  const impl = materialRow({
    queuedAt: t(4),
    startedAt: t(4),
    status: 'queued',
    attemptId: 'new-attempt',
    attempts: [archived],
  });
  const review = reviewRow({ startedAt: t(2) });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'stale', 'the retried implement was queued after the review');
  assert.equal(code.stateReason, 'implement_queued_after_review');
});

test('a retry of a review does not resurrect the stored PASS', () => {
  const archivedPass = {
    attemptId: 'archived-pass',
    status: 'completed',
    queuedAt: t(1),
    startedAt: t(1),
    finishedAt: t(2),
    reportVerdict: 'PASS',
    verifyRequired: false,
    model: 'deepseek-chat',
    transport: 'opencode',
  };
  const retry = reviewRow({
    attemptId: 'retry-attempt',
    queuedAt: t(3),
    startedAt: t(3),
    status: 'running',
    reportVerdict: '',
    report: '',
    attempts: [archivedPass],
  });
  const pending = subjectSnapshot([retry]);
  assert.equal(pending.state, 'pending');

  const terminalRetry = { ...retry, status: 'completed', startedAt: t(3), finishedAt: t(3) };
  const unknown = subjectSnapshot([terminalRetry]);
  assert.equal(unknown.state, 'unknown');
  assert.notEqual(unknown.state, 'passed');
});

test('a stale verify from the previous attempt does not satisfy the retried attempt', () => {
  const archivedPass = {
    attemptId: 'archived-pass',
    status: 'completed',
    queuedAt: t(1),
    startedAt: t(1),
    finishedAt: t(2),
    reportVerdict: 'PASS',
    verifyRequired: false,
    verifyResult: { status: 'passed', attemptId: 'archived-pass' },
    model: 'deepseek-chat',
    transport: 'opencode',
  };
  const retry = reviewRow({
    attemptId: 'retry-attempt',
    queuedAt: t(3),
    startedAt: t(3),
    finishedAt: t(3),
    reportVerdict: 'PASS',
    verifyRequired: true,
    verifyResult: null,
    attempts: [archivedPass],
  });
  const code = subjectSnapshot([retry]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'verify_missing');
});

test('a late-finishing but older review is stale, not current', () => {
  const review = reviewRow({ startedAt: t(1), finishedAt: t(9) });
  const impl = materialRow({ queuedAt: t(2), startedAt: t(2), finishedAt: t(3) });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'stale', 'chronology uses start time, not finishedAt');
});

test('a size-truncated report with a persisted verdict stays usable', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const longBody = 'x'.repeat(3000);
  assert.equal(isIncompleteDelegationReport(longBody), true, 'the raw body alone has no VERDICT line');
  const review = reviewRow({
    startedAt: t(2),
    report: longBody,
    reportVerdict: 'PASS',
    reportDegraded: true,
    reportSummary: 'truncated',
  });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'passed');
});

test('an attempt history truncated by retention settles as unknown', () => {
  const archived = [];
  for (let i = 0; i < 20; i += 1) {
    archived.push({
      attemptId: `archived-${i}`,
      status: 'completed',
      queuedAt: t(i + 1),
      startedAt: t(i + 1),
      finishedAt: t(i + 1),
      reportVerdict: 'PASS',
      verifyRequired: false,
      reviewSubject: 'code',
      reviewSubjectSource: 'explicit',
      model: 'deepseek-chat',
      transport: 'opencode',
    });
  }
  const current = reviewRow({
    attemptId: 'current-attempt',
    queuedAt: t(30),
    startedAt: t(30),
    reportVerdict: 'PASS',
    attempts: archived,
  });
  const code = subjectSnapshot([current]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'history_truncated');
  assert.equal(code.truncated, true);
});

test('a different leaf id contributes nothing to the snapshot', () => {
  const other = materialRow({ leafId: 'bbbbbbbb-2222-4222-8222-222222222222', queuedAt: t(1) });
  const review = reviewRow({ startedAt: t(2), reviewSubject: 'code' });
  const code = subjectSnapshot([other, review]);
  // Only the review has the target leaf, so it is a review-only round.
  assert.equal(code.state, 'passed');
  assert.equal(code.implementer, null);
});

test('the runtime wrapper reads the logical workspace regardless of parent chat', () => {
  const leaf = 'dddddddd-4444-4444-8444-444444444444';
  const impl = createDelegationRecord({
    parentChatId: 'wrapper-parent-impl',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'gpt-5' },
    assignment: 'implement',
    leafId: leaf,
    queuedAt: t(1),
  });
  updateDelegationRecord(impl.id, {
    status: 'completed',
    attemptId: 'wrapper-impl-attempt',
    startedAt: t(1),
    finishedAt: t(2),
  });
  const review = createDelegationRecord({
    parentChatId: 'wrapper-parent-review',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'deepseek-chat' },
    assignment: 'review',
    executionMode: 'agent',
    leafId: leaf,
    queuedAt: t(2),
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
  });
  updateDelegationRecord(review.id, {
    status: 'completed',
    attemptId: 'wrapper-review-attempt',
    startedAt: t(2),
    finishedAt: t(2),
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  const snapshot = computeTodoReviewSnapshotForTodo({
    todo: { id: leaf, workspaceFolder: ISOLATED_DATA_DIR },
    now: NOW,
  });
  assert.equal(snapshot.code.state, 'passed');
  assert.equal(snapshot.code.implementer.delegationId, impl.id);
  assert.equal(snapshot.code.reviewers[0].delegationId, review.id);
});

test('more reviewers than the cap settle the round as unknown', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const reviews = [];
  for (let i = 0; i < 65; i += 1) {
    reviews.push(reviewRow({
      id: `rev-cap-${i}`,
      attemptId: `att-cap-${i}`,
      startedAt: t(2, i),
      finishedAt: t(2, i),
    }));
  }
  const code = subjectSnapshot([impl, ...reviews]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'reviewer_cap');
  assert.equal(code.truncated, true);
  assert.equal(code.reviewers.length, 64);
});

// --- regression: existing quality-cycle metrics must not change (P9) ---------

/**
 * @param {object} overrides
 * @returns {object}
 */
function cycleRow(overrides = {}) {
  return {
    id: nextId('job'),
    parentChatId: 'regression-parent',
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    createdAt: t(1),
    startedAt: t(1),
    finishedAt: t(2),
    report: '',
    ...overrides,
  };
}

test('buildDelegationQualityCycles output is unchanged (part B regression)', () => {
  const implement = cycleRow({ id: 'reg-impl', createdAt: t(1) });
  const pass = cycleRow({
    id: 'reg-pass',
    assignment: 'review',
    reportVerdict: 'PASS',
    report: 'VERDICT: PASS',
    createdAt: t(3),
  });
  const fail = cycleRow({
    id: 'reg-fail',
    assignment: 'review',
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
    createdAt: t(4),
  });
  const cancel = cycleRow({
    id: 'reg-cancel',
    assignment: 'review',
    status: 'cancelled',
    report: 'stopped',
    createdAt: t(5),
  });
  const cycles = buildDelegationQualityCycles({
    rows: [implement, pass, fail, cancel],
    parentChatId: 'regression-parent',
  });
  assert.equal(cycles.length, 1);
  const [cycle] = cycles;
  assert.equal(cycle.implementId, 'reg-impl');
  assert.equal(cycle.qualityOutcome, 'rejected-by-review');
  assert.equal(cycle.acceptedByReview, false);
  assert.equal(cycle.manualAccepted, false);
  assert.equal(cycle.runClass, 'cancel');
  assert.deepEqual(cycle.reviewVerdicts, ['PASS', 'FAIL']);
  assert.deepEqual(cycle.jobIds, ['reg-impl', 'reg-pass', 'reg-fail', 'reg-cancel']);
});

test('round.index counts implement/fix rounds since the last PASS', () => {
  const impl1 = materialRow({ queuedAt: t(1), startedAt: t(1), finishedAt: t(2) });
  const failed = reviewRow({ startedAt: t(3), reportVerdict: 'FAIL', report: 'VERDICT: FAIL' });
  const impl2 = materialRow({ queuedAt: t(4), startedAt: t(4), finishedAt: t(5) });
  // No PASS yet: both implement rounds count.
  assert.equal(subjectSnapshot([impl1, failed, impl2]).round.index, 2);
  const passed = reviewRow({ startedAt: t(6) });
  assert.equal(subjectSnapshot([impl1, failed, impl2, passed]).round.index, 0, 'a PASS closes the count');
  const impl3 = materialRow({ queuedAt: t(7), startedAt: t(7), finishedAt: t(8) });
  assert.equal(subjectSnapshot([impl1, failed, impl2, passed, impl3]).round.index, 1);
});
