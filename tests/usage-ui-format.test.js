import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  escapeHtml,
  formatBucketLabel,
  formatChartValue,
  formatCompactNumber,
  formatInteger,
  formatPercent,
  sumDayWindow,
  sumTokens,
  unpricedReason,
} from '../app_front/features/usage/usageCharts.js';

test('formatCompactNumber abbreviates large token counts per language', () => {
  assert.equal(formatCompactNumber(1_600_000_000, 'pl'), '1,6 mld');
  assert.equal(formatCompactNumber(1_600_000_000, 'en'), '1.6B');
  assert.equal(formatCompactNumber(2_450_000, 'pl'), '2,5 mln');
  assert.equal(formatCompactNumber(2_450_000, 'en'), '2.5M');
  assert.equal(formatCompactNumber(125_000, 'en'), '125K');
  assert.equal(formatCompactNumber(1500, 'pl'), '1,5 tys.');
  assert.equal(formatCompactNumber(999, 'en'), '999');
  assert.equal(formatCompactNumber(0, 'en'), '0');
  assert.equal(formatCompactNumber(null, 'en'), '0');
});

test('formatInteger and formatPercent are locale aware', () => {
  assert.equal(formatInteger(1234, 'en'), '1,234');
  assert.equal(formatInteger(12345, 'pl').replace(/\u00A0/g, ' '), '12 345');
  assert.equal(formatInteger(Number.NaN, 'en'), '—');
  assert.equal(formatPercent(0.954, 'pl'), '95,4%');
  assert.equal(formatPercent(0.95, 'en'), '95%');
  assert.equal(formatPercent(null, 'en'), '—');
});

test('formatChartValue switches on the metric', () => {
  assert.equal(formatChartValue(0.42, 'usd'), '$0.42');
  assert.equal(formatChartValue(1_600_000_000, 'tokens', 'en'), '1.6B');
  assert.equal(formatChartValue(1234, 'runs', 'en'), '1,234');
  assert.equal(formatChartValue(Number.NaN, 'tokens', 'en'), '—');
});

test('formatBucketLabel shortens day and hour buckets', () => {
  assert.equal(formatBucketLabel('2026-02-03'), '02-03');
  assert.equal(formatBucketLabel('2026-02-03T13:00:00.000Z'), '13:00');
});

test('unpricedReason distinguishes subscription harnesses from missing prices', () => {
  assert.equal(unpricedReason({ usd: null, unpricedEvents: 3, harness: 'claude' }), 'subscription');
  assert.equal(unpricedReason({ usd: null, unpricedEvents: 1, harness: 'sdk' }), 'subscription');
  assert.equal(unpricedReason({ usd: 0, unpricedEvents: 5, harness: 'codex' }), 'unpriced');
  assert.equal(unpricedReason({ usd: 0, unpricedEvents: 5, harness: null }), 'unpriced');
  assert.equal(unpricedReason({ usd: 1.2, unpricedEvents: 5, harness: 'claude' }), null);
  assert.equal(unpricedReason({ usd: 0, unpricedEvents: 0, harness: 'sdk' }), null);
});

test('sumTokens adds every token bucket and ignores junk', () => {
  assert.equal(sumTokens({ textInput: 10, textOutput: 5, cachedInput: 2 }), 17);
  assert.equal(sumTokens({ textInput: '4', audioInput: -3 }), 4);
  assert.equal(sumTokens(null), 0);
});

test('escapeHtml neutralizes markup and quotes', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});

test('sumDayWindow sums byDay rows inside an inclusive window', () => {
  const byDay = {
    '2026-02-01': { usd: 1, estimatedUsd: 0.5, unpricedEvents: 0, tokens: { textInput: 10 }, runs: 2, okRuns: 1 },
    '2026-02-02': { usd: 2, estimatedUsd: 0, unpricedEvents: 3, tokens: { textInput: 5 }, runs: 2, okRuns: 2 },
    '2026-02-03': { usd: 0, estimatedUsd: 0, unpricedEvents: 0, tokens: {}, runs: 0, okRuns: 0 },
  };
  const window = sumDayWindow(byDay, '2026-02-01', '2026-02-02');
  assert.equal(window.usd, 3);
  assert.equal(window.estimatedUsd, 0.5);
  assert.equal(window.unpricedEvents, 3);
  assert.equal(window.tokens, 15);
  assert.equal(window.runs, 4);
  assert.equal(window.successRate, 0.75);
  assert.equal(sumDayWindow(byDay, '2026-02-04', '2026-02-05').runs, 0);
  assert.equal(sumDayWindow(byDay, '2026-02-04', '2026-02-05').successRate, null);
});

test('addDaysIso handles month boundaries in UTC', () => {
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysIso('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysIso('2026-02-10', 5), '2026-02-15');
});
