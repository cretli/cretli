/**
 * Chat toolbar action buttons and settings copy-id buttons.
 */
import { isForkSubtreeBusy } from '../../../../lib/chat-tree.js';
import { t } from '../../../i18n/index.js';
import { writeTextToClipboard } from '../../../lib/clipboard.js';
import { hasLiveHarnessWork } from '../chatStatusMeta.js';
import { sendKeySequenceToActiveChat } from '../services/chatComposer.js';
import {
  resetChatSdkContext,
  runIntentionalSummary,
  setTransientChatActionHint,
  startNewAgent,
} from '../services/chatContextCompression.js';
import {
  requestArchiveChatConfirmed,
  requestDeleteChat,
  requestRestoreChat,
  syncArchiveMenuUi,
} from '../services/chatDeleteArchive.js';
import { copyActiveChatToClipboard } from '../services/chatLifecycle.js';
import { bindChatToolbarActionItem, closeChatActionsModal } from '../services/chatSidebarState.js';
import { syncWidgetPinUrlUi, toggleWidgetUrlPin } from '../services/chatWidgetPin.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { openChatSettingsModal } from './chatSettingsModal.js';
import { openNewChatModal } from './newChatModal.js';

/** Bind toolbar buttons. */
export function bindChatPanelToolbar({ toggleChatFullscreen }) {
  const fullscreenBtn = document.getElementById('chat-fullscreen-btn');
  if (fullscreenBtn) {
    bindChatToolbarActionItem(fullscreenBtn, () => {
      closeChatActionsModal();
      toggleChatFullscreen();
    });
  }
  const fullscreenMenuBtn = document.getElementById('chat-fullscreen-menu-btn');
  if (fullscreenMenuBtn) {
    fullscreenMenuBtn.addEventListener('click', () => {
      const sidebarMenuBtn = document.getElementById('header-menu-btn');
      if (!(sidebarMenuBtn instanceof HTMLButtonElement)) return;
      sidebarMenuBtn.click();
    });
  }

  const settingsBtn = document.getElementById('chat-settings-btn');
  if (settingsBtn) {
    bindChatToolbarActionItem(settingsBtn, () => {
      closeChatActionsModal();
      openChatSettingsModal();
    });
  }
  const copyBtn = document.getElementById('chat-copy-btn');
  if (copyBtn) {
    bindChatToolbarActionItem(copyBtn, () => {
      closeChatActionsModal();
      void copyActiveChatToClipboard().then((ok) => {
        if (!ok) return;
        const label = copyBtn.querySelector('.chat-toolbar-action-label');
        if (!label) return;
        const prev = label.textContent;
        label.textContent = t('chat.copied');
        window.setTimeout(() => {
          label.textContent = prev;
        }, 1500);
      });
    });
  }
  const resetContextBtn = document.getElementById('chat-reset-context-btn');
  if (resetContextBtn) {
    bindChatToolbarActionItem(resetContextBtn, () => {
      closeChatActionsModal();
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) {
        setTransientChatActionHint(hint, t('chat.noActiveChat'));
        return;
      }
      void resetChatSdkContext(chat, hint);
    });
  }
  const forkMenuBtn = document.getElementById('chat-fork-menu-btn');
  if (forkMenuBtn) {
    bindChatToolbarActionItem(forkMenuBtn, () => {
      closeChatActionsModal();
      const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
      if (!chat?.id) {
        alert(t('chat.noActiveChat'));
        return;
      }
      openNewChatModal({
        forkFromChatId: chat.id,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    });
  }
  const newAgentBtn = document.getElementById('chat-new-agent-btn');
  if (newAgentBtn) {
    bindChatToolbarActionItem(newAgentBtn, () => {
      closeChatActionsModal();
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) {
        setTransientChatActionHint(hint, t('chat.noActiveChat'));
        return;
      }
      void startNewAgent(chat, hint);
    });
  }
  const intentSummaryBtn = document.getElementById('chat-intent-summary-btn');
  if (intentSummaryBtn) {
    bindChatToolbarActionItem(intentSummaryBtn, () => {
      closeChatActionsModal();
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) {
        setTransientChatActionHint(hint, t('chat.noActiveChat'));
        return;
      }
      void runIntentionalSummary(chat, hint);
    });
  }
  const monitorAgentBtn = document.getElementById('chat-monitor-agent-btn');
  if (monitorAgentBtn) {
    bindChatToolbarActionItem(monitorAgentBtn, () => {
      closeChatActionsModal();
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat?.id) {
        alert(t('chat.noActiveChat'));
        return;
      }
      openNewChatModal({
        monitorFromChatId: chat.id,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    });
  }

  const pinUrlMenuBtn = document.getElementById('chat-pin-url-menu-btn');
  if (pinUrlMenuBtn) {
    bindChatToolbarActionItem(pinUrlMenuBtn, () => {
      closeChatActionsModal();
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      void toggleWidgetUrlPin(chat, hint);
    });
  }
  syncWidgetPinUrlUi(chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null);

  const stopMenuBtn = document.getElementById('chat-stop-menu-btn');
  if (stopMenuBtn) {
    bindChatToolbarActionItem(stopMenuBtn, () => {
      closeChatActionsModal();
      const id = chatRuntime.activeChatId;
      if (!id) return;
      sendKeySequenceToActiveChat('\x03');
    });
  }

  const archiveMenuBtn = document.getElementById('chat-archive-menu-btn');
  if (archiveMenuBtn) {
    bindChatToolbarActionItem(archiveMenuBtn, () => {
      closeChatActionsModal();
      const id = chatRuntime.activeChatId;
      if (!id) return;
      const chat = chats.find((entry) => entry.id === id);
      if (chat?.archivedAt) {
        void requestRestoreChat(id);
        return;
      }
      if (isForkSubtreeBusy(chats, id, hasLiveHarnessWork)) return;
      void requestArchiveChatConfirmed(id);
    });
    syncArchiveMenuUi(chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null);
  }

  const deleteMenuBtn = document.getElementById('chat-delete-menu-btn');
  if (deleteMenuBtn) {
    bindChatToolbarActionItem(deleteMenuBtn, () => {
      closeChatActionsModal();
      const id = chatRuntime.activeChatId;
      if (!id) return;
      requestDeleteChat(id);
    });
  }

  const copyIdButtons = [
    ['chat-copy-chat-id-btn', 'chat-settings-chat-id-value'],
    ['chat-copy-session-id-btn', 'chat-settings-session-id-value'],
    ['chat-copy-agent-id-btn', 'chat-settings-agent-id-value'],
  ];
  for (const [btnId, valueId] of copyIdButtons) {
    const copyBtn = document.getElementById(btnId);
    if (!copyBtn) continue;
    copyBtn.addEventListener('click', () => {
      const valueEl = document.getElementById(valueId);
      const value = valueEl ? valueEl.textContent.trim() : '';
      if (!value || value === '—') return;
      void writeTextToClipboard(value).then((ok) => {
        if (!ok) return;
        const prevTitle = copyBtn.getAttribute('title');
        copyBtn.classList.add('is-copied');
        copyBtn.setAttribute('title', t('chat.copied'));
        window.setTimeout(() => {
          copyBtn.classList.remove('is-copied');
          copyBtn.setAttribute('title', prevTitle || '');
        }, 1200);
      });
    });
  }
}
