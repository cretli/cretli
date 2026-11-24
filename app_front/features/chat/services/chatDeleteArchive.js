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
import { isOperatorChat, operatorChatActions } from '../operatorChat.js';
import { closeChatListModal, renderChatList } from './chatSidebarState.js';
import { closeChat } from './chatLifecycle.js';
import { chatListExplicitReloadGuard } from './chatHistorySync.js';
import { loadChatsFromServer, selectChat } from './chatSelection.js';
import { restoreChatAndResend } from '../chatArchivedSend.js';
import { showChoiceDialog } from '../../../lib/choiceDialog.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';
import { getChatsForCurrentWorkspace } from './chatWorkspaceContext.js';

/**
 * An archive or restore reload only needs the workspace of the changed chats.
 *
 * @param {Iterable<string>} chatIds
 * @returns {string} empty when they span workspaces, which falls back to the full index
 */
function archiveReloadWorkspace(chatIds) {
  const files = new Set();
  for (const id of chatIds) {
    files.add(chats.find((entry) => entry.id === id)?.workspaceFile || '');
  }
  return files.size === 1 ? [...files][0] : '';
}

/**
 * Archive/delete fallback: stay in the workspace the operator is looking at when
 * a chat there can take over; only reach into other workspaces when none can.
 *
 * @param {{ requestedId?: string, archivedIds: Set<string>, activeChatId: string }} input
 * @returns {string}
 */
function resolveArchiveFallbackId({ requestedId, archivedIds, activeChatId }) {
  const resolve = (list) => resolveArchiveSwitchTargetId({ chats: list, requestedId, archivedIds, activeChatId });
  // An explicit target from the caller always wins.
  const requested = String(requestedId || '').trim();
  if (requested && resolveArchiveSwitchTargetId({ chats, requestedId: requested, archivedIds, activeChatId: '' }) === requested) return requested;
  let local = [];
  try {
    local = getChatsForCurrentWorkspace() || [];
  } catch {
    local = [];
  }
  return (local.length ? resolve(local) : '') || resolve(chats);
}

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
  if (!operatorChatActions(chats.find((c) => c.id === id)).archive) return Promise.resolve(false);
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
  // The operator thread is pinned: no archive from any entry point (the server answers 409 as well).
  if (!operatorChatActions(chats.find((c) => c.id === chatId)).archive) return false;
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
  // Optimistic hide: the row leaves the live tree at click time instead of after the
  // PATCH round trip. Only the archivedAt stamp moves here; the runtime teardown below
  // waits for the server, and a refusal restores the previous stamps.
  const optimisticStamp = new Date().toISOString();
  const previousStamps = new Map(
    chats
      .filter((entry) => entry && !entry.archivedAt)
      .map((entry) => [entry.id, entry.archivedAt])
  );
  const optimisticIds = markForkSubtreeArchived(chats, chatId, optimisticStamp);
  renderChatList();
  const rollbackOptimistic = () => {
    for (const id of optimisticIds) {
      const row = chats.find((entry) => entry.id === id);
      if (row && previousStamps.has(id)) {
        if (previousStamps.get(id) === undefined) delete row.archivedAt;
        else row.archivedAt = previousStamps.get(id);
      }
    }
    renderChatList();
  };
  let data = null;
  try {
    data = await api.archiveChat(chatId, true);
  } catch {
    data = null;
  }
  if (!data?.ok) {
    rollbackOptimistic();
    const message = data?.code === 'CHAT_ARCHIVE_BUSY'
      ? t('chat.archiveBusy')
      : (data?.error || t('chat.archiveFailed'));
    alert(message);
    return false;
  }
  const stamp = typeof data?.chat?.archivedAt === 'string' && data.chat.archivedAt.trim()
    ? data.chat.archivedAt.trim() : optimisticStamp;
  const finished = finishArchivedChat(chatId, stamp, options, relatedParentIds);
  // Offer a quick undo: an accidental archive (e.g. a swipe) must be reversible.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cretli:toast', {
      detail: {
        message: t('chat.archivedToast', { title: String(archivedRow?.title || '').trim() || chatId }),
        actionLabel: t('chat.archivedUndo'),
        onAction: () => {
          // An undo means the archive was unintended, so bring the confirm back.
          chatHost.setSkipChatArchiveConfirm(false);
          void requestRestoreChat(chatId);
        },
        durationMs: 8000,
      },
    }));
  }
  return finished;
}

export function finishArchivedChat(chatId, stamp = new Date().toISOString(), options = {}, relatedParentIds) {
  const row = chats.find((entry) => entry.id === chatId);
  relatedParentIds ||= [row?.forkParentChatId, row?.delegationParentChatId].filter(Boolean);
  const archivedIds = new Set(markForkSubtreeArchived(chats, chatId, stamp));
  archivedIds.add(String(chatId).trim());
  const switchToChatId = resolveArchiveFallbackId({
    requestedId: options.switchToChatId,
    archivedIds,
    activeChatId: chatRuntime.activeChatId,
  });
  // closeChat stays the single teardown entry point, but `keepRow` makes it close
  // runtime/presence/local data only; one explicit close per archived id, one render.
  for (const id of archivedIds) {
    closeChat(id, {
      skipApiDelete: true,
      keepRow: true,
      switchToChatId,
      render: false,
    });
  }
  renderChatList();
  if (switchToChatId && chats.some((entry) => entry.id === switchToChatId && !entry.archivedAt)) {
    // Automatic fallback: an operator-equivalent switch, never a link conflict.
    selectChat(switchToChatId, { byUser: true });
  }
  // Reconcile with the server in the background so rapid successive archives never
  // queue behind a full list reload (the joined in-flight load merges their queries).
  const reloadGuardIds = [...archivedIds];
  chatListExplicitReloadGuard.begin(reloadGuardIds);
  void loadChatsFromServer({
    includeArchived: true,
    archiveWorkspace: archiveReloadWorkspace(archivedIds),
    forceRefresh: true,
    preferChatId: switchToChatId || undefined,
    skipAutoSelect: !switchToChatId,
  }).catch(() => {}).finally(() => chatListExplicitReloadGuard.end(reloadGuardIds));
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
  const switchToChatId = resolveArchiveFallbackId({
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
    archiveWorkspace: archiveReloadWorkspace(archivedIds),
    forceRefresh: true,
    preferChatId: switchToChatId || undefined,
    skipAutoSelect: !switchToChatId,
  });
  if (switchToChatId && chats.some((entry) => entry.id === switchToChatId && !entry.archivedAt)) {
    // Automatic fallback: an operator-equivalent switch, never a link conflict.
    selectChat(switchToChatId, { byUser: true });
  }
  relatedParentIds.forEach((id) => {
    refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === id));
  });
  return { ok: failed === 0, archived: ids.length - failed, failed };
}

/**
 * Send pressed in an archived chat: offer to restore it, then resend the kept draft.
 * @param {any} chat
 */
export function promptRestoreArchivedChat(chat) {
  return restoreChatAndResend(chat, {
    confirmRestore: async () => {
      const choice = await showChoiceDialog({
        heading: t('chat.restoreToSendTitle'),
        body: t('chat.restoreToSendBody'),
        options: [{ value: 'restore', label: t('chat.restoreToSendConfirm'), variant: 'primary' }],
        cancelLabel: t('chat.cancel'),
      });
      return choice === 'restore';
    },
    restoreChat: requestRestoreChat,
    ensureConnection: (target) => chatHost.ensureChatConnection(target),
  });
}

/**
 * Keep the composer in step when archive state changes on another client.
 * @param {object | null | undefined} chat
 * @returns {void}
 */
export function syncArchivedChatSendUi(chat) {
  const sendBar = chat?.pane?._sendBar;
  if (!sendBar) return;
  const archived = isChatArchived(chat);
  // A chat of a switched-off plugin keeps its history but cannot send.
  const pluginOff = isReadOnlyOptionalPluginChat(chat);
  // An archived chat stays editable: Send offers to restore it.
  sendBar.setReadOnly(pluginOff);
  sendBar.setPlaceholder(archived ? t('chat.archivedSendHint')
    : pluginOff ? resolvePersistedLocalChatUnavailableMessage(chat, t)
    : (isOperatorChat(chat) ? t('operatorChat.placeholder') : isWatcherPinnedChat(chat) ? t('watcherPinned.placeholder') : t('chat.commandPlaceholder')));
}

export function syncArchiveMenuUi(chat = null) {
  syncArchivedChatSendUi(chat);
  const btn = document.getElementById('chat-archive-menu-btn');
  if (!btn) return;
  const archived = Boolean(String(chat?.archivedAt || '').trim());
  const blocked = !archived && isForkSubtreeBusy(chats, chat?.id, hasLiveHarnessWork);
  const check = /** @type {HTMLButtonElement | null} */ (document.getElementById('chat-check-archive-menu-btn'));
  if (check) {
    check.hidden = !chat || archived || !operatorChatActions(chat).archive;
    check.disabled = blocked;
    check.setAttribute('aria-disabled', String(blocked));
  }
  const key = archived ? 'chat.restore' : (blocked ? 'chat.archiveBusy' : 'chat.archive');
  const label = t(key);
  btn.disabled = blocked;
  // Pinned operator thread: the archive control is not offered at all.
  btn.hidden = !operatorChatActions(chat).archive;
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
      archiveWorkspace: archiveReloadWorkspace([chatId]),
      forceRefresh: true,
      preferChatId: chatId,
      skipAutoSelect: false,
    });
    if (chats.some((entry) => entry.id === chatId)) {
      selectChat(chatId, { byUser: true });
    }
    return true;
  } finally {
    chatListExplicitReloadGuard.end([suppressListReloadChatId]);
  }
}
