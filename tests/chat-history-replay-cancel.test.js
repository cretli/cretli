/**
 * Task 1.1 — cancel superseded / destroyed replay async tails (controlled scheduler).
 */
import assert from 'node:assert/strict';

import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_CHUNK_SIZE,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import { createChatHistoryReplayGenerationGate } from '../app_front/lib/chatHistoryReplayGenerationGate.js';
import { monoNow, resetChatPerfBudget } from '../app_front/lib/chatPerfBudget.js';
import { UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS } from '../app_front/lib/uiFreezeRenderBudgets.js';
import { createDefaultSchedulerYieldDeps } from '../app_front/lib/schedulerYield.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';

/** @typedef {{ pending: Array<() => void>, flush: () => void }} FrameScheduler */

/** @returns {FrameScheduler} */
function createControlledFrameScheduler() {
  /** @type {Array<() => void>} */
  const pending = [];
  return {
    pending,
    flush() {
      let guard = 0;
      while (pending.length > 0 && guard < 64) {
        guard += 1;
        const batch = pending.splice(0, pending.length);
        for (const cb of batch) cb();
      }
    },
  };
}

/** @param {FrameScheduler} scheduler */
function scheduleFrameFrom(scheduler) {
  return (cb) => {
    scheduler.pending.push(cb);
  };
}

/** @param {FrameScheduler} scheduler */
function yieldDepsFrom(scheduler) {
  const deps = createDefaultSchedulerYieldDeps();
  deps.MessageChannel = undefined;
  deps.scheduler = undefined;
  deps.setTimeoutFn = (fn) => {
    scheduler.pending.push(fn);
    return scheduler.pending.length;
  };
  return deps;
}

/** @param {FrameScheduler} scheduler @param {Promise<unknown>} promise */
async function settleAsyncTail(scheduler, promise) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    scheduler.flush();
    const settled = await Promise.race([
      promise.then(() => true, () => true),
      Promise.resolve(false),
    ]);
    if (settled) return;
    await Promise.resolve();
  }
  await promise;
}

/** @param {boolean} on */
function createLifecycleHarness(on) {
  /** @type {Array<{ category: string, event: string, payload: Record<string, unknown> }>} */
  const events = [];
  const lifecycle = createChatHistoryReplayLifecycle({
    active: () => on,
    trace: (category, event, payload) => {
      events.push({ category, event, payload: payload || {} });
    },
  });
  return { lifecycle, events };
}

/** @param {number} delayMs */
function spinForMs(delayMs) {
  const deadline = monoNow() + delayMs;
  while (monoNow() < deadline) {
    // Busy-wait so time-sliced replay yields before finishing the tail.
  }
}

/** @param {number} total */
function makeUserRecords(total) {
  return Array.from({ length: total }, (_, index) => ({
    kind: 'localUser',
    text: `prompt-${index}`,
    historySeq: index + 1,
    createdAt: new Date(0).toISOString(),
  }));
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();

{
  const gate = createChatHistoryReplayGenerationGate();
  const { lifecycle, events } = createLifecycleHarness(true);
  const scheduler = createControlledFrameScheduler();
  const total = HISTORY_REPLAY_SYNC_HEAD + HISTORY_REPLAY_CHUNK_SIZE * 3;
  const records = makeUserRecords(total);
  const runA = lifecycle.beginReplay({
    source: 'local',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(runA.generation);
  lifecycle.noteSyncApplied(runA.generation, HISTORY_REPLAY_SYNC_HEAD);
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  let finalizeCalls = 0;
  const tailPromise = runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: runA.generation,
    lifecycle,
    scheduleFrame: scheduleFrameFrom(scheduler),
    deps: yieldDepsFrom(scheduler),
    isCancelled: () => !gate.isActive(runA.generation),
    applyHistoryRecord: () => {
      spinForMs(2);
      applied += 1;
    },
    finalizeTail: () => {
      finalizeCalls += 1;
    },
    getAppliedMeta: () => ({ applied, children: applied }),
  });
  const recordsPerSlice = Math.max(1, Math.floor(UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS / 2));
  assert.equal(applied, HISTORY_REPLAY_SYNC_HEAD + recordsPerSlice);
  const runB = lifecycle.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(runB.generation);
  assert.ok(events.some((row) => row.event === 'supersede'));
  await settleAsyncTail(scheduler, tailPromise);
  assert.equal(finalizeCalls, 0);
  assert.ok(applied < total);
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
  assert.ok(
    events.some(
      (row) =>
        row.event === 'end' &&
        row.payload.generation === runA.generation &&
        row.payload.reason === 'superseded',
    ),
  );
  assert.equal(gate.getActiveGeneration(), runB.generation);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();

{
  const gate = createChatHistoryReplayGenerationGate();
  const { lifecycle, events } = createLifecycleHarness(true);
  const scheduler = createControlledFrameScheduler();
  const total = HISTORY_REPLAY_SYNC_HEAD + HISTORY_REPLAY_CHUNK_SIZE * 2;
  const records = makeUserRecords(total);
  const run = lifecycle.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(run.generation);
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  let finalizeCalls = 0;
  let scrollCalls = 0;
  const tailPromise = runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: run.generation,
    lifecycle,
    scheduleFrame: scheduleFrameFrom(scheduler),
    deps: yieldDepsFrom(scheduler),
    isCancelled: () => !gate.isActive(run.generation),
    applyHistoryRecord: () => {
      spinForMs(2);
      applied += 1;
    },
    finalizeTail: () => {
      finalizeCalls += 1;
      gate.scheduleGuardedScroll(
        run.generation,
        () => {
          scrollCalls += 1;
        },
        scheduleFrameFrom(scheduler),
      );
    },
    getAppliedMeta: () => ({ applied, children: applied }),
  });
  const recordsPerSlice = Math.max(1, Math.floor(UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS / 2));
  assert.equal(applied, HISTORY_REPLAY_SYNC_HEAD + recordsPerSlice);
  gate.revoke();
  lifecycle.onViewDestroyed(0);
  assert.ok(events.some((row) => row.event === 'destroy'));
  await settleAsyncTail(scheduler, tailPromise);
  assert.equal(finalizeCalls, 0);
  assert.equal(scrollCalls, 0);
  assert.equal(gate.getActiveGeneration(), 0);
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();

{
  const gate = createChatHistoryReplayGenerationGate();
  const { lifecycle } = createLifecycleHarness(false);
  const scheduler = createControlledFrameScheduler();
  const total = HISTORY_REPLAY_SYNC_HEAD + HISTORY_REPLAY_CHUNK_SIZE * 2;
  const records = makeUserRecords(total);
  const runA = lifecycle.beginReplay({
    source: 'local',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(runA.generation);
  let appliedA = HISTORY_REPLAY_SYNC_HEAD;
  let finallyClearedA = false;
  let flagsOwnedByA = true;
  const tailA = runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: runA.generation,
    lifecycle,
    scheduleFrame: scheduleFrameFrom(scheduler),
    deps: yieldDepsFrom(scheduler),
    isCancelled: () => !gate.isActive(runA.generation),
    applyHistoryRecord: () => {
      spinForMs(2);
      appliedA += 1;
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied: appliedA, children: appliedA }),
  }).finally(() => {
    if (gate.isActive(runA.generation)) {
      finallyClearedA = true;
      flagsOwnedByA = false;
    }
  });
  const runB = lifecycle.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(runB.generation);
  assert.equal(gate.getActiveGeneration(), runB.generation);
  let appliedB = HISTORY_REPLAY_SYNC_HEAD;
  let finalizeB = 0;
  const tailB = runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: runB.generation,
    lifecycle,
    scheduleFrame: scheduleFrameFrom(scheduler),
    deps: yieldDepsFrom(scheduler),
    isCancelled: () => !gate.isActive(runB.generation),
    applyHistoryRecord: () => {
      spinForMs(2);
      appliedB += 1;
    },
    finalizeTail: () => {
      finalizeB += 1;
    },
    getAppliedMeta: () => ({ applied: appliedB, children: appliedB }),
  });
  await settleAsyncTail(scheduler, tailA);
  await settleAsyncTail(scheduler, tailB);
  assert.equal(finallyClearedA, false);
  assert.equal(flagsOwnedByA, true);
  assert.equal(finalizeB, 1);
  assert.ok(appliedA < total);
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();

{
  const gateOld = createChatHistoryReplayGenerationGate();
  const gateNew = createChatHistoryReplayGenerationGate();
  const { lifecycle: lifecycleOld } = createLifecycleHarness(false);
  const { lifecycle: lifecycleNew } = createLifecycleHarness(false);
  const scheduler = createControlledFrameScheduler();
  const total = HISTORY_REPLAY_SYNC_HEAD + HISTORY_REPLAY_CHUNK_SIZE * 2;
  const records = makeUserRecords(total);
  const runOld = lifecycleOld.beginReplay({
    source: 'local',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gateOld.activate(runOld.generation);
  let appliedOld = HISTORY_REPLAY_SYNC_HEAD;
  let finallyOld = false;
  const tailOld = runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: runOld.generation,
    lifecycle: lifecycleOld,
    scheduleFrame: scheduleFrameFrom(scheduler),
    deps: yieldDepsFrom(scheduler),
    isCancelled: () => !gateOld.isActive(runOld.generation),
    applyHistoryRecord: () => {
      spinForMs(2);
      appliedOld += 1;
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied: appliedOld, children: appliedOld }),
  }).finally(() => {
    if (gateOld.isActive(runOld.generation)) finallyOld = true;
  });
  gateOld.revoke();
  const runNew = lifecycleNew.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gateNew.activate(runNew.generation);
  assert.equal(gateNew.getActiveGeneration(), runNew.generation);
  assert.equal(gateOld.getActiveGeneration(), 0);
  await settleAsyncTail(scheduler, tailOld);
  assert.equal(finallyOld, false);
  assert.ok(appliedOld < total);
  assert.equal(lifecycleOld.getActiveAsyncLoops(), 0);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();

{
  const gate = createChatHistoryReplayGenerationGate();
  const { lifecycle } = createLifecycleHarness(false);
  const runA = lifecycle.beginReplay({
    source: 'local',
    totalRecords: 40,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(runA.generation);
  lifecycle.noteAsyncLoopStarted(runA.generation);
  const runB = lifecycle.beginReplay({
    source: 'http',
    totalRecords: 40,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(runB.generation);
  assert.equal(gate.getActiveGeneration(), runB.generation);
  assert.equal(lifecycle.getActiveAsyncLoops(), 1);
  lifecycle.finishReplay(runA.generation, { reason: 'complete', applied: 28 });
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
  lifecycle.noteAsyncLoopStarted(runB.generation);
  assert.equal(lifecycle.getActiveAsyncLoops(), 1);
  lifecycle.finishReplay(runB.generation, { reason: 'complete', applied: 40 });
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
}

console.log('chat-history-replay-cancel.test.js: ok');
