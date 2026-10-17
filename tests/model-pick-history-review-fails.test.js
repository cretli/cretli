import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskComplexity } from '../lib/model-pick-complexity.js';
import { buildModelPickHistory, countLeafReviewFails } from '../lib/model-pick-history.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const CREATED_AT = '2026-10-14T11:00:00Z';

/**
 * Build a persisted delegation row fixture. `leafKey` picks which leaf field is
 * populated (`leafId` or `leaf_id`) so both shapes stay covered.
 *
 * @param {{
 *   assignment?: string,
 *   executionMode?: string,
 *   status?: string,
 *   report?: string,
 *   leaf?: string,
 *   leafKey?: 'leafId' | 'leaf_id',
 * }} [overrides]
 * @returns {object}
 */
function delegationRow(overrides = {}) {
  const {
    assignment = 'review',
    executionMode = 'agent',
    status = 'completed',
    report = 'Findings...\nVERDICT: FAIL',
    leaf = 'leaf-1',
    leafKey = 'leafId',
  } = overrides;
  return {
    id: `d-${Math.random().toString(16).slice(2)}`,
    controllerChatId: 'chat-1',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    assignment,
    executionMode,
    status,
    report,
    createdAt: CREATED_AT,
    [leafKey]: leaf,
  };
}

test('per-leaf review-FAIL counter counts two FAIL reviews for the leaf', () => {
  const rows = [
    delegationRow({ report: 'a\nVERDICT: FAIL' }),
    delegationRow({ report: 'b\nVERDICT: FAIL', leafKey: 'leaf_id' }),
  ];
  const history = buildModelPickHistory({
    role: 'implement',
    chatId: 'chat-1',
    leafId: 'leaf-1',
    delegations: rows,
    lockouts: [],
    planLimits: [],
    now: NOW,
  });
  assert.equal(history.reviewFailCount, 2);
  assert.equal(history.leafReviewFails, 2, 'leafReviewFails is the same value alias');
});

test('the wired history drives the review_fail_history complexity signal', () => {
  const history = buildModelPickHistory({
    role: 'implement',
    chatId: 'chat-1',
    leafId: 'leaf-1',
    delegations: [
      delegationRow({ report: 'a\nVERDICT: FAIL' }),
      delegationRow({ report: 'b\nVERDICT: FAIL' }),
    ],
    lockouts: [],
    planLimits: [],
    now: NOW,
  });
  const complexity = classifyTaskComplexity({
    role: 'implement',
    leafBody: 'x',
    leafSize: 'large',
    history,
  });
  assert.equal(complexity.level, 'demanding');
  assert.ok(complexity.signals.includes('review_fail_history'));
});

test('plan-mode review and another leaf do not count', () => {
  const rows = [
    delegationRow({ report: 'plan\nVERDICT: FAIL', executionMode: 'plan' }),
    delegationRow({ report: 'other\nVERDICT: FAIL', leaf: 'leaf-2' }),
    delegationRow({ report: 'pass\nVERDICT: PASS' }),
    delegationRow({ report: 'infra failure without verdict', status: 'failed' }),
    delegationRow({ assignment: 'implement', report: 'impl\nVERDICT: FAIL' }),
  ];
  const history = buildModelPickHistory({
    role: 'implement',
    chatId: 'chat-1',
    leafId: 'leaf-1',
    delegations: rows,
    lockouts: [],
    planLimits: [],
    now: NOW,
  });
  assert.equal(history.reviewFailCount, 0);
  assert.equal(history.leafReviewFails, 0);
});

test('reviewFailCount is 0 when no leafId is requested', () => {
  const rows = [
    delegationRow({ report: 'a\nVERDICT: FAIL' }),
    delegationRow({ report: 'b\nVERDICT: FAIL' }),
  ];
  const history = buildModelPickHistory({
    role: 'implement',
    chatId: 'chat-1',
    delegations: rows,
    lockouts: [],
    planLimits: [],
    now: NOW,
  });
  assert.equal(history.reviewFailCount, 0);
  assert.equal(history.leafReviewFails, 0);
});

test('one FAIL alone does not make the task demanding', () => {
  const history = buildModelPickHistory({
    role: 'implement',
    chatId: 'chat-1',
    leafId: 'leaf-1',
    delegations: [delegationRow({ report: 'a\nVERDICT: FAIL' })],
    lockouts: [],
    planLimits: [],
    now: NOW,
  });
  assert.equal(history.reviewFailCount, 1);
  const complexity = classifyTaskComplexity({
    role: 'implement',
    leafBody: 'x',
    leafSize: 'small',
    history,
  });
  assert.notEqual(complexity.level, 'demanding');
  assert.ok(!complexity.signals.includes('review_fail_history'));
});

test('countLeafReviewFails is pure and leaf-scoped', () => {
  const rows = [
    delegationRow({ report: 'a\nVERDICT: FAIL', leaf: ' Leaf-1 ' }),
    delegationRow({ report: 'b\nVERDICT: FAIL', leaf: 'leaf-1' }),
  ];
  // Trim + lower-case comparison matches both spellings.
  assert.equal(countLeafReviewFails(rows, 'LEAF-1'), 2);
  assert.equal(countLeafReviewFails(rows, 'leaf-2'), 0);
  assert.equal(countLeafReviewFails(rows, ''), 0);
  assert.equal(countLeafReviewFails(null, 'leaf-1'), 0);
});

function failCounts(reports) {
  const rows = reports.map((report) => delegationRow({ report }));
  const history = buildModelPickHistory({
    role: 'implement', chatId: 'chat-1', leafId: 'leaf-1',
    delegations: rows, lockouts: [], planLimits: [], now: NOW,
  });
  return { direct: countLeafReviewFails(rows, 'leaf-1'), viaHistory: history.reviewFailCount };
}

test('FAIL in prose without a VERDICT line is not counted', () => {
  const r = failCounts(['The review did not FAIL any check.']);
  assert.equal(r.direct, 0);
  assert.equal(r.viaHistory, 0);
});

test('a bare FAIL string without a VERDICT line is not counted', () => {
  const r = failCounts(['FAIL', 'status: FAIL']);
  assert.equal(r.direct, 0);
  assert.equal(r.viaHistory, 0);
});

test('compact "TASK: review VERDICT: FAIL" and a real VERDICT line are counted', () => {
  const r = failCounts(['TASK: review VERDICT: FAIL', 'notes\nVERDICT: FAIL']);
  assert.equal(r.direct, 2);
  assert.equal(r.viaHistory, 2);
});
