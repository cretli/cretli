/**
 * Production history convergence: fetch, yield, apply, hydration, notifications.
 * Store ACK is not proof the current view instance still holds those records.
 */

import {
  HISTORY_SYNC_STATUS,
  captureViewApplyToken,
  getViewAppliedOrigin,
  getViewAppliedSeq,
  isViewApplyTokenCurrent,
  resolveChatHistoryConvergence,
  shouldClearPendingRemoteHistory,
  syncViewAppliedSessionKey,
} from './chatHistoryConvergence.js';
import { applyCatchUpSdkHistoryRecords, replaySdkRichViewHistory } from './chatHistoryViewApply.js';
import { beginSdkHistoryHydration, ownsSdkHistoryHydration } from './sdkEventReplayGuard.js';
import { setChatPendingRemoteHistoryFlag } from './chatPendingRemoteHistoryFlag.js';

/**
 * Runtime fields consumed by convergence and its service callbacks.
 * @typedef {{
 *   id?: string,
 *   cursorSessionId?: string,
 *   _wsGeneration?: number,
 *   _unackedPingAt?: number,
 *   _sdkHistoryHydrating?: boolean,
 *   _sdkHistoryRepairing?: boolean,
 *   _sdkViewAppliedSeqs?: Set<number>,
 *   _sdkRichView?: object,
 * }} HistoryConvergenceChat
 */

/**
 * @typedef {{
 *   now?: () => number,
 *   isDocumentHidden?: () => boolean,
 *   getResumeDeferMs?: (reason: string) => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   yieldToMain?: () => Promise<void>,
 *   fetchDelta: (chat: HistoryConvergenceChat) => Promise<{
 *     headSeq?: number,
 *     ackSeq?: number,
 *     events?: unknown[],
 *     incomplete?: boolean,
 *   } | null>,
 *   fetchTail?: (chat: HistoryConvergenceChat) => Promise<{ events?: unknown[] } | null>,
 *   replayTail?: typeof replaySdkRichViewHistory,
 *   readLocal: (chat: HistoryConvergenceChat) => Promise<{ events?: unknown[] } | null>,
 *   applyCatchUp?: (chat: HistoryConvergenceChat, records: unknown[]) => Promise<number>,
 *   completeHydration?: (chat: HistoryConvergenceChat, records: unknown[]) => void,
 *   onApplied?: (chat: HistoryConvergenceChat) => void,
 *   notifyReachable?: (chat: HistoryConvergenceChat) => void,
 *   getDraftAndScroll?: (chat: HistoryConvergenceChat) => { draftText: string, scrollTop: number },
 *   getBackgroundMs?: () => number,
 *   getUnackedPingAgeMs?: (chat: HistoryConvergenceChat) => number,
 *   getStoreAckSeq?: (chat: HistoryConvergenceChat) => number,
 *   log?: (tag: string, message: string, payload?: object) => void,
 *   trace?: (tag: string, phase: string, payload?: object) => void,
 * }} SdkHistoryConvergenceDeps
 */

/**
 * Finish hydration only when this run still owns the current generation.
 *
 * @param {HistoryConvergenceChat | null | undefined} chat
 * @param {{ view?: object | null, generation?: number } | null | undefined} token
 * @param {unknown[]} records
 * @param {SdkHistoryConvergenceDeps} deps
 */
function completeOwnedHydration(chat, token, records, deps) {
  if (!ownsSdkHistoryHydration(chat, token?.generation)) return;
  deps.completeHydration?.(chat, records);
}

/**
 * @param {HistoryConvergenceChat | null | undefined} chat
 * @param {{ view?: object | null, generation?: number }} token
 * @param {SdkHistoryConvergenceDeps} deps
 * @returns {{ status: string, deferReason: string, shouldClearPending: boolean } | null}
 */
function abortIfViewReplaced(chat, token, deps) {
  if (isViewApplyTokenCurrent(chat, token)) return null;
  completeOwnedHydration(chat, token, [], deps);
  deps.log?.('chat-sync', 'resume aborted after view replace', {
    chatId: chat?.id,
  });
  return {
    status: HISTORY_SYNC_STATUS.DEFERRED,
    deferReason: 'view_replaced',
    shouldClearPending: false,
  };
}

/**
 * One production catch-up cycle for the current pane instance.
 *
 * @param {HistoryConvergenceChat} chat
 * @param {{ reason?: string } | undefined} context
 * @param {SdkHistoryConvergenceDeps} deps
 * @returns {Promise<object>}
 */
export async function runSdkHistoryConvergence(chat, context = {}, deps) {
  const reason = String(context.reason || 'unknown');
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const syncStartedAt = now();
  const backgroundMs = deps.getBackgroundMs?.() || 0;
  const unackedPingAgeMs = deps.getUnackedPingAgeMs?.(chat) || 0;
  syncViewAppliedSessionKey(chat.id, chat, chat.cursorSessionId || '');
  const repairTail = reason === 'room_state_missing_interactive';
  const token = captureViewApplyToken(chat);
  deps.log?.('chat-sync', 'resume sync start', {
    chatId: chat.id,
    reason,
    backgroundMs,
    socketGeneration: Number(chat._wsGeneration) || 0,
    unackedPingAgeMs,
    storeAckSeq: deps.getStoreAckSeq?.(chat) || 0,
    viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
  });
  deps.trace?.('chat-sync', 'start', {
    chatId: chat.id,
    reason,
    hydrating: chat._sdkHistoryHydrating === true,
  });
  if (deps.isDocumentHidden?.() === true) {
    return { status: HISTORY_SYNC_STATUS.DEFERRED, deferReason: 'document_hidden' };
  }
  const resumeDeferMs = deps.getResumeDeferMs?.(reason) || 0;
  if (resumeDeferMs > 0) {
    deps.log?.('chat-sync', 'resume sync deferred', {
      chatId: chat.id,
      reason,
      deferMs: resumeDeferMs,
    });
    await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(resumeDeferMs);
    const abortedAfterDefer = abortIfViewReplaced(chat, token, deps);
    if (abortedAfterDefer) return abortedAfterDefer;
    if (deps.isDocumentHidden?.() === true) {
      return { status: HISTORY_SYNC_STATUS.DEFERRED, deferReason: 'document_hidden' };
    }
  }
  if (repairTail) {
    if (chat._sdkHistoryHydrating !== true) beginSdkHistoryHydration(chat);
    chat._sdkHistoryRepairing = true;
  }
  const { draftText, scrollTop } = deps.getDraftAndScroll?.(chat) || { draftText: '', scrollTop: 0 };
  const viewAppliedBefore = getViewAppliedSeq(chat.id, chat);
  const storeAckBefore = deps.getStoreAckSeq?.(chat) || 0;
  let serverState = null;
  let fetchFailed = false;
  const fetchStartedAt = now();
  try {
    serverState = await (repairTail ? deps.fetchTail(chat) : deps.fetchDelta(chat));
    if (!serverState) fetchFailed = true;
  } catch (err) {
    fetchFailed = true;
    deps.log?.('chat-sync', 'resume fetch failed', {
      chatId: chat.id,
      reason,
      error: String(err?.message || err),
    });
  }
  const fetchMs = now() - fetchStartedAt;
  const abortedAfterFetch = abortIfViewReplaced(chat, token, deps);
  if (abortedAfterFetch) return abortedAfterFetch;
  if (repairTail) {
    const records = Array.isArray(serverState?.events) ? serverState.events : [];
    try {
      if (fetchFailed || records.length === 0) throw new Error('History tail unavailable');
      const replay = await (deps.replayTail || replaySdkRichViewHistory)(chat, records, {
        instant: true, source: reason,
      });
      const aborted = abortIfViewReplaced(chat, token, deps);
      if (aborted) return aborted;
      if (replay.reason !== 'complete' || replay.applied !== records.length) {
        throw new Error('History tail replay incomplete');
      }
      completeOwnedHydration(chat, token, records, deps);
      deps.onApplied?.(chat);
      return { status: HISTORY_SYNC_STATUS.SUCCESS, shouldClearPending: false };
    } catch (err) {
      completeOwnedHydration(chat, token, [], deps);
      deps.log?.('chat-sync', 'interactive history repair failed', { chatId: chat.id, error: String(err) });
      return { status: HISTORY_SYNC_STATUS.ERROR, shouldClearPending: false };
    }
  }
  let localRecords = [];
  try {
    const local = await deps.readLocal(chat);
    localRecords = Array.isArray(local?.events) ? local.events : [];
  } catch (err) {
    deps.log?.('chat-sync', 'local history read failed', {
      chatId: chat.id,
      error: String(err?.message || err),
    });
  }
  const abortedAfterLocal = abortIfViewReplaced(chat, token, deps);
  if (abortedAfterLocal) return abortedAfterLocal;
  const decision = resolveChatHistoryConvergence({
    reason,
    documentHidden: deps.isDocumentHidden?.() === true,
    backgroundMs,
    socketGeneration: Number(chat._wsGeneration) || 0,
    unackedPingAgeMs,
    serverHeadSeq: Number(serverState?.headSeq) || storeAckBefore,
    storeAckSeq: Number(serverState?.ackSeq) || deps.getStoreAckSeq?.(chat) || 0,
    viewAppliedSeq: viewAppliedBefore,
    viewAppliedSeqs: chat._sdkViewAppliedSeqs,
    viewAppliedOrigin: getViewAppliedOrigin(chat.id, chat),
    fetchedRecords: Array.isArray(serverState?.events) ? serverState.events : [],
    localRecords,
    fetchFailed,
    fetchIncomplete: serverState?.incomplete === true,
    draftText,
    scrollTop,
  });
  deps.log?.('chat-sync', 'resume sync decision', decision.diagnostics);
  if (decision.status === HISTORY_SYNC_STATUS.ERROR && fetchFailed) {
    completeOwnedHydration(chat, token, [], deps);
    return decision;
  }
  if (decision.status === HISTORY_SYNC_STATUS.DEFERRED) {
    return decision;
  }
  let applied = 0;
  let applyMs = 0;
  const applyCatchUp = deps.applyCatchUp || applyCatchUpSdkHistoryRecords;
  if (decision.shouldApplyToView && token.view) {
    try {
      if (typeof deps.yieldToMain === 'function') await deps.yieldToMain();
      const abortedAfterYield = abortIfViewReplaced(chat, token, deps);
      if (abortedAfterYield) return abortedAfterYield;
      const applyStartedAt = now();
      applied = await applyCatchUp(chat, decision.recordsToApply);
      applyMs = now() - applyStartedAt;
      const abortedAfterApply = abortIfViewReplaced(chat, token, deps);
      if (abortedAfterApply) return abortedAfterApply;
      if (applied > 0) deps.onApplied?.(chat);
    } catch (err) {
      deps.log?.('chat-sync', 'resume apply failed', {
        chatId: chat.id,
        reason,
        error: String(err?.message || err),
      });
      completeOwnedHydration(chat, token, [], deps);
      return {
        ...decision,
        status: HISTORY_SYNC_STATUS.ERROR,
        shouldClearPending: false,
        deferReason: 'apply_failed',
      };
    }
  }
  const abortedBeforeHydration = abortIfViewReplaced(chat, token, deps);
  if (abortedBeforeHydration) return abortedBeforeHydration;
  const records = Array.isArray(serverState?.events) ? serverState.events : [];
  completeOwnedHydration(chat, token, records, deps);
  const viewAppliedAfter = getViewAppliedSeq(chat.id, chat);
  const result = {
    ...decision,
    viewAppliedSeq: viewAppliedAfter,
    shouldClearPending: shouldClearPendingRemoteHistory({
      status: decision.status,
      headSeq: Number(serverState?.headSeq) || 0,
      viewAppliedSeq: viewAppliedAfter,
    }),
  };
  if (result.shouldClearPending) {
    setChatPendingRemoteHistoryFlag(chat, false);
  }
  if (result.status !== HISTORY_SYNC_STATUS.DEFERRED) {
    deps.notifyReachable?.(chat);
  }
  deps.trace?.('chat-sync', 'complete', {
    chatId: chat.id,
    reason,
    received: records.length,
    applied,
    fetchMs,
    applyMs,
    totalMs: now() - syncStartedAt,
    status: result.status,
  });
  deps.log?.('chat-sync', 'resume catch-up complete', {
    chatId: chat.id,
    reason,
    received: records.length,
    applied,
    fetchMs,
    applyMs,
    totalMs: now() - syncStartedAt,
    headSeq: serverState?.headSeq,
    ackSeq: serverState?.ackSeq,
    viewAppliedSeq: viewAppliedAfter,
    status: result.status,
    hasRichView: !!chat._sdkRichView,
    draftUnchanged: (deps.getDraftAndScroll?.(chat).draftText || '') === draftText,
  });
  return result;
}
