import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerChatArchivistRoutes } from '../lib/routes/chat-archivist-routes.js';

function setup() {
  const routes = new Map();
  const calls = [];
  const app = { get: (url, fn) => routes.set(url, fn), post: (url, fn) => routes.set(url, fn) };
  const service = Object.fromEntries(['report', 'assess', 'archive', 'archiveWithFollowups', 'restore'].map((key) => [key, async (...args) => { calls.push([key, ...args]); return {}; }]));
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

test('manual mode is forwarded and invalid mode is rejected', async () => {
  const { routes, calls, res } = setup();
  const handler = routes.get('/api/chat-archivist/assess');
  await handler({ body: { chatId: 'a', mode: 'manual' } }, res);
  assert.deepEqual(calls, [['assess', 'a', { mode: 'manual', idleDays: 7 }]]);
  for (const mode of ['invalid', null, 1]) {
    await handler({ body: { chatId: 'a', mode } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 1);
});
test('followups require confirmation and items; restore forwards followup ids', async () => {
  const { routes, calls, res } = setup();
  const handler = routes.get('/api/chat-archivist/archive-with-followups');
  for (const body of [{ assessmentId: 'a', items: [{}] }, { assessmentId: 'a', confirm: true, items: [] }]) {
    await handler({ body }, res);
    assert.equal(res.statusCode, 400);
  }
  const items = [{ index: 0, title: 'Task' }];
  await handler({ body: { assessmentId: 'a', confirm: true, items } }, res);
  await routes.get('/api/chat-archivist/restore')({ body: { actionId: 'followup-id' } }, res);
  assert.deepEqual(calls, [['archiveWithFollowups', 'a', items], ['restore', 'followup-id']]);
});
test('payload mismatch maps to 409 and failure includes partial action', async () => {
  const routes = new Map();
  registerChatArchivistRoutes({ get: (url, fn) => routes.set(url, fn), post: (url, fn) => routes.set(url, fn) }, {
    service: { archiveWithFollowups: async () => { throw Object.assign(new Error(), { code: 'followups_payload_mismatch', action: { todoIds: { 0: 'todo' } } }); } },
  });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await routes.get('/api/chat-archivist/archive-with-followups')({ body: { assessmentId: 'a', items: [{}], confirm: true } }, res);
  assert.equal(res.code, 409);
  assert.equal(res.body.code, 'followups_payload_mismatch');
  assert.equal(res.body.action.todoIds[0], 'todo');
});
