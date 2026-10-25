/** Chat delete/archive confirmation flows and restore. */
import { t, getCurrentLang } from '../../../i18n/index.js';
import { chats, chatRuntime } from '../state/chatRuntimeState.js';
import { hasActiveAgentRun, hasLiveHarnessWork } from '../chatStatusMeta.js';
import { shouldSkipChatDeleteConfirm } from '../chatDeleteConfirm.js';
import { closeChatSettingsModal } from '../views/chatSettingsModal.js';
import { initModal } from '../../../lib/modal.js';
import { findLastLiveSelectableChatId, markForkSubtreeArchived, resolveArchiveSwitchId as resolveArchiveSwitchTargetId, isChatArchived, isForkSubtreeBusy } from '../../../../lib/chat-tree.js';
import { countArchiveSubtree, buildArchiveConfirmMessage } from '../chatArchiveConfirm.js';
import * as api from '../../../core/api/index.js';
import { refreshRelatedChatHistoryLinks } from './harnessSwitch.js';
import { isReadOnlyOptionalPluginChat, resolvePersistedLocalChatUnavailableMessage } from '../persistedLocalChatState.js';
import { isWatcherPinnedChat } from '../watcherPinnedChat.js';
import { closeChatListModal, renderChatList } from './chatSidebarState.js';
import { closeChat } from './chatLifecycle.js';
import { chatListExplicitReloadGuard } from './chatHistorySync.js';
import { loadChatsFromServer, selectChat } from './chatSelection.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

export function closeChatDeleteConfirmModal() {
  chatShell.pendingDeleteChatId = null;
  chatShell.chatDeleteConfirmModalApi?.close();
}

export function syncChatDeleteConfirmModal(isAgentWorking) {
  const headingEl = document.getElementById('chat-delete-confirm-heading');
  const warningEl = document.getElementById('chat-delete-confirm-agent-warning');
  const skipBtn = document.getElementById('chat-delete-confirm-delete-skip');
  if (headingEl) {
    headingEl.textContent = isAgentWorking
      ? t('chat.deleteConfirmBusyTitle')
      : t('chat.deleteConfirmTitle');
  }
  if (warningEl) warningEl.hidden = !isAgentWorking;
  if (skipBtn) skipBtn.hidden = isAgentWorking;
}

/**
 * Ask to delete a chat. Skip-confirm is ignored while the agent is working,
 * unless skipConfirm is passed explicitly (voice / programmatic delete).
 *
 * @param {string} chatId
 * @param {{ skipConfirm?: boolean, forceConfirm?: boolean, preserveListOpen?: boolean, title?: string }} [options]
 */
export function requestDeleteChat(chatId, options = {}) {
  if (!chatId) return;
  const chat = chats.find((c) => c.id === chatId);
  const isAgentWorking = hasActiveAgentRun(chat);
  const skipConfirm = shouldSkipChatDeleteConfirm({
    skipConfirm: options.skipConfirm === true,
    forceConfirm: options.forceConfirm === true,
    skipPreference: chatHost.getSkipChatDeleteConfirm(),
    isAgentWorking,
  });
  const preserveListOpen = options.preserveListOpen === true;
  if (skipConfirm) {
    if (!preserveListOpen) closeChatSettingsModal();
    if (!preserveListOpen) closeChatListModal();
    closeChat(chatId);
    return;
  }
  const title =
    (typeof options.title === 'string' && options.title.trim()) ||
    chat?.title ||
    chatId;
  chatShell.pendingDeleteChatId = chatId;
  const titleEl = document.getElementById('chat-delete-confirm-chat-title');
  if (titleEl) titleEl.textContent = title;
  syncChatDeleteConfirmModal(isAgentWorking);
  if (!preserveListOpen) closeChatSettingsModal();
  if (!preserveListOpen) closeChatListModal();
  openChatDeleteConfirmModal();
}

export function openChatDeleteConfirmModal() {
  if (!chatShell.chatDeleteConfirmModalApi) {
    const modalEl = document.getElementById('chat-delete-confirm-modal');
    if (modalEl) {
      chatShell.chatDeleteConfirmModalApi = initModal(modalEl, {
        backdropSelector: '.chat-settings-backdrop',
      });
    }
  }
  chatShell.chatDeleteConfirmModalApi?.open();
  const modalEl = document.getElementById('chat-delete-confirm-modal');
  if (modalEl) modalEl.hidden = false;
}

export function confirmDeleteChat(skipNextPrompt) {
  const chatId = chatShell.pendingDeleteChatId;
  if (!chatId) {
    chatShell.chatDeleteConfirmModalApi?.close();
    return;
  }
  if (skipNextPrompt) chatHost.setSkipChatDeleteConfirm(true);
  closeChatDeleteConfirmModal();
  closeChat(chatId);
}

export function findLastVisibleChatId(excludeChatId = '') {
  return findLastLiveSelectableChatId(chats, excludeChatId);
}

export function openChatArchiveConfirmModal() {
  if (!chatShell.chatArchiveConfirmModalApi) {
    const modalEl = document.getElementById('chat-archive-confirm-modal');
    if (modalEl) {
      chatShell.chatArchiveConfirmModalApi = initModal(modalEl, {
        backdropSelector: '.chat-settings-backdrop',
      });
    }
  }
  chatShell.chatArchiveConfirmModalApi?.open();
  const modalEl = document.getElementById('chat-archive-confirm-modal');
  if (modalEl) modalEl.hidden = false;
}

/**
 * Close the confirm and settle its pending promise. `confirmed` runs the actual
 * archive; anything else resolves false. The "don't ask again" checkbox is only
 * honored when the user confirms, so closing without archiving never persists it.
 *
 * @param {boolean} confirmed
 */
export function settleArchiveConfirm(confirmed) {
  const pending = chatShell.pendingArchiveConfirm;
  if (!pending) {
    chatShell.chatArchiveConfirmModalApi?.close();
    return;
  }
  chatShell.pendingArchiveConfirm = null;
  chatShell.chatArchiveConfirmModalApi?.close();
  if (!confirmed) {
    pending.resolve(false);
    return;
  }
  const skipEl = document.getElementById('chat-archive-confirm-dont-ask');
  if (skipEl?.checked) chatHost.setSkipChatArchiveConfirm(true);
  void requestArchiveChat(pending.chatId, pending.options).then(
    (ok) => pending.resolve(ok === true),
    () => pending.resolve(false),
  );
}

/**
 * User-facing archive entry point: shows the cascade confirm (with a
 * "don't ask again" checkbox) unless the preference already opts out, then
 * delegates to {@link requestArchiveChat}. Programmatic/internal callers keep
 * using `requestArchiveChat` directly so they never open a modal.
 *
 * @param {string} chatId
 * @param {{ switchToChatId?: string, preserveListOpen?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export function requestArchiveChatConfirmed(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return Promise.resolve(false);
  if (options.forceConfirm !== true && chatHost.getSkipChatArchiveConfirm()) return requestArchiveChat(id, options);
  if (chatShell.pendingArchiveConfirm) {
    const previous = chatShell.pendingArchiveConfirm;
    chatShell.pendingArchiveConfirm = null;
    previous.resolve(false);
  }
  return new Promise((resolve) => {
    chatShell.pendingArchiveConfirm = { chatId: id, options, resolve };
    const { total, subchats } = countArchiveSubtree(chats, id);
    const messageEl = document.getElementById('chat-archive-confirm-message');
    if (messageEl) {
      messageEl.textContent = buildArchiveConfirmMessage(total, subchats, t, getCurrentLang());
    }
    const skipEl = document.getElementById('chat-archive-confirm-dont-ask');
    if (skipEl) skipEl.checked = false;
    openChatArchiveConfirmModal();
  });
}

export async function requestArchiveChat(chatId, options = {}) {
  if (!chatId) return false;
  const suppressListReloadChatId = String(chatId).trim();
  chatListExplicitReloadGuard.begin([suppressListReloadChatId]);
  try {
    return await requestArchiveChatInner(chatId, options);
  } finally {
    chatListExplicitReloadGuard.end([suppressListReloadChatId]);
  }
}

export async function requestArchiveChatInner(chatId, options) {
  const archivedRow = chats.find((entry) => entry.id === chatId);
  const relatedParentIds = [
    String(archivedRow?.forkParentChatId || '').trim(),
    String(archivedRow?.delegationParentChatId || '').trim(),
  ].filter(Boolean);
  let data = null;
  try {
    data = await api.archiveChat(chatId, true);
  } catch {
    data = null;
  }
  if (!data?.ok) {
    const message = data?.code === 'CHAT_ARCHIVE_BUSY'
      ? t('chat.archiveBusy')
      : (data?.error || t('chat.archiveFailed'));
    alert(message);
    return false;
  }
  // The server archives the whole subtree atomically; mirror that locally BEFORE
  // computing the fallback or tearing anything down, so neither the switch target
  // nor the lifecycle can point at a row that is leaving the live tree. Rows stay
  // in `chats`, so `partitionChatsByArchive` moves parent and children together
  // and `flattenChatsTree` keeps the relation (no level-0 orphans).
  const stamp = typeof data?.chat?.archivedAt === 'string' && data.chat.archivedAt.trim()
    ? data.chat.archivedAt.trim()
    : new Date().toISOString();
  const archivedIds = new Set(markForkSubtreeArchived(chats, chatId, stamp));
  archivedIds.add(String(chatId).trim());
  const switchToChatId = resolveArchiveSwitchTargetId({
    chats,
    requestedId: options.switchToChatId,
    archivedIds,
    activeChatId: chatRuntime.activeChatId,
  });
  // closeChat stays the single teardown entry point, but `keepRow` makes it close
  // runtime/presence/local data only — it is no longer the mechanism that moves
  // the branch. One explicit close per archived id, one render for the pass.
  for (const id of archivedIds) {
    closeChat(id, {
      skipApiDelete: true,
      keepRow: true,
      switchToChatId,
      render: false,
    });
  }
  renderChatList();
  await loadChatsFromServer({
    includeArchived: true,
    forceRefresh: true,
    preferChatId: switchToChatId || undefined,
    skipAutoSelect: !switchToChatId,
  });
  if (switchToChatId && chats.some((entry) => entry.id === switchToChatId && !entry.archivedAt)) {
    selectChat(switchToChatId);
  }
  relatedParentIds.forEach((id) => {
    refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === id));
  });
  return true;
}

/**
 * Archive a whole sidebar "settled subchats" group in one pass: one local
 * subtree update and one reload instead of one `closeChat` per child. The caller
 * confirms with the user first. Partial API failures leave the failed rows live
 * and stamp only the subtrees whose PATCH succeeded.
 *
 * @param {string[]} chatIds
 * @param {{ switchToChatId?: string }} [options]
 * @returns {Promise<{ ok: boolean, archived: number, failed: number }>}
 */
export async function requestArchiveSettledChats(chatIds, options = {}) {
  const ids = [...new Set(
    (Array.isArray(chatIds) ? chatIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )];
  if (!ids.length) return { ok: true, archived: 0, failed: 0 };
  chatListExplicitReloadGuard.begin(ids);
  try {
    return await requestArchiveSettledChatsInner(ids, options);
  } finally {
    chatListExplicitReloadGuard.end(ids);
  }
}

export async function requestArchiveSettledChatsInner(ids, options) {
  const archivedSet = new Set(ids);
  const fallbackStamp = new Date().toISOString();
  const relatedParentIds = new Set();
  const archivedIds = new Set();
  let failed = 0;
  for (const id of ids) {
    const row = chats.find((entry) => entry.id === id);
    for (const parent of [row?.forkParentChatId, row?.delegationParentChatId]) {
      const parentId = String(parent || '').trim();
      if (parentId && !archivedSet.has(parentId)) relatedParentIds.add(parentId);
    }
    let data = null;
    try {
      data = await api.archiveChat(id, true);
    } catch {
      data = null;
    }
    if (!data?.ok) {
      failed += 1;
      continue;
    }
    const stamp = typeof data?.chat?.archivedAt === 'string' && data.chat.archivedAt.trim()
      ? data.chat.archivedAt.trim()
      : fallbackStamp;
    markForkSubtreeArchived(chats, id, stamp).forEach((markedId) => archivedIds.add(markedId));
    archivedIds.add(id);
  }
  // One local update for the whole successful group: fallback and lifecycle are
  // computed once, after every archived subtree is stamped.
  const switchToChatId = resolveArchiveSwitchTargetId({
    chats,
    requestedId: options.switchToChatId,
    archivedIds,
    activeChatId: chatRuntime.activeChatId,
  });
  for (const id of archivedIds) {
    closeChat(id, {
      skipApiDelete: true,
      keepRow: true,
      switchToChatId,
      render: false,
    });
  }
  renderChatList();
  await loadChatsFromServer({
    includeArchived: true,
    forceRefresh: true,
    preferChatId: switchToChatId || undefined,
    skipAutoSelect: !switchToChatId,
  });
  if (switchToChatId && chats.some((entry) => entry.id === switchToChatId && !entry.archivedAt)) {
    selectChat(switchToChatId);
  }
  relatedParentIds.forEach((id) => {
    refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === id));
  });
  return { ok: failed === 0, archived: ids.length - failed, failed };
}

/**
 * Keep the composer read-only when archive state changes on another client.
 * @param {object | null | undefined} chat
 * @returns {void}
 */
export function syncArchivedChatSendUi(chat) {
  const sendBar = chat?.pane?._sendBar;
  if (!sendBar) return;
  const archived = isChatArchived(chat);
  // A chat of a switched-off plugin keeps its history but cannot send.
  const pluginOff = isReadOnlyOptionalPluginChat(chat);
  sendBar.setReadOnly(archived || pluginOff);
  sendBar.setPlaceholder(archived ? t('chat.archivedReadOnly')
    : pluginOff ? resolvePersistedLocalChatUnavailableMessage(chat, t)
    : (isWatcherPinnedChat(chat) ? t('watcherPinned.placeholder') : t('chat.commandPlaceholder')));
}

export function syncArchiveMenuUi(chat = null) {
  syncArchivedChatSendUi(chat);
  const btn = document.getElementById('chat-archive-menu-btn');
  if (!btn) return;
  const archived = Boolean(String(chat?.archivedAt || '').trim());
  const blocked = !archived && isForkSubtreeBusy(chats, chat?.id, hasLiveHarnessWork);
  const key = archived ? 'chat.restore' : (blocked ? 'chat.archiveBusy' : 'chat.archive');
  const label = t(key);
  btn.disabled = blocked;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('data-i18n-title', key);
  btn.setAttribute('data-i18n-aria', key);
  const labelEl = btn.querySelector('.chat-toolbar-action-label');
  if (labelEl) {
    labelEl.setAttribute('data-i18n', key);
    labelEl.textContent = label;
  }
  const icon = btn.querySelector('.mdi');
  if (!icon) return;
  icon.classList.toggle('mdi-archive-arrow-down-outline', !archived);
  icon.classList.toggle('mdi-archive-arrow-up-outline', archived);
}

export async function requestRestoreChat(chatId) {
  if (!chatId) return false;
  const suppressListReloadChatId = String(chatId).trim();
  chatListExplicitReloadGuard.begin([suppressListReloadChatId]);
  try {
    let data = null;
    try {
      data = await api.archiveChat(chatId, false);
    } catch {
      data = null;
    }
    if (!data?.ok) {
      alert(data?.error || t('chat.restoreFailed'));
      return false;
    }
    await loadChatsFromServer({
      includeArchived: true,
      forceRefresh: true,
      preferChatId: chatId,
      skipAutoSelect: false,
    });
    if (chats.some((entry) => entry.id === chatId)) {
      selectChat(chatId);
    }
    return true;
  } finally {
    chatListExplicitReloadGuard.end([suppressListReloadChatId]);
  }
}
