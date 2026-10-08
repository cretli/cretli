/**
 * Stage 4 (5af7d7aa): cycle classification, explicit roles, manual acceptance
 * and cost per accepted. Pure unit tests over injected rows/usage events — no
 * store, no runtime.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDelegationQualityCycles, summarizeDelegationCycleCostMetrics } from '../lib/delegation-cycle-outcomes.js';
import { delegationCycleRole } from '../lib/delegation-cycle-classify.js';

const PARENT = 'cycle-parent';

let seq = 0;
function row(overrides = {}) {
  seq += 1;
  const created = overrides.createdAt || `2026-10-01T10:${String(seq).padStart(2, '0')}:00.000Z`;
  return {
    id: overrides.id || `job-${seq}`,
    parentChatId: PARENT,
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    createdAt: created,
    startedAt: overrides.startedAt || created,
    finishedAt: overrides.finishedAt || created,
    report: '',
    ...overrides,
  };
}

function review(overrides = {}) {
  return row({ assignment: 'review', executionMode: 'agent', ...overrides });
}

test('review FAIL that finds a defect stays quality, not reviewer infra', () => {
  const implement = row({ id: 'impl-fail', createdAt: '2026-10-01T09:00:00.000Z' });
  const failing = review({
    id: 'rev-fail',
    createdAt: '2026-10-01T09:05:00.000Z',
    report: 'TASK: review\nVERDICT: FAIL',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, failing], parentChatId: PARENT });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].runClass, 'quality', 'a substantive FAIL is not reviewer infra');
  assert.equal(cycles[0].technicalSuccess, true, 'the implementer technical run still succeeded');
  assert.equal(cycles[0].qualityOutcome, 'rejected-by-review');
  assert.equal(cycles[0].taskOutcome, 'unspecified');
  assert.deepEqual(cycles[0].reviewVerdicts, ['FAIL']);
});

test('quota, timeout and user-cancel get their own runClass', () => {
  const quota = row({
    id: 'impl-quota',
    createdAt: '2026-10-01T08:00:00.000Z',
    error: 'insufficient balance for this account',
  });
  const timeout = row({
    id: 'impl-timeout',
    createdAt: '2026-10-01T08:10:00.000Z',
    error: 'adapter timed out after grace period',
  });
  const cancelled = row({
    id: 'impl-cancel',
    createdAt: '2026-10-01T08:20:00.000Z',
    status: 'cancelled',
    report: 'stopped by user',
  });
  const cycles = buildDelegationQualityCycles({
    rows: [quota, timeout, cancelled],
    parentChatId: PARENT,
  });
  const byId = Object.fromEntries(cycles.map((cycle) => [cycle.implementId, cycle]));
  assert.equal(byId['impl-quota'].runClass, 'infra');
  assert.equal(byId['impl-quota'].technicalSuccess, false);
  assert.equal(byId['impl-timeout'].runClass, 'infra');
  assert.equal(byId['impl-timeout'].technicalSuccess, false);
  assert.equal(byId['impl-cancel'].runClass, 'cancel');
  assert.equal(byId['impl-cancel'].technicalSuccess, false);
});

test('reviewer infra timeout does not become a quality FAIL', () => {
  const implement = row({ id: 'impl-infra-review', createdAt: '2026-10-01T07:00:00.000Z' });
  const brokenReview = review({
    id: 'rev-timeout',
    createdAt: '2026-10-01T07:05:00.000Z',
    error: 'adapter_incomplete',
    report: '',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, brokenReview], parentChatId: PARENT });
  assert.equal(cycles[0].runClass, 'infra');
  assert.equal(cycles[0].acceptedByReview, false);
  assert.deepEqual(cycles[0].reviewVerdicts, [], 'an infra review contributes no usable verdict');
});

test('a terminal review without a usable verdict leaves the cycle undecided', () => {
  const implement = row({ id: 'impl-undecided', createdAt: '2026-10-01T06:30:00.000Z' });
  const vague = review({
    id: 'rev-vague',
    createdAt: '2026-10-01T06:35:00.000Z',
    report: 'I looked at the diff and it seems fine.',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, vague], parentChatId: PARENT });
  assert.equal(cycles[0].unreviewed, false);
  assert.equal(cycles[0].acceptedByReview, false);
  assert.equal(cycles[0].qualityOutcome, 'undecided');
  assert.equal(cycles[0].decided, false);
  assert.equal(summarizeDelegationCycleCostMetrics(cycles).undecidedCount, 1);
});

test('mixed sibling verdicts block accepted-by-review', () => {
  const implement = row({ id: 'impl-mixed', createdAt: '2026-10-01T06:00:00.000Z' });
  const pass = review({ id: 'rev-pass', report: 'VERDICT: PASS', createdAt: '2026-10-01T06:05:00.000Z' });
  const fail = review({ id: 'rev-fail', report: 'VERDICT: FAIL', createdAt: '2026-10-01T06:06:00.000Z' });
  const cycles = buildDelegationQualityCycles({ rows: [implement, pass, fail], parentChatId: PARENT });
  assert.equal(cycles[0].acceptedByReview, false);
  assert.equal(cycles[0].qualityOutcome, 'rejected-by-review');
  assert.equal(cycles[0].decided, true);
});

test('verify failure blocks accepted-by-review even with a PASS verdict', () => {
  const implement = row({ id: 'impl-verify', createdAt: '2026-10-01T05:00:00.000Z' });
  const ok = review({
    id: 'rev-verify',
    report: 'VERDICT: PASS',
    verifyResult: { status: 'failed' },
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, ok], parentChatId: PARENT });
  assert.equal(cycles[0].acceptedByReview, false);
  assert.equal(cycles[0].verifyPassed, false);
});

test('explicit fix role opens a cycle while legacy implement stays implement', () => {
  const realFix = row({
    id: 'impl-fix',
    assignment: 'implement',
    pickRole: 'fix',
    createdAt: '2026-10-01T04:00:00.000Z',
  });
  const pass = review({ id: 'rev-fix', report: 'VERDICT: PASS', createdAt: '2026-10-01T04:05:00.000Z' });
  const cycles = buildDelegationQualityCycles({ rows: [realFix, pass], parentChatId: PARENT });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].implementRole, 'fix', 'the explicit fix role is preserved');
  assert.equal(cycles[0].acceptedByReview, true);

  const legacy = row({ id: 'impl-legacy', assignment: 'implement', createdAt: '2026-10-01T03:00:00.000Z' });
  assert.equal(delegationCycleRole(legacy), 'implement', 'legacy implement/fix is not guessed as fix');
  assert.equal(delegationCycleRole(realFix), 'fix');
});

test('plan review does not open an implement cycle', () => {
  const planReview = review({
    id: 'plan-rev',
    executionMode: 'plan',
    pickRole: 'plan',
    createdAt: '2026-10-01T02:00:00.000Z',
  });
  const cycles = buildDelegationQualityCycles({ rows: [planReview], parentChatId: PARENT });
  assert.equal(cycles.length, 0);
});

test('manualAccepted comes from an explicit human acknowledgement', () => {
  const implement = row({
    id: 'impl-ack',
    createdAt: '2026-10-01T01:00:00.000Z',
    acknowledgedAt: '2026-10-01T01:30:00.000Z',
    acknowledgedReason: 'accepted',
  });
  const pass = review({ id: 'rev-ack', report: 'VERDICT: PASS', createdAt: '2026-10-01T01:05:00.000Z' });
  const cycles = buildDelegationQualityCycles({ rows: [implement, pass], parentChatId: PARENT });
  assert.equal(cycles[0].manualAccepted, true);
  assert.equal(cycles[0].manualAcceptedAt, '2026-10-01T01:30:00.000Z');
  assert.deepEqual(cycles[0].manualAcceptedJobIds, ['impl-ack']);
  assert.equal(cycles[0].acceptedByReview, true, 'manual acceptance is a separate signal');

  const withoutAck = buildDelegationQualityCycles({
    rows: [row({ id: 'impl-no-ack', createdAt: '2026-10-01T00:00:00.000Z' })],
    parentChatId: PARENT,
  });
  assert.equal(withoutAck[0].manualAccepted, false);
});

test('parallel reviews contribute wall time once, not summed', () => {
  const implement = row({
    id: 'impl-wall',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:10:00.000Z',
  });
  const slow = review({
    id: 'rev-slow',
    createdAt: '2026-10-01T10:05:00.000Z',
    startedAt: '2026-10-01T10:05:00.000Z',
    finishedAt: '2026-10-01T10:20:00.000Z',
    report: 'VERDICT: PASS',
  });
  const fast = review({
    id: 'rev-fast',
    createdAt: '2026-10-01T10:06:00.000Z',
    startedAt: '2026-10-01T10:06:00.000Z',
    finishedAt: '2026-10-01T10:08:00.000Z',
    report: 'VERDICT: PASS',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, slow, fast], parentChatId: PARENT });
  // Union of 10:00-10:10, 10:05-10:20 and 10:06-10:08: one 20 min span.
  assert.equal(cycles[0].wallTimeMs, 20 * 60 * 1000, 'overlapping siblings are counted once (union), never summed');
});

test('zero accepted cycles yield null effective cost', () => {
  const implement = row({ id: 'impl-zero', createdAt: '2026-10-01T00:00:00.000Z' });
  const cycles = buildDelegationQualityCycles({ rows: [implement], parentChatId: PARENT });
  const metrics = summarizeDelegationCycleCostMetrics(cycles);
  assert.equal(metrics.acceptedCount, 0);
  assert.equal(metrics.effectiveCostPerAcceptedUsd, null);
  assert.equal(metrics.totalCostUsd, null);
  assert.equal(metrics.unreviewedCount, 1);
});

test('unknown and subscription usage are not counted as USD 0', () => {
  const implement = row({ id: 'impl-usage', createdAt: '2026-10-01T00:00:00.000Z' });
  const pass = review({ id: 'rev-usage', report: 'VERDICT: PASS', createdAt: '2026-10-01T00:01:00.000Z' });
  const cycles = buildDelegationQualityCycles({ rows: [implement, pass], parentChatId: PARENT });
  const metrics = summarizeDelegationCycleCostMetrics(cycles, {
    readUsageEvents: () => [
      { eventType: 'delta', delegationId: implement.id, usd: 2, billingClass: 'priced' },
      { eventType: 'delta', delegationId: implement.id, billingClass: 'unknown' },
      { eventType: 'delta', delegationId: implement.id, billingClass: 'subscription_quota' },
      { eventType: 'run', delegationId: implement.id, usd: 99 },
    ],
  });
  assert.equal(metrics.totalCostUsd, 2);
  assert.equal(metrics.partialCostUsd, 2);
  assert.equal(metrics.unknownUsageEventCount, 1);
  assert.equal(metrics.subscriptionUsageEventCount, 1);
  assert.equal(metrics.denominators.totalEvents, 3);
  assert.equal(metrics.denominators.pricedEvents, 1);
  assert.equal(metrics.pricedEventShare, 0.3333);
  assert.equal(metrics.pricedCycleCount, 1);
  assert.equal(metrics.pricedCycleShare, 1);
  assert.equal(metrics.effectiveCostPerAcceptedUsd, 2);
});

test('running cycles stay out of the closed denominator but keep accrued usage', () => {
  const implement = row({
    id: 'impl-open',
    status: 'running',
    createdAt: '2026-10-01T00:00:00.000Z',
    finishedAt: '',
  });
  const cycles = buildDelegationQualityCycles({
    rows: [implement],
    parentChatId: PARENT,
    includeOpen: true,
  });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].closed, false);
  const metrics = summarizeDelegationCycleCostMetrics(cycles, {
    readUsageEvents: () => [
      { eventType: 'delta', delegationId: implement.id, usd: 1.5, billingClass: 'priced' },
    ],
  });
  assert.equal(metrics.closedCycleCount, 0);
  assert.equal(metrics.openCycleCount, 1);
  assert.equal(metrics.openCyclePartialCostUsd, 1.5);
  assert.equal(metrics.totalCostUsd, null);
  assert.equal(metrics.effectiveCostPerAcceptedUsd, null);
});

test('manualAccepted is counted separately from accepted-by-review', () => {
  const implement = row({
    id: 'impl-manual',
    createdAt: '2026-10-01T00:00:00.000Z',
    acknowledgedAt: '2026-10-01T00:10:00.000Z',
    acknowledgedReason: 'accepted',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement], parentChatId: PARENT });
  const metrics = summarizeDelegationCycleCostMetrics(cycles);
  assert.equal(metrics.manualAcceptedCount, 1);
  assert.equal(metrics.acceptedCount, 0);
  assert.equal(metrics.denominators.manualAccepted, 1);
});

test('wall time of a sequential implement then review adds up instead of taking the max', () => {
  const implement = row({
    id: 'impl-seq',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:10:00.000Z',
  });
  const pass = review({
    id: 'rev-seq',
    createdAt: '2026-10-01T10:10:00.000Z',
    startedAt: '2026-10-01T10:10:00.000Z',
    finishedAt: '2026-10-01T10:15:00.000Z',
    report: 'VERDICT: PASS',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, pass], parentChatId: PARENT });
  assert.equal(cycles[0].wallTimeMs, 15 * 60 * 1000);
});

test('parallel reviews fully inside the implement window do not add wall time', () => {
  const implement = row({
    id: 'impl-par',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:10:00.000Z',
  });
  const a = review({ id: 'rev-par-a', startedAt: '2026-10-01T10:02:00.000Z', finishedAt: '2026-10-01T10:04:00.000Z', createdAt: '2026-10-01T10:02:00.000Z', report: 'VERDICT: PASS' });
  const b = review({ id: 'rev-par-b', startedAt: '2026-10-01T10:03:00.000Z', finishedAt: '2026-10-01T10:05:00.000Z', createdAt: '2026-10-01T10:03:00.000Z', report: 'VERDICT: PASS' });
  const cycles = buildDelegationQualityCycles({ rows: [implement, a, b], parentChatId: PARENT });
  assert.equal(cycles[0].wallTimeMs, 10 * 60 * 1000);
});

test('cancelled implement + PASS review is not accepted-by-review and stays a cancel', () => {
  const implement = row({ id: 'impl-cx', status: 'cancelled', createdAt: '2026-10-02T09:00:00.000Z' });
  const pass = review({ id: 'rev-cx', report: 'VERDICT: PASS', createdAt: '2026-10-02T09:05:00.000Z' });
  const [cycle] = buildDelegationQualityCycles({ rows: [implement, pass], parentChatId: PARENT });
  assert.equal(cycle.acceptedByReview, false);
  assert.equal(cycle.technicalSuccess, false);
  assert.equal(cycle.runClass, 'cancel');
  assert.notEqual(cycle.qualityOutcome, 'accepted-by-review');
});

test('a PASS review with a conflicting or unspecified sibling is not accepted', () => {
  for (const [name, siblingReport, siblingStatus] of [
    ['conflict', 'VERDICT: PASS\nVERDICT: FAIL', 'completed'],
    ['unspecified', 'Looks fine, no verdict line.', 'completed'],
    ['infra', '', 'failed'],
  ]) {
    const implement = row({ id: `impl-${name}`, createdAt: '2026-10-02T10:00:00.000Z' });
    const pass = review({ id: `rev-pass-${name}`, report: 'VERDICT: PASS', createdAt: '2026-10-02T10:05:00.000Z' });
    const sibling = review({ id: `rev-sib-${name}`, report: siblingReport, status: siblingStatus, createdAt: '2026-10-02T10:06:00.000Z' });
    const [cycle] = buildDelegationQualityCycles({ rows: [implement, pass, sibling], parentChatId: PARENT });
    assert.equal(cycle.acceptedByReview, false, `${name} sibling must block acceptance`);
  }
});

test('requireVerify policy: no verify blocks acceptance; passed verify accepts; failed verify always blocks', () => {
  const implement = row({ id: 'impl-v', createdAt: '2026-10-02T11:00:00.000Z' });
  const bare = review({ id: 'rev-v-bare', report: 'VERDICT: PASS', createdAt: '2026-10-02T11:05:00.000Z' });
  const verified = review({ id: 'rev-v-ok', report: 'VERDICT: PASS', createdAt: '2026-10-02T11:05:00.000Z', verifyResult: { status: 'passed' } });
  const failedVerify = review({ id: 'rev-v-bad', report: 'VERDICT: PASS', createdAt: '2026-10-02T11:05:00.000Z', verifyResult: { status: 'failed' } });
  const accepted = (reviewRow, requireVerify) => buildDelegationQualityCycles({
    rows: [implement, reviewRow], parentChatId: PARENT, requireVerify,
  })[0].acceptedByReview;
  assert.equal(accepted(bare, false), true);
  assert.equal(accepted(bare, true), false, 'policy requires verify, none present');
  assert.equal(accepted(verified, true), true);
  assert.equal(accepted(failedVerify, false), false, 'a verify that ran and failed blocks regardless of policy');
});

test('a tests=no review with no host verify cannot close the leaf', () => {
  const implement = row({ id: 'impl-vreq', createdAt: '2026-10-02T12:00:00.000Z' });
  const required = review({
    id: 'rev-vreq-bare',
    report: 'VERDICT: PASS',
    createdAt: '2026-10-02T12:05:00.000Z',
    verifyRequired: true,
  });
  const [blocked] = buildDelegationQualityCycles({ rows: [implement, required], parentChatId: PARENT });
  assert.equal(blocked.acceptedByReview, false, 'a required verify with no result blocks acceptance');
  assert.equal(blocked.verifyPassed, false);

  const implement2 = row({ id: 'impl-vreq2', createdAt: '2026-10-02T12:10:00.000Z' });
  const verified = review({
    id: 'rev-vreq-ok',
    report: 'VERDICT: PASS',
    createdAt: '2026-10-02T12:15:00.000Z',
    verifyRequired: true,
    verifyResult: { status: 'passed' },
  });
  const [accepted] = buildDelegationQualityCycles({ rows: [implement2, verified], parentChatId: PARENT });
  assert.equal(accepted.acceptedByReview, true, 'a required verify that passed accepts');
  assert.equal(accepted.verifyPassed, true);

  const implement3 = row({ id: 'impl-vreq3', createdAt: '2026-10-02T12:20:00.000Z' });
  const failed = review({
    id: 'rev-vreq-bad',
    report: 'VERDICT: PASS',
    createdAt: '2026-10-02T12:25:00.000Z',
    verifyRequired: true,
    verifyResult: { status: 'failed' },
  });
  const [rejected] = buildDelegationQualityCycles({ rows: [implement3, failed], parentChatId: PARENT });
  assert.equal(rejected.acceptedByReview, false, 'a required verify that failed still blocks');
});

test('reviewCanRunTests:false implies verify required even without the explicit flag', () => {
  const implement = row({ id: 'impl-vtrait', createdAt: '2026-10-02T13:00:00.000Z' });
  const cannot = review({
    id: 'rev-vtrait-no',
    report: 'VERDICT: PASS',
    createdAt: '2026-10-02T13:05:00.000Z',
    reviewCanRunTests: false,
  });
  const [blocked] = buildDelegationQualityCycles({ rows: [implement, cannot], parentChatId: PARENT });
  assert.equal(blocked.acceptedByReview, false);

  const implement2 = row({ id: 'impl-vtrait2', createdAt: '2026-10-02T13:10:00.000Z' });
  const can = review({
    id: 'rev-vtrait-yes',
    report: 'VERDICT: PASS',
    createdAt: '2026-10-02T13:15:00.000Z',
    reviewCanRunTests: true,
  });
  const [accepted] = buildDelegationQualityCycles({ rows: [implement2, can], parentChatId: PARENT });
  assert.equal(accepted.acceptedByReview, true, 'a self-running reviewer needs no separate verify');
});

test('manualAccepted needs an explicit accept, not any ack (reviewed/open_child/failed)', () => {
  for (const [reason, status] of [['reviewed', 'completed'], ['open_child', 'completed'], ['accepted', 'failed']]) {
    const implement = row({
      id: `impl-ack-${reason}-${status}`,
      status,
      createdAt: '2026-10-03T00:00:00.000Z',
      acknowledgedAt: '2026-10-03T00:10:00.000Z',
      acknowledgedReason: reason,
    });
    const [cycle] = buildDelegationQualityCycles({ rows: [implement], parentChatId: PARENT });
    assert.equal(cycle.manualAccepted, false, `${reason}/${status} must not be a manual acceptance`);
  }
});

test('user cancel is not infra, and an "aborted" error on a cancelled job stays a cancel', () => {
  const implement = row({ id: 'impl-ab', status: 'cancelled', error: 'Run aborted by user', createdAt: '2026-10-03T01:00:00.000Z' });
  const [cycle] = buildDelegationQualityCycles({ rows: [implement], parentChatId: PARENT });
  assert.equal(cycle.runClass, 'cancel');
  const infraRow = row({ id: 'impl-ab2', status: 'failed', error: 'Run aborted: server restarted', createdAt: '2026-10-03T02:00:00.000Z' });
  const [infraCycle] = buildDelegationQualityCycles({ rows: [infraRow], parentChatId: PARENT });
  assert.equal(infraCycle.runClass, 'infra');
});

test('mixed cohorts without parentChatId filter: reviews attach only within the same leaf', () => {
  const implA = row({
    id: 'impl-cohort-a',
    leafId: 'leaf-a',
    createdAt: '2026-10-05T10:00:00.000Z',
  });
  const revA = review({
    id: 'rev-cohort-a',
    leafId: 'leaf-a',
    createdAt: '2026-10-05T10:05:00.000Z',
    report: 'VERDICT: PASS',
  });
  const implB = row({
    id: 'impl-cohort-b',
    leafId: 'leaf-b',
    createdAt: '2026-10-05T10:10:00.000Z',
  });
  const revB = review({
    id: 'rev-cohort-b',
    leafId: 'leaf-b',
    createdAt: '2026-10-05T10:15:00.000Z',
    report: 'VERDICT: PASS',
  });
  const cycles = buildDelegationQualityCycles({
    rows: [implA, revB, revA, implB],
  });
  const cycleA = cycles.find((cycle) => cycle.implementId === 'impl-cohort-a');
  const cycleB = cycles.find((cycle) => cycle.implementId === 'impl-cohort-b');
  assert.ok(cycleA, 'leaf-a cycle exists');
  assert.ok(cycleB, 'leaf-b cycle exists');
  assert.equal(cycleA.acceptedByReview, true, 'leaf-a PASS review accepts leaf-a');
  assert.deepEqual(cycleA.jobIds, ['impl-cohort-a', 'rev-cohort-a'], 'leaf-b review must not join leaf-a');
  assert.equal(cycleB.acceptedByReview, true, 'leaf-b has its own review');
  assert.equal(cycleB.unreviewed, false);
  assert.deepEqual(cycleB.jobIds, ['impl-cohort-b', 'rev-cohort-b'], 'leaf-a review must not close leaf-b');
  const metrics = summarizeDelegationCycleCostMetrics(cycles);
  assert.equal(metrics.acceptedCount, 2);
});

test('idle gap between implement and review is excluded from wall time (union, not span)', () => {
  const implement = row({
    id: 'impl-gap',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:10:00.000Z',
  });
  const pass = review({
    id: 'rev-gap',
    createdAt: '2026-10-01T11:00:00.000Z',
    startedAt: '2026-10-01T11:00:00.000Z',
    finishedAt: '2026-10-01T11:05:00.000Z',
    report: 'VERDICT: PASS',
  });
  const cycles = buildDelegationQualityCycles({ rows: [implement, pass], parentChatId: PARENT });
  assert.equal(cycles[0].wallTimeMs, 15 * 60 * 1000, '10 min implement + 5 min review, one-hour gap excluded');
});

test('leafId filters cycles and cycles expose leaf, workflow id and task revision', () => {
  const a = row({ id: 'impl-leaf-a', leafId: 'leaf-a', planHash: 'hash-a', planRevision: 3, createdAt: '2026-10-04T00:00:00.000Z' });
  const b = row({ id: 'impl-leaf-b', leafId: 'leaf-b', sourceHash: 'src-b', createdAt: '2026-10-04T00:10:00.000Z' });
  const only = buildDelegationQualityCycles({ rows: [a, b], parentChatId: PARENT, leafId: 'leaf-a' });
  assert.equal(only.length, 1);
  assert.equal(only[0].leafId, 'leaf-a');
  assert.equal(only[0].workflowId, `${PARENT}:leaf-a`);
  assert.equal(only[0].workflowTaskRevision, 'hash-a');
  assert.equal(only[0].planRevision, 3);
});

test('usage cohort flags a cycle opened before the usage window as truncated', () => {
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  const old = row({ id: 'impl-old', createdAt: '2026-08-01T00:00:00.000Z' });
  const cycles = buildDelegationQualityCycles({ rows: [old], parentChatId: PARENT });
  const truncated = summarizeDelegationCycleCostMetrics(cycles, { now, readUsageEvents: () => [] });
  assert.equal(truncated.usageRangeTruncated, true);
  const fresh = row({ id: 'impl-fresh', createdAt: '2026-10-05T00:00:00.000Z' });
  const freshMetrics = summarizeDelegationCycleCostMetrics(
    buildDelegationQualityCycles({ rows: [fresh], parentChatId: PARENT }),
    { now, readUsageEvents: () => [] },
  );
  assert.equal(freshMetrics.usageRangeTruncated, false);
});
