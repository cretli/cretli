/**
 * Opt-in lifecycle diagnostics for `replayHistoryRecords` / chunked async replay.
 *
 * Task 0.1 — measurement and contracts only: logs generation, supersede, batch
 * timing (apply + yield + finalize) and keeps a single `history.replay` budget span open until the async
 * tail finishes (not only the first 20 synchronous records). When a newer replay
 * starts, the previous span closes with reason `superseded`; stale async loops
 * may still run (behaviour fix is a later stage) but are counted separately.
 *
 * No chat content crosses this boundary — only counts, durations, source labels
 * and generation ids.
 */

import { beginSpan, endSpan, monoNow, observeSample } from './chatPerfBudget.js';
import { getUiFreezeCounters } from './uiFreezeCounters.js';
import { isUiFreezeTraceActive, traceUiFreeze } from './uiFreezeTrace.js';

/** @typedef {'local' | 'http' | 'sdk-api' | 'unknown'} HistoryReplaySource */

export const HISTORY_REPLAY_TRACE_CATEGORY = 'history-replay';

export const HISTORY_REPLAY_SYNC_HEAD = 20;
export const HISTORY_REPLAY_CHUNK_SIZE = 8;

/**
 * @param {{ active?: () => boolean, trace?: typeof traceUiFreeze }} [options]
 */
export function createChatHistoryReplayLifecycle(options = {}) {
  const active = options.active || isUiFreezeTraceActive;
  const trace = options.trace || traceUiFreeze;

  let generation = 0;
  let activeAsyncLoops = 0;
  /** @type {Set<number>} */
  const registeredAsyncLoops = new Set();
  /** @type {Map<number, string>} */
  const closedSpanReasonByGeneration = new Map();

  /**
   * @type {{
   *   generation: number,
   *   source: HistoryReplaySource,
   *   totalRecords: number,
   *   syncHead: number,
   *   applied: number,
   *   batchCount: number,
   *   startedAt: number,
   *   spanOpen: boolean,
   * } | null}
   */
  let openReplay = null;

  /**
   * @param {HistoryReplaySource} source
   * @returns {HistoryReplaySource}
   */
  function normalizeSource(source) {
    const value = String(source || 'unknown').trim().toLowerCase();
    if (value === 'local' || value === 'http' || value === 'sdk-api') return value;
    return 'unknown';
  }

  /**
   * @param {typeof openReplay} meta
   * @param {string} reason
   * @param {number} applied
   * @param {number} [children]
   */
  function closeOpenSpan(meta, reason, applied, children = 0) {
    if (!meta?.spanOpen) return;
    const durationMs = monoNow() - meta.startedAt;
    const fields = {
      cards: meta.totalRecords,
      applied,
      source: meta.source,
      generation: meta.generation,
      reason,
      batches: meta.batchCount,
      children,
    };
    endSpan();
    meta.spanOpen = false;
    closedSpanReasonByGeneration.set(meta.generation, reason);
    const counters = getUiFreezeCounters();
    counters?.recordSpan('history.replay', durationMs, fields);
    observeSample({
      kind: 'history.replay',
      durationMs,
      ...fields,
    });
    trace(HISTORY_REPLAY_TRACE_CATEGORY, 'end', {
      generation: meta.generation,
      reason,
      durationMs: Math.round(durationMs),
      applied,
      totalRecords: meta.totalRecords,
      source: meta.source,
      batches: meta.batchCount,
      activeAsyncLoops,
    });
  }

  return {
    /** @returns {number} */
    getGeneration() {
      return generation;
    },
    /** @returns {number} */
    getActiveAsyncLoops() {
      return activeAsyncLoops;
    },
    /**
     * @param {{ source?: HistoryReplaySource, totalRecords: number, syncHead: number, instant: boolean }} input
     * @returns {{ generation: number, syncHead: number, trackAsync: boolean }}
     */
    beginReplay(input) {
      const totalRecords = Math.max(0, Math.round(Number(input.totalRecords) || 0));
      const syncHead = Math.min(
        totalRecords,
        Math.max(0, Math.round(Number(input.syncHead) || HISTORY_REPLAY_SYNC_HEAD)),
      );
      const instant = input.instant === true && totalRecords <= HISTORY_REPLAY_SYNC_HEAD;
      const trackAsync = !instant && totalRecords > syncHead;
      generation += 1;
      const nextGeneration = generation;
      if (!active()) {
        return { generation: nextGeneration, syncHead, trackAsync };
      }
      if (openReplay?.spanOpen) {
        getUiFreezeCounters()?.bump('history.replay.supersedes');
        trace(HISTORY_REPLAY_TRACE_CATEGORY, 'supersede', {
          previousGeneration: openReplay.generation,
          nextGeneration,
          appliedBeforeSupersede: openReplay.applied,
          activeAsyncLoops,
        });
        closeOpenSpan(openReplay, 'superseded', openReplay.applied);
      }
      /** @type {typeof openReplay} */
      const meta = {
        generation: nextGeneration,
        source: normalizeSource(input.source),
        totalRecords,
        syncHead,
        applied: 0,
        batchCount: 0,
        startedAt: monoNow(),
        spanOpen: true,
      };
      openReplay = meta;
      getUiFreezeCounters()?.bump('history.replay.starts');
      getUiFreezeCounters()?.recordSpanStart('history.replay', {
        cards: totalRecords,
        source: meta.source,
        generation: nextGeneration,
        syncHead,
        trackAsync,
      });
      beginSpan('history.replay', {
        cards: totalRecords,
        source: meta.source,
        generation: nextGeneration,
        syncHead,
        trackAsync,
      });
      trace(HISTORY_REPLAY_TRACE_CATEGORY, 'start', {
        generation: nextGeneration,
        source: meta.source,
        totalRecords,
        syncHead,
        instant,
        trackAsync,
        activeAsyncLoops,
      });
      return { generation: nextGeneration, syncHead, trackAsync };
    },
    /**
     * @param {number} replayGeneration
     * @param {number} syncApplied
     */
    noteSyncApplied(replayGeneration, syncApplied) {
      if (!active() || !openReplay || openReplay.generation !== replayGeneration) return;
      openReplay.applied = Math.max(openReplay.applied, syncApplied);
      trace(HISTORY_REPLAY_TRACE_CATEGORY, 'sync-end', {
        generation: replayGeneration,
        syncApplied,
        totalRecords: openReplay.totalRecords,
      });
    },
    /** @param {number} replayGeneration */
    noteAsyncLoopStarted(replayGeneration) {
      if (registeredAsyncLoops.has(replayGeneration)) return;
      registeredAsyncLoops.add(replayGeneration);
      activeAsyncLoops = registeredAsyncLoops.size;
      if (!active()) return;
      trace(HISTORY_REPLAY_TRACE_CATEGORY, 'async-start', {
        generation: replayGeneration,
        activeAsyncLoops,
      });
    },
    /**
     * @param {number} replayGeneration
     * @param {{ batchRecords: number, batchMs: number, applied: number }} sample
     */
    noteBatch(replayGeneration, sample) {
      if (!active() || !openReplay || openReplay.generation !== replayGeneration) return;
      openReplay.batchCount += 1;
      openReplay.applied = Math.max(openReplay.applied, sample.applied);
      getUiFreezeCounters()?.bump('history.replay.batches');
      trace(HISTORY_REPLAY_TRACE_CATEGORY, 'batch', {
        generation: replayGeneration,
        batchIndex: openReplay.batchCount,
        batchRecords: sample.batchRecords,
        applyMs: Math.round(Number(sample.applyMs) || 0),
        yieldMs: Math.round(Number(sample.yieldMs) || 0),
        batchMs: Math.round(Number(sample.batchMs) || 0),
        applied: sample.applied,
        totalRecords: openReplay.totalRecords,
      });
    },
    /**
     * @param {number} replayGeneration
     * @param {{ reason: string, applied: number, children?: number }} input
     */
    finishReplay(replayGeneration, input) {
      if (registeredAsyncLoops.has(replayGeneration)) {
        registeredAsyncLoops.delete(replayGeneration);
        activeAsyncLoops = registeredAsyncLoops.size;
        if (active()) {
          trace(HISTORY_REPLAY_TRACE_CATEGORY, 'async-end', {
            generation: replayGeneration,
            reason: input.reason,
            activeAsyncLoops,
            finalizeMs: Math.round(Number(input.finalizeMs) || 0),
          });
        }
      }
      if (!active()) return;
      if (!openReplay || openReplay.generation !== replayGeneration) {
        const priorClose = closedSpanReasonByGeneration.get(replayGeneration);
        if (input.reason === 'complete' && priorClose === 'destroyed') {
          trace(HISTORY_REPLAY_TRACE_CATEGORY, 'destroy-async-complete', {
            generation: replayGeneration,
            applied: input.applied,
            activeAsyncLoops,
          });
          return;
        }
        if (input.reason === 'complete' && priorClose === 'superseded') {
          getUiFreezeCounters()?.bump('history.replay.staleCompletes');
          trace(HISTORY_REPLAY_TRACE_CATEGORY, 'stale-complete', {
            generation: replayGeneration,
            applied: input.applied,
            activeAsyncLoops,
          });
        }
        if (input.reason === 'error') {
          trace(HISTORY_REPLAY_TRACE_CATEGORY, 'async-error-after-close', {
            generation: replayGeneration,
            priorClose: priorClose || 'none',
            applied: input.applied,
          });
        }
        return;
      }
      openReplay.applied = Math.max(openReplay.applied, input.applied);
      closeOpenSpan(openReplay, input.reason, openReplay.applied, input.children || 0);
      openReplay = null;
    },
    /** @param {number} [children] */
    onViewDestroyed(children = 0) {
      if (!active() || !openReplay?.spanOpen) return;
      trace(HISTORY_REPLAY_TRACE_CATEGORY, 'destroy', {
        generation: openReplay.generation,
        applied: openReplay.applied,
        activeAsyncLoops,
      });
      closeOpenSpan(openReplay, 'destroyed', openReplay.applied, children);
      openReplay = null;
    },
    /** Test seam */
    reset() {
      generation = 0;
      activeAsyncLoops = 0;
      registeredAsyncLoops.clear();
      closedSpanReasonByGeneration.clear();
      openReplay = null;
    },
  };
}

/** @type {ReturnType<typeof createChatHistoryReplayLifecycle> | null} */
let sharedLifecycle = null;

/**
 * Per-process singleton; each rich view should prefer a closure instance when
 * multiple mounts are tested in one page.
 * @returns {ReturnType<typeof createChatHistoryReplayLifecycle>}
 */
export function createHistoryReplayLifecycleForView() {
  return createChatHistoryReplayLifecycle();
}
