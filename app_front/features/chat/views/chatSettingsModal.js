/** Chat settings modal: tabs, load, save and title history. */
import * as api from '../../../core/api/index.js';
import { appLogger } from '../../../core/logging/logger.js';
import { t } from '../../../i18n/index.js';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import { isContextAdvisoryEnabled, normalizeContextAdvisoryWarnPercent } from '../../../../lib/sdk/sdk-context-advisory.ts';
import { createVoiceReadOptions } from '../../voice/voiceReadControls.js';
import { getStoredDictationResumeAfterSend, setStoredDictationResumeAfterSend } from '../../sendBar/sendBarMedia.js';
import { writeLocalStorageSafe } from '../chatLocalStorage.js';
import {
  getShowSendFieldEnabled,
  getAutoUpdateChatTitleEnabled,
  isChatDiagEnabled,
  getSdkVerboseLogsEnabled,
  setShowSendFieldEnabled,
  setAutoUpdateChatTitleEnabled,
  SHOW_CHAT_DIAG_KEY,
  SDK_VERBOSE_LOGS_KEY,
} from '../chatSettingsPrefs.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatHost } from '../services/chatHost.js';

const CHAT_SETTINGS_TABS = ['chat', 'voice', 'context', 'diagnosis'];

/**
 * @param {string} tabId
 */
function applyChatSettingsTab(tabId) {
  const nextTab = CHAT_SETTINGS_TABS.includes(tabId) ? tabId : 'chat';
  const modal = document.getElementById('chat-settings-modal');
  if (!modal) return;
  modal.querySelectorAll('[data-chat-settings-tab]').forEach((el) => {
    const isMatch = el.dataset.chatSettingsTab === nextTab;
    if (el.getAttribute('role') === 'tab') {
      el.classList.toggle('active', isMatch);
      el.setAttribute('aria-selected', isMatch ? 'true' : 'false');
      return;
    }
    el.hidden = !isMatch;
  });
}

export function initChatSettingsTabs() {
  const tabBar = document.getElementById('chat-settings-tabs');
  if (!tabBar) return;
  tabBar.querySelectorAll('[data-chat-settings-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyChatSettingsTab(btn.dataset.chatSettingsTab || 'chat');
    });
  });
  applyChatSettingsTab('chat');
}

/**
 * Open the settings modal for the active chat (name, Send-field option).
 */
export function openChatSettingsModal() {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat) return;
  const modal = document.getElementById('chat-settings-modal');
  const modalDialog = modal?.querySelector('.chat-settings-dialog');
  const titleInput = document.getElementById('chat-settings-title-input');
  const showSendFieldCheckbox = document.getElementById('chat-settings-show-send-field');
  const autoUpdateTitleCheckbox = document.getElementById('chat-settings-auto-update-title');
  const showDiagCheckbox = document.getElementById('chat-settings-show-diag');
  const sdkVerboseLogsCheckbox = document.getElementById('chat-settings-sdk-verbose-logs');
  const sdkUiModeSelect = document.getElementById('chat-settings-sdk-ui-mode');
  const sdkSystemPromptInput = document.getElementById('chat-settings-sdk-system-prompt');
  const autoContextCompressionEnabledCheckbox = document.getElementById(
    'chat-settings-auto-context-compression-enabled'
  );
  const autoContextCompressionThresholdInput = document.getElementById(
    'chat-settings-auto-context-compression-threshold'
  );
  const contextAdvisoryEnabledCheckbox = document.getElementById('chat-settings-context-advisory-enabled');
  const contextAdvisoryWarnPercentInput = document.getElementById(
    'chat-settings-context-advisory-warn-percent'
  );
  const contextSummaryResetCheckbox = document.getElementById('chat-settings-context-summary-reset');
  const sessionMetaEl = document.getElementById('chat-settings-session-meta');
  if (!modal || !titleInput) return;
  titleInput.value = chat.title || '';
  titleInput.dataset.baseTitle = chat.title || '';
  void refreshChatTitleHistorySection(chat);
  if (showSendFieldCheckbox) {
    showSendFieldCheckbox.checked = getShowSendFieldEnabled();
  }
  if (autoUpdateTitleCheckbox) {
    autoUpdateTitleCheckbox.checked = getAutoUpdateChatTitleEnabled();
  }
  if (showDiagCheckbox) {
    showDiagCheckbox.checked = isChatDiagEnabled();
  }
  if (sdkVerboseLogsCheckbox) {
    sdkVerboseLogsCheckbox.checked = getSdkVerboseLogsEnabled();
  }
  if (sdkUiModeSelect) {
    sdkUiModeSelect.value = normalizeSdkUiMode(chat.sdkUiMode);
  }
  if (sdkSystemPromptInput) {
    sdkSystemPromptInput.value = typeof chat.sdkSystemPrompt === 'string' ? chat.sdkSystemPrompt : '';
    const sdkPromptRow = sdkSystemPromptInput.closest('.chat-settings-form');
    if (sdkPromptRow) {
      sdkSystemPromptInput.hidden = chat.agentTransport !== 'sdk';
      const label = sdkPromptRow.querySelector('[for="chat-settings-sdk-system-prompt"]');
      if (label) label.hidden = chat.agentTransport !== 'sdk';
      const hint = label?.nextElementSibling?.classList?.contains('chat-settings-hint-inline')
        ? label.nextElementSibling
        : sdkSystemPromptInput.nextElementSibling;
      if (hint?.classList?.contains('chat-settings-hint-inline')) {
        hint.hidden = chat.agentTransport !== 'sdk';
      }
    }
  }
  if (autoContextCompressionEnabledCheckbox) {
    autoContextCompressionEnabledCheckbox.checked = chatHost.isAutoContextCompressionEnabled(chat);
  }
  if (autoContextCompressionThresholdInput) {
    autoContextCompressionThresholdInput.value = String(
      chatHost.normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold)
    );
  }
  if (contextAdvisoryEnabledCheckbox) {
    contextAdvisoryEnabledCheckbox.checked = isContextAdvisoryEnabled(chat);
  }
  if (contextAdvisoryWarnPercentInput) {
    contextAdvisoryWarnPercentInput.value = String(
      normalizeContextAdvisoryWarnPercent(chat.contextAdvisoryWarnPercent)
    );
  }
  if (contextSummaryResetCheckbox) {
    contextSummaryResetCheckbox.checked = chatHost.shouldResetAfterContextCompression(chat);
  }
  const updateTitleHint = document.getElementById('chat-settings-update-title-hint');
  if (updateTitleHint) updateTitleHint.textContent = '';
  if (sessionMetaEl) {
    const chatId = chat.id ? String(chat.id) : '—';
    const sessionId = chat.cursorSessionId ? String(chat.cursorSessionId) : '—';
    const agentId = chat.sdkAgentId
      ? String(chat.sdkAgentId)
      : (chat.model ? String(chat.model) : (chat.agentTransport ? String(chat.agentTransport) : '—'));
    sessionMetaEl.hidden = false;
    const chatIdValueEl = document.getElementById('chat-settings-chat-id-value');
    const sessionIdValueEl = document.getElementById('chat-settings-session-id-value');
    const agentIdValueEl = document.getElementById('chat-settings-agent-id-value');
    if (chatIdValueEl) chatIdValueEl.textContent = chatId;
    if (sessionIdValueEl) sessionIdValueEl.textContent = sessionId;
    if (agentIdValueEl) agentIdValueEl.textContent = agentId;
  }
  const voiceReadMount = document.getElementById('chat-settings-voice-read');
  if (voiceReadMount && !chatRuntime.chatSettingsVoiceRead) {
    chatRuntime.chatSettingsVoiceRead = createVoiceReadOptions();
    voiceReadMount.replaceChildren(chatRuntime.chatSettingsVoiceRead.root);
  }
  chatRuntime.chatSettingsVoiceRead?.refresh();
  const resumeDictationCheckbox = document.getElementById('chat-settings-resume-dictation');
  if (resumeDictationCheckbox) {
    resumeDictationCheckbox.checked = getStoredDictationResumeAfterSend();
  }
  applyChatSettingsTab('chat');
  chatRuntime.chatSettingsModalApi?.open();
  if (modalDialog instanceof HTMLElement) {
    modalDialog.scrollTop = 0;
  }
  const formEl = modal.querySelector('.chat-settings-form');
  if (formEl instanceof HTMLElement) {
    formEl.scrollTop = 0;
  }
  chatRuntime.chatDiagnosticsApi.renderChatDiagnosis(chat);
  titleInput.focus();
}

export function closeChatSettingsModal() {
  chatRuntime.chatSettingsModalApi?.close();
}

/**
 * Saves chat settings from the modal (PATCH) and closes the modal.
 */
function setChatSettingsTitleHint(text, clearAfterMs = 4000) {
  const hint = document.getElementById('chat-settings-update-title-hint');
  if (!hint) return;
  hint.textContent = text;
  if (text && clearAfterMs > 0) {
    setTimeout(() => {
      if (hint.textContent === text) hint.textContent = '';
    }, clearAfterMs);
  }
}

function isChatSettingsModalOpenFor(chatId) {
  const modal = document.getElementById('chat-settings-modal');
  return !!(modal && !modal.hidden && chatId && chatId === chatRuntime.activeChatId);
}

const TITLE_REASON_KEYS = {
  first: 'chat.titleReasonFirst',
  regenerate: 'chat.titleReasonRegenerate',
  rename: 'chat.titleReasonRename',
  backfill: 'chat.titleReasonBackfill',
};

/**
 * Builds the "Title history" timeline (newest first) + lock checkbox for the open settings modal.
 * @param {object} chat
 * @param {{ title?: string, titleSource?: string, history?: Array<object> } | null} [loaded] already fetched response
 */
async function refreshChatTitleHistorySection(chat, loaded = null) {
  const listEl = document.getElementById('chat-settings-title-history-list');
  const lockCheckbox = document.getElementById('chat-settings-title-lock');
  if (!listEl || !chat?.id) return;
  const data = loaded || await api.getChatTitleHistory(chat.id).catch(() => null);
  if (!isChatSettingsModalOpenFor(chat.id)) return;
  if (!data || !data.ok) return;
  if (typeof data.titleSource === 'string' && data.titleSource) chat.titleSource = data.titleSource;
  if (lockCheckbox) lockCheckbox.checked = chat.titleSource === 'manual';
  const history = Array.isArray(data.history) ? [...data.history].reverse() : [];
  listEl.textContent = '';
  if (history.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = t('chat.titleHistoryEmpty');
    listEl.appendChild(empty);
    return;
  }
  const currentTitle = typeof data.title === 'string' ? data.title : (chat.title || '');
  history.forEach((entry, index) => {
    const li = document.createElement('li');
    const at = document.createElement('span');
    at.className = 'chat-settings-title-history-at';
    const when = new Date(entry.at);
    at.textContent = Number.isNaN(when.getTime()) ? '' : when.toLocaleString();
    const text = document.createElement('span');
    text.className = 'chat-settings-title-history-text';
    text.textContent = entry.title || '';
    const meta = document.createElement('span');
    meta.className = 'chat-settings-title-history-meta';
    const sourceLabel = t(entry.source === 'manual' ? 'chat.titleSourceManual' : 'chat.titleSourceAuto');
    const reasonKey = TITLE_REASON_KEYS[entry.reason];
    meta.textContent = reasonKey ? `${sourceLabel} · ${t(reasonKey)}` : sourceLabel;
    li.append(at, text, meta);
    if (index === 0 && entry.title === currentTitle) {
      const current = document.createElement('span');
      current.className = 'chat-settings-title-history-meta';
      current.textContent = `(${t('chat.titleHistoryCurrent')})`;
      li.appendChild(current);
    } else if (entry.title) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'chat-settings-btn-secondary';
      restore.textContent = t('chat.titleHistoryRestore');
      restore.addEventListener('click', () => {
        void restoreChatTitleFromHistory(chat, entry.title, restore);
      });
      li.appendChild(restore);
    }
    listEl.appendChild(li);
  });
}

async function restoreChatTitleFromHistory(chat, title, button) {
  if (button) button.disabled = true;
  try {
    const res = await api.patchChat(chat.id, { title });
    if (!res?.ok) return;
    chat.title = title;
    chat.titleSource = 'manual';
    const titleInput = document.getElementById('chat-settings-title-input');
    if (titleInput) {
      titleInput.value = title;
      titleInput.dataset.baseTitle = title;
    }
    chatHost.renderChatList();
    chatHost.updateChatBarSelect();
    setChatSettingsTitleHint(t('chat.titleHistoryRestored'));
    await refreshChatTitleHistorySection(chat);
  } finally {
    if (button) button.disabled = false;
  }
}

/** "Update title": server-side regenerate, nothing is injected into the conversation. */
export async function regenerateActiveChatTitle(button) {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat) {
    setChatSettingsTitleHint(t('chat.noActiveChat'));
    return;
  }
  if (button) button.disabled = true;
  setChatSettingsTitleHint(t('chat.titleRegenerating'), 0);
  try {
    const res = await api.regenerateChatTitle(chat.id);
    if (res?.ok && res.chat) {
      chat.title = res.chat.title;
      chat.titleSource = res.chat.titleSource || 'auto';
      const titleInput = document.getElementById('chat-settings-title-input');
      if (titleInput && isChatSettingsModalOpenFor(chat.id)) {
        // Only replace the field when the user has not started editing it.
        if (titleInput.value === (titleInput.dataset.baseTitle ?? '')) titleInput.value = chat.title;
        titleInput.dataset.baseTitle = chat.title;
      }
      chatHost.renderChatList();
      chatHost.updateChatBarSelect();
      setChatSettingsTitleHint(t('chat.titleRegenerated'));
      await refreshChatTitleHistorySection(chat);
    } else if (res?.reason === 'no_generator') {
      setChatSettingsTitleHint(t('chat.titleRegenerateUnavailable'), 8000);
    } else if (res?.status === 'skipped') {
      setChatSettingsTitleHint(t('chat.titleRegenerateSkipped', { reason: res.reason || '' }), 8000);
    } else {
      setChatSettingsTitleHint(t('chat.titleRegenerateFailed'), 8000);
    }
  } catch (err) {
    appLogger.log('api-error', 'POST /api/chats/' + chat.id + '/regenerate-title', String(err));
    setChatSettingsTitleHint(t('chat.titleRegenerateFailed'), 8000);
  } finally {
    if (button) button.disabled = false;
  }
}

export async function applyActiveChatTitleLock(checkbox) {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat) return;
  const wanted = checkbox.checked === true;
  const res = await api.setChatTitleLock(chat.id, wanted).catch(() => null);
  if (!res?.ok || !res.chat) {
    checkbox.checked = !wanted;
    return;
  }
  chat.titleSource = res.chat.titleSource;
  chatHost.renderChatList();
  setChatSettingsTitleHint(t('chat.titleLockSaved'));
}

/**
 * Server `chatsChanged` reason:'title' (auto title, another tab/device, MCP rename). The list reload
 * is handled by the live sync; here the open settings modal is refreshed without overwriting
 * text the user is typing.
 */
export function handleServerTitleChanged(chatId) {
  if (!chatId || !isChatSettingsModalOpenFor(chatId)) return;
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  void api.getChatTitleHistory(chatId).then((data) => {
    if (!data?.ok || !isChatSettingsModalOpenFor(chatId)) return;
    const serverTitle = typeof data.title === 'string' ? data.title : '';
    const titleInput = document.getElementById('chat-settings-title-input');
    if (titleInput && serverTitle !== (titleInput.dataset.baseTitle ?? '')) {
      const untouched = titleInput.value === (titleInput.dataset.baseTitle ?? '');
      if (untouched) {
        titleInput.value = serverTitle;
      } else {
        setChatSettingsTitleHint(t('chat.titleChangedElsewhere'), 8000);
      }
      titleInput.dataset.baseTitle = serverTitle;
    }
    return refreshChatTitleHistorySection(chat, data);
  }).catch(() => {});
}

export function saveChatSettings() {
  const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
  if (!chat) {
    closeChatSettingsModal();
    return;
  }
  const titleInput = document.getElementById('chat-settings-title-input');
  if (!titleInput) return;
  const newTitle = (titleInput.value || '').trim();
  const payload = {};
  // Compare with the title the field was filled with, not the live one: an auto title that landed
  // while the modal was open must not be overwritten by a stale, untouched field.
  const baseTitle = titleInput.dataset.baseTitle ?? (chat.title || '');
  if (newTitle !== baseTitle && newTitle !== (chat.title || '')) payload.title = newTitle;
  const sdkUiModeSelect = document.getElementById('chat-settings-sdk-ui-mode');
  const nextSdkUiMode = normalizeSdkUiMode(sdkUiModeSelect?.value);
  if (nextSdkUiMode !== normalizeSdkUiMode(chat.sdkUiMode)) {
    payload.sdkUiMode = nextSdkUiMode;
  }
  const sdkSystemPromptInput = document.getElementById('chat-settings-sdk-system-prompt');
  if (
    sdkSystemPromptInput
    && chat.agentTransport === 'sdk'
    && chatHost.isChatSettingsControlOnVisibleTab(sdkSystemPromptInput)
  ) {
    const nextPrompt = sdkSystemPromptInput.value.trim();
    const prevPrompt = typeof chat.sdkSystemPrompt === 'string' ? chat.sdkSystemPrompt.trim() : '';
    if (nextPrompt !== prevPrompt) {
      payload.sdkSystemPrompt = nextPrompt || null;
    }
  }
  const showSendFieldCheckbox = document.getElementById('chat-settings-show-send-field');
  const autoUpdateTitleCheckbox = document.getElementById('chat-settings-auto-update-title');
  if (showSendFieldCheckbox && chatHost.isChatSettingsControlOnVisibleTab(showSendFieldCheckbox)) {
    setShowSendFieldEnabled(showSendFieldCheckbox.checked);
    chatHost.applySendFieldPreference();
  }
  if (autoUpdateTitleCheckbox && chatHost.isChatSettingsControlOnVisibleTab(autoUpdateTitleCheckbox)) {
    setAutoUpdateChatTitleEnabled(autoUpdateTitleCheckbox.checked);
    const globalAutoUpdateTitleCheckbox = document.getElementById('auto-update-chat-title-checkbox');
    if (globalAutoUpdateTitleCheckbox) globalAutoUpdateTitleCheckbox.checked = autoUpdateTitleCheckbox.checked;
  }
  const resumeDictationCheckbox = document.getElementById('chat-settings-resume-dictation');
  if (resumeDictationCheckbox && chatHost.isChatSettingsControlOnVisibleTab(resumeDictationCheckbox)) {
    setStoredDictationResumeAfterSend(!!resumeDictationCheckbox.checked);
  }
  const showDiagCheckbox = document.getElementById('chat-settings-show-diag');
  if (showDiagCheckbox && chatHost.isChatSettingsControlOnVisibleTab(showDiagCheckbox)) {
    writeLocalStorageSafe(
      SHOW_CHAT_DIAG_KEY,
      showDiagCheckbox.checked ? 'true' : 'false',
      'saveChatSettings.showDiag'
    );
    const activeChat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (activeChat) {
      chatRuntime.chatDiagnosticsApi.syncChatDiagEnabled(activeChat);
    }
  }
  const sdkVerboseLogsCheckbox = document.getElementById('chat-settings-sdk-verbose-logs');
  if (sdkVerboseLogsCheckbox && chatHost.isChatSettingsControlOnVisibleTab(sdkVerboseLogsCheckbox)) {
    writeLocalStorageSafe(
      SDK_VERBOSE_LOGS_KEY,
      sdkVerboseLogsCheckbox.checked ? 'true' : 'false',
      'saveChatSettings.sdkVerboseLogs'
    );
  }
  const autoContextCompressionEnabledCheckbox = document.getElementById(
    'chat-settings-auto-context-compression-enabled'
  );
  if (
    autoContextCompressionEnabledCheckbox
    && chatHost.isChatSettingsControlOnVisibleTab(autoContextCompressionEnabledCheckbox)
  ) {
    const enabled = autoContextCompressionEnabledCheckbox.checked === true;
    if (enabled !== chatHost.isAutoContextCompressionEnabled(chat)) {
      payload.autoContextCompressionEnabled = enabled;
    }
  }
  const autoContextCompressionThresholdInput = document.getElementById(
    'chat-settings-auto-context-compression-threshold'
  );
  if (
    autoContextCompressionThresholdInput
    && chatHost.isChatSettingsControlOnVisibleTab(autoContextCompressionThresholdInput)
  ) {
    const threshold = chatHost.normalizeAutoContextCompressionThreshold(autoContextCompressionThresholdInput.value);
    if (threshold !== chatHost.normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold)) {
      payload.autoContextCompressionThreshold = threshold;
    }
  }
  const contextAdvisoryEnabledCheckbox = document.getElementById('chat-settings-context-advisory-enabled');
  if (contextAdvisoryEnabledCheckbox && chatHost.isChatSettingsControlOnVisibleTab(contextAdvisoryEnabledCheckbox)) {
    const enabled = contextAdvisoryEnabledCheckbox.checked !== false;
    if (enabled !== isContextAdvisoryEnabled(chat)) {
      payload.contextAdvisoryEnabled = enabled;
    }
  }
  const contextAdvisoryWarnPercentInput = document.getElementById(
    'chat-settings-context-advisory-warn-percent'
  );
  if (
    contextAdvisoryWarnPercentInput
    && chatHost.isChatSettingsControlOnVisibleTab(contextAdvisoryWarnPercentInput)
  ) {
    const warnPercent = normalizeContextAdvisoryWarnPercent(contextAdvisoryWarnPercentInput.value);
    if (warnPercent !== normalizeContextAdvisoryWarnPercent(chat.contextAdvisoryWarnPercent)) {
      payload.contextAdvisoryWarnPercent = warnPercent;
    }
  }
  const contextSummaryResetCheckbox = document.getElementById('chat-settings-context-summary-reset');
  if (contextSummaryResetCheckbox && chatHost.isChatSettingsControlOnVisibleTab(contextSummaryResetCheckbox)) {
    const resetEnabled = contextSummaryResetCheckbox.checked === true;
    if (resetEnabled !== chatHost.shouldResetAfterContextCompression(chat)) {
      payload.autoContextCompressionReset = resetEnabled;
    }
  }

  if (Object.keys(payload).length === 0) {
    closeChatSettingsModal();
    return;
  }
  appLogger.log('api-request', 'PATCH /api/chats/' + chat.id + ' (' + t('chat.settings') + ')', payload);
  api.patchChat(chat.id, payload).then((data) => {
    appLogger.log('api-response', 'PATCH /api/chats/' + chat.id + ' (' + t('chat.settings') + ')', data);
    if (!data.ok) return;
    if (payload.title !== undefined) {
      chat.title = newTitle;
      appLogger.log('chat-title', 'settings (manual change):', newTitle);
      chatHost.updateChatBarSelect();
    }
    if (payload.sdkUiMode !== undefined) {
      chat.sdkUiMode = nextSdkUiMode;
      chat._sdkRichView?.setUiMode?.(nextSdkUiMode);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'sdkSystemPrompt')) {
      if (payload.sdkSystemPrompt) chat.sdkSystemPrompt = payload.sdkSystemPrompt;
      else delete chat.sdkSystemPrompt;
    }
    if (payload.autoContextCompressionEnabled !== undefined) {
      chat.autoContextCompressionEnabled = payload.autoContextCompressionEnabled;
      if (!chat.autoContextCompressionEnabled) {
        chat._autoContextCompressionPending = false;
      }
    }
    if (payload.autoContextCompressionThreshold !== undefined) {
      chat.autoContextCompressionThreshold = payload.autoContextCompressionThreshold;
    }
    if (payload.autoContextCompressionReset !== undefined) {
      chat.autoContextCompressionReset = payload.autoContextCompressionReset;
    }
    if (payload.contextAdvisoryEnabled !== undefined) {
      if (payload.contextAdvisoryEnabled === false) chat.contextAdvisoryEnabled = false;
      else delete chat.contextAdvisoryEnabled;
    }
    if (payload.contextAdvisoryWarnPercent !== undefined) {
      chat.contextAdvisoryWarnPercent = payload.contextAdvisoryWarnPercent;
    }
    chatRuntime.chatDiagnosticsApi?.updateChatContextMeter?.(
      chat,
      chatRuntime.chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
    );
    closeChatSettingsModal();
  }).catch((err) => {
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id + ' (' + t('chat.settings') + ')', String(err));
  });
}
