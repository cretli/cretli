import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { recordOperatorEventSafe } from '../lib/persist/operator-journal-persist.js';
import { addTodo } from '../lib/persist/todos-legacy-adapter.js';
import { requireAuth } from '../lib/auth.js';
import { registerOperatorEventsRoutes } from '../lib/routes/operator-events-routes.js';
import { syncTodoReviewTarget } from '../lib/todo-review-sync-hooks.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-operator-events-routes-'));

async function serve(ctx = {}, pre = []) {
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const cwd = fs.mkdtempSync(path.join(root, 'ws-'));
  const app = express();
  for (const middleware of pre) app.use(middleware);
  registerOperatorEventsRoutes(app, { dataDir, getCurrentCwd: () => cwd, ...ctx });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (query) => {
    const res = await fetch(`${base}/api/operator/events?${new URLSearchParams(query)}`);
    return { status: res.status, body: await res.json() };
  };
  return { dataDir, cwd, get, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('since cursor and type filter', async () => {
  const s = await serve();
  try {
    const opts = { dataDir: s.dataDir };
    recordOperatorEventSafe(s.cwd, 'review_failed', 'review_failed: leaf a, x', opts);
    recordOperatorEventSafe(s.cwd, 'integration_ready', 'integration_ready: leaf b, y', opts);
    recordOperatorEventSafe(s.cwd, 'review_failed', 'review_failed: leaf c, z', opts);
    const all = await s.get({ since: '0', wait: '0' });
    assert.deepEqual(all.body.events.map((e) => e.kind), ['review_failed', 'integration_ready', 'review_failed']);
    const filtered = await s.get({ since: '0', types: 'review_failed', wait: '0' });
    assert.equal(filtered.body.events.length, 2);
    // The cursor moves past events the filter skipped.
    const afterFirst = await s.get({ since: String(all.body.events[0].cursor), types: 'integration_ready,review_failed', wait: '0' });
    assert.deepEqual(afterFirst.body.events.map((e) => e.kind), ['integration_ready', 'review_failed']);
    const rest = await s.get({ since: String(all.body.cursor), wait: '0' });
    assert.deepEqual(rest.body.events, []);
    assert.equal(rest.body.cursor, all.body.cursor);
    // Without `since` the head cursor is handed out and nothing is replayed.
    const first = await s.get({ wait: '0' });
    assert.deepEqual(first.body.events, []);
    assert.equal(first.body.cursor, all.body.cursor);
    for (const bad of ['abc', '-1', '1.5', '1e3', ' 2', '99999999999999999999', '']) {
      assert.equal((await s.get({ since: bad, wait: '0' })).status, 400, `since=${bad}`);
    }
    for (const bad of ['0', '501', '-5', '2.5', 'x', '']) {
      assert.equal((await s.get({ since: '0', limit: bad, wait: '0' })).status, 400, `limit=${bad}`);
    }
    assert.equal((await s.get({ since: '0', limit: '2', wait: '0' })).body.events.length, 2);
    // A cursor beyond the head is echoed back: it never moves backwards.
    const ahead = await s.get({ since: String(all.body.cursor + 50), wait: '0' });
    assert.equal(ahead.status, 200);
    assert.deepEqual(ahead.body.events, []);
    assert.equal(ahead.body.cursor, all.body.cursor + 50);
  } finally { await s.close(); }
});

test('refuses unauthenticated, restricted and non-local callers', async () => {
  const unauth = await serve({}, [requireAuth]);
  try { assert.equal((await unauth.get({ since: '0' })).status, 401); } finally { await unauth.close(); }
  const widget = await serve({}, [(req, _res, next) => { req.widgetAccess = { id: 'w' }; next(); }]);
  try { assert.equal((await widget.get({ since: '0' })).status, 403); } finally { await widget.close(); }
  const remote = await serve({ isLocal: () => false });
  try { assert.equal((await remote.get({ since: '0' })).status, 403); } finally { await remote.close(); }
});

test('a long-poll client wakes on review_failed produced by a real review sync', async () => {
  const s = await serve({ pollMs: 5000 });
  try {
    const todo = addTodo(s.dataDir, s.cwd, { title: 'leaf', status: 'doing' }).item;
    const head = (await s.get({ wait: '0' })).body.cursor;
    const started = Date.now();
    const waiting = s.get({ since: String(head), types: 'review_failed', wait: '10000' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await syncTodoReviewTarget({ dataDir: s.dataDir, workspaceFolder: s.cwd, todoId: todo.id }, { env: {}, deps: {
      readTodo: async () => ({ id: todo.id, updatedAt: 'x', review: { generation: 0 } }),
      computeSnapshot: async () => ({ code: { state: 'failed', stateReason: 'review_failed' } }),
      writeReview: async () => ({ changed: true, generation: 1 }),
    } });
    const { body } = await waiting;
    assert.equal(body.waited, true);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].kind, 'review_failed');
    assert.ok(Date.now() - started < 4000, 'woke on the write, not on the poll timer or deadline');
  } finally { await s.close(); }
});

test('a long-poll with no event returns empty at its deadline', async () => {
  const s = await serve({ maxWaitMs: 300, pollMs: 100 });
  try {
    const { body } = await s.get({ since: '0', wait: '5000' });
    assert.deepEqual(body.events, []);
    assert.equal(body.waited, true);
  } finally { await s.close(); }
});
