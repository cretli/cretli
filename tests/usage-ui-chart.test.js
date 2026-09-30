import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChartModel,
  harnessRowsFromSummary,
  modelRowsFromPayload,
  normalizeUsageRow,
  renderStackedBarSvg,
  unpricedReason,
} from '../app_front/features/usage/usageCharts.js';

test('normalizeUsageRow fills totals, success rate and p95', () => {
  const row = normalizeUsageRow(
    { usd: 1.5, estimatedUsd: 0.2, unpricedEvents: 1, runs: 4, okRuns: 3, tokens: { textInput: 7, textOutput: 3 }, p95LatencyMs: 900 },
    { key: 'gpt-x', label: 'gpt-x' }
  );
  assert.equal(row.label, 'gpt-x');
  assert.equal(row.usd, 1.5);
  assert.equal(row.totalTokens, 10);
  assert.equal(row.runs, 4);
  assert.equal(row.successRate, 0.75);
  assert.equal(row.p95LatencyMs, 900);
  assert.equal(normalizeUsageRow({ runs: 0 }).successRate, null);
  assert.equal(normalizeUsageRow({ runs: 0 }).p95LatencyMs, null);
  assert.equal(normalizeUsageRow({ usd: null }).usd, null);
});

test('harnessRowsFromSummary and modelRowsFromPayload build table rows', () => {
  const harnessRows = harnessRowsFromSummary({
    byHarness: {
      claude: { usd: null, unpricedEvents: 2, tokens: { textInput: 5 }, runs: 1, okRuns: 1 },
      sdk: { usd: 0.5, tokens: { textInput: 100 }, runs: 2, okRuns: 1 },
    },
  });
  assert.equal(harnessRows.length, 2);
  const claude = harnessRows.find((row) => row.harness === 'claude');
  assert.equal(claude.unpricedEvents, 2);
  assert.equal(claude.totalTokens, 5);
  const models = modelRowsFromPayload([{ model: 'gpt-4o', totalTokens: 42, runs: 1, okRuns: 1 }]);
  assert.equal(models[0].label, 'gpt-4o');
  assert.equal(models[0].totalTokens, 42);
  assert.deepEqual(modelRowsFromPayload(null), []);
});

test('buildChartModel stacks groups and keeps bucket totals', () => {
  const model = buildChartModel({
    buckets: ['2026-02-01', '2026-02-02'],
    series: [
      { group: 'a', values: [1, 2] },
      { group: 'b', values: [4, 0] },
    ],
  });
  assert.deepEqual(model.bucketTotals, [5, 2]);
  assert.equal(model.max, 5);
  assert.deepEqual(model.series.map((entry) => entry.group), ['b', 'a']);
  assert.deepEqual(model.series.map((entry) => entry.colorIndex), [0, 1]);
});

test('buildChartModel collapses extra groups into an "other" slice', () => {
  const model = buildChartModel(
    {
      buckets: ['d1'],
      series: [
        { group: 'a', values: [10] },
        { group: 'b', values: [8] },
        { group: 'c', values: [6] },
        { group: 'd', values: [4] },
      ],
    },
    { maxSeries: 3, otherLabel: 'other' }
  );
  assert.equal(model.series.length, 3);
  assert.deepEqual(model.series.map((entry) => entry.label), ['a', 'b', 'other']);
  assert.equal(model.series[2].values[0], 10);
  assert.equal(model.max, 28);
});

test('buildChartModel tolerates missing values and empty payloads', () => {
  const model = buildChartModel({ buckets: ['d1'], series: [{ group: 'a', values: [Number.NaN] }] });
  assert.deepEqual(model.bucketTotals, [0]);
  assert.equal(model.max, 0);
  const empty = buildChartModel(null);
  assert.deepEqual(empty.buckets, []);
  assert.equal(empty.max, 0);
});

test('renderStackedBarSvg draws accessible rects with titles', () => {
  const model = buildChartModel({
    buckets: ['2026-02-01', '2026-02-02'],
    series: [{ group: 'claude', values: [5, 10] }],
  });
  const svg = renderStackedBarSvg(model, { metric: 'tokens', lang: 'en' });
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 \d+ 200"/);
  assert.equal((svg.match(/<rect /g) || []).length, 2);
  assert.match(svg, /settings-usage-series-0/);
  assert.match(svg, /<title>claude: 5<\/title>/);
  assert.match(svg, /02-01/);
});

test('renderStackedBarSvg returns nothing without data and grows with buckets', () => {
  assert.equal(renderStackedBarSvg(null), '');
  assert.equal(renderStackedBarSvg(buildChartModel({ buckets: ['d1'], series: [] })), '');
  const twoBuckets = renderStackedBarSvg(
    buildChartModel({ buckets: ['d1', 'd2'], series: [{ group: 'a', values: [1, 1] }] })
  );
  const tenBuckets = renderStackedBarSvg(
    buildChartModel({ buckets: Array.from({ length: 10 }, (_, i) => `d${i}`), series: [{ group: 'a', values: new Array(10).fill(1) }] })
  );
  const widthOf = (svg) => Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
  assert.ok(widthOf(tenBuckets) > widthOf(twoBuckets));
});

test('renderStackedBarSvg prints Y-axis labels for 0, half and max', () => {
  const model = buildChartModel({
    buckets: ['d1', 'd2'],
    series: [{ group: 'a', values: [4, 8] }],
  });
  const svg = renderStackedBarSvg(model, { metric: 'tokens', lang: 'en' });
  const yLabels = [...svg.matchAll(/settings-usage-axis-label-y"[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(yLabels, ['0', '4', '8']);
  assert.match(svg, /text-anchor="end"/);
});

test('renderStackedBarSvg keeps X labels at a readable density', () => {
  const buckets = Array.from({ length: 60 }, (_, i) => `2026-02-${String((i % 28) + 1).padStart(2, '0')}`);
  const model = buildChartModel({
    buckets,
    series: [{ group: 'a', values: new Array(60).fill(1) }],
  });
  const svg = renderStackedBarSvg(model, { metric: 'tokens', lang: 'en' });
  const xLabels = [...svg.matchAll(/settings-usage-axis-label"[^>]*>([^<]+)</g)];
  assert.ok(xLabels.length > 0 && xLabels.length <= 13, `expected <=13 x labels, got ${xLabels.length}`);
});

test('buildChartModel maps group ids through labelFor for legends and tooltips', () => {
  const model = buildChartModel(
    { buckets: ['d1'], series: [{ group: 'sdk', values: [3] }, { group: 'claude', values: [1] }] },
    { labelFor: (group) => (group === 'sdk' ? 'Cursor SDK' : group) }
  );
  assert.deepEqual(model.series.map((entry) => entry.group), ['sdk', 'claude']);
  assert.deepEqual(model.series.map((entry) => entry.label), ['Cursor SDK', 'claude']);
});

test('modelRowsFromPayload keeps the harness and p95 from the API row', () => {
  const rows = modelRowsFromPayload([
    { model: 'claude-sonnet-4-5', harness: 'claude', unpricedEvents: 2, runs: 1, okRuns: 1, p95LatencyMs: 420, totalTokens: 10 },
  ]);
  assert.equal(rows[0].harness, 'claude');
  assert.equal(rows[0].p95LatencyMs, 420);
  assert.equal(unpricedReason(rows[0]), 'subscription');
});
