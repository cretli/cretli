/**
 * Viewport anchor batching for history replay (UI freeze stage 2.1).
 * One geometry capture + one scroll restore per chunk, not per record.
 */

import { HISTORY_REPLAY_CHUNK_SIZE } from './chatHistoryReplayLifecycle.js';

/** Emergency record cap when `now()` does not advance within a time-budget slice. */
const TIME_BUDGET_EMERGENCY_RECORD_CAP = HISTORY_REPLAY_CHUNK_SIZE;
import { UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS } from './uiFreezeRenderBudgets.js';

/**
 * @param {number} recordCount
 * @param {number} [chunkSize]
 * @returns {number}
 */
export function countViewportAnchorBatches(recordCount, chunkSize = HISTORY_REPLAY_CHUNK_SIZE) {
  const total = Math.max(0, Math.round(Number(recordCount) || 0));
  const size = Math.max(1, Math.round(Number(chunkSize) || HISTORY_REPLAY_CHUNK_SIZE));
  if (total === 0) return 0;
  return Math.ceil(total / size);
}

/**
 * @param {number} syncHead
 * @param {number} totalRecords
 * @param {number} [chunkSize]
 * @returns {number}
 */
/**
 * @param {number} recordCount
 * @param {number} budgetMs
 * @param {number} msPerRecord
 * @returns {number}
 */
export function countViewportAnchorBatchesForTimeBudget(
  recordCount,
  budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS,
  msPerRecord = 1,
) {
  const total = Math.max(0, Math.round(Number(recordCount) || 0));
  const budget = Math.max(1, Number(budgetMs) || UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS);
  const perRecord = Math.max(0.001, Number(msPerRecord) || 1);
  if (total === 0) return 0;
  let index = 0;
  let batches = 0;
  while (index < total) {
    batches += 1;
    let clock = 0;
    let itemsInSlice = 0;
    while (index < total) {
      const withinBudget = itemsInSlice === 0 || clock < budget;
      if (!withinBudget) break;
      clock += perRecord;
      index += 1;
      itemsInSlice += 1;
    }
  }
  return batches;
}

/**
 * @param {number} syncHead
 * @param {number} totalRecords
 * @param {number} budgetMs
 * @param {number} msPerRecord
 * @returns {number}
 */
export function countReplayViewportAnchorBatchesForTimeBudget(
  syncHead,
  totalRecords,
  budgetMs = UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS,
  msPerRecord = 1,
) {
  const sync = Math.max(0, Math.round(Number(syncHead) || 0));
  const total = Math.max(0, Math.round(Number(totalRecords) || 0));
  const syncBatches = countViewportAnchorBatchesForTimeBudget(Math.min(sync, total), budgetMs, msPerRecord);
  const tailRecords = Math.max(0, total - sync);
  const tailBatches = countViewportAnchorBatchesForTimeBudget(tailRecords, budgetMs, msPerRecord);
  return syncBatches + tailBatches;
}

export function countReplayViewportAnchorBatches(syncHead, totalRecords, chunkSize = HISTORY_REPLAY_CHUNK_SIZE) {
  const sync = Math.max(0, Math.round(Number(syncHead) || 0));
  const total = Math.max(0, Math.round(Number(totalRecords) || 0));
  const syncBatches = countViewportAnchorBatches(Math.min(sync, total), chunkSize);
  const tailRecords = Math.max(0, total - sync);
  const tailBatches = countViewportAnchorBatches(tailRecords, chunkSize);
  return syncBatches + tailBatches;
}

/**
 * @param {{
 *   capture: () => void,
 *   restore: () => void,
 * }} hooks
 */
export function createViewportAnchorBatchController(hooks) {
  let depth = 0;
  let capturedThisBatch = false;
  let captureCalls = 0;
  let restoreCalls = 0;

  function begin() {
    depth += 1;
    if (depth === 1) capturedThisBatch = false;
  }

  function end() {
    if (depth <= 0) return;
    depth -= 1;
    if (depth !== 0) return;
    hooks.restore();
    restoreCalls += 1;
  }

  /**
   * @param {() => void} captureOnce
   * @param {() => void} markPreserve
   */
  function noteInsertBefore(captureOnce, markPreserve) {
    if (depth <= 0) {
      captureOnce();
      captureCalls += 1;
      return;
    }
    if (!capturedThisBatch) {
      captureOnce();
      capturedThisBatch = true;
      captureCalls += 1;
      return;
    }
    markPreserve();
  }

  /**
   * @param {number} startIndex
   * @param {number} endIndexExclusive
   * @param {(index: number) => void} onRecord
   * @param {number} [chunkSize]
   */
  function forEachRecordInBatches(startIndex, endIndexExclusive, onRecord, chunkSize = HISTORY_REPLAY_CHUNK_SIZE) {
    const total = Math.max(0, endIndexExclusive - startIndex);
    const size = Math.max(1, Math.round(Number(chunkSize) || HISTORY_REPLAY_CHUNK_SIZE));
    for (let index = startIndex; index < endIndexExclusive; index += 1) {
      const progress = index - startIndex;
      if (progress % size === 0) begin();
      try {
        onRecord(index);
      } catch (err) {
        while (depth > 0) end();
        throw err;
      } finally {
        const after = progress + 1;
        if (after % size === 0 || after === total) end();
      }
    }
  }

  /**
   * @param {number} startIndex
   * @param {number} endIndexExclusive
   * @param {(index: number) => void} onRecord
   * @param {{
   *   budgetMs?: number,
   *   now?: () => number,
   * }} [options]
   */
  function forEachRecordInTimeBudget(startIndex, endIndexExclusive, onRecord, options = {}) {
    const budgetMs = Number.isFinite(Number(options.budgetMs))
      ? Number(options.budgetMs)
      : UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
    const now =
      typeof options.now === 'function'
        ? options.now
        : () => {
            if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
              return performance.now();
            }
            return Date.now();
          };
    let index = startIndex;
    while (index < endIndexExclusive) {
      begin();
      const sliceStart = now();
      let itemsInSlice = 0;
      try {
        while (index < endIndexExclusive) {
          if (itemsInSlice > 0) {
            const elapsedMs = now() - sliceStart;
            if (elapsedMs >= budgetMs) break;
            if (elapsedMs === 0 && itemsInSlice >= TIME_BUDGET_EMERGENCY_RECORD_CAP) break;
          }
          onRecord(index);
          index += 1;
          itemsInSlice += 1;
        }
      } catch (err) {
        while (depth > 0) end();
        throw err;
      } finally {
        end();
      }
    }
  }

  return {
    begin,
    end,
    noteInsertBefore,
    forEachRecordInBatches,
    forEachRecordInTimeBudget,
    getDepth: () => depth,
    getCaptureCalls: () => captureCalls,
    getRestoreCalls: () => restoreCalls,
  };
}

/**
 * Simulates insert-before work on every record to assert capture calls scale with batches.
 *
 * @param {number} recordCount
 * @param {number} [chunkSize]
 * @returns {{ captureCalls: number, restoreCalls: number, batchCount: number }}
 */
export function simulateBatchedInsertBeforeCaptures(recordCount, chunkSize = HISTORY_REPLAY_CHUNK_SIZE) {
  const controller = createViewportAnchorBatchController({
    capture: () => {},
    restore: () => {},
  });
  controller.forEachRecordInBatches(0, recordCount, () => {
    controller.noteInsertBefore(
      () => {},
      () => {},
    );
  }, chunkSize);
  const batchCount = countViewportAnchorBatches(recordCount, chunkSize);
  return {
    captureCalls: controller.getCaptureCalls(),
    restoreCalls: controller.getRestoreCalls(),
    batchCount,
  };
}
