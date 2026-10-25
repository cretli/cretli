import {
  CHAT_BACKGROUND_MONITOR_WINDOW_MS,
  CHAT_BACKGROUND_WS_MAX,
} from '../../config.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { hasConfirmedAgentRun, hasLiveHarnessWork } from './chatStatusMeta.js';
import { isPendingContextCompressionChat } from './chatContextCompressionRecovery.js';
import {
  comparePreparedActivityAtDesc,
  prepareChatActivitySortKeys,
} from './chatListSort.js';
import {
  createSliceSession,
  forEachInTimeSlices,
} from '../../lib/schedulerYield.js';

/** Yield during monitoring selection when eligible chat count exceeds this. */
export const MONITORED_CHAT_IDS_SLICE_THRESHOLD = 128;

/**
 * @param {number} lastActivityAt
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRecentActivityAt(lastActivityAt, now = Date.now()) {
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return false;
  return now - lastActivityAt <= CHAT_BACKGROUND_MONITOR_WINDOW_MS;
}

export function isRecentlyActiveChat(chat, getChatActivityAt, now = Date.now()) {
  if (!chat?.cursorSessionId) return false;
  return isRecentActivityAt(getChatActivityAt(chat), now);
}

/**
 * Archived rows keep their history server-side; only an open chat or a real run
 * may pull them back into live monitoring.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isArchivedChat(chat) {
  return Boolean(String(chat?.archivedAt || '').trim());
}

/**
 * Task 3.1 gate: a *non-archived* chat uses the full reason set, but an
 * archived chat qualifies for monitoring only when it is the open chat, or when
 * the contract-completed `hasConfirmedAgentRun` sees an actual in-flight run.
 * A stale `waiting`/`attention` server state (no in-flight child delegations), a
 * pending question/permission, a recent activity timestamp, or a client-only
 * `_agentState` kept alive by one of those is **not** work and must not keep an
 * archived chat monitored. Parent `waiting` with `waitingAgentCount` or an
 * in-flight child `delegationStatus` **is** work.
 *
 * @param {object | null | undefined} chat
 * @param {string | null | undefined} activeChatId
 * @returns {boolean}
 */
export function qualifiesArchivedMonitoring(chat, activeChatId) {
  if (!isArchivedChat(chat)) return true;
  if (activeChatId && chat?.id === activeChatId) return true;
  return hasConfirmedAgentRun(chat);
}

/**
 * Temporary summary-fork chats must keep WS until the callback agent finishes.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isPendingSummaryForkChat(chat) {
  if (!chat?.id || !chat?.cursorSessionId) return false;
  if (chat.isTemporary !== true) return false;
  return chat.forkKind === 'summary';
}

/**
 * Chats with a live harness run must keep WS / monitoring after the user switches away.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isLiveAgentChat(chat) {
  if (!chat?.id || !chat?.cursorSessionId) return false;
  return hasLiveHarnessWork(chat);
}

/**
 * @param {object[] | null | undefined} chats
 * @param {string | null | undefined} chatId
 * @returns {boolean}
 */
export function isListedChat(chats, chatId) {
  if (!chatId || !Array.isArray(chats)) return false;
  return chats.some((chat) => chat?.id === chatId);
}

/**
 * @param {object | null | undefined} chat
 * @param {object[] | null | undefined} chats
 * @returns {boolean}
 */
export function shouldKeepChatSocket(chat, chats) {
  if (!chat?.id || chat._remoteDeleted === true) return false;
  return isListedChat(chats, chat.id);
}

/**
 * Chat ids that should keep a live WebSocket (active chat + top recent background slots).
 *
 * @param {object[]} chats
 * @param {() => string | null} getActiveChatId
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} [now]
 * @returns {Set<string>}
 */
export function selectBackgroundWsChatIds(chats, getActiveChatId, getChatActivityAt, now = Date.now()) {
  const wsChatIds = new Set();
  const activeChatId = getActiveChatId();
  if (activeChatId && isListedChat(chats, activeChatId)) wsChatIds.add(activeChatId);
  const backgroundWsMax = isMobileLikeClient() ? 0 : CHAT_BACKGROUND_WS_MAX;
  const candidates = prepareChatActivitySortKeys(
    chats.filter((chat) => (
      chat?.id
      && chat?.cursorSessionId
      && chat.id !== activeChatId
      && !isArchivedChat(chat)
    )),
    getChatActivityAt
  )
    .filter((entry) => isRecentActivityAt(entry.activityAt, now))
    .sort(comparePreparedActivityAtDesc)
    .slice(0, backgroundWsMax)
    .map((entry) => entry.chat);
  for (const chat of candidates) {
    wsChatIds.add(chat.id);
  }
  for (const chat of chats) {
    if (!isPendingSummaryForkChat(chat)) continue;
    wsChatIds.add(chat.id);
  }
  for (const chat of chats) {
    if (!isPendingContextCompressionChat(chat)) continue;
    wsChatIds.add(chat.id);
  }
  for (const chat of chats) {
    if (!isLiveAgentChat(chat)) continue;
    // Archived rows pass only with an actual run (or while open); a stale
    // waiting/attention presence must not keep a background socket alive.
    if (!qualifiesArchivedMonitoring(chat, activeChatId)) continue;
    wsChatIds.add(chat.id);
  }
  return wsChatIds;
}

/**
 * Background history-batch: keep live/active chats even when their workspace
 * is collapsed; skip idle rows that are not in the sidebar DOM.
 *
 * @param {Set<string>} monitoredChatIds
 * @param {object[]} chats
 * @param {{
 *   activeChatId?: string | null,
 *   visibleChatIds?: Set<string> | null,
 * }} [options]
 * @returns {Set<string>}
 */
export function selectHistoryHttpChatIds(monitoredChatIds, chats, options = {}) {
  const monitored = monitoredChatIds instanceof Set ? monitoredChatIds : new Set();
  const visible = options.visibleChatIds instanceof Set ? options.visibleChatIds : new Set();
  const activeChatId = typeof options.activeChatId === 'string' ? options.activeChatId : '';
  const out = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat?.id || !monitored.has(chat.id)) continue;
    // Defence in depth for the archive gate: even when an archived id reaches
    // this set from another caller, a stale row must not be HTTP-polled merely
    // because the archive section made it visible.
    if (!qualifiesArchivedMonitoring(chat, activeChatId)) continue;
    const isPriority =
      chat.id === activeChatId
      || isLiveAgentChat(chat)
      || chat._serverRunState?.state === 'busy'
      || chat._serverRunState?.state === 'waiting'
      || chat._serverRunState?.state === 'attention';
    if (isPriority || (visible.size > 0 && visible.has(chat.id))) {
      out.add(chat.id);
    }
  }
  return out;
}

/**
 * Qualification buckets for `selectMonitoredChatIds`, in the order the
 * selection checks them. Task 0.1 reports counts per bucket split by
 * `archivedAt`, so a report can show whether archived rows qualify only
 * because of a stale waiting/attention server state.
 */
export const MONITORING_REASON_NAMES = Object.freeze([
  'active',
  'recent',
  'live',
  'busy',
  'waiting',
  'attention',
]);

/**
 * The only buckets that may keep an *archived* chat in the monitoring set.
 * `live`/`busy` require an actual run; `active` is the chat the user has open.
 * `recent`, `waiting` and `attention` are deliberately absent (task 3.1).
 */
export const ARCHIVED_MONITORING_REASON_NAMES = Object.freeze([
  'active',
  'live',
  'busy',
]);

/**
 * Raw candidate reasons, ignoring the archive gate. This is the pre-3.1
 * behaviour and the "before" side of the measurement; it must not be used to
 * drive selection.
 *
 * @param {object | null | undefined} chat
 * @param {{
 *   activeChatId?: string | null,
 *   getChatActivityAt?: (chat: object) => number,
 *   now?: number,
 * }} [options]
 * @returns {string[]}
 */
export function classifyMonitoringCandidateReasons(chat, options = {}) {
  if (!chat?.id || !chat?.cursorSessionId) return [];
  const activeChatId = typeof options.activeChatId === 'string' ? options.activeChatId : '';
  const activityFn = typeof options.getChatActivityAt === 'function'
    ? options.getChatActivityAt
    : () => 0;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const reasons = [];
  if (activeChatId && chat.id === activeChatId) reasons.push('active');
  if (isRecentlyActiveChat(chat, activityFn, now)) reasons.push('recent');
  if (isLiveAgentChat(chat)) reasons.push('live');
  const state = chat._serverRunState?.state;
  if (state === 'busy') reasons.push('busy');
  if (state === 'waiting') reasons.push('waiting');
  if (state === 'attention') reasons.push('attention');
  return reasons;
}

/**
 * Every reason a chat *actually* qualifies for history monitoring, after the
 * 3.1 archive gate. A non-archived chat keeps the full reason set; an archived
 * chat is reduced to the actual-run buckets (`active`, `live`, `busy`). An empty
 * array means it will not be monitored.
 *
 * @param {object | null | undefined} chat
 * @param {{
 *   activeChatId?: string | null,
 *   getChatActivityAt?: (chat: object) => number,
 *   now?: number,
 * }} [options]
 * @returns {string[]}
 */
export function classifyMonitoringReasons(chat, options = {}) {
  const candidates = classifyMonitoringCandidateReasons(chat, options);
  if (candidates.length === 0 || !isArchivedChat(chat)) return candidates;
  const activeChatId = typeof options.activeChatId === 'string' ? options.activeChatId : '';
  if (!qualifiesArchivedMonitoring(chat, activeChatId)) return [];
  return candidates.filter((reason) => ARCHIVED_MONITORING_REASON_NAMES.includes(reason));
}

/**
 * Chat ids monitored via HTTP history revisions (active + recently active window).
 *
 * @param {object[]} chats
 * @param {() => string | null} getActiveChatId
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} [now]
 * @param {{
 *   onQualified?: (chat: object, reasons: string[]) => void,
 *   onClassified?: (chat: object, info: {
 *     reasons: string[],
 *     candidateReasons: string[],
 *     archived: boolean,
 *   }) => void,
 * }} [options]
 * @returns {Set<string>}
 */
/**
 * @param {object} chat
 * @param {string | null} activeChatId
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} now
 * @param {Set<string>} monitoredChatIds
 * @param {{
 *   onQualified?: (chat: object, reasons: string[]) => void,
 *   onClassified?: (chat: object, info: object) => void,
 * }} instrument
 */
function considerChatForMonitoring(
  chat,
  activeChatId,
  getChatActivityAt,
  now,
  monitoredChatIds,
  instrument,
) {
  if (!chat?.id || !chat?.cursorSessionId) return;
  const onQualified = typeof instrument.onQualified === 'function' ? instrument.onQualified : null;
  const onClassified = typeof instrument.onClassified === 'function' ? instrument.onClassified : null;
  if (onQualified || onClassified) {
    const candidateReasons = classifyMonitoringCandidateReasons(chat, {
      activeChatId,
      getChatActivityAt,
      now,
    });
    if (candidateReasons.length === 0) return;
    const reasons = classifyMonitoringReasons(chat, { activeChatId, getChatActivityAt, now });
    if (onClassified) {
      onClassified(chat, {
        reasons,
        candidateReasons,
        archived: isArchivedChat(chat),
      });
    }
    if (reasons.length === 0) return;
    monitoredChatIds.add(chat.id);
    if (onQualified) onQualified(chat, reasons);
    return;
  }
  if (!qualifiesArchivedMonitoring(chat, activeChatId)) return;
  if (
    chat.id === activeChatId
    || isRecentlyActiveChat(chat, getChatActivityAt, now)
    || isLiveAgentChat(chat)
    || chat._serverRunState?.state === 'busy'
    || chat._serverRunState?.state === 'waiting'
    || chat._serverRunState?.state === 'attention'
  ) {
    monitoredChatIds.add(chat.id);
  }
}

export function selectMonitoredChatIds(chats, getActiveChatId, getChatActivityAt, now = Date.now(), options = {}) {
  const monitoredChatIds = new Set();
  const activeChatId = getActiveChatId();
  const list = Array.isArray(chats) ? chats : [];
  for (const chat of list) {
    considerChatForMonitoring(
      chat,
      activeChatId,
      getChatActivityAt,
      now,
      monitoredChatIds,
      options,
    );
  }
  return monitoredChatIds;
}

/**
 * Same result as {@link selectMonitoredChatIds} with macrotask yields on large lists.
 *
 * @param {object[]} chats
 * @param {() => string | null} getActiveChatId
 * @param {(chat: object) => number} getChatActivityAt
 * @param {number} [now]
 * @param {Parameters<typeof selectMonitoredChatIds>[4]} [options]
 * @returns {Promise<Set<string>>}
 */
export async function selectMonitoredChatIdsAsync(
  chats,
  getActiveChatId,
  getChatActivityAt,
  now = Date.now(),
  options = {},
) {
  const list = Array.isArray(chats) ? chats : [];
  const monitoredChatIds = new Set();
  const activeChatId = getActiveChatId();
  if (list.length <= MONITORED_CHAT_IDS_SLICE_THRESHOLD) {
    for (const chat of list) {
      considerChatForMonitoring(
        chat,
        activeChatId,
        getChatActivityAt,
        now,
        monitoredChatIds,
        options,
      );
    }
    return monitoredChatIds;
  }
  const session = options.sliceSession || createSliceSession();
  await forEachInTimeSlices(list, {
    session,
    deps: options.deps,
    budgetMs: options.budgetMs,
    onItem: (chat) => {
      considerChatForMonitoring(
        chat,
        activeChatId,
        getChatActivityAt,
        now,
        monitoredChatIds,
        options,
      );
    },
  });
  return monitoredChatIds;
}

/**
 * @param {object | null | undefined} chat
 * @param {Set<string>} wsChatIds
 * @param {Set<string>} monitoredChatIds
 * @param {string | null} activeChatId
 * @returns {'ws-active' | 'ws' | 'poll' | 'none'}
 */
export function resolveBackgroundMonitorMode(chat, wsChatIds, monitoredChatIds, activeChatId) {
  if (!chat?.id) return 'none';
  if (wsChatIds.has(chat.id)) {
    return chat.id === activeChatId ? 'ws-active' : 'ws';
  }
  if (monitoredChatIds.has(chat.id)) return 'poll';
  return 'none';
}

/**
 * Skip HTTP history pull when a live WS already covers this background chat.
 * Pending delegation still forces HTTP even with an open socket.
 *
 * @param {{ monitorMode?: string, hasPendingDelegation?: boolean }} [input]
 * @returns {boolean}
 */
export function shouldSkipBackgroundHistoryHttp(input = {}) {
  if (input.hasPendingDelegation === true) return false;
  const mode = String(input.monitorMode || '');
  return mode === 'ws' || mode === 'ws-active';
}

export const HISTORY_HTTP_MAX_POSTS_PER_POLL = 2;

/**
 * Cap background history-batch posts per poll cycle (chunkSize × maxPosts).
 *
 * @param {unknown[]} jobs
 * @param {{ chunkSize?: number, maxPosts?: number }} [options]
 * @returns {unknown[]}
 */
export function capHistoryHttpJobs(jobs, options = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  const chunkSize = Math.max(1, Number(options.chunkSize) || 16);
  const maxPosts = Math.max(1, Number(options.maxPosts) || HISTORY_HTTP_MAX_POSTS_PER_POLL);
  return jobs.slice(0, chunkSize * maxPosts);
}
