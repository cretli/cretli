import { getChatHistoryRevisions, getChatAgentStates } from '../../api.js';
import {
  CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
} from '../../config.js';
import { getLastAckedSeq, syncChatHistoryDeltaFromServer } from '../../lib/sdk-chat-history-store.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { getChatActivityAt } from './chatStore.js';
import { selectMonitoredChatIds } from './chatBackgroundPolicy.js';
import {
  ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
  RESUME_POLL_DEFER_MOBILE_MS,
  shouldSkipActiveChatHistoryPollSync,
} from './chatResumePolicy.js';
import { notifyChatBackendReachable, notifyChatConnectionRestored } from './chatServerRecovery.js';
import {
  getViewAppliedSeq,
  resolveHistorySyncPollFollowUp,
} from './chatHistoryConvergence.js';

const POLL_INTERVAL_MS = 15000;
const RESUME_POLL_DEFER_MS = 5000;
const BACKGROUND_HISTORY_SYNC_GAP_MS = 250;

const backgroundHistoryPullOptions = {
  pageLimit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  maxPages: CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
};

/** @type {ChatHistorySyncPollDeps | null} */
let deps = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimerId = null;
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

/**
 * @typedef {object} ChatHistorySyncPollDeps
 * @property {() => object[]} getChats
 * @property {() => string | null} getActiveChatId
 * @property {(chat: object, context?: object) => Promise<{ status?: string } | void>} syncSdkHistoryOnResume
 * @property {{ log: (tag: string, message: string, payload?: object) => void }} appLogger
 * @property {() => void} [onPendingHistoryChange]
 * @property {() => void} [onAgentStatesChange]
 */

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

function applyAgentStatesToChats(chats, statesById) {
  if (!statesById || typeof statesById !== 'object') return false;
  let changed = false;
  for (const chat of chats) {
    const next = statesById[chat.id] || null;
    const prev = chat._serverRunState || null;
    const prevKey = prev ? `${prev.state}:${prev.delegationId}:${prev.attention}` : '';
    const nextKey = next ? `${next.state}:${next.delegationId}:${next.attention}` : '';
    if (prevKey === nextKey) continue;
    chat._serverRunState = next;
    changed = true;
  }
  return changed;
}

async function pollChatHistoryRevisions() {
  if (!deps || typeof document === 'undefined' || document.hidden) return;
  const chats = deps.getChats().filter((chat) => chat?.id && chat?.cursorSessionId);
  if (chats.length === 0) return;
  const now = Date.now();
  try {
    const stateResponse = await getChatAgentStates(chats.map((chat) => chat.id));
    if (stateResponse?.ok && applyAgentStatesToChats(chats, stateResponse.states)) {
      if (typeof deps.onAgentStatesChange === 'function') deps.onAgentStatesChange();
    }
  } catch (err) {
    deps.appLogger.log('chat-history-poll', 'agent-state poll failed', {
      error: String(err?.message || err),
    });
  }
  const monitoredChatIds = selectMonitoredChatIds(chats, deps.getActiveChatId, getChatActivityAt);
  const monitoredChats = chats.filter((chat) => monitoredChatIds.has(chat.id));
  if (monitoredChats.length === 0) return;
  try {
    const response = await getChatHistoryRevisions(monitoredChats.map((chat) => chat.id));
    if (!response?.ok) return;
    const revisions = response.revisions && typeof response.revisions === 'object' ? response.revisions : {};
    for (const chat of monitoredChats) {
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
      const isActive = chat.id === deps.getActiveChatId();
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
      const synced = await syncChatHistoryDeltaFromServer(
        chat.id,
        chat.cursorSessionId || '',
        backgroundHistoryPullOptions
      );
      if (!synced) continue;
      if (synced.incomplete === true) {
        deps.appLogger.log('chat-history-poll', 'background history partial', {
          chatId: chat.id,
          applied: synced.applied,
          headSeq: synced.headSeq,
          ackSeq: synced.ackSeq,
        });
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
      if (isMobileLikeClient()) {
        await new Promise((resolve) => setTimeout(resolve, BACKGROUND_HISTORY_SYNC_GAP_MS));
      }
    }
  } catch (err) {
    deps.appLogger.log('chat-history-poll', 'revision poll failed', {
      error: String(err?.message || err),
    });
  }
}

function startPolling() {
  if (pollTimerId != null || typeof window === 'undefined') return;
  pollTimerId = setInterval(() => {
    void pollChatHistoryRevisions();
  }, POLL_INTERVAL_MS);
  void pollChatHistoryRevisions();
}

function stopPolling() {
  if (pollTimerId == null) return;
  clearInterval(pollTimerId);
  pollTimerId = null;
}

function bindVisibilitySync() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
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
  lastActiveHistorySyncAt.clear();
  historySyncRetryAttempt.clear();
  for (const timer of gapRecheckTimers.values()) clearTimeout(timer);
  gapRecheckTimers.clear();
  gapFirstSeenAt.clear();
}