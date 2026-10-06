/**
 * Local / HTTP hydration coordination with live WS events and replay generation.
 *
 * Owns: local→HTTP merge mode (replace vs catch-up), replay settle tracking, and
 * buffering live socket frames while an async history replay tail is still running.
 */

import {
  dedupeHistoryRecords,
  sortRecordsForViewApply,
} from './chatHistoryConvergence.js';
import {
  hasSdkHistoryRoomWatermarks,
  ownsSdkHistoryHydration,
} from './sdkEventReplayGuard.js';

export const LOCAL_HTTP_MERGE_CATCH_UP = 'catch_up';
export const LOCAL_HTTP_MERGE_REPLACE = 'replace';

/**
 * @param {object | null | undefined} chat
 * @param {boolean} structuredReplayDone
 * @returns {'catch_up' | 'replace'}
 */
export function resolveLocalToHttpMergeMode(chat, structuredReplayDone) {
  if (structuredReplayDone === true && hasSdkHistoryRoomWatermarks(chat)) {
    return LOCAL_HTTP_MERGE_CATCH_UP;
  }
  return LOCAL_HTTP_MERGE_REPLACE;
}

/**
 * @param {object | null | undefined} chat
 * @param {unknown} generation
 * @returns {boolean}
 */
export function ownsHydrationForViewGeneration(chat, generation) {
  return ownsSdkHistoryHydration(chat, generation);
}

/**
 * Remembers the in-flight replay promise for this chat (latest generation wins).
 *
 * @param {object | null | undefined} chat
 * @param {Promise<unknown>} promise
 */
/**
 * Live frames buffered after hydration ended but while replay suppress* flags still run.
 *
 * @param {object | null | undefined} chat
 * @returns {Array<Record<string, unknown>>}
 */
export function takePendingLiveEventsAfterReplaySettle(chat) {
  if (!chat || typeof chat !== 'object') return [];
  if (chat._sdkHistoryHydrating === true) return [];
  if (!Array.isArray(chat._sdkPendingRoomEvents) || chat._sdkPendingRoomEvents.length === 0) {
    return [];
  }
  const pending = chat._sdkPendingRoomEvents.splice(0);
  if (chat._sdkPendingRoomEvents.length === 0) delete chat._sdkPendingRoomEvents;
  return pending;
}

/**
 * @param {object} chat
 * @param {Array<Record<string, unknown>>} pending
 */
function flushPendingLiveEventsAfterReplaySettle(chat, pending) {
  if (!pending.length) return;
  if (typeof chat._flushPendingSdkRoomEvents === 'function') {
    void chat._flushPendingSdkRoomEvents(pending);
    return;
  }
  for (const message of pending) {
    chat._processSdkSocketMessage?.(message);
  }
}

export function trackHistoryReplayPromise(chat, promise) {
  if (!chat || typeof chat !== 'object') return;
  const generation = Math.round(Number(chat._sdkActiveHistoryReplayGeneration) || 0);
  const tracked = Promise.resolve(promise).finally(() => {
    if (chat._sdkTrackedHistoryReplayGeneration !== generation) return;
    delete chat._sdkTrackedHistoryReplayGeneration;
    delete chat._sdkHistoryReplaySettlePromise;
    const pending = takePendingLiveEventsAfterReplaySettle(chat);
    flushPendingLiveEventsAfterReplaySettle(chat, pending);
  });
  chat._sdkTrackedHistoryReplayGeneration = generation;
  chat._sdkHistoryReplaySettlePromise = tracked;
}

/**
 * @param {object | null | undefined} chat
 * @returns {Promise<void>}
 */
export async function waitForHistoryReplaySettled(chat) {
  if (!chat || typeof chat !== 'object') return;
  const pending = chat._sdkHistoryReplaySettlePromise;
  if (!pending) return;
  await pending.catch(() => {});
}

/**
 * True while an async replay tail may still hold suppress* flags on the view.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isHistoryReplayInFlight(chat) {
  if (!chat || typeof chat !== 'object') return false;
  return !!chat._sdkHistoryReplaySettlePromise;
}

/**
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
function isNonReplayTaggedLiveFrame(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.replay === true) return false;
  const type = typeof message.type === 'string' ? message.type : '';
  return type === 'sdkEvent' || type === 'sdkHistoryChanged';
}

/**
 * Buffers live WS frames that arrive while hydration or an async replay tail runs.
 *
 * @param {object} chat
 * @param {Record<string, unknown>} message
 * @returns {boolean} true when the message was buffered (caller must not apply)
 */
export function bufferLiveEventDuringHistoryReplay(chat, message) {
  if (!chat || typeof chat !== 'object') return false;
  if (!isNonReplayTaggedLiveFrame(message)) return false;
  if (chat._sdkLiveDuringHydration === true) return false;
  const hydrating = chat._sdkHistoryHydrating === true;
  const replayInFlight = isHistoryReplayInFlight(chat);
  if (!hydrating && !replayInFlight) return false;
  if (chat._sdkReplayTagged === true && message.replay !== true) return false;
  if (!Array.isArray(chat._sdkPendingRoomEvents)) chat._sdkPendingRoomEvents = [];
  chat._sdkPendingRoomEvents.push(message);
  return true;
}

/**
 * Builds the expected merged history for tests (deduped, chronological).
 *
 * @param {{
 *   localRecords?: unknown[],
 *   httpRecords?: unknown[],
 *   liveRecords?: unknown[],
 *   mode?: 'catch_up' | 'replace',
 * }} input
 * @returns {unknown[]}
 */
export function buildExpectedHydratedHistory(input) {
  const local = Array.isArray(input.localRecords) ? input.localRecords : [];
  const http = Array.isArray(input.httpRecords) ? input.httpRecords : [];
  const live = Array.isArray(input.liveRecords) ? input.liveRecords : [];
  const mode = input.mode === LOCAL_HTTP_MERGE_CATCH_UP
    ? LOCAL_HTTP_MERGE_CATCH_UP
    : LOCAL_HTTP_MERGE_REPLACE;
  const base = mode === LOCAL_HTTP_MERGE_CATCH_UP ? [...local, ...http] : http;
  return sortRecordsForViewApply(dedupeHistoryRecords([...base, ...live]));
}

/**
 * Test-only: drop replay tracking fields on a chat stub.
 *
 * @param {object | null | undefined} chat
 */
export function resetHistoryReplayTrackingForTests(chat) {
  if (!chat || typeof chat !== 'object') return;
  delete chat._sdkTrackedHistoryReplayGeneration;
  delete chat._sdkHistoryReplaySettlePromise;
}
