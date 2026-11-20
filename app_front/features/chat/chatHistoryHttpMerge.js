/**
 * Applies authoritative HTTP history onto the rich view after local boot / replay settle.
 */

import {
  captureViewApplyToken,
  isViewApplyTokenCurrent,
  syncViewAppliedSessionKey,
} from './chatHistoryConvergence.js';
import { applyCatchUpSdkHistoryRecords, replaySdkRichViewHistory } from './chatHistoryViewApply.js';
import {
  resolveLocalToHttpMergeMode,
  LOCAL_HTTP_MERGE_CATCH_UP,
  waitForHistoryReplaySettled,
} from './chatHistoryHydrationLive.js';
import { rememberHistoryWindowStart } from './chatHistoryWindowOrder.js';
import { replaceSdkChatHistoryRecords } from '../../lib/sdk-chat-history-store.js';

/**
 * @typedef {{
 *   chatId: string,
 *   sessionKey: string,
 *   cursorSessionId: string,
 *   viewToken: { view?: object | null, generation?: number },
 * }} HydrationHttpBoundary
 */

/**
 * Snapshot chat/session/view ownership before a slow HTTP history pull.
 *
 * @param {object | null | undefined} chat
 * @param {string} sessionKey
 * @returns {HydrationHttpBoundary}
 */
export function captureHydrationHttpBoundary(chat, sessionKey) {
  const chatId = typeof chat?.id === 'string' ? chat.id : '';
  const resolvedSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const cursorSessionId =
    typeof chat?.cursorSessionId === 'string' ? chat.cursorSessionId.trim() : '';
  return {
    chatId,
    sessionKey: resolvedSessionKey,
    cursorSessionId,
    viewToken: captureViewApplyToken(chat),
  };
}

/**
 * @param {object | null | undefined} chat
 * @param {HydrationHttpBoundary | null | undefined} boundary
 * @returns {boolean}
 */
export function isHydrationHttpBoundaryCurrent(chat, boundary) {
  if (!boundary || typeof boundary !== 'object') return false;
  const chatId = typeof chat?.id === 'string' ? chat.id : '';
  if (boundary.chatId && chatId !== boundary.chatId) return false;
  const cursorSessionId =
    typeof chat?.cursorSessionId === 'string' ? chat.cursorSessionId.trim() : '';
  if (boundary.cursorSessionId && cursorSessionId !== boundary.cursorSessionId) return false;
  if (boundary.sessionKey && cursorSessionId !== boundary.sessionKey) return false;
  return isViewApplyTokenCurrent(chat, boundary.viewToken);
}

/**
 * @param {object} chat
 * @param {unknown[]} serverEvents
 * @param {string} sessionKey
 * @param {boolean} structuredReplayDone
 * @param {HydrationHttpBoundary | null | undefined} httpBoundary
 * @param {(target: object) => void} [syncPlainBuffer]
 * @returns {Promise<{ hydratedRecords: unknown[], structuredReplayDone: boolean, staleHttp?: boolean }>}
 */
export async function mergeServerSdkHistoryIntoRichView(
  chat,
  serverEvents,
  sessionKey,
  structuredReplayDone,
  httpBoundary,
  syncPlainBuffer,
) {
  if (!chat?._sdkRichView || !Array.isArray(serverEvents) || serverEvents.length === 0) {
    return { hydratedRecords: serverEvents || [], structuredReplayDone };
  }
  const boundary = httpBoundary || captureHydrationHttpBoundary(chat, sessionKey);
  await waitForHistoryReplaySettled(chat);
  if (!isHydrationHttpBoundaryCurrent(chat, boundary)) {
    return { hydratedRecords: [], structuredReplayDone, staleHttp: true };
  }
  const resolvedSessionKey = sessionKey || '';
  const mergeMode = resolveLocalToHttpMergeMode(chat, structuredReplayDone);
  if (mergeMode === LOCAL_HTTP_MERGE_CATCH_UP) {
    const applied = await applyCatchUpSdkHistoryRecords(chat, serverEvents);
    if (!isHydrationHttpBoundaryCurrent(chat, boundary)) {
      return { hydratedRecords: [], structuredReplayDone, staleHttp: true };
    }
    if (applied > 0 && typeof syncPlainBuffer === 'function') syncPlainBuffer(chat);
    if (resolvedSessionKey) {
      await replaceSdkChatHistoryRecords(chat.id, resolvedSessionKey, serverEvents);
    }
    return { hydratedRecords: serverEvents, structuredReplayDone: true };
  }
  if (!isHydrationHttpBoundaryCurrent(chat, boundary)) {
    return { hydratedRecords: [], structuredReplayDone, staleHttp: true };
  }
  rememberHistoryWindowStart(chat, serverEvents, { reset: true });
  syncViewAppliedSessionKey(chat.id, chat, resolvedSessionKey);
  await replaySdkRichViewHistory(chat, serverEvents, { instant: true, source: 'http' });
  if (!isHydrationHttpBoundaryCurrent(chat, boundary)) {
    return { hydratedRecords: [], structuredReplayDone, staleHttp: true };
  }
  if (resolvedSessionKey) {
    await replaceSdkChatHistoryRecords(chat.id, resolvedSessionKey, serverEvents);
  }
  if (typeof syncPlainBuffer === 'function') syncPlainBuffer(chat);
  return { hydratedRecords: serverEvents, structuredReplayDone: true };
}
