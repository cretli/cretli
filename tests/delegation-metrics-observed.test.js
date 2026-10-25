/**
 * Observed aggregation of per-run metrics (task "Metryki per delegacja",
 * subtask 5): `median_tokens_per_sec`, `median_tool_calls`, `median_files_changed`
 * feed the `observed` block from the delegation record's `metrics` field.
 *
 * `summarizeDelegationOutcomes` is pure (rows injected), so every fixture here
 * is an in-memory delegation record.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { buildModelPickHistory, summarizeDelegationOutcomes } from '../lib/model-pick-history.js';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const minutesAgo = (m) => new Date(now - (m * 60000)).toISOString();

/**
 * @param {object} overrides
 * @returns {object}
 */
function row(overrides) {
  return {
    status: 'completed',
    executionMode: 'agent',
    createdAt: minutesAgo(5),
    startedAt: minutesAgo(5),
    finishedAt: minutesAgo(4),
    executor: { transport: 'sdk', model: 'model-a' },
    ...overrides,
  };
}

// --- implement: three-metric medians over two runs ---------------------------
const implementOutcomes = summarizeDelegationOutcomes({
  now,
  rows: [
    row({
      assignment: 'implement',
      metrics: { tokens_out_per_sec: 10, tool_calls_n: 5, files_changed: 2 },
    }),
    row({
      assignment: 'implement',
      metrics: { tokens_out_per_sec: 20, tool_calls_n: 15, files_changed: 4 },
    }),
  ],
});
const impl = implementOutcomes.roles.implement['sdk/model-a'];
assert.equal(impl.n, 2);
assert.equal(impl.median_tokens_per_sec, 15, 'median of [10,20]');
assert.equal(impl.median_tool_calls, 10, 'median of [5,15]');
assert.equal(impl.median_files_changed, 3, 'median of [2,4]');

// --- odd sample size returns the middle value --------------------------------
const oddOutcomes = summarizeDelegationOutcomes({
  now,
  rows: [
    row({ assignment: 'implement', metrics: { tool_calls_n: 1 } }),
    row({ assignment: 'implement', metrics: { tool_calls_n: 4 } }),
    row({ assignment: 'implement', metrics: { tool_calls_n: 9 } }),
  ],
});
assert.equal(oddOutcomes.roles.implement['sdk/model-a'].median_tool_calls, 4, 'median of [1,4,9]');

// --- plan/review keep the speed signal but no execute-only medians -----------
const reviewOutcomes = summarizeDelegationOutcomes({
  now,
  rows: [row({
    assignment: 'review',
    report: 'TASK: review\nVERDICT: PASS\n',
    metrics: { tokens_out_per_sec: 8, tool_calls_n: 12, files_changed: 7 },
  })],
});
const reviewRow = reviewOutcomes.roles.review['sdk/model-a'];
assert.equal(reviewRow.median_tokens_per_sec, 8, 'review still reports response speed');
assert.equal(reviewRow.median_tool_calls, null, 'tool calls are execute-only');
assert.equal(reviewRow.median_files_changed, null, 'file churn is execute-only');

// --- no metrics on any run -> all medians null (not 0) -----------------------
const noMetrics = summarizeDelegationOutcomes({
  now,
  rows: [row({ assignment: 'implement' })],
});
const noMetricsRow = noMetrics.roles.implement['sdk/model-a'];
assert.equal(noMetricsRow.median_tokens_per_sec, null);
assert.equal(noMetricsRow.median_tool_calls, null);
assert.equal(noMetricsRow.median_files_changed, null);

// A corrupt/partial metrics object only contributes its valid numbers.
const partial = summarizeDelegationOutcomes({
  now,
  rows: [
    row({ assignment: 'implement', metrics: { tool_calls_n: 'bad', files_changed: -3 } }),
    row({ assignment: 'implement', metrics: { tool_calls_n: 6 } }),
  ],
});
assert.equal(partial.roles.implement['sdk/model-a'].median_tool_calls, 6,
  'invalid samples are dropped, so only the valid run counts');
assert.equal(partial.roles.implement['sdk/model-a'].median_files_changed, null,
  'a negative files_changed is not a signal');

// --- buildModelPickHistory threads the medians into `observed` ---------------
const history = buildModelPickHistory({
  role: 'implement',
  harnesses: ['sdk'],
  now,
  delegations: [
    row({ assignment: 'implement', metrics: { tokens_out_per_sec: 40, tool_calls_n: 2, files_changed: 1 } }),
  ],
});
assert.equal(history.observed['sdk/model-a'].median_tokens_per_sec, 40);
assert.equal(history.observed['sdk/model-a'].median_tool_calls, 2);
assert.equal(history.observed['sdk/model-a'].median_files_changed, 1);

console.log('delegation-metrics-observed.test.js OK');
