/**
 * Time-sliced history replay finalize — same pacing as apply slices (yield + one rAF).
 */

import { monoNow } from './chatPerfBudget.js';
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
 *   steps: Array<() => void>,
 *   replayGeneration?: number,
 *   isCancelled?: () => boolean,
 *   budgetMs?: number,
 *   deps?: ReturnType<typeof createDefaultSchedulerYieldDeps>,
 *   scheduleFrame?: (cb: () => void) => void,
 * }} input
 * @returns {Promise<{ cancelled: boolean, finalizeMs: number }>}
 */
export async function runHistoryReplayFinalizeSlices(input) {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const deps = input.deps || createDefaultSchedulerYieldDeps();
  const budgetMs = Number.isFinite(Number(input.budgetMs))
    ? Number(input.budgetMs)
    : UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS;
  const isCancelled =
    typeof input.isCancelled === 'function' ? input.isCancelled : () => false;
  const readClock = () => deps.now();
  const finalizeStartedAt = monoNow();
  let index = 0;
  while (index < steps.length) {
    if (isCancelled()) {
      return { cancelled: true, finalizeMs: monoNow() - finalizeStartedAt };
    }
    const sliceStart = readClock();
    let stepsInSlice = 0;
    while (index < steps.length) {
      if (isCancelled()) {
        return { cancelled: true, finalizeMs: monoNow() - finalizeStartedAt };
      }
      if (stepsInSlice > 0) {
        const elapsedMs = readClock() - sliceStart;
        if (elapsedMs >= budgetMs) break;
      }
      steps[index]();
      index += 1;
      stepsInSlice += 1;
    }
    if (index >= steps.length) break;
    if (isCancelled()) {
      return { cancelled: true, finalizeMs: monoNow() - finalizeStartedAt };
    }
    await yieldToNewTask(deps);
    await awaitOneAnimationFrame(input.scheduleFrame);
  }
  return { cancelled: false, finalizeMs: monoNow() - finalizeStartedAt };
}
