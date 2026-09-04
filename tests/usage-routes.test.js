import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';

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
