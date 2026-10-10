import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
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
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

/**
 * @param {string} method
 * @param {string} requestPath
 * @param {{ body?: object, dataDir: string, store: object, widgetAccess?: boolean }} input
 */
async function callRoute(method, requestPath, input) {
  const app = createFakeApp();
  registerUsageRoutes(app, {
    dataDir: input.dataDir,
    loadSettings: () => input.store,
    saveSettings: (next) => { input.store = next; },
  });
  const handler = app.routes.get(`${method} ${requestPath}`);
  assert.ok(handler, `${method} ${requestPath} must be registered`);
  const res = createFakeResponse();
  await handler({ body: input.body || {}, query: {}, widgetAccess: input.widgetAccess }, res);
  return res;
}

test('GET /api/usage/settings returns defaults and the directory size', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-settings-'));
  const usageDir = path.join(dataDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(path.join(usageDir, '2026-05-31.jsonl'), '{}\n', 'utf8');
  const store = {};
  const res = await callRoute('GET', '/api/usage/settings', { dataDir, store });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.settings.retentionDays, 90);
  assert.equal(res.body.settings.alerts.planLimit, false);
  assert.equal(res.body.storage.dayFiles, 1);
  assert.ok(res.body.storage.bytes > 0);
});

test('POST /api/usage/settings persists a partial patch', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-settings-'));
  const store = { usage: { retentionDays: 30, alerts: { lockout: true } } };
  const res = await callRoute('POST', '/api/usage/settings', {
    dataDir,
    store,
    body: { alerts: { planLimit: true, planLimitThresholdPercent: 75 } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.retentionDays, 30);
  assert.equal(res.body.settings.alerts.lockout, true);
  assert.equal(res.body.settings.alerts.planLimit, true);
  assert.equal(res.body.settings.alerts.planLimitThresholdPercent, 75);
  assert.equal(store.usage.alerts.planLimit, true);
});

test('POST /api/usage/settings accepts a nested usage patch and prunes on demand', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-settings-'));
  const usageDir = path.join(dataDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(path.join(usageDir, '2020-01-01.jsonl'), '{}\n', 'utf8');
  const store = {};
  const res = await callRoute('POST', '/api/usage/settings', {
    dataDir,
    store,
    body: { usage: { retentionDays: 30 }, pruneNow: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.retentionDays, 30);
  assert.deepEqual(res.body.pruned.deleted, ['2020-01-01.jsonl']);
  assert.equal(res.body.storage.dayFiles, 0);
});

test('usage settings routes reject widget access', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-settings-'));
  const store = {};
  const res = await callRoute('GET', '/api/usage/settings', { dataDir, store, widgetAccess: true });
  assert.equal(res.statusCode, 403);
});
