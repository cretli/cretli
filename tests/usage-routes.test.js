import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';

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
 * @param {string} path
 * @param {{ body?: object, query?: object, dataDir: string }} input
 */
async function callRoute(method, path, input) {
  const app = createFakeApp();
  registerUsageRoutes(app, { dataDir: input.dataDir });
  const handler = app.routes.get(`${method} ${path}`);
  assert.ok(handler, `${method} ${path} must be registered`);
  const res = createFakeResponse();
  await handler({ body: input.body || {}, query: input.query || {} }, res);
  return res;
}

test('empty ledger summary is zero', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  const actual = await callRoute('GET', '/api/usage/summary', { dataDir });
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.ok, true);
  assert.equal(actual.body.summary.totalUsd, 0);
});

test('client realtime usage is priced on the server', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  const actual = await callRoute('POST', '/api/usage/events', {
    dataDir,
    body: {
      provider: 'openai',
      feature: 'voice-live',
      model: 'gpt-realtime-2.1',
      usage: {
        input_token_details: { audio_tokens: 1_000_000, text_tokens: 0, cached_tokens: 0 },
        output_token_details: { audio_tokens: 0, text_tokens: 0 },
      },
    },
  });
  assert.equal(actual.body.ok, true);
  assert.equal(actual.body.event.usd, 32);
  assert.equal(actual.body.event.source, undefined);
});

test('rejects a client-supplied usd', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  const actual = await callRoute('POST', '/api/usage/events', {
    dataDir,
    body: { provider: 'openai', usd: 999, usage: {} },
  });
  assert.equal(actual.statusCode, 400);
});

test('rejects a missing provider', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  const actual = await callRoute('POST', '/api/usage/events', {
    dataDir,
    body: { usage: {} },
  });
  assert.equal(actual.statusCode, 400);
});

test('summary enforces the 92-day range and validates dates', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  const tooLong = await callRoute('GET', '/api/usage/summary', {
    dataDir,
    query: { from: '2025-01-01', to: '2026-12-31' },
  });
  assert.equal(tooLong.statusCode, 400);

  const badDate = await callRoute('GET', '/api/usage/summary', {
    dataDir,
    query: { from: '2026-02-31', to: '2026-03-01' },
  });
  assert.equal(badDate.statusCode, 400);

  const ok = await callRoute('GET', '/api/usage/summary', {
    dataDir,
    query: { from: '2026-08-01', to: '2026-08-28' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.from, '2026-08-01');
  assert.equal(ok.body.to, '2026-08-28');
});

test('claude subscription usage stays unpriced in the summary', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  recordUsage(
    {
      provider: 'other',
      harness: 'claude',
      feature: 'chat',
      model: 'claude-sonnet-4-5',
      billingMode: 'subscription',
      tokens: { textInput: 1000 },
      at: '2026-08-28T10:00:00.000Z',
    },
    { dataDir }
  );
  const actual = await callRoute('GET', '/api/usage/summary', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-28' },
  });
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.summary.totalUsd, 0);
  assert.equal(actual.body.summary.unpricedEvents, 1);
});

test('summary keeps legacy keys and adds harness/model/role groups', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  recordUsage(
    {
      provider: 'cursor',
      feature: 'chat',
      harness: 'sdk',
      role: 'implement',
      model: 'composer-2',
      tokens: { textInput: 1000 },
      at: '2026-08-28T10:00:00.000Z',
    },
    { dataDir }
  );
  recordUsage(
    {
      provider: 'cursor',
      feature: 'chat',
      harness: 'sdk',
      role: 'implement',
      model: 'composer-2',
      eventType: 'run',
      outcome: 'ok',
      latencyMs: 120,
      at: '2026-08-28T10:05:00.000Z',
    },
    { dataDir }
  );
  const actual = await callRoute('GET', '/api/usage/summary', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-28' },
  });
  assert.equal(actual.statusCode, 200);
  const summary = actual.body.summary;
  assert.equal(summary.byProvider.cursor.events, 1);
  assert.equal(summary.byHarness.sdk.events, 1);
  assert.equal(summary.byHarness.sdk.runs, 1);
  assert.equal(summary.byModel['composer-2'].tokens.textInput, 1000);
  assert.equal(summary.byRole.implement.runs, 1);
  assert.equal(summary.runs, 1);
  assert.equal(summary.successRate, 1);
  assert.equal(summary.p50LatencyMs, 120);
});

test('timeseries endpoint groups by day/model and validates params', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  recordUsage(
    { provider: 'google', feature: 'voice-live', model: 'gemini', tokens: { audioInput: 1_000_000 }, at: '2026-08-28T10:00:00.000Z' },
    { dataDir }
  );
  recordUsage(
    { provider: 'google', feature: 'voice-live', model: 'gemini', tokens: { audioInput: 1_000_000 }, at: '2026-08-29T11:00:00.000Z' },
    { dataDir }
  );
  const actual = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-29', bucket: 'day', groupBy: 'model', metric: 'tokens' },
  });
  assert.equal(actual.statusCode, 200);
  assert.deepEqual(actual.body.buckets, ['2026-08-28', '2026-08-29']);
  assert.deepEqual(actual.body.series, [{ group: 'gemini', values: [1_000_000, 1_000_000] }]);

  const badBucket = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-29', bucket: 'minute' },
  });
  assert.equal(badBucket.statusCode, 400);

  const badGroup = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-29', groupBy: 'provider' },
  });
  assert.equal(badGroup.statusCode, 400);

  const badMetric = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-29', metric: 'latency' },
  });
  assert.equal(badMetric.statusCode, 400);

  const tooLong = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-01-01', to: '2026-12-31' },
  });
  assert.equal(tooLong.statusCode, 400);

  const reversed = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-08-29', to: '2026-08-28' },
  });
  assert.equal(reversed.statusCode, 400);

  const badDate = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-02-31', to: '2026-03-01' },
  });
  assert.equal(badDate.statusCode, 400);
});

test('models endpoint ranks by tokens and rejects unknown metrics', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  recordUsage(
    { provider: 'cursor', harness: 'sdk', feature: 'chat', model: 'composer-2', tokens: { textInput: 500 }, at: '2026-08-28T10:00:00.000Z' },
    { dataDir }
  );
  recordUsage(
    { provider: 'openai', harness: 'codex', feature: 'chat', model: 'gpt-5-codex', tokens: { textInput: 100, textOutput: 50 }, at: '2026-08-28T11:00:00.000Z' },
    { dataDir }
  );
  const actual = await callRoute('GET', '/api/usage/models', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-28' },
  });
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.metric, 'tokens');
  assert.deepEqual(actual.body.models.map((row) => row.model), ['composer-2', 'gpt-5-codex']);
  assert.equal(actual.body.models[0].totalTokens, 500);
  assert.equal(actual.body.models[1].totalTokens, 150);

  const byUsd = await callRoute('GET', '/api/usage/models', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-28', metric: 'usd' },
  });
  assert.equal(byUsd.statusCode, 200);

  const bad = await callRoute('GET', '/api/usage/models', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-28', metric: 'latency' },
  });
  assert.equal(bad.statusCode, 400);
});

test('models endpoint exposes dominant harness and per-row p95 latency', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  recordUsage(
    { provider: 'other', harness: 'claude', feature: 'chat', model: 'claude-sonnet-4-5', tokens: { textInput: 100 }, at: '2026-08-28T10:00:00.000Z' },
    { dataDir }
  );
  recordUsage(
    { provider: 'other', harness: 'claude', feature: 'chat', model: 'claude-sonnet-4-5', eventType: 'run', outcome: 'ok', latencyMs: 420, at: '2026-08-28T10:01:00.000Z' },
    { dataDir }
  );
  recordUsage(
    { provider: 'cursor', harness: 'sdk', feature: 'chat', model: 'composer-2', tokens: { textInput: 50 }, at: '2026-08-28T10:02:00.000Z' },
    { dataDir }
  );
  const actual = await callRoute('GET', '/api/usage/models', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-28' },
  });
  assert.equal(actual.statusCode, 200);
  const claude = actual.body.models.find((row) => row.model === 'claude-sonnet-4-5');
  assert.equal(claude.harness, 'claude');
  assert.deepEqual(claude.harnesses, ['claude']);
  assert.equal(claude.p95LatencyMs, 420);
  assert.equal(claude.p50LatencyMs, 420);
  const composer = actual.body.models.find((row) => row.model === 'composer-2');
  assert.equal(composer.harness, 'sdk');
  assert.equal(composer.p95LatencyMs, null);
});

test('timeseries endpoint fills the requested range with empty buckets', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-api-'));
  recordUsage(
    { provider: 'google', feature: 'voice-live', model: 'gemini', tokens: { audioInput: 1_000_000 }, at: '2026-08-28T10:00:00.000Z' },
    { dataDir }
  );
  recordUsage(
    { provider: 'google', feature: 'voice-live', model: 'gemini', tokens: { audioInput: 1_000_000 }, at: '2026-08-31T11:00:00.000Z' },
    { dataDir }
  );
  const actual = await callRoute('GET', '/api/usage/timeseries', {
    dataDir,
    query: { from: '2026-08-28', to: '2026-08-31', bucket: 'day', groupBy: 'model', metric: 'tokens' },
  });
  assert.equal(actual.statusCode, 200);
  assert.deepEqual(actual.body.buckets, ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']);
  assert.deepEqual(actual.body.series, [{ group: 'gemini', values: [1_000_000, 0, 0, 1_000_000] }]);
});
