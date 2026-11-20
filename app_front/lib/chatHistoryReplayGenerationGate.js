/**
 * Per rich-view replay generation gate — at most one generation may run async
 * tail apply/finalize and scheduled scroll work.
 */

/**
 * @returns {{
 *   getActiveGeneration: () => number,
 *   activate: (generation: number) => void,
 *   revoke: () => void,
 *   isActive: (generation: number) => boolean,
 *   cancelPendingScrollFrames: () => void,
 *   scheduleGuardedScroll: (
 *     generation: number,
 *     run: () => void,
 *     scheduleFrame?: (cb: () => void) => void,
 *   ) => void,
 * }}
 */
export function createChatHistoryReplayGenerationGate() {
  /** @type {number} */
  let activeGeneration = 0;
  /** One frame at a time; a custom scheduler gives no id, so this tracks it. */
  let framePending = false;
  /** @type {number} */
  let pendingFrameId = 0;
  /** @type {Map<number, Set<() => void>>} */
  let mergedFrameWork = new Map();

  /**
   * @param {(cb: () => void) => void} [scheduleFrame]
   * @returns {(cb: () => void) => number}
   */
  function resolveScheduler(scheduleFrame) {
    if (typeof scheduleFrame === 'function') {
      return (cb) => {
        const id = /** @type {unknown} */ (scheduleFrame(cb));
        return typeof id === 'number' ? id : 0;
      };
    }
    if (typeof requestAnimationFrame === 'function') {
      return (cb) => requestAnimationFrame(cb);
    }
    return (cb) => {
      setTimeout(cb, 0);
      return 0;
    };
  }

  /**
   * Drops queued work of replay generations. Live work (generation 0) stays: it
   * includes resets such as re-enabling stick tracking after a page prepend, and
   * losing those leaves the view stuck.
   */
  function cancelPendingScrollFrames() {
    const live = mergedFrameWork.get(0);
    mergedFrameWork = new Map();
    if (live && live.size > 0) {
      mergedFrameWork.set(0, live);
      return;
    }
    if (pendingFrameId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pendingFrameId);
      pendingFrameId = 0;
      framePending = false;
    }
  }

  /**
   * @param {number} generation `0` = live DOM work (always runs).
   * @param {() => void} run
   * @param {(cb: () => void) => void} [scheduleFrame]
   */
  function scheduleMergedFrameWork(generation, run, scheduleFrame) {
    const gen = Math.max(0, Math.round(Number(generation) || 0));
    if (!mergedFrameWork.has(gen)) mergedFrameWork.set(gen, new Set());
    mergedFrameWork.get(gen).add(run);
    if (framePending) return;
    framePending = true;
    const schedule = resolveScheduler(scheduleFrame);
    pendingFrameId = schedule(() => {
      framePending = false;
      pendingFrameId = 0;
      const snapshot = mergedFrameWork;
      mergedFrameWork = new Map();
      for (const [frameGen, workSet] of snapshot) {
        if (frameGen > 0 && !isActive(frameGen)) continue;
        for (const fn of workSet) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  /**
   * @param {number} generation
   * @returns {boolean}
   */
  function isActive(generation) {
    const gen = Math.round(Number(generation) || 0);
    return gen > 0 && gen === activeGeneration;
  }

  return {
    getActiveGeneration() {
      return activeGeneration;
    },
    activate(generation) {
      cancelPendingScrollFrames();
      activeGeneration = Math.max(0, Math.round(Number(generation) || 0));
    },
    revoke() {
      cancelPendingScrollFrames();
      activeGeneration = 0;
    },
    isActive,
    cancelPendingScrollFrames,
    /**
     * One animation frame per scroll adjustment; stale generations are dropped.
     *
     * @param {number} generation
     * @param {() => void} run
     * @param {(cb: () => void) => void} [scheduleFrame]
     */
    scheduleGuardedScroll(generation, run, scheduleFrame) {
      scheduleMergedFrameWork(generation, () => {
        if (!isActive(generation)) return;
        run();
      }, scheduleFrame);
    },
    scheduleMergedFrameWork,
  };
}
