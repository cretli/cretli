import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSession, getCsrfTokenForSessionToken, requireAuth, setPassword } from '../lib/auth.js';
import { registerOperatorInternalRoutes } from '../lib/routes/operator-internal-routes.js';
import { claimRunSlot, claimPendingEvents, openOperatorStore } from '../lib/operator/operator-internal-store.js';
import { ingestOperatorEvents } from '../lib/operator/operator-event-ingest.js';
import { recordOperatorEvent } from '../lib/persist/operator-journal-persist.js';
import { createOperatorScheduler } from '../lib/operator/operator-scheduler.js';
import { interruptRunForDeletedChat, OPERATOR_TEST_EVENTS_PER_HOUR } from '../lib/operator/operator-owner.js';
import { assertChatArchiveAllowed } from '../lib/chat-archive-guard.js';
import { isChatArchivable } from './helpers/operator-owner-archivable.js';

setPassword('test-password-123');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-operator-owner-'));
const WS = '/tmp/operator-owner-ws';

async function serve({ pre = [], enabled = true, registered = [WS] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const rows = new Map();
  const notices = [];
  const chatDeps = {
    getChatById: async (id) => rows.get(id) || null,
    loadChats: async () => [...rows.values()],
    addChat: async (_s, title, _f, folder, _m, extras) => { const row = { id: extras.id, title, workspaceFolder: folder, ...extras }; rows.set(row.id, row); return row; },
    appendNotice: async (id, text, meta) => { notices.push({ id, text, meta }); },
  };
  const app = express();
  app.use(express.json());
  for (const middleware of pre) app.use(middleware);
  // The real global gate: cookie session + CSRF on mutating calls.
  app.use(requireAuth);
  registerOperatorInternalRoutes(app, {
    dataDir,
    getCurrentCwd: () => WS,
    ownerOptions: {
      settings: { operatorInternal: { enabled } },
      chatDeps,
      deps: { isRegisteredWorkspace: (folder) => registered.includes(folder) },
    },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { body, session, csrf = true, headers: extra = {} } = {}) => {
    const headers = { 'content-type': 'application/json', ...extra };
    if (session) {
      headers.cookie = `cr_session=${session}`;
      if (csrf) headers['x-cretli-csrf'] = getCsrfTokenForSessionToken(session);
    }
    const res = await fetch(`${base}/api/operator/internal${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const q = (sql, ...a) => { const db = openOperatorStore({ dataDir }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
  return { dataDir, rows, notices, call, q, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('every route is human-only: no session, agent session, MCP and widget callers get 403', async () => {
  const human = createSession();
  const agent = createSession({ agentSession: true });
  const preview = createSession({ browserPreview: true });
  const mcp = await serve({ pre: [(req, _res, next) => { if (req.headers['x-test-mcp']) req.mcpIntegration = { chatId: 'c' }; next(); }] });
  const widget = await serve({ pre: [(req, _res, next) => { req.widgetAccess = true; next(); }] });
  const plain = await serve();
  try {
    const routes = [['GET', '/status'], ['POST', '/message', { text: 'hi' }], ['POST', '/pause'], ['POST', '/resume'], ['POST', '/test-event', { workspaceFolder: WS }]];
    for (const [method, route, body] of routes) {
      // No cookie: the global gate answers 401, never reaching the route.
      assert.equal((await plain.call(method, route, { body })).status, 401, `${method} ${route} anonymous`);
      const asAgent = await plain.call(method, route, { body, session: agent });
      assert.equal(asAgent.status, 403, `${method} ${route} agent session`);
      assert.equal(asAgent.body.error, 'operator_human_only');
      const asPreview = await plain.call(method, route, { body, session: preview });
      assert.equal(asPreview.status, 403, `${method} ${route} browser preview`);
      assert.equal(asPreview.body.error, 'operator_human_only');
      assert.equal((await widget.call(method, route, { body, session: human })).status, 403, `${method} ${route} widget`);
    }
    // MCP integration marker on an otherwise valid human session.
    for (const [method, route, body] of routes) {
      assert.equal((await mcp.call(method, route, { body, session: human, headers: { 'x-test-mcp': '1' } })).status, 403, `${method} ${route} mcp`);
    }
    assert.equal((await plain.call('GET', '/status', { session: human })).status, 200);
  } finally { await Promise.all([mcp.close(), widget.close(), plain.close()]); }
});

test('mutating routes need the CSRF token', async () => {
  const human = createSession();
  const s = await serve();
  try {
    for (const [route, body] of [['/message', { text: 'hi' }], ['/pause'], ['/resume'], ['/test-event', { workspaceFolder: WS }]]) {
      const res = await s.call('POST', route, { body, session: human, csrf: false });
      assert.ok([401, 403].includes(res.status), `${route} without CSRF -> ${res.status}`);
    }
    assert.equal(s.q('SELECT COUNT(*) AS n FROM operator_events')[0].n, 0);
    assert.equal(s.q('SELECT COUNT(*) AS n FROM operator_owner_messages')[0].n, 0);
  } finally { await s.close(); }
});

test('owner message: stored, shown in the thread, queued as an owner_message event; validation and disabled state', async () => {
  const human = createSession();
  const s = await serve();
  const off = await serve({ enabled: false });
  try {
    assert.equal((await s.call('POST', '/message', { body: { text: '   ' }, session: human })).body.error, 'text_required');
    assert.equal((await s.call('POST', '/message', { body: { text: 'x'.repeat(4001) }, session: human })).body.error, 'text_too_long');
    const ok = await s.call('POST', '/message', { body: { text: 'Check the watcher', source: 'voice' }, session: human });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.source, 'voice');
    assert.equal(s.q("SELECT text, direction FROM operator_owner_messages")[0].direction, 'owner');
    assert.equal(s.q("SELECT kind FROM operator_events")[0].kind, 'owner_message');
    assert.equal(s.notices.at(-1).text, 'Check the watcher');
    assert.equal([...s.rows.values()][0].operatorChat, true);
    const off1 = await off.call('POST', '/message', { body: { text: 'hello' }, session: human });
    assert.equal(off1.status, 409);
    assert.equal(off1.body.error, 'operator_disabled');
  } finally { await s.close(); await off.close(); }
});

test('status chip states and pause/resume (resume also clears the breaker)', async () => {
  const human = createSession();
  const s = await serve();
  const off = await serve({ enabled: false });
  try {
    assert.equal((await off.call('GET', '/status', { session: human })).body.state, 'off');
    assert.equal((await s.call('GET', '/status', { session: human })).body.state, 'idle');
    recordOperatorEvent(WS, 'review_failed', 'review_failed: leaf l1, x', { dataDir: s.dataDir });
    ingestOperatorEvents({ dataDir: s.dataDir });
    const queued = (await s.call('GET', '/status', { session: human })).body;
    assert.equal(queued.state, 'queued');
    assert.equal(queued.queued, 1);
    await s.call('POST', '/pause', { session: human });
    assert.equal((await s.call('GET', '/status', { session: human })).body.state, 'paused');
    const db = openOperatorStore({ dataDir: s.dataDir });
    db.prepare("INSERT INTO operator_meta(key, value) VALUES ('breaker_paused_at', 'x') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    db.close();
    await s.call('POST', '/resume', { session: human });
    const after = (await s.call('GET', '/status', { session: human })).body;
    assert.equal(after.state, 'queued');
    assert.equal(after.breaker.paused, false);
  } finally { await s.close(); await off.close(); }
});

test('test-event: operator_test only, enabled, registered workspace, 10 per hour, loopback', async () => {
  const human = createSession();
  const s = await serve();
  const off = await serve({ enabled: false });
  try {
    assert.equal((await off.call('POST', '/test-event', { body: { workspaceFolder: WS }, session: human })).body.error, 'operator_disabled');
    assert.equal((await s.call('POST', '/test-event', { body: {}, session: human })).body.error, 'workspaceFolder_required');
    const foreign = await s.call('POST', '/test-event', { body: { workspaceFolder: '/etc' }, session: human });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, 'workspace_not_registered');
    // A caller-chosen kind is ignored: the route has no `kind` input.
    const ok = await s.call('POST', '/test-event', { body: { workspaceFolder: WS, kind: 'owner_message' }, session: human });
    assert.equal(ok.status, 200);
    assert.deepEqual(s.q('SELECT kind FROM operator_events').map((r) => r.kind), ['operator_test']);
    for (let i = 1; i < OPERATOR_TEST_EVENTS_PER_HOUR; i += 1) assert.equal((await s.call('POST', '/test-event', { body: { workspaceFolder: WS }, session: human })).status, 200);
    const limited = await s.call('POST', '/test-event', { body: { workspaceFolder: WS }, session: human });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'test_event_rate_limited');
    assert.equal(s.q("SELECT COUNT(*) AS n FROM operator_events WHERE kind='operator_test'")[0].n, OPERATOR_TEST_EVENTS_PER_HOUR);
  } finally { await s.close(); await off.close(); }
});

test('test-event is refused for a non-loopback peer', async () => {
  const human = createSession();
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const app = express();
  app.use(express.json());
  registerOperatorInternalRoutes(app, { dataDir, isHuman: () => true, isLocal: () => false, ownerOptions: { settings: { operatorInternal: { enabled: true } }, deps: { isRegisteredWorkspace: () => true } } });
  const server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/operator/internal/test-event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceFolder: WS }) });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'operator_test_local_only');
    void human;
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('the operator thread cannot be archived; other chats can; auto-archive skips it', () => {
  const chats = [{ id: 'op', operatorChat: true }, { id: 'other' }];
  assert.throws(() => assertChatArchiveAllowed(chats, 'op'), (error) => error.code === 'operator_chat_pinned');
  assert.doesNotThrow(() => assertChatArchiveAllowed(chats, 'other'));
  assert.equal(isChatArchivable({ id: 'op', operatorChat: true, updatedAt: '2020-01-01T00:00:00Z' }), false);
  assert.equal(isChatArchivable({ id: 'x', updatedAt: '2020-01-01T00:00:00Z' }), true);
});

test('deleting a running run chat interrupts the run once and frees the slot; no breaker count', async () => {
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const now = Date.now();
  recordOperatorEvent(WS, 'review_failed', 'review_failed: leaf l1, x', { dataDir, now });
  ingestOperatorEvents({ dataDir, now });
  const claim = claimRunSlot({ dataDir, now }, { ownerInstanceId: 'i1', workspace: WS, triggerKind: 'review_failed' });
  claimPendingEvents({ dataDir, now }, { runId: claim.runId, ownerInstanceId: 'i1', workspace: WS, limit: 5 });
  const db = openOperatorStore({ dataDir });
  db.prepare('UPDATE operator_runs SET chat_id=? WHERE id=?').run('run-chat', claim.runId);
  db.close();
  assert.deepEqual(interruptRunForDeletedChat('someone-else', { dataDir }), { interrupted: false, runId: '' });
  assert.deepEqual(interruptRunForDeletedChat('run-chat', { dataDir }), { interrupted: true, runId: claim.runId });
  const check = openOperatorStore({ dataDir });
  try {
    const run = check.prepare('SELECT state, failure_reason FROM operator_runs WHERE id=?').get(claim.runId);
    assert.equal(run.state, 'interrupted');
    assert.equal(run.failure_reason, 'chat_deleted');
    assert.equal(check.prepare("SELECT state FROM operator_internal_queue").get().state, 'pending');
    assert.equal(check.prepare("SELECT value FROM operator_meta WHERE key='breaker_failures'").get(), undefined);
  } finally { check.close(); }
  assert.equal(interruptRunForDeletedChat('run-chat', { dataDir }).interrupted, false);
});

test('scheduler: a run whose chat vanished is interrupted (not missing_report) and does not trip the breaker', async () => {
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  let nowMs = Date.parse('2026-11-11T10:00:00.000Z');
  const rows = new Map();
  const chatDeps = {
    getChatById: async (id) => rows.get(id) || null,
    loadChats: async () => [...rows.values()],
    addChat: async (_s, title, _f, folder, _m, extras) => { const row = { id: extras.id, title, workspaceFolder: folder, ...extras }; rows.set(row.id, row); return row; },
  };
  const scheduler = createOperatorScheduler({
    dataDir, settings: { enabled: true, coalesceMs: 0 }, now: () => nowMs, logger: { warn() {}, error() {} }, idleGraceMs: 1000,
    deps: {
      chatDeps,
      pickExecutor: async () => ({ harness: 'claude', model: 'm1' }),
      addChat: async (_s, title, _f, folder, _m, extras) => ({ id: extras.id, title, workspaceFolder: folder, ...extras }),
      startChatRun: async () => ({ accepted: true }),
      cancelRun: async () => {},
      probeLiveness: async () => ({ known: false, busy: false, reason: 'chat_missing' }),
      measureTokens: async () => 0,
      appendNotice: async () => {},
      readWorkspaceState: async () => 'state',
    },
  });
  recordOperatorEvent(WS, 'review_failed', 'review_failed: leaf l1, x', { dataDir, now: nowMs });
  const started = await scheduler.tick();
  assert.equal(started.started, true);
  nowMs += 100;
  await scheduler.tick();
  const db = openOperatorStore({ dataDir });
  try {
    const run = db.prepare('SELECT state, failure_reason FROM operator_runs').get();
    assert.equal(run.state, 'interrupted');
    assert.equal(run.failure_reason, 'chat_deleted');
    assert.equal(db.prepare("SELECT value FROM operator_meta WHERE key='breaker_failures'").get()?.value ?? '0', '0');
  } finally { db.close(); }
});

test('scheduler: owner pause holds event runs but lets an owner message through', async () => {
  const { setOwnerPause } = await import('../lib/operator/operator-owner.js');
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const nowMs = Date.parse('2026-11-11T10:00:00.000Z');
  const rows = new Map();
  const scheduler = createOperatorScheduler({
    dataDir, settings: { enabled: true, coalesceMs: 0 }, now: () => nowMs, logger: { warn() {}, error() {} },
    deps: {
      chatDeps: { getChatById: async (id) => rows.get(id) || null, loadChats: async () => [...rows.values()], addChat: async (_s, title, _f, folder, _m, extras) => { const row = { id: extras.id, title, workspaceFolder: folder, ...extras }; rows.set(row.id, row); return row; } },
      pickExecutor: async () => ({ harness: 'claude', model: 'm1' }),
      addChat: async (_s, title, _f, folder, _m, extras) => ({ id: extras.id, title, workspaceFolder: folder, ...extras }),
      startChatRun: async () => ({ accepted: true }),
      cancelRun: async () => {}, probeLiveness: async () => ({ known: true, busy: true, reason: '' }),
      measureTokens: async () => 0, appendNotice: async () => {}, readWorkspaceState: async () => 'state',
    },
  });
  setOwnerPause(true, { dataDir, now: nowMs });
  recordOperatorEvent(WS, 'review_failed', 'review_failed: leaf l1, x', { dataDir, now: nowMs });
  assert.equal((await scheduler.tick()).skipped, 'owner_paused');
  recordOperatorEvent(WS, 'owner_message', 'owner_message: ui message m1', { dataDir, now: nowMs });
  assert.equal((await scheduler.tick()).started, true);
});

test('chat_archive / chat_delete refuse the operator thread (agent session) without touching the chat', async () => {
  const { CHAT_MCP_TOOLS } = await import('../lib/mcp/builtin/chat-tools.js');
  const calls = [];
  const chat = { id: '5b1e1d6e-0f5e-4b6f-9a55-2d1a3b7c9e10', title: 'Operator', operatorChat: true, workspaceFolder: WS };
  const client = {
    listChats: async () => [chat],
    archiveChat: async (...a) => { calls.push(['archive', ...a]); },
    deleteChat: async (...a) => { calls.push(['delete', ...a]); },
  };
  const session = { workspaceFolder: WS, chatId: 'agent-chat' };
  for (const [name, args] of [['chat_archive', { chat: chat.id, scope: 'all' }], ['chat_delete', { chat: chat.id, confirm: true, scope: 'all' }]]) {
    const tool = CHAT_MCP_TOOLS.find((item) => item.name === name);
    await assert.rejects(() => tool.handler(args, { client, session }), /operator_chat_pinned/);
  }
  assert.deepEqual(calls, []);
});


test('HTTP DELETE rejects browser preview and agent sessions before deleting the operator thread', async () => {
  const { registerChatsRoutes } = await import('../lib/routes/chats-routes.js');
  const { addChatAsync, getChatByIdAsync } = await import('../lib/persist/chats-persist.js');
  const { useChatsBackendFromEnv } = await import('./helpers/chats-backends.js');
  await useChatsBackendFromEnv();
  const chat = await addChatAsync('operator-owner', 'Operator', undefined, WS, undefined, { operatorChat: true });
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerChatsRoutes(app, {});
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    for (const options of [{ browserPreview: true }, { agentSession: true }]) {
      const session = createSession(options);
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chats/${chat.id}`, {
        method: 'DELETE',
        headers: { cookie: `cr_session=${session}`, 'x-cretli-csrf': getCsrfTokenForSessionToken(session) },
      });
      assert.equal(res.status, 403, JSON.stringify(options));
      assert.equal((await res.json()).code, 'operator_chat_pinned');
      assert.equal((await getChatByIdAsync(chat.id)).operatorChat, true);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
