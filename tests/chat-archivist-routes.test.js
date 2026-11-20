import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerChatArchivistRoutes } from '../lib/routes/chat-archivist-routes.js';

function setup() {
  const routes = new Map();
  const calls = [];
  const app = { get: (url, fn) => routes.set(url, fn), post: (url, fn) => routes.set(url, fn) };
  const service = Object.fromEntries(['report', 'assess', 'archive', 'restore'].map((key) => [key, async (...args) => { calls.push([key, ...args]); return {}; }]));
  registerChatArchivistRoutes(app, { service });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { routes, calls, res };
}
test('archivist denies widget and integration access without reading data', async () => {
  for (const request of [{ widgetAccess: {} }, { mcpIntegration: {} }]) {
    const { routes, calls, res } = setup();
    for (const handler of routes.values()) await handler(request, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(calls, []);
  }
});
test('archive requires explicit confirmation and assessment identifier', async () => {
  const { routes, calls, res } = setup();
  const fn = routes.get('/api/chat-archivist/archive');
  await fn({ body: { assessmentId: 'a' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
  await fn({ body: { confirm: true, assessmentId: 'a' } }, res);
  assert.deepEqual(calls, [['archive', 'a']]);
});
test('assessment validates idle days before invoking the model', async () => {
  for (const idleDays of [0, -1, 1.5, 3651, 'bad']) {
    const { routes, calls, res } = setup();
    await routes.get('/api/chat-archivist/assess')({ body: { chatId: 'a', idleDays } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(calls, []);
  }
});
