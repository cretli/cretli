/**
 * Host-verify policy computed at delegation start. The effective
 * `review_can_run_tests` trait (static prior + observed review reports) decides
 * whether a review child owes a parent `delegation_verify`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDelegationReviewVerifyPlan } from '../lib/delegation-review-verify-plan.js';

test('non-review and plan-mode review do not require host verify', () => {
  assert.equal(resolveDelegationReviewVerifyPlan({ assignment: 'implement', transport: 'deepseek' }).applies, false);
  const planReview = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'plan',
    transport: 'deepseek',
  });
  assert.equal(planReview.applies, false);
  assert.equal(planReview.required, false);
});

test('a harness whose prior cannot run tests owes a verify; one that can does not', () => {
  const deepseek = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'deepseek',
  });
  assert.equal(deepseek.applies, true);
  assert.equal(deepseek.canRunTests, false);
  assert.equal(deepseek.required, true);
  assert.equal(deepseek.source, 'prior');

  const claude = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'claude',
  });
  assert.equal(claude.required, false);
  assert.equal(claude.canRunTests, true);
});

test('observed reports flip the gate, not just the tie-break', () => {
  // deepseek prior says no, but two real reports show the runner worked.
  const observedYes = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'deepseek',
    reviewTestObservations: { deepseek: { positive: 2, negative: 0 } },
  });
  assert.equal(observedYes.canRunTests, true);
  assert.equal(observedYes.required, false);
  assert.equal(observedYes.source, 'observed');

  // claude prior says yes, but two reviews reported the runner blocked.
  const observedNo = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'claude',
    reviewTestObservations: { claude: { positive: 0, negative: 2 } },
  });
  assert.equal(observedNo.canRunTests, false);
  assert.equal(observedNo.required, true);
  assert.equal(observedNo.source, 'observed');
});

test('observations can be summarized from injected review rows', () => {
  const rows = [
    {
      assignment: 'review',
      executionMode: 'agent',
      status: 'completed',
      createdAt: new Date().toISOString(),
      executor: { transport: 'deepseek', model: 'm' },
      report: 'ran review-verify exit 0',
    },
    {
      assignment: 'review',
      executionMode: 'agent',
      status: 'completed',
      createdAt: new Date().toISOString(),
      executor: { transport: 'deepseek', model: 'm' },
      report: 'review-verify OK',
    },
  ];
  const plan = resolveDelegationReviewVerifyPlan({
    assignment: 'review',
    executionMode: 'agent',
    transport: 'deepseek',
    rows,
  });
  assert.equal(plan.observedPositive, 2);
  assert.equal(plan.canRunTests, true);
  assert.equal(plan.required, false);
});
