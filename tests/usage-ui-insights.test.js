/**
 * Pure UI view helpers for cache buckets, coverage, executed choices, shares
 * and export metadata.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShareOfTotalPercent,
  choiceGroupRows,
  choicesView,
  costProvenanceView,
  coverageBreakdownRows,
  coverageViewRows,
  exportMetaRows,
  signalRows,
  tokenBucketRows,
} from '../app_front/features/usage/usageCharts.js';
import { sumUsageTokenBuckets } from '../lib/usage/usage-insights.js';

test('tokenBucketRows keeps cache read/write separate and shares sum to the total', () => {
  const view = tokenBucketRows({
    inputWithoutCache: 50,
    cacheRead: 900,
    cacheWrite: 50,
    outputWithoutReasoning: 80,
    reasoning: 20,
    reasoningDiagnosticTokens: 0,
  });
  assert.equal(view.totalTokens, 1100);
  assert.equal(view.cacheTokens, 950);
  const cacheRead = view.rows.find((row) => row.key === 'cacheRead');
  assert.equal(cacheRead.labelKey, 'usage.bucketCacheRead');
  assert.equal(cacheRead.value, 900);
  assert.ok(Math.abs(cacheRead.share_ratio - 900 / 1100) < 1e-6);
  assert.ok(Math.abs(view.rows.reduce((sum, row) => sum + (row.share_ratio || 0), 0) - 1) < 1e-6);
});

test('tokenBucketRows reports null shares for an all-zero view', () => {
  const view = tokenBucketRows({});
  assert.equal(view.totalTokens, 0);
  assert.equal(view.rows[0].share_percent, null);
});

test('tokenBucketRows never double counts diagnostic reasoning from an unknown relation', () => {
  // qwen reasoning is inside output: the API keeps it only in
  // reasoningDiagnosticTokens, outside the disjoint total.
  const api = sumUsageTokenBuckets([
    { harness: 'qwen', tokens: { textInput: 100, textOutput: 50, reasoning: 10 } },
  ]);
  assert.equal(api.totalTokens, 150);
  assert.equal(api.reasoningDiagnosticTokens, 10);
  const view = tokenBucketRows(api);
  assert.equal(view.totalTokens, 150, 'the disjoint API total is authoritative');
  assert.equal(
    view.rows.reduce((sum, row) => sum + row.value, 0),
    150,
    'bucket rows sum to the disjoint total'
  );
  assert.equal(view.rows.find((row) => row.key === 'reasoning').value, 0);
  assert.equal(view.diagnosticRows.length, 1);
  assert.equal(view.diagnosticRows[0].value, 10);
  // A producer that leaked diagnostic reasoning into `reasoning` must not
  // inflate the total or the shares.
  const leaked = tokenBucketRows({ ...api, reasoning: 10 });
  assert.equal(leaked.totalTokens, 150);
  assert.equal(leaked.rows.reduce((sum, row) => sum + row.value, 0), 150);
  assert.ok(leaked.rows.reduce((sum, row) => sum + (row.share_ratio || 0), 0) <= 1 + 1e-6);
});

test('buildShareOfTotalPercent returns null without a cohort total', () => {
  assert.equal(buildShareOfTotalPercent(25, 100), 25);
  assert.equal(buildShareOfTotalPercent(1, 3), 33.33);
  assert.equal(buildShareOfTotalPercent(5, 0), null);
  assert.equal(buildShareOfTotalPercent(5, null), null);
});

test('coverageViewRows keeps both ratios with their denominators', () => {
  const rows = coverageViewRows({
    endedWithUsage: { n: 3, denominator: 5, ratio: 0.6 },
    endedComplete: { n: 1, denominator: 5, ratio: 0.2 },
  });
  assert.equal(rows[0].key, 'endedWithUsage');
  assert.equal(rows[0].ratio, 0.6);
  assert.equal(rows[1].labelKey, 'usage.coverageEndedComplete');
  assert.equal(rows[1].ratio, 0.2);
  const empty = coverageViewRows({ endedWithUsage: { n: 0, denominator: 0, ratio: null } });
  assert.equal(empty[0].ratio, null);
  assert.equal(empty[0].denominator, 0);
});

test('coverageBreakdownRows lists lifecycle/completeness categories separately', () => {
  const rows = coverageBreakdownRows({
    byCompleteness: { complete: 1, partial: 2, missing: 3, unsupported: 0, unknown: 4 },
    runs: { active: 5 },
    legacy: { inferredWithoutRunStart: 6 },
    estimated: { runs: 7 },
    reportedZero: { runs: 8 },
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.n]));
  assert.deepEqual(byKey, {
    complete: 1,
    partial: 2,
    missing: 3,
    unsupported: 0,
    unknown: 4,
    active: 5,
    legacy: 6,
    estimated: 7,
    reportedZero: 8,
  });
});

test('choicesView separates executed from proposals and diagnostic picks', () => {
  const view = choicesView({
    executed: 4,
    auto: 2,
    manual: 1,
    unknown: 1,
    proposals: 7,
    diagnosticPicks: 4,
    originDetails: { selected: 1, fanout: 1, legacy: 2 },
    linkStatuses: { linked: 3, legacy: 1 },
    groups: [{ key: 'sdk/m', executed: 3 }],
  });
  assert.equal(view.executed, 4);
  assert.equal(view.proposals, 7);
  assert.equal(view.diagnosticPicks, 4);
  assert.equal(view.originRows.find((row) => row.key === 'auto').share_percent, 50);
  assert.equal(view.originRows.find((row) => row.key === 'manual').labelKey, 'usage.choices_manual');
  const selected = view.originDetails.find((row) => row.key === 'selected');
  assert.equal(selected.labelKey, 'usage.originSelected');
  assert.equal(view.linkStatuses.find((row) => row.key === 'legacy').labelKey, 'usage.linkLegacy');
});

test('choicesView keeps an unreadable proposal store as null, not zero', () => {
  const view = choicesView({ executed: 0, proposals: null, diagnosticPicks: null });
  assert.equal(view.proposals, null);
  assert.equal(view.diagnosticPicks, null);
  assert.equal(view.originRows[0].share_percent, null);
});

test('choiceGroupRows normalizes per-model executed rows', () => {
  const rows = choiceGroupRows([
    { key: 'sdk/m', harness: 'sdk', model: 'm', executed: 2, auto: 1, manual: 1, technicalSuccess: 1, technicalOutcomeKnown: 2, technicalSuccessRate: 0.5 },
  ]);
  assert.equal(rows[0].executed, 2);
  assert.equal(rows[0].technicalSuccessRate, 0.5);
  assert.deepEqual(choiceGroupRows(null), []);
});

test('signalRows never blends technical success with review acceptance', () => {
  const rows = signalRows({
    technicalSuccess: { n: 3, denominator: 4 },
    acceptedByReview: { n: 2, denominator: 4 },
    manualAccepted: { n: 1, denominator: 4 },
    rejectedByReview: { n: 1, denominator: 4 },
  });
  assert.deepEqual(rows.map((row) => row.key), ['technicalSuccess', 'acceptedByReview', 'manualAccepted', 'rejectedByReview']);
  assert.ok(Math.abs(rows[0].ratio - 0.75) < 1e-9);
  assert.ok(Math.abs(rows[1].ratio - 0.5) < 1e-9);
  const zero = signalRows({ acceptedByReview: { n: 0, denominator: 0 } });
  assert.equal(zero[1].ratio, null, 'no denominator means no ratio, not 0%');
});

test('costProvenanceView exposes actual/estimate/subscription/unpriced and partial', () => {
  const view = costProvenanceView({
    actualUsd: 2.5,
    estimatedUsd: 0.5,
    subscriptionEvents: 2,
    unpricedEvents: 1,
    pricedEvents: 3,
    totalEvents: 5,
    partial: true,
  });
  assert.equal(view.actualUsd, 2.5);
  assert.equal(view.subscriptionEvents, 2);
  assert.equal(view.unpricedEvents, 1);
  assert.equal(view.partial, true);
});

test('exportMetaRows carries scope, zone, filters, coverage and versions', () => {
  const rows = exportMetaRows({
    window: { tz: 'Europe/Warsaw', range: 'month', from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
    filters: { scope: 'consolidated', subject: 'delegation', role: 'implement', origin: 'auto', workspaceFile: '/w' },
    coverage: { endedWithUsage: { n: 3, denominator: 5 }, endedComplete: { n: 1, denominator: 5 } },
    version: { schemaVersion: 2, normalizationVersion: 2, contractRevision: '2026-10-06.2' },
  });
  const map = Object.fromEntries(rows);
  assert.equal(map.scope, 'consolidated');
  assert.equal(map.subject, 'delegation');
  assert.equal(map.tz, 'Europe/Warsaw');
  assert.equal(map.range, 'month');
  assert.equal(map.role, 'implement');
  assert.equal(map.origin, 'auto');
  assert.equal(map.workspace, '/w');
  assert.equal(map.coverage_ended_with_usage, '3/5');
  assert.equal(map.coverage_ended_complete, '1/5');
  assert.equal(map.schema_version, '2');
  assert.equal(map.contract_revision, '2026-10-06.2');
});
