/**
 * Workspace Watcher durable cycle-metrics store.
 *
 * Covers the acceptance criteria of the "keep orchestrator model identity and
 * cycle history" leaf: legacy records stay unknown, a start that never reaches
 * `running` still records the requested pair, a full record round-trips through
 * the normalizers, a duplicate close never creates a second metric, retention is
 * explicit, and a telemetry-store failure never breaks a cycle.
 *
 * Uses a scratch data dir per case so no live project data is touched.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  acquireWorkspaceWatcherLease,
  getWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import {
  normalizeWorkspaceWatcherCycleMetric,
  beginWorkspaceWatcherCycleMetric,
  stampWorkspaceWatcherCycleMetricRequest,
  markWorkspaceWatcherCycleMetricRunning,
  finalizeWorkspaceWatcherCycleMetric,
  loadWorkspaceWatcherCycleMetrics,
  getWorkspaceWatcherCycleMetric,
  getWorkspaceWatcherCycleMetricsStatus,
  pruneWorkspaceWatcherCycleMetrics,
  recordWorkspaceWatcherCycleMetricsError,
  WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS,
} from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';
import {
  beginWorkspaceWatcherCycleMetric as beginSafely,
  readWorkspaceWatcherCycleMetricsStatus,
} from '../lib/workspace-watcher-cycle-metrics.js';
import { startWorkspaceWatcherCycle, reportWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cycle-metrics-'));

/**
 * @param {string} name
 * @returns {string}
 */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} name
 * @returns {string}
 */
function makeWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} title
 * @returns {object}
 */
function addReadyTodo(dataDir, cwd, title) {
  return addTodo(dataDir, cwd, { title, status: 'ready' }).item;
}

/**
 * @param {string} cwd
 * @param {string} dataDir
 * @returns {object}
 */
function setAutopilot(cwd, dataDir) {
  return upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 50,
      maxParallel: 5,
      maxConsecutiveFailures: 3,
    },
  }, { dataDir });
}

/**
 * Fabricate a live cycle slot carrying the full orchestrator identity, without
 * starting a chat run.
 *
 * @param {string} cwd
 * @param {string} dataDir
 * @param {{ cycleId: string, chatId: string, todoId: string, mode?: string, requestedHarness?: string, requestedModel?: string, requestedSource?: string }} input
 * @returns {void}
 */
function seedActiveCycle(cwd, dataDir, input) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      cycleId: input.cycleId,
      todoIds: [input.todoId],
      startedAt: iso(T0),
      chatId: input.chatId,
      runId: 'run-seed',
      phase: 'running',
      mode: input.mode || 'implement',
      planOnly: input.mode === 'plan',
      requestedHarness: input.requestedHarness ?? null,
      requestedModel: input.requestedModel ?? null,
      requestedSource: input.requestedSource ?? null,
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir });
}

test('legacy records keep unknown model/source as null instead of guessing', () => {
  const legacy = normalizeWorkspaceWatcherCycleMetric({
    cycleId: 'c-legacy',
    todoIds: ['t1'],
    startedAt: iso(T0),
    closedAt: iso(T0 + 60_000),
    closeOutcome: 'success',
  });
  assert.equal(legacy.mode, null);
  assert.equal(legacy.requestedHarness, null);
  assert.equal(legacy.requestedModel, null);
  assert.equal(legacy.requestedSource, null);
  assert.equal(legacy.model, null);
  assert.equal(legacy.phase, 'closed');

  // Legacy active slot: `mode` derives from the authoritative planOnly flag,
  // but requested identity stays null (never inferred from current policy).
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/legacy-ws',
    activeCycle: { cycleId: 'c1', chatId: 'chat', todoIds: ['t'], startedAt: iso(T0), runId: '', planOnly: true },
  });
  assert.equal(row.activeCycles[0].mode, 'plan');
  assert.equal(row.activeCycles[0].requestedHarness, null);
  assert.equal(row.activeCycles[0].requestedModel, null);
  assert.equal(row.activeCycles[0].requestedSource, null);

  // Legacy cycleChats entry: new fields stay null.
  const historyRow = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/legacy-ws-2',
    cycleChats: [{ id: 'chat-1', cycleId: 'c1', outcome: 'success', startedAt: iso(T0), at: iso(T0 + 30_000) }],
  });
  assert.equal(historyRow.cycleChats[0].mode, null);
  assert.equal(historyRow.cycleChats[0].requestedModel, null);
  assert.equal(historyRow.cycleChats[0].closeSource, null);
});

test('a full metrics record round-trips through the normalizer', () => {
  const input = {
    cycleId: 'c-round-trip',
    workspaceFolder: '/w',
    mode: 'implement',
    orchestratorChatId: 'chat-1',
    orchestratorRunId: 'run-1',
    todoIds: ['t1', 't2'],
    claimedTodoIds: ['t1', 't2'],
    reportedTodoIds: ['t1'],
    unknownReportedTodoIds: [],
    completedTodoIds: ['t1'],
    todoOutcomes: [{
      todoId: 't1',
      claimed: true,
      reported: true,
      planTarget: false,
      outcome: 'completed',
      status: 'done',
      planSaved: false,
      readError: null,
    }],
    planOnly: false,
    planSaved: false,
    blockedReasonCode: null,
    requestedHarness: 'claude',
    requestedModel: 'sonnet',
    requestedSource: 'policy',
    harness: 'claude',
    model: null,
    usage: null,
    usageProvisional: false,
    usageFinalized: false,
    usageFinalizedAt: null,
    usageExpired: false,
    startedAt: iso(T0),
    closedAt: iso(T0 + 120_000),
    closeSource: 'report',
    closeReason: 'cycle_success',
    reportedOutcome: 'success',
    closeOutcome: 'success',
    todoStatusAtClose: 'done',
    reachedRunning: true,
    phase: 'closed',
    createdAt: iso(T0),
    updatedAt: iso(T0 + 120_000),
  };
  assert.deepEqual(normalizeWorkspaceWatcherCycleMetric(input), input);

  // New fields also round-trip on the bounded row collections.
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/round-trip-ws',
    activeCycles: [{
      cycleId: 'c-rt', chatId: 'chat', todoIds: ['t'], startedAt: iso(T0), runId: 'r', phase: 'running',
      mode: 'implement', requestedHarness: 'mock', requestedModel: 'cheap', requestedSource: 'implement_pick',
    }],
    cycleChats: [{
      id: 'chat', cycleId: 'c-rt', todoIds: ['t'], startedAt: iso(T0), at: iso(T0 + 1000), outcome: 'success',
      harness: 'mock', mode: 'implement', requestedHarness: 'mock', requestedModel: 'cheap',
      requestedSource: 'implement_pick', closeSource: 'reconcile',
    }],
  });
  assert.equal(row.activeCycles[0].requestedModel, 'cheap');
  assert.equal(row.activeCycles[0].requestedSource, 'implement_pick');
  assert.equal(row.cycleChats[0].mode, 'implement');
  assert.equal(row.cycleChats[0].requestedHarness, 'mock');
  assert.equal(row.cycleChats[0].closeSource, 'reconcile');
});

test('begin/stamp/markRunning/finalize persists one record; duplicate close is a no-op', () => {
  const dataDir = freshDataDir('idempotency');
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'cy-1',
    workspaceFolder: '/w',
    mode: 'implement',
    orchestratorChatId: 'chat-1',
    todoIds: ['t1'],
    startedAt: iso(T0),
  });
  stampWorkspaceWatcherCycleMetricRequest({
    dataDir,
    cycleId: 'cy-1',
    requestedHarness: 'mock',
    requestedModel: 'cheap',
    requestedSource: 'implement_pick',
  });
  markWorkspaceWatcherCycleMetricRunning({ dataDir, cycleId: 'cy-1', orchestratorRunId: 'run-1', harness: 'mock' });
  const first = finalizeWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'cy-1',
    closeSource: 'report',
    closeOutcome: 'success',
    closeReason: 'cycle_success',
    todoStatusAtClose: 'done',
    closedAt: iso(T0 + 60_000),
  });
  assert.equal(first.replay, false);
  assert.equal(first.created, false);
  assert.ok(first.record);

  // A duplicate close with the same cycleId must not create a second metric.
  const second = finalizeWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'cy-1',
    closeSource: 'reconcile',
    closeOutcome: 'failure',
    closedAt: iso(T0 + 999_999),
  });
  assert.equal(second.replay, true);

  const records = loadWorkspaceWatcherCycleMetrics({ dataDir }).records.filter((record) => record.cycleId === 'cy-1');
  assert.equal(records.length, 1);
  const record = getWorkspaceWatcherCycleMetric('cy-1', { dataDir });
  assert.equal(record.requestedModel, 'cheap');
  assert.equal(record.requestedSource, 'implement_pick');
  assert.equal(record.orchestratorRunId, 'run-1');
  assert.equal(record.closeSource, 'report');
  assert.equal(record.closeOutcome, 'success');
  assert.equal(record.closedAt, iso(T0 + 60_000), 'the first close wins');
  assert.equal(record.phase, 'closed');
  assert.equal(record.reachedRunning, true);
  assert.ok(loadWorkspaceWatcherCycleMetrics({ dataDir }).collectionStartedAt);
});

test('a start that fails before running still records the requested pair as an abort', async () => {
  const dataDir = freshDataDir('failed-start');
  const cwd = makeWorkspace('failed-start');
  const todo = addReadyTodo(dataDir, cwd, 'doomed');
  setAutopilot(cwd, dataDir);
  const deps = {
    addChat: (_s, _t, _wf, _f, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => {
      const error = new Error('adapter down');
      error.code = 'adapter_unavailable';
      throw error;
    },
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'implement_pick' }),
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
    notify: () => false,
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'failed-start', deps });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'start_failed');

  const records = loadWorkspaceWatcherCycleMetrics({ dataDir }).records;
  assert.equal(records.length, 1, 'the aborted start still lands in the store');
  const record = records[0];
  assert.equal(record.requestedHarness, 'mock');
  assert.equal(record.requestedModel, 'cheap');
  assert.equal(record.requestedSource, 'implement_pick');
  assert.equal(record.mode, 'implement');
  assert.equal(record.orchestratorChatId !== null, true);
  assert.equal(record.closeSource, 'abort');
  assert.equal(record.reachedRunning, false);
  assert.equal(record.closeOutcome, null);
});

test('report close writes exactly one metric and a replay does not add another', () => {
  const dataDir = freshDataDir('report-metric');
  const cwd = makeWorkspace('report-metric');
  const todo = addReadyTodo(dataDir, cwd, 'report me');
  updateTodo(dataDir, cwd, todo.id, {
    status: 'doing',
    claimedByChatId: 'orch-1',
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, {
    cycleId: 'c-report',
    chatId: 'orch-1',
    todoId: todo.id,
    mode: 'implement',
    requestedHarness: 'claude',
    requestedModel: 'sonnet',
    requestedSource: 'policy',
  });
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'c-report',
    workspaceFolder: cwd,
    mode: 'implement',
    orchestratorChatId: 'orch-1',
    todoIds: [todo.id],
    startedAt: iso(T0),
  });
  stampWorkspaceWatcherCycleMetricRequest({
    dataDir,
    cycleId: 'c-report',
    requestedHarness: 'claude',
    requestedModel: 'sonnet',
    requestedSource: 'policy',
  });
  updateTodo(dataDir, cwd, todo.id, { status: 'done', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });

  const first = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-1',
    outcome: 'success',
    todoIds: [todo.id],
    cycleId: 'c-report',
    reportId: 'c-report',
  });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.closed, true);

  // A replay (same cycleId/reportId) is a no-op and must not touch the metric.
  const replay = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    sourceChatId: 'orch-1',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'c-report',
    reportId: 'c-report',
  });
  assert.equal(replay.replayed, true);

  const records = loadWorkspaceWatcherCycleMetrics({ dataDir }).records.filter((record) => record.cycleId === 'c-report');
  assert.equal(records.length, 1);
  assert.equal(records[0].closeSource, 'report');
  assert.equal(records[0].closeOutcome, 'success');
  assert.equal(records[0].requestedModel, 'sonnet');
  assert.equal(records[0].todoStatusAtClose, 'done');

  // The bounded cycleChats entry also carries the orchestrator identity.
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycleChats[0].mode, 'implement');
  assert.equal(row.cycleChats[0].requestedModel, 'sonnet');
  assert.equal(row.cycleChats[0].closeSource, 'report');
});

test('retention prunes by age and caps by size, never dropping live records', () => {
  const now = T0;
  const retentionMs = 1000;
  const records = {
    ancient: { cycleId: 'ancient', startedAt: iso(now - 5000), closedAt: iso(now - 4000) },
    fresh1: { cycleId: 'fresh1', startedAt: iso(now - 300), closedAt: iso(now - 200) },
    fresh2: { cycleId: 'fresh2', startedAt: iso(now - 200), closedAt: iso(now - 100) },
    live: { cycleId: 'live', startedAt: iso(now - 50) },
  };
  const pruned = pruneWorkspaceWatcherCycleMetrics(records, { now, retentionMs, maxRecords: 2 });
  assert.equal(pruned.ancient, undefined, 'a settled record past retention is dropped');
  assert.ok(pruned.live, 'a live record is never dropped by the size cap');
  assert.ok(pruned.fresh2, 'the newest settled record survives the cap');
  assert.equal(Object.keys(pruned).length, 2);

  // The status exposes the explicit history range and retention.
  const dataDir = freshDataDir('retention-status');
  beginWorkspaceWatcherCycleMetric({ dataDir, cycleId: 'r1', workspaceFolder: '/w', startedAt: iso(T0 - 10_000) });
  finalizeWorkspaceWatcherCycleMetric({ dataDir, cycleId: 'r1', closeSource: 'abort', closedAt: iso(T0) });
  const status = getWorkspaceWatcherCycleMetricsStatus({ dataDir });
  assert.equal(status.recordCount, 1);
  assert.equal(status.openCount, 0);
  assert.equal(status.oldestStartedAt, iso(T0 - 10_000));
  assert.equal(status.newestStartedAt, iso(T0 - 10_000));
  assert.equal(status.retention.ms, WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS);
  assert.ok(status.collectionStartedAt);
});

test('a telemetry-store failure is isolated, visible, and never breaks a start', async () => {
  const dataDir = freshDataDir('telemetry-failure');
  const cwd = makeWorkspace('telemetry-failure');
  const todo = addReadyTodo(dataDir, cwd, 'still starts');
  setAutopilot(cwd, dataDir);

  // A store that fails every write but still records the limitation.
  const failingStore = {
    beginWorkspaceWatcherCycleMetric() { throw new Error('disk full'); },
    stampWorkspaceWatcherCycleMetricRequest() { throw new Error('disk full'); },
    markWorkspaceWatcherCycleMetricRunning() { throw new Error('disk full'); },
    finalizeWorkspaceWatcherCycleMetric() { throw new Error('disk full'); },
    // Delegate to the real store so the limitation is durable.
    recordWorkspaceWatcherCycleMetricsError: (input) => recordWorkspaceWatcherCycleMetricsError(input),
  };
  // The direct wrapper never throws.
  const direct = beginSafely({ cycleId: 'x', workspaceFolder: cwd, dataDir }, { cycleMetricsStore: failingStore });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.message, 'disk full');

  const deps = {
    cycleMetricsStore: failingStore,
    addChat: (_s, _t, _wf, _f, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => ({ runId: 'run-ok', accepted: true }),
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'telemetry', deps });
  assert.equal(started.started, true, 'a broken telemetry store does not interrupt the cycle');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');

  // The failure is visible as a durable limitation.
  const status = readWorkspaceWatcherCycleMetricsStatus({ dataDir });
  assert.ok(status.lastError);
  assert.equal(status.lastError.lastMessage, 'disk full');
  assert.ok(status.lastError.count >= 1);
});
