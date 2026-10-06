/**
 * Apply catch-up and live history cards to the current rich view.
 * Room watermarks move only after a successful render on this view instance.
 */

import {
  captureViewApplyToken,
  isViewApplyTokenCurrent,
  noteViewAppliedRecords,
  replaceViewAppliedRecords,
  sortRecordsForViewApply,
} from './chatHistoryConvergence.js';
import { emptyHistoryReplayResult } from '../../lib/chatHistoryReplayResult.js';
import {
  selectMissingSdkHistoryRecords,
  selectRoomCoveredSdkHistoryRecords,
  takeMissingSdkHistoryRecords,
} from './sdkEventReplayGuard.js';
import {
  partitionRecordsByWindowStart,
  rememberHistoryWindowStart,
} from './chatHistoryWindowOrder.js';
import { trackHistoryReplayPromise } from './chatHistoryHydrationLive.js';

/**
 * @param {unknown} record
 * @returns {string}
 */
function readLocalUserText(record) {
  if (!record || typeof record !== 'object') return '';
  const text = /** @type {{ kind?: unknown, text?: unknown }} */ (record).text;
  if (/** @type {{ kind?: unknown }} */ (record).kind !== 'localUser') return '';
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Optimistic echoes already sit in the DOM. Do not mark coverage for a prompt
 * the current view still does not hold.
 *
 * @param {object | null | undefined} view
 * @param {unknown} record
 * @returns {boolean}
 */
function isCatchUpRecordVisibleInView(view, record) {
  if (!record || typeof record !== 'object') return false;
  if (/** @type {{ kind?: unknown }} */ (record).kind !== 'localUser') return true;
  const text = readLocalUserText(record);
  if (!text) return false;
  if (typeof view?.hasQueuedOrSentUserText === 'function') {
    return view.hasQueuedOrSentUserText(text) === true;
  }
  if (!Array.isArray(view?.nodes)) return false;
  return view.nodes.some((row) => readLocalUserText(row) === text);
}

/**
 * @param {object | null | undefined} view
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
function selectVisibleCatchUpRecords(view, records) {
  if (!Array.isArray(records)) return [];
  return records.filter((record) => isCatchUpRecordVisibleInView(view, record));
}

/**
 * View coverage for a replay: only the applied prefix counts as rendered.
 *
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @param {unknown[]} records
 * @param {number} appliedCount
 * @returns {number}
 */
export function applyReplayViewCoverage(chatId, chat, records, appliedCount) {
  const list = Array.isArray(records) ? records : [];
  const count = Math.min(list.length, Math.max(0, Math.round(Number(appliedCount) || 0)));
  return replaceViewAppliedRecords(chatId, chat, list.slice(0, count));
}

/**
 * @param {object | null | undefined} chat
 * @param {unknown[]} records
 * @param {{ instant?: boolean, source?: string }} [opts]
 * @returns {Promise<import('../../lib/chatHistoryReplayResult.js').HistoryReplayResult>}
 */
export async function replaySdkRichViewHistory(chat, records, opts = {}) {
  const view = chat?._sdkRichView;
  if (!view || typeof view.replayHistoryRecords !== 'function') {
    return emptyHistoryReplayResult();
  }
  if (!Array.isArray(records) || records.length === 0) {
    return emptyHistoryReplayResult();
  }
  const token = captureViewApplyToken(chat);
  const replayPromise = view.replayHistoryRecords(records, opts);
  trackHistoryReplayPromise(chat, replayPromise);
  const result = await replayPromise;
  if (!isViewApplyTokenCurrent(chat, token)) return result;
  const activeGen = Math.round(Number(chat._sdkActiveHistoryReplayGeneration) || 0);
  if (activeGen !== result.generation) return result;
  applyReplayViewCoverage(chat.id, chat, records, result.applied);
  return result;
}

/**
 * Applies a server catch-up batch without putting older streams under the
 * already-rendered window. localUser rows have no stream id; they still apply
 * with prompt-text dedupe. Room-covered live/replay events are not redrawn,
 * but their historySeq is noted so contiguous coverage can catch up.
 *
 * @param {object} chat
 * @param {unknown[]} incomingRecords
 * @returns {Promise<number>} number of records applied to the view
 */
export async function applyCatchUpSdkHistoryRecords(chat, incomingRecords) {
  const token = captureViewApplyToken(chat);
  const view = token.view;
  if (!view || !Array.isArray(incomingRecords) || incomingRecords.length === 0) {
    return 0;
  }
  const chronological = sortRecordsForViewApply(incomingRecords);
  const missing = selectMissingSdkHistoryRecords(chat, chronological);
  const roomCovered = selectRoomCoveredSdkHistoryRecords(chat, chronological);
  const windowOldestAt =
    typeof chat._historyWindowOldestAt === 'string' ? chat._historyWindowOldestAt : '';
  const missingParts = partitionRecordsByWindowStart(missing, windowOldestAt);
  /** @type {unknown[]} */
  const rendered = [];
  if (missingParts.older.length > 0) {
    const older = partitionRecordsByWindowStart(chronological, windowOldestAt).older;
    const toPrepend = older.length > 0 ? older : missingParts.older;
    view.prependHistoryRecords(toPrepend);
    if (!isViewApplyTokenCurrent(chat, token)) return 0;
    rememberHistoryWindowStart(chat, toPrepend);
    rendered.push(...selectVisibleCatchUpRecords(view, toPrepend));
  }
  if (missingParts.newer.length > 0) {
    await Promise.resolve(
      view.appendHistoryRecords(missingParts.newer, {
        instant: true,
        forceScroll: false,
      })
    );
    if (!isViewApplyTokenCurrent(chat, token)) return 0;
    rendered.push(...selectVisibleCatchUpRecords(view, missingParts.newer));
  }
  if (!isViewApplyTokenCurrent(chat, token)) return 0;
  if (rendered.length === 0 && roomCovered.length === 0) return 0;
  takeMissingSdkHistoryRecords(chat, missing);
  noteViewAppliedRecords(chat.id, chat, [...rendered, ...roomCovered]);
  return rendered.length;
}

/**
 * Live mailbox/delegation cards from sdkHistoryChanged. Do not note coverage
 * until the current view instance finishes rendering.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {Promise<void>}
 */
export function applyLiveServerHistoryCards(chat, records) {
  const token = captureViewApplyToken(chat);
  const view = token.view;
  if (!view || !Array.isArray(records) || records.length === 0) {
    return Promise.resolve();
  }
  if (typeof view.appendHistoryRecords !== 'function') return Promise.resolve();
  return Promise.resolve(
    view.appendHistoryRecords(records, {
      instant: true,
      forceScroll: false,
    })
  ).then(() => {
    if (!isViewApplyTokenCurrent(chat, token)) return;
    noteViewAppliedRecords(chat.id, chat, records);
  });
}
