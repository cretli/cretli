import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildClaudeNoticePayload } from '../lib/claude/claude-agent-ws.js';
import { buildClaudeRateLimitNotice } from '../lib/agent-harness/claude-event-normalizer.js';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import {
  getHarnessUsageLimit,
  noteHarnessUsageLimit,
  readHarnessUsageLimitHistory,
} from '../lib/harness-usage-limits.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';
import {
  buildHarnessHealth,
  noteHarnessPlanLimit,
  readHarnessPlanLimits,
} from '../lib/usage/harness-health.js';
import { readHarnessPlanLimitHistory } from '../lib/usage/plan-limit-history.js';
import { resolveHarnessPlanLimitSnapshot } from '../lib/usage/harness-usage.js';
import {
  buildHarnessHealthMap,
  registerHarnessCatalogRoutes,
} from '../lib/routes/harness-catalog-routes.js';

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
 * @param {string} route
 * @param {{ body?: object, query?: object, params?: object, req?: object }} [input]
 */
async function callRoute(method, route, input = {}) {
  const app = createFakeApp();
  registerHarnessCatalogRoutes(app);
  const handler = app.routes.get(`${method} ${route}`);
  assert.ok(handler, `${method} ${route} must be registered`);
  const res = createFakeResponse();
  await handler(
    { body: input.body || {}, query: input.query || {}, params: input.params || {}, ...(input.req || {}) },
    res,
  );
  return res;
}

function tempDataDir() {
  return mkdtempSync(path.join(tmpdir(), 'cretli-harness-health-'));
}

test('claude rate_limit_info extraction normalizes SDK fractions to shared percentages', () => {
  const notice = buildClaudeRateLimitNotice({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt: 1_800_000_000,
      utilization: 0.825,
      rateLimitType: 'five_hour',
    },
  });
  assert.equal(notice.status, 'rejected');
  assert.equal(notice.resetsAt, 1_800_000_000);
  assert.equal(notice.utilization, 82.5);
  assert.equal(notice.rateLimitType, 'five_hour');

  // The SDK omits a percentage for some windows: store nothing, never guess.
  const bare = buildClaudeRateLimitNotice({ rate_limit_info: { status: 'allowed' } });
  assert.equal('utilization' in bare, false);
  assert.equal('rateLimitType' in bare, false);
});

test('plan-limit snapshot resolves from a raw event and from a normalized notice', () => {
  const raw = resolveHarnessPlanLimitSnapshot('claude', {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      utilization: 0.41,
      resetsAt: 1_800_000_000,
      rateLimitType: 'seven_day',
    },
  });
  assert.equal(raw.harness, 'claude');
  assert.equal(raw.status, 'allowed_warning');
  assert.equal(raw.utilization, 41);
  assert.equal(raw.rateLimitType, 'seven_day');
  assert.match(raw.resetsAt, /^\d{4}-\d{2}-\d{2}T/);

  const notice = resolveHarnessPlanLimitSnapshot('claude', {
    type: 'sdkRunProgress',
    noticeType: 'rate_limit',
    status: 'allowed',
    resetsAt: 1_800_000_000,
  });
  assert.equal(notice.status, 'allowed');
  assert.equal(notice.utilization, undefined);

  assert.equal(
    resolveHarnessPlanLimitSnapshot('codex', { type: 'sdkEvent', event: { type: 'usage', usage: {} } }),
    null,
  );
});

test('plan-limit snapshots upsert per harness/window and flag stale', () => {
  const dataDir = tempDataDir();
  try {
    const stored = noteHarnessPlanLimit({
      harness: 'claude',
      status: 'allowed_warning',
      utilization: 55,
      resetsAt: '2026-09-01T00:00:00.000Z',
      rateLimitType: 'five_hour',
      dataDir,
    });
    assert.equal(stored.utilization, 55);

    noteHarnessPlanLimit({
      harness: 'claude',
      status: 'rejected',
      utilization: 99,
      rateLimitType: 'five_hour',
      dataDir,
    });
    const rows = readHarnessPlanLimits('claude', { dataDir });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[0].utilization, 99);
    assert.equal(rows[0].stale, false);

    const stale = readHarnessPlanLimits('claude', { dataDir, now: Date.now() + 7 * 60 * 60 * 1000 });
    assert.equal(stale[0].stale, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('buildHarnessHealth aggregates runs, errors, limit history and plan snapshots', () => {
  const dataDir = tempDataDir();
  try {
    recordUsage(
      { provider: 'cursor', harness: 'sdk', feature: 'chat', model: 'composer-2', eventType: 'run', outcome: 'ok', latencyMs: 100, at: '2026-08-28T10:00:00.000Z' },
      { dataDir },
    );
    recordUsage(
      { provider: 'cursor', harness: 'sdk', feature: 'chat', model: 'composer-2', eventType: 'run', outcome: 'error', errorCode: 'run_error', latencyMs: 300, at: '2026-08-28T10:05:00.000Z' },
      { dataDir },
    );
    recordUsage(
      { provider: 'cursor', harness: 'sdk', feature: 'chat', model: 'composer-2', eventType: 'run', outcome: 'ok', latencyMs: 200, at: '2026-08-29T10:00:00.000Z' },
      { dataDir },
    );
    recordUsage(
      { provider: 'cursor', harness: 'sdk', feature: 'chat', model: 'composer-2', tokens: { textInput: 100 }, at: '2026-08-28T10:00:00.000Z' },
      { dataDir },
    );
    mkdirSync(path.join(dataDir, 'usage'), { recursive: true });
    appendFileSync(
      path.join(dataDir, 'usage', 'limits.jsonl'),
      `${JSON.stringify({ ts: '2026-08-28T09:00:00.000Z', harness: 'sdk', model: 'composer-2', resetAt: '2026-08-28T10:00:00.000Z', source: 'error-text', code: 'usage_limit' })}\n`,
    );
    noteHarnessPlanLimit({
      harness: 'sdk',
      status: 'allowed_warning',
      utilization: 10,
      rateLimitType: 'five_hour',
      dataDir,
    });

    const health = buildHarnessHealth({ harness: 'sdk', from: '2026-08-28', to: '2026-08-29', dataDir });
    assert.equal(health.harness, 'sdk');
    assert.equal(health.runs, 3);
    assert.equal(health.okRuns, 2);
    assert.equal(health.errorRuns, 1);
    assert.equal(health.successRate, Number((2 / 3).toFixed(4)));
    assert.equal(health.limitHistory.count, 1);
    assert.equal(health.limitHistory.byDay['2026-08-28'], 1);
    assert.equal(health.limitHistory.lastAt, '2026-08-28T09:00:00.000Z');
    assert.deepEqual(health.lastErrors, [
      { ts: '2026-08-28T10:05:00.000Z', errorCode: 'run_error', model: 'composer-2' },
    ]);
    assert.deepEqual(health.daily.map((row) => row.day), ['2026-08-28', '2026-08-29']);
    assert.deepEqual(health.daily.map((row) => row.runs), [2, 1]);
    assert.deepEqual(health.daily.map((row) => row.errors), [1, 0]);
    assert.equal(health.planLimits.length, 1);
    assert.equal(health.planLimits[0].utilization, 10);
    assert.ok(Number.isFinite(health.p50LatencyMs));
    assert.ok(Number.isFinite(health.p95LatencyMs));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET /api/harnesses/health returns the default 7-day range for every catalog harness', async () => {
  const response = await callRoute('GET', '/api/harnesses/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const span = Math.round(
    (Date.parse(`${response.body.to}T00:00:00.000Z`) - Date.parse(`${response.body.from}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
  assert.equal(span, 7);
  assert.ok(response.body.harnesses && typeof response.body.harnesses === 'object');
  assert.equal(Object.getPrototypeOf(response.body.harnesses), null);
  assert.ok(Object.prototype.hasOwnProperty.call(response.body.harnesses, 'sdk'));
  for (const health of Object.values(response.body.harnesses)) {
    assert.equal(Array.isArray(health.planLimits), true);
    assert.equal(Array.isArray(health.daily), true);
  }
});

test('GET /api/harnesses/health validates range and rejects widget callers', async () => {
  const tooLong = await callRoute('GET', '/api/harnesses/health', {
    query: { from: '2025-01-01', to: '2026-12-31' },
  });
  assert.equal(tooLong.statusCode, 400);

  const badDate = await callRoute('GET', '/api/harnesses/health', {
    query: { from: '2026-02-31', to: '2026-03-01' },
  });
  assert.equal(badDate.statusCode, 400);

  const restricted = await callRoute('GET', '/api/harnesses/health', { req: { widgetAccess: {} } });
  assert.equal(restricted.statusCode, 403);
});

test('POST /api/harnesses/:id/usage-limit/clear unlocks a harness', async () => {
  const model = `clear-endpoint-${process.pid}`;
  assert.equal(noteHarnessUsageLimit({ harness: 'sdk', model, message: '429 rate limit exceeded' }), true);
  assert.ok(getHarnessUsageLimit({ harness: 'sdk', model }));

  const response = await callRoute('POST', '/api/harnesses/:id/usage-limit/clear', {
    params: { id: 'sdk' },
    body: { model },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.removed, 1);
  assert.equal(getHarnessUsageLimit({ harness: 'sdk', model }), null);

  const restricted = await callRoute('POST', '/api/harnesses/:id/usage-limit/clear', {
    params: { id: 'sdk' },
    req: { mcpIntegration: {} },
  });
  assert.equal(restricted.statusCode, 403);
});

test('room-kernel turns a rejected rate-limit event into a lockout and a plan snapshot', () => {
  const dataDir = tempDataDir();
  try {
    const kernel = createAgentRoomKernel({
      transport: 'claude',
      persistHistory: () => {},
      recordUsage: () => {},
      usageDataDir: dataDir,
    });
    const room = kernel.createRoomState({ sessionKey: 'claude-rl', chatId: 'c-rl', modelId: 'claude-sonnet-4-5' });
    kernel.broadcastRoom(room, {
      type: 'sdkRunProgress',
      noticeType: 'rate_limit',
      status: 'rejected',
      resetsAt: 4_000_000_000,
      utilization: 88,
      rateLimitType: 'five_hour',
    });

    const history = readHarnessUsageLimitHistory({ harness: 'claude', dataDir });
    assert.equal(history.length, 1);
    assert.equal(history[0].source, 'rate-limit-event');
    assert.equal(history[0].code, 'rate_limit_five_hour');
    assert.equal(history[0].model, 'claude-sonnet-4-5');

    const plan = readHarnessPlanLimits('claude', { dataDir });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].utilization, 88);
    assert.equal(plan[0].rateLimitType, 'five_hour');

    // The structured rejected event must reach the plan history exactly once:
    // noteHarnessPlanLimit writes it and the rate-limit-event lockout path must
    // not append a second copy.
    const planHistory = readHarnessPlanLimitHistory({ harness: 'claude', dataDir });
    assert.equal(planHistory.length, 1);
    assert.equal(planHistory[0].status, 'rejected');

    // A warning refreshes the snapshot but must not add another lockout row.
    kernel.broadcastRoom(room, {
      type: 'sdkRunProgress',
      noticeType: 'rate_limit',
      status: 'allowed_warning',
      utilization: 12,
      rateLimitType: 'five_hour',
    });
    assert.equal(readHarnessUsageLimitHistory({ harness: 'claude', dataDir }).length, 1);
    assert.equal(readHarnessPlanLimits('claude', { dataDir })[0].utilization, 12);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('buildClaudeNoticePayload carries plan fields end-to-end into the health snapshot', () => {
  const dataDir = tempDataDir();
  try {
    // A fake raw SDK rate_limit_event, exactly as the normalizer consumes it.
    const notice = buildClaudeRateLimitNotice({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 4_000_000_000,
        utilization: 0.8825,
        rateLimitType: 'five_hour',
        overageStatus: 'enabled',
        isUsingOverage: true,
      },
    });
    assert.equal(notice.utilization, 88.25);
    assert.equal(notice.rateLimitType, 'five_hour');

    // Nothing is injected by hand: only the real notice goes through the builder.
    const payload = buildClaudeNoticePayload(notice, 'run-rl-e2e');
    assert.equal(payload.noticeType, 'rate_limit');
    assert.equal(payload.utilization, 88.25);
    assert.equal(payload.rateLimitType, 'five_hour');
    assert.equal(payload.overageStatus, 'enabled');
    assert.equal(payload.isUsingOverage, true);

    const snapshot = resolveHarnessPlanLimitSnapshot('claude', payload);
    assert.equal(snapshot.status, 'rejected');
    assert.equal(snapshot.utilization, 88.25);
    assert.equal(snapshot.rateLimitType, 'five_hour');

    const kernel = createAgentRoomKernel({
      transport: 'claude',
      persistHistory: () => {},
      recordUsage: () => {},
      usageDataDir: dataDir,
    });
    const room = kernel.createRoomState({
      sessionKey: 'claude-rl-e2e',
      chatId: 'c-rl-e2e',
      modelId: 'claude-sonnet-4-5',
    });
    kernel.broadcastRoom(room, payload);

    const plan = readHarnessPlanLimits('claude', { dataDir });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].utilization, 88.25);
    assert.equal(plan[0].rateLimitType, 'five_hour');

    const history = readHarnessUsageLimitHistory({ harness: 'claude', dataDir });
    assert.equal(history.length, 1);
    assert.equal(history[0].code, 'rate_limit_five_hour');
    assert.equal(history[0].model, 'claude-sonnet-4-5');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('buildHarnessHealth accepts pre-read events so the route reads the ledger once', () => {
  const dataDir = tempDataDir();
  try {
    const events = [
      { provider: 'other', harness: 'sdk', eventType: 'run', outcome: 'ok', model: 'm', at: '2026-08-28T10:00:00.000Z' },
      { provider: 'other', harness: 'sdk', eventType: 'run', outcome: 'error', model: 'm', at: '2026-08-28T11:00:00.000Z' },
      { provider: 'other', harness: 'claude', eventType: 'run', outcome: 'ok', model: 'm', at: '2026-08-28T12:00:00.000Z' },
    ];
    const health = buildHarnessHealth({
      harness: 'sdk',
      from: '2026-08-28',
      to: '2026-08-28',
      dataDir,
      events,
    });
    assert.equal(health.runs, 2);
    assert.equal(health.okRuns, 1);
    assert.equal(health.errorRuns, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('readPlanLimitStore keeps a *.corrupt copy instead of silently overwriting', () => {
  const dataDir = tempDataDir();
  try {
    const file = path.join(dataDir, 'harness-plan-limits.json');
    writeFileSync(file, '{ this is not valid json', 'utf8');
    assert.deepEqual(readHarnessPlanLimits('claude', { dataDir }), []);
    assert.equal(existsSync(`${file}.corrupt`), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('harness health map drops prototype ids and clear validates the catalog', async () => {
  const map = buildHarnessHealthMap(
    [{ id: '__proto__' }, { id: 'constructor' }, { id: 'sdk' }],
    { from: '2026-08-28', to: '2026-08-28' },
  );
  assert.equal(Object.getPrototypeOf(map), null);
  assert.equal(Object.prototype.hasOwnProperty.call(map, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(map, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(map, 'sdk'), true);

  const unknown = await callRoute('POST', '/api/harnesses/:id/usage-limit/clear', {
    params: { id: 'definitely-not-a-harness' },
  });
  assert.equal(unknown.statusCode, 404);

  const proto = await callRoute('POST', '/api/harnesses/:id/usage-limit/clear', {
    params: { id: '__proto__' },
  });
  assert.equal(proto.statusCode, 400);

  const longModel = await callRoute('POST', '/api/harnesses/:id/usage-limit/clear', {
    params: { id: 'sdk' },
    body: { model: 'x'.repeat(201) },
  });
  assert.equal(longModel.statusCode, 400);
});

removeIsolatedDataDir();


test('forecast persists measured growth per harness/window and expires at reset', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-plan-forecast-'));
  const start = Date.parse('2026-10-02T12:00:00Z');
  const resetsAt = new Date(start + 5 * 3600000).toISOString();
  const note = (utilization, offset, extra = {}) => noteHarnessPlanLimit({ harness: 'qwen',
    rateLimitType: 'five_hour', utilization, observedAt: new Date(start + offset).toISOString(), resetsAt, dataDir, ...extra });
  const read = (offset = 3600000) => readHarnessPlanLimits('qwen', { dataDir, now: start + offset })[0];
  try {
    note(20, 0);
    assert.equal(read(0).forecast, null);
    note(40, 3600000);
    assert.equal(read().remainingPercent, 60);
    assert.equal(read().forecast.percentPerHour, 20);
    assert.equal(read().forecast.exhaustsAt, new Date(start + 4 * 3600000).toISOString());
    assert.equal(read().forecast.beforeReset, true);
    note(30, 1800000); // Out-of-order event cannot replace the last reading.
    assert.equal(read().utilization, 40);
    note(99, 3600000, { harness: 'codex' });
    note(99, 3600000, { rateLimitType: 'seven_day' });
    assert.equal(readHarnessPlanLimits('qwen', { dataDir, now: start + 3600000 }).find(r => r.rateLimitType === 'seven_day').forecast, null);
    const expired = read(5 * 3600000);
    assert.equal(expired.expired, true);
    assert.equal(expired.forecast, null);
    assert.equal(expired.remainingPercent, null);
    note(10, 2 * 3600000); // Decrease cannot be extrapolated across a reset.
    assert.equal(read(2 * 3600000).forecast, null);
    note(20, 3 * 3600000, { resetsAt: new Date(start + 10 * 3600000).toISOString() });
    assert.equal(read(3 * 3600000).forecast, null);
    note(null, 4 * 3600000);
    assert.equal('utilization' in read(4 * 3600000), false);
    assert.equal(read(4 * 3600000).remainingPercent, null);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('stale samples and flat readings do not produce a forecast', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-plan-stale-'));
  const start = Date.parse('2026-10-02T12:00:00Z');
  const note = (utilization, hours) => noteHarnessPlanLimit({ harness: 'sdk', rateLimitType: 'seven_day',
    utilization, observedAt: new Date(start + hours * 3600000).toISOString(),
    resetsAt: new Date(start + 7 * 86400000).toISOString(), dataDir });
  try {
    note(20, 0); note(20, 1);
    assert.equal(readHarnessPlanLimits('sdk', { dataDir, now: start + 3600000 })[0].forecast, null);
    note(30, 2);
    const stale = readHarnessPlanLimits('sdk', { dataDir, now: start + 9 * 3600000 })[0];
    assert.equal(stale.stale, true);
    assert.equal(stale.forecast, null);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});


test('shared rate-limit notices work for every harness without guessing a scale', () => {
  for (const harness of ['sdk', 'claude', 'codex', 'qwen', 'openrouter', 'future']) {
    const snapshot = resolveHarnessPlanLimitSnapshot(harness, { noticeType: 'rate_limit', rateLimitType: 'session', utilization: 0.8 });
    assert.equal(snapshot.utilization, 0.8);
    assert.equal(snapshot.rateLimitType, 'session');
    const absent = resolveHarnessPlanLimitSnapshot(harness, { noticeType: 'rate_limit', status: 'allowed', utilization: null });
    assert.equal('utilization' in absent, false);
  }
  const claude = buildClaudeRateLimitNotice({ rate_limit_info: { status: 'allowed_warning', utilization: 0.008 } });
  assert.equal(claude.utilization, 0.8);
  assert.equal('utilization' in buildClaudeRateLimitNotice({ rate_limit_info: { status: 'allowed', utilization: '' } }), false);
});

test('plan-limit history records every sample per harness in one shared store', () => {
  const dataDir = tempDataDir();
  try {
    const t0 = Date.parse('2026-10-01T10:00:00Z');
    const at = (i) => new Date(t0 + i * 3_600_000).toISOString();
    for (const harness of ['claude', 'qwen']) {
      noteHarnessPlanLimit({ harness, rateLimitType: 'five_hour', utilization: 40, resetsAt: at(6), observedAt: at(0), dataDir });
      noteHarnessPlanLimit({ harness, rateLimitType: 'five_hour', utilization: 70, resetsAt: at(6), observedAt: at(1), dataDir });
      noteHarnessPlanLimit({ harness, rateLimitType: 'five_hour', status: 'rejected', resetsAt: at(6), observedAt: at(2), dataDir });
    }
    for (const harness of ['claude', 'qwen']) {
      const rows = readHarnessPlanLimitHistory({ harness, dataDir });
      assert.equal(rows.length, 3, `three rows for ${harness}`);
      assert.deepEqual(rows.map((row) => row.observedAt), [at(0), at(1), at(2)]); // ascending
      assert.deepEqual(rows.map((row) => row.utilization), [40, 70, undefined]);
      assert.equal(rows[2].status, 'rejected');
      assert.equal('utilization' in rows[2], false); // never invented
    }
    // A single shared file keeps the two harnesses distinct.
    assert.equal(readHarnessPlanLimitHistory({ dataDir }).length, 6);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('plan-limit history ignores a reading with none of status/utilization/resetsAt/rateLimitType', () => {
  const dataDir = tempDataDir();
  try {
    assert.equal(noteHarnessPlanLimit({ harness: 'claude', dataDir }), null);
    assert.equal(noteHarnessPlanLimit({ harness: 'claude', model: 'claude-sonnet-4-5', dataDir }), null);
    assert.equal(noteHarnessPlanLimit({ harness: 'claude', observedAt: '2026-10-01T10:00:00Z', dataDir }), null);
    assert.deepEqual(readHarnessPlanLimitHistory({ dataDir }), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('text rejection writes a plan-limit history row without a fabricated percentage', () => {
  const dataDir = tempDataDir();
  try {
    assert.equal(noteHarnessUsageLimit({ harness: 'claude', model: 'claude-sonnet-4-5', message: 'Usage limit reached. Reset at 2026-12-31T00:00:00', dataDir }), true);
    assert.equal(noteHarnessUsageLimit({ harness: 'qwen', model: 'qwen-max', message: '429 rate limit exceeded', dataDir }), true);

    const claude = readHarnessPlanLimitHistory({ harness: 'claude', dataDir });
    assert.equal(claude.length, 1);
    assert.equal(claude[0].status, 'rejected');
    assert.equal(claude[0].model, 'claude-sonnet-4-5');
    assert.match(claude[0].resetsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(claude[0].resetsAt) > Date.now());
    assert.equal('utilization' in claude[0], false);

    const qwen = readHarnessPlanLimitHistory({ harness: 'qwen', dataDir });
    assert.equal(qwen.length, 1);
    assert.equal(qwen[0].status, 'rejected');
    // The message states no reset date, so the row must not invent one from the
    // lockout-store TTL fallback.
    assert.equal('resetsAt' in qwen[0], false);

    // A non-limit message must not add any row.
    assert.equal(noteHarnessUsageLimit({ harness: 'codex', model: 'codex', message: 'network timeout', dataDir }), false);
    assert.deepEqual(readHarnessPlanLimitHistory({ harness: 'codex', dataDir }), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('plan-limit history does not disturb the last snapshot or the health card', () => {
  const dataDir = tempDataDir();
  const resetsAt = '2026-10-01T18:00:00.000Z';
  try {
    noteHarnessPlanLimit({ harness: 'claude', rateLimitType: 'five_hour', utilization: 40, resetsAt, observedAt: '2026-10-01T10:00:00.000Z', dataDir });
    noteHarnessPlanLimit({ harness: 'claude', rateLimitType: 'five_hour', utilization: 70, resetsAt, observedAt: '2026-10-01T11:00:00.000Z', dataDir });

    // Upsert keeps ONE last snapshot at the latest reading...
    const now = Date.parse('2026-10-01T11:30:00.000Z');
    const plan = readHarnessPlanLimits('claude', { dataDir, now });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].utilization, 70);

    // ...while history keeps BOTH samples.
    assert.deepEqual(readHarnessPlanLimitHistory({ harness: 'claude', dataDir }).map((row) => row.utilization), [40, 70]);

    const health = buildHarnessHealth({ harness: 'claude', from: '2026-10-01', to: '2026-10-01', dataDir, now });
    assert.equal(health.planLimits.length, 1);
    assert.equal(health.planLimits[0].utilization, 70);
    assert.equal(health.planLimitHistory.count, 2);
    assert.equal(health.planLimitHistory.lastAt, '2026-10-01T11:00:00.000Z');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
