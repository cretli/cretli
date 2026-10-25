/**
 * Time-sliced hydration of boot-cache rows after the synchronous bootstrap (task 5.3).
 */

import {
  applyIfFresh,
  createSliceSession,
  forEachInTimeSlices,
} from '../../lib/schedulerYield.js';

/**
 * @typedef {object} BootListHydrationGuard
 * @property {() => boolean} isSessionFresh
 * @property {() => boolean} isListFresh
 * @property {() => boolean} [isIdbEpochFresh]
 */

/**
 * Tracks cancellation for async boot list hydration.
 */
export function createChatBootListHydrationController() {
  /** @type {ReturnType<typeof createSliceSession>} */
  let sliceSession = createSliceSession();
  let listRevision = 0;
  /** @type {{ sessionId: string, generation: number }} */
  let sessionScope = { sessionId: '', generation: 0 };
  let idbEpoch = 0;
  /** Monotonic token; `cancel()` and scope/revision bumps invalidate in-flight IIFE continuations. */
  let runEpoch = 0;
  /**
   * @param {{ sessionId?: string, generation?: number }} scope
   */
  function setSessionScope(scope) {
    const next = {
      sessionId: typeof scope.sessionId === 'string' ? scope.sessionId : '',
      generation: Number(scope.generation) || 0,
    };
    if (next.sessionId === sessionScope.sessionId && next.generation === sessionScope.generation) return;
    sessionScope = next;
    runEpoch += 1;
    sliceSession.cancel();
    sliceSession = createSliceSession();
  }
  /**
   * @param {number} epoch
   */
  function setIdbEpoch(epoch) {
    const next = Number(epoch) || 0;
    if (next === idbEpoch) return;
    idbEpoch = next;
    runEpoch += 1;
    sliceSession.cancel();
    sliceSession = createSliceSession();
  }
  function bumpListRevision() {
    listRevision += 1;
    runEpoch += 1;
    sliceSession.cancel();
    sliceSession = createSliceSession();
  }
  function cancel() {
    runEpoch += 1;
    sliceSession.cancel();
    sliceSession = createSliceSession();
  }
  /** @returns {() => boolean} */
  function captureRunEpoch() {
    const captured = runEpoch;
    return () => runEpoch === captured;
  }
  /** @returns {BootListHydrationGuard} */
  function createGuard() {
    const capturedListRevision = listRevision;
    const capturedScope = { ...sessionScope };
    const capturedIdbEpoch = idbEpoch;
    return {
      isSessionFresh: () =>
        sessionScope.sessionId === capturedScope.sessionId
        && sessionScope.generation === capturedScope.generation,
      isListFresh: () => listRevision === capturedListRevision,
      isIdbEpochFresh: () => idbEpoch === capturedIdbEpoch,
    };
  }
  /**
   * @param {BootListHydrationGuard} guard
   * @returns {boolean}
   */
  function isGuardFresh(guard) {
    if (!guard) return false;
    if (!guard.isSessionFresh() || !guard.isListFresh()) return false;
    if (guard.isIdbEpochFresh && !guard.isIdbEpochFresh()) return false;
    return true;
  }
  /**
   * @param {object[]} rows
   * @param {(row: object) => void} applyRow
   * @param {import('../../lib/schedulerYield.js').SchedulerYieldDeps & { budgetMs?: number }} [deps]
   * @param {{ guard?: BootListHydrationGuard, isRunActive?: () => boolean }} [options]
   * @returns {Promise<{ applied: number, cancelled: boolean }>}
   */
  async function hydrateRows(rows, applyRow, deps, options = {}) {
    const guard = options.guard || createGuard();
    const isRunActive = typeof options.isRunActive === 'function' ? options.isRunActive : () => true;
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return { applied: 0, cancelled: false };
    const budgetMs = deps && Number.isFinite(Number(deps.budgetMs)) ? Number(deps.budgetMs) : undefined;
    const result = await forEachInTimeSlices(list, {
      session: sliceSession,
      deps,
      budgetMs,
      onItem: (row) => {
        if (!isRunActive() || !isGuardFresh(guard)) return;
        const token = sliceSession.captureToken();
        applyIfFresh(sliceSession, token, () => {
          if (!isRunActive() || !isGuardFresh(guard)) return;
          applyRow(row);
        });
      },
    });
    const cancelled = result.cancelled || !isRunActive() || !isGuardFresh(guard);
    return { applied: result.processed, cancelled };
  }
  return {
    setSessionScope,
    setIdbEpoch,
    bumpListRevision,
    cancel,
    captureGuard: createGuard,
    captureRunEpoch,
    isGuardFresh,
    hydrateRows,
    getListRevision: () => listRevision,
  };
}

/** @type {ReturnType<typeof createChatBootListHydrationController> | null} */
let sharedHydrationController = null;

/** @returns {ReturnType<typeof createChatBootListHydrationController>} */
export function getChatBootListHydrationController() {
  if (!sharedHydrationController) {
    sharedHydrationController = createChatBootListHydrationController();
  }
  return sharedHydrationController;
}

export function __resetChatBootListHydrationControllerForTest() {
  sharedHydrationController = null;
}

/**
 * @param {ReturnType<typeof import('./chatLocalBootCache.js').parseChatLocalBootCache>} fullDoc
 * @param {Set<string>} existingIds
 * @returns {object[]}
 */
export function selectBootRowsMissingFromRuntime(fullDoc, existingIds) {
  if (!fullDoc || !Array.isArray(fullDoc.chats)) return [];
  const seen = existingIds instanceof Set ? existingIds : new Set();
  /** @type {object[]} */
  const missing = [];
  for (const row of fullDoc.chats) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    missing.push(row);
  }
  return missing;
}
