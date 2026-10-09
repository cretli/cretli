/**
 * API-level stage-8 coverage: exact instant ranges, IANA grouping across DST,
 * disjoint cache buckets, coverage ratios and executed choices.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';
import { beginUsageRun, recordUsage } from '../lib/usage/usage-ledger.js';

function createFakeApp() {
  /** @type {Map<string, Function>} */
  const routes = new Map();
  return {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
    routes,
  };
}

function createFakeResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/**
 * @param {string} method
 * @param {string} routePath
 * @param {{ body?: object, query?: object } & object} input
 */
async function callRoute(method, routePath, input) {
  const app = createFakeApp();
  registerUsageRoutes(app, input.ctx || {});
  const handler = app.routes.get(`${method} ${routePath}`);
  assert.ok(handler, `${method} ${routePath} must be registered`);
  const res = createFakeResponse();
  await handler({ body: input.body || {}, query: input.query || {} }, res);
  return res;
}

/**
 * @param {string} dataDir
 * @param {object} partial
 */
function seed(dataDir, partial) {
  recordUsage(partial, { dataDir });
}

test('summary returns disjoint cache buckets, cost provenance and zone days', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  seed(dataDir, {
    provider: 'cursor',
    harness: 'sdk',
    role: 'implement',
    eventType: 'delta',
    at: '2026-08-28T10:00:00.000Z',
    tokens: { textInput: 1000, textOutput: 100, cachedInput: 900, cacheWrite: 50, reasoning: 20 },
  });
  const actual = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir },
    query: { from: '2026-08-28', to: '2026-08-28', tz: 'UTC' },
  });
  assert.equal(actual.statusCode, 200);
  const buckets = actual.body.summary.buckets;
  assert.equal(buckets.inputWithoutCache, 50);
  assert.equal(buckets.cacheRead, 900);
  assert.equal(buckets.cacheWrite, 50);
  assert.equal(buckets.outputWithoutReasoning, 80);
  assert.equal(buckets.totalTokens, 1100);
  assert.ok(Math.abs(buckets.cacheShare - 950 / 1100) < 1e-6);
  // The sdk event has no rate-table price: the cost must stay explicitly partial.
  assert.equal(actual.body.summary.cost.partial, true);
  assert.equal(actual.body.summary.cost.unpricedEvents, 1);
  assert.equal(actual.body.summary.byZoneDay['2026-08-28'].tokens, 1100);
  assert.equal(actual.body.tz, 'UTC');
});

test('summary keeps an unpriced event visibly partial instead of a free cost', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  seed(dataDir, {
    provider: 'other',
    harness: 'claude',
    billingMode: 'subscription',
    eventType: 'delta',
    at: '2026-08-28T10:00:00.000Z',
    tokens: { textInput: 100 },
  });
  const actual = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir },
    query: { from: '2026-08-28', to: '2026-08-28' },
  });
  assert.equal(actual.body.summary.cost.actualUsd, 0);
  assert.equal(actual.body.summary.cost.subscriptionEvents, 1);
  assert.equal(actual.body.summary.cost.unpricedEvents, 1);
  assert.equal(actual.body.summary.cost.partial, true);
});

test('summary coverage correlates runs per id and reports null for an empty cohort', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  const { runId } = beginUsageRun(
    { harness: 'claude', role: 'implement', at: '2026-08-28T10:00:00.000Z' },
    { dataDir }
  );
  seed(dataDir, {
    provider: 'other',
    harness: 'claude',
    role: 'implement',
    runId,
    eventType: 'delta',
    at: '2026-08-28T10:01:00.000Z',
    tokens: { textInput: 100 },
  });
  seed(dataDir, {
    provider: 'other',
    harness: 'claude',
    role: 'implement',
    runId,
    eventType: 'run',
    outcome: 'ok',
    at: '2026-08-28T10:02:00.000Z',
  });
  const actual = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir },
    query: { from: '2026-08-28', to: '2026-08-28' },
  });
  const coverage = actual.body.summary.coverage;
  assert.equal(coverage.runs.ended, 1);
  assert.equal(coverage.endedWithUsage.denominator, 1);
  assert.equal(coverage.endedWithUsage.ratio, 1);

  const empty = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir },
    query: { from: '2026-01-01', to: '2026-01-02' },
  });
  assert.equal(empty.body.summary.coverage.endedWithUsage.denominator, 0);
  assert.equal(empty.body.summary.coverage.endedWithUsage.ratio, null);
});

test('range=today and grouping follow the IANA zone across a DST day', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  // 2026-03-29 is the Europe/Warsaw spring-forward day.
  seed(dataDir, {
    provider: 'other', harness: 'claude', eventType: 'delta', at: '2026-03-28T23:30:00.000Z', tokens: { textInput: 1 },
  });
  seed(dataDir, {
    provider: 'other', harness: 'claude', eventType: 'delta', at: '2026-03-29T21:30:00.000Z', tokens: { textInput: 2 },
  });
  seed(dataDir, {
    provider: 'other', harness: 'claude', eventType: 'delta', at: '2026-03-29T22:30:00.000Z', tokens: { textInput: 4 },
  });
  const actual = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir, now: Date.parse('2026-03-29T12:00:00.000Z') },
    query: { range: 'today', tz: 'Europe/Warsaw' },
  });
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.from, '2026-03-29');
  assert.equal(actual.body.to, '2026-03-29');
  // Only the two events before the next zone midnight are in "today".
  assert.equal(actual.body.summary.buckets.totalTokens, 3);
  assert.deepEqual(Object.keys(actual.body.summary.byZoneDay), ['2026-03-29']);
});

test('timeseries groups by the zone calendar day and drops the next zone day', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  seed(dataDir, {
    provider: 'other', harness: 'claude', model: 'm', eventType: 'delta', at: '2026-03-29T21:30:00.000Z', tokens: { textInput: 5 },
  });
  seed(dataDir, {
    provider: 'other', harness: 'claude', model: 'm', eventType: 'delta', at: '2026-03-29T22:30:00.000Z', tokens: { textInput: 7 },
  });
  const actual = await callRoute('GET', '/api/usage/timeseries', {
    ctx: { dataDir },
    query: { from: '2026-03-29', to: '2026-03-29', tz: 'Europe/Warsaw', bucket: 'day', groupBy: 'model', metric: 'tokens' },
  });
  assert.equal(actual.statusCode, 200);
  assert.deepEqual(actual.body.buckets, ['2026-03-29']);
  assert.deepEqual(actual.body.series, [{ group: 'm', values: [5] }]);
  assert.equal(actual.body.tz, 'Europe/Warsaw');
});

test('an exact [from, to) instant range excludes the end instant', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  seed(dataDir, { provider: 'other', harness: 'claude', eventType: 'delta', at: '2026-08-01T09:59:59.999Z', tokens: { textInput: 1 } });
  seed(dataDir, { provider: 'other', harness: 'claude', eventType: 'delta', at: '2026-08-01T10:00:00.000Z', tokens: { textInput: 2 } });
  seed(dataDir, { provider: 'other', harness: 'claude', eventType: 'delta', at: '2026-08-01T11:00:00.000Z', tokens: { textInput: 4 } });
  const actual = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir },
    query: { from: '2026-08-01T10:00:00.000Z', to: '2026-08-01T11:00:00.000Z' },
  });
  assert.equal(actual.body.summary.buckets.totalTokens, 2);
});

test('an invalid IANA zone is a 400, never a silent UTC fallback', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  const actual = await callRoute('GET', '/api/usage/summary', {
    ctx: { dataDir },
    query: { from: '2026-08-01', to: '2026-08-02', tz: 'Mars/Olympus' },
  });
  assert.equal(actual.statusCode, 400);
  assert.match(actual.body.error, /Invalid tz/);
});

test('insights reports executed choices separately from proposals and diagnostic picks', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  seed(dataDir, {
    provider: 'cursor', harness: 'sdk', role: 'implement', eventType: 'delta', at: '2026-08-10T00:00:00.000Z', tokens: { textInput: 10 },
  });
  const rows = [
    { id: 'd1', pickId: 'p1', pickOrigin: 'auto', pickOriginDetail: 'selected', pickLinkStatus: 'linked', pickRole: 'implement', executor: { transport: 'sdk', model: 'composer-2' }, status: 'completed', createdAt: '2026-08-10T00:00:00.000Z' },
    { id: 'd2', pickOrigin: 'manual', pickOriginDetail: 'user', pickLinkStatus: 'linked', pickRole: 'implement', executor: { transport: 'claude', model: 'opus' }, status: 'completed', createdAt: '2026-08-10T00:00:00.000Z' },
  ];
  const actual = await callRoute('GET', '/api/usage/insights', {
    ctx: { dataDir, now, loadDelegations: () => rows, loadModelPickRecords: () => ({ p1: {}, p2: {}, p3: {} }) },
    query: { range: '30d', tz: 'UTC', origin: 'auto' },
  });
  assert.equal(actual.statusCode, 200);
  const insights = actual.body.insights;
  assert.equal(insights.choices.executed, 1, 'the origin=auto filter keeps only the auto start');
  assert.equal(insights.choices.auto, 1);
  assert.equal(insights.choices.manifest, undefined);
  assert.equal(insights.choices.proposals, 3);
  assert.equal(insights.choices.diagnosticPicks, 2);
  assert.equal(insights.filters.scope, 'own');
  assert.equal(insights.choices.groups[0].key, 'sdk/composer-2');
  assert.equal(insights.choices.groups[0].count, undefined);
  assert.equal(insights.choices.groups[0].executed, 1);
});

test('insights exposes coverage and signals even with no delegation rows', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  const actual = await callRoute('GET', '/api/usage/insights', {
    ctx: { dataDir, loadDelegations: () => [], loadModelPickRecords: () => ({}) },
    query: { range: '7d', tz: 'UTC' },
  });
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.insights.choices.proposals, 0);
  assert.equal(actual.body.insights.choices.diagnosticPicks, 0);
  assert.equal(actual.body.insights.coverage.endedWithUsage.ratio, null);
  assert.equal(actual.body.insights.signals.acceptedByReview.denominator, 0);
  assert.equal(typeof actual.body.window, 'object');
});

test('changing the window moves executed choices and every cycle signal together', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-insights-'));
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  const rows = [
    {
      id: 'i1', parentChatId: 'c1', leafId: 'l1',
      pickId: 'p1', pickOrigin: 'auto', pickRole: 'implement',
      executor: { transport: 'sdk', model: 'composer-2' },
      status: 'completed', taskOutcome: 'success',
      createdAt: '2026-08-10T00:00:00.000Z', finishedAt: '2026-08-10T00:10:00.000Z',
      acknowledgedAt: '2026-08-10T01:00:00.000Z', acknowledgedReason: 'accepted',
    },
    {
      id: 'r1', parentChatId: 'c1', leafId: 'l1',
      pickId: 'p2', pickOrigin: 'auto', pickRole: 'review',
      executor: { transport: 'sdk', model: 'reviewer' },
      status: 'completed', taskOutcome: 'success', report: 'VERDICT: PASS',
      createdAt: '2026-08-10T00:20:00.000Z', finishedAt: '2026-08-10T00:30:00.000Z',
    },
    {
      id: 'i2', parentChatId: 'c2', leafId: 'l2',
      pickId: 'p3', pickOrigin: 'auto', pickRole: 'implement',
      executor: { transport: 'claude', model: 'opus' },
      status: 'completed', taskOutcome: 'success',
      createdAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:10:00.000Z',
    },
  ];
  const ctx = {
    dataDir,
    now,
    loadDelegations: () => rows,
    loadModelPickRecords: () => ({ p1: {}, p2: {}, p3: {} }),
  };
  const narrow = await callRoute('GET', '/api/usage/insights', {
    ctx,
    query: { range: '7d', tz: 'UTC' },
  });
  const wide = await callRoute('GET', '/api/usage/insights', {
    ctx,
    query: { from: '2026-06-01', to: '2026-08-15', tz: 'UTC' },
  });
  assert.equal(narrow.statusCode, 200);
  assert.equal(wide.statusCode, 200);
  const a = narrow.body.insights;
  const b = wide.body.insights;
  // Narrow window: only the first implement + review cycle is inside.
  assert.equal(a.choices.executed, 2);
  assert.equal(a.signals.technicalSuccess.n, 1);
  assert.equal(a.signals.technicalSuccess.denominator, 1);
  assert.equal(a.signals.acceptedByReview.n, 1);
  assert.equal(a.signals.acceptedByReview.denominator, 1);
  assert.equal(a.signals.manualAccepted.n, 1);
  assert.equal(a.signals.manualAccepted.denominator, 1);
  assert.equal(a.signals.reviewVerdicts.pass, 1);
  assert.equal(a.signals.reviewVerdicts.n, 1);
  // Wide window adds the second implement cycle, so every signal (not just the
  // executed count) moves to the same larger cohort.
  assert.equal(b.choices.executed, 3);
  assert.equal(b.signals.technicalSuccess.n, 2);
  assert.equal(b.signals.technicalSuccess.denominator, 2);
  assert.equal(b.signals.acceptedByReview.n, 1);
  assert.equal(b.signals.acceptedByReview.denominator, 2);
  assert.equal(b.signals.manualAccepted.n, 1);
  assert.equal(b.signals.manualAccepted.denominator, 2);
  assert.equal(b.signals.reviewVerdicts.pass, 1);
  assert.equal(b.signals.reviewVerdicts.undecided, 1);
  assert.equal(b.signals.reviewVerdicts.n, 2);
});
