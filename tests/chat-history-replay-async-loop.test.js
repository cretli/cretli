/**
 * runHistoryReplayAsyncTail — error cleanup, applied counts, tail batch timing.
 */
import assert from 'node:assert/strict';

import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import {
  currentSpanName,
  monoNow,
  resetChatPerfBudget,
} from '../app_front/lib/chatPerfBudget.js';
import { UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS } from '../app_front/lib/uiFreezeRenderBudgets.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';

/** @param {number} delayMs */
function spinForMs(delayMs) {
  const deadline = monoNow() + delayMs;
  while (monoNow() < deadline) {
    // Busy-wait so applyMs is measurable with immediate scheduleFrame.
  }
}

/** @param {boolean} on */
function createHarness(on) {
  /** @type {Array<{ category: string, event: string, payload: Record<string, unknown> }>} */
  const events = [];
  let finishReplayCalls = 0;
  const base = createChatHistoryReplayLifecycle({
    active: () => on,
    trace: (category, event, payload) => {
      events.push({ category, event, payload: payload || {} });
    },
  });
  const lifecycle = {
    noteAsyncLoopStarted: (generation) => base.noteAsyncLoopStarted(generation),
    noteBatch: (generation, sample) => base.noteBatch(generation, sample),
    finishReplay: (generation, input) => {
      finishReplayCalls += 1;
      base.finishReplay(generation, input);
    },
    getActiveAsyncLoops: () => base.getActiveAsyncLoops(),
    beginReplay: (input) => base.beginReplay(input),
    noteSyncApplied: (generation, syncApplied) => base.noteSyncApplied(generation, syncApplied),
    reset: () => {
      finishReplayCalls = 0;
      base.reset();
    },
    getFinishReplayCalls: () => finishReplayCalls,
  };
  return { lifecycle, events };
}

/** @param {number} count @param {number} failAtApplied */
function makeRecords(count, failAtApplied = -1) {
  const records = [];
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  return {
    records: Array.from({ length: count }, (_, index) => ({ id: index, message: `m${index}` })),
    applyHistoryRecord: () => {
      const nextApplied = applied + 1;
      if (failAtApplied >= 0 && nextApplied === failAtApplied) {
        throw new Error('apply-fail');
      }
      applied = nextApplied;
    },
    getAppliedMeta: () => ({ applied, children: applied }),
  };
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();
{
  const { lifecycle, events } = createHarness(true);
  const total = HISTORY_REPLAY_SYNC_HEAD + 12;
  const { records, applyHistoryRecord, getAppliedMeta } = makeRecords(total, HISTORY_REPLAY_SYNC_HEAD + 5);
  const run = lifecycle.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  let caught = null;
  try {
    await runHistoryReplayAsyncTail({
      records,
      startIndex: HISTORY_REPLAY_SYNC_HEAD,
      replayGeneration: run.generation,
      lifecycle,
      scheduleFrame: (cb) => cb(),
      applyHistoryRecord,
      finalizeTail: () => {},
      getAppliedMeta,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(lifecycle.getFinishReplayCalls(), 1);
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
  assert.equal(currentSpanName(), 'idle');
  const end = events.find((row) => row.event === 'end');
  assert.ok(end);
  assert.equal(end.payload.reason, 'error');
  assert.equal(end.payload.applied, HISTORY_REPLAY_SYNC_HEAD + 4);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();
{
  const { lifecycle, events } = createHarness(true);
  const total = HISTORY_REPLAY_SYNC_HEAD + 4;
  const { records, applyHistoryRecord, getAppliedMeta } = makeRecords(total);
  const run = lifecycle.beginReplay({
    source: 'local',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  let caught = null;
  try {
    await runHistoryReplayAsyncTail({
      records,
      startIndex: HISTORY_REPLAY_SYNC_HEAD,
      replayGeneration: run.generation,
      lifecycle,
      scheduleFrame: (cb) => cb(),
      applyHistoryRecord,
      finalizeTail: () => {
        throw new Error('finalize-fail');
      },
      getAppliedMeta,
    });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught?.message, 'finalize-fail');
  assert.equal(lifecycle.getFinishReplayCalls(), 1);
  assert.equal(lifecycle.getActiveAsyncLoops(), 0);
  assert.equal(currentSpanName(), 'idle');
  const end = events.find((row) => row.event === 'end');
  assert.ok(end);
  assert.equal(end.payload.reason, 'error');
  assert.equal(end.payload.applied, total);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();
{
  const { lifecycle, events } = createHarness(true);
  const tail = 5;
  const total = HISTORY_REPLAY_SYNC_HEAD + tail;
  const records = Array.from({ length: total }, (_, index) => ({ id: index }));
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  const run = lifecycle.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  await runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: run.generation,
    lifecycle,
    scheduleFrame: (cb) => cb(),
    applyHistoryRecord: () => {
      spinForMs(1);
      applied += 1;
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied, children: applied }),
  });
  const batches = events.filter((row) => row.event === 'batch');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].payload.batchRecords, tail);
  assert.equal(batches[0].payload.applied, total);
  assert.ok(Number(batches[0].payload.applyMs) >= tail);
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();
{
  const { lifecycle, events } = createHarness(true);
  const tailLength = 19;
  const total = HISTORY_REPLAY_SYNC_HEAD + tailLength;
  const records = Array.from({ length: total }, (_, index) => ({ id: index }));
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  const run = lifecycle.beginReplay({
    source: 'http',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  await runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: run.generation,
    lifecycle,
    scheduleFrame: (cb) => cb(),
    applyHistoryRecord: () => {
      spinForMs(2);
      applied += 1;
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied, children: applied }),
  });
  const batches = events.filter((row) => row.event === 'batch');
  const recordsPerSlice = Math.max(1, Math.floor(UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS / 2));
  const expectedBatches = Math.ceil(tailLength / recordsPerSlice);
  assert.equal(batches.length, expectedBatches);
  const appliedTotal = batches.reduce(
    (sum, row) => sum + Math.round(Number(row.payload.batchRecords) || 0),
    0,
  );
  assert.equal(appliedTotal, tailLength);
  assert.equal(batches[batches.length - 1].payload.applied, total);
}

console.log('chat-history-replay-async-loop.test.js: ok');
