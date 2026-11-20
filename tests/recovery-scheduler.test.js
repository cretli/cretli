/**
 * Tests for the client-less recovery scheduler (leaf R15): no client trigger,
 * one attempt, age/concurrency/backoff and the safety gates.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getRun, openRecoveryStore, transitionRun, writeRunIntent } from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { markRunWaiting, requestRunCancel } from '../lib/recovery/recovery-queue.ts';
import { createRecoveryResumeService } from '../lib/recovery/recovery-resume.ts';
import { createRecoveryScheduler } from '../lib/recovery/recovery-scheduler.ts';
import { automaticResumeKey } from '../lib/recovery/recovery-policy.ts';
import { createRuntimeRecoveryScheduler } from '../lib/delegation-runtime-boot.js';
import { makeTempDir } from './helpers/temp-dir.js';

const AUTO = { chatRestartRecoveryMode: 'automatic' };

function seed(store, extra = {}, at = Date.now()) {
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId, attemptId: ids.attemptId, requestId: ids.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: `chat-${ids.logicalRunId}`,
    sessionId: 'sess-1', harness: 'claude', ...extra,
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running', now: at }, store).run;
  transitionRun({
    logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'interrupted',
    reason: 'server_restart', now: at, patch: { acceptance: { state: 'accepted', adapterRunId: 'a' } },
  }, store);
  return ids;
}

function build(over = {}) {
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-sched-') });
  const clock = { t: Date.now() };
  const starts = [];
  const resumeService = createRecoveryResumeService({
    store, now: () => clock.t,
    probeLiveness: () => 'dead',
    getCapabilities: () => ({ canResumeSession: true }),
    startContinuation: over.startContinuation || (async (i) => { starts.push(i); return { accepted: true, adapterRunId: 'x' }; }),
    checkLimits: over.checkLimits,
    isAdapterValidated: over.isAdapterValidated || (() => true),
  });
  const scheduler = createRecoveryScheduler({
    store, now: () => clock.t, loadSettings: () => over.settings || AUTO, resumeService,
    probeLiveness: over.probeLiveness || (() => 'dead'),
    getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: over.isAdapterValidated || (() => true),
    maxAgeMs: 60_000, backoffBaseMs: 1000, backoffCapMs: 4000, maxDeferrals: 3,
    ...over.sched,
  });
  return { store, clock, starts, scheduler };
}

test('no client: a plain tick resumes a confirmed interrupted run once', async () => {
  const { store, starts, scheduler } = build();
  const ids = seed(store);
  const out = await scheduler.tick();
  assert.equal(out.decisions[0].reason, 'resumed');
  assert.equal(starts.length, 1);
  assert.equal(getRun(ids.logicalRunId, store).state, 'running');
  await scheduler.tick();
  assert.equal(starts.length, 1);
});

test('production scheduler defers state_missing without claiming or changing the run', async () => {
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-runtime-sched-') });
  const ids = seed(store);
  const calls = [];
  const before = JSON.stringify(getRun(ids.logicalRunId, store));
  const scheduler = createRuntimeRecoveryScheduler({
    store,
    loadSettings: () => AUTO,
    resumeService: { resumeRun: async (input) => { calls.push(input); return { status: 'resumed' }; } },
    probeLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: () => true,
    isLocked: () => false,
    isReady: () => true,
  });
  const out = await scheduler.tick();
  assert.equal(out.decisions[0].action, 'deferred');
  assert.equal(out.decisions[0].reason, 'liveness_not_confirmed_dead');
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(getRun(ids.logicalRunId, store)), before);
});

test('default/manual/off modes never auto-resume', async () => {
  for (const settings of [{}, { chatRestartRecoveryMode: 'manual' }, { chatRestartRecoveryMode: 'off' }]) {
    const { store, starts, scheduler } = build({ settings });
    seed(store);
    const out = await scheduler.tick();
    assert.equal(starts.length, 0);
    assert.equal(out.decisions[0].action, 'skipped');
  }
});

test('one attempt only: failed launch is not retried, even by a fresh scheduler', async () => {
  let calls = 0;
  const { store, clock, scheduler } = build({ startContinuation: async () => { calls += 1; return { accepted: false }; } });
  const ids = seed(store);
  assert.equal((await scheduler.tick()).decisions[0].reason, 'launch_failed');
  assert.equal(getRun(ids.logicalRunId, store).state, 'interrupted');
  clock.t += 5000;
  const freshScheduler = createRecoveryScheduler({
    store,
    now: () => clock.t,
    loadSettings: () => AUTO,
    resumeService: { resumeRun: async () => { calls += 1; return { status: 'resumed' }; } },
    probeLiveness: () => 'dead',
    getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: () => true,
  });
  assert.equal((await freshScheduler.tick()).decisions[0].reason, 'attempt_already_made');
  assert.equal(calls, 1);
});

test('max interruption age leaves old runs to a human', async () => {
  const { store, starts, scheduler } = build();
  seed(store, {}, Date.now() - 120_000);
  assert.equal((await scheduler.tick()).decisions[0].reason, 'too_old');
  assert.equal(starts.length, 0);
});

test('concurrency: only maxConcurrent runs launch per pass', async () => {
  const { store, starts, scheduler } = build({ sched: { maxConcurrent: 1 } });
  seed(store); seed(store);
  const out = await scheduler.tick();
  assert.equal(starts.length, 1);
  assert.deepEqual(out.decisions.map((d) => d.reason).sort(), ['concurrency_limit', 'resumed']);
});

test('concurrency counts an automatic resume that is starting on a later tick', async () => {
  const { store, starts, scheduler } = build({ sched: { maxConcurrent: 1 } });
  seed(store);
  const second = seed(store);
  const first = await scheduler.tick();
  assert.equal(first.decisions.filter((d) => d.reason === 'resumed').length, 1);
  assert.equal((await scheduler.tick()).decisions.find((d) => d.logicalRunId === second.logicalRunId)?.reason, 'concurrency_limit');
  assert.equal(starts.length, 1);
});

test('concurrency count applies resumeActor before LIMIT within one lifecycle state', async () => {
  const { store, starts, scheduler } = build({ sched: { maxConcurrent: 1, scanLimit: 200 } });
  for (let index = 0; index < 1001; index += 1) {
    const ids = createRecoveryIds();
    writeRunIntent({
      logicalRunId: ids.logicalRunId, attemptId: ids.attemptId, requestId: ids.requestId,
      family: 'chat', owner: 'chat-run-service', chatId: `manual-${index}`,
      sessionId: 'sess-manual', harness: 'claude',
    }, store);
    const run = getRun(ids.logicalRunId, store);
    transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store);
  }
  const active = seed(store);
  let activeRun = getRun(active.logicalRunId, store);
  transitionRun({
    logicalRunId: active.logicalRunId,
    expectedRevision: activeRun.revision,
    expectedState: 'interrupted',
    to: 'recovering',
    patch: {
      resumeActor: 'automatic',
      resumeRequests: { [automaticResumeKey(active.logicalRunId)]: { status: 'in_progress' } },
    },
  }, store);
  activeRun = getRun(active.logicalRunId, store);
  activeRun = transitionRun({
    logicalRunId: active.logicalRunId,
    expectedRevision: activeRun.revision,
    expectedState: 'recovering',
    to: 'starting',
  }, store).run;
  transitionRun({
    logicalRunId: active.logicalRunId,
    expectedRevision: activeRun.revision,
    expectedState: 'starting',
    to: 'running',
  }, store);
  const eligible = seed(store);
  const out = await scheduler.tick();
  assert.equal(out.decisions.find((item) => item.logicalRunId === eligible.logicalRunId)?.reason, 'concurrency_limit');
  assert.equal(starts.length, 0);
});

test('pagination reaches eligible runs after a full page of old candidates', async () => {
  const { store, starts, scheduler } = build({ sched: { scanLimit: 2 } });
  seed(store, {}, Date.now() - 120_000);
  seed(store, {}, Date.now() - 120_000);
  const eligible = seed(store);
  const out = await scheduler.tick();
  assert.equal(starts.length, 1);
  assert.equal(out.decisions.find((d) => d.logicalRunId === eligible.logicalRunId)?.reason, 'resumed');
});

test('scanLimit above the store maximum does not skip hidden interrupted rows', async () => {
  const { store, starts, scheduler } = build({ sched: { scanLimit: 1500 } });
  for (let index = 0; index < 1000; index += 1) seed(store, {}, Date.now() - 120_000);
  const eligible = seed(store);
  const out = await scheduler.tick();
  assert.equal(starts.length, 1);
  assert.equal(out.decisions.find((item) => item.logicalRunId === eligible.logicalRunId)?.reason, 'resumed');
});

test('separate backoff: transient refusal defers exponentially, then exhausts', async () => {
  const { store, clock, starts, scheduler } = build({ checkLimits: () => ({ allowed: false, reason: 'cost' }) });
  const ids = seed(store);
  assert.equal((await scheduler.tick()).decisions[0].action, 'deferred');
  assert.equal((await scheduler.tick()).decisions[0].reason, 'backoff');
  clock.t += 1000;
  assert.equal((await scheduler.tick()).decisions[0].action, 'deferred');
  assert.equal(scheduler.getDeferral(ids.logicalRunId).count, 2);
  clock.t += 2000;
  await scheduler.tick();
  clock.t += 10_000;
  assert.equal((await scheduler.tick()).decisions[0].reason, 'deferrals_exhausted');
  assert.equal(starts.length, 0);
  assert.equal(getRun(ids.logicalRunId, store).resumeFailure, undefined);
});

test('gates: stop/cancel, waiting, lock, unknown liveness and unknown state', async () => {
  const a = build();
  const cancelled = seed(a.store);
  requestRunCancel({ logicalRunId: cancelled.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user' }, a.store);
  await a.scheduler.tick();
  assert.equal(a.starts.length, 0);

  const b = build();
  const waiting = createRecoveryIds();
  writeRunIntent({
    logicalRunId: waiting.logicalRunId, attemptId: waiting.attemptId, requestId: waiting.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: 'chat-w', sessionId: 's', harness: 'claude',
  }, b.store);
  const w0 = getRun(waiting.logicalRunId, b.store);
  transitionRun({ logicalRunId: waiting.logicalRunId, expectedRevision: w0.revision, to: 'running' }, b.store);
  const wr = getRun(waiting.logicalRunId, b.store);
  markRunWaiting({ logicalRunId: waiting.logicalRunId, expectedRevision: wr.revision, kind: 'question', requestId: createRecoveryIds().requestId }, b.store);
  await b.scheduler.tick();
  assert.equal(b.starts.length, 0);

  const c = build({ sched: { isLocked: () => true } });
  seed(c.store);
  assert.equal((await c.scheduler.tick()).decisions[0].reason, 'workflow_locked');

  const d = build({ probeLiveness: () => 'unknown' });
  seed(d.store);
  const dec = (await d.scheduler.tick()).decisions[0];
  assert.equal(dec.action, 'deferred');
  assert.equal(d.starts.length, 0);

  const e = build();
  const unk = createRecoveryIds();
  writeRunIntent({
    logicalRunId: unk.logicalRunId, attemptId: unk.attemptId, requestId: unk.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: 'chat-u', sessionId: 's', harness: 'claude',
  }, e.store);
  const u0 = getRun(unk.logicalRunId, e.store);
  const u1 = transitionRun({ logicalRunId: unk.logicalRunId, expectedRevision: u0.revision, to: 'running' }, e.store).run;
  const u2 = transitionRun({ logicalRunId: unk.logicalRunId, expectedRevision: u1.revision, to: 'unknown', reason: 'server_restart' }, e.store);
  assert.equal(u2.applied, true);
  await e.scheduler.tick();
  assert.equal(e.starts.length, 0);
});

test('re-entrant tick is rejected while the first tick awaits resume', async () => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const { store, scheduler } = build({ startContinuation: () => deferred });
  seed(store);
  const first = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await scheduler.tick()).reason, 'tick_in_progress');
  release({ accepted: true, adapterRunId: 'deferred-run' });
  assert.equal((await first).decisions[0].reason, 'resumed');
});

test('not-ready ticks are ignored', async () => {
  const { store, scheduler } = build({ sched: { isReady: () => false } });
  seed(store);
  assert.equal((await scheduler.tick()).reason, 'not_ready');
});

test('stopping during a pending tick prevents later claims and launches', async () => {
  let release;
  let launchCalls = 0;
  const deferred = new Promise((resolve) => { release = resolve; });
  const { store, scheduler } = build({
    startContinuation: async (input) => {
      launchCalls += 1;
      if (launchCalls === 1) return deferred;
      return { accepted: true, adapterRunId: 'unexpected' };
    },
    sched: { maxConcurrent: 2 },
  });
  seed(store);
  seed(store);
  const stop = scheduler.start(60_000);
  const pending = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  release({ accepted: true, adapterRunId: 'first' });
  const out = await pending;
  assert.equal(launchCalls, 1);
  assert.equal(out.decisions.filter((item) => item.reason === 'stopped').length, 1);
  assert.equal((await scheduler.tick()).reason, 'stopped');
});

test('periodic timer is unrefed and its stop callback clears it', () => {
  const originalSetInterval = globalThis.setTimeout;
  const originalClearInterval = globalThis.clearTimeout;
  let unrefCalls = 0;
  let cleared = null;
  const timer = { unref: () => { unrefCalls += 1; } };
  globalThis.setTimeout = () => timer;
  globalThis.clearTimeout = (value) => { cleared = value; };
  try {
    const { scheduler } = build();
    const stop = scheduler.start(1000);
    assert.equal(unrefCalls, 1);
    stop();
    assert.equal(cleared, timer);
  } finally {
    globalThis.setTimeout = originalSetInterval;
    globalThis.clearTimeout = originalClearInterval;
  }
});
