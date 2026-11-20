/**
 * Leaf R8 — boot readiness gate. Reconciliation-dependent work (the delegation
 * runtime worker, the watcher autopilot schedule, its nudges and the manual
 * tick / cycle entry points) must not run before boot reconciliation finished.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  getBootReadiness,
  getDelegationLifecycleState,
  isBootReconciliationComplete,
  resetDelegationLifecycleForTest,
  setDelegationLifecycleState,
} from '../lib/delegation-lifecycle.js';
import { runWorkspaceWatcherAutopilot } from '../lib/workspace-watcher-cycle.js';
import { runWorkspaceWatcherCycleNow, runWorkspaceWatcherTick } from '../lib/workspace-watcher-control.js';
import {
  __resetWorkspaceWatcherAutopilotScheduleForTest,
  registerWorkspaceWatcherAutopilotRunner,
  scheduleWorkspaceWatcherAutopilot,
  workspaceWatcherAutopilotPendingDebounceCount,
} from '../lib/workspace-watcher-event-schedule.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { registerWakeupsRoutes } from '../lib/routes/wakeups-routes.js';
import { chatAutoArchiveJob } from '../lib/chat-auto-archive-worker.js';
import { bootDelegationRuntime, getPeriodicJobRunner, getWakeupScheduler, isRecoveryRunWorkflowLocked, shutdownDelegationRuntime } from '../lib/delegation-runtime-boot.js';
import { getRun, openRecoveryStore, resolveRecoveryStorePath, transitionRun, writeRunIntent } from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import {
  getDelegationRuntimeWorkerStats,
  resetDelegationRuntimeHealth,
  startDelegationRuntimeWorker,
  tickDelegationRuntime,
  stopDelegationRuntimeWorker,
} from '../lib/delegation-runtime-worker.js';

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('the readiness gate treats a pre-boot library process as ready and blocks initializing/degraded', () => {
  resetDelegationLifecycleForTest();
  assert.equal(isBootReconciliationComplete(), true, 'pre-boot library use stays permissive');
  assert.equal(getBootReadiness().reconciled, true);

  setDelegationLifecycleState('initializing');
  assert.equal(isBootReconciliationComplete(), false, 'reconciliation in progress blocks work');
  assert.equal(getBootReadiness().acceptingWork, false);

  setDelegationLifecycleState('degraded', { code: 'X', message: 'x' });
  assert.equal(isBootReconciliationComplete(), false, 'degraded refuses reconciliation-dependent work');

  setDelegationLifecycleState('ready');
  assert.equal(isBootReconciliationComplete(), true);
  resetDelegationLifecycleForTest();
});

test('no autopilot / tick / nudge work runs while reconciliation is in progress', async () => {
  resetDelegationLifecycleForTest();
  setDelegationLifecycleState('initializing');
  let runnerCalls = 0;
  registerWorkspaceWatcherAutopilotRunner(async () => {
    runnerCalls += 1;
  });
  try {
    const autopilot = await runWorkspaceWatcherAutopilot({
      dataDir: '',
      deps: {
        startChatRun: async () => {
          throw new Error('autopilot must not reach a cycle start before boot reconciliation');
        },
      },
    });
    assert.equal(autopilot.skipped, true);
    assert.equal(autopilot.reason, 'boot_not_ready');
    assert.equal(autopilot.scanned, 0);
    assert.equal(autopilot.started, 0);

    const tick = await runWorkspaceWatcherTick({ dataDir: '', workspaceFolder: '/proj' });
    assert.equal(tick.started?.reason, 'boot_not_ready');
    assert.equal(tick.tick.wrote, false);
    assert.equal(tick.tick.skipped, true);

    const cycleNow = await runWorkspaceWatcherCycleNow({ dataDir: '', workspaceFolder: '/proj' });
    assert.equal(cycleNow.skipped, true);
    assert.equal(cycleNow.reason, 'boot_not_ready');

    const scheduled = scheduleWorkspaceWatcherAutopilot({
      workspaceFolder: '/proj',
      dataDir: '',
      debounceMs: 1,
    });
    assert.equal(scheduled.scheduled, false);
    assert.equal(scheduled.reason, 'boot_not_ready');
    assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 0);
    await sleep(30);
    assert.equal(runnerCalls, 0, 'a pre-ready nudge must never reach the runner');
  } finally {
    __resetWorkspaceWatcherAutopilotScheduleForTest();
    resetDelegationLifecycleForTest();
  }
});

test('the scheduled delegation runtime tick never runs before reconciliation', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  setDelegationLifecycleState('initializing');
  startDelegationRuntimeWorker({ intervalMs: 5 });
  try {
    await sleep(60);
    const stats = getDelegationRuntimeWorkerStats();
    assert.equal(stats.running, true, 'the worker may be armed, but its tick is gated');
    assert.equal(stats.lastTickStartedAt, 0, 'no tick may start before boot reconciliation');
  } finally {
    stopDelegationRuntimeWorker();
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

test('after reconciliation the nudge schedule is admitted again', async () => {
  resetDelegationLifecycleForTest();
  let runnerCalls = 0;
  registerWorkspaceWatcherAutopilotRunner(async () => {
    runnerCalls += 1;
  });
  try {
    const scheduled = scheduleWorkspaceWatcherAutopilot({
      workspaceFolder: '/proj',
      dataDir: '',
      debounceMs: 5,
    });
    assert.equal(scheduled.scheduled, true);
    assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 1);
    await sleep(40);
    assert.equal(runnerCalls, 1, 'a ready process runs the debounced nudge');
  } finally {
    __resetWorkspaceWatcherAutopilotScheduleForTest();
    resetDelegationLifecycleForTest();
  }
});

test('the public tickDelegationRuntime does nothing while initializing or degraded', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  try {
    for (const state of ['initializing', 'degraded']) {
      setDelegationLifecycleState(state, state === 'degraded' ? { code: 'X', message: 'x' } : undefined);
      await tickDelegationRuntime();
      assert.equal(getDelegationRuntimeWorkerStats().lastTickStartedAt, 0, `${state}: no tick may start`);
    }
    setDelegationLifecycleState('ready');
    await tickDelegationRuntime();
    assert.ok(getDelegationRuntimeWorkerStats().lastTickStartedAt > 0, 'ready: the tick runs again');
  } finally {
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

test('boot starts the recovery scheduler only after readiness and shutdown stops it', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const observed = [];
  let stops = 0;
  try {
    await bootDelegationRuntime({
      intervalMs: 60_000,
      recoverySchedulerIntervalMs: 60_000,
      recoverySchedulerFactory: () => ({
        start: (intervalMs) => {
          observed.push({ state: getDelegationLifecycleState(), reconciled: isBootReconciliationComplete(), intervalMs });
          return () => { stops += 1; };
        },
      }),
    });
    assert.deepEqual(observed, [{ state: 'ready', reconciled: true, intervalMs: 60_000 }]);
    assert.equal(stops, 0);
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    assert.equal(stops, 1, 'shutdown clears the scheduler timer');
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    stopDelegationRuntimeWorker();
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

test('production boot starts the real scheduler and defers unknown liveness without a client', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const store = openRecoveryStore();
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    chatId: `boot-${ids.logicalRunId}`,
    sessionId: 'boot-session',
    harness: 'claude',
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  transitionRun({
    logicalRunId: ids.logicalRunId,
    expectedRevision: run.revision,
    to: 'interrupted',
    reason: 'server_restart',
    patch: { acceptance: { state: 'accepted', adapterRunId: 'missing-adapter-run' } },
  }, store);
  const before = JSON.stringify(getRun(ids.logicalRunId, store));
  const resumeCalls = [];
  try {
    await bootDelegationRuntime({
      intervalMs: 60_000,
      recoverySchedulerIntervalMs: 5,
      recoverySchedulerOptions: {
        store,
        loadSettings: () => ({ chatRestartRecoveryMode: 'automatic' }),
        resumeService: { resumeRun: async (input) => { resumeCalls.push(input); return { status: 'resumed' }; } },
        probeLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
        getCapabilities: () => ({ canResumeSession: true }),
        isLocked: () => false,
      },
    });
    for (let retries = 0; retries < 20 && resumeCalls.length === 0; retries += 1) await sleep(10);
    assert.equal(getDelegationLifecycleState(), 'ready');
    assert.equal(resumeCalls.length, 0);
    assert.equal(JSON.stringify(getRun(ids.logicalRunId, store)), before);
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    stopDelegationRuntimeWorker();
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

test('production boot timer resumes a confirmed dead run through the real R12 service without a client', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const store = openRecoveryStore();
  const ids = createRecoveryIds();
  const chatId = `boot-positive-${ids.logicalRunId}`;
  writeRunIntent({
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    chatId,
    sessionId: 'boot-positive-session',
    harness: 'claude',
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  transitionRun({
    logicalRunId: ids.logicalRunId,
    expectedRevision: run.revision,
    to: 'interrupted',
    reason: 'server_restart',
    patch: { acceptance: { state: 'accepted', adapterRunId: 'dead-adapter-run' } },
  }, store);
  const starts = [];
  try {
    await bootDelegationRuntime({
      intervalMs: 60_000,
      recoverySchedulerIntervalMs: 5,
      recoverySchedulerOptions: {
        store,
        loadSettings: () => ({ chatRestartRecoveryMode: 'automatic', enabledHarnesses: ['claude'] }),
        probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
        getCapabilities: () => ({ canResumeSession: true }),
        getHarnessUsageLimit: () => null,
        assertCanAcceptNewRun: () => {},
        loadChats: () => [{ id: chatId, cursorSessionId: 'boot-positive-session' }],
        assertChatCanReceiveMessages: () => {},
        startChatRun: async (input) => {
          starts.push(input);
          return { accepted: true, runId: 'resumed-adapter-run' };
        },
        isLocked: () => false,
        // No adapter is validated in production yet; inject the enable gate.
        isAdapterValidated: (harness) => harness === 'claude',
      },
    });
    for (let retries = 0; retries < 50 && starts.length === 0; retries += 1) await sleep(10);
    assert.equal(getDelegationLifecycleState(), 'ready');
    assert.equal(starts.length, 1, 'the timer invokes the production start collaborator without a browser client');
    const resumed = getRun(ids.logicalRunId, store);
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.resumeActor, 'automatic');
    assert.equal(resumed.resumeAdapterRunId, 'resumed-adapter-run');
    assert.equal(resumed.resumeRequests?.[`auto-${ids.logicalRunId}`]?.status, 'resumed');
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    stopDelegationRuntimeWorker();
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

test('the production scheduler lock excludes active delegation and watcher chats and fails closed', () => {
  const run = { chatId: 'chat-1' };
  assert.equal(isRecoveryRunWorkflowLocked({ run }, {
    listDelegations: () => [{ status: 'running' }],
    loadWatchers: () => [],
  }), true);
  assert.equal(isRecoveryRunWorkflowLocked({ run }, {
    listDelegations: () => [],
    loadWatchers: () => [{ activeCycles: [{ chatId: 'chat-1', cycleId: 'cycle-1', startedAt: new Date().toISOString() }] }],
  }), true);
  assert.equal(isRecoveryRunWorkflowLocked({ run }, {
    listDelegations: () => [],
    loadWatchers: () => [],
  }), false);
  assert.equal(isRecoveryRunWorkflowLocked({ run }, {
    listDelegations: () => { throw new Error('store unavailable'); },
  }), true);
});

test('boot degrades and starts no delegation worker when the recovery store cannot be opened', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const storePath = resolveRecoveryStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // A directory in place of the sqlite file makes openRecoveryStore fail
  // without writing a corrupt store.
  fs.rmSync(storePath, { force: true });
  fs.mkdirSync(storePath, { recursive: true });
  let schedulerStarts = 0;
  try {
    await bootDelegationRuntime({
      intervalMs: 60_000,
      recoverySchedulerFactory: () => ({
        start: () => {
          schedulerStarts += 1;
          return () => {};
        },
      }),
    });
    assert.equal(getDelegationLifecycleState(), 'degraded');
    assert.equal(getDelegationRuntimeWorkerStats().running, false, 'no delegation worker while degraded');
    assert.equal(isBootReconciliationComplete(), false);
    assert.equal(schedulerStarts, 0, 'recovery scheduler must not start after degraded reconciliation');
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    stopDelegationRuntimeWorker();
    fs.rmSync(storePath, { recursive: true, force: true });
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

/** Enable chat auto-archive in the isolated data dir; returns a restore function. */
function enableChatAutoArchive() {
  const before = loadSettings();
  saveSettings({ ...before, chatAutoArchive: { enabled: true, idleValue: 30, idleUnit: 'days' } });
  return () => saveSettings(before);
}

/** Calls GET /api/wakeups/status through the real route with the real getters. */
async function readWakeupStatus() {
  let handler = null;
  const app = { get: (route, fn) => { if (route === '/api/wakeups/status') handler = fn; }, patch() {}, post() {} };
  registerWakeupsRoutes(app, { getScheduler: getWakeupScheduler, getPeriodicJobRunner });
  let json = null;
  await handler({}, { status() { return this; }, json(payload) { json = payload; } });
  return json;
}

async function waitForArchiveRun() {
  // The boot run is delayed by the job's random start jitter.
  const deadline = Date.now() + (Number(chatAutoArchiveJob.jitterMs) || 0) + 500;
  while (Date.now() < deadline) {
    const row = getPeriodicJobRunner()?.getJobsStatus().find((job) => job.id === 'chat_auto_archive');
    if (row?.lastRunAt) return row;
    await sleep(10);
  }
  return getPeriodicJobRunner()?.getJobsStatus().find((job) => job.id === 'chat_auto_archive');
}

test('degraded boot runs the chat auto-archive job automatically and lists it with empty kinds', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const restoreSettings = enableChatAutoArchive();
  const storePath = resolveRecoveryStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.rmSync(storePath, { force: true });
  fs.mkdirSync(storePath, { recursive: true });
  try {
    await bootDelegationRuntime({ intervalMs: 60_000 });
    assert.equal(getDelegationLifecycleState(), 'degraded');
    assert.equal(getWakeupScheduler(), null);
    const row = await waitForArchiveRun();
    assert.equal(row.enabled, true);
    assert.ok(row.lastRunAt, 'the boot run fired without runNow');
    assert.equal(row.lastError, null);
    assert.equal(row.skipped, 0);
    const status = await readWakeupStatus();
    assert.deepEqual(status.kinds, []);
    assert.ok(status.jobs.some((job) => job.id === 'chat_auto_archive'));
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    stopDelegationRuntimeWorker();
    fs.rmSync(storePath, { recursive: true, force: true });
    restoreSettings();
    resetDelegationRuntimeHealth();
    resetDelegationLifecycleForTest();
  }
});

test('normal boot registers the auto-archive job alongside wake-up kinds; a second boot re-arms it', async () => {
  for (let round = 0; round < 2; round += 1) {
    resetDelegationLifecycleForTest();
    resetDelegationRuntimeHealth();
    const restoreSettings = enableChatAutoArchive();
    try {
      await bootDelegationRuntime({ intervalMs: 60_000, recoverySchedulerFactory: () => ({ start: () => () => {} }) });
      assert.equal(getDelegationLifecycleState(), 'ready');
      assert.ok(getWakeupScheduler(), 'scheduler is up');
      const row = await waitForArchiveRun();
      assert.ok(row.lastRunAt, `boot run fired in round ${round}`);
      const status = await readWakeupStatus();
      assert.ok(status.kinds.length > 0);
      assert.ok(status.jobs.some((job) => job.id === 'chat_auto_archive'));
    } finally {
      await shutdownDelegationRuntime({ timeoutMs: 1000 });
      stopDelegationRuntimeWorker();
      restoreSettings();
      resetDelegationRuntimeHealth();
      resetDelegationLifecycleForTest();
    }
  }
});
