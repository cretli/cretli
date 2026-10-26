/** Chat selection and switching: select/switch, widget host selection, embed selection. */
import { releaseViewContextRouteTarget, reportViewContextResourceConflict } from '../../../app/appShell/viewContextBridge.js';
import { isEmbedWidgetMode } from './newChatHarnessState.js';
import { isWidgetHostNavigationAvailable, requestWidgetHostUrl, consumePendingWidgetChatSelection, isSamePageUrl } from '../../../embed/widgetHostNavigation.js';
import { appLogger } from '../../../core/logging/logger.js';
import { chats, chatRuntime, removedChatIds } from '../state/chatRuntimeState.js';
import { resolveWorkspaceTargetForChat } from '../../sidebar/workspaceChatMatch.js';
import { applyVoiceWorkspaceSwitch } from './voiceWorkspaces.js';
import * as api from '../../../core/api/index.js';
import { probeSync } from '../../../lib/perfProbe.js';
import { scheduleChatSendBarReserveSync } from '../chatSendBarLayout.js';
import { isSdkOpenTerminalHydrating } from '../sdkEventReplayGuard.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { getChatWidgetPinnedUrl } from '../chatWidgetPin.js';
import { createEmbedChatRecordOnly, requestWidgetChatBinding, resolveChatSelectionForCurrentHostPage, syncWidgetPinUrlUi } from './chatWidgetPin.js';
import { retainMountedChatPanes, waitForEmbedBootReady } from './chatLifecycle.js';
import { getChatsList, notifySidebarSelectionOnly } from './chatSidebarHooks.js';
import { getChatsForCurrentWorkspace, getWorkspaceContextForChat } from './chatWorkspaceContext.js';
import { renderChatList, renderChatTerminalState, scheduleChatListStateRefresh } from './chatSidebarState.js';
import { applyPinnedChatModeUi, syncChatTodoChip } from './chatComposer.js';
import { checkChatResumeAdvice } from './chatResumeAdvice.js';
import { syncArchiveMenuUi, syncArchivedChatSendUi } from './chatDeleteArchive.js';
import { syncChatSdkModeUi } from './chatSdkMode.js';
import { syncSdkHistoryOnResume } from './chatHistorySync.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';
import { readEmbedChatMode, setEmbedNoChatState } from '../views/embedNoChatState.js';

/**
 * @param {string} id
 * @param {{ byUser?: boolean }} [options] byUser marks an explicit operator
 *   choice (sidebar, chat list, notification, voice). It retires a deep-link
 *   ws/folder target first, so a chat from another workspace opens and switches
 *   the tab instead of being silently refused as a link conflict. Route
 *   restores and list refreshes leave it unset and keep the ownership check.
 */
export function selectChat(id, options = {}) {
  if (options?.byUser === true) releaseViewContextRouteTarget();
  if (chatShell.pinnedChatSelectionGuard) {
    performSelectChat(id);
    return;
  }

  if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) {
    performSelectChat(id);
    return;
  }

  chatShell.pinnedChatSelectionGuard = true;
  void resolveChatSelectionForCurrentHostPage(id)
    .then((resolvedId) => {
      chatShell.pinnedChatSelectionGuard = false;
      if (!resolvedId) return;
      performSelectChat(resolvedId);
    })
    .catch((error) => {
      chatShell.pinnedChatSelectionGuard = false;
      appLogger.log('widget-pin-url', 'resolve selection failed', String(error));
      performSelectChat(id);
    });
}

/** Widget host → iframe selection without host-page navigation side effects. */
export async function selectChatFromWidgetHost(chatId) {
  const normalizedId = String(chatId || '').trim();
  if (!normalizedId) return;
  setForcedEmbedChatId(normalizedId);
  await waitForEmbedBootReady();
  let pinnedTo = '';
  if (isWidgetHostNavigationAvailable()) {
    try {
      const current = await requestWidgetHostUrl();
      pinnedTo = typeof current?.url === 'string' ? current.url.trim() : '';
    } catch {
      // Host URL unavailable — load the default chat list.
    }
  }
  await loadChatsFromServer({
    pinnedTo: pinnedTo || undefined,
    skipAutoSelect: true,
    preferChatId: normalizedId,
  });
  if (!getChatsList().some((chat) => chat.id === normalizedId)) {
    await loadChatsFromServer({
      skipAutoSelect: true,
      preferChatId: normalizedId,
      includeArchived: true,
    });
  }
  performSelectChat(normalizedId);
  chatShell.forcedEmbedChatId = null;
}

/**
 * Switch to the chat from a PWA notification click without reloading the SPA.
 * The service worker posts this after focusing the existing window.
 *
 * @param {{ chatId?: string, url?: string }} message
 */
export function openChatFromNotification(message) {
  const chatId = String(message?.chatId || '').trim();
  if (!chatId) return;
  const activate = () => {
    selectChat(chatId, { byUser: true });
    chatHost.chatTransport.scheduleResumeActiveChat('notification', false);
  };
  if (chats.some((chat) => chat.id === chatId)) {
    activate();
    return;
  }
  void loadChatsFromServer({ preferChatId: chatId, skipAutoSelect: true })
    .catch(() => {})
    .then(activate);
}

/**
 * Active workspace follows the chat being opened. A chat that only stores
 * `workspaceFolder` (pinned watcher chats) is matched against the loaded catalog.
 * The following list refresh must not replace this selection.
 *
 * @param {object | null | undefined} chat
 */
export function alignActiveWorkspaceWithChat(chat) {
  if (!chat || isEmbedWidgetMode()) return;
  const target = resolveWorkspaceTargetForChat(
    chat,
    getWorkspaceContextForChat(),
    chatShell.listWorkspaceContextsForChat(),
    chatShell.getPreferredWorkspaceFolderForChat,
  );
  if (!target) return;
  // A chat opened while the link pins ws/folder must belong to that scope;
  // report a conflict and keep the linked context — no local or global switch.
  const ownership = reportViewContextResourceConflict('chat', chat);
  if (!ownership.ok) return;
  chatShell.workspaceRefreshPreserveDepth += 1;
  Promise.resolve(applyVoiceWorkspaceSwitch(target.workspaceFile, target.workspaceFolder))
    .finally(() => {
      chatShell.workspaceRefreshPreserveDepth = Math.max(0, chatShell.workspaceRefreshPreserveDepth - 1);
    });
}

/**
 * The user is looking at this chat: its latest finished run counts as read. The local row is
 * stamped first so the green check turns grey without waiting for the server round trip; the
 * server frame then confirms it (and carries it to the user's other devices).
 *
 * @param {string} chatId
 */
export function markChatSeenIfUnread(chatId) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat || !chat.lastFinishedAt) return;
  if (chat.lastSeenAt && chat.lastSeenAt >= chat.lastFinishedAt) return;
  chat.lastSeenAt = new Date().toISOString();
  scheduleChatListStateRefresh([chatId]);
  void api.postChatSeen(chatId).catch(() => {});
}

export function performSelectChat(id) {
  probeSync('chat.switch', () => performSelectChatBody(id));
}

export function performSelectChatBody(id) {
  const chat = chats.find((c) => c.id === id);
  if (chat) {
    const ownership = reportViewContextResourceConflict('chat', chat);
    if (!ownership.ok) return;
  }
  if (chat) setEmbedNoChatState(false);
  const reselectingActive = chatRuntime.activeChatId === id;
  const prevActiveChatId = chatRuntime.activeChatId;
  retainMountedChatPanes(id);
  chats.forEach((c) => {
    c.pane?._sendBar?.closeSendMenu?.();
    if (c.id === id) return;
    chatRuntime.chatDiagnosticsApi.stopChatContextUsageSync(c);
  });
  chatHost.recordChatLastUsed(id);
  chatHost.recordChatActivity(id);
  notifySidebarSelectionOnly();
  chatHost.chatController.selectChat(id);
  // `activeChatId` just moved, so `chatExpectsLiveSocket` changed for BOTH the previous
  // and the newly active row. With the full `*` gone, neither repaints itself.
  scheduleChatListStateRefresh([prevActiveChatId, id]);
  markChatSeenIfUnread(id);
  scheduleChatSendBarReserveSync();
  if (chat?._serverRunState?.state === 'waiting' && chat._serverRunState.delegationId) {
    void api.postDelegationAck(chat._serverRunState.delegationId, { reason: 'open_child' }).then((res) => {
      if (!res?.ok || !res.delegation) return;
      chat._serverRunState = {
        ...chat._serverRunState,
        attention: false,
        state: chat._serverRunState.state === 'waiting' ? 'idle' : chat._serverRunState.state,
      };
      scheduleChatListStateRefresh([chat.id]);
    }).catch(() => {});
  }
  if (chat) chatHost.openTerminal(chat);
  if (chat) alignActiveWorkspaceWithChat(chat);
  if (chat) syncChatTodoChip(chat);
  if (chat) void checkChatResumeAdvice(chat);
  if (chat) {
    requestWidgetChatBinding(chat);
    syncWidgetPinUrlUi(chat);
    syncArchiveMenuUi(chat);
    syncChatSdkModeUi(chat);
    renderChatTerminalState(chat);
    applyPinnedChatModeUi(chat);
    syncArchivedChatSendUi(chat);
    chatRuntime.chatDiagnosticsApi.startChatContextUsageSync(chat);
    if (chat._sdkRichView && !reselectingActive) {
      setTimeout(() => chat._sdkRichView.scrollToBottom(), 50);
      if (!chat._sdkHistoryHydrating && !isSdkOpenTerminalHydrating(chat)) {
        void syncSdkHistoryOnResume(chat, { reason: 'selectChat' }).catch((err) => {
          appLogger.log('chat-sync', 'selectChat catch-up failed', {
            chatId: chat.id,
            error: String(err?.message || err),
          });
        });
      }
    }
  }
  notifySidebarSelectionOnly();
}

export function loadWorkspaces() {
  return chatHost.chatController.loadWorkspaces().then(() => {
    newChatModalState.chatNewModelDropdownApi?.refresh?.();
  });
}

export function loadChatsFromServer(query = {}) {
  return chatHost.chatController.loadChatsFromServer(query).then(() => {
    if (removedChatIds.size === 0) return;
    let didRemove = false;
    for (let i = chats.length - 1; i >= 0; i -= 1) {
      if (!removedChatIds.has(chats[i].id)) continue;
      chats.splice(i, 1);
      didRemove = true;
    }
    if (didRemove) renderChatList();
  });
}

export function getArchivedCounts() {
  return chatHost.chatController.getArchivedCounts();
}

/**
 * Sidebar search: hydrate archived rows from IDB and refresh when freshness allows.
 */
export function notifySidebarSearchHydration() {
  void chatHost.chatArchiveCatalog.ensureIdbArchivedRows();
  void chatHost.chatArchiveCatalog.hydrateMissingArchiveIntoRuntime();
  void loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
}

/**
 * @param {object[]} workspaceChats
 * @param {string} workspaceKey
 * @returns {object[]}
 */
export function expandSidebarWorkspaceSearchPool(workspaceChats, workspaceKey) {
  return chatHost.chatArchiveCatalog.buildSearchPoolForWorkspace(workspaceChats, workspaceKey);
}

/**
 * @param {string | null | undefined} chatId
 */
export function setForcedEmbedChatId(chatId) {
  const normalized = String(chatId || '').trim();
  chatShell.forcedEmbedChatId = normalized || null;
}

export function findFirstUnpinnedChat(chatList) {
  if (!Array.isArray(chatList)) return null;
  return chatList.find((chat) => !getChatWidgetPinnedUrl(chat)) || null;
}

/**
 * @param {Array<object>} existing
 * @returns {Promise<{ chatId: string|null, skipPinnedNavigation: boolean, shouldCreate: boolean, pinnedTo?: string }>}
 */
export async function resolveEmbedChatSelectionId(existing) {
  const pendingChatId = consumePendingWidgetChatSelection();
  if (pendingChatId && existing.some((chat) => chat.id === pendingChatId)) {
    chatShell.forcedEmbedChatId = null;
    return { chatId: pendingChatId, skipPinnedNavigation: true, shouldCreate: false };
  }

  if (chatShell.forcedEmbedChatId) {
    const forcedId = chatShell.forcedEmbedChatId;
    if (existing.some((chat) => chat.id === forcedId)) {
      chatShell.forcedEmbedChatId = null;
      return { chatId: forcedId, skipPinnedNavigation: true, shouldCreate: false };
    }
    return {
      chatId: forcedId,
      skipPinnedNavigation: true,
      shouldCreate: false,
      reloadPreferChatId: forcedId,
    };
  }

  let currentUrl = '';
  if (isWidgetHostNavigationAvailable()) {
    try {
      const current = await requestWidgetHostUrl();
      currentUrl = typeof current?.url === 'string' ? current.url.trim() : '';
    } catch {
      // Host URL unavailable — fall back below.
    }
  }

  if (currentUrl) {
    const lookup = await api.getChats({ pinnedTo: currentUrl });
    const urlMatched = lookup?.linkedChat?.id
      ? lookup.linkedChat
      : existing.find((chat) => {
        const pinnedUrl = getChatWidgetPinnedUrl(chat);
        return pinnedUrl && isSamePageUrl(pinnedUrl, currentUrl);
      });
    if (urlMatched?.id) {
      appLogger.log('widget-plus', 'embed resolve: pinned match', {
        chatId: urlMatched.id.slice(0, 8),
        currentUrl,
      });
      return {
        chatId: urlMatched.id,
        skipPinnedNavigation: true,
        shouldCreate: false,
        pinnedTo: currentUrl,
      };
    }
    // Host page has no pinned chat yet — use "+" to create one; do not reuse unpinned chats.
    appLogger.log('widget-plus', 'embed resolve: no pin for page — waiting for +', { currentUrl });
    return {
      chatId: null,
      skipPinnedNavigation: true,
      shouldCreate: false,
      pinnedTo: currentUrl,
      noPinnedForPage: true,
    };
  }

  if (isWidgetHostNavigationAvailable()) {
    return { chatId: null, skipPinnedNavigation: true, shouldCreate: false };
  }

  // Host is creating/selecting a chat — do not fall back to the first list item.
  if (chatShell.forcedEmbedChatId) {
    return {
      chatId: chatShell.forcedEmbedChatId,
      skipPinnedNavigation: true,
      shouldCreate: false,
      reloadPreferChatId: chatShell.forcedEmbedChatId,
    };
  }

  const unpinned = findFirstUnpinnedChat(existing);
  if (unpinned?.id) {
    return { chatId: unpinned.id, skipPinnedNavigation: true, shouldCreate: false };
  }

  if (existing.length === 0) {
    return { chatId: null, skipPinnedNavigation: true, shouldCreate: true };
  }

  return { chatId: null, skipPinnedNavigation: true, shouldCreate: true };
}

export async function applyEmbedChatSelection(existing) {
  const resolved = await resolveEmbedChatSelectionId(existing);
  // Host plus/select may win while this async resolution was in flight.
  if (chatShell.forcedEmbedChatId) {
    const forcedId = chatShell.forcedEmbedChatId;
    await loadChatsFromServer({
      skipAutoSelect: true,
      preferChatId: forcedId,
      pinnedTo: resolved?.pinnedTo || undefined,
    });
    performSelectChat(forcedId);
    chatShell.forcedEmbedChatId = null;
    return getChatsList().find((chat) => chat.id === forcedId) || null;
  }
  if (resolved?.noPinnedForPage) {
    // The user chose the general workspace chat before: open it on every page
    // that has no chat of its own.
    if (readEmbedChatMode() === 'general') return openEmbedGeneralChat();
    // Otherwise there is nothing to connect to until the user picks a mode.
    setEmbedNoChatState(true);
    return null;
  }
  if (resolved?.pinnedTo || resolved?.reloadPreferChatId) {
    await loadChatsFromServer({
      pinnedTo: resolved.pinnedTo || undefined,
      skipAutoSelect: true,
      preferChatId: resolved.reloadPreferChatId || resolved.chatId || undefined,
    });
  }
  if (chatShell.forcedEmbedChatId) {
    const forcedId = chatShell.forcedEmbedChatId;
    performSelectChat(forcedId);
    chatShell.forcedEmbedChatId = null;
    return getChatsList().find((chat) => chat.id === forcedId) || null;
  }
  if (resolved?.shouldCreate) {
    const chat = await createEmbedChatRecordOnly();
    if (chat) performSelectChat(chat.id);
    return chat;
  }
  const preferredId = resolved?.chatId || null;
  if (!preferredId) return null;
  if (!getChatsList().some((chat) => chat.id === preferredId)) {
    await loadChatsFromServer({
      skipAutoSelect: true,
      preferChatId: preferredId,
      pinnedTo: resolved.pinnedTo || undefined,
    });
  }
  if (chatShell.forcedEmbedChatId) {
    const forcedId = chatShell.forcedEmbedChatId;
    performSelectChat(forcedId);
    chatShell.forcedEmbedChatId = null;
    return getChatsList().find((chat) => chat.id === forcedId) || null;
  }
  performSelectChat(preferredId);
  return getChatsList().find((chat) => chat.id === preferredId) || null;
}

/**
 * General widget chat: one unpinned chat shared by the whole workspace, used on
 * pages without a chat pinned to their URL. Reuses the first unpinned chat or
 * creates one.
 */
export async function openEmbedGeneralChat() {
  await loadChatsFromServer({ skipAutoSelect: true });
  let chat = findFirstUnpinnedChat(getChatsForCurrentWorkspace());
  if (!chat) chat = await createEmbedChatRecordOnly();
  if (!chat?.id) {
    setEmbedNoChatState(true);
    return null;
  }
  performSelectChat(chat.id);
  return chat;
}

export function ensureEmbedChat() {
  const existing = getChatsForCurrentWorkspace();
  return applyEmbedChatSelection(existing);
}

/**
 * Re-selects embed chat for the current host page URL (after in-app navigation).
 */
export function syncEmbedChatToHostPage() {
  let pinnedTo = '';
  if (isWidgetHostNavigationAvailable()) {
    return requestWidgetHostUrl()
      .then((current) => {
        pinnedTo = typeof current?.url === 'string' ? current.url.trim() : '';
        return loadChatsFromServer(pinnedTo ? { pinnedTo } : {});
      })
      .catch(() => loadChatsFromServer())
      .then(() => applyEmbedChatSelection(getChatsForCurrentWorkspace()));
  }
  return loadChatsFromServer().then(() => applyEmbedChatSelection(getChatsForCurrentWorkspace()));
}
