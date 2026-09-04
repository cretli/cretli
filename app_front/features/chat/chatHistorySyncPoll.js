import { getChatHistoryRevisions } from '../../api.js';
import {
  CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
} from '../../config.js';
import { getLastAckedSeq, syncChatHistoryDeltaFromServer } from '../../lib/sdk-chat-history-store.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { getChatActivityAt } from './chatStore.js';
import { selectMonitoredChatIds } from './chatBackgroundPolicy.js';
import {
  RESUME_POLL_DEFER_MOBILE_MS,
  shouldSkipActiveChatHistoryPollSync,
} from './chatResumePolicy.js';
import { notifyChatBackendReachable, notifyChatConnectionRestored } from './chatServerRecovery.js';

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

/**
 * @typedef {object} ChatHistorySyncPollDeps
 * @property {() => object[]} getChats
 * @property {() => string | null} getActiveChatId
 * @property {(chat: object, context?: object) => Promise<void>} syncSdkHistoryOnResume
 * @property {{ log: (tag: string, message: string, payload?: object) => void }} appLogger
 * @property {() => void} [onPendingHistoryChange]
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

async function pollChatHistoryRevisions() {
  if (!deps || typeof document === 'undefined' || document.hidden) return;
  const chats = deps.getChats().filter((chat) => chat?.id && chat?.cursorSessionId);
  if (chats.length === 0) return;
  const monitoredChatIds = selectMonitoredChatIds(chats, deps.getActiveChatId, getChatActivityAt);
  const monitoredChats = chats.filter((chat) => monitoredChatIds.has(chat.id));
  if (monitoredChats.length === 0) return;
  const now = Date.now();
  try {
    const response = await getChatHistoryRevisions(monitoredChats.map((chat) => chat.id));
    if (!response?.ok) return;
    const revisions = response.revisions && typeof response.revisions === 'object' ? response.revisions : {};
    for (const chat of monitoredChats) {
      const revision = revisions[chat.id];
      if (!revision || typeof revision.headSeq !== 'number') {
        setChatPendingRemoteHistory(chat, false);
        continue;
      }
      const localAck = getLastAckedSeq(chat.id);
      if (revision.headSeq <= localAck) {
        setChatPendingRemoteHistory(chat, false);
        continue;
      }
      setChatPendingRemoteHistory(chat, true);
      const isActive = chat.id === deps.getActiveChatId();
      if (isActive) {
        const wsOpen = chat.ws?.readyState === WebSocket.OPEN;
        if (
          shouldSkipActiveChatHistoryPollSync({
            headSeq: revision.headSeq,
            localAck,
            wsOpen,
            hydrating: chat._sdkHistoryHydrating === true,
            lastSyncAt: lastActiveHistorySyncAt.get(chat.id),
            now,
          })
        ) {
          setChatPendingRemoteHistory(chat, false);
          continue;
        }
        await deps.syncSdkHistoryOnResume(chat, { reason: 'cross_device_poll' });
        lastActiveHistorySyncAt.set(chat.id, now);
        setChatPendingRemoteHistory(chat, false);
        if (chat.ws?.readyState === WebSocket.OPEN) {
          notifyChatConnectionRestored(chat);
        } else {
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
      setChatPendingRemoteHistory(chat, false);
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
}