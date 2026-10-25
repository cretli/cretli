import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWakeupScheduler } from '../lib/wakeup-scheduler.js';
import { createConditionCheckKind } from '../lib/wakeup-condition-check.js';
import { createConditionCheckAnnouncers } from '../lib/wakeup-condition-check-notices.js';
import { createConditionCheckService } from '../lib/wakeup-condition-check-service.js';
import { composeAnnouncers } from '../lib/wakeup-announcers.js';
import { createResumeAnnouncers } from '../lib/usage-limit-resume-notices.js';
import { publishConditionCheckNotification } from '../lib/notifications/condition-check-producer.ts';
import { registerWakeupsRoutes } from '../lib/routes/wakeups-routes.js';
import { WAKEUP_KINDS } from '../lib/persist/wakeups-persist.js';

void ISOLATED_DATA_DIR;

const NOW = Date.parse('2026-03-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const row = (id, over = {}) => ({
  id,
  kind: 'condition_check',
  subjectType: 'todo',
  subjectId: 'todo-1',
  state: 'armed',
  reason: '',
  attempts: 0,
  pendingAttempt: 0,
  resumeRequestId: '',
  title: 'Measure coverage',
  predicate: { id: 'delegations_finished_since', params: { transport: 'codex', sinceMs: 0, minCount: 2 } },
  action: { type: 'start_todo_chat', todoId: 'todo-1', brief: 'Measure now.', workspaceFolder: '/ws' },
  createdAt: new Date(NOW - DAY).toISOString(),
  expiresAt: new Date(NOW + DAY).toISOString(),
  startedChatId: '',
  ...over,
});

const finished = (n, transport = 'codex') => Array.from({ length: n }, (_, i) => ({
  id: `d${i}`, executor: { transport }, finishedAt: new Date(NOW - i * 1000).toISOString(),
}));

function setup({ rows, delegations = finished(0), kindDeps = {}, settings = {}, announcers } = {}) {
  const store = { rows: rows.map((r) => ({ ...r })), patches: 0 };
  const calls = { startTodo: [], startRun: [], loads: 0 };
  const notices = [];
  const kind = createConditionCheckKind({
    loadDelegations: () => { calls.loads += 1; return typeof delegations === 'function' ? delegations() : delegations; },
    getLimit: () => null,
    startTodoAgent: async (input) => {
      calls.startTodo.push(input);
      return { chat: { id: `chat-${calls.startTodo.length}` }, initialPrompt: 'STANDARD PREAMBLE' };
    },
    startChatRun: async (input) => { calls.startRun.push(input); return { accepted: true, runId: 'r1' }; },
    lookupChatRunRequest: () => null,
    probeChatRunLiveness: () => ({ known: false }),
    patchRow: (id, fields) => {
      const target = store.rows.find((r) => r.id === id);
      Object.assign(target, fields);
      return { ...target };
    },
    readSettings: () => ({ enabled: true, maxPerTick: 2, harness: '', model: '', ...settings }),
    ...kindDeps,
  });
  const scheduler = createWakeupScheduler({
    now: () => NOW,
    store: {
      list: () => store.rows.map((r) => ({ ...r })),
      patch: (id, fields, _now, expectState) => {
        const target = store.rows.find((r) => r.id === id);
        if (!target || (expectState && target.state !== expectState)) return null;
        store.patches += 1;
        Object.assign(target, fields);
        return { ...target };
      },
    },
    ...(announcers || { notify: (n) => notices.push(n) }),
  });
  scheduler.registerKind(kind);
  return { scheduler, store, calls, notices, kind };
}

test('condition_check is a known wake-up kind', () => {
  assert.ok(WAKEUP_KINDS.includes('condition_check'));
});

test('not met: defers, no chat, no attempt consumed, progress kept in memory', async () => {
  const h = setup({ rows: [row('a')], delegations: finished(1) });
  await h.scheduler.tick({ now: NOW });
  assert.equal(h.calls.startTodo.length, 0);
  assert.equal(h.store.rows[0].state, 'armed');
  assert.equal(h.store.rows[0].attempts, 0);
  assert.equal(h.store.patches, 0);
  const progress = h.kind.getEvaluation('a');
  assert.deepEqual([progress.met, progress.current, progress.target], [false, 1, 2]);
});

test('met: exactly one fresh chat, brief + standard preamble, resumed keeps startedChatId', async () => {
  const h = setup({ rows: [row('a')], delegations: finished(3) });
  await h.scheduler.tick({ now: NOW });
  await h.scheduler.tick({ now: NOW + 60_000 });
  assert.equal(h.calls.startTodo.length, 1);
  assert.equal(h.calls.startTodo[0].body.forceNew, true);
  assert.equal(h.calls.startRun.length, 1);
  assert.equal(h.calls.startRun[0].requestId, 'condcheck:a:1');
  assert.match(h.calls.startRun[0].prompt, /^Measure now\.\n\nSTANDARD PREAMBLE$/);
  assert.equal(h.store.rows[0].state, 'resumed');
  assert.equal(h.store.rows[0].startedChatId, 'chat-1');
});

test('crash after persist-before-call: a stored chat id is resolved, never a second chat', async () => {
  const accepted = setup({
    rows: [row('a', { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: 'condcheck:a:1', startedChatId: 'chat-x' })],
    delegations: finished(5),
    kindDeps: { lookupChatRunRequest: () => ({ accepted: true }) },
  });
  await accepted.scheduler.tick({ now: NOW });
  assert.equal(accepted.store.rows[0].state, 'resumed');
  assert.equal(accepted.calls.startTodo.length, 0);
  assert.equal(accepted.calls.startRun.length, 0);

  const unknown = setup({
    rows: [row('b', { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: 'condcheck:b:1', startedChatId: '' })],
    delegations: finished(5),
  });
  await unknown.scheduler.tick({ now: NOW });
  assert.equal(unknown.store.rows[0].state, 'blocked');
  assert.equal(unknown.store.rows[0].reason, 'start_uncertain');
  assert.equal(unknown.calls.startTodo.length, 0);
});

test('refund (recipient_busy) re-arms and the retry reuses the stored chat', async () => {
  let busy = true;
  const h = setup({
    rows: [row('a')],
    delegations: finished(3),
    kindDeps: {
      startChatRun: async (input) => {
        if (busy) { busy = false; throw Object.assign(new Error('busy'), { code: 'recipient_busy' }); }
        return { accepted: true, runId: input.requestId };
      },
    },
  });
  await h.scheduler.tick({ now: NOW });
  assert.equal(h.store.rows[0].state, 'armed');
  assert.equal(h.store.rows[0].attempts, 0);
  assert.equal(h.store.rows[0].startedChatId, 'chat-1');
  await h.scheduler.tick({ now: NOW + 60_000 });
  assert.equal(h.store.rows[0].state, 'resumed');
  assert.equal(h.calls.startTodo.length, 1);
});

test('refund then retry: a different requestId, the same chat, no second chat', async () => {
  let busy = true;
  const requests = [];
  const h = setup({
    rows: [row('a')],
    delegations: finished(3),
    kindDeps: {
      startChatRun: async (input) => {
        requests.push({ chatId: input.chatId, requestId: input.requestId });
        if (busy) { busy = false; throw Object.assign(new Error('busy'), { code: 'recipient_busy' }); }
        return { accepted: true, runId: input.requestId };
      },
    },
  });
  await h.scheduler.tick({ now: NOW });
  await h.scheduler.tick({ now: NOW + 60_000 });
  assert.equal(h.calls.startTodo.length, 1);
  assert.deepEqual(requests.map((r) => r.requestId), ['condcheck:a:1', 'condcheck:a:1:r1']);
  assert.equal(new Set(requests.map((r) => r.chatId)).size, 1);
});

test('refusal classes: todo_not_found and chat_archived block, adapter_unavailable refunds', async () => {
  const notFound = setup({
    rows: [row('a')], delegations: finished(3),
    kindDeps: { startTodoAgent: async () => { throw { status: 404, key: 'todo.notFound' }; } },
  });
  await notFound.scheduler.tick({ now: NOW });
  assert.deepEqual([notFound.store.rows[0].state, notFound.store.rows[0].reason], ['blocked', 'todo_not_found']);

  const archived = setup({
    rows: [row('a')], delegations: finished(3),
    kindDeps: { startChatRun: async () => { throw Object.assign(new Error('x'), { code: 'chat_archived' }); } },
  });
  await archived.scheduler.tick({ now: NOW });
  assert.deepEqual([archived.store.rows[0].state, archived.store.rows[0].reason], ['blocked', 'chat_archived']);

  const adapter = setup({
    rows: [row('a')], delegations: finished(3),
    kindDeps: { startChatRun: async () => { throw Object.assign(new Error('x'), { code: 'adapter_unavailable' }); } },
  });
  await adapter.scheduler.tick({ now: NOW });
  assert.equal(adapter.store.rows[0].state, 'armed');
});

test('expiry: expired without evaluating or starting anything', async () => {
  const h = setup({ rows: [row('a', { expiresAt: new Date(NOW - 1).toISOString() })], delegations: finished(9) });
  await h.scheduler.tick({ now: NOW });
  assert.equal(h.store.rows[0].state, 'expired');
  assert.equal(h.calls.startTodo.length, 0);
  assert.equal(h.calls.loads, 0);
});

test('cancelled check never starts a chat', async () => {
  const h = setup({ rows: [row('a', { state: 'cancelled' })], delegations: finished(9) });
  await h.scheduler.tick({ now: NOW });
  assert.equal(h.calls.startTodo.length, 0);
});

test('unknown predicate blocks; invalid params defer with a reason', async () => {
  const unknown = setup({ rows: [row('a', { predicate: { id: 'nope', params: {} } })] });
  await unknown.scheduler.tick({ now: NOW });
  assert.deepEqual([unknown.store.rows[0].state, unknown.store.rows[0].reason], ['blocked', 'unknown_predicate']);
});

test('throwing predicate degrades to defer and never breaks the tick', async () => {
  const h = setup({ rows: [row('a'), row('b')], delegations: () => { throw new Error('journal down'); } });
  const out = await h.scheduler.tick({ now: NOW });
  assert.equal(out.resumed, 0);
  assert.deepEqual(h.store.rows.map((r) => r.state), ['armed', 'armed']);
  assert.match(h.kind.getEvaluation('a').error, /journal down/);
  const run = await h.scheduler.runNow('a');
  assert.equal(run.action, 'defer');
  assert.match(run.reason, /predicate_error: journal down/);
});

test('prepare/decide perform zero store writes (unmet, throwing, unknown-free ticks)', async () => {
  const unmet = setup({ rows: [row('a')], delegations: finished(1) });
  await unmet.scheduler.tick({ now: NOW });
  await unmet.scheduler.tick({ now: NOW + 1 });
  assert.equal(unmet.store.patches, 0);
  const throwing = setup({ rows: [row('a')], delegations: () => { throw new Error('x'); } });
  await throwing.scheduler.tick({ now: NOW });
  assert.equal(throwing.store.patches, 0);
});

test('runNow: unmet changes nothing; met starts once; non-armed is refused', async () => {
  let count = 1;
  const h = setup({ rows: [row('a'), row('c', { state: 'cancelled' })], delegations: () => finished(count) });
  const unmet = await h.scheduler.runNow('a');
  assert.deepEqual([unmet.ok, unmet.action, unmet.reason, unmet.started], [true, 'defer', 'not_met', false]);
  assert.equal(h.store.patches, 0);
  assert.equal(h.store.rows[0].state, 'armed');
  assert.deepEqual(await h.scheduler.runNow('c'), { ok: false, code: 'not_armed' });
  assert.deepEqual(await h.scheduler.runNow('zzz'), { ok: false, code: 'not_found' });
  count = 4;
  const met = await h.scheduler.runNow('a');
  assert.deepEqual([met.action, met.started], ['resume', true]);
  assert.equal(h.store.rows[0].state, 'resumed');
  assert.equal(h.calls.startTodo.length, 1);
  assert.deepEqual(await h.scheduler.runNow('a'), { ok: false, code: 'not_armed' });
});

test('disabled setting skips evaluation and execution', async () => {
  const h = setup({ rows: [row('a')], delegations: finished(9), settings: { enabled: false } });
  await h.scheduler.tick({ now: NOW });
  assert.equal(h.calls.startTodo.length, 0);
  assert.equal(h.calls.loads, 0);
  assert.equal(h.store.rows[0].state, 'armed');
});

test('harness lockout defers a met check', async () => {
  const h = setup({
    rows: [row('a')], delegations: finished(9), settings: { harness: 'codex' },
    kindDeps: { getLimit: () => ({ resetAt: 'later' }) },
  });
  await h.scheduler.tick({ now: NOW });
  assert.equal(h.calls.startTodo.length, 0);
  assert.equal(h.store.rows[0].state, 'armed');
});

test('describeRow exposes progress and no due time', async () => {
  const h = setup({ rows: [row('a')], delegations: finished(1) });
  assert.equal(h.scheduler.describeRow(h.store.rows[0]).details.progress, null);
  await h.scheduler.tick({ now: NOW });
  const described = h.scheduler.describeRow(h.store.rows[0]);
  assert.equal(described.dueAt, null);
  assert.deepEqual([described.details.progress.current, described.details.progress.target], [1, 2]);
});

function notificationSetup({ enabled = true } = {}) {
  const published = [];
  const seen = new Set();
  const publish = async (payload) => {
    const created = !seen.has(payload.fingerprint);
    seen.add(payload.fingerprint);
    if (created) published.push(payload);
    return { created };
  };
  const checkAnnouncers = createConditionCheckAnnouncers({
    readSettings: () => ({ enabled }),
    publish: (payload) => publishConditionCheckNotification(payload, { publish, push: async () => {} }),
  });
  return { published, announcers: composeAnnouncers([checkAnnouncers]) };
}

test('notifications: once per settled state, none for armed/cancelled, replay is deduped', async () => {
  const n = notificationSetup();
  const h = setup({
    rows: [
      row('met'),
      row('exp', { expiresAt: new Date(NOW - 1).toISOString() }),
      row('blk', { predicate: { id: 'nope', params: {} } }),
      row('wait', { predicate: { id: 'delegations_finished_since', params: { transport: 'opencode', sinceMs: 0, minCount: 5 } } }),
    ],
    delegations: finished(3),
    announcers: n.announcers,
  });
  await h.scheduler.tick({ now: NOW });
  await h.scheduler.tick({ now: NOW + 60_000 });
  const fingerprints = n.published.map((p) => p.fingerprint).sort();
  assert.deepEqual(fingerprints, ['condition-check:blk:blocked', 'condition-check:exp:expired', 'condition-check:met:resumed']);
  assert.ok(n.published.every((p) => p.category === 'system'));
  const bySeverity = Object.fromEntries(n.published.map((p) => [p.fingerprint, p.severity]));
  assert.equal(bySeverity['condition-check:blk:blocked'], 'warning');
  assert.equal(bySeverity['condition-check:met:resumed'], 'info');
  const resumed = n.published.find((p) => p.fingerprint.endsWith(':resumed'));
  assert.match(resumed.actionUrl, /chat=chat-1/);
  // A replay of the same settled payload publishes nothing new.
  await n.announcers.notify({ event: 'resumed', record: { ...h.store.rows[0] } });
  assert.equal(n.published.length, 3);
});

test('notifications: disabled setting publishes nothing; announceChat is a no-op', async () => {
  const n = notificationSetup({ enabled: false });
  await n.announcers.notify({ record: { id: 'x', kind: 'condition_check', state: 'resumed' } });
  assert.equal(n.published.length, 0);
  const on = notificationSetup();
  const chatNotices = [];
  const composed = composeAnnouncers([on.announcers, { announceChat: async (p) => chatNotices.push(p) }]);
  await composed.announceChat({ record: { id: 'x', kind: 'condition_check', state: 'resumed' } });
  assert.equal(chatNotices.length, 1);
  assert.equal(on.published.length, 0);
});

test('usage-limit announcers ignore condition_check payloads and vice versa; a throwing announcer is contained', async () => {
  const usage = { published: [], notices: [] };
  const usageAnnouncers = createResumeAnnouncers({
    readSettings: () => ({ enabled: true }),
    publish: async (p) => usage.published.push(p),
    appendNotice: async (...args) => usage.notices.push(args),
  });
  const check = notificationSetup();
  const logs = [];
  const composed = composeAnnouncers([
    { notify: async () => { throw new Error('boom'); } },
    usageAnnouncers,
    createConditionCheckAnnouncers({ readSettings: () => ({ enabled: true }), publish: async (p) => check.published.push(p) }),
  ], { log: (event) => logs.push(event) });
  await composed.notify({ record: { id: 'c1', kind: 'condition_check', state: 'resumed' } });
  await composed.announceChat({ record: { id: 'c1', kind: 'condition_check', state: 'resumed', subjectType: 'chat', subjectId: 'chat-z' } });
  assert.equal(usage.published.length, 0);
  assert.equal(usage.notices.length, 0);
  assert.equal(check.published.length, 1);
  await composed.notify({ record: { id: 'u1', kind: 'usage_limit_resume', state: 'resumed' } });
  assert.equal(usage.published.length, 1);
  assert.equal(check.published.length, 1);
  assert.ok(logs.includes('wakeup-notify-failed'));
});

// ---- REST + service -------------------------------------------------------

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  const app = { get: add('GET'), patch: add('PATCH'), post: add('POST') };
  async function call(method, route, { params = {}, body, flags = {} } = {}) {
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `route ${method} ${route} is registered`);
    const out = { status: 200, json: null };
    const res = {
      status(code) { out.status = code; return res; },
      json(payload) { out.json = payload; return res; },
    };
    await handler({ params, query: {}, body, ...flags }, res);
    return out;
  }
  return { app, call };
}

function routeSetup({ delegations }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-condcheck-'));
  const startTodo = [];
  const scheduler = createWakeupScheduler({ dataDir, now: () => NOW });
  const kind = createConditionCheckKind({
    loadDelegations: () => delegations(),
    startTodoAgent: async (input) => { startTodo.push(input); return { chat: { id: 'chat-9' }, initialPrompt: 'P' }; },
    startChatRun: async () => ({ accepted: true }),
    lookupChatRunRequest: () => null,
    probeChatRunLiveness: () => ({ known: false }),
    patchRow: () => null,
    readSettings: () => ({ enabled: true, maxPerTick: 2, harness: '', model: '' }),
  });
  scheduler.registerKind(kind);
  const conditionCheck = createConditionCheckService({
    dataDir,
    getScheduler: () => scheduler,
    getTodo: (_ws, id) => (id === 'todo-1' ? { id, title: 'Measure coverage' } : null),
    now: () => NOW,
  });
  const { app, call } = makeApp();
  registerWakeupsRoutes(app, { dataDir, getScheduler: () => scheduler, conditionCheck, getCurrentCwd: () => '/ws' });
  return { call, startTodo, conditionCheck };
}

const createBody = (over = {}) => ({
  todoId: 'todo-1',
  predicate: { id: 'delegations_finished_since', params: { transport: 'codex', sinceMs: 0, minCount: 2 } },
  brief: 'Measure now.',
  ...over,
});

test('REST create validates and stores a flat armed row', async () => {
  const h = routeSetup({ delegations: () => [] });
  const ok = await h.call('POST', '/api/wakeups/condition-check', { body: createBody() });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.item.state, 'armed');
  assert.equal(ok.json.item.todoId, 'todo-1');
  for (const [over, code] of [
    [{ predicate: { id: 'nope', params: {} } }, 'unknown_predicate'],
    [{ predicate: { id: 'delegations_finished_since', params: { transport: 'codex', sinceMs: 0, minCount: 5000 } } }, 'invalid_params'],
    [{ brief: 'x'.repeat(1501) }, 'brief_too_long'],
    [{ todoId: 'missing' }, 'todo_not_found'],
  ]) {
    const bad = await h.call('POST', '/api/wakeups/condition-check', { body: createBody(over) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, code);
  }
});

test('REST: widget and MCP-integration callers get 403', async () => {
  const h = routeSetup({ delegations: () => [] });
  for (const flags of [{ widgetAccess: true }, { mcpIntegration: {} }]) {
    assert.equal((await h.call('POST', '/api/wakeups/condition-check', { body: createBody(), flags })).status, 403);
    assert.equal((await h.call('POST', '/api/wakeups/:id/run-now', { params: { id: 'x' }, flags })).status, 403);
  }
});

test('REST run-now: 409 condition_not_met with progress and no change; met starts once; then 409 not_armed', async () => {
  let rows = finished(1);
  const h = routeSetup({ delegations: () => rows });
  const created = await h.call('POST', '/api/wakeups/condition-check', { body: createBody() });
  const id = created.json.item.id;
  const unmet = await h.call('POST', '/api/wakeups/:id/run-now', { params: { id } });
  assert.equal(unmet.status, 409);
  assert.equal(unmet.json.code, 'condition_not_met');
  assert.deepEqual([unmet.json.progress.current, unmet.json.progress.target], [1, 2]);
  assert.equal(h.conditionCheck.list()[0].state, 'armed');
  assert.equal(h.startTodo.length, 0);
  rows = finished(2);
  const met = await h.call('POST', '/api/wakeups/:id/run-now', { params: { id } });
  assert.equal(met.status, 200);
  assert.equal(met.json.item.state, 'resumed');
  assert.equal(h.startTodo.length, 1);
  const again = await h.call('POST', '/api/wakeups/:id/run-now', { params: { id } });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'not_armed');
  const missing = await h.call('POST', '/api/wakeups/:id/run-now', { params: { id: 'nope' } });
  assert.equal(missing.status, 404);
});

test('service cancel: an armed check is cancelled and never runs', async () => {
  const h = routeSetup({ delegations: () => finished(9) });
  const id = (await h.call('POST', '/api/wakeups/condition-check', { body: createBody() })).json.item.id;
  assert.equal(h.conditionCheck.cancel(id).item.state, 'cancelled');
  assert.equal(h.conditionCheck.cancel(id).code, 'not_armed');
  const run = await h.call('POST', '/api/wakeups/:id/run-now', { params: { id } });
  assert.equal(run.status, 409);
  assert.equal(h.startTodo.length, 0);
});

test('MCP check tools: names fit the budget, descriptions say they never call a model, handlers use the service', async () => {
  const { CHECK_MCP_TOOLS } = await import('../lib/mcp/builtin/check-tools.js');
  assert.deepEqual(CHECK_MCP_TOOLS.map((t) => t.name), ['check_schedule', 'check_list', 'check_cancel']);
  for (const tool of CHECK_MCP_TOOLS) assert.match(tool.description, /never calls a model/);
  assert.equal(CHECK_MCP_TOOLS.find((t) => t.name === 'check_list').readOnly, true);
  const h = routeSetup({ delegations: () => [] });
  const client = {
    getTodo: async () => ({ id: 'todo-1', title: 'Measure coverage' }),
    listTodos: async () => [{ id: 'todo-1', title: 'Measure coverage' }],
    scheduleCheck: async (input) => h.conditionCheck.create(input),
    listChecks: async (input) => h.conditionCheck.list(input),
    cancelCheck: async ({ checkId }) => h.conditionCheck.cancel(checkId),
  };
  const session = { mode: 'agent', workspaceFolder: '/ws' };
  const [schedule, list, cancel] = CHECK_MCP_TOOLS;
  const made = await schedule.handler({ todo_id: 'todo-1', predicate: createBody().predicate }, { client, session });
  assert.equal(made.structuredContent?.item?.state ?? JSON.parse(made.content[0].text).item.state, 'armed');
  const listed = await list.handler({}, { client, session });
  assert.equal((listed.structuredContent?.items ?? JSON.parse(listed.content[0].text).items).length, 1);
  const id = h.conditionCheck.list()[0].id;
  await cancel.handler({ check_id: id }, { client, session });
  assert.equal(h.conditionCheck.list()[0].state, 'cancelled');
  await assert.rejects(() => cancel.handler({ check_id: id }, { client, session }), /not_armed/);
});
