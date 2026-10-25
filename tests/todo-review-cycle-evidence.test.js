/**
 * Part C: per-cycle review evidence for worktree integration
 * (`lib/todo-review-cycle-evidence.js`, `docs/todo-review-contract.md` §8).
 *
 * The helper is pure: it scopes the workspace delegations to one cycle's
 * orchestrator chat + leaf and derives an honest artifact. Only a fresh,
 * independent PASS with satisfied verify is `verified: true`; everything else is
 * `unknown` (or `FAIL` for a decisive failure). The result is pinned to the
 * concrete reviewer/implementer attempt ids.
 */
import test from 'node:test';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { buildCycleReviewEvidence } from '../lib/todo-review-cycle-evidence.js';

const LEAF = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHAT = 'cycle-chat';

/**
 * @param {object} overrides
 * @returns {object}
 */
function implementRow(overrides = {}) {
  return {
    id: 'impl-job',
    parentChatId: CHAT,
    workspaceFolder: '/ws',
    leafId: LEAF,
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    attemptId: 'impl-attempt',
    queuedAt: '2026-01-01T00:01:00.000Z',
    startedAt: '2026-01-01T00:01:00.000Z',
    finishedAt: '2026-01-01T00:02:00.000Z',
    executor: { transport: 'testfake', model: 'gpt-5' },
    reportVerdict: '',
    report: '',
    ...overrides,
  };
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function reviewRow(overrides = {}) {
  return {
    id: 'review-job',
    parentChatId: CHAT,
    workspaceFolder: '/ws',
    leafId: LEAF,
    assignment: 'review',
    executionMode: 'agent',
    status: 'completed',
    attemptId: 'review-attempt',
    queuedAt: '2026-01-01T00:02:00.000Z',
    startedAt: '2026-01-01T00:02:00.000Z',
    finishedAt: '2026-01-01T00:03:00.000Z',
    executor: { transport: 'testfake', model: 'testfakeb-chat' },
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    reportVerdict: 'PASS',
    verifyRequired: false,
    verifyResult: null,
    report: 'VERDICT: PASS',
    ...overrides,
  };
}

test('a fresh independent PASS is the only verified artifact', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-1',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [implementRow(), reviewRow()],
  });
  assert.equal(evidence.outcome, 'PASS');
  assert.equal(evidence.verified, true);
  assert.equal(evidence.cycleId, 'cycle-1');
  assert.equal(evidence.delegationId, 'review-job');
  assert.equal(evidence.attemptId, 'review-attempt');
  assert.equal(evidence.implementerAttemptId, 'impl-attempt');
  assert.equal(evidence.independence, 'different_base_model');
  assert.equal(evidence.reviewerCount, 1);
  assert.equal(evidence.materialCurrent, true);
});

test('a cycle without a review job is unknown, never a hardcoded PASS', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-2',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [implementRow()],
  });
  assert.equal(evidence.outcome, 'unknown');
  assert.equal(evidence.verified, false);
  assert.equal(evidence.reportedOutcome, 'none');
  assert.equal(evidence.attemptId, '');
});

test('a PASS that is not independent is unknown, not verified', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-3',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [
      implementRow({ executor: { transport: 'testfake', model: 'testfakeb-chat' } }),
      reviewRow({ executor: { transport: 'testfake', model: 'testfakeb-chat' } }),
    ],
  });
  assert.equal(evidence.reportedOutcome, 'passed');
  assert.equal(evidence.outcome, 'unknown');
  assert.equal(evidence.verified, false);
  assert.equal(evidence.independence, 'same_model_same_harness');
});

test('a PASS without the required host verify is unknown', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-4',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [
      implementRow(),
      reviewRow({ verifyRequired: true, reviewCanRunTests: false, verifyResult: null }),
    ],
  });
  assert.equal(evidence.reportedOutcome, 'unknown');
  assert.equal(evidence.outcome, 'unknown');
  assert.equal(evidence.verified, false);
  assert.equal(evidence.stateReason, 'verify_missing');
});

test('a fix queued after the review makes the artifact unknown/stale', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-5',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [
      implementRow(),
      reviewRow(),
      implementRow({ id: 'fix-job', attemptId: 'fix-attempt', pickRole: 'fix', status: 'queued', queuedAt: '2026-01-01T00:04:00.000Z', startedAt: '', finishedAt: '' }),
    ],
  });
  assert.equal(evidence.reportedOutcome, 'stale');
  assert.equal(evidence.outcome, 'unknown');
  assert.equal(evidence.verified, false);
  assert.equal(evidence.materialCurrent, false);
});

test('a decisive FAIL is a FAIL artifact but is not verified', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-6',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [implementRow(), reviewRow({ reportVerdict: 'FAIL', report: 'VERDICT: FAIL' })],
  });
  assert.equal(evidence.outcome, 'FAIL');
  assert.equal(evidence.verified, false);
});

test('cycles from another orchestrator chat are ignored', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-7',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [implementRow({ parentChatId: 'other-chat' }), reviewRow({ parentChatId: 'other-chat' })],
  });
  assert.equal(evidence.outcome, 'unknown');
  assert.equal(evidence.verified, false);
  assert.equal(evidence.reviewerCount, 0);
});

test('a prefix leaf id is attributed to the full leaf', () => {
  const evidence = buildCycleReviewEvidence({
    cycleId: 'cycle-8',
    parentChatId: CHAT,
    leafId: LEAF,
    rows: [implementRow({ leafId: LEAF.slice(0, 12) }), reviewRow({ leafId: LEAF.slice(0, 12) })],
  });
  assert.equal(evidence.outcome, 'PASS');
  assert.equal(evidence.verified, true);
});

test('FU-1: a legacy single PASS under a live fixed_pair policy is not verified', () => {
  const rows = [implementRow(), reviewRow()];
  const base = { cycleId: 'c1', parentChatId: CHAT, leafId: LEAF, rows, now: Date.parse('2026-01-01T01:00:00.000Z') };
  const withPolicy = buildCycleReviewEvidence({ ...base, codeReviewerPolicy: { selection: 'fixed_pair' } });
  assert.equal(withPolicy.verified, false);
  assert.equal(withPolicy.outcome, 'unknown');
  const without = buildCycleReviewEvidence(base);
  assert.equal(without.verified, true);
});
