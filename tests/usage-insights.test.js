/**
 * Disjoint buckets, coverage, executed choices and cohort shares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCohortShares,
  buildUsageCoverage,
  buildUsageInsights,
  buildUsageKpis,
  buildUsageSignals,
  delegationRowMatchesFilters,
  filterUsageEvents,
  sumUsageCost,
  sumUsageTokenBuckets,
  summarizeExecutedChoices,
  usageEventSubject,
} from '../lib/usage/usage-insights.js';

test('sumUsageTokenBuckets derives disjoint buckets and never folds cache into input', () => {
  const sdk = sumUsageTokenBuckets([
    {
      harness: 'sdk',
      tokens: { textInput: 1000, textOutput: 100, cachedInput: 900, cacheWrite: 50, reasoning: 20 },
    },
  ]);
  assert.equal(sdk.inputWithoutCache, 50);
  assert.equal(sdk.cacheRead, 900);
  assert.equal(sdk.cacheWrite, 50);
  assert.equal(sdk.outputWithoutReasoning, 80);
  assert.equal(sdk.reasoning, 20);
  assert.equal(sdk.cacheTokens, 950);
  assert.equal(sdk.totalTokens, 1100);
  assert.ok(Math.abs(sdk.cacheShare - 950 / 1100) < 1e-6);
  assert.equal(sdk.eventsWithCache, 1);
});

test('reasoning with an unknown relation stays a diagnostic subcounter', () => {
  const qwen = sumUsageTokenBuckets([
    { harness: 'qwen', tokens: { textInput: 100, textOutput: 50, reasoning: 10 } },
  ]);
  // qwen relation is unknown: reasoning is already inside output and is not added again.
  assert.equal(qwen.outputWithoutReasoning, 50);
  assert.equal(qwen.reasoning, 0);
  assert.equal(qwen.reasoningDiagnosticTokens, 10);
  assert.equal(qwen.totalTokens, 150);
});

test('sumUsageCost separates actual, estimated, subscription and unpriced', () => {
  const cost = sumUsageCost([
    { usd: 1.5, provenance: 'reported' },
    { usd: 0.5, estimated: true },
    { usd: null, billingMode: 'subscription' },
    { usd: null },
  ]);
  assert.equal(cost.actualUsd, 1.5);
  assert.equal(cost.estimatedUsd, 0.5);
  assert.equal(cost.pricedEvents, 2);
  assert.equal(cost.estimatedEvents, 1);
  assert.equal(cost.subscriptionEvents, 1);
  assert.equal(cost.unpricedEvents, 2);
  assert.equal(cost.partial, true);
});

test('usageEventSubject classifies chat, delegation and internal children', () => {
  assert.equal(usageEventSubject({ chatId: 'c1' }), 'chat');
  assert.equal(usageEventSubject({ delegationId: 'd1' }), 'delegation');
  assert.equal(usageEventSubject({ accountingScope: 'consolidated' }), 'internal');
  assert.equal(usageEventSubject({ cycleId: 'cy' }), 'internal');
});

test('filterUsageEvents honours role, harness, workspace, scope and subject', () => {
  const events = [
    { id: 'a', role: 'implement', harness: 'sdk', workspaceFile: '/w/a', at: '2026-08-01T00:00:00Z' },
    { id: 'b', role: 'review', harness: 'claude', workspaceFile: '/w/b', accountingScope: 'consolidated', at: '2026-08-01T00:00:00Z' },
    { id: 'c', role: 'implement', harness: 'claude', delegationId: 'd1', at: '2026-08-01T00:00:00Z' },
  ];
  assert.deepEqual(filterUsageEvents(events, { role: 'implement' }).map((e) => e.id), ['a', 'c']);
  assert.deepEqual(filterUsageEvents(events, { harness: 'claude' }).map((e) => e.id), ['b', 'c']);
  assert.deepEqual(filterUsageEvents(events, { workspaceFile: '/w/a' }).map((e) => e.id), ['a']);
  assert.deepEqual(filterUsageEvents(events, { scope: 'consolidated' }).map((e) => e.id), ['b']);
  assert.deepEqual(filterUsageEvents(events, { subject: 'internal' }).map((e) => e.id), ['b']);
  assert.deepEqual(filterUsageEvents(events, { subject: 'delegation' }).map((e) => e.id), ['c']);
});

test('buildUsageCoverage reports both ratios with explicit denominators', () => {
  const runs = [
    { runKey: 'a', runId: 'r1', harness: 'claude', role: 'implement', status: 'ended', endedAt: '2026-08-01T10:00:00Z', measurementPresent: true, completeness: 'complete', coverage: { proof: true } },
    { runKey: 'b', runId: 'r2', harness: 'claude', role: 'implement', status: 'ended', endedAt: '2026-08-01T11:00:00Z', measurementPresent: false, completeness: 'missing' },
    { runKey: 'c', runId: 'r3', harness: 'claude', role: 'implement', status: 'active', startedAt: '2026-08-01T12:00:00Z', inferredWithoutRunStart: true },
  ];
  const events = [
    { runId: 'r1', eventType: 'delta', at: '2026-08-01T10:00:00Z', tokens: { textInput: 10 } },
  ];
  const coverage = buildUsageCoverage({
    runs,
    events,
    window: { fromMs: Date.parse('2026-08-01T00:00:00Z'), toMs: Date.parse('2026-08-02T00:00:00Z') },
    filters: { harness: 'claude' },
  });
  assert.equal(coverage.runs.total, 3);
  assert.equal(coverage.runs.active, 1);
  assert.equal(coverage.runs.ended, 2);
  assert.equal(coverage.endedWithUsage.n, 1);
  assert.equal(coverage.endedWithUsage.denominator, 2);
  assert.equal(coverage.endedWithUsage.ratio, 0.5);
  assert.equal(coverage.endedComplete.n, 1);
  assert.equal(coverage.endedComplete.denominator, 2);
  assert.equal(coverage.endedComplete.ratio, 0.5);
  assert.deepEqual(coverage.byCompleteness, { complete: 1, partial: 0, missing: 1, unsupported: 0, unknown: 0 });
  assert.equal(coverage.legacy.inferredWithoutRunStart, 1);
});

test('buildUsageCoverage returns null ratios instead of a fake zero denominator', () => {
  const coverage = buildUsageCoverage({ runs: [], events: [] });
  assert.equal(coverage.endedWithUsage.denominator, 0);
  assert.equal(coverage.endedWithUsage.ratio, null);
  assert.equal(coverage.endedComplete.ratio, null);
});

test('buildUsageCoverage correlates per run id and keeps a reported zero visible', () => {
  const runs = [
    { runKey: 'a', runId: 'r1', status: 'ended', endedAt: '2026-08-01T10:00:00Z', completeness: 'partial' },
    { runKey: 'b', runId: 'r2', status: 'ended', endedAt: '2026-08-01T11:00:00Z', completeness: 'partial' },
  ];
  const events = [
    { runId: 'r1', eventType: 'delta', at: '2026-08-01T10:00:00Z', tokens: { textInput: 0 } },
  ];
  const coverage = buildUsageCoverage({ runs, events });
  assert.equal(coverage.endedWithUsage.n, 1, 'only r1 has a correlated measurement');
  assert.equal(coverage.reportedZero.runs, 1, 'a reported zero is not a missing measurement');
});

test('summarizeExecutedChoices separates execution from proposals and diagnostic picks', () => {
  const rows = [
    { pickId: 'p1', pickOrigin: 'auto', pickOriginDetail: 'selected', pickLinkStatus: 'linked', pickRole: 'implement', executor: { transport: 'sdk', model: 'composer-2' }, status: 'completed' },
    { pickId: 'p2', pickOrigin: 'auto', pickOriginDetail: 'fanout', pickLinkStatus: 'linked', pickRole: 'implement', executor: { transport: 'deepseek', model: 'deepseek-v4' }, status: 'completed' },
    { pickOrigin: 'manual', pickOriginDetail: 'user', pickLinkStatus: 'linked', pickRole: 'review', executor: { transport: 'claude', model: 'opus' }, status: 'failed' },
    { pickOrigin: 'unknown', pickOriginDetail: 'legacy', pickLinkStatus: 'legacy', pickRole: 'implement', executor: { transport: 'sdk', model: 'composer-2' } },
  ];
  const choices = summarizeExecutedChoices(rows, { proposals: 5 });
  assert.equal(choices.executed, 4);
  assert.equal(choices.auto, 2);
  assert.equal(choices.manual, 1);
  assert.equal(choices.unknown, 1);
  assert.equal(choices.proposals, 5);
  assert.equal(choices.diagnosticPicks, 3);
  assert.equal(choices.originDetails.selected, 1);
  assert.equal(choices.linkStatuses.legacy, 1);
  const sdk = choices.groups.find((group) => group.key === 'sdk/composer-2');
  assert.equal(sdk.executed, 2);
  assert.equal(sdk.technicalSuccess, 1);
  assert.equal(sdk.technicalOutcomeKnown, 1);
  assert.equal(sdk.technicalSuccessRate, 1);
});

test('delegationRowMatchesFilters filters role, origin, workspace and window', () => {
  const row = { pickRole: 'implement', pickOrigin: 'auto', workspaceFolder: '/w', createdAt: '2026-08-01T10:00:00Z' };
  assert.equal(delegationRowMatchesFilters(row, { role: 'implement' }), true);
  assert.equal(delegationRowMatchesFilters(row, { role: 'review' }), false);
  assert.equal(delegationRowMatchesFilters(row, { origin: 'auto' }), true);
  assert.equal(delegationRowMatchesFilters(row, { origin: 'manual' }), false);
  assert.equal(delegationRowMatchesFilters(row, { workspace: '/w' }), true);
  assert.equal(delegationRowMatchesFilters(row, { workspace: '/other' }), false);
  assert.equal(delegationRowMatchesFilters(row, { fromMs: Date.parse('2026-08-01T09:00:00Z'), toMs: Date.parse('2026-08-01T11:00:00Z') }), true);
  assert.equal(delegationRowMatchesFilters(row, { fromMs: Date.parse('2026-08-02T00:00:00Z') }), false);
});

test('buildCohortShares gives percentages of the cohort total and names a leader', () => {
  const shares = buildCohortShares(
    [{ key: 'a', tokens: 60 }, { key: 'b', tokens: 30 }, { key: 'c', tokens: 10 }],
    (row) => row.tokens,
    { keyOf: (row) => row.key }
  );
  assert.equal(shares.metricTotal, 100);
  assert.deepEqual(shares.rows.map((row) => row.share_percent), [60, 30, 10]);
  assert.ok(Math.abs(shares.rows.reduce((sum, row) => sum + row.share_ratio, 0) - 1) < 1e-6);
  assert.equal(shares.leader.key, 'a');
  assert.equal(shares.leader.share_ratio, 0.6);
});

test('buildCohortShares returns null percentages for an all-zero cohort', () => {
  const shares = buildCohortShares([{ key: 'a', tokens: 0 }], (row) => row.tokens, { keyOf: (row) => row.key });
  assert.equal(shares.metricTotal, 0);
  assert.equal(shares.rows[0].share_percent, null);
  assert.equal(shares.leader, null);
});

test('buildUsageSignals keeps acceptance, manualAccept and verdicts separate', () => {
  const signals = buildUsageSignals(
    {
      closedCycleCount: 4,
      openCycleCount: 2,
      acceptedCount: 2,
      rejectedCount: 1,
      manualAcceptedCount: 1,
      undecidedCount: 1,
      unreviewedCount: 1,
      totalCostUsd: 3,
      unknownUsageEventCount: 1,
      subscriptionUsageEventCount: 1,
      pricedEventShare: 0.5,
      denominators: { openCycles: 2, pricedEvents: 1, totalEvents: 2 },
    },
    { verdicts: { pass: 2, fail: 1, blocked: 0, undecided: 1 } }
  );
  assert.equal(signals.acceptedByReview.n, 2);
  assert.equal(signals.acceptedByReview.denominator, 4);
  assert.equal(signals.acceptedByReview.ratio, 0.5);
  assert.equal(signals.manualAccepted.n, 1);
  assert.equal(signals.reviewVerdicts.n, 4);
  assert.equal(signals.cost.partial, true);
  assert.equal(signals.technicalSuccess.denominator, 0);
});

test('buildUsageInsights composes one filter-consistent payload', () => {
  const insights = buildUsageInsights({
    events: [
      { id: 'a', harness: 'sdk', role: 'implement', eventType: 'delta', at: '2026-08-01T10:00:00Z', tokens: { textInput: 100, cachedInput: 60 } },
      { id: 'b', harness: 'sdk', role: 'review', eventType: 'delta', at: '2026-08-01T11:00:00Z', tokens: { textInput: 50 } },
    ],
    runs: [
      { runKey: 'a', runId: 'l1', harness: 'sdk', role: 'implement', status: 'ended', endedAt: '2026-08-01T10:00:00Z', measurementPresent: true, completeness: 'complete' },
    ],
    window: { tz: 'UTC', from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z', fromMs: Date.parse('2026-08-01T00:00:00Z'), toMs: Date.parse('2026-08-02T00:00:00Z'), definition: 'x', inputKind: 'instant' },
    filters: { role: 'implement' },
    choicesRows: [{ pickId: 'p1', pickOrigin: 'auto', pickRole: 'implement', executor: { transport: 'sdk', model: 'composer-2' } }],
    proposals: 3,
  });
  assert.equal(insights.schemaVersion, 2);
  assert.equal(insights.filters.role, 'implement');
  assert.equal(insights.tokens.events, 1, 'the review event is filtered out everywhere');
  assert.equal(insights.tokens.inputWithoutCache, 40);
  assert.equal(insights.tokens.cacheRead, 60);
  assert.equal(insights.choices.executed, 1);
  assert.equal(insights.choices.diagnosticPicks, 2);
  assert.equal(insights.coverage.endedWithUsage.n, 1);
});

test('buildUsageKpis resolves today, rolling week and calendar month in the zone', () => {
  const byZoneDay = {
    '2026-02-25': { usd: 0, tokens: 1, runs: 1, okRuns: 1 },
    '2026-03-01': { usd: 1, tokens: 10, runs: 1, okRuns: 1 },
    '2026-03-02': { usd: 2, tokens: 20, runs: 1, okRuns: 0 },
    '2026-03-03': { usd: 3, tokens: 30, runs: 2, okRuns: 2 },
  };
  const kpi = buildUsageKpis(byZoneDay, { now: Date.parse('2026-03-03T12:00:00.000Z'), tz: 'Europe/Warsaw' });
  assert.equal(kpi.today.tokens, 30);
  assert.equal(kpi.today.usd, 3);
  assert.equal(kpi.week.tokens, 61, 'week includes 2026-02-25 through 2026-03-03');
  assert.equal(kpi.month.tokens, 60, 'month starts 2026-03-01');
  assert.equal(kpi.month.runs, 4);
  assert.ok(Math.abs(kpi.month.successRate - 0.75) < 1e-9);
});
