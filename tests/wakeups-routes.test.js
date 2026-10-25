import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeriodicJobRunner } from '../lib/periodic-job-runner.js';
import { registerWakeupsRoutes } from '../lib/routes/wakeups-routes.js';
import { createWakeupScheduler } from '../lib/wakeup-scheduler.js';
import { createUsageLimitResumeKind } from '../lib/usage-limit-resume-executor.js';
import { armWakeup } from '../lib/persist/wakeups-persist.js';
import { USAGE_LIMIT_RESUME_SETTINGS_SCHEMA } from '../lib/usage-limit-resume-settings.js';

void ISOLATED_DATA_DIR;

/** Minimal express stand-in: records handlers and invokes them directly. */
function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  const app = { get: add('GET'), patch: add('PATCH'), post: add('POST') };
  async function call(method, route, { params = {}, query = {}, body, flags = {} } = {}) {
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `route ${method} ${route} is registered`);
    const out = { status: 200, json: null };
    const res = {
      status(code) { out.status = code; return res; },
      json(payload) { out.json = payload; return res; },
    };
    await handler({ params, query, body, ...flags }, res);
    return out;
  }
  return { app, call };
}

const fakeKind = {
  kind: 'fake',
  label: 'Fake',
  getSettings: () => ({ enabled: true, maxPerTick: 2 }),
  normalize: (row) => ({ ...row }),
  selectCandidates: () => [],
};

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-wakeups-routes-'));
  const scheduler = createWakeupScheduler({ dataDir, now: () => Date.parse('2026-01-01T00:00:00Z') });
  scheduler.registerKind(createUsageLimitResumeKind({ dataDir }));
  scheduler.registerKind(fakeKind);
  const saved = { config: { usageLimitResume: { enabled: false } } };
  const { app, call } = makeApp();
  registerWakeupsRoutes(app, {
    dataDir,
    getScheduler: () => scheduler,
    loadSettings: () => saved.config,
    saveSettings: (config) => { saved.config = config; },
  });
  const arm = (row) => armWakeup(row, { dataDir });
  const usageRow = (id, over = {}) => ({
    id, kind: 'usage_limit_resume', subjectType: 'chat', subjectId: `chat-${id}`, harness: 'claude',
    resetAt: '2026-01-01T01:00:00.000Z', pausedAt: '2026-01-01T00:00:00.000Z', state: 'armed', attempts: 0, ...over,
  });
  return { call, arm, usageRow, saved, scheduler };
}

test('list: filters by kind and state; unknown kind yields an empty list', async () => {
  const { call, arm, usageRow } = setup();
  arm(usageRow('a'));
  arm(usageRow('b', { state: 'cancelled' }));
  arm({ id: 'f1', kind: 'fake', subjectType: 'x', subjectId: 'y', state: 'armed' });
  assert.equal((await call('GET', '/api/wakeups')).json.items.length, 3);
  assert.deepEqual((await call('GET', '/api/wakeups', { query: { kind: 'usage_limit_resume', state: 'armed' } })).json.items.map((i) => i.id), ['a']);
  assert.deepEqual((await call('GET', '/api/wakeups', { query: { state: 'cancelled' } })).json.items.map((i) => i.id), ['b']);
  const unknown = await call('GET', '/api/wakeups', { query: { kind: 'nope' } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json.items, []);
});

test('list: dueAt is a value for a usage-limit row and null for a kind without describeRow', async () => {
  const { call, arm, usageRow } = setup();
  arm(usageRow('a'));
  arm({ id: 'f1', kind: 'fake', subjectType: 'x', subjectId: 'y', state: 'armed' });
  arm(usageRow('bad', { resetAt: 'not-a-date' }));
  const items = (await call('GET', '/api/wakeups')).json.items;
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.ok(Date.parse(byId.a.dueAt) >= Date.parse('2026-01-01T01:00:00.000Z'));
  assert.equal(byId.f1.dueAt, null);
  assert.equal(byId.bad.dueAt, null);
  assert.equal(byId.a.kind, 'usage_limit_resume');
  assert.equal(byId.a.attempts, 0);
});

test('kinds: metadata, enabled flag and settings schema', async () => {
  const { call } = setup();
  const { json } = await call('GET', '/api/wakeups/kinds');
  const usage = json.kinds.find((k) => k.kind === 'usage_limit_resume');
  assert.equal(usage.label, 'Usage-limit resume');
  assert.ok(usage.description);
  assert.equal(usage.enabled, false);
  assert.deepEqual(usage.settingsSchema, USAGE_LIMIT_RESUME_SETTINGS_SCHEMA);
  assert.equal(json.kinds.find((k) => k.kind === 'fake').settingsSchema && Object.keys(json.kinds.find((k) => k.kind === 'fake').settingsSchema).length, 0);
});

test('settings PATCH: 404 unknown kind, 400 invalid body / unsupported kind, 200 persists', async () => {
  const { call, saved } = setup();
  const patch = (kind, body) => call('PATCH', '/api/wakeups/kinds/:kind/settings', { params: { kind }, body });
  assert.equal((await patch('nope', {})).status, 404);
  const badBody = await patch('usage_limit_resume', [1]);
  assert.equal(badBody.status, 400);
  assert.equal(badBody.json.code, 'invalid_settings');
  const unsupported = await patch('fake', { enabled: true });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.code, 'unsupported_settings');
  const ok = await patch('usage_limit_resume', { enabled: true, maxChain: 99 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.enabled, true);
  assert.equal(ok.json.settings.maxChain, 5, 'clamped by the kind settings module');
  assert.equal(saved.config.usageLimitResume.enabled, true);
});

test('cancel: armed -> cancelled, other state 409 not_armed, unknown id 404', async () => {
  const { call, arm, usageRow } = setup();
  arm(usageRow('a'));
  arm(usageRow('b', { state: 'resumed' }));
  const cancel = (id) => call('POST', '/api/wakeups/:id/cancel', { params: { id } });
  const done = await cancel('a');
  assert.equal(done.status, 200);
  assert.equal(done.json.item.state, 'cancelled');
  const again = await cancel('a');
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'not_armed');
  assert.equal((await cancel('b')).status, 409);
  assert.equal((await cancel('zzz')).status, 404);
});

test('status: scheduler snapshot shape, and a safe default before the scheduler boots', async () => {
  const { call, scheduler } = setup();
  const { json } = await call('GET', '/api/wakeups/status');
  assert.equal(json.running, false);
  assert.equal(json.lastTickAt, null);
  assert.equal(typeof json.tickMs, 'number');
  assert.deepEqual(json.jobs, []);
  assert.deepEqual(json.kinds.find((k) => k.kind === 'fake'), { kind: 'fake', maxPerTick: 2 });
  assert.equal(json.kinds.find((k) => k.kind === 'usage_limit_resume').maxPerTick, 3);
  void scheduler;

  const { app, call: callEmpty } = makeApp();
  registerWakeupsRoutes(app, { dataDir: os.tmpdir(), getScheduler: () => null });
  const empty = await callEmpty('GET', '/api/wakeups/status');
  assert.deepEqual({ ...empty.json, ok: undefined }, { ok: undefined, running: false, tickMs: 60000, lastTickAt: null, kinds: [], jobs: [] });
  assert.deepEqual((await callEmpty('GET', '/api/wakeups/kinds')).json.kinds, []);
});

test('scheduler is read lazily: a scheduler that boots after registration is visible', async () => {
  const { app, call } = makeApp();
  let booted = null;
  registerWakeupsRoutes(app, { dataDir: os.tmpdir(), getScheduler: () => booted });
  assert.deepEqual((await call('GET', '/api/wakeups/kinds')).json.kinds, []);
  booted = createWakeupScheduler({ dataDir: os.tmpdir() });
  booted.registerKind(fakeKind);
  assert.equal((await call('GET', '/api/wakeups/kinds')).json.kinds.length, 1);
});

test('auth restriction: widget and MCP-integration callers get 403 on every route', async () => {
  const { call, arm, usageRow } = setup();
  arm(usageRow('a'));
  const routes = [
    ['GET', '/api/wakeups'], ['GET', '/api/wakeups/kinds'], ['GET', '/api/wakeups/status'],
    ['PATCH', '/api/wakeups/kinds/:kind/settings'], ['POST', '/api/wakeups/:id/cancel'],
  ];
  for (const flags of [{ widgetAccess: true }, { mcpIntegration: true }]) {
    for (const [method, route] of routes) {
      const res = await call(method, route, { params: { kind: 'usage_limit_resume', id: 'a' }, body: {}, flags });
      assert.equal(res.status, 403, `${method} ${route}`);
    }
  }
  assert.equal((await call('GET', '/api/wakeups')).json.items[0].state, 'armed', 'forbidden cancel changed nothing');
});

test('kinds: a kind whose getSettings throws does not break the list', async () => {
  const { app, call } = makeApp();
  const scheduler = createWakeupScheduler({ dataDir: os.tmpdir() });
  scheduler.registerKind({ ...fakeKind, kind: 'broken', getSettings: () => { throw new Error('boom'); } });
  scheduler.registerKind(fakeKind);
  registerWakeupsRoutes(app, { dataDir: os.tmpdir(), getScheduler: () => scheduler });
  const { status, json } = await call('GET', '/api/wakeups/kinds');
  assert.equal(status, 200);
  const broken = json.kinds.find((k) => k.kind === 'broken');
  assert.equal(broken.enabled, false);
  assert.deepEqual(broken.settings, {});
  assert.equal(json.kinds.find((k) => k.kind === 'fake').enabled, true);
});

test('status lists periodic jobs from the runner even without a scheduler; no chat titles leak', async () => {
  const runner = createPeriodicJobRunner({ setTimeoutFn: () => 0, setIntervalFn: () => 0, clearTimeoutFn() {}, clearIntervalFn() {} });
  runner.register({
    id: 'chat_auto_archive', label: 'Idle chat auto-archive', intervalMs: 60_000, settingKey: 'chatAutoArchive',
    isEnabled: () => true, run: () => ({ archived: 1, scanned: 4 }),
  });
  await runner.runNow('chat_auto_archive');
  const { app, call } = makeApp();
  registerWakeupsRoutes(app, { dataDir: os.tmpdir(), getScheduler: () => null, getPeriodicJobRunner: () => runner });
  const { json } = await call('GET', '/api/wakeups/status');
  assert.deepEqual(json.kinds, []);
  assert.equal(json.jobs.length, 1);
  assert.deepEqual(Object.keys(json.jobs[0]).sort(), ['enabled', 'id', 'intervalMs', 'label', 'lastDurationMs', 'lastError', 'lastResult', 'lastRunAt', 'maxDurationMs', 'running', 'runs', 'settingKey', 'skipped']);
  assert.deepEqual(json.jobs[0].lastResult, { archived: 1, scanned: 4 });
});
