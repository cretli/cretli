/**
 * Part B of the server-owned `todo.review` contract: the pure snapshot builder
 * (`lib/todo-review-sync.js`). Covers the leaf snapshot matrix from
 * `docs/todo-review-contract.md` §2-§6, §9, §11 plus a regression gate that the
 * existing `buildDelegationQualityCycles` metrics are unchanged (P9).
 */
import { snapshotDelegationAttempt } from '../lib/delegation-attempt.js';
import './fixtures/fake-transport.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTodoReviewSnapshot, computeTodoReviewSnapshotForTodo, evaluateTodoLeafAutoClose, isReviewRoundInfraAttempt } from '../lib/todo-review-sync.js';
import { buildDelegationQualityCycles } from '../lib/delegation-cycle-outcomes.js';
import { resolveEffectiveCodeReviewReportVerdict } from '../lib/delegation-code-review-phase.js';
import { isIncompleteDelegationReport } from '../lib/delegation-verdict.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';

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
    executor: { transport: 'testfake', model: 'gpt-5' },
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
    executor: { transport: 'testfake', model: 'testfakeb-chat' },
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

test('fan-out PASS + zero-tool terminal sibling without a verdict passes', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const pass = reviewRow({ startedAt: t(3) });
  const noTools = reviewRow({
    startedAt: t(4),
    status: 'failed',
    report: '',
    reportVerdict: '',
    metrics: { tool_calls_n: 0 },
  });
  const code = subjectSnapshot([impl, pass, noTools]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
});

test('fan-out PASS + cancel_unconfirmed sibling passes when verify is satisfied', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const pass = reviewRow({ startedAt: t(3) });
  const dead = reviewRow({
    startedAt: t(4),
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
    error: 'Stop was requested but could not be confirmed before the deadline.',
    report: '',
    reportVerdict: '',
  });
  const code = subjectSnapshot([impl, pass, dead]);
  assert.equal(code.state, 'passed');
});

test('fan-out PASS + infra sibling passes when the replacement review is usable', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const pass = reviewRow({ startedAt: t(3) });
  const infra = reviewRow({ startedAt: t(4), status: 'failed', error: 'adapter_incomplete', report: '' });
  const code = subjectSnapshot([impl, pass, infra]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
});

test('infra failed without report (Transport not started) does not poison a usable PASS sibling', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const infra = reviewRow({
    startedAt: t(2),
    status: 'failed',
    error: 'Transport not started',
    report: '',
    reportVerdict: '',
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: null,
  });
  const pass = reviewRow({
    startedAt: t(3),
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: { status: 'passed', attemptId: 'att-pass', recordedAt: t(4) },
  });
  const code = subjectSnapshot([impl, infra, pass]);
  assert.equal(code.state, 'passed');
  assert.notEqual(code.stateReason, 'verify_missing');
  assert.equal(code.reviewers.find((row) => row.verdict === 'PASS')?.usable, true);
});

test('queue-expired attempt is infra/non-deciding: two PASS + expired attempt is passed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const expired = reviewRow({
    startedAt: t(2),
    status: 'failed',
    error: 'Storage request expired in queue',
    report: '',
    reportVerdict: '',
    executor: { transport: 'codex', model: 'expired-reviewer' },
  });
  const passA = reviewRow({ startedAt: t(3), executor: { transport: 'codex', model: 'reviewer-a' } });
  const passB = reviewRow({ startedAt: t(3, 30), executor: { transport: 'claude', model: 'reviewer-b' } });
  const code = subjectSnapshot([impl, expired, passA, passB]);
  assert.equal(code.state, 'passed');
  assert.notEqual(code.stateReason, 'no_verdict');
  assert.equal(isReviewRoundInfraAttempt(expired), true);
});

test('ordinary reviewer error without the queue-expiry message stays deciding', () => {
  const ordinary = reviewRow({ status: 'failed', error: 'reviewer crashed on bad input', report: '', reportVerdict: '' });
  assert.equal(isReviewRoundInfraAttempt(ordinary), false);
});

test('dead sdk review sibling does not poison independence when a deciding PASS exists', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const deadSdk = reviewRow({
    startedAt: t(2),
    status: 'failed',
    error: 'Transport not started',
    report: '',
    reportVerdict: '',
    executor: { transport: 'sdk', model: 'composer-2.5-fast' },
  });
  const pass = reviewRow({
    startedAt: t(3),
    executor: { transport: 'testfake', model: 'testfakeb-chat' },
  });
  const code = subjectSnapshot([impl, deadSdk, pass]);
  assert.equal(code.state, 'passed');
  assert.equal(code.independence.independent, true);
  assert.equal(code.independence.class, 'different_base_model');
  assert.equal(code.reviewerCount, 2);
});

test('infra attempt with persisted FAIL blocks a usable PASS sibling', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const infraFail = reviewRow({
    startedAt: t(2),
    status: 'failed',
    error: 'Transport not started',
    report: '',
    reportVerdict: 'FAIL',
    executor: { transport: 'codex', model: 'other-reviewer' },
  });
  const pass = reviewRow({ startedAt: t(3) });
  const code = subjectSnapshot([impl, infraFail, pass]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'review_failed');
});

test('infra attempt with conflicting persisted verdict prevents a usable PASS', () => {
  const infra = reviewRow({ startedAt: t(2), status: 'failed', error: 'Transport not started', report: '', reportVerdict: 'conflict', executor: { transport: 'codex', model: 'other-reviewer' }, });
  const pass = reviewRow({ startedAt: t(3) });
  const code = subjectSnapshot([infra, pass]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'no_verdict');
});

test('no-verdict attempt followed by a PASS of the same reviewer is superseded: passed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const dead = reviewRow({ startedAt: t(2), finishedAt: t(2), status: 'failed', error: 'Transport not started', report: '', reportVerdict: '' });
  const retry = reviewRow({ startedAt: t(3), finishedAt: t(3) });
  const other = reviewRow({ startedAt: t(3), finishedAt: t(4), executor: { transport: 'codex', model: 'other-reviewer' } });
  const code = subjectSnapshot([impl, dead, retry, other]);
  assert.equal(code.state, 'passed');
  const lone = subjectSnapshot([impl, dead, retry]);
  assert.equal(lone.state, 'passed');
});

test('a no-verdict attempt with no later replacement stays unknown', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const unspecified = reviewRow({ startedAt: t(2), reportVerdict: 'unspecified', report: 'no verdict line' });
  const code = subjectSnapshot([impl, unspecified]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'no_verdict');
});

test('failed review with an empty report and no error evidence is not infra: PASS sibling stays unknown', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const unclassified = reviewRow({ startedAt: t(2), status: 'failed', report: '', reportVerdict: '', executor: { transport: 'codex', model: 'other-reviewer' }, });
  const pass = reviewRow({ startedAt: t(3) });
  const code = subjectSnapshot([impl, unclassified, pass]);
  assert.equal(code.state, 'unknown');
  assert.notEqual(code.state, 'passed');
});

test('failed review with an empty report keeps a persisted FAIL / BLOCKED verdict', () => {
  for (const verdict of ['FAIL', 'BLOCKED']) {
    const impl = materialRow({ queuedAt: t(1) });
    const row = reviewRow({ startedAt: t(2), status: 'failed', report: '', reportVerdict: verdict, executor: { transport: 'codex', model: 'other-reviewer' }, });
    const pass = reviewRow({ startedAt: t(3) });
    const code = subjectSnapshot([impl, row, pass]);
    assert.equal(code.state, 'failed', verdict);
  }
});

test('failed review with an empty report and a conflict verdict stays unknown', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const row = reviewRow({ startedAt: t(2), status: 'failed', report: '', reportVerdict: 'conflict' });
  const code = subjectSnapshot([impl, row]);
  assert.equal(code.state, 'unknown');
});

test('infra-only reviews without a replacement PASS stay unknown', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = reviewRow({ startedAt: t(2), status: 'failed', error: 'Transport not started', report: '', reportVerdict: '' });
  const b = reviewRow({ startedAt: t(3), status: 'interrupted', error: 'adapter_incomplete', report: '', reportVerdict: '' });
  const code = subjectSnapshot([impl, a, b]);
  assert.equal(code.state, 'unknown');
});

test('failed host verify is preserved next to a Transport not started sibling', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const infra = reviewRow({ startedAt: t(2), status: 'failed', error: 'Transport not started', report: '', reportVerdict: '' });
  const pass = reviewRow({
    startedAt: t(3),
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: { status: 'failed', attemptId: 'att-v', recordedAt: t(4) },
  });
  const code = subjectSnapshot([impl, infra, pass]);
  assert.equal(code.state, 'failed');
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
    transport: 'testfake',
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
    model: 'testfakeb-chat',
    transport: 'testfake',
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
    model: 'testfakeb-chat',
    transport: 'testfake',
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
      model: 'testfakeb-chat',
      transport: 'testfake',
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

test('the runtime wrapper reads the logical workspace regardless of parent chat', async () => {
  const leaf = 'dddddddd-4444-4444-8444-444444444444';
  const impl = createDelegationRecord({
    parentChatId: 'wrapper-parent-impl',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'gpt-5' },
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
    executor: { transport: 'testfake', model: 'testfakeb-chat' },
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
  const snapshot = await computeTodoReviewSnapshotForTodo({
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

/**
 * Finish→record→badge: a closure review's FAIL is reconciled at finish, persisted
 * as reportVerdict, and only then read by the todo snapshot.
 *
 * @param {string} report
 * @returns {object}
 */
function closureReviewRecordedAtFinish(report) {
  const raw = reviewRow({ startedAt: t(3), reviewMode: 'closure', report, reportVerdict: 'FAIL' });
  const reportVerdict = resolveEffectiveCodeReviewReportVerdict(raw, 'FAIL');
  return { ...raw, reportVerdict };
}

test('closure: a non-P1 FOLLOW_UP FAIL recorded at finish gives a passed todo badge', () => {
  const impl = materialRow({ queuedAt: t(1), startedAt: t(1), finishedAt: t(2) });
  const review = closureReviewRecordedAtFinish([
    'F1 FIXED with test evidence',
    'VERDICT: FAIL',
    '[FOLLOW_UP]',
    'F9 (P2): style nit',
  ].join('\n'));
  const code = subjectSnapshot([impl, review]);
  assert.equal(review.reportVerdict, 'PASS');
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
});

test('closure: a STILL_OPEN P1 recorded at finish keeps the todo badge failed', () => {
  const impl = materialRow({ queuedAt: t(1), startedAt: t(1), finishedAt: t(2) });
  const review = closureReviewRecordedAtFinish([
    'F1 STILL_OPEN (P1): regression in the finish path',
    'VERDICT: FAIL',
    '[FOLLOW_UP]',
    'F9 (P2): style nit',
  ].join('\n'));
  const code = subjectSnapshot([impl, review]);
  assert.equal(review.reportVerdict, 'FAIL');
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'review_failed');
});

/**
 * @param {string} id
 * @param {string} startedAt
 * @param {'PASS'|'FAIL'} verdict
 * @returns {object}
 */
function planReviewRow(id, startedAt, verdict, extra = {}) {
  return reviewRow({
    ...extra,
    id,
    startedAt,
    reviewSubject: 'plan',
    pickRole: 'plan',
    reportVerdict: verdict,
    report: `TASK: review\nVERDICT: ${verdict}`,
  });
}

test('plan revision: a PASS after the latest plan edit supersedes older plan FAILs', () => {
  const rows = [planReviewRow('p-fail', t(3), 'FAIL', { executor: { transport: 'codex', model: 'other-reviewer' } }), planReviewRow('p-pass', t(12), 'PASS')];
  assert.equal(subjectSnapshot(rows, 'plan').state, 'failed');
  const plan = subjectSnapshot(rows, 'plan', { planBoundaryAt: t(10) });
  assert.equal(plan.state, 'passed');
  assert.deepEqual(plan.reviewers.map((row) => row.delegationId), ['p-pass']);
  assert.equal(plan.round.openedAt, t(10));
  assert.equal(plan.round.invalidationAt, t(10));
});

test('plan revision: a plan edit after the last review makes the plan review stale', () => {
  const rows = [planReviewRow('p-pass', t(3), 'PASS')];
  const plan = subjectSnapshot(rows, 'plan', { planBoundaryAt: t(10) });
  assert.equal(plan.state, 'stale');
  assert.equal(plan.stateReason, 'plan_edited_after_review');
  assert.equal(plan.material.current, false);
});

test('plan revision: a FAIL in the current plan round stays decisive', () => {
  const rows = [planReviewRow('p-pass', t(11), 'PASS'), planReviewRow('p-fail', t(12), 'FAIL')];
  assert.equal(subjectSnapshot(rows, 'plan', { planBoundaryAt: t(10) }).state, 'failed');
});

test('plan revision does not affect the code subject', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const codePass = reviewRow({ id: 'rev-code', startedAt: t(2), reviewSubject: 'code' });
  const code = subjectSnapshot([impl, codePass], 'code', { planBoundaryAt: t(40) });
  assert.equal(code.state, 'passed');
});

test('plan revision: no boundary keeps the legacy single-round behaviour', () => {
  const rows = [planReviewRow('p-fail', t(3), 'FAIL', { executor: { transport: 'codex', model: 'other-reviewer' } }), planReviewRow('p-pass', t(12), 'PASS')];
  assert.equal(subjectSnapshot(rows, 'plan', { planBoundaryAt: '' }).state, 'failed');
});

test('a PASS from another reviewer in the same round does not supersede a prior FAIL', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const failed = reviewRow({
    id: 'reviewer-a-fail',
    startedAt: t(3),
    finishedAt: t(4),
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
    executor: { transport: 'codex', model: 'gpt-6-luna' },
  });
  const passed = reviewRow({
    id: 'reviewer-b-pass',
    startedAt: t(5),
    finishedAt: t(6),
    verifyRequired: true,
    verifyResult: { status: 'passed', attemptId: 'verify-b', recordedAt: t(6) },
    executor: { transport: 'claude', model: 'opus' },
  });
  const code = subjectSnapshot([impl, failed, passed]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'review_failed');
  assert.deepEqual(code.reviewers.map((row) => row.delegationId), ['reviewer-a-fail', 'reviewer-b-pass']);
});

test('a sequential PASS by the same canonical reviewer supersedes its prior FAIL', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const failed = reviewRow({
    id: 'reviewer-a-fail',
    startedAt: t(3),
    finishedAt: t(4),
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
    executor: { transport: 'codex', model: 'gpt-6-luna::effort=low' },
  });
  const passed = reviewRow({
    id: 'reviewer-a-pass',
    startedAt: t(5),
    finishedAt: t(6),
    verifyRequired: true,
    verifyResult: { status: 'passed', attemptId: 'verify-a', recordedAt: t(6) },
    executor: { transport: 'codex', model: 'gpt-6-luna::effort=high' },
  });
  const code = subjectSnapshot([impl, failed, passed]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
  const laterFail = reviewRow({
    startedAt: t(7),
    finishedAt: t(8),
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
    executor: { transport: 'codex', model: 'gpt-6-luna' },
  });
  assert.equal(subjectSnapshot([impl, failed, passed, laterFail]).state, 'failed');
});

test('a new round after a fix excludes the prior round FAIL', () => {
  const impl = materialRow({ queuedAt: t(1), startedAt: t(1), finishedAt: t(2) });
  const failed = reviewRow({
    id: 'old-round-fail',
    startedAt: t(3),
    finishedAt: t(4),
    reportVerdict: 'FAIL',
    report: 'VERDICT: FAIL',
    executor: { transport: 'codex', model: 'gpt-6-luna' },
  });
  const fix = materialRow({
    id: 'fix-material',
    assignment: 'implement',
    pickRole: 'fix',
    queuedAt: t(5),
    startedAt: t(5),
    finishedAt: t(6),
  });
  const passed = reviewRow({
    id: 'new-round-pass',
    startedAt: t(7),
    finishedAt: t(8),
    verifyRequired: true,
    verifyResult: { status: 'passed', attemptId: 'verify-new-round', recordedAt: t(8) },
    executor: { transport: 'claude', model: 'opus' },
  });
  const code = subjectSnapshot([impl, failed, fix, passed]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
  assert.deepEqual(code.reviewers.map((row) => row.delegationId), ['new-round-pass']);
});


test('runtime wrapper applies a legacy plan timestamp when rows are supplied for backfill', async () => {
  const snapshot = await computeTodoReviewSnapshotForTodo({
    todo: { id: LEAF, plan: { markdown: 'v2', updatedAt: t(10) } },
    rows: [planReviewRow('legacy-fail', t(3), 'FAIL'), planReviewRow('legacy-pass', t(12), 'PASS')],
    now: NOW,
  });
  assert.equal(snapshot.plan.state, 'passed');
});

test('a passed verify with only pre-existing failures keeps the round passed and says so', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({
    startedAt: t(3),
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: {
      status: 'passed',
      attemptId: 'attempt',
      recordedAt: t(4),
      preexistingFailures: ['model-pick-rotation', 'notices'],
      newFailures: [],
    },
  });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'verify_preexisting_failures');
  assert.equal(code.reviewers[0].verifyStatus, 'passed');
  assert.equal(code.reviewers[0].verifyPreexisting, 2);
});

test('a failed verify with new failures still fails even when pre-existing ones are listed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = reviewRow({
    startedAt: t(3),
    verifyRequired: true,
    reviewCanRunTests: false,
    verifyResult: { status: 'failed', attemptId: 'attempt', recordedAt: t(4), newFailures: ['x'], preexistingFailures: ['y'] },
  });
  const code = subjectSnapshot([impl, review]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'verify_failed');
  assert.equal(code.reviewers[0].verifyPreexisting, undefined);
});

// ---- F16/F17: a fixed-pair code review never passes without two members ----

const fixedPairReview = (id, transport, model, membership, startedAt, extra = {}) => reviewRow({
  id,
  startedAt,
  executor: { transport, model },
  reviewerPolicy: { selection: 'fixed_pair', membership },
  pickOrigin: 'auto',
  ...extra,
});

test('fixed pair: one member PASS stays pending and is not auto-close eligible (F16)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const review = fixedPairReview('pair-one', 'claude', 'claude-opus-5-5::effort=medium', 'member', t(3));
  const rows = [impl, review];
  const code = subjectSnapshot(rows);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
  assert.notEqual(code.state, 'passed');
  const close = evaluateTodoLeafAutoClose({
    todo: { id: LEAF, status: 'doing' },
    items: [],
    rows,
    isLiveWorktree: () => false,
  });
  assert.equal(close.eligible, false);
  assert.equal(close.reason, 'review_pending');
});

test('fixed pair: two distinct member PASSes resolve as passed', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('pair-a', 'claude', 'claude-opus-5-5', 'member', t(3));
  const b = fixedPairReview('pair-b', 'codex', 'rev-b', 'member', t(4));
  const code = subjectSnapshot([impl, a, b]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
});

test('fixed pair: two PASSes from one reviewer identity (DEGRADED) stay pending', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('deg-a', 'claude', 'claude-opus-5-5::effort=low', 'member', t(3));
  const b = fixedPairReview('deg-b', 'claude', 'opus::effort=high', 'member', t(4));
  const code = subjectSnapshot([impl, a, b]);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
});

test('fixed pair: an outside-pool PASS never supplies the second member (F17)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('out-a', 'claude', 'rev-a', 'member', t(3));
  const outsider = fixedPairReview('out-c', 'testfakeb', 'rev-outside', 'outside_pool', t(4));
  const pendingCode = subjectSnapshot([impl, a, outsider]);
  assert.equal(pendingCode.state, 'pending');
  assert.equal(pendingCode.stateReason, 'pair_reviewer_pending');
  const b = fixedPairReview('out-b', 'codex', 'rev-b', 'member', t(5));
  const passedCode = subjectSnapshot([impl, a, outsider, b]);
  assert.equal(passedCode.state, 'passed');
});

test('fixed pair: effort-suffixed members pass, an outside-pool Opus never replaces the missing member', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const luna = fixedPairReview('eff-luna', 'codex', 'gpt-6-luna::effort=low', 'member', t(3));
  const opusOutside = fixedPairReview('eff-opus', 'claude', 'claude-opus-4-6::effort=low', 'outside_pool', t(3));
  // Two PASSes, but only one covers a pair slot: the other pair member never reviewed.
  const pending = subjectSnapshot([impl, luna, opusOutside]);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.stateReason, 'pair_reviewer_pending');
  // Two PASSes from the two pair members (model ids carry `::effort=...`) pass the round.
  const luna56 = fixedPairReview('eff-luna56', 'codex', 'gpt-5.6-luna::effort=low', 'member', t(4));
  const passed = subjectSnapshot([impl, luna, opusOutside, luna56]);
  assert.equal(passed.state, 'passed');
  assert.equal(passed.stateReason, 'fresh_review');
  const opusMember = fixedPairReview('eff-opus-m', 'claude', 'claude-opus-4-6::effort=low', 'member', t(4));
  assert.equal(subjectSnapshot([impl, luna, opusMember]).state, 'passed');
});

test('fixed pair: after an unstartable member is evicted, a learning PASS completes the round', () => {
  // A learned member that left the enabled favorites is evicted on read, so the
  // next reviewer joins with `membership: learning` (eligible). An outside-pool
  // PASS still never supplies the second member.
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('ev-a', 'claude', 'opus::effort=medium', 'member', t(3));
  const outsider = fixedPairReview('ev-out', 'codex', 'gpt-6-luna', 'outside_pool', t(4));
  assert.equal(subjectSnapshot([impl, a, outsider]).stateReason, 'pair_reviewer_pending');
  const learning = fixedPairReview('ev-c', 'codex', 'gpt-6-luna', 'learning', t(5), { pickOrigin: 'manual' });
  assert.equal(subjectSnapshot([impl, a, learning]).state, 'passed');
});

test('fixed pair: a reviewer with no resolvable identity never supplies the second PASS', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('blank-a', 'claude', 'rev-a', 'member', t(3));
  const blank = reviewRow({
    id: 'blank-b',
    startedAt: t(4),
    executor: {},
    reviewerPolicy: { selection: 'fixed_pair', membership: 'member' },
  });
  const code = subjectSnapshot([impl, a, blank]);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
});

// ---- FU-1: eligibility must be reconstructed from the persisted snapshot ----

test('fixed pair: a PASS with no reviewerPolicy snapshot never supplies the second member (FU-1)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const member = fixedPairReview('nosnap-a', 'claude', 'rev-a', 'member', t(3));
  // Legacy PASS: the attempt predates the policy snapshot (or the start path
  // never wrote one), so its eligibility cannot be reconstructed.
  const legacy = reviewRow({ id: 'nosnap-legacy', startedAt: t(4) });
  const pending = subjectSnapshot([impl, member, legacy]);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.stateReason, 'pair_reviewer_pending');
  const second = fixedPairReview('nosnap-b', 'codex', 'rev-b', 'member', t(5));
  const passed = subjectSnapshot([impl, member, legacy, second]);
  assert.equal(passed.state, 'passed');
  assert.equal(passed.stateReason, 'fresh_review');
});

test('fixed pair: a pickOrigin=unknown member never counts toward the pair (FU-1)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const unknownOrigin = fixedPairReview('orig-a', 'claude', 'rev-a', 'member', t(3), { pickOrigin: 'unknown' });
  const known = fixedPairReview('orig-b', 'codex', 'rev-b', 'member', t(4), { pickOrigin: 'auto' });
  const pending = subjectSnapshot([impl, unknownOrigin, known]);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.stateReason, 'pair_reviewer_pending');
  const third = fixedPairReview('orig-c', 'testfakeb', 'rev-c', 'member', t(5), { pickOrigin: 'manual' });
  const passed = subjectSnapshot([impl, unknownOrigin, known, third]);
  assert.equal(passed.state, 'passed');
  assert.equal(passed.stateReason, 'fresh_review');
});

test('fixed pair: known pickOrigin members still count toward the pair', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('known-a', 'claude', 'claude-opus-5-5', 'member', t(3), { pickOrigin: 'auto' });
  const b = fixedPairReview('known-b', 'codex', 'rev-b', 'member', t(4), { pickOrigin: 'manual' });
  const code = subjectSnapshot([impl, a, b]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
});

test('fixed pair: a live fixed_pair code policy holds an all-legacy round pending (FU-1)', async () => {
  saveDelegationSettings(WORKSPACE, {
    reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'learned', session: 'fresh' } },
  }, { dataDir: ISOLATED_DATA_DIR });
  try {
    const impl = materialRow({ queuedAt: t(1) });
    // Every attempt is legacy: no reviewerPolicy snapshot to derive the pair from.
    const legacyPass = reviewRow({ id: 'live-legacy-pass', startedAt: t(3) });
    const snapshot = await computeTodoReviewSnapshotForTodo({
      todo: { id: LEAF, workspaceFolder: WORKSPACE },
      rows: [impl, legacyPass],
      now: NOW,
      dataDir: ISOLATED_DATA_DIR,
    });
    assert.equal(snapshot.code.state, 'pending');
    assert.equal(snapshot.code.stateReason, 'pair_reviewer_pending');
  } finally {
    saveDelegationSettings(WORKSPACE, { reviewer_policy: null }, { dataDir: ISOLATED_DATA_DIR });
  }
});

test('fixed pair: non-pair reviews remain unaffected (FU-1)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const autoSnapshot = reviewRow({
    id: 'nonpair-auto',
    startedAt: t(3),
    reviewerPolicy: { selection: 'auto', membership: 'member' },
  });
  const code = subjectSnapshot([impl, autoSnapshot], 'code', { codeReviewerPolicy: { selection: 'auto' } });
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
  // The pair gate is code-only: a single plan PASS still resolves the plan
  // subject even when the attempt carries a fixed_pair snapshot.
  const planPass = reviewRow({
    id: 'nonpair-plan',
    startedAt: t(4),
    reviewSubject: 'plan',
    pickRole: 'plan',
    reviewerPolicy: { selection: 'fixed_pair', membership: 'member' },
  });
  const plan = subjectSnapshot([planPass], 'plan');
  assert.equal(plan.state, 'passed');
});

test('fixed pair: an unknown-origin member blocks auto-close (FU-1)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('close-a', 'claude', 'rev-a', 'member', t(3), { pickOrigin: 'auto' });
  const unknown = fixedPairReview('close-b', 'codex', 'rev-b', 'member', t(4), { pickOrigin: 'unknown' });
  const rows = [impl, a, unknown];
  const code = subjectSnapshot(rows);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
  const close = evaluateTodoLeafAutoClose({
    todo: { id: LEAF, status: 'doing' },
    items: [],
    rows,
    isLiveWorktree: () => false,
  });
  assert.equal(close.eligible, false);
  assert.equal(close.reason, 'review_pending');
});

test('fixed pair: an empty or unrecognized pickOrigin is never eligible (FU-1)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const empty = fixedPairReview('eo-a', 'claude', 'rev-a', 'member', t(3), { pickOrigin: '' });
  const odd = fixedPairReview('eo-b', 'codex', 'rev-b', 'member', t(4), { pickOrigin: 'weird' });
  const code = subjectSnapshot([impl, empty, odd]);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
});

test('fixed pair: an attempt whose snapshot selection is not fixed_pair never counts (FU-1)', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a = fixedPairReview('sel-a', 'claude', 'rev-a', 'member', t(3), { pickOrigin: 'auto' });
  const b = fixedPairReview('sel-b', 'codex', 'rev-b', 'member', t(4), {
    pickOrigin: 'auto',
    reviewerPolicy: { selection: 'auto', membership: 'member' },
  });
  const code = subjectSnapshot([impl, a, b], 'code', { codeReviewerPolicy: { selection: 'fixed_pair' } });
  assert.equal(code.state, 'pending');
});

const PROVIDER_503 = 'API error occurred: Status 503 {"type":"unreachable_backend","raw_status_code":503}';

test('provider 503 failed reviewer does not block a usable PASS sibling', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const failed503 = reviewRow({
    startedAt: t(2),
    status: 'failed',
    error: PROVIDER_503,
    report: 'worked through several tool calls before the provider died',
    reportVerdict: '',
  });
  const pass = reviewRow({ startedAt: t(3) });
  const code = subjectSnapshot([impl, failed503, pass]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
});

test('provider 503 failed reviewer alone leaves the round unknown', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const failed503 = reviewRow({ startedAt: t(2), status: 'failed', error: PROVIDER_503, report: '', reportVerdict: '' });
  const code = subjectSnapshot([impl, failed503]);
  assert.equal(code.state, 'unknown');
});

// ---- Audited adapter_no_verdict fallback replaces one failed pair slot ----

const noVerdictMember = (id, transport, model, startedAt, extra = {}) => fixedPairReview(id, transport, model, 'member', startedAt, {
  attemptId: `${id}-att`,
  status: 'failed',
  error: 'adapter_no_verdict: review produced no VERDICT line',
  reportVerdict: '',
  report: 'Reviewed the change. No defects found.',
  ...extra,
});

const fallbackReview = (id, from, startedAt, extra = {}) => fixedPairReview(id, 'mistral', 'mistral-large-4-0', 'outside_pool', startedAt, {
  attemptId: `${id}-att`,
  pickOriginDetail: 'fallback',
  pickFallbackFrom: from,
  pickFallbackFromAttemptId: `${from}-att`,
  pickFallbackAttemptId: `${id}-att`,
  ...extra,
});

test('fallback pair: member PASS + audited replacement PASS passes the round without touching membership', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const ok = fixedPairReview('fb-ok', 'claude', 'rev-a', 'member', t(3));
  const broken = noVerdictMember('fb-broken', 'codex', 'rev-b', t(3, 30));
  const repl = fallbackReview('fb-repl', 'fb-broken', t(5));
  const code = subjectSnapshot([impl, ok, broken, repl]);
  assert.equal(code.state, 'passed');
  assert.equal(code.stateReason, 'fresh_review');
  // Without the replacement the round stays pending on the pair.
  assert.equal(subjectSnapshot([impl, ok, broken]).stateReason, 'pair_reviewer_pending');
});

test('fallback pair: negative cases never supply the second member', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const ok = fixedPairReview('fn-ok', 'claude', 'rev-a', 'member', t(3));
  const broken = noVerdictMember('fn-broken', 'codex', 'rev-b', t(3, 30));
  const pending = (rows) => {
    const code = subjectSnapshot(rows);
    assert.notEqual(code.state, 'passed');
    return code;
  };
  // Plain outsider (no fallback link) and a manual unrelated pick.
  pending([impl, ok, broken, fixedPairReview('fn-out', 'mistral', 'mistral-large-4-0', 'outside_pool', t(5))]);
  pending([impl, ok, broken, fallbackReview('fn-manual', 'fn-broken', t(5), { pickOrigin: 'manual', pickOriginDetail: 'ui' })]);
  // Fallback pointing at an unknown / foreign delegation.
  pending([impl, ok, broken, fallbackReview('fn-foreign', 'elsewhere', t(5))]);
  // Predecessor reported a real FAIL, BLOCKED or carried a verdict: not a gap.
  pending([impl, ok, noVerdictMember('fn-fail', 'codex', 'rev-b', t(3, 30), { reportVerdict: 'FAIL' }), fallbackReview('fn-r1', 'fn-fail', t(5))]);
  pending([impl, ok, noVerdictMember('fn-blk', 'codex', 'rev-b', t(3, 30), { reportVerdict: 'BLOCKED' }), fallbackReview('fn-r2', 'fn-blk', t(5))]);
  pending([impl, ok, noVerdictMember('fn-pass', 'codex', 'rev-b', t(3, 30), { report: 'VERDICT: PASS' }), fallbackReview('fn-r3', 'fn-pass', t(5))]);
  // Predecessor failed for another reason (timeout-free generic error).
  pending([impl, ok, noVerdictMember('fn-other', 'codex', 'rev-b', t(3, 30), { error: 'boom' }), fallbackReview('fn-r4', 'fn-other', t(5))]);
  // Predecessor was an outsider, not a pair slot.
  pending([impl, ok, noVerdictMember('fn-outpred', 'codex', 'rev-b', t(3, 30), { reviewerPolicy: { selection: 'fixed_pair', membership: 'outside_pool' } }), fallbackReview('fn-r5', 'fn-outpred', t(5))]);
  // Replacement with an empty report body still needs a PASS verdict.
  pending([impl, ok, broken, fallbackReview('fn-empty', 'fn-broken', t(5), { reportVerdict: '', report: '' })]);
  // Same executor as the failed attempt is no replacement.
  pending([impl, ok, broken, { ...fallbackReview('fn-same', 'fn-broken', t(5)), executor: { transport: 'codex', model: 'rev-b' } }]);
  // Second fallback of the same predecessor / chained fallback.
  pending([impl, ok, broken, fallbackReview('fn-twice-1', 'fn-broken', t(5), { status: 'failed', reportVerdict: '', error: 'adapter_no_verdict' }), fallbackReview('fn-twice-2', 'fn-broken', t(6))]);
  const chainedPred = noVerdictMember('fn-chain-1', 'mistral', 'mistral-large-4-0', t(5), { pickOriginDetail: 'fallback', pickFallbackFrom: 'fn-broken', reviewerPolicy: { selection: 'fixed_pair', membership: 'member' } });
  pending([impl, ok, broken, chainedPred, fallbackReview('fn-chain-2', 'fn-chain-1', t(6), { executor: { transport: 'qwen', model: 'qwen-x' } })]);
  // Different leaf or subject of the replacement.
  pending([impl, ok, broken, fallbackReview('fn-leaf', 'fn-broken', t(5), { leafId: 'other-leaf' })]);
  pending([impl, ok, broken, fallbackReview('fn-subj', 'fn-broken', t(5), { reviewSubject: 'plan' })]);
});

test('fallback pair: stale material - a replacement started before a newer implement is not a PASS for the new round', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const ok = fixedPairReview('fs-ok', 'claude', 'rev-a', 'member', t(3));
  const broken = noVerdictMember('fs-broken', 'codex', 'rev-b', t(3, 30));
  const repl = fallbackReview('fs-repl', 'fs-broken', t(5));
  const fix = materialRow({ queuedAt: t(7), startedAt: t(7), finishedAt: t(8), pickRole: 'fix' });
  const code = subjectSnapshot([impl, ok, broken, repl, fix]);
  assert.notEqual(code.state, 'passed');
});

// ---- Attempt-bound fallback proof and slot-based pair aggregation ----

test('fallback proof F1: a retried replacement attempt cannot reuse the first attempt proof', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const ok = fixedPairReview('f1-ok', 'claude', 'rev-a', 'member', t(3));
  const broken = noVerdictMember('f1-broken', 'codex', 'rev-b', t(3, 30));
  const first = fallbackReview('f1-repl', 'f1-broken', t(5));
  assert.equal(subjectSnapshot([impl, ok, broken, first]).state, 'passed');
  // Retry: the archived first attempt carries the proof; the live attempt has a new attemptId.
  const retried = {
    ...first,
    attemptId: 'f1-repl-att2',
    attempts: [snapshotDelegationAttempt({
      ...first,
      status: 'failed',
      error: 'adapter_no_verdict: review produced no VERDICT line',
      reportVerdict: '',
      report: '',
    })],
  };
  const code = subjectSnapshot([impl, ok, broken, retried]);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
  // Control: the same retry with a proof bound to its own current attemptId passes,
  // so the stale ownProof is the only isolated difference.
  const rebound = { ...retried, pickFallbackAttemptId: 'f1-repl-att2' };
  assert.equal(subjectSnapshot([impl, ok, broken, rebound]).state, 'passed');
  // A stale claim-less replacement (legacy row without attempt ids) is not accepted either.
  const legacy = { ...first, pickFallbackFromAttemptId: '', pickFallbackAttemptId: '' };
  assert.notEqual(subjectSnapshot([impl, ok, broken, legacy]).state, 'passed');
});

test('fallback proof F1: proof survives a snapshot roundtrip and binds the predecessor attempt', () => {
  const first = fallbackReview('f1s-repl', 'f1s-broken', t(5));
  const snap = snapshotDelegationAttempt(first);
  assert.equal(snap.pickFallbackFromAttemptId, 'f1s-broken-att');
  assert.equal(snap.pickFallbackAttemptId, 'f1s-repl-att');
  const roundtrip = snapshotDelegationAttempt(JSON.parse(JSON.stringify({ ...first, ...snap, executor: first.executor })));
  assert.equal(roundtrip.pickFallbackFromAttemptId, snap.pickFallbackFromAttemptId);
  assert.equal(roundtrip.pickFallbackAttemptId, snap.pickFallbackAttemptId);
});

test('fallback proof F1: an archived predecessor attempt does not veto the current no_verdict attempt', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const ok = fixedPairReview('f1v-ok', 'claude', 'rev-a', 'member', t(3));
  const archived = snapshotDelegationAttempt(noVerdictMember('f1v-broken', 'codex', 'rev-b', t(3), {
    attemptId: 'f1v-broken-old',
    error: PROVIDER_503,
    report: '',
  }));
  const broken = { ...noVerdictMember('f1v-broken', 'codex', 'rev-b', t(3, 30)), attempts: [archived] };
  const repl = fallbackReview('f1v-repl', 'f1v-broken', t(5));
  assert.equal(subjectSnapshot([impl, ok, broken, repl]).state, 'passed');
  // A proof pointing at the archived (non-failed) attempt does not justify the fallback.
  const wrong = fallbackReview('f1v-wrong', 'f1v-broken', t(5), { pickFallbackFromAttemptId: 'f1v-broken-old' });
  assert.notEqual(subjectSnapshot([impl, ok, broken, wrong]).state, 'passed');
});

test('fallback proof F2: replaced slot A plus a later A PASS never covers slot B', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const brokenA = noVerdictMember('f2-a-broken', 'claude', 'rev-a', t(3));
  const replC = fallbackReview('f2-c', 'f2-a-broken', t(5));
  const laterA = fixedPairReview('f2-a-later', 'claude', 'rev-a', 'member', t(6));
  const code = subjectSnapshot([impl, brokenA, replC, laterA]);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
  // With B present the same round passes (slots A via C, B via B).
  const b = fixedPairReview('f2-b', 'codex', 'rev-b', 'member', t(4));
  assert.equal(subjectSnapshot([impl, brokenA, replC, b]).state, 'passed');
});

test('fallback proof F2: two failed delegations of the same slot with two outsiders count one slot', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const a1 = noVerdictMember('f2m-a1', 'claude', 'rev-a', t(3));
  const a2 = noVerdictMember('f2m-a2', 'claude', 'rev-a', t(3, 30));
  const c = fallbackReview('f2m-c', 'f2m-a1', t(5));
  const d = fallbackReview('f2m-d', 'f2m-a2', t(6), { executor: { transport: 'qwen', model: 'qwen-x' } });
  const code = subjectSnapshot([impl, a1, a2, c, d]);
  assert.equal(code.state, 'pending');
  assert.equal(code.stateReason, 'pair_reviewer_pending');
});

test('pairPolicy explains whether the round snapshot or the live policy imposes the pair', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const pair = fixedPairReview('pp-one', 'claude', 'claude-opus-5-5', 'member', t(3));
  // Round attempts carry fixed_pair, but the live policy has since moved to auto.
  const dropped = subjectSnapshot([impl, pair], 'code', { codeReviewerPolicy: { selection: 'auto' } });
  assert.equal(dropped.stateReason, 'pair_reviewer_pending');
  assert.deepEqual(dropped.pairPolicy, { source: 'round_snapshot', liveSelection: 'auto' });
  // A legacy attempt without a snapshot is held only by the live fixed_pair policy.
  const legacy = reviewRow({ startedAt: t(3), finishedAt: t(3) });
  const added = subjectSnapshot([impl, legacy], 'code', { codeReviewerPolicy: { selection: 'fixed_pair' } });
  assert.deepEqual(added.pairPolicy, { source: 'live_policy', liveSelection: 'fixed_pair' });
  // No pair requirement: the field is absent.
  assert.equal(subjectSnapshot([impl, legacy]).pairPolicy, undefined);
});

test('51a9504a: a passed verify on the implement attempt satisfies the reviewer verifyRequired', () => {
  const impl = materialRow({
    queuedAt: t(1),
    verifyResult: { status: 'passed', materialRevision: 'rev-1', stale: false },
  });
  const review = reviewRow({ startedAt: t(3), verifyRequired: true, reviewCanRunTests: false });
  const code = subjectSnapshot([impl, review], 'code', { materialRevision: 'rev-1' });
  assert.equal(code.state, 'passed');
  // A verify recorded for a different material revision does not count.
  const stale = materialRow({
    queuedAt: t(1),
    verifyResult: { status: 'passed', materialRevision: 'rev-0', stale: false },
  });
  const other = subjectSnapshot([stale, review], 'code', { materialRevision: 'rev-1' });
  assert.equal(other.state, 'unknown');
  assert.equal(other.stateReason, 'verify_missing');

  const missingVerifyRevision = materialRow({
    queuedAt: t(1),
    verifyResult: { status: 'passed', stale: false },
  });
  const missingSnapshotRevision = materialRow({
    queuedAt: t(1),
    verifyResult: { status: 'passed', materialRevision: 'rev-1', stale: false },
  });
  assert.equal(
    subjectSnapshot([missingVerifyRevision, review], 'code', { materialRevision: 'rev-1' }).stateReason,
    'verify_missing',
  );
  assert.equal(subjectSnapshot([missingSnapshotRevision, review]).stateReason, 'verify_missing');
});

test('5fc43626: a later independent PASS with verify passed supersedes an earlier required-missing reviewer', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const missing = reviewRow({
    startedAt: t(3), finishedAt: t(4), verifyRequired: true,
    executor: { transport: 'testfake', model: 'model-a' },
  });
  const good = reviewRow({
    startedAt: t(5), finishedAt: t(6), verifyRequired: true,
    verifyResult: { status: 'passed' },
    executor: { transport: 'testfake', model: 'model-b' },
  });
  const code = subjectSnapshot([impl, missing, good]);
  assert.equal(code.state, 'passed');
});

test('2620699a: sandbox BLOCKED without findings is non-deciding next to a verified PASS', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const blocked = reviewRow({
    startedAt: t(3), finishedAt: t(4), reportVerdict: 'BLOCKED',
    report: 'VERDICT: BLOCKED\nThe sandbox does not allow running the tests.',
    executor: { transport: 'testfake', model: 'model-a' },
  });
  const pass = reviewRow({
    startedAt: t(5), finishedAt: t(6), verifyRequired: true,
    verifyResult: { status: 'passed' },
    executor: { transport: 'testfake', model: 'model-b' },
  });
  assert.equal(subjectSnapshot([impl, blocked, pass]).state, 'passed');
  // Alone it is unknown (infra reason), never failed.
  const alone = subjectSnapshot([impl, blocked]);
  assert.equal(alone.state, 'unknown');
  assert.equal(alone.stateReason, 'review_blocked_infra');
});

test('sandbox BLOCKED with findings remains blocking next to a verified PASS', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const blocked = reviewRow({
    startedAt: t(3), finishedAt: t(4), reportVerdict: 'BLOCKED',
    report: [
      'The sandbox does not allow running the tests.',
      '```findings-json',
      JSON.stringify({
        findings: [{
          id: 'F1',
          status: 'NEW',
          priority: 'P1',
          category: 'contract-violation',
          files: ['lib/example.js'],
          summary: 'Production behavior is incorrect.',
        }],
      }),
      '```',
      'TASK: review',
      'VERDICT: BLOCKED',
    ].join('\n'),
    executor: { transport: 'testfake', model: 'model-a' },
  });
  const pass = reviewRow({
    startedAt: t(5), finishedAt: t(6), verifyRequired: true,
    verifyResult: { status: 'passed' },
    executor: { transport: 'testfake', model: 'model-b' },
  });
  const code = subjectSnapshot([impl, blocked, pass]);
  assert.equal(code.state, 'failed');
  assert.equal(code.stateReason, 'review_blocked');
});

test('environment BLOCKED is not excused by an implementer self-review PASS', () => {
  const impl = materialRow({ queuedAt: t(1) });
  const blocked = reviewRow({
    startedAt: t(3), finishedAt: t(4), reportVerdict: 'BLOCKED',
    report: 'VERDICT: BLOCKED\nThe sandbox does not allow running the tests.',
    executor: { transport: 'testfake', model: 'model-a' },
  });
  const selfReview = reviewRow({
    startedAt: t(5), finishedAt: t(6), verifyRequired: true,
    verifyResult: { status: 'passed' },
    executor: { transport: impl.executor.transport, model: impl.executor.model },
  });
  const code = subjectSnapshot([impl, blocked, selfReview]);
  assert.equal(code.state, 'unknown');
  assert.equal(code.stateReason, 'review_blocked_infra');
});
