/**
 * Automatic restart recovery rollout (leaf R20): the per-adapter enable gate,
 * restart/attempt-limit behaviour of the scheduler, delegation isolation and a
 * broken recovery store. Module-level (server-only, no browser or client); the
 * restart is a real close + reopen of the same on-disk store.
 */
import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeRecoveryStore, getRun, openRecoveryStore, transitionRun, writeRunIntent } from '../lib/recovery/recovery-store.ts';
import { markRunWaiting, requestRunCancel } from '../lib/recovery/recovery-queue.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { createRecoveryResumeService } from '../lib/recovery/recovery-resume.ts';
import { createRecoveryScheduler } from '../lib/recovery/recovery-scheduler.ts';
import { createRuntimeRecoveryScheduler, isRecoveryAdapterValidated, isRecoveryRunWorkflowLocked } from '../lib/delegation-runtime-boot.js';
import { makeTempDir } from './helpers/temp-dir.js';

const AUTO = { chatRestartRecoveryMode: 'automatic' };

function seed(store, extra = {}) {
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId, attemptId: ids.attemptId, requestId: ids.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: `chat-${ids.logicalRunId}`,
    sessionId: 'sess-1', harness: 'claude', ...extra,
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  transitionRun({
    logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'interrupted',
    reason: 'server_restart', patch: { acceptance: { state: 'accepted', adapterRunId: 'a' } },
  }, store);
  return ids;
}

/** One "server process": a scheduler over the store at `dataDir`. */
function boot(dataDir, over = {}) {
  const store = openRecoveryStore({ dataDir });
  const starts = [];
  const resumeService = createRecoveryResumeService({
    store, probeLiveness: () => 'dead', getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: over.isAdapterValidated,
    startContinuation: over.startContinuation || (async (i) => { starts.push(i); return { accepted: true, adapterRunId: 'x' }; }),
  });
  const scheduler = createRecoveryScheduler({
    store, now: over.now, loadSettings: () => over.settings || AUTO, resumeService,
    probeLiveness: () => 'dead', getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: over.isAdapterValidated,
    backoffBaseMs: 1000, maxDeferrals: 3, ...over.sched,
  });
  return { store, starts, scheduler };
}

test('AC1: policy automatic still blocks an adapter that is not validated', async () => {
  const dataDir = makeTempDir('recovery-rollout-');
  const gates = [undefined, () => false, (h) => h === 'other'];
  for (const isAdapterValidated of gates) {
    const { store, starts, scheduler } = boot(dataDir, { isAdapterValidated });
    seed(store);
    const out = await scheduler.tick();
    assert.ok(out.decisions.every((d) => d.reason === 'adapter_not_validated'));
    assert.equal(starts.length, 0);
    closeRecoveryStore(store);
  }
});

test('AC1: production gate defaults to blocked; no adapter is validated today', () => {
  for (const harness of ['sdk', 'claude', 'codex', 'qwen', 'testfakeb', 'testfake', 'nope', '', undefined]) {
    assert.equal(isRecoveryAdapterValidated(harness), false);
  }
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-rollout-prod-') });
  seed(store);
  const calls = [];
  const scheduler = createRuntimeRecoveryScheduler({
    store, loadSettings: () => AUTO, isLocked: () => false, isReady: () => true,
    resumeService: { resumeRun: async (i) => { calls.push(i); return { status: 'resumed' }; } },
    probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getCapabilities: () => ({ canResumeSession: true }),
  });
  return scheduler.tick().then((out) => {
    assert.equal(out.decisions[0].reason, 'adapter_not_validated');
    assert.equal(calls.length, 0);
    closeRecoveryStore(store);
  });
});

test('AC2a: validated adapter, automatic, no client: resumed exactly once across restarts', async () => {
  const dataDir = makeTempDir('recovery-rollout-');
  const first = boot(dataDir, { isAdapterValidated: () => true });
  const ids = seed(first.store);
  closeRecoveryStore(first.store); // server dies before any tick
  let total = 0;
  for (let restart = 0; restart < 4; restart += 1) {
    const proc = boot(dataDir, { isAdapterValidated: (h) => h === 'claude' });
    await proc.scheduler.tick();
    await proc.scheduler.tick();
    total += proc.starts.length;
    assert.notEqual(getRun(ids.logicalRunId, proc.store).state, 'interrupted');
    closeRecoveryStore(proc.store);
  }
  assert.equal(total, 1);
});

test('AC2b: failed launch and limit refusals produce no retry storm across restarts', async () => {
  const dataDir = makeTempDir('recovery-rollout-');
  let launches = 0;
  const seeded = boot(dataDir);
  seed(seeded.store);
  closeRecoveryStore(seeded.store);
  for (let restart = 0; restart < 5; restart += 1) {
    const proc = boot(dataDir, {
      isAdapterValidated: () => true,
      startContinuation: async () => { launches += 1; return { accepted: false }; },
    });
    await proc.scheduler.tick();
    closeRecoveryStore(proc.store);
  }
  assert.equal(launches, 1);

  // A transient refusal backs off inside one process and gives up after maxDeferrals.
  const clock = { t: Date.now() };
  const dir2 = makeTempDir('recovery-rollout-');
  const proc = boot(dir2, { isAdapterValidated: () => true, now: () => clock.t, sched: { probeLiveness: undefined } });
  const store2 = proc.store;
  const ids = seed(store2);
  const stuck = createRecoveryScheduler({
    store: store2, now: () => clock.t, loadSettings: () => AUTO,
    resumeService: { resumeRun: async () => { launches += 1; return { status: 'limit_blocked' }; } },
    probeLiveness: () => 'dead', getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: () => true, backoffBaseMs: 1000, backoffCapMs: 4000, maxDeferrals: 3,
  });
  const seen = [];
  for (let i = 0; i < 40; i += 1) {
    seen.push((await stuck.tick()).decisions.find((d) => d.logicalRunId === ids.logicalRunId)?.action);
    clock.t += 500;
  }
  assert.equal(seen.filter((a) => a === 'deferred').length, 3);
  assert.equal(launches, 1 + 3);
  closeRecoveryStore(store2);
});

test('AC2c: delegation-owned chats and delegation-family runs are not touched by the chat scheduler', async () => {
  const dataDir = makeTempDir('recovery-rollout-');
  const { store, starts, scheduler } = boot(dataDir, {
    isAdapterValidated: () => true,
    sched: { isLocked: ({ run }) => isRecoveryRunWorkflowLocked({ run }, {
      listDelegations: () => [{ status: 'running' }],
      loadWatchers: () => [],
    }) },
  });
  const chat = seed(store);
  const delegation = seed(store, { family: 'delegation', owner: 'delegation-service' });
  const out = await scheduler.tick();
  assert.equal(starts.length, 0);
  assert.equal(out.decisions.find((d) => d.logicalRunId === chat.logicalRunId)?.reason, 'workflow_locked');
  assert.equal(out.decisions.find((d) => d.logicalRunId === delegation.logicalRunId), undefined);
  assert.equal(getRun(delegation.logicalRunId, store).state, 'interrupted');
  // The delegation retry rules themselves are pinned in tests/delegation-interrupt-retry.test.js
  // (one-time server_restart continuation; running_orphan / starting_timeout stay stop-only).
  closeRecoveryStore(store);
});

test('AC2d: Stop/cancelled, waiting and unknown-liveness runs are never auto-resumed', async () => {
  const dataDir = makeTempDir('recovery-rollout-');
  const { store, starts, scheduler } = boot(dataDir, { isAdapterValidated: () => true });
  const stopped = seed(store);
  requestRunCancel({ logicalRunId: stopped.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user' }, store);
  // A run waiting for a human answer is `running` -> `waiting`, never `interrupted`.
  const waiting = createRecoveryIds();
  writeRunIntent({
    logicalRunId: waiting.logicalRunId, attemptId: waiting.attemptId, requestId: waiting.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: `chat-${waiting.logicalRunId}`, sessionId: 'sess-1', harness: 'claude',
  }, store);
  transitionRun({ logicalRunId: waiting.logicalRunId, expectedRevision: getRun(waiting.logicalRunId, store).revision, to: 'running' }, store);
  markRunWaiting({
    logicalRunId: waiting.logicalRunId, expectedRevision: getRun(waiting.logicalRunId, store).revision,
    kind: 'question', requestId: createRecoveryIds().requestId,
  }, store);
  // `unknown` (unproven interruption) is reached from `running`, not from `interrupted`.
  const unknownState = createRecoveryIds();
  writeRunIntent({
    logicalRunId: unknownState.logicalRunId, attemptId: unknownState.attemptId, requestId: unknownState.requestId,
    family: 'chat', owner: 'chat-run-service', chatId: `chat-${unknownState.logicalRunId}`, sessionId: 'sess-1', harness: 'claude',
  }, store);
  transitionRun({ logicalRunId: unknownState.logicalRunId, expectedRevision: getRun(unknownState.logicalRunId, store).revision, to: 'running' }, store);
  const unknownMoved = transitionRun({
    logicalRunId: unknownState.logicalRunId, expectedRevision: getRun(unknownState.logicalRunId, store).revision,
    to: 'unknown', reason: 'server_restart',
  }, store);
  assert.equal(unknownMoved.run.state, 'unknown');
  for (let i = 0; i < 3; i += 1) await scheduler.tick();
  assert.equal(starts.length, 0);
  for (const ids of [stopped, waiting, unknownState]) {
    assert.ok(!getRun(ids.logicalRunId, store)?.resumeRequests?.[`auto-${ids.logicalRunId}`], 'no automatic attempt recorded');
  }
  assert.equal(getRun(unknownState.logicalRunId, store).state, 'unknown');
  assert.equal(getRun(waiting.logicalRunId, store).state, 'waiting');
  closeRecoveryStore(store);

  // Unknown liveness of an otherwise eligible interrupted run: never resumed.
  const dir2 = makeTempDir('recovery-rollout-');
  const proc = boot(dir2, { isAdapterValidated: () => true });
  const ids = seed(proc.store);
  const unknownLiveness = createRecoveryScheduler({
    store: proc.store, loadSettings: () => AUTO, resumeService: { resumeRun: async () => { proc.starts.push('x'); return { status: 'resumed' }; } },
    probeLiveness: () => 'unknown', getCapabilities: () => ({ canResumeSession: true }), isAdapterValidated: () => true,
  });
  const out = await unknownLiveness.tick();
  assert.equal(proc.starts.length, 0);
  assert.equal(out.decisions.find((d) => d.logicalRunId === ids.logicalRunId)?.action, 'deferred');
  closeRecoveryStore(proc.store);
});

test('AC2e: an unavailable recovery store is logged with capped exponential backoff and never resumes', async (t) => {
  const errors = [];
  const brokenStore = { db: { prepare() { throw new Error('database disk image is malformed'); } } };
  let launches = 0;
  const scheduler = createRecoveryScheduler({
    store: brokenStore, loadSettings: () => AUTO,
    resumeService: { resumeRun: async () => { launches += 1; return { status: 'resumed' }; } },
    probeLiveness: () => 'dead', getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: () => true, onError: (e) => errors.push(e), errorBackoffCapMs: 400,
  });
  await assert.rejects(scheduler.tick());
  assert.equal((await scheduler.tick().catch(() => ({ ran: false }))).ran, false); // not wedged in "ticking"
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const stop = scheduler.start(50);
  // Failure n schedules the next tick after min(cap, 50 * 2^n): 100, 200, 400, 400.
  const gaps = [50, 100, 200, 400, 400];
  for (let i = 0; i < gaps.length; i += 1) {
    t.mock.timers.tick(gaps[i] - 1);
    await settle();
    assert.equal(errors.length, i, `no tick before the ${gaps[i]}ms backoff elapses`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(errors.length, i + 1);
  }
  stop();
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(errors.length, gaps.length);
  assert.equal(launches, 0);
});

test('AC2f: the scheduler returns to the base interval after a successful tick', async (t) => {
  const errors = [];
  let broken = true;
  const flakyStore = { db: { prepare() { throw new Error('database is locked'); } } };
  const realDir = makeTempDir('recovery-rollout-');
  const realStore = openRecoveryStore({ dataDir: realDir });
  const proxy = new Proxy({}, { get: (_t, prop) => (broken ? flakyStore : realStore)[prop] });
  const scheduler = createRecoveryScheduler({
    store: proxy, loadSettings: () => AUTO,
    resumeService: { resumeRun: async () => ({ status: 'resumed' }) },
    probeLiveness: () => 'dead', getCapabilities: () => ({ canResumeSession: true }),
    isAdapterValidated: () => true, onError: (e) => errors.push(e),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const stop = scheduler.start(100);
  t.mock.timers.tick(100); await settle(); // fails -> next in 200
  t.mock.timers.tick(200); await settle(); // fails -> next in 400
  assert.equal(errors.length, 2);
  broken = false;
  t.mock.timers.tick(399); await settle();
  assert.equal(errors.length, 2);
  t.mock.timers.tick(1); await settle(); // succeeds -> back to 100
  assert.equal(errors.length, 2);
  broken = true;
  t.mock.timers.tick(99); await settle();
  assert.equal(errors.length, 2);
  t.mock.timers.tick(1); await settle();
  assert.equal(errors.length, 3);
  stop();
  closeRecoveryStore(realStore);
});
