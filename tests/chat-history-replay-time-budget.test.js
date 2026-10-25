/**
 * Stage 2.2 — replay apply uses wall-clock slice budget (not fixed record counts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHistoryReplayApplySlices } from '../app_front/lib/chatHistoryReplayApplySlice.js';
import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import { createChatHistoryReplayGenerationGate } from '../app_front/lib/chatHistoryReplayGenerationGate.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import {
  UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS,
  UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT,
} from '../app_front/lib/uiFreezeRenderBudgets.js';
import {
  countViewportAnchorBatchesForTimeBudget,
  createViewportAnchorBatchController,
} from '../app_front/lib/sdkRichViewViewportBatch.js';
import { createDefaultSchedulerYieldDeps } from '../app_front/lib/schedulerYield.js';

/** @returns {{ deps: ReturnType<typeof createDefaultSchedulerYieldDeps>, advanceMs: (ms: number) => void, flushYield: () => Promise<void>, flushRaf: () => void }} */
function createControlledYieldDeps() {
  let clock = 0;
  /** @type {Array<() => void>} */
  const timerQueue = [];
  /** @type {Array<() => void>} */
  const rafQueue = [];
  const deps = createDefaultSchedulerYieldDeps();
  deps.MessageChannel = undefined;
  deps.scheduler = undefined;
  deps.now = () => clock;
  deps.setTimeoutFn = (fn) => {
    timerQueue.push(fn);
    return timerQueue.length;
  };
  deps.requestAnimationFrameFn = (fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  };
  return {
    deps,
    advanceMs(ms) {
      clock += ms;
    },
    async flushYield() {
      while (timerQueue.length) {
        const batch = timerQueue.splice(0);
        for (const fn of batch) fn();
        await Promise.resolve();
      }
    },
    flushRaf() {
      while (rafQueue.length) {
        const batch = rafQueue.splice(0);
        for (const fn of batch) fn();
      }
    },
  };
}

/** @param {Promise<unknown>} promise @param {() => Promise<void>} flush */
async function settleWithFlush(promise, flush) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await flush();
    const settled = await Promise.race([
      promise.then(() => true, () => true),
      Promise.resolve(false),
    ]);
    if (settled) return;
  }
  await promise;
}

async function runTests() {
  {
    const budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
    const msPerRecord = 3;
    const recordCount = 20;
    const expectedBatches = countViewportAnchorBatchesForTimeBudget(recordCount, budgetMs, msPerRecord);
    assert.ok(expectedBatches > 1, 'slow apply must split into multiple viewport batches');
    const batch = createViewportAnchorBatchController({ capture: () => {}, restore: () => {} });
    let clock = 0;
    batch.forEachRecordInTimeBudget(0, recordCount, () => {
      clock += msPerRecord;
    }, {
      budgetMs,
      now: () => clock,
    });
    assert.equal(batch.getRestoreCalls(), expectedBatches);
  }

  {
    const budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
    const harness = createControlledYieldDeps();
    const recordsPerSlowSlice = Math.max(1, Math.floor(budgetMs / 5));
    assert.ok(recordsPerSlowSlice <= 8, 'slow apply must respect time budget before emergency cap');
    const records = Array.from({ length: 12 }, (_, index) => ({ id: index }));
    let batchCount = 0;
    let recordsInFirstBatch = 0;
    let inFirstBatch = false;
    const applyPromise = runHistoryReplayApplySlices({
      records,
      startIndex: 0,
      endIndexExclusive: records.length,
      replayGeneration: 1,
      deps: harness.deps,
      budgetMs,
      scheduleFrame: (cb) => harness.deps.requestAnimationFrameFn?.(cb),
      onSliceStart: () => {
        batchCount += 1;
        inFirstBatch = batchCount === 1;
        if (inFirstBatch) recordsInFirstBatch = 0;
      },
      applyHistoryRecord: () => {
        harness.advanceMs(5);
        if (inFirstBatch) recordsInFirstBatch += 1;
      },
      onSliceEnd: () => {
        inFirstBatch = false;
      },
    });
    await settleWithFlush(applyPromise, async () => {
      await harness.flushYield();
      harness.flushRaf();
    });
    assert.ok(batchCount >= 2);
    assert.ok(recordsInFirstBatch <= recordsPerSlowSlice + 1);
    assert.ok(recordsInFirstBatch < records.length);
  }

  {
    const gate = createChatHistoryReplayGenerationGate();
    const scheduler = createControlledYieldDeps();
    gate.activate(1);
    let frameCallbacks = 0;
    let innerRan = false;
    gate.scheduleGuardedScroll(
      1,
      () => {
        frameCallbacks += 1;
        innerRan = true;
      },
      (cb) => scheduler.deps.requestAnimationFrameFn?.(cb),
    );
    scheduler.flushRaf();
    assert.equal(frameCallbacks, 1);
    assert.equal(innerRan, true);
    gate.activate(2);
    gate.scheduleGuardedScroll(
      1,
      () => {
        frameCallbacks += 1;
      },
      (cb) => scheduler.deps.requestAnimationFrameFn?.(cb),
    );
    scheduler.flushRaf();
    assert.equal(frameCallbacks, 1, 'stale generation scroll must be dropped');
  }

  {
    let replayRenderMode = false;
    let liveGapObserved = false;
    const records = Array.from({ length: 16 }, (_, index) => ({ id: index }));
    const harness = createControlledYieldDeps();
    const budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
    const applyPromise = runHistoryReplayApplySlices({
      records,
      startIndex: 0,
      endIndexExclusive: records.length,
      replayGeneration: 1,
      deps: harness.deps,
      budgetMs,
      scheduleFrame: (cb) => harness.deps.requestAnimationFrameFn?.(cb),
      onSliceStart: () => {
        replayRenderMode = true;
      },
      onSliceEnd: () => {
        replayRenderMode = false;
      },
      applyHistoryRecord: () => {
        harness.advanceMs(3);
        assert.equal(replayRenderMode, true, 'apply must run inside replay slice');
      },
    });
    const flushWithGapCheck = async () => {
      if (!replayRenderMode && liveGapObserved === false) {
        liveGapObserved = true;
      }
      await harness.flushYield();
      harness.flushRaf();
      if (!replayRenderMode) {
        liveGapObserved = true;
      }
    };
    await settleWithFlush(applyPromise, flushWithGapCheck);
    assert.equal(replayRenderMode, false);
    assert.equal(liveGapObserved, true, 'live gap between slices must not inherit replay render mode');
  }

  {
    const budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
    const harness = createControlledYieldDeps();
    const records = Array.from({ length: 24 }, (_, index) => ({ id: index }));
    let maxSliceMs = 0;
    let sliceStartClock = 0;
    const applyPromise = runHistoryReplayApplySlices({
      records,
      startIndex: 0,
      endIndexExclusive: records.length,
      replayGeneration: 2,
      deps: harness.deps,
      budgetMs,
      scheduleFrame: (cb) => harness.deps.requestAnimationFrameFn?.(cb),
      onSliceStart: () => {
        sliceStartClock = harness.deps.now();
      },
      onSliceEnd: () => {
        maxSliceMs = Math.max(maxSliceMs, harness.deps.now() - sliceStartClock);
      },
      applyHistoryRecord: () => {
        harness.advanceMs(2);
      },
    });
    await settleWithFlush(applyPromise, async () => {
      await harness.flushYield();
      harness.flushRaf();
    });
    assert.ok(
      maxSliceMs <= budgetMs + 0.001,
      `slice apply must not exceed budget (${maxSliceMs} > ${budgetMs})`,
    );
  }

  {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const fixture = JSON.parse(
      readFileSync(path.join(projectRoot, 'tests/fixtures/synthetic-history-replay-records.json'), 'utf8'),
    );
    assert.equal(fixture.records.length, UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT);
    const harness = createControlledYieldDeps();
    const budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
    const lifecycle = createChatHistoryReplayLifecycle({ active: () => false });
    const run = lifecycle.beginReplay({
      source: 'local',
      totalRecords: fixture.records.length,
      syncHead: HISTORY_REPLAY_SYNC_HEAD,
      instant: false,
    });
    let applied = HISTORY_REPLAY_SYNC_HEAD;
    const msPerRecord = 0.35;
    const msPerFinalizeStep = 0.4;
    const pipelineStartedAt = harness.deps.now();
    const pipelinePromise = runHistoryReplayAsyncTail({
      records: fixture.records,
      startIndex: HISTORY_REPLAY_SYNC_HEAD,
      replayGeneration: run.generation,
      lifecycle,
      deps: harness.deps,
      scheduleFrame: (cb) => harness.deps.requestAnimationFrameFn?.(cb),
      applyHistoryRecord: () => {
        harness.advanceMs(msPerRecord);
        applied += 1;
      },
      getFinalizeSteps: () =>
        Array.from({ length: 6 }, () => () => {
          harness.advanceMs(msPerFinalizeStep);
        }),
      getAppliedMeta: () => ({ applied, children: applied }),
    });
    await settleWithFlush(pipelinePromise, async () => {
      await harness.flushYield();
      harness.flushRaf();
    });
    const pipelineMs = harness.deps.now() - pipelineStartedAt;
    assert.equal(applied, fixture.records.length);
    assert.ok(
      pipelineMs <= 50,
      `synthetic tail pipeline should stay within 50 ms on controlled clock (${pipelineMs})`,
    );
  }

  console.log('chat-history-replay-time-budget.test.js: ok');
}

await runTests();
