/**
 * Chat settings modal and diagnostics wiring plus the send-field preference.
 */
import { chatHost } from '../services/chatHost.js';
import { t } from '../../../i18n/index.js';
import { initModal } from '../../../lib/modal.js';
import { setStoredDictationResumeAfterSend } from '../../sendBar/sendBarMedia.js';
import { scheduleChatSendBarReserveSync } from '../chatSendBarLayout.js';
import {
  getShowSendFieldEnabled,
  healLegacyShowSendFieldPreference,
  setAutoUpdateChatTitleEnabled,
  setShowSendFieldEnabled,
} from '../chatSettingsPrefs.js';
import {
  cancelChatRun,
  forceReconnectChat,
  resetChatSdkContext,
  resetSdkChatRoom,
  runIntentionalSummary,
} from '../services/chatContextCompression.js';
import { syncChatTitlesFromServer } from '../services/chatLifecycle.js';
import { updateChatBarSelect } from '../services/chatSidebarState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatShell } from '../state/chatShellState.js';
import {
  applyActiveChatTitleLock,
  closeChatSettingsModal,
  initChatSettingsTabs,
  regenerateActiveChatTitle,
  saveChatSettings,
} from './chatSettingsModal.js';

const CHAT_TITLES_SYNC_INTERVAL_MS = 120000;

/**
 * WebKit reports checkbox.checked=false when the control sits in a
 * display:none settings tab. Saving then persisted a false preference.
 *
 * @param {Element | null} el
 * @returns {boolean}
 */
export function isChatSettingsControlOnVisibleTab(el) {
  if (!(el instanceof HTMLElement)) return false;
  const panel = el.closest('.chat-settings-tab-panel');
  if (!(panel instanceof HTMLElement)) return true;
  return !panel.hidden;
}

/**
 * Apply the “show send field” preference (class on #chat-panel).
 */
export function applySendFieldPreference() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  healLegacyShowSendFieldPreference();
  panel.classList.toggle('hide-send-field', !getShowSendFieldEnabled());
  scheduleChatSendBarReserveSync();
}
/** Wire settings modal, preferences and diagnostics buttons. */
export function bindChatPanelSettings() {
  chatHost.chatView.initDropdownWiring();

  chatRuntime.chatSettingsModalApi = initModal(document.getElementById('chat-settings-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  initChatSettingsTabs();
  const cancelBtn = document.getElementById('chat-settings-cancel');
  const saveBtn = document.getElementById('chat-settings-save');
  const updateTitleBtn = document.getElementById('chat-settings-update-title-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeChatSettingsModal();
  });
  if (saveBtn) saveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveChatSettings();
  });
    if (updateTitleBtn) updateTitleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      void regenerateActiveChatTitle(updateTitleBtn);
    });
    const titleLockCheckbox = document.getElementById('chat-settings-title-lock');
    if (titleLockCheckbox) {
      titleLockCheckbox.addEventListener('change', () => {
        void applyActiveChatTitleLock(titleLockCheckbox);
      });
    }
    const titleFromForkBtn = document.getElementById('chat-settings-title-from-fork-btn');
    if (titleFromForkBtn) {
      titleFromForkBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
        const hint = document.getElementById('chat-settings-update-title-hint');
        if (!chat) {
          if (hint) hint.textContent = t('chat.noActiveChat');
          return;
        }
        if (hint) hint.textContent = t('chat.creatingTempAgent');
        titleFromForkBtn.disabled = true;
        chatShell.requestTitleFromFork(
          chat,
          (title, errorMsg) => {
          titleFromForkBtn.disabled = false;
          if (hint) {
            hint.textContent = title
              ? t('chat.updatedTemp')
              : (errorMsg || t('chat.tooLittleContent'));
            setTimeout(() => { hint.textContent = ''; }, 8000);
          }
          if (title) {
            const titleInput = document.getElementById('chat-settings-title-input');
            if (titleInput) titleInput.value = title;
          }
        },
          (tempChat) => {
            if (hint) {
              hint.textContent = t('chat.tempChatOnList', { name: tempChat.title || '[Temp]' });
            }
          }
        );
      });
    }
    const summaryForkBtn = document.getElementById('chat-settings-summary-fork-btn');
    if (summaryForkBtn) {
      summaryForkBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
        const hint = document.getElementById('chat-settings-update-title-hint');
        if (!chat) {
          if (hint) hint.textContent = t('chat.noActiveChat');
          return;
        }
        if (hint) hint.textContent = t('chat.tempAgentAnalyzing');
        summaryForkBtn.disabled = true;
        chatShell.requestSummaryFromFork(
          chat,
          (result, errorMsg) => {
          summaryForkBtn.disabled = false;
          if (hint) {
            hint.textContent = result
              ? (result.summary ? t('chat.summarySaved') : '') + (result.title ? t('chat.nameUpdated') : '')
              : (errorMsg || t('chat.summaryFailed'));
            setTimeout(() => { hint.textContent = ''; }, 8000);
          }
          if (result && result.title) {
            const titleInput = document.getElementById('chat-settings-title-input');
            if (titleInput) titleInput.value = result.title;
          }
        },
          (tempChat) => {
            if (hint) {
              hint.textContent = t('chat.tempChatOnList', { name: tempChat.title || '[Temp]' });
            }
          }
        );
      });
    }
    const intentSummarySettingsBtn = document.getElementById('chat-settings-intent-summary-btn');
    if (intentSummarySettingsBtn) {
      intentSummarySettingsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
        const hint = document.getElementById('chat-settings-update-title-hint');
        if (!chat) {
          if (hint) hint.textContent = t('chat.noActiveChat');
          return;
        }
        void runIntentionalSummary(chat, hint);
      });
    }
  updateChatBarSelect();
  applySendFieldPreference();
  if (!chatShell.chatTitlesSyncTimer && typeof window !== 'undefined') {
    chatShell.chatTitlesSyncTimer = setInterval(syncChatTitlesFromServer, CHAT_TITLES_SYNC_INTERVAL_MS);
    window.addEventListener('pagehide', () => {
      if (!chatShell.chatTitlesSyncTimer) return;
      clearInterval(chatShell.chatTitlesSyncTimer);
      chatShell.chatTitlesSyncTimer = null;
    }, { once: true });
  }
  scheduleChatSendBarReserveSync();

  const showSendFieldCheckbox = document.getElementById('chat-settings-show-send-field');
  if (showSendFieldCheckbox) {
    showSendFieldCheckbox.addEventListener('change', (event) => {
      if (event.isTrusted === false) return;
      if (!isChatSettingsControlOnVisibleTab(showSendFieldCheckbox)) return;
      setShowSendFieldEnabled(showSendFieldCheckbox.checked);
      applySendFieldPreference();
    });
  }
  const chatSettingsAutoUpdateTitleCheckbox = document.getElementById('chat-settings-auto-update-title');
  if (chatSettingsAutoUpdateTitleCheckbox) {
    chatSettingsAutoUpdateTitleCheckbox.addEventListener('change', () => {
      setAutoUpdateChatTitleEnabled(chatSettingsAutoUpdateTitleCheckbox.checked);
      const globalAutoUpdateTitleCheckbox = document.getElementById('auto-update-chat-title-checkbox');
      if (globalAutoUpdateTitleCheckbox) globalAutoUpdateTitleCheckbox.checked = chatSettingsAutoUpdateTitleCheckbox.checked;
    });
  }
  const resumeDictationCheckbox = document.getElementById('chat-settings-resume-dictation');
  if (resumeDictationCheckbox) {
    resumeDictationCheckbox.addEventListener('change', () => {
      setStoredDictationResumeAfterSend(!!resumeDictationCheckbox.checked);
    });
  }

  const diagRefreshBtn = document.getElementById('chat-diag-refresh');
  if (diagRefreshBtn) {
    diagRefreshBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      chatRuntime.chatDiagnosticsApi.renderChatDiagnosis(chat);
    });
  }
  const diagFetchServerBtn = document.getElementById('chat-diag-fetch-server');
  if (diagFetchServerBtn) {
    diagFetchServerBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      void chatRuntime.chatDiagnosticsApi.fetchAndRenderServerDiag(chat);
    });
  }
  const diagReconnectBtn = document.getElementById('chat-diag-reconnect');
  if (diagReconnectBtn) {
    diagReconnectBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) return;
      forceReconnectChat(chat);
      const hint = document.getElementById('chat-diag-hint');
      if (hint) {
        hint.textContent = t('chat.diagReconnectForced');
        setTimeout(() => { hint.textContent = ''; }, 4000);
      }
    });
  }
  const diagResetRoomBtn = document.getElementById('chat-diag-reset-room');
  if (diagResetRoomBtn) {
    diagResetRoomBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) return;
      const hint = document.getElementById('chat-diag-hint');
      void resetSdkChatRoom(chat, hint);
    });
  }
  const diagResetContextBtn = document.getElementById('chat-diag-reset-context');
  if (diagResetContextBtn) {
    diagResetContextBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) return;
      const hint = document.getElementById('chat-diag-hint');
      void resetChatSdkContext(chat, hint);
    });
  }
  const diagProbeSdkBtn = document.getElementById('chat-diag-probe-sdk');
  if (diagProbeSdkBtn) {
    diagProbeSdkBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) return;
      const hint = document.getElementById('chat-diag-hint');
      void chatRuntime.chatDiagnosticsApi.runSdkAgentProbe(chat, hint);
    });
  }
  const diagCancelBtn = document.getElementById('chat-diag-cancel');
  if (diagCancelBtn) {
    diagCancelBtn.addEventListener('click', () => {
      const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
      if (!chat) return;
      cancelChatRun(chat);
      const hint = document.getElementById('chat-diag-hint');
      if (hint) {
        hint.textContent = t('chat.diagCancelSent');
        setTimeout(() => { hint.textContent = ''; }, 4000);
      }
    });
  }
}
