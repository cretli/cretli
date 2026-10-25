/**
 * Shared async tail for history replay (time-sliced apply + lifecycle batch timing).
 */

import { monoNow } from './chatPerfBudget.js';
import { runHistoryReplayApplySlices } from './chatHistoryReplayApplySlice.js';
import { runHistoryReplayFinalizeSlices } from './chatHistoryReplayFinalizeSlice.js';

/**
 * @param {{
 *   records: unknown[],
 *   startIndex: number,
 *   replayGeneration: number,
 *   applyHistoryRecord: (record: unknown) => void,
 *   lifecycle: {
 *     noteAsyncLoopStarted: (generation: number) => void,
 *     noteBatch: (generation: number, sample: Record<string, unknown>) => void,
 *     finishReplay: (generation: number, input: Record<string, unknown>) => void,
 *   },
 *   finalizeTail?: () => void,
 *   getFinalizeSteps?: () => Array<() => void>,
 *   getAppliedMeta: () => { applied: number, children: number },
 *   scheduleFrame?: (cb: () => void) => void,
 *   isCancelled?: () => boolean,
 *   onSliceStart?: () => void,
 *   onSliceEnd?: () => void,
 *   deps?: import('./schedulerYield.js').SchedulerYieldDeps,
 * }} input
 */
export async function runHistoryReplayAsyncTail(input) {
  const { records, startIndex, replayGeneration, lifecycle } = input;
  const isCancelled =
    typeof input.isCancelled === 'function' ? input.isCancelled : () => false;
  const recordCount = Array.isArray(records) ? records.length : 0;
  const tailLength = Math.max(0, recordCount - startIndex);
  if (tailLength === 0) {
    lifecycle.finishReplay(replayGeneration, {
      reason: 'complete',
      applied: Math.min(recordCount, startIndex),
      children: input.getAppliedMeta().children,
      finalizeMs: 0,
    });
    return;
  }
  if (isCancelled()) {
    const meta = input.getAppliedMeta();
    lifecycle.finishReplay(replayGeneration, {
      reason: 'cancelled',
      applied: meta.applied,
      children: meta.children,
      finalizeMs: 0,
    });
    return;
  }
  lifecycle.noteAsyncLoopStarted(replayGeneration);
  let finishReason = 'complete';
  let cancelled = false;
  /** @type {unknown} */
  let applyError = null;
  try {
    const sliceResult = await runHistoryReplayApplySlices({
      records,
      startIndex,
      endIndexExclusive: recordCount,
      replayGeneration,
      lifecycle,
      scheduleFrame: input.scheduleFrame,
      deps: input.deps,
      isCancelled,
      onSliceStart: input.onSliceStart,
      onSliceEnd: input.onSliceEnd,
      applyHistoryRecord: (record) => {
        input.applyHistoryRecord(record);
      },
    });
    cancelled = sliceResult.cancelled || isCancelled();
  } catch (err) {
    finishReason = 'error';
    applyError = err;
  }
  let finalizeMs = 0;
  /** @type {unknown} */
  let finalizeError = null;
  const shouldFinalize = !cancelled && finishReason === 'complete' && !isCancelled();
  try {
    if (shouldFinalize) {
      try {
        if (!isCancelled()) {
          const steps =
            typeof input.getFinalizeSteps === 'function' ? input.getFinalizeSteps() : null;
          if (Array.isArray(steps) && steps.length > 0) {
            const finalizeResult = await runHistoryReplayFinalizeSlices({
              steps,
              replayGeneration,
              deps: input.deps,
              scheduleFrame: input.scheduleFrame,
              isCancelled,
            });
            finalizeMs = finalizeResult.finalizeMs;
            if (finalizeResult.cancelled) cancelled = true;
          } else if (typeof input.finalizeTail === 'function') {
            const finalizeStartedAt = monoNow();
            input.finalizeTail();
            finalizeMs = monoNow() - finalizeStartedAt;
          }
        }
      } catch (err) {
        finalizeError = err;
        finishReason = 'error';
      }
    }
  } finally {
    const meta = input.getAppliedMeta();
    const resolvedReason = cancelled && finishReason === 'complete' ? 'cancelled' : finishReason;
    lifecycle.finishReplay(replayGeneration, {
      reason: resolvedReason,
      applied: meta.applied,
      children: meta.children,
      finalizeMs,
    });
  }
  if (finalizeError) throw finalizeError;
  if (applyError) throw applyError;
}
