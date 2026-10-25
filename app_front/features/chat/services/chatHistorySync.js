/** History convergence, agent presence and push inbox consumption. */
import { createInFlightHistorySyncTracker, setChatHistorySyncInFlight, shouldKeepHistorySyncInFlight } from '../chatHistoryConvergence.js';
import { isBlockingPersistedLocalChatHarnessState } from '../persistedLocalChatState.js';
import { isSdkOpenTerminalHydrating } from '../sdkEventReplayGuard.js';
import { clearPushPreview, consumePushInbox } from '../../pwa/pushInbox.js';
import { runSdkHistoryConvergence as executeSdkHistoryConvergence } from '../chatHistoryConvergenceRun.js';
import { applyCatchUpSdkHistoryRecords } from '../chatHistoryViewApply.js';
import { notifyChatBackendReachable } from '../chatServerRecovery.js';
import { getLastBackgroundDurationMs } from '../../../lib/pageBackgroundGrace.js';
import { traceUiFreeze } from '../../../lib/uiFreezeTrace.js';
import { getResumeHistorySyncDeferMs } from '../chatResumePolicy.js';
import { isMobileLikeClient } from '../../../lib/mobileClient.js';
import { syncChatHistoryDeltaFromServer, readSdkChatHistoryStateAsync, getLastAckedSeq } from '../../../lib/sdk-chat-history-store.js';
import { syncRichViewPlainBuffer } from './sdkHistoryQueue.js';
import { appLogger } from '../../../core/logging/logger.js';
import { createChatListExplicitReloadGuard } from '../chatListExplicitReload.js';
import { chats, chatRuntime } from '../state/chatRuntimeState.js';
import { applyWorkspaceWatcherPresence } from '../../sidebar/workspaceAutopilotBadge.js';
import { ingestAgentPresenceMessage, applyAgentStatesToChats } from '../chatHistorySyncPoll.js';
import * as api from '../../../core/api/index.js';
import { renderChatList, renderChatTerminalState, scheduleChatListStateRefresh, updateAwaitingInput } from './chatSidebarState.js';
import { notifySidebar } from './chatSidebarHooks.js';
import { loadChatsFromServer } from './chatSelection.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/**
 * @returns {Promise<void>}
 */
export function yieldToMainThread() {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

export const historyResumeSyncTracker = createInFlightHistorySyncTracker();

export function isDocumentHidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function resolveChatDraftAndScroll(chat) {
  const sendInput = typeof document !== 'undefined'
    ? document.getElementById('chat-send-input')
    : null;
  const draftText = sendInput && typeof sendInput.value === 'string' ? sendInput.value : '';
  const stream = chat?._sdkRichView?.streamEl || chat?._sdkRichView?.el || null;
  const scrollTop = Number.isFinite(Number(stream?.scrollTop)) ? Number(stream.scrollTop) : 0;
  return { draftText, scrollTop };
}

export async function syncSdkHistoryOnResume(chat, context = {}) {
  if (!chat?.id) return { status: 'unchanged' };
  // A blocked persisted local chat has no SDK runtime: never fetch or apply SDK history,
  // regardless of which lifecycle path asked for the resume sync.
  if (isBlockingPersistedLocalChatHarnessState(chat)) return { status: 'unchanged' };
  const reason = String(context.reason || 'unknown');
  if (isSdkOpenTerminalHydrating(chat)) {
    return { status: 'deferred', deferReason: 'open_terminal_hydrating' };
  }
  setChatHistorySyncInFlight(chat, true, renderChatTerminalState);
  try {
    const result = await historyResumeSyncTracker.run(
      chat.id,
      () => runSdkHistoryConvergence(chat, context)
    );
    // Authoritative history landed: the transient inbox preview is stale.
    if (result?.status !== 'deferred') clearPushPreview(chat);
    setChatHistorySyncInFlight(
      chat,
      shouldKeepHistorySyncInFlight(result),
      renderChatTerminalState
    );
    return result;
  } catch (err) {
    setChatHistorySyncInFlight(chat, false, renderChatTerminalState);
    throw err;
  }
}

export async function runSdkHistoryConvergence(chat, context = {}) {
  return executeSdkHistoryConvergence(chat, context, {
    isDocumentHidden,
    getResumeDeferMs: (reason) => getResumeHistorySyncDeferMs(
      reason,
      isMobileLikeClient(),
      getLastBackgroundDurationMs()
    ),
    yieldToMain: yieldToMainThread,
    fetchDelta: (target) => syncChatHistoryDeltaFromServer(
      target.id,
      target.cursorSessionId || ''
    ),
    readLocal: (target) => readSdkChatHistoryStateAsync(target.id),
    applyCatchUp: applyCatchUpSdkHistoryRecords,
    completeHydration: (target, records) => {
      if (isSdkOpenTerminalHydrating(target) && (!Array.isArray(records) || records.length === 0)) {
        return;
      }
      chatHost.chatTransport.completeSdkHistoryHydration(target, records);
    },
    onApplied: (target) => {
      syncRichViewPlainBuffer(target);
      updateAwaitingInput(target);
      renderChatTerminalState(target);
    },
    notifyReachable: notifyChatBackendReachable,
    getDraftAndScroll: resolveChatDraftAndScroll,
    getBackgroundMs: getLastBackgroundDurationMs,
    getUnackedPingAgeMs: (target) => (
      Number.isFinite(target._unackedPingAt) ? Date.now() - target._unackedPingAt : 0
    ),
    getStoreAckSeq: (target) => getLastAckedSeq(target.id),
    log: (tag, message, payload) => appLogger.log(tag, message, payload),
    trace: traceUiFreeze,
  });
}

// Recognizes the trailing archive/restore echo of a reload this client already applied:
// the `chatsChanged` frame carries only `{ reason, chatId }`, so the current list is the
// only way to tell it apart from an independent same-id change. The explicit reload runs
// with `includeArchived: true` and the controller rebuilds `chats` in place, so by the
// time requestArchiveChat/requestRestoreChat call guard.end() the row already reflects the
// new state — the late echo is redundant. A frame whose state is NOT yet in the list falls
// through to the in-flight TTL and reloads, so independent changes are never swallowed.
export const chatListExplicitReloadGuard = createChatListExplicitReloadGuard({
  isChatStateAlreadyApplied: (reason, chatId) => {
    const row = chats.find((entry) => entry.id === chatId);
    if (!row) return false;
    const archived = Boolean(String(row.archivedAt || '').trim());
    return reason === 'restore' ? !archived : archived;
  },
});

/**
 * Applies a batch of presence frames in arrival order, then runs the UI work once:
 * a single sidebar notify, one merged chat-list refresh and at most one snapshot repair.
 * @param {any[]} frames
 */
export function applyAgentPresenceFrames(frames) {
  let watchersChanged = false;
  let changed = false;
  let seqGap = false;
  const dirtyIds = new Set();
  for (const msg of frames) {
    if (Array.isArray(msg?.watchers) && applyWorkspaceWatcherPresence(msg.watchers)) watchersChanged = true;
    const result = ingestAgentPresenceMessage(chats, msg);
    if (result.changed) {
      changed = true;
      for (const id of result.dirtyIds || []) dirtyIds.add(id);
    }
    if (result.seqGap) seqGap = true;
  }
  // A workspace autopilot badge changed; a full sidebar render is cheap
  // because renderSignature short-circuits unchanged frames.
  if (watchersChanged) notifySidebar();
  // A gap frame is still a valid newer delta: apply it now, then repair the missing
  // middle with the HTTP snapshot. A late response cannot roll the delta back because
  // `requestedAt` is compared against the per-chat applied watermark.
  if (changed) scheduleChatListStateRefresh([...dirtyIds]);
  if (seqGap) {
    const requestedAt = Date.now();
    void api.getChatAgentStates().then((data) => {
      if (!data?.ok) return;
      const applied = applyAgentStatesToChats(chats, data.states, { requestedAt });
      if (applied.changed) scheduleChatListStateRefresh(applied.dirtyIds);
    }).catch(() => {});
  }
}

/**
 * Re-fetch authoritative agent states right after an inbox patch. This is the
 * same path the app already uses for a presence seq gap; `loadChatsFromServer`
 * alone does not refresh `_serverRunState`.
 */
export async function refreshPushInboxAgentStates() {
  try {
    const requestedAt = Date.now();
    const data = await api.getChatAgentStates();
    if (!data?.ok) return;
    const applied = applyAgentStatesToChats(chats, data.states, { requestedAt });
    if (applied.changed) scheduleChatListStateRefresh(applied.dirtyIds);
  } catch (error) {
    appLogger?.log?.('push-inbox', 'agent-state refresh failed', { error: String(error) });
  }
}

/**
 * Coalesces overlapping triggers. consumePushInbox deletes the records it
 * applies, so the single queued follow-up pass (needed because refreshFromServer
 * reloads the chat list and then asks for another consume) always settles.
 */
export function runPushInboxConsume() {
  if (chatShell.pushInboxConsumeInFlight) {
    chatShell.pushInboxConsumeQueued = true;
    return;
  }
  chatShell.pushInboxConsumeInFlight = true;
  void consumePushInbox({
    getChats: () => chats,
    getLastAckedSeq,
    getActiveChatId: () => chatRuntime.activeChatId,
    renderChatList,
    syncChatHistoryDelta: (chat) => syncChatHistoryDeltaFromServer(
      chat.id,
      chat.cursorSessionId || ''
    ),
    syncActiveChatHistory: (chat) => syncSdkHistoryOnResume(chat, { reason: 'push_inbox' }),
    refreshAgentStates: refreshPushInboxAgentStates,
    refreshFromServer: () => loadChatsFromServer({ skipAutoSelect: true }),
    logger: appLogger,
  }).catch(() => {}).finally(() => {
    chatShell.pushInboxConsumeInFlight = false;
    if (!chatShell.pushInboxConsumeQueued) return;
    chatShell.pushInboxConsumeQueued = false;
    runPushInboxConsume();
  });
}

export function consumePushInboxFromStore() {
  runPushInboxConsume();
}
