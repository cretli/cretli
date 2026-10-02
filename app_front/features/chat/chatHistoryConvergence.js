/**
 * Convergence of server history, local store, and the visible chat view.
 * Store ACK is not proof that the screen is current. The highest historySeq
 * of any applied card is not proof of contiguous coverage either.
 */

import { readRecordCreatedAt } from './chatHistoryWindowOrder.js';

export const HISTORY_SYNC_STATUS = Object.freeze({
  SUCCESS: 'success',
  DEFERRED: 'deferred',
  PARTIAL: 'partial',
  ERROR: 'error',
  UNCHANGED: 'unchanged',
});

/** Immediate retries after partial/error, then the 15s poll takes over. */
export const HISTORY_SYNC_RETRY_MAX = 4;

export const HISTORY_SYNC_RETRY_DELAYS_MS = Object.freeze([400, 1200, 3000, 8000]);

/** Mode-bar catch-up label must not outlive a hung fetch/IDB after PWA resume. */
export const HISTORY_SYNC_IN_FLIGHT_MAX_MS = 8000;

/** Drop a stuck tracker entry so a later resume can fetch again. */
export const HISTORY_SYNC_TRACKER_STALE_MS = 20000;

/** @type {Map<string, number>} */
const viewAppliedSeqByChatId = new Map();

/** @type {Map<string, Set<number>>} */
const viewAppliedSeqsByChatId = new Map();

/** Explicit start of the hydrated window (min seq of the last full replay). */
/** @type {Map<string, number>} */
const viewAppliedOriginByChatId = new Map();

/**
 * @param {unknown} record
 * @returns {number}
 */
export function resolveHistoryRecordSeq(record) {
  if (!record || typeof record !== 'object') return 0;
  const seq = Number(/** @type {{ historySeq?: unknown }} */ (record).historySeq);
  if (!Number.isSafeInteger(seq) || seq <= 0) return 0;
  return seq;
}

/**
 * @param {unknown[]} records
 * @param {number} [fallback]
 * @returns {number}
 */
export function resolveMaxHistorySeq(records, fallback = 0) {
  let maxSeq = Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 0;
  if (!Array.isArray(records)) return maxSeq;
  for (const record of records) {
    const seq = resolveHistoryRecordSeq(record);
    if (seq > maxSeq) maxSeq = seq;
  }
  return maxSeq;
}

/**
 * @param {unknown[]} records
 * @param {number} afterSeq
 * @returns {unknown[]}
 */
export function selectRecordsNewerThan(records, afterSeq) {
  const floor = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
  if (!Array.isArray(records)) return [];
  return records.filter((record) => {
    const seq = resolveHistoryRecordSeq(record);
    if (seq <= 0) return false;
    return seq > floor;
  });
}

/**
 * Stable identity for catch-up dedupe. Prefers durable history seq.
 *
 * @param {unknown} record
 * @returns {string}
 */
export function resolveHistoryRecordIdentity(record) {
  if (!record || typeof record !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (record);
  const seq = resolveHistoryRecordSeq(rec);
  if (seq > 0) return `seq:${seq}`;
  const streamId = typeof rec.eventStreamId === 'string' ? rec.eventStreamId.trim() : '';
  const roomSeq = Number(rec.roomEventSeq);
  if (streamId && Number.isSafeInteger(roomSeq) && roomSeq > 0) {
    return `room:${streamId}:${roomSeq}`;
  }
  if (rec.kind === 'meta' && typeof rec.variant === 'string' && rec.payload != null) {
    try {
      const payload = typeof rec.payload === 'string' ? JSON.parse(rec.payload) : rec.payload;
      const id = payload && typeof payload === 'object' ? String(payload.id || '').trim() : '';
      if (id) return `meta:${rec.variant}:${id}`;
    } catch {
      /* ignore malformed payload */
    }
  }
  return '';
}

/**
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function dedupeHistoryRecords(records) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const key = resolveHistoryRecordIdentity(record);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(record);
  }
  return out;
}

/**
 * Durable chronological order. historySeq wins so a later fetch page cannot
 * sit in front of earlier local rows before stream-watermark selection.
 *
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function sortRecordsForViewApply(records) {
  if (!Array.isArray(records)) return [];
  if (records.length < 2) return records.slice();
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftSeq = resolveHistoryRecordSeq(left.record);
      const rightSeq = resolveHistoryRecordSeq(right.record);
      if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) return leftSeq - rightSeq;
      const leftAt = readRecordCreatedAt(left.record);
      const rightAt = readRecordCreatedAt(right.record);
      if (leftAt && rightAt && leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
      return left.index - right.index;
    })
    .map((item) => item.record);
}

/**
 * @param {unknown[]} [fetchedRecords]
 * @param {unknown[]} [localRecords]
 * @returns {unknown[]}
 */
export function mergeHistoryRecordsForApply(fetchedRecords = [], localRecords = []) {
  const fetched = Array.isArray(fetchedRecords) ? fetchedRecords : [];
  const local = Array.isArray(localRecords) ? localRecords : [];
  return sortRecordsForViewApply(dedupeHistoryRecords([...fetched, ...local]));
}

/**
 * @param {unknown} value
 * @returns {Set<number> | null}
 */
function normalizeAppliedSeqSet(value) {
  if (value instanceof Set) {
    return value;
  }
  if (!Array.isArray(value)) return null;
  const set = new Set();
  for (const item of value) {
    const seq = Number(item);
    if (Number.isSafeInteger(seq) && seq > 0) set.add(seq);
  }
  return set;
}

/**
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @returns {Set<number>}
 */
export function getViewAppliedSeqs(chatId, chat) {
  if (chat && chat._sdkViewAppliedSeqs instanceof Set) {
    return chat._sdkViewAppliedSeqs;
  }
  const id = String(chatId || '').trim();
  if (!id) {
    const local = new Set();
    if (chat && typeof chat === 'object') chat._sdkViewAppliedSeqs = local;
    return local;
  }
  let set = viewAppliedSeqsByChatId.get(id);
  if (!set) {
    set = new Set();
    viewAppliedSeqsByChatId.set(id, set);
  }
  if (chat && typeof chat === 'object') chat._sdkViewAppliedSeqs = set;
  return set;
}

/**
 * A fetched row is unprocessed for this cycle even when a later live card
 * already raised the max applied seq. Do not use that max as a floor.
 *
 * @param {unknown[]} records
 * @param {{
 *   viewAppliedSeq?: number,
 *   viewAppliedSeqs?: Set<number> | number[],
 *   fetchedRecords?: unknown[],
 * }} [input]
 * @returns {unknown[]}
 */
export function selectUnappliedHistoryRecords(records, input = {}) {
  if (!Array.isArray(records)) return [];
  const viewAppliedSeq = Number(input?.viewAppliedSeq) || 0;
  const appliedSeqs = normalizeAppliedSeqSet(input?.viewAppliedSeqs);
  const fetchedSeqs = new Set();
  if (Array.isArray(input?.fetchedRecords)) {
    for (const record of input.fetchedRecords) {
      const seq = resolveHistoryRecordSeq(record);
      if (seq > 0) fetchedSeqs.add(seq);
    }
  }
  return records.filter((record) => {
    const seq = resolveHistoryRecordSeq(record);
    if (seq <= 0) return resolveHistoryRecordIdentity(record) !== '';
    if (appliedSeqs && appliedSeqs.has(seq)) return false;
    if (fetchedSeqs.has(seq)) return true;
    return seq > viewAppliedSeq;
  });
}

/**
 * Walks forward from a known floor. A lone live card must not invent coverage
 * for every seq below it — only an explicit hydrated-window origin may do that.
 *
 * @param {Set<number>} appliedSeqs
 * @param {number} current
 * @param {number} [origin]
 * @returns {number}
 */
function resolveContiguousAppliedSeq(appliedSeqs, current, origin = 0) {
  let start = Number.isSafeInteger(current) && current > 0 ? current : 0;
  const originSeq = Number.isSafeInteger(origin) && origin > 0 ? origin : 0;
  if (start <= 0 && originSeq > 0) start = originSeq - 1;
  let next = start;
  while (appliedSeqs.has(next + 1)) next += 1;
  return next > 0 ? next : 0;
}

/**
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function getViewAppliedOrigin(chatId, chat) {
  const fromChat = Number(chat?._sdkViewAppliedOrigin);
  if (Number.isSafeInteger(fromChat) && fromChat > 0) return fromChat;
  const id = String(chatId || '').trim();
  if (!id) return 0;
  return viewAppliedOriginByChatId.get(id) || 0;
}

/**
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @param {number} origin
 */
export function setViewAppliedOrigin(chatId, chat, origin) {
  if (!Number.isSafeInteger(origin) || origin < 0) return;
  const id = String(chatId || '').trim();
  if (id) viewAppliedOriginByChatId.set(id, origin);
  if (chat && typeof chat === 'object') chat._sdkViewAppliedOrigin = origin;
}

/**
 * @param {unknown[]} records
 * @returns {number}
 */
function resolveMinHistorySeq(records) {
  let minSeq = 0;
  if (!Array.isArray(records)) return 0;
  for (const record of records) {
    const seq = resolveHistoryRecordSeq(record);
    if (seq <= 0) continue;
    if (minSeq === 0 || seq < minSeq) minSeq = seq;
  }
  return minSeq;
}

/**
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function getViewApplyGeneration(chat) {
  const generation = Number(chat?._sdkViewApplyGeneration);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

/**
 * Invalidates in-flight catch-up / convergence after a pane or session swap.
 *
 * @param {object | null | undefined} chat
 * @returns {number}
 */
export function bumpViewApplyGeneration(chat) {
  if (!chat || typeof chat !== 'object') return 0;
  const next = getViewApplyGeneration(chat) + 1;
  chat._sdkViewApplyGeneration = next;
  return next;
}

/**
 * @param {object | null | undefined} chat
 * @returns {{ view: object | null, generation: number }}
 */
export function captureViewApplyToken(chat) {
  return {
    view: chat?._sdkRichView || null,
    generation: getViewApplyGeneration(chat),
  };
}

/**
 * @param {object | null | undefined} chat
 * @param {{ view?: object | null, generation?: number } | null | undefined} token
 * @returns {boolean}
 */
export function isViewApplyTokenCurrent(chat, token) {
  if (!token || typeof token !== 'object') return false;
  return chat?._sdkRichView === token.view && getViewApplyGeneration(chat) === Number(token.generation || 0);
}

/**
 * A new SDK session on the same chat id must not inherit the previous window.
 *
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @param {unknown} sessionKey
 * @returns {boolean} true when coverage was reset
 */
export function syncViewAppliedSessionKey(chatId, chat, sessionKey) {
  const next = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const previous = typeof chat?._sdkViewAppliedSessionKey === 'string'
    ? chat._sdkViewAppliedSessionKey.trim()
    : '';
  if (chat && typeof chat === 'object') chat._sdkViewAppliedSessionKey = next;
  if (!previous || !next || previous === next) return false;
  resetViewAppliedState(chatId, chat);
  if (chat && typeof chat === 'object') chat._sdkViewAppliedSessionKey = next;
  return true;
}

/**
 * @param {string} chatId
 * @param {object} [chat]
 * @returns {number}
 */
export function getViewAppliedSeq(chatId, chat) {
  const fromChat = Number(chat?._sdkViewAppliedSeq);
  if (Number.isSafeInteger(fromChat) && fromChat > 0) return fromChat;
  const id = String(chatId || '').trim();
  if (!id) return 0;
  return viewAppliedSeqByChatId.get(id) || 0;
}

/**
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @param {number} seq
 */
export function setViewAppliedSeq(chatId, chat, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) return;
  const id = String(chatId || '').trim();
  if (id) viewAppliedSeqByChatId.set(id, seq);
  if (chat && typeof chat === 'object') chat._sdkViewAppliedSeq = seq;
}

/**
 * Records which seqs the current view instance actually holds, then advances
 * the watermark only across a contiguous prefix. A live card at 102 must not
 * hide a still-missing 101.
 *
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @param {unknown[]} records
 * @returns {number}
 */
export function noteViewAppliedRecords(chatId, chat, records) {
  const appliedSeqs = getViewAppliedSeqs(chatId, chat);
  if (Array.isArray(records)) {
    for (const record of records) {
      const seq = resolveHistoryRecordSeq(record);
      if (seq > 0) appliedSeqs.add(seq);
    }
  }
  const next = resolveContiguousAppliedSeq(
    appliedSeqs,
    getViewAppliedSeq(chatId, chat),
    getViewAppliedOrigin(chatId, chat)
  );
  setViewAppliedSeq(chatId, chat, next);
  return next;
}

/**
 * Full replay / hydration of the current view instance.
 *
 * @param {string} chatId
 * @param {object | null | undefined} chat
 * @param {unknown[]} records
 * @returns {number}
 */
export function replaceViewAppliedRecords(chatId, chat, records) {
  const appliedSeqs = getViewAppliedSeqs(chatId, chat);
  appliedSeqs.clear();
  setViewAppliedSeq(chatId, chat, 0);
  setViewAppliedOrigin(chatId, chat, resolveMinHistorySeq(records));
  return noteViewAppliedRecords(chatId, chat, records);
}

/**
 * Drop view watermarks after the pane is destroyed. Store ACK stays.
 *
 * @param {string} chatId
 * @param {object | null | undefined} chat
 */
export function resetViewAppliedState(chatId, chat) {
  const id = String(chatId || '').trim();
  if (id) {
    viewAppliedSeqByChatId.delete(id);
    viewAppliedSeqsByChatId.delete(id);
    viewAppliedOriginByChatId.delete(id);
  }
  bumpViewApplyGeneration(chat);
  if (!chat || typeof chat !== 'object') return;
  chat._sdkViewAppliedSeq = 0;
  chat._sdkViewAppliedOrigin = 0;
  chat._sdkViewAppliedSeqs = new Set();
  delete chat._sdkViewAppliedSessionKey;
  delete chat._sdkLastRoomEventSeq;
  delete chat._sdkHydratedRoomEventSeqByStream;
  delete chat._sdkUnrenderedRoomEventSeqsByStream;
  delete chat._historyWindowOldestAt;
}

/**
 * Tests only.
 */
export function resetViewAppliedSeqMemoryForTests() {
  viewAppliedSeqByChatId.clear();
  viewAppliedSeqsByChatId.clear();
  viewAppliedOriginByChatId.clear();
}

/**
 * @param {number} attempt 1-based attempt that is about to run
 * @returns {number} delay ms, or 0 when retries are exhausted
 */
export function nextHistorySyncRetryDelayMs(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 0;
  if (attempt > HISTORY_SYNC_RETRY_MAX) return 0;
  return HISTORY_SYNC_RETRY_DELAYS_MS[attempt - 1] || 0;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function shouldRetryHistorySyncStatus(status) {
  return status === HISTORY_SYNC_STATUS.ERROR || status === HISTORY_SYNC_STATUS.PARTIAL;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function shouldMarkConnectionHealthyAfterHistorySync(status) {
  return status === HISTORY_SYNC_STATUS.SUCCESS || status === HISTORY_SYNC_STATUS.UNCHANGED;
}

/**
 * @param {{
 *   status?: string,
 *   headSeq?: number,
 *   viewAppliedSeq?: number,
 *   wsOpen?: boolean,
 *   retryAttempt?: number,
 * }} input
 * @returns {{
 *   canClearPending: boolean,
 *   retryDelayMs: number,
 *   notifyRestored: boolean,
 *   notifyReachable: boolean,
 * }}
 */
export function resolveHistorySyncPollFollowUp(input) {
  const status = String(input?.status || '');
  const wsOpen = input?.wsOpen === true;
  const retryAttempt = Number(input?.retryAttempt) || 0;
  const retryDelayMs = shouldRetryHistorySyncStatus(status)
    ? nextHistorySyncRetryDelayMs(retryAttempt + 1)
    : 0;
  const markHealthy = shouldMarkConnectionHealthyAfterHistorySync(status);
  return {
    canClearPending: shouldClearPendingRemoteHistory(input),
    retryDelayMs,
    notifyRestored: markHealthy && wsOpen,
    notifyReachable: markHealthy && !wsOpen,
  };
}

/**
 * Cold-start cached render: arm the discreet mode-bar "syncing" label once local IDB
 * history is already on screen, so the delta catch-up is visible without a full-screen
 * spinner. `structuredReplayDone` is exactly the signal that cached history rendered.
 *
 * @param {{ structuredReplayDone?: boolean } | null | undefined} localHydration
 * @returns {boolean}
 */
export function shouldArmCachedHistorySyncIndicator(localHydration) {
  return localHydration?.structuredReplayDone === true;
}

/**
 * Visible catch-up indicator. Tracker `isRunning` does not cover WS replay wait.
 *
 * @param {object | null | undefined} chat
 * @param {boolean} next
 * @param {(chat: object) => void} [onChange]
 * @param {number} [maxMs]
 */
export function setChatHistorySyncInFlight(chat, next, onChange, maxMs = HISTORY_SYNC_IN_FLIGHT_MAX_MS) {
  if (!chat || typeof chat !== 'object') return;
  const value = next === true;
  const timeoutMs = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : HISTORY_SYNC_IN_FLIGHT_MAX_MS;
  if (value !== true) {
    clearHistorySyncInFlightTimer(chat);
    delete chat._historySyncInFlightStartedAt;
  }
  if (chat._historySyncInFlight === value) {
    if (value === true) armHistorySyncInFlightTimer(chat, onChange, timeoutMs);
    return;
  }
  chat._historySyncInFlight = value;
  if (value === true) armHistorySyncInFlightTimer(chat, onChange, timeoutMs);
  onChange?.(chat);
}

/**
 * @param {object} chat
 */
function clearHistorySyncInFlightTimer(chat) {
  if (chat._historySyncInFlightTimer == null) return;
  clearTimeout(chat._historySyncInFlightTimer);
  delete chat._historySyncInFlightTimer;
}

/**
 * @param {object} chat
 * @param {(chat: object) => void} [onChange]
 * @param {number} maxMs
 */
function armHistorySyncInFlightTimer(chat, onChange, maxMs) {
  if (chat._historySyncInFlightTimer != null) return;
  const startedAt = Number(chat._historySyncInFlightStartedAt) || Date.now();
  chat._historySyncInFlightStartedAt = startedAt;
  const remainingMs = Math.max(0, maxMs - (Date.now() - startedAt));
  chat._historySyncInFlightTimer = setTimeout(() => {
    delete chat._historySyncInFlightTimer;
    setChatHistorySyncInFlight(chat, false, onChange, maxMs);
  }, remainingMs);
}

/**
 * Tracker `isRunning` does not cover mobile WS replay wait. Turn the
 * mode-bar indicator on when HTTP is skipped for replay.
 *
 * @param {object | null | undefined} chat
 * @param {boolean} skipHttpForReplay
 * @param {(chat: object) => void} [onChange]
 * @returns {boolean}
 */
export function markHistorySyncInFlightForWsReplay(chat, skipHttpForReplay, onChange) {
  if (skipHttpForReplay !== true) return false;
  setChatHistorySyncInFlight(chat, true, onChange);
  return true;
}

/**
 * Keep the indicator when replay is followed by HTTP catch-up; clear when not.
 *
 * @param {object | null | undefined} chat
 * @param {boolean} willHttpCatchUp
 * @param {(chat: object) => void} [onChange]
 * @returns {boolean} true when the flag was cleared
 */
export function clearHistorySyncInFlightAfterWsReplay(chat, willHttpCatchUp, onChange) {
  if (willHttpCatchUp === true) return false;
  setChatHistorySyncInFlight(chat, false, onChange);
  return true;
}

/**
 * Keep the mode-bar syncing label after a convergence result.
 * A finished attempt (including partial/deferred) must not leave the bar stuck.
 *
 * @param {{ status?: string, deferReason?: string } | null | undefined} result
 * @returns {boolean}
 */
export function shouldKeepHistorySyncInFlight(result) {
  void result;
  return false;
}

/**
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isChatHistorySyncInFlight(chat) {
  return chat?._historySyncInFlight === true;
}

/**
 * @param {{
 *   status?: string,
 *   headSeq?: number,
 *   viewAppliedSeq?: number,
 * }} input
 * @returns {boolean}
 */
export function shouldClearPendingRemoteHistory(input) {
  const status = String(input?.status || '');
  if (
    status === HISTORY_SYNC_STATUS.ERROR ||
    status === HISTORY_SYNC_STATUS.DEFERRED ||
    status === HISTORY_SYNC_STATUS.PARTIAL
  ) {
    return false;
  }
  const headSeq = Number(input?.headSeq);
  const viewAppliedSeq = Number(input?.viewAppliedSeq);
  if (!Number.isFinite(headSeq) || !Number.isFinite(viewAppliedSeq)) return false;
  return viewAppliedSeq >= headSeq;
}

/**
 * One in-flight convergence per chat. Signals during the run recheck once it
 * finishes. A stale run is dropped so a later resume is not stuck on hung I/O.
 *
 * @param {{ staleMs?: number }} [options]
 * @returns {{
 *   run: (chatId: string, task: () => Promise<unknown>) => Promise<unknown>,
 *   isRunning: (chatId: string) => boolean,
 *   resetForTests: () => void,
 * }}
 */
export function createInFlightHistorySyncTracker(options = {}) {
  /** @type {Map<string, { dirty: boolean, promise: Promise<unknown> }>} */
  const inflight = new Map();
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0
    ? options.staleMs
    : HISTORY_SYNC_TRACKER_STALE_MS;
  return {
    isRunning(chatId) {
      return inflight.has(String(chatId || ''));
    },
    async run(chatId, task) {
      const id = String(chatId || '');
      if (!id) return task();
      const current = inflight.get(id);
      if (current) {
        current.dirty = true;
        return current.promise;
      }
      const entry = { dirty: false, promise: Promise.resolve() };
      entry.promise = (async () => {
        let result;
        do {
          entry.dirty = false;
          result = await raceHistorySyncTask(task, staleMs);
          if (isHistorySyncTrackerTimeout(result)) break;
        } while (entry.dirty);
        return result;
      })().finally(() => {
        if (inflight.get(id) === entry) inflight.delete(id);
      });
      inflight.set(id, entry);
      return entry.promise;
    },
    resetForTests() {
      inflight.clear();
    },
  };
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function isHistorySyncTrackerTimeout(result) {
  if (!result || typeof result !== 'object') return false;
  return /** @type {{ deferReason?: unknown }} */ (result).deferReason === 'timeout';
}

/**
 * @param {() => Promise<unknown>} task
 * @param {number} staleMs
 * @returns {Promise<unknown>}
 */
function raceHistorySyncTask(task, staleMs) {
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ status: HISTORY_SYNC_STATUS.ERROR, deferReason: 'timeout' });
    }, staleMs);
  });
  return Promise.race([task(), timeoutPromise]).finally(() => {
    if (timeoutId != null) clearTimeout(timeoutId);
  });
}

/**
 * Decide fetch/apply/pending from store vs view vs server, without I/O.
 *
 * @param {{
 *   reason?: string,
 *   documentHidden?: boolean,
 *   backgroundMs?: number,
 *   socketGeneration?: number,
 *   unackedPingAgeMs?: number,
 *   serverHeadSeq?: number,
 *   storeAckSeq?: number,
 *   viewAppliedSeq?: number,
 *   viewAppliedSeqs?: Set<number> | number[],
 *   viewAppliedOrigin?: number,
 *   fetchedRecords?: unknown[],
 *   localRecords?: unknown[],
 *   fetchFailed?: boolean,
 *   fetchIncomplete?: boolean,
 *   applyFailed?: boolean,
 *   draftText?: string,
 *   scrollTop?: number,
 * }} input
 * @returns {{
 *   status: string,
 *   shouldFetch: boolean,
 *   shouldApplyToView: boolean,
 *   recordsToApply: unknown[],
 *   shouldClearPending: boolean,
 *   nextViewAppliedSeq: number,
 *   deferReason: string,
 *   draftText: string,
 *   scrollTop: number,
 *   diagnostics: Record<string, unknown>,
 * }}
 */
export function resolveChatHistoryConvergence(input) {
  const reason = String(input?.reason || 'unknown');
  const serverHeadSeq = Number(input?.serverHeadSeq) || 0;
  const storeAckSeq = Number(input?.storeAckSeq) || 0;
  const viewAppliedSeq = Number(input?.viewAppliedSeq) || 0;
  const viewAppliedOrigin = Number(input?.viewAppliedOrigin) || 0;
  const draftText = typeof input?.draftText === 'string' ? input.draftText : '';
  const scrollTop = Number.isFinite(Number(input?.scrollTop)) ? Number(input.scrollTop) : 0;
  const diagnostics = {
    reason,
    backgroundMs: Number(input?.backgroundMs) || 0,
    socketGeneration: Number(input?.socketGeneration) || 0,
    unackedPingAgeMs: Number(input?.unackedPingAgeMs) || 0,
    serverHeadSeq,
    storeAckSeq,
    viewAppliedSeq,
  };
  const shouldFetch = storeAckSeq < serverHeadSeq;
  if (input?.fetchFailed === true) {
    return {
      status: HISTORY_SYNC_STATUS.ERROR,
      shouldFetch,
      shouldApplyToView: false,
      recordsToApply: [],
      shouldClearPending: false,
      nextViewAppliedSeq: viewAppliedSeq,
      deferReason: 'fetch_failed',
      draftText,
      scrollTop,
      diagnostics: { ...diagnostics, result: HISTORY_SYNC_STATUS.ERROR },
    };
  }
  const merged = mergeHistoryRecordsForApply(input?.fetchedRecords, input?.localRecords);
  const recordsToApply = selectUnappliedHistoryRecords(merged, {
    viewAppliedSeq,
    viewAppliedSeqs: input?.viewAppliedSeqs,
    fetchedRecords: input?.fetchedRecords,
  });
  const appliedSeqs = new Set(normalizeAppliedSeqSet(input?.viewAppliedSeqs) || []);
  for (const record of recordsToApply) {
    const seq = resolveHistoryRecordSeq(record);
    if (seq > 0) appliedSeqs.add(seq);
  }
  const nextViewAppliedSeq = resolveContiguousAppliedSeq(
    appliedSeqs,
    viewAppliedSeq,
    viewAppliedOrigin
  );
  if (input?.documentHidden === true) {
    return {
      status: HISTORY_SYNC_STATUS.DEFERRED,
      shouldFetch,
      shouldApplyToView: false,
      recordsToApply,
      shouldClearPending: false,
      nextViewAppliedSeq: viewAppliedSeq,
      deferReason: 'document_hidden',
      draftText,
      scrollTop,
      diagnostics: { ...diagnostics, result: HISTORY_SYNC_STATUS.DEFERRED },
    };
  }
  if (input?.applyFailed === true) {
    return {
      status: HISTORY_SYNC_STATUS.ERROR,
      shouldFetch,
      shouldApplyToView: true,
      recordsToApply,
      shouldClearPending: false,
      nextViewAppliedSeq: viewAppliedSeq,
      deferReason: 'apply_failed',
      draftText,
      scrollTop,
      diagnostics: { ...diagnostics, result: HISTORY_SYNC_STATUS.ERROR },
    };
  }
  if (serverHeadSeq <= viewAppliedSeq && recordsToApply.length === 0 && input?.fetchIncomplete !== true) {
    return {
      status: HISTORY_SYNC_STATUS.UNCHANGED,
      shouldFetch: false,
      shouldApplyToView: false,
      recordsToApply: [],
      shouldClearPending: true,
      nextViewAppliedSeq: viewAppliedSeq,
      deferReason: '',
      draftText,
      scrollTop,
      diagnostics: { ...diagnostics, result: HISTORY_SYNC_STATUS.UNCHANGED },
    };
  }
  if (input?.fetchIncomplete === true || nextViewAppliedSeq < serverHeadSeq) {
    return {
      status: HISTORY_SYNC_STATUS.PARTIAL,
      shouldFetch,
      shouldApplyToView: recordsToApply.length > 0,
      recordsToApply,
      shouldClearPending: false,
      nextViewAppliedSeq,
      deferReason: 'incomplete',
      draftText,
      scrollTop,
      diagnostics: { ...diagnostics, result: HISTORY_SYNC_STATUS.PARTIAL },
    };
  }
  return {
    status: HISTORY_SYNC_STATUS.SUCCESS,
    shouldFetch: false,
    shouldApplyToView: recordsToApply.length > 0,
    recordsToApply,
    shouldClearPending: true,
    nextViewAppliedSeq,
    deferReason: '',
    draftText,
    scrollTop,
    diagnostics: { ...diagnostics, result: HISTORY_SYNC_STATUS.SUCCESS },
  };
}
