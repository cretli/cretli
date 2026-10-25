import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideWorkspaceWatcherAction, resetWorkspaceWatcherOrchestratorCooldown } from '../lib/workspace-watcher.js';
import { buildWorkspaceWatcherCycleClosePatch } from '../lib/workspace-watcher-cycle-close.js';
import { resolveWorkspaceWatcherOrchestrator, recordWorkspaceWatcherCycleRunEnd } from '../lib/workspace-watcher-cycle.js';
import {
  WORKSPACE_WATCHER_ORCHESTRATOR_COOLDOWN_TTL_MS,
  WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK,
  classifyWorkspaceWatcherCycleInfraCause,
  evaluateWorkspaceWatcherGuardrails,
} from '../lib/workspace-watcher-guardrails.js';
import {
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { clearWorkspaceWatcherLoopStop } from '../lib/workspace-watcher-control.js';
import { captureRunEnd } from '../lib/usage/run-end-snapshot.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const policy = { maxParallel: 2, requirePlanApproval: false, cooldownMs: 0, backoffBaseMs: 60_000, backoffCapMs: 3_600_000 };
const TODO = 'todo-1';

function baseRow(extra = {}) {
  return normalizeWorkspaceWatcherRow({ workspaceFolder: '/tmp/my-app', mode: 'autopilot', policy, ...extra });
}

/** A live slot as the close sees it; `runEnd` is the real run-end snapshot. */
function cycle(n, { harness = 'h1', model = 'm1', runEnd, reportedOutcome = '' } = {}) {
  return {
    cycleId: `c${n}`,
    chatId: `chat${n}`,
    runId: `run${n}`,
    todoIds: [TODO],
    startedAt: new Date(T0).toISOString(),
    harness,
    requestedHarness: harness,
    requestedModel: model,
    reportedOutcome,
    ...(runEnd ? { runEnd } : {}),
  };
}

const shortError = (extra = {}) => ({ status: 'error', durationMs: 10_000, errorCode: 'provider_down', errorSource: 'provider', outputSeen: false, errorStage: 'unknown', ...extra });

/** Closes one cycle at `now` and folds the patch into the row (as the store does). */
function close(row, c, { outcome = 'failure', now = T0, reason = 'missing_report' } = {}) {
  const live = normalizeWorkspaceWatcherRow({ ...row, activeCycles: [...(row.activeCycles || []), c] });
  const patch = buildWorkspaceWatcherCycleClosePatch({ row: live, cycle: c, outcome, decisionReason: reason, now });
  return normalizeWorkspaceWatcherRow({ ...live, ...patch });
}

function failInfra(row, n, now = T0, runEnd = shortError(), model = 'm1') {
  return close(row, cycle(n, { model, runEnd }), { now });
}

test('three infra failures on one model cool it down; the next pick uses another model, or the pool is empty', async () => {
  let row = baseRow();
  row = failInfra(row, 1, T0);
  row = failInfra(row, 2, T0 + 1000);
  assert.equal(row.orchestratorCooldowns.length, 0, 'two failures are below the threshold');
  row = failInfra(row, 3, T0 + 2000);
  assert.equal(row.orchestratorCooldowns.length, 1);
  const cool = row.orchestratorCooldowns[0];
  assert.deepEqual([cool.harness, cool.model, cool.scope], ['h1', 'm1', 'model']);
  assert.equal(Date.parse(cool.until) - (T0 + 2000), WORKSPACE_WATCHER_ORCHESTRATOR_COOLDOWN_TTL_MS);

  const catalog = [{ id: 'h1', enabled: true, ready: true, can_delegate: true }];
  const deps = (items) => ({
    listHarnessCatalog: async () => catalog,
    listHarnessModels: async () => ({ favorites_configured: true, items }),
    mcpCapabilityProbe: () => ({ ok: true }),
  });
  const two = await resolveWorkspaceWatcherOrchestrator({
    watcher: { ...row, policy: { ...policy, allowedHarnesses: ['h1'] } },
    now: T0 + 3000,
    deps: deps([{ id: 'm1', roles: ['implement'] }, { id: 'm2', roles: ['implement'] }]),
  });
  assert.equal(two.ok, true);
  assert.equal(two.model, 'm2');
  const one = await resolveWorkspaceWatcherOrchestrator({
    watcher: { ...row, policy: { ...policy, allowedHarnesses: ['h1'] } },
    now: T0 + 3000,
    deps: deps([{ id: 'm1', roles: ['implement'] }]),
  });
  assert.equal(one.ok, false);
  assert.equal(one.reason, WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK);
  const expired = await resolveWorkspaceWatcherOrchestrator({
    watcher: { ...row, policy: { ...policy, allowedHarnesses: ['h1'] } },
    now: T0 + 2000 + WORKSPACE_WATCHER_ORCHESTRATOR_COOLDOWN_TTL_MS + 1,
    deps: deps([{ id: 'm1', roles: ['implement'] }]),
  });
  assert.equal(expired.ok, true, 'cooldown expires after the TTL');
});

test('a short todo-incomplete failure is not infra: it raises failures and does not count', () => {
  let row = baseRow();
  const c = cycle(1, { reportedOutcome: 'success', runEnd: { status: 'completed', durationMs: 5_000 } });
  row = close(row, c, { reason: 'cycle_no_progress' });
  assert.equal(row.failures[TODO], 1);
  assert.deepEqual(row.infraStreaks, {});
  assert.equal(row.cycleChats.at(-1).cause, 'todo_incomplete');
  assert.equal(classifyWorkspaceWatcherCycleInfraCause({ outcome: 'failure', cycle: c, closeReason: 'cycle_no_progress' }).streak, 'reset');
});

test('success resets the streak; long failure, cancel and unknown cause have explicit rules', () => {
  let row = failInfra(failInfra(baseRow(), 1), 2);
  assert.equal(Object.values(row.infraStreaks)[0].count, 2);
  // unknown cause (no run-end snapshot): ignored, failures raised
  const unknown = close(row, cycle(3), {});
  assert.equal(Object.values(unknown.infraStreaks)[0].count, 2);
  assert.equal(unknown.failures[TODO], 1);
  assert.equal(unknown.cycleChats.at(-1).cause, 'unknown');
  // cancelled: ignored
  const cancelled = close(row, cycle(4, { runEnd: { status: 'cancelled', durationMs: 1000 } }), {});
  assert.equal(Object.values(cancelled.infraStreaks)[0].count, 2);
  assert.equal(cancelled.cycleChats.at(-1).cause, 'cancelled');
  // long failure: resets, raises failures
  const long = close(row, cycle(5, { runEnd: shortError({ durationMs: 10 * 60_000 }) }), {});
  assert.deepEqual(long.infraStreaks, {});
  assert.equal(long.failures[TODO], 1);
  assert.equal(long.cycleChats.at(-1).cause, 'long_failure');
  // error after output is work done: not infra
  const afterOutput = close(row, cycle(6, { runEnd: shortError({ outputSeen: true }) }), {});
  assert.deepEqual(afterOutput.infraStreaks, {});
  // success: resets streak and the infra backoff
  const ok = close(row, cycle(7), { outcome: 'success', reason: 'completed' });
  assert.deepEqual(ok.infraStreaks, {});
  assert.equal(ok.infraBackoffUntil, '');
});

test('the first infra failure keeps todo failures at zero but arms its own backoff', () => {
  const row = failInfra(baseRow(), 1, T0);
  assert.equal(row.failures[TODO], undefined);
  assert.equal(row.backoffUntil, '');
  assert.equal(Date.parse(row.infraBackoffUntil), T0 + 60_000);
  const waiting = evaluateWorkspaceWatcherGuardrails({ watcher: row, now: T0 + 30_000 });
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.reason, 'failure_backoff');
  const free = evaluateWorkspaceWatcherGuardrails({ watcher: row, now: T0 + 61_000 });
  assert.equal(free.allowed, true);
  // second failure doubles
  const second = failInfra(row, 2, T0 + 61_000);
  assert.equal(Date.parse(second.infraBackoffUntil), T0 + 61_000 + 120_000);
  // the todo is never blocked by infra errors
  assert.equal(Object.keys(second.failures).length, 0);
});

test('parallel closes fold deterministically and one run increments the streak once', () => {
  const a = cycle(1, { runEnd: shortError() });
  const b = cycle(2, { runEnd: shortError() });
  let row = baseRow({ activeCycles: [a, b] });
  const patchA = buildWorkspaceWatcherCycleClosePatch({ row, cycle: a, outcome: 'failure', decisionReason: 'missing_report', now: T0 });
  row = normalizeWorkspaceWatcherRow({ ...row, ...patchA });
  const patchB = buildWorkspaceWatcherCycleClosePatch({ row, cycle: b, outcome: 'failure', decisionReason: 'missing_report', now: T0 + 5 });
  row = normalizeWorkspaceWatcherRow({ ...row, ...patchB });
  assert.equal(Object.values(row.infraStreaks)[0].count, 2);
  // replaying the close of run1 (duplicate close) does not count it again
  const replay = buildWorkspaceWatcherCycleClosePatch({ row, cycle: a, outcome: 'failure', decisionReason: 'missing_report', now: T0 + 10 });
  assert.equal(Object.values(replay.infraStreaks)[0].count, 2);
});

test('explicit policy.orchestrator pointing at a cooled model stops instead of swapping', async () => {
  let row = baseRow();
  for (let i = 1; i <= 3; i += 1) row = failInfra(row, i, T0 + i);
  const verdict = await resolveWorkspaceWatcherOrchestrator({
    watcher: { ...row, policy: { ...policy, orchestrator: { harness: 'h1', model: 'm1' }, allowedHarnesses: ['h1'] } },
    now: T0 + 1000,
    deps: {
      listHarnessCatalog: async () => [{ id: 'h1', enabled: true, ready: true, can_delegate: true }],
      listHarnessModels: async () => ({ favorites_configured: true, items: [{ id: 'm1', roles: ['implement'] }, { id: 'm2', roles: ['implement'] }] }),
      mcpCapabilityProbe: () => ({ ok: true }),
    },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'orchestrator_infra_cooldown');
  assert.equal(verdict.cooldown.model, 'm1');
});

test('a 10 s failure closed by reconcile after 2 minutes is recognised as short', () => {
  const c = cycle(1, { runEnd: shortError({ durationMs: 10_000 }) });
  const closeAt = T0 + 130_000;
  const row = close(baseRow(), c, { now: closeAt });
  assert.equal(row.cycleChats.at(-1).runDurationMs, 10_000, 'real run duration, not close time - start');
  assert.ok(Date.parse(row.cycleChats.at(-1).at) - Date.parse(c.startedAt) >= 120_000);
  assert.equal(row.cycleChats.at(-1).cause, 'infra:provider_down');
  assert.equal(row.cycleChats.at(-1).model, 'm1');
  assert.equal(Object.values(row.infraStreaks)[0].count, 1);
});

test('harness is cooled only with the same cause on at least two models', () => {
  let row = baseRow();
  for (let i = 1; i <= 3; i += 1) row = failInfra(row, i, T0 + i, shortError(), 'm1');
  assert.equal(row.orchestratorCooldowns.some((e) => e.scope === 'harness'), false);
  // different cause on a second model: model cooldown only
  for (let i = 4; i <= 6; i += 1) row = failInfra(row, i, T0 + i, shortError({ errorCode: 'other' }), 'm2');
  assert.equal(row.orchestratorCooldowns.some((e) => e.scope === 'harness'), false);
  // same cause on a third model: harness-wide
  for (let i = 7; i <= 9; i += 1) row = failInfra(row, i, T0 + i, shortError(), 'm3');
  const harnessCooldown = row.orchestratorCooldowns.find((e) => e.scope === 'harness');
  assert.ok(harnessCooldown);
  assert.equal(harnessCooldown.harness, 'h1');
});

test('state survives a reload, manual reset works and clearing stopReason keeps the cooldown', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-breaker-'));
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws);
  upsertWorkspaceWatcher(ws, { mode: 'autopilot', policy }, { dataDir });
  let row = getWorkspaceWatcher(ws, { dataDir });
  for (let i = 1; i <= 3; i += 1) row = failInfra(row, i, Date.now());
  upsertWorkspaceWatcher(ws, {
    infraBackoffUntil: row.infraBackoffUntil,
    infraStreaks: row.infraStreaks,
    orchestratorCooldowns: row.orchestratorCooldowns,
    stopReason: WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK,
  }, { dataDir });
  // "process restart": read back from the store
  const reloaded = getWorkspaceWatcher(ws, { dataDir });
  assert.equal(reloaded.orchestratorCooldowns.length, 1);
  assert.ok(Date.parse(reloaded.infraBackoffUntil) > 0);
  // clearing stopReason (plain and loop-stop variant) keeps the cooldown
  upsertWorkspaceWatcher(ws, { stopReason: '' }, { dataDir });
  clearWorkspaceWatcherLoopStop({ dataDir, workspaceFolder: ws });
  const cleared = getWorkspaceWatcher(ws, { dataDir });
  assert.equal(cleared.stopReason, '');
  assert.equal(cleared.orchestratorCooldowns.length, 1, 'stopReason clear must not clear the cooldown');
  // manual reset
  resetWorkspaceWatcherOrchestratorCooldown({ dataDir, workspaceFolder: ws });
  const reset = getWorkspaceWatcher(ws, { dataDir });
  assert.deepEqual(reset.orchestratorCooldowns, []);
  assert.equal(reset.infraBackoffUntil, '');
  assert.equal(reset.decisions.at(-1).kind, 'orchestrator_cooldown_reset');
  void mutateWorkspaceWatcherRow;
});

test('run-end snapshot is stamped on the live slot once and used by the close', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-breaker-'));
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws);
  upsertWorkspaceWatcher(ws, { mode: 'autopilot', policy, activeCycles: [cycle(1)] }, { dataDir });
  const stamped = recordWorkspaceWatcherCycleRunEnd({
    workspaceFolder: ws, dataDir, cycleId: 'c1', snapshot: { status: 'error', durationMs: 9000, durationKnown: true, errorCode: 'x', errorSource: 'provider', outputSeen: false, errorStage: 'unknown' },
  });
  assert.equal(stamped, true);
  const again = recordWorkspaceWatcherCycleRunEnd({ workspaceFolder: ws, dataDir, cycleId: 'c1', snapshot: { status: 'completed', durationMs: 1 } });
  assert.equal(again, false);
  const live = getWorkspaceWatcher(ws, { dataDir });
  assert.equal(live.activeCycles[0].runEnd.durationMs, 9000);
  const closed = close(live, live.activeCycles[0], { now: T0 + 130_000 });
  assert.equal(closed.cycleChats.at(-1).runDurationMs, 9000);
  void decideWorkspaceWatcherAction;
});

test('the real captureRunEnd hook stamps the cycle slot: a 10 s failure closed 2 min later is short infra', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-breaker-'));
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws);
  upsertWorkspaceWatcher(ws, { mode: 'autopilot', policy, activeCycles: [cycle(1)] }, { dataDir });
  // Another chat's run end is a no-op for the watcher.
  captureRunEnd({ room: { chatId: 'other-chat', _runStartedAt: Date.now() - 1000 }, harness: 'h1', model: 'm1', payload: { status: 'error', lastErrorMessage: 'boom' }, dataDir });
  assert.equal(getWorkspaceWatcher(ws, { dataDir }).activeCycles[0].runEnd, undefined);
  const room = { chatId: 'chat1', _runStartedAt: Date.now() - 10_000 };
  captureRunEnd({ room, harness: 'h1', model: 'm1', payload: { status: 'error', lastErrorCode: 'provider_down', lastErrorMessage: 'upstream unavailable' }, dataDir });
  const live = getWorkspaceWatcher(ws, { dataDir });
  const runEnd = live.activeCycles[0].runEnd;
  assert.equal(runEnd.status, 'error');
  assert.ok(runEnd.durationMs >= 9_000 && runEnd.durationMs < 20_000);
  const closed = close(live, live.activeCycles[0], { now: Date.parse(live.activeCycles[0].startedAt) + 130_000 });
  const entry = closed.cycleChats.at(-1);
  assert.match(entry.cause, /^infra:/);
  assert.ok(entry.runDurationMs < 20_000);
  assert.deepEqual(closed.failures, {});
  assert.equal(Object.values(closed.infraStreaks)[0].count, 1);
});

test('watcher_update reset_orchestrator_cooldown clears cooldowns through the control path', async () => {
  const dataDir = ISOLATED_DATA_DIR;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-breaker-ws-'));
  const until = new Date(Date.now() + 3_600_000).toISOString();
  upsertWorkspaceWatcher(ws, {
    mode: 'autopilot',
    policy,
    orchestratorCooldowns: [
      { harness: 'h1', model: 'm1', scope: 'model', cause: 'infra:x', since: until, until },
      { harness: 'h2', model: 'm2', scope: 'model', cause: 'infra:x', since: until, until },
    ],
  }, { dataDir });
  const client = createInProcessMcpClient({ chatId: 'reset-chat' });
  const one = await client.workspaceWatcherUpdate({ action: 'reset_orchestrator_cooldown', workspaceFolder: ws, harness: 'h1', model: 'm1' });
  assert.equal(one.ok, true);
  assert.deepEqual(getWorkspaceWatcher(ws, { dataDir }).orchestratorCooldowns.map((e) => e.harness), ['h2']);
  await client.workspaceWatcherUpdate({ action: 'reset_orchestrator_cooldown', workspaceFolder: ws });
  assert.deepEqual(getWorkspaceWatcher(ws, { dataDir }).orchestratorCooldowns, []);
});
