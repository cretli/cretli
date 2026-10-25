import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeContextCacheSeries } from '../lib/usage/context-cache-series.ts';
import { renderChatContextCacheChartHtml } from '../app_front/features/chat/chatContextCacheChartView.js';

const base = Date.parse('2026-01-01T00:00:00Z');
const sample = (minute, over = {}) => ({
  observedAt: new Date(base + minute * 60000).toISOString(), chatId: 'c', runId: 'r1', model: 'm', contextEpoch: 0,
  inputTokens: 50000, totalTokens: 50500, outputTokens: 500, cacheReadTokens: 48000, cacheWriteTokens: null,
  contextWindowTokens: 200000, ...over,
});

test('healthy growing cache produces no breaks', () => {
  const { points, breaks } = analyzeContextCacheSeries([sample(0), sample(1, { cacheReadTokens: 49000 })]);
  assert.equal(points.length, 2);
  assert.equal(breaks.length, 0);
});

test('classifies the cause of a cache drop from neighbouring samples', () => {
  const drop = { cacheReadTokens: 100 };
  const cause = (previous, current) => analyzeContextCacheSeries([previous, current]).breaks[0]?.cause;
  assert.equal(cause(sample(0), sample(1, { ...drop, contextEpoch: 1, contextEpochReason: 'compaction' })), 'compaction');
  assert.equal(cause(sample(0), sample(1, { ...drop, model: 'other' })), 'model_change');
  assert.equal(cause(sample(0), sample(30, drop)), 'idle_gap');
  assert.equal(cause(sample(0), sample(1, { ...drop, runId: 'r2' })), 'new_run');
  assert.equal(cause(sample(0), sample(1, drop)), 'unknown');
  const rows = (tokens) => ({ breakdown: { rows: [{ id: 'systemTools', tokens }] } });
  assert.equal(cause(sample(0, rows(1000)), sample(1, { ...drop, ...rows(1500) })), 'prefix_change');
});

test('unknown cache values and tiny prefixes never count as breaks', () => {
  assert.equal(analyzeContextCacheSeries([sample(0, { cacheReadTokens: null }), sample(1, { cacheReadTokens: 0 })]).breaks.length, 0);
  assert.equal(analyzeContextCacheSeries([sample(0, { cacheReadTokens: 500 }), sample(1, { cacheReadTokens: 0 })]).breaks.length, 0);
});

test('chart renders the series and break list, and stays silent without a series', () => {
  const t = (key) => key;
  const series = analyzeContextCacheSeries([sample(0), sample(30, { cacheReadTokens: 0 })]);
  const html = renderChatContextCacheChartHtml(series, t);
  assert.match(html, /<svg/);
  assert.match(html, /contextBreakCause_idle_gap/);
  assert.equal(renderChatContextCacheChartHtml(null, t), '');
});

test('series exposes the newest breakdown and fills a snapshot only where live data is missing', async () => {
  const { mergeSeriesIntoContextSnapshot } = await import('../app_front/features/chat/chatContextCacheChartView.js');
  const rows = [{ id: 'messages', tokens: 10, count: null, estimated: true }];
  const series = analyzeContextCacheSeries([sample(0, { breakdown: { rows } }), sample(1)]);
  assert.equal(series.latestBreakdown.rows.length, 1);
  const filled = mergeSeriesIntoContextSnapshot({ transport: 'claude', cacheReadTokens: null, breakdown: null }, series);
  assert.equal(filled.cacheReadTokens, 48000);
  assert.equal(filled.cacheInputTokens, 50000);
  assert.equal(filled.breakdown.rows.length, 1);
  const live = mergeSeriesIntoContextSnapshot({ transport: 'claude', cacheReadTokens: 5, cacheInputTokens: 9, breakdown: { rows: [] } }, series);
  assert.equal(live.cacheReadTokens, 5);
  assert.equal(live.breakdown.rows.length, 0);
});


test('repeated response observations are not separate calls and idle gaps are not proof of expiry', () => {
  const series = analyzeContextCacheSeries([sample(0, { measurementId: 'same' }), sample(1, { measurementId: 'same' }), sample(30, { measurementId: 'next', cacheReadTokens: 100, cacheWriteTokens: 0 })]);
  assert.equal(series.points.length, 2);
  assert.equal(series.breaks[0].cause, 'idle_gap');
  assert.equal(series.breaks[0].confidence, 'inferred');
  assert.equal(series.breaks[0].uncachedInputTokens, 49900);
  assert.equal(series.breaks[0].cacheWriteTokens, 0);
});


test('shrinking context with healthy cache hit share is not a cache break', () => {
  const series = analyzeContextCacheSeries([sample(0), sample(1, { inputTokens: 10000, cacheReadTokens: 9500, totalTokens: 10500 })]);
  assert.equal(series.breaks.length, 0);
});

test('a collapsing context is a compaction and the following cache rebuild is attributed to it', () => {
  const synthetic = { measurementId: undefined, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 9000 };
  const series = analyzeContextCacheSeries([
    sample(0, { totalTokens: 80000, inputTokens: 79500, cacheReadTokens: 79000, measurementId: 'a' }),
    sample(0.4, synthetic),
    sample(0.5, { totalTokens: 12000, inputTokens: 11900, cacheReadTokens: 3000, measurementId: 'b' }),
  ]);
  assert.equal(series.compactions.length, 1);
  assert.equal(series.compactions[0].cause, 'compaction');
  assert.equal(series.compactions[0].totalBefore, 80000);
  assert.equal(series.compactions[0].totalAfter, 9000);
  assert.equal(series.breaks.length, 1);
  assert.equal(series.breaks[0].cause, 'compaction');
});

test('chart marks compactions and exposes hover binding without throwing outside a DOM', async () => {
  const { bindChatContextCacheChart } = await import('../app_front/features/chat/chatContextCacheChartView.js');
  const series = analyzeContextCacheSeries([sample(0, { totalTokens: 80000, measurementId: 'a' }), sample(1, { totalTokens: 9000, inputTokens: 0, cacheReadTokens: 0 })]);
  const html = renderChatContextCacheChartHtml(series, (key) => key);
  assert.match(html, /data-event="compaction"/);
  assert.match(html, /contextEventCompaction/);
  assert.doesNotThrow(() => bindChatContextCacheChart(null, series, (key) => key));
});

test('zoom presets limit the plotted calls and mark the active preset', () => {
  const many = Array.from({ length: 60 }, (_, i) => sample(i, { measurementId: `m${i}` }));
  const series = analyzeContextCacheSeries(many);
  const all = renderChatContextCacheChartHtml(series, (key, params) => `${key}${params?.count ?? ''}`);
  assert.match(all, /data-range="30"/);
  const zoomed = renderChatContextCacheChartHtml(series, (key) => key, 'en', { range: 30 });
  assert.match(zoomed, /data-range="30" aria-pressed="true"/);
  assert.match(zoomed, /contextSeriesRange/);
});

test('points carry categories and growth jumps name the category that grew most', () => {
  const rows = (messages, toolResults) => ({ breakdown: { rows: [{ id: 'messages', tokens: messages }, { id: 'toolResults', tokens: toolResults }] } });
  const series = analyzeContextCacheSeries([
    sample(0, { totalTokens: 10000, ...rows(1000, 2000) }),
    sample(1, { totalTokens: 30000, ...rows(1500, 21000) }),
  ]);
  assert.deepEqual(series.points[1].categories, { messages: 1500, toolResults: 21000 });
  assert.equal(series.jumps.length, 1);
  assert.equal(series.jumps[0].topCategory, 'toolResults');
  assert.equal(series.jumps[0].topCategoryDelta, 19000);
});

test('composition mode renders stacked layers and the jump list', () => {
  const t = (key) => key;
  const rows = (tokens) => ({ breakdown: { rows: [{ id: 'toolResults', tokens }] } });
  const series = analyzeContextCacheSeries([
    sample(0, { totalTokens: 10000, ...rows(5000) }),
    sample(1, { totalTokens: 30000, ...rows(25000) }),
  ]);
  const html = renderChatContextCacheChartHtml(series, t, 'en', { mode: 'composition' });
  assert.match(html, /data-layer="toolResults"/);
  assert.match(html, /data-layer="unassigned"/);
  assert.match(html, /growth_jump/);
});
