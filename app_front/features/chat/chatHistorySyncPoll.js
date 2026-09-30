import { getChatHistoryRevisions, getChatAgentStates, postChatHistoryBatch } from '../../api.js';
import {
  CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
} from '../../config.js';
import { buildChatHistoryBatchBody } from '../../lib/chatIdsQuery.js';
import { getLastAckedSeq, ingestChatHistoryDeltaResponse } from '../../lib/sdk-chat-history-store.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { getChatActivityAt } from './chatStore.js';
import { getRenderedSidebarChatIds } from '../sidebar/sidebarVisibleChats.js';
import {
  resolveBackgroundMonitorMode,
  selectBackgroundWsChatIds,
  selectMonitoredChatIds,
  selectHistoryHttpChatIds,
  shouldSkipBackgroundHistoryHttp,
  capHistoryHttpJobs,
  HISTORY_HTTP_MAX_POSTS_PER_POLL,
} from './chatBackgroundPolicy.js';
import {
  resolveBackgroundHttpBatchDelayMs,
  resolveBackgroundHttpBatchSize,
} from './chatWsReconnectPolicy.js';
import {
  ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
  RESUME_POLL_DEFER_MOBILE_MS,
  shouldSkipActiveChatHistoryPollSync,
} from './chatResumePolicy.js';
import { notifyChatBackendReachable, notifyChatConnectionRestored } from './chatServerRecovery.js';
import {
  hasAgentPresenceSeqGap,
  shouldSkipHttpAgentStates,
} from '../../../lib/agent-presence-policy.js';
import {
  getViewAppliedSeq,
  resolveHistorySyncPollFollowUp,
  shouldClearPendingRemoteHistory,
} from './chatHistoryConvergence.js';
import { isBlockingPersistedLocalChatHarnessState } from './persistedLocalChatState.js';

const POLL_INTERVAL_MS = 15000;
const HISTORY_POLL_START_DELAY_MS = 1500;
const RESUME_POLL_DEFER_MS = 5000;
const BACKGROUND_HISTORY_SYNC_GAP_MS = 250;
const EMPTY_HISTORY_PULL_BACKOFF_MS = 60000;
/** @type {Map<string, number>} */
const emptyPullBackoffUntil = new Map();

const backgroundHistoryPullOptions = {
  pageLimit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  maxPages: CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
};

/** @type {ChatHistorySyncPollDeps | null} */
let deps = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimerId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let firstPollTimerId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let resumePollTimerId = null;
/** @type {Map<string, number>} */
const lastActiveHistorySyncAt = new Map();
/** @type {Map<string, number>} */
const gapFirstSeenAt = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const gapRecheckTimers = new Map();
/** @type {Map<string, number>} */
const historySyncRetryAttempt = new Map();
let pollInFlight = false;
let pollQueued = false;
let lastPresenceAt = 0;
let lastPresenceSeq = 0;

/**
 * @typedef {object} ChatHistorySyncPollDeps
 * @property {() => object[]} getChats
 * @property {() => string | null} getActiveChatId
 * @property {(chat: object, context?: object) => Promise<{ status?: string } | void>} syncSdkHistoryOnResume
 * @property {{ log: (tag: string, message: string, payload?: object) => void }} appLogger
 * @property {() => void} [onPendingHistoryChange]
 * @property {() => void} [onAgentStatesChange]
 * @property {(ids?: string[]) => void} [onAgentPresenceChange]
 * @property {() => 'local' | 'redis' | string} [getSdkRoomBusMode]
 * @property {() => boolean} [hasOpenHarnessWs]
 */

/**
 * @returns {boolean}
 */
export function isChatHistoryRevisionPollInFlight() {
  return pollInFlight;
}

/**
 * Interval + gap-recheck share one cycle. A signal during the run queues one more pass.
 *
 * @returns {boolean} true when this caller owns the cycle
 */
export function tryEnterChatHistoryRevisionPoll() {
  if (pollInFlight) {
    pollQueued = true;
    return false;
  }
  pollInFlight = true;
  return true;
}

/**
 * @returns {boolean} true when another pass was requested while in flight
 */
export function leaveChatHistoryRevisionPoll() {
  const again = pollQueued;
  pollQueued = false;
  pollInFlight = false;
  return again;
}

/**
 * @param {object} chat
 * @param {boolean} pending
 */
function setChatPendingRemoteHistory(chat, pending) {
  if (!chat) return;
  const next = pending === true;
  if (chat._pendingRemoteHistory === next) return;
  chat._pendingRemoteHistory = next;
  if (typeof deps?.onPendingHistoryChange === 'function') {
    deps.onPendingHistoryChange(chat);
  }
}

function clearGapRecheck(chatId) {
  const timer = gapRecheckTimers.get(chatId);
  if (timer != null) {
    clearTimeout(timer);
    gapRecheckTimers.delete(chatId);
  }
  gapFirstSeenAt.delete(chatId);
}

function scheduleGapRecheck(chatId, delayMs, options = {}) {
  if (gapRecheckTimers.has(chatId)) {
    if (options.replace !== true) return;
    clearTimeout(gapRecheckTimers.get(chatId));
    gapRecheckTimers.delete(chatId);
  }
  gapRecheckTimers.set(
    chatId,
    setTimeout(() => {
      gapRecheckTimers.delete(chatId);
      void pollChatHistoryRevisions();
    }, Math.max(0, delayMs))
  );
}

/**
 * Store ACK is not the view. Keep the badge until viewAppliedSeq catches headSeq.
 *
 * @param {{ headSeq?: number, viewAppliedSeq?: number, incomplete?: boolean }} input
 * @returns {boolean}
 */
export function canClearPendingRemoteHistoryAfterStoreAck(input) {
  if (input?.incomplete === true) return false;
  return shouldClearPendingRemoteHistory({
    status: 'success',
    headSeq: input?.headSeq,
    viewAppliedSeq: input?.viewAppliedSeq,
  });
}

/**
 * Apply a compact agent-states map. Missing keys are idle (clears a previous busy row).
 *
 * @param {object[]} chats
 * @param {Record<string, object> | null | undefined} statesById
 * @returns {boolean}
 */
export function applyAgentStatesToChats(chats, statesById) {
  if (!statesById || typeof statesById !== 'object') return false;
  let changed = false;
  for (const chat of chats) {
    const next = statesById[chat.id] || null;
    const prev = chat._serverRunState || null;
    if (agentRunStateDedupeKey(prev) === agentRunStateDedupeKey(next)) continue;
    chat._serverRunState = next;
    changed = true;
  }
  return changed;
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function agentRunStateDedupeKey(row) {
  if (!row) return '';
  return [
    row.state || '',
    row.delegationId || '',
    row.attention === true ? '1' : '0',
    String(row.waitingAgentCount || 0),
    row.activityKey || '',
    row.activityArg || '',
  ].join(':');
}

/**
 * Patch presence from a WS frame. Snapshot treats missing ids as idle.
 *
 * @param {object[]} chats
 * @param {{ states?: Record<string, object>, cleared?: string[], snapshot?: boolean } | null | undefined} message
 * @returns {{ changed: boolean, dirtyIds: string[] }}
 */
export function applyAgentPresenceToChats(chats, message) {
  if (!message || typeof message !== 'object') return { changed: false, dirtyIds: [] };
  const list = Array.isArray(chats) ? chats : [];
  if (message.snapshot === true) {
    const states = message.states && typeof message.states === 'object' ? message.states : {};
    const dirtyIds = [];
    for (const chat of list) {
      const next = states[chat.id] || null;
      if (agentRunStateDedupeKey(chat._serverRunState) === agentRunStateDedupeKey(next)) continue;
      chat._serverRunState = next;
      dirtyIds.push(chat.id);
    }
    return { changed: dirtyIds.length > 0, dirtyIds };
  }
  const states = message.states && typeof message.states === 'object' ? message.states : {};
  const byId = new Map(list.map((chat) => [chat.id, chat]));
  const dirtyIds = [];
  for (const [id, next] of Object.entries(states)) {
    const chat = byId.get(id);
    if (!chat) continue;
    if (agentRunStateDedupeKey(chat._serverRunState) === agentRunStateDedupeKey(next)) continue;
    chat._serverRunState = next;
    dirtyIds.push(id);
  }
  for (const rawId of Array.isArray(message.cleared) ? message.cleared : []) {
    const id = String(rawId || '').trim();
    const chat = byId.get(id);
    if (!chat || !chat._serverRunState) continue;
    chat._serverRunState = null;
    dirtyIds.push(id);
  }
  return { changed: dirtyIds.length > 0, dirtyIds };
}

/**
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Chats the revision poll may touch. A persisted local chat whose plugin is missing,
 * disabled, not chat-capable, or host-incompatible has no SDK runtime, so it must never
 * trigger an agent-state/history-revision HTTP request or an active resume sync. Every
 * other row (including `not_loaded`, no-state, and legacy rows) is preserved unchanged.
 *
 * @param {object[] | null | undefined} chats
 * @returns {object[]}
 */
export function selectPersistedLocalChatHistoryPollChats(chats) {
  return (Array.isArray(chats) ? chats : []).filter(
    (chat) => chat?.id && chat?.cursorSessionId && !isBlockingPersistedLocalChatHarnessState(chat)
  );
}

/**
 * @param {Array<{ chat: object, revision: object }>} jobs
 */
async function pullBackgroundHistoryQueue(jobs) {
  if (!deps || jobs.length === 0) return;
  const chunkSize = Math.max(1, resolveBackgroundHttpBatchSize());
  const delayMs = resolveBackgroundHttpBatchDelayMs();
  const cappedJobs = capHistoryHttpJobs(jobs, {
    chunkSize,
    maxPosts: HISTORY_HTTP_MAX_POSTS_PER_POLL,
  });
  for (let offset = 0; offset < cappedJobs.length; offset += chunkSize) {
    if (offset > 0) await waitMs(delayMs);
    // A background chat can turn blocking while the poll is in flight. Drop it before
    // the fetch, and re-check again before ingest because the POST itself is async.
    const slice = cappedJobs
      .slice(offset, offset + chunkSize)
      .filter(({ chat }) => !isBlockingPersistedLocalChatHarnessState(chat));
    if (slice.length === 0) continue;
    const body = buildChatHistoryBatchBody(
      slice.map(({ chat }) => ({
        id: chat.id,
        since: getLastAckedSeq(chat.id),
        limit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
      }))
    );
    if (!body) continue;
    let response = null;
    try {
      response = await postChatHistoryBatch(body.chats);
    } catch (err) {
      deps.appLogger.log('chat-history-poll', 'background history batch failed', {
        error: String(err?.message || err),
        chatIds: slice.map(({ chat }) => chat.id),
      });
      continue;
    }
    if (!response?.ok || !response.histories || typeof response.histories !== 'object') continue;
    for (const { chat, revision } of slice) {
      // The response is async: a chat may have flipped to blocking while the batch was
      // in flight. It must never ingest history or be pulled any further.
      if (isBlockingPersistedLocalChatHarnessState(chat)) continue;
      const page = response.histories[chat.id];
      if (!page) continue;
      const sinceBeforePull = getLastAckedSeq(chat.id);
      const synced = await ingestChatHistoryDeltaResponse(
        chat.id,
        chat.cursorSessionId || '',
        page,
        sinceBeforePull
      );
      if (!synced) {
        emptyPullBackoffUntil.set(chat.id, Date.now() + EMPTY_HISTORY_PULL_BACKOFF_MS);
        continue;
      }
      if (!synced.applied) {
        emptyPullBackoffUntil.set(chat.id, Date.now() + EMPTY_HISTORY_PULL_BACKOFF_MS);
      } else {
        emptyPullBackoffUntil.delete(chat.id);
      }
      if (synced.incomplete === true) {
        deps.appLogger.log('chat-history-poll', 'background history partial', {
          chatId: chat.id,
          applied: synced.applied,
          headSeq: synced.headSeq,
          ackSeq: synced.ackSeq,
        });
        continue;
      }
      if (
        !canClearPendingRemoteHistoryAfterStoreAck({
          headSeq: revision.headSeq,
          viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
          incomplete: synced.incomplete,
        })
      ) {
        continue;
      }
      setChatPendingRemoteHistory(chat, false);
      clearGapRecheck(chat.id);
      deps.appLogger.log('chat-history-poll', 'background history synced', {
        chatId: chat.id,
        applied: synced.applied,
        headSeq: synced.headSeq,
        ackSeq: synced.ackSeq,
        pageLimit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
      });
    }
    if (isMobileLikeClient()) await waitMs(BACKGROUND_HISTORY_SYNC_GAP_MS);
  }
}

export function ingestAgentPresenceMessage(chats, message) {
  const seq = Number(message?.seq);
  const snapshot = message?.snapshot === true;
  if (hasAgentPresenceSeqGap(lastPresenceSeq, seq, snapshot)) {
    lastPresenceAt = 0;
    if (Number.isSafeInteger(seq) && seq > 0) lastPresenceSeq = seq;
    return { changed: false, dirtyIds: [], seqGap: true };
  }
  if (Number.isSafeInteger(seq) && seq > 0) lastPresenceSeq = seq;
  lastPresenceAt = Date.now();
  const applied = applyAgentPresenceToChats(chats, message);
  return { ...applied, seqGap: false };
}

export function invalidateAgentPresenceTrust() {
  lastPresenceAt = 0;
}

function shouldSkipAgentStatesHttp() {
  return shouldSkipHttpAgentStates({
    redisBus: deps?.getSdkRoomBusMode?.() === 'redis',
    hasOpenHarnessWs: deps?.hasOpenHarnessWs?.() === true,
    lastPresenceAt,
    hidden: typeof document !== 'undefined' && document.hidden === true,
  });
}

/**
 * One revision-poll pass. Exported so the blocked-chat exclusion can be regression-tested
 * without timers; production passes run through `pollChatHistoryRevisions`.
 *
 * @returns {Promise<void>}
 */
export async function runChatHistoryRevisionPoll() {
  if (!deps || typeof document === 'undefined' || document.hidden) return;
  // Blocked persisted local chats are dropped before any agent-state/history HTTP so a
  // missing/disabled plugin can never drive SDK sync for that chat.
  const chats = selectPersistedLocalChatHistoryPollChats(deps.getChats());
  if (chats.length === 0) return;
  const now = Date.now();
  if (!shouldSkipAgentStatesHttp()) {
    try {
      const stateResponse = await getChatAgentStates();
      if (stateResponse?.ok && applyAgentStatesToChats(chats, stateResponse.states)) {
        if (typeof deps.onAgentStatesChange === 'function') deps.onAgentStatesChange();
      }
    } catch (err) {
      deps.appLogger.log('chat-history-poll', 'agent-state poll failed', {
        error: String(err?.message || err),
      });
    }
  }
  // A chat can turn blocking while the agent-state request was in flight: re-check the
  // live state before deciding which chats may be history-polled or resume-synced.
  const eligibleChats = chats.filter(
    (chat) => !isBlockingPersistedLocalChatHarnessState(chat)
  );
  if (eligibleChats.length === 0) return;
  const activeChatId = deps.getActiveChatId();
  const monitoredChatIds = selectHistoryHttpChatIds(
    selectMonitoredChatIds(eligibleChats, deps.getActiveChatId, getChatActivityAt),
    eligibleChats,
    {
      activeChatId,
      visibleChatIds: getRenderedSidebarChatIds(),
    },
  );
  const wsChatIds = selectBackgroundWsChatIds(eligibleChats, deps.getActiveChatId, getChatActivityAt, now);
  const monitoredChats = eligibleChats.filter((chat) => monitoredChatIds.has(chat.id));
  if (monitoredChats.length === 0) return;
  try {
    const response = await getChatHistoryRevisions(monitoredChats.map((chat) => chat.id));
    if (!response?.ok) return;
    const revisions = response.revisions && typeof response.revisions === 'object' ? response.revisions : {};
    /** @type {Array<{ chat: object, revision: object }>} */
    const backgroundHttpJobs = [];
    for (const chat of monitoredChats) {
      // Re-check the live state after the revision request and immediately before any
      // active resume sync or background fetch/ingest: a chat that flipped to blocking
      // in flight must not drive SDK history.
      if (isBlockingPersistedLocalChatHarnessState(chat)) continue;
      const revision = revisions[chat.id];
      if (!revision || typeof revision.headSeq !== 'number') {
        setChatPendingRemoteHistory(chat, false);
        clearGapRecheck(chat.id);
        continue;
      }
      const localAck = getLastAckedSeq(chat.id);
      const viewAppliedSeq = getViewAppliedSeq(chat.id, chat);
      const storeLag = revision.headSeq > localAck;
      const viewLag = revision.headSeq > viewAppliedSeq;
      if (!storeLag && !viewLag) {
        setChatPendingRemoteHistory(chat, false);
        clearGapRecheck(chat.id);
        continue;
      }
      setChatPendingRemoteHistory(chat, true);
      if (!gapFirstSeenAt.has(chat.id)) gapFirstSeenAt.set(chat.id, now);
      const isActive = chat.id === activeChatId;
      const monitorMode = resolveBackgroundMonitorMode(
        chat,
        wsChatIds,
        monitoredChatIds,
        activeChatId
      );
      const hasPendingDelegation = revision.hasPendingDelegation === true;
      if (
        !isActive &&
        shouldSkipBackgroundHistoryHttp({
          monitorMode,
          hasPendingDelegation,
        })
      ) {
        if (!viewLag) {
          setChatPendingRemoteHistory(chat, false);
          clearGapRecheck(chat.id);
        }
        continue;
      }
      if (isActive) {
        const wsOpen = chat.ws?.readyState === WebSocket.OPEN;
        const gapObservedAt = gapFirstSeenAt.get(chat.id) || now;
        if (
          shouldSkipActiveChatHistoryPollSync({
            headSeq: revision.headSeq,
            localAck,
            viewAppliedSeq,
            wsOpen,
            hydrating: chat._sdkHistoryHydrating === true,
            lastSyncAt: lastActiveHistorySyncAt.get(chat.id),
            now,
            gapObservedAt,
            hasPendingDelegation,
          })
        ) {
          if (!viewLag) {
            setChatPendingRemoteHistory(chat, false);
            clearGapRecheck(chat.id);
          } else {
            const graceLeft = ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS - (now - gapObservedAt);
            if (wsOpen && graceLeft > 0) {
              scheduleGapRecheck(chat.id, graceLeft);
            }
          }
          continue;
        }
        const result = await deps.syncSdkHistoryOnResume(chat, { reason: 'cross_device_poll' });
        const viewSeqAfter = getViewAppliedSeq(chat.id, chat);
        const followUp = resolveHistorySyncPollFollowUp({
          status: result?.status,
          headSeq: revision.headSeq,
          viewAppliedSeq: viewSeqAfter,
          wsOpen: chat.ws?.readyState === WebSocket.OPEN,
          retryAttempt: historySyncRetryAttempt.get(chat.id) || 0,
        });
        if (followUp.canClearPending) {
          lastActiveHistorySyncAt.set(chat.id, Date.now());
          setChatPendingRemoteHistory(chat, false);
          clearGapRecheck(chat.id);
          historySyncRetryAttempt.delete(chat.id);
        } else if (followUp.retryDelayMs > 0) {
          historySyncRetryAttempt.set(
            chat.id,
            (historySyncRetryAttempt.get(chat.id) || 0) + 1
          );
          scheduleGapRecheck(chat.id, followUp.retryDelayMs, { replace: true });
        } else {
          historySyncRetryAttempt.delete(chat.id);
        }
        if (followUp.notifyRestored) {
          notifyChatConnectionRestored(chat);
        } else if (followUp.notifyReachable) {
          notifyChatBackendReachable(chat);
        }
        continue;
      }
      const backoffUntil = emptyPullBackoffUntil.get(chat.id) || 0;
      if (backoffUntil > now) continue;
      backgroundHttpJobs.push({ chat, revision });
    }
    await pullBackgroundHistoryQueue(backgroundHttpJobs);
  } catch (err) {
    deps.appLogger.log('chat-history-poll', 'revision poll failed', {
      error: String(err?.message || err),
    });
  }
}

async function pollChatHistoryRevisions() {
  if (!tryEnterChatHistoryRevisionPoll()) return;
  try {
    do {
      pollQueued = false;
      await runChatHistoryRevisionPoll();
    } while (pollQueued);
  } finally {
    leaveChatHistoryRevisionPoll();
  }
}

function startPolling() {
  if (pollTimerId != null || typeof window === 'undefined') return;
  pollTimerId = setInterval(() => {
    void pollChatHistoryRevisions();
  }, POLL_INTERVAL_MS);
  if (firstPollTimerId != null) clearTimeout(firstPollTimerId);
  firstPollTimerId = setTimeout(() => {
    firstPollTimerId = null;
    void pollChatHistoryRevisions();
  }, HISTORY_POLL_START_DELAY_MS);
}

function stopPolling() {
  if (firstPollTimerId != null) {
    clearTimeout(firstPollTimerId);
    firstPollTimerId = null;
  }
  if (pollTimerId == null) return;
  clearInterval(pollTimerId);
  pollTimerId = null;
}

function bindVisibilitySync() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      invalidateAgentPresenceTrust();
      if (resumePollTimerId != null) {
        clearTimeout(resumePollTimerId);
        resumePollTimerId = null;
      }
      return;
    }
    if (resumePollTimerId != null) clearTimeout(resumePollTimerId);
    const deferMs = isMobileLikeClient() ? RESUME_POLL_DEFER_MOBILE_MS : RESUME_POLL_DEFER_MS;
    resumePollTimerId = setTimeout(() => {
      resumePollTimerId = null;
      void pollChatHistoryRevisions();
    }, deferMs);
  });
}

/**
 * @param {ChatHistorySyncPollDeps} dependencies
 */
export function initChatHistorySyncPoll(dependencies) {
  deps = dependencies;
  bindVisibilitySync();
  startPolling();
}

export function stopChatHistorySyncPoll() {
  stopPolling();
  deps = null;
  pollInFlight = false;
  pollQueued = false;
  lastActiveHistorySyncAt.clear();
  historySyncRetryAttempt.clear();
  lastPresenceAt = 0;
  lastPresenceSeq = 0;
  for (const timer of gapRecheckTimers.values()) clearTimeout(timer);
  gapRecheckTimers.clear();
  gapFirstSeenAt.clear();
}
