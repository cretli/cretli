/**
 * Apply catch-up and live history cards to the current rich view.
 * Room watermarks move only after a successful render on this view instance.
 */

import {
  captureViewApplyToken,
  isViewApplyTokenCurrent,
  noteViewAppliedRecords,
  sortRecordsForViewApply,
} from './chatHistoryConvergence.js';
import {
  selectMissingSdkHistoryRecords,
  selectRoomCoveredSdkHistoryRecords,
  takeMissingSdkHistoryRecords,
} from './sdkEventReplayGuard.js';
import {
  partitionRecordsByWindowStart,
  rememberHistoryWindowStart,
} from './chatHistoryWindowOrder.js';

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
