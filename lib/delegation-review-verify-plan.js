/**
 * Host-verify policy for a delegation start.
 *
 * A `review` child only produces a hard test signal if its harness can execute
 * the host-owned `node scripts/review-verify.js` runner itself. When the
 * effective `review_can_run_tests` trait is false — static prior or observed
 * from real review reports — the parent must call `delegation_verify`, and the
 * workflow cycle treats a missing verify as blocking. The flag is computed once
 * at start so the gate reads a durable field instead of re-deriving traits.
 */

import { resolveHarnessDelegationTraits } from './delegation-adapter-capabilities.js';
import { summarizeReviewTestObservations } from './model-pick-history.js';

/**
 * @param {{
 *   assignment?: unknown,
 *   executionMode?: unknown,
 *   transport?: unknown,
 *   rows?: object[],
 *   reviewTestObservations?: Record<string, { positive?: number, negative?: number }>,
 *   now?: number,
 * }} [input]
 * @returns {{
 *   applies: boolean,
 *   required: boolean,
 *   canRunTests: boolean | null,
 *   source: string,
 *   observedPositive: number,
 *   observedNegative: number,
 * }}
 */
export function resolveDelegationReviewVerifyPlan(input = {}) {
  const assignment = String(input.assignment || '').trim().toLowerCase();
  const executionMode = String(input.executionMode || '').trim().toLowerCase();
  const transport = String(input.transport || '').trim().toLowerCase();
  // A plan-mode `review` is a planner, not a reviewer; it has no test duty.
  const applies = assignment === 'review' && executionMode !== 'plan';
  if (!applies) {
    return {
      applies: false,
      required: false,
      canRunTests: null,
      source: 'not-review',
      observedPositive: 0,
      observedNegative: 0,
    };
  }
  const observations = input.reviewTestObservations
    || summarizeReviewTestObservations(Array.isArray(input.rows) ? input.rows : [], { now: input.now });
  const counts = (observations && observations[transport]) || { positive: 0, negative: 0 };
  const positive = Number(counts.positive) > 0 ? Math.floor(Number(counts.positive)) : 0;
  const negative = Number(counts.negative) > 0 ? Math.floor(Number(counts.negative)) : 0;
  const traits = resolveHarnessDelegationTraits(transport, { positive, negative });
  const canRunTests = traits.review_can_run_tests === true;
  return {
    applies: true,
    required: !canRunTests,
    canRunTests,
    source: traits.review_can_run_tests_source,
    observedPositive: positive,
    observedNegative: negative,
  };
}
