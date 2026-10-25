import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildClaudeNoticePayload } from '../lib/claude/claude-agent-ws.ts';
import { buildClaudeRateLimitNotice } from '../lib/agent-harness/claude-event-normalizer.ts';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import {
  getHarnessUsageLimit,
  noteHarnessUsageLimit,
  readHarnessUsageLimitHistory,
} from '../lib/harness-usage-limits.js';
import { recordUsage } from '../lib/usage/usage-ledger.ts';
import {
  buildHarnessHealth,
  noteHarnessPlanLimit,
  readHarnessPlanLimits,
} from '../lib/usage/harness-health.ts';
import { readHarnessPlanLimitHistory } from '../lib/usage/plan-limit-history.ts';
import { forecastPlanWindows } from '../lib/usage/plan-window-forecast.ts';
import { resolveHarnessPlanLimitSnapshot } from '../lib/usage/harness-usage.ts';
import {
  buildHarnessHealthMap,
  registerHarnessCatalogRoutes,
} from '../lib/routes/harness-catalog-routes.js';

// Plan limits exist only under subscription auth; API-key mode is covered by
// the explicit authMode tests below.
process.env.CRETLI_CLAUDE_AUTH_MODE = 'subscription';

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
      harness: 'claude', authMode: 'subscription',
      status: 'allowed_warning',
      utilization: 55,
      resetsAt: '2026-09-01T00:00:00.000Z',
      rateLimitType: 'five_hour',
      dataDir,
    });
    assert.equal(stored.utilization, 55);

    noteHarnessPlanLimit({
      harness: 'claude', authMode: 'subscription',
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

test('Codex health includes bounded run-pressure counters for limit hits', () => {
  const events = [
    { provider: 'openai', harness: 'codex', feature: 'chat', model: 'gpt-6.1-sol', eventType: 'run', outcome: 'limit', errorCode: 'usage_limit', at: '2026-10-25T10:00:00.000Z', harnessRunPressure: { activeRuns: 3, startsLastMinute: 5, startsLastFiveMinutes: 11 } },
  ];
  const health = buildHarnessHealth({
    harness: 'codex', from: '2026-10-25', to: '2026-10-25', events,
  });
  assert.deepEqual(health.lastErrors, [{
    ts: '2026-10-25T10:00:00.000Z',
    errorCode: 'usage_limit',
    model: 'gpt-6.1-sol',
    runPressure: { activeRuns: 3, startsLastMinute: 5, startsLastFiveMinutes: 11 },
  }]);
});

test('Codex and Claude run telemetry capture active work and recent start counts on a 429', () => {
  for (const harness of ['codex', 'claude']) {
    const recorded = [];
    const kernel = createAgentRoomKernel({
      transport: harness,
      persistHistory: () => {},
      recordUsage: (event) => recorded.push(event),
    });
    const room = kernel.createRoomState({ sessionKey: `${harness}-pressure-${process.pid}`, chatId: `${harness}-pressure` });
    kernel.rooms.set(room.sessionKey, room);
    kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-pressure' });
    kernel.broadcastRoom(room, {
      type: 'sdkRunFinished', runId: 'run-pressure', status: 'error',
      lastErrorMessage: 'exceeded retry limit, last status: 429 Too Many Requests',
    });
    const run = recorded.find((event) => event.eventType === 'run');
    assert.equal(run.outcome, 'limit');
    assert.equal(run.harnessRunPressure.activeRuns, 1);
    assert.ok(run.harnessRunPressure.startsLastMinute >= 1);
    assert.ok(run.harnessRunPressure.startsLastFiveMinutes >= run.harnessRunPressure.startsLastMinute);
    kernel.rooms.delete(room.sessionKey);
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
    // `five_hour` is the account window, not the model: the lockout blocks every
    // Claude model, so history records the harness-wide marker instead of the id
    // the room happened to use.
    assert.equal(history[0].model, 'auto');

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
    assert.equal(history[0].model, 'auto', 'the account window locks the harness, not one model');
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
    // A later delivery for an earlier reset window cannot replace the newer one.
    note(null, 4 * 3600000);
    assert.equal(read(4 * 3600000).utilization, 20);
    assert.equal(read(4 * 3600000).resetsAt, new Date(start + 10 * 3600000).toISOString());
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
    assert.equal(noteHarnessPlanLimit({ harness: 'claude', authMode: 'subscription', dataDir }), null);
    assert.equal(noteHarnessPlanLimit({ harness: 'claude', authMode: 'subscription', model: 'claude-sonnet-4-5', dataDir }), null);
    assert.equal(noteHarnessPlanLimit({ harness: 'claude', authMode: 'subscription', observedAt: '2026-10-01T10:00:00Z', dataDir }), null);
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
    noteHarnessPlanLimit({ harness: 'claude', authMode: 'subscription', rateLimitType: 'five_hour', utilization: 40, resetsAt, observedAt: '2026-10-01T10:00:00.000Z', dataDir });
    noteHarnessPlanLimit({ harness: 'claude', authMode: 'subscription', rateLimitType: 'five_hour', utilization: 70, resetsAt, observedAt: '2026-10-01T11:00:00.000Z', dataDir });

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

test('pure forecast keeps harnesses, window types and reset windows apart', () => {
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const at = (min) => new Date(T0 + min * 60_000).toISOString();
  const fiveHour = new Date(T0 + 5 * 3_600_000).toISOString();
  const sevenDay = new Date(T0 + 7 * 86_400_000).toISOString();
  const otherReset = new Date(T0 + 10 * 3_600_000).toISOString();
  const readings = [
    { harness: 'alpha', rateLimitType: 'five_hour', resetsAt: fiveHour, utilization: 20, observedAt: at(0) },
    { harness: 'alpha', rateLimitType: 'five_hour', resetsAt: fiveHour, utilization: 40, observedAt: at(60) },
    { harness: 'beta', rateLimitType: 'five_hour', resetsAt: fiveHour, utilization: 10, observedAt: at(0) },
    { harness: 'beta', rateLimitType: 'five_hour', resetsAt: fiveHour, utilization: 30, observedAt: at(120) },
    { harness: 'alpha', rateLimitType: 'seven_day', resetsAt: sevenDay, utilization: 5, observedAt: at(60) },
    { harness: 'alpha', rateLimitType: 'five_hour', resetsAt: otherReset, utilization: 15, observedAt: at(60) },
  ];
  const windows = forecastPlanWindows({ readings, now: T0 + 2 * 3_600_000 });
  assert.equal(windows.length, 4);
  const pick = (harness, rateLimitType, resetsAt) =>
    windows.find((row) => row.harness === harness
      && row.rateLimitType === rateLimitType && row.resetsAt === resetsAt);

  const alphaFive = pick('alpha', 'five_hour', fiveHour);
  assert.equal(alphaFive.utilization, 40);
  assert.equal(alphaFive.remainingPercent, 60);
  assert.equal(alphaFive.forecast.percentPerHour, 20);
  assert.equal(alphaFive.forecast.exhaustsAt, at(240));
  assert.equal(alphaFive.forecast.beforeReset, true);
  assert.equal(alphaFive.confidence, 'low');

  // A different harness in the same moment has its own rate and reset verdict.
  const betaFive = pick('beta', 'five_hour', fiveHour);
  assert.equal(betaFive.utilization, 30);
  assert.equal(betaFive.forecast.percentPerHour, 10);
  assert.equal(betaFive.forecast.beforeReset, false);
  assert.equal(betaFive.confidence, 'low');

  // Same harness, another window type or another reset: separate and no forecast.
  const alphaSeven = pick('alpha', 'seven_day', sevenDay);
  assert.equal(alphaSeven.utilization, 5);
  assert.equal(alphaSeven.forecast, null);
  assert.equal(alphaSeven.confidence, 'none');
  const alphaOtherReset = pick('alpha', 'five_hour', otherReset);
  assert.equal(alphaOtherReset.utilization, 15);
  assert.equal(alphaOtherReset.forecast, null);
  assert.equal(alphaOtherReset.confidence, 'none');
});

test('token samples never invent a percentage or a forecast without utilization', () => {
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const at = (min) => new Date(T0 + min * 60_000).toISOString();
  const fiveHour = new Date(T0 + 5 * 3_600_000).toISOString();
  const readings = [
    { harness: 'gamma', rateLimitType: 'five_hour', status: 'allowed_warning', resetsAt: fiveHour, observedAt: at(0) },
    { harness: 'gamma', rateLimitType: 'five_hour', status: 'rejected', resetsAt: fiveHour, observedAt: at(60) },
  ];
  const tokenSamples = [
    { harness: 'gamma', at: at(30), totalTokens: 1234 },
    { harness: 'gamma', at: at(45), tokens: { textInput: 10, textOutput: 5 } },
    { harness: 'gamma', at: at(-30), totalTokens: 9999 }, // before the first reading
    { harness: 'delta', at: at(45), totalTokens: 777 }, // another harness
  ];
  const withTokens = forecastPlanWindows({ readings, tokenSamples, now: T0 + 3_600_000 })[0];
  const withoutTokens = forecastPlanWindows({ readings, now: T0 + 3_600_000 })[0];
  assert.equal(withTokens.utilization, null);
  assert.equal(withTokens.remainingPercent, null);
  assert.equal(withTokens.forecast, null);
  assert.equal(withTokens.confidence, 'none');
  assert.equal(withTokens.resetInMs, 4 * 3_600_000);
  assert.equal(withTokens.tokensInWindow, 1249); // 1234 + (10 + 5)
  assert.equal(withoutTokens.tokensInWindow, null);
  assert.deepEqual(
    { utilization: withTokens.utilization, remainingPercent: withTokens.remainingPercent, forecast: withTokens.forecast },
    { utilization: withoutTokens.utilization, remainingPercent: withoutTokens.remainingPercent, forecast: withoutTokens.forecast },
  );
});

test('confidence distinguishes no forecast, thin and well supported windows', () => {
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const at = (min) => new Date(T0 + min * 60_000).toISOString();
  const fiveHour = new Date(T0 + 5 * 3_600_000).toISOString();
  const readings = [];
  for (const harness of ['one']) readings.push({ harness, rateLimitType: 'w', resetsAt: fiveHour, utilization: 10, observedAt: at(0) });
  for (const [index, value] of [10, 30].entries()) readings.push({ harness: 'two', rateLimitType: 'w', resetsAt: fiveHour, utilization: value, observedAt: at(index * 60) });
  for (const [index, value] of [10, 20, 30].entries()) readings.push({ harness: 'three', rateLimitType: 'w', resetsAt: fiveHour, utilization: value, observedAt: at(index * 20) });
  for (const [index, value] of [10, 20, 30].entries()) readings.push({ harness: 'brief', rateLimitType: 'w', resetsAt: fiveHour, utilization: value, observedAt: at(index) });
  const windows = forecastPlanWindows({ readings, now: T0 + 3_600_000 });
  const confidence = (harness) => windows.find((row) => row.harness === harness).confidence;
  assert.equal(confidence('one'), 'none');
  assert.equal(confidence('two'), 'low');
  assert.equal(confidence('three'), 'high');
  assert.equal(confidence('brief'), 'low'); // three points, but the span is too short
});

test('a utilization drop or an expired window yields no forecast', () => {
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const at = (min) => new Date(T0 + min * 60_000).toISOString();
  const fiveHour = new Date(T0 + 5 * 3_600_000).toISOString();
  const drop = forecastPlanWindows({ now: T0 + 3_600_000, readings: [
    { harness: 'drop', rateLimitType: 'w', resetsAt: fiveHour, utilization: 40, observedAt: at(0) },
    { harness: 'drop', rateLimitType: 'w', resetsAt: fiveHour, utilization: 10, observedAt: at(60) },
  ] })[0];
  assert.equal(drop.utilization, 10);
  assert.equal(drop.remainingPercent, 90);
  assert.equal(drop.forecast, null);
  assert.equal(drop.confidence, 'none');

  const expired = forecastPlanWindows({ now: T0 + 6 * 3_600_000, readings: [
    { harness: 'exp', rateLimitType: 'w', resetsAt: fiveHour, utilization: 40, observedAt: at(0) },
    { harness: 'exp', rateLimitType: 'w', resetsAt: fiveHour, utilization: 60, observedAt: at(60) },
  ] })[0];
  assert.equal(expired.expired, true);
  assert.equal(expired.remainingPercent, null);
  assert.equal(expired.forecast, null);
});

test('readHarnessPlanLimits delegates to the pure forecast and stays compatible', () => {
  const dataDir = tempDataDir();
  const T0 = Date.parse('2026-10-05T00:00:00Z');
  const at = (min) => new Date(T0 + min * 60_000).toISOString();
  const fiveHour = new Date(T0 + 5 * 3_600_000).toISOString();
  try {
    noteHarnessPlanLimit({ harness: 'alpha', rateLimitType: 'five_hour', utilization: 20, observedAt: at(0), resetsAt: fiveHour, dataDir });
    noteHarnessPlanLimit({ harness: 'alpha', rateLimitType: 'five_hour', utilization: 40, observedAt: at(60), resetsAt: fiveHour, dataDir });
    noteHarnessPlanLimit({ harness: 'beta', rateLimitType: 'five_hour', status: 'allowed', utilization: 10, observedAt: at(0), resetsAt: fiveHour, dataDir });

    const rows = readHarnessPlanLimits('', {
      dataDir,
      now: T0 + 3_600_000,
      tokenSamples: [{ harness: 'alpha', at: at(30), totalTokens: 500 }],
    });
    const alpha = rows.find((row) => row.harness === 'alpha');
    assert.equal(alpha.utilization, 40);
    assert.equal(alpha.remainingPercent, 60);
    assert.equal(alpha.forecast.percentPerHour, 20);
    assert.equal(alpha.forecast.exhaustsAt, at(240));
    assert.equal(alpha.confidence, 'low');
    assert.equal(alpha.tokensInWindow, 500);
    assert.equal(alpha.stale, false);
    assert.equal(alpha.expired, false);
    assert.equal(alpha.resetInMs, 4 * 3_600_000);
    assert.equal('samples' in alpha, false);

    const beta = rows.find((row) => row.harness === 'beta');
    assert.equal(beta.utilization, 10);
    assert.equal(beta.forecast, null);
    assert.equal(beta.confidence, 'none');
    assert.equal(beta.tokensInWindow, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- Claude plan limits: auth scope, partial readings, ordering, lockouts ---

function claudeKernel(dataDir) {
  return createAgentRoomKernel({
    transport: 'claude',
    persistHistory: () => {},
    recordUsage: () => {},
    usageDataDir: dataDir,
  });
}

function withAuthMode(mode, fn) {
  const previous = process.env.CRETLI_CLAUDE_AUTH_MODE;
  process.env.CRETLI_CLAUDE_AUTH_MODE = mode;
  try {
    return fn();
  } finally {
    process.env.CRETLI_CLAUDE_AUTH_MODE = previous;
  }
}

test('api-key mode neither stores nor shows a plan limit or lockout', () => {
  const dataDir = tempDataDir();
  try {
    withAuthMode('api-key', () => {
      const kernel = claudeKernel(dataDir);
      const room = kernel.createRoomState({ sessionKey: 'k-api', chatId: 'c-api', modelId: 'claude-sonnet-4-5' });
      kernel.broadcastRoom(room, {
        type: 'sdkRunProgress', noticeType: 'rate_limit', status: 'rejected',
        rateLimitType: 'five_hour', utilization: 91, resetsAt: 4_000_000_000, authMode: 'api-key',
      });
      // Also without a stamp: the current auth mode decides.
      kernel.broadcastRoom(room, {
        type: 'sdkRunProgress', noticeType: 'rate_limit', status: 'allowed_warning', utilization: 80,
      });
      assert.deepEqual(readHarnessPlanLimits('claude', { dataDir }), []);
      assert.deepEqual(readHarnessPlanLimitHistory({ harness: 'claude', dataDir }), []);
      assert.deepEqual(readHarnessUsageLimitHistory({ harness: 'claude', dataDir }), []);
      assert.equal(getHarnessUsageLimit({ harness: 'claude', model: 'claude-sonnet-4-5', dataDir }), null);
      // Direct store call is defended too.
      assert.equal(noteHarnessPlanLimit({ harness: 'claude', authMode: 'api-key', status: 'rejected', dataDir }), null);
      // A provider error with limit prose must not write a plan-limit history row.
      noteHarnessUsageLimit({
        harness: 'claude', model: 'claude-sonnet-4-5', authMode: 'api-key',
        message: 'rate limit reached', dataDir,
      });
      assert.deepEqual(readHarnessPlanLimitHistory({ harness: 'claude', dataDir }), []);
      assert.equal(noteHarnessUsageLimit({
        harness: 'claude', model: 'claude-sonnet-4-5', authMode: 'api-key',
        message: "You've hit your session limit · resets 2:30pm", dataDir,
      }), false);
      assert.deepEqual(readHarnessUsageLimitHistory({ harness: 'claude', dataDir }), []);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('subscription snapshots record auth mode and source; one conversion per event', () => {
  const dataDir = tempDataDir();
  try {
    withAuthMode('subscription', () => {
      const kernel = claudeKernel(dataDir);
      const room = kernel.createRoomState({ sessionKey: 'k-sub', chatId: 'c-sub', modelId: 'claude-sonnet-4-5' });
      // Normalized notice already carries percent: not multiplied again.
      kernel.broadcastRoom(room, {
        type: 'sdkRunProgress', noticeType: 'rate_limit', status: 'allowed_warning',
        rateLimitType: 'five_hour', utilization: 40, resetsAt: 4_000_000_000, authMode: 'subscription',
      });
      // A raw SDK event is converted exactly once.
      kernel.broadcastRoom(room, {
        type: 'sdkEvent',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.25, resetsAt: 4_000_100_000 },
        },
      });
      const rows = readHarnessPlanLimits('claude', { dataDir, authMode: 'subscription' });
      const five = rows.find((row) => row.rateLimitType === 'five_hour');
      const seven = rows.find((row) => row.rateLimitType === 'seven_day');
      assert.equal(five.utilization, 40);
      assert.equal(seven.utilization, 25);
      for (const row of [five, seven]) {
        assert.equal(row.authMode, 'subscription');
        assert.equal(row.source, 'claude-sdk-rate-limit-event');
        assert.equal(row.scopeMismatch, undefined);
      }
      const history = readHarnessPlanLimitHistory({ harness: 'claude', dataDir });
      assert.ok(history.every((row) => row.authMode === 'subscription' && row.source === 'claude-sdk-rate-limit-event'));
      assert.equal(readHarnessUsageLimitHistory({ harness: 'claude', dataDir }).length, 0);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a snapshot from another auth scope is not shown as current', () => {
  const dataDir = tempDataDir();
  try {
    noteHarnessPlanLimit({
      harness: 'claude', authMode: 'subscription', rateLimitType: 'five_hour', status: 'allowed_warning',
      utilization: 70, resetsAt: '2099-01-01T00:00:00.000Z', dataDir,
    });
    // Same auth scope: current.
    assert.equal(readHarnessPlanLimits('claude', { dataDir, authMode: 'subscription' })[0].utilization, 70);
    // Switched to API-key: nothing is shown.
    assert.deepEqual(readHarnessPlanLimits('claude', { dataDir, authMode: 'api-key' }), []);
    // A legacy row without a recorded scope cannot be attributed: stale, no percent.
    const legacyDir = tempDataDir();
    try {
      noteHarnessPlanLimit({
        harness: 'claude', rateLimitType: 'five_hour', status: 'allowed_warning',
        utilization: 70, resetsAt: '2099-01-01T00:00:00.000Z', dataDir: legacyDir,
      });
      const [legacy] = readHarnessPlanLimits('claude', { dataDir: legacyDir, authMode: 'subscription' });
      assert.equal(legacy.scopeMismatch, true);
      assert.equal(legacy.stale, true);
      assert.equal('utilization' in legacy, false);
      assert.equal(legacy.remainingPercent, null);
      // The first reading under the current scope replaces it without merging.
      noteHarnessPlanLimit({
        harness: 'claude', authMode: 'subscription', rateLimitType: 'five_hour', status: 'allowed',
        resetsAt: '2099-01-01T00:00:00.000Z', dataDir: legacyDir,
      });
      const [fresh] = readHarnessPlanLimits('claude', { dataDir: legacyDir, authMode: 'subscription' });
      assert.equal(fresh.scopeMismatch, undefined);
      assert.equal('utilization' in fresh, false);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a partial reading keeps the last known percentage with its own age', () => {
  const dataDir = tempDataDir();
  const resetsAt = '2026-10-01T18:00:00.000Z';
  const base = { harness: 'claude', authMode: 'subscription', dataDir };
  try {
    noteHarnessPlanLimit({ ...base, rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 60, resetsAt, observedAt: '2026-10-01T10:00:00.000Z' });
    noteHarnessPlanLimit({ ...base, rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 30, resetsAt: '2026-10-07T00:00:00.000Z', observedAt: '2026-10-01T10:05:00.000Z' });
    // Rejected without a percentage and without a reset for the five-hour window.
    noteHarnessPlanLimit({ ...base, rateLimitType: 'five_hour', status: 'rejected', observedAt: '2026-10-01T11:00:00.000Z' });
    const now = Date.parse('2026-10-01T11:30:00.000Z');
    const rows = readHarnessPlanLimits('claude', { dataDir, authMode: 'subscription', now });
    const five = rows.find((row) => row.rateLimitType === 'five_hour');
    const seven = rows.find((row) => row.rateLimitType === 'seven_day');
    assert.equal(five.status, 'rejected');
    assert.equal(five.utilization, 60);
    assert.equal(five.utilizationObservedAt, '2026-10-01T10:00:00.000Z');
    assert.equal(five.observedAt, '2026-10-01T11:00:00.000Z');
    // No reset was delivered: none is invented.
    assert.equal('resetsAt' in five, false);
    // The other window is untouched.
    assert.equal(seven.utilization, 30);
    assert.equal(seven.status, 'allowed_warning');
    // The carried percentage ages from its own observation, not the rejection.
    const later = readHarnessPlanLimits('claude', {
      dataDir, authMode: 'subscription', rateLimitType: 'five_hour', now: Date.parse('2026-10-01T16:30:01.000Z'),
    }).find((row) => row.rateLimitType === 'five_hour');
    assert.equal(later.stale, true);
    // A reading for a different (new) window does not inherit the old percentage.
    noteHarnessPlanLimit({ ...base, rateLimitType: 'five_hour', status: 'allowed', resetsAt: '2026-10-01T23:00:00.000Z', observedAt: '2026-10-01T19:00:00.000Z' });
    const renewed = readHarnessPlanLimits('claude', { dataDir, authMode: 'subscription', now: Date.parse('2026-10-01T19:10:00.000Z') })
      .find((row) => row.rateLimitType === 'five_hour');
    assert.equal('utilization' in renewed, false);
    assert.equal(renewed.remainingPercent, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an older or earlier-window observation never overwrites a newer snapshot', () => {
  const dataDir = tempDataDir();
  const base = { harness: 'claude', authMode: 'subscription', rateLimitType: 'five_hour', dataDir };
  try {
    noteHarnessPlanLimit({ ...base, status: 'allowed_warning', utilization: 80, resetsAt: '2026-10-01T18:00:00.000Z', observedAt: '2026-10-01T12:00:00.000Z' });
    // Delayed event: older receipt time.
    noteHarnessPlanLimit({ ...base, status: 'allowed', utilization: 10, resetsAt: '2026-10-01T18:00:00.000Z', observedAt: '2026-10-01T11:00:00.000Z' });
    // Delivered later but belongs to an earlier reset window.
    noteHarnessPlanLimit({ ...base, status: 'allowed', utilization: 5, resetsAt: '2026-10-01T13:00:00.000Z', observedAt: '2026-10-01T12:30:00.000Z' });
    const [row] = readHarnessPlanLimits('claude', { dataDir, authMode: 'subscription', now: Date.parse('2026-10-01T12:40:00.000Z') });
    assert.equal(row.utilization, 80);
    assert.equal(row.status, 'allowed_warning');
    assert.equal(row.resetsAt, '2026-10-01T18:00:00.000Z');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('only rejected on a plan window creates a lockout; reset source is recorded', () => {
  const dataDir = tempDataDir();
  try {
    withAuthMode('subscription', () => {
      const kernel = claudeKernel(dataDir);
      const room = kernel.createRoomState({ sessionKey: 'k-lock', chatId: 'c-lock', modelId: 'claude-sonnet-4-5' });
      const notice = (extra) => kernel.broadcastRoom(room, {
        type: 'sdkRunProgress', noticeType: 'rate_limit', authMode: 'subscription', ...extra,
      });
      const lockCount = () => readHarnessUsageLimitHistory({ harness: 'claude', dataDir }).length;
      notice({ status: 'allowed', rateLimitType: 'five_hour' });
      notice({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 90 });
      notice({ rateLimitType: 'five_hour', utilization: 95 });
      // The overage lane is a different meter.
      notice({ status: 'rejected', rateLimitType: 'overage' });
      // Ordinary run errors and a bare 429 are not plan limits.
      kernel.broadcastRoom(room, { type: 'sdkRunFinished', status: 'error', result: 'Something exploded' });
      kernel.broadcastRoom(room, { type: 'sdkRunFinished', status: 'error', result: 'API Error: 429' });
      assert.equal(lockCount(), 0);
      assert.equal(getHarnessUsageLimit({ harness: 'claude', model: 'claude-sonnet-4-5', dataDir }), null);

      // Rejected without a provider reset: lockout with a technical fallback.
      notice({ status: 'rejected', rateLimitType: 'five_hour' });
      assert.equal(lockCount(), 1);
      const fallback = getHarnessUsageLimit({ harness: 'claude', model: 'claude-sonnet-4-5', dataDir });
      assert.equal(fallback.resetSource, 'fallback-ttl');
      assert.equal(fallback.rateLimitType, 'five_hour');
      assert.equal(fallback.authMode, 'subscription');
      assert.equal(fallback.source, 'rate-limit-event');
      // The fallback is not written to the plan snapshot as a reset.
      const snap = readHarnessPlanLimits('claude', { dataDir, authMode: 'subscription' })
        .find((row) => row.rateLimitType === 'five_hour');
      assert.equal('resetsAt' in snap, false);
      // Neither reading ever carried a reset: the unknown window keeps the
      // last known percentage (95) with its own age instead of dropping it.
      assert.equal('utilization' in snap, true);
      assert.equal(snap.utilization, 95);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
