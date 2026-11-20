import assert from 'node:assert/strict';
import test from 'node:test';
import { registerChatRetentionRoutes } from '../lib/routes/chat-retention-routes.js';

function routeHandler(deps) {
  const routes = new Map();
  const app = { get() {}, patch() {}, post(path, handler) { routes.set(path, handler); } };
  registerChatRetentionRoutes(app, deps);
  return routes.get('/api/chat-retention/restore');
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('restore awaits successful async update', async () => {
  let finished = false;
  const handler = routeHandler({ retention: { updateChat: async () => { await Promise.resolve(); finished = true; return { id: 'c1' }; } } });
  const res = response();
  await handler({ body: { chatId: 'c1' } }, res);
  assert.equal(finished, true);
  assert.deepEqual(res.body, { ok: true, chatId: 'c1' });
});

test('restore maps not-found to 404', async () => {
  const handler = routeHandler({ retention: { updateChat: async () => null } });
  const res = response();
  await handler({ body: { chatId: 'missing' } }, res);
  assert.equal(res.statusCode, 404);
});

test('restore maps parent_archived rejection to conflict and reports other failures', async () => {
  const handler = routeHandler({ retention: { updateChat: async () => { throw Object.assign(new Error('parent is archived'), { code: 'parent_archived' }); } } });
  const conflict = response();
  await handler({ body: { chatId: 'child' } }, conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'parent_archived');

  const failing = routeHandler({ retention: { updateChat: async () => { throw new Error('store unavailable'); } } });
  const error = response();
  await failing({ body: { chatId: 'child' } }, error);
  assert.equal(error.statusCode, 500);
  assert.match(error.body.error, /store unavailable/);
});
