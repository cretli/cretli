/**
 * History replay apply pacing — wall-clock slice budget + macrotask yield + one rAF per slice.
 *
 * Slice size is governed by {@link UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS}, not a fixed record
 * count. {@link HISTORY_REPLAY_CHUNK_SIZE} is an emergency cap only when `deps.now()` does not
 * advance between apply calls in the same slice (`elapsedMs === 0`), so runaway work still yields.
 */

import { monoNow } from './chatPerfBudget.js';
import { HISTORY_REPLAY_CHUNK_SIZE } from './chatHistoryReplayLifecycle.js';
import { UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS } from './uiFreezeRenderBudgets.js';
import {
  createDefaultSchedulerYieldDeps,
  yieldToNewTask,
} from './schedulerYield.js';

/**
 * @param {(cb: () => void) => void} [scheduleFrame]
 * @returns {Promise<void>}
 */
function awaitOneAnimationFrame(scheduleFrame) {
  return new Promise((resolve) => {
    if (typeof scheduleFrame === 'function') {
      scheduleFrame(() => resolve());
      return;
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * @param {{
 *   records: unknown[],
 *   startIndex: number,
 *   endIndexExclusive: number,
 *   replayGeneration: number,
 *   applyHistoryRecord: (record: unknown, index: number) => void,
 *   lifecycle?: {
 *     noteBatch: (generation: number, sample: Record<string, unknown>) => void,
 *   },
 *   isCancelled?: () => boolean,
 *   budgetMs?: number,
 *   deps?: ReturnType<typeof createDefaultSchedulerYieldDeps>,
 *   scheduleFrame?: (cb: () => void) => void,
 *   onSliceStart?: () => void,
 *   onSliceEnd?: () => void,
 * }} input
 * @returns {Promise<{ appliedIndex: number, cancelled: boolean }>}
 */
export async function runHistoryReplayApplySlices(input) {
  const records = Array.isArray(input.records) ? input.records : [];
  const startIndex = Math.max(0, Math.round(Number(input.startIndex) || 0));
  const endIndexExclusive = Math.min(
    records.length,
    Math.max(startIndex, Math.round(Number(input.endIndexExclusive) || 0)),
  );
  const deps = input.deps || createDefaultSchedulerYieldDeps();
  const budgetMs = Number.isFinite(Number(input.budgetMs))
    ? Number(input.budgetMs)
    : UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
  const isCancelled =
    typeof input.isCancelled === 'function' ? input.isCancelled : () => false;
  const readClock = () => deps.now();
  let index = startIndex;
  let batchApplyStartedAt = monoNow();
  let batchRecords = 0;
  while (index < endIndexExclusive) {
    if (isCancelled()) {
      return { appliedIndex: index, cancelled: true };
    }
    input.onSliceStart?.();
    const sliceStart = readClock();
    let itemsInSlice = 0;
    try {
      while (index < endIndexExclusive) {
        if (isCancelled()) break;
        if (itemsInSlice > 0) {
          const elapsedMs = readClock() - sliceStart;
          if (elapsedMs >= budgetMs) break;
          if (elapsedMs === 0 && itemsInSlice >= HISTORY_REPLAY_CHUNK_SIZE) break;
        }
        input.applyHistoryRecord(records[index], index);
        index += 1;
        itemsInSlice += 1;
        batchRecords += 1;
      }
    } finally {
      input.onSliceEnd?.();
    }
    if (index >= endIndexExclusive) break;
    if (isCancelled()) {
      return { appliedIndex: index, cancelled: true };
    }
    const applyMs = monoNow() - batchApplyStartedAt;
    const yieldStartedAt = monoNow();
    await yieldToNewTask(deps);
    const yieldMs = monoNow() - yieldStartedAt;
    if (input.lifecycle && batchRecords > 0) {
      input.lifecycle.noteBatch(input.replayGeneration, {
        batchRecords,
        applyMs,
        yieldMs,
        batchMs: applyMs + yieldMs,
        applied: index,
      });
    }
    batchRecords = 0;
    batchApplyStartedAt = monoNow();
    await awaitOneAnimationFrame(input.scheduleFrame);
    if (isCancelled()) {
      return { appliedIndex: index, cancelled: true };
    }
  }
  if (input.lifecycle && batchRecords > 0 && !isCancelled()) {
    const applyMs = monoNow() - batchApplyStartedAt;
    input.lifecycle.noteBatch(input.replayGeneration, {
      batchRecords,
      applyMs,
      yieldMs: 0,
      batchMs: applyMs,
      applied: index,
    });
  }
  return { appliedIndex: index, cancelled: false };
}
