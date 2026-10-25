/** Chat titles, local buffer reads and agent output filtering. */
import { readChatBufferSync, persistChatBuffer } from '../../../lib/chatBufferStore.js';
import { CHAT_BUFFER_LOCALSTORAGE_PREFIX, CHAT_BUFFER_MAX } from '../../../config.js';
import { getReadChatBufferFromLocalStorageEnabled, getAutoNameChatEnabled, setAutoNameChatEnabled, getAutoUpdateChatTitleEnabled, setAutoUpdateChatTitleEnabled, getSkipCatchUpOnResume, setSkipCatchUpOnResume, getChatCanvasAddonEnabled, setChatCanvasAddonEnabled, setReadChatBufferFromLocalStorageEnabled } from '../chatSettingsPrefs.js';
import { initAutoTitleSettings } from '../../settings/autoTitleSettings.js';
import { initChatAutoArchiveSettings } from '../../settings/chatAutoArchiveSettings.js';
import { setSidebarArchiveCountdownListener } from '../../sidebar/sidebarArchiveCountdownClock.js';
import { t } from '../../../i18n/index.js';
import * as api from '../../../core/api/index.js';
import { appLogger } from '../../../core/logging/logger.js';
import { debugAutoTitle } from './chatDebugLogs.js';
import { chatRuntime } from '../state/chatRuntimeState.js';
import { previewStr, tryExtractTitleFromBuffer, splitTrailingTitleJson, tryExtractStandaloneTitleJson } from '../chatTitleParsing.js';
import { AUTO_TITLE_RESPONSE_AFTER_MS, PASSIVE_TITLE_DEDUP_MS } from '../chatTitleFork.js';
import { onAgentOutput, renderChatList, scheduleChatListStateRefreshAll, scheduleTerminalStateRefresh, setAgentState, updateAwaitingInput } from './chatSidebarState.js';
import { getChatAgentState } from './chatSidebarHooks.js';

/** Reads the buffer from localStorage ignoring the checkbox (e.g. SDK mode, which has no server catch-up). */
export function readChatBufferRawFromLocalStorage(chatId) {
  return readChatBufferSync(chatId, CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

export function readChatBufferFromLocalStorage(chatId) {
  if (!chatId) return '';
  if (!getReadChatBufferFromLocalStorageEnabled()) return '';
  return readChatBufferRawFromLocalStorage(chatId);
}

/**
 * On chat start: CLI honours the "read buffer" preference; SDK always reads the saved buffer because it has no PTY catch-up.
 * @param {string} chatId
 * @param {boolean} [isSdk]
 */
export function readChatBufferForChatRestore(chatId, isSdk) {
  if (!chatId) return '';
  if (isSdk) return readChatBufferRawFromLocalStorage(chatId);
  return readChatBufferFromLocalStorage(chatId);
}

/** Initialize Chat checkboxes in the Settings panel. */
export function initAutoNameChatSetting() {
  initAutoTitleSettings();
  initChatAutoArchiveSettings();
  // Keep the sidebar auto-archive countdown ticking while the setting is enabled
  // (the clock itself is a no-op when disabled).
  setSidebarArchiveCountdownListener(() => scheduleChatListStateRefreshAll());
  const cb = document.getElementById('auto-name-chat-checkbox');
  if (cb) {
    cb.checked = getAutoNameChatEnabled();
    cb.addEventListener('change', () => setAutoNameChatEnabled(cb.checked));
  }
  const autoUpdateTitleCb = document.getElementById('auto-update-chat-title-checkbox');
  if (autoUpdateTitleCb) {
    autoUpdateTitleCb.checked = getAutoUpdateChatTitleEnabled();
    autoUpdateTitleCb.addEventListener('change', () => {
      setAutoUpdateChatTitleEnabled(autoUpdateTitleCb.checked);
      const chatSettingsAutoUpdateTitleCheckbox = document.getElementById('chat-settings-auto-update-title');
      if (chatSettingsAutoUpdateTitleCheckbox) {
        chatSettingsAutoUpdateTitleCheckbox.checked = autoUpdateTitleCb.checked;
      }
    });
  }
  const skipCatchUpCb = document.getElementById('skip-catchup-on-resume-checkbox');
  if (skipCatchUpCb) {
    skipCatchUpCb.checked = getSkipCatchUpOnResume();
    skipCatchUpCb.addEventListener('change', () => setSkipCatchUpOnResume(skipCatchUpCb.checked));
  }
  const maintainCb = document.getElementById('maintain-sessions-checkbox');
  if (maintainCb) {
    maintainCb.checked = true;
    maintainCb.disabled = true;
    maintainCb.title = t('chat.alwaysEnabled');
  }
  const connectAllCb = document.getElementById('connect-all-chats-on-start-checkbox');
  if (connectAllCb) {
    connectAllCb.checked = true;
    connectAllCb.disabled = true;
    connectAllCb.title = t('chat.alwaysEnabled');
  }
  const canvasAddonCb = document.getElementById('chat-canvas-addon-checkbox');
  if (canvasAddonCb) {
    canvasAddonCb.checked = getChatCanvasAddonEnabled();
    canvasAddonCb.addEventListener('change', () => setChatCanvasAddonEnabled(canvasAddonCb.checked));
  }
  const readBufferCb = document.getElementById('chat-read-buffer-from-localstorage-checkbox');
  if (readBufferCb) {
    readBufferCb.checked = getReadChatBufferFromLocalStorageEnabled();
    readBufferCb.addEventListener('change', () => {
      setReadChatBufferFromLocalStorageEnabled(readBufferCb.checked);
    });
  }
  const agentTitlePrintCb = document.getElementById('agent-title-print-checkbox');
  if (agentTitlePrintCb) {
    api.getSettings().then((data) => {
      if (data && data.ok) agentTitlePrintCb.checked = !!data.agentTitlePrint;
    }).catch(() => {});
    agentTitlePrintCb.addEventListener('change', () => {
      api.patchSettings({ agentTitlePrint: agentTitlePrintCb.checked }).catch(() => {});
    });
  }
}

/**
 * Output filter: while waiting for an auto-title, parse JSON and update the chat name.
 * Accept a title change only when the output arrived after the stored request time (requestAt + margin).
 * @param {object} chat
 * @param {string} data
 * @returns {boolean} true if the output was consumed (optional for future filters)
 */
export function patchChatTitle(chat, title, opts = {}) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  if (!chat || !normalized) return false;
  if ((chat.title || '').trim() === normalized) return false;
  // The server already titled this chat (auto) or the user renamed it: automatic client flows must not override.
  if (!opts.showHint && (chat.titleSource === 'auto' || chat.titleSource === 'manual')) return false;
  if (chat._titlePatchInFlight && chat._titlePatchTarget === normalized) return false;
  chat._titlePatchInFlight = true;
  chat._titlePatchTarget = normalized;
  const patchPayload = { title: normalized };
  appLogger.log('api-request', 'PATCH /api/chats/' + chat.id, patchPayload);
  api.patchChat(chat.id, patchPayload).then((res) => {
    appLogger.log('api-response', 'PATCH /api/chats/' + chat.id, res);
    debugAutoTitle('patchChat response', { chatId: chat.id, ok: res?.ok, res, source: opts.source || 'unknown' });
    if (!res || !res.ok) return;
    chat.title = normalized;
    appLogger.log('chat-title', opts.logLabel || 'auto-title (backend):', normalized);
    renderChatList();
    const modal = document.getElementById('chat-settings-modal');
    const titleInput = document.getElementById('chat-settings-title-input');
    if (modal && !modal.hidden && chat.id === chatRuntime.activeChatId && titleInput) {
      titleInput.value = normalized;
    }
    if (!opts.showHint) return;
    const hint = document.getElementById('chat-settings-update-title-hint');
    if (!hint) return;
    hint.textContent = t('chat.updated');
    setTimeout(() => { hint.textContent = ''; }, 2000);
  }).catch((err) => {
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id, String(err));
    debugAutoTitle('patchChat error', { chatId: chat.id, err: String(err), source: opts.source || 'unknown' });
  }).finally(() => {
    chat._titlePatchInFlight = false;
    chat._titlePatchTarget = '';
  });
  return true;
}

export function filterOutputAutoTitle(chat, data) {
  if (!getAutoUpdateChatTitleEnabled() && !chat?._pendingAutoTitle) return false;
  const pending = !!chat._pendingAutoTitle;
  debugAutoTitle('filter', { chatId: chat.id, pending, dataType: typeof data, dataLen: data?.length, dataPreview: previewStr(data, 80) });
  if (!pending) {
    if (data && String(data).includes('"title"')) {
      debugAutoTitle('filter skip', { chatId: chat.id, msg: 'a response with "title" arrived, but pending=false – monitoring is off (timed out?)' });
    }
    return false;
  }
  const requestAt = chat._autoTitleRequestAt ?? 0;
  const now = Date.now();
  if (requestAt && now - requestAt < AUTO_TITLE_RESPONSE_AFTER_MS) {
    debugAutoTitle('filter before request', { chatId: chat.id, msSinceRequest: now - requestAt, msg: 'output predates the response timestamp – skipping (only later JSON counts)' });
    return false;
  }
  chat._autoTitleBuffer = (chat._autoTitleBuffer || '') + (data || '');
  const title = tryExtractTitleFromBuffer(chat._autoTitleBuffer, debugAutoTitle);
  if (chat._autoTitleBuffer.length > 500 || title) {
    debugAutoTitle('buffer', { chatId: chat.id, bufferLen: chat._autoTitleBuffer.length, extractedTitle: title ?? '(none)' });
  }
  if (!title) return false;
  chat._pendingAutoTitle = false;
  chat._autoTitleBuffer = '';
  if (chat._autoTitleTimeout) {
    clearTimeout(chat._autoTitleTimeout);
    chat._autoTitleTimeout = null;
  }
  debugAutoTitle('patch', { chatId: chat.id, title });
  patchChatTitle(chat, title, {
    source: 'pending',
    showHint: true,
    logLabel: 'auto-title (agent response):',
  });
  return false;
}

/**
 * Passive title detection from the backend: works without _pendingAutoTitle.
 * Handles the case when the backend sends a JSON line {"title":"..."}.
 */
export function filterOutputPassiveTitle(chat, data, opts = {}) {
  if (!chat || !data || opts.catchUp) return false;
  if (chat._pendingAutoTitle) return false;
  const incoming = typeof data === 'string' ? data : String(data);
  chat._passiveTitleBuffer = (chat._passiveTitleBuffer || '') + incoming;
  if (chat._passiveTitleBuffer.length > 1200) {
    chat._passiveTitleBuffer = chat._passiveTitleBuffer.slice(-1200);
  }
  const trailing = splitTrailingTitleJson(chat._passiveTitleBuffer);
  const title = trailing.title || (
    getAutoUpdateChatTitleEnabled() ? tryExtractStandaloneTitleJson(chat._passiveTitleBuffer) : null
  );
  if (!title) return false;
  const now = Date.now();
  if (chat._lastPassiveTitle === title && now - (chat._lastPassiveTitleAt || 0) < PASSIVE_TITLE_DEDUP_MS) {
    return false;
  }
  chat._lastPassiveTitle = title;
  chat._lastPassiveTitleAt = now;
  chat._passiveTitleBuffer = '';
  debugAutoTitle('patch (passive)', { chatId: chat.id, title });
  patchChatTitle(chat, title, {
    source: 'passive',
    logLabel: 'auto-title (passive backend monitoring):',
  });
  return false;
}

/** Matches the default title the server assigns when a chat is created without a name ("Chat 12"). */
export const DEFAULT_CHAT_TITLE_RE = /^chat \d+$/i;

/** Max length of the first message sent to the backend title generator. */
export const AUTO_NAME_PROMPT_MAX_CHARS = 4000;

/**
 * @param {unknown} title
 * @returns {boolean} true when the chat still carries the auto-assigned default name
 */
export function isDefaultChatTitle(title) {
  return DEFAULT_CHAT_TITLE_RE.test(String(title || '').trim());
}

/**
 * When "Automatic name for a new chat" is enabled and the chat still has the
 * default title, generate a title from the first message via the backend
 * one-shot agent and patch the chat (the conversation itself is untouched).
 * @param {object} chat
 * @param {string} messageText
 */
export function maybeAutoNameNewChat(chat, messageText) {
  if (!chat?.id) return;
  if (!getAutoNameChatEnabled()) return;
  if (chat._autoNameRequested) return;
  if (!isDefaultChatTitle(chat.title)) return;
  const text = String(messageText || '').trim();
  if (!text) return;
  chat._autoNameRequested = true;
  const promptText = text.slice(0, AUTO_NAME_PROMPT_MAX_CHARS);
  const payload = {
    text: promptText,
    workspaceFile: chat.workspaceFile || undefined,
    workspaceFolder: chat.workspaceFolder || undefined,
  };
  if (chat.model) payload.model = chat.model;
  debugAutoTitle('auto-name', { chatId: chat.id, textLen: promptText.length });
  appLogger.log('api-request', 'POST /api/generate-chat-title (auto-name)', { chatId: chat.id, textLen: promptText.length });
  api.postGenerateChatTitle(payload).then((res) => {
    appLogger.log('api-response', 'POST /api/generate-chat-title (auto-name)', res);
    const title = res && res.ok && typeof res.title === 'string' ? res.title.trim() : '';
    if (title) {
      patchChatTitle(chat, title, {
        source: 'auto-name',
        logLabel: 'auto-name (first message):',
      });
      return;
    }
    // Generation failed — allow a retry on the next sent message.
    chat._autoNameRequested = false;
  }).catch((err) => {
    appLogger.log('api-error', 'POST /api/generate-chat-title (auto-name)', String(err));
    debugAutoTitle('auto-name error', { chatId: chat.id, err: String(err) });
    chat._autoNameRequested = false;
  });
}

/** Appends output to the chat buffer (max CHAT_BUFFER_MAX) and persists it to localStorage (throttled to 5s). */
export function appendToChatBuffer(chat, data) {
  if (!chat || !data) return;
  chat._buffer = (chat._buffer || '') + (typeof data === 'string' ? data : String(data));
  if (chat._buffer.length > CHAT_BUFFER_MAX) {
    chat._buffer = chat._buffer.slice(-CHAT_BUFFER_MAX);
  }
  persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

/** Agent output filters — each receives (chat, data). More filters can be added. */
export const outputFilters = [filterOutputAutoTitle, filterOutputPassiveTitle];

/** Run agent output through filters (e.g. catching JSON with the chat name). */
export function applyOutputFilters(chat, data, opts = {}) {
  debugAutoTitle('output', { chatId: chat.id, dataType: typeof data, dataLen: data?.length, preview: previewStr(data, 100) });
  for (const fn of outputFilters) {
    fn(chat, data, opts);
  }
}

/**
 * Single entry for agent output: buffer, filters, state (generating/idle), awaiting.
 * After the call the caller does term.write(data) and scrollChatTerminalToBottom (and catch-up).
 * @param {object} chat
 * @param {string} data
 * @param {{ catchUp?: boolean }} [opts]
 */
export function processAgentOutput(chat, data, opts = {}) {
  appendToChatBuffer(chat, data);
  applyOutputFilters(chat, data, opts);
  onAgentOutput(chat);
  if (!opts.catchUp) {
    chat._lastOutputAt = Date.now();
    scheduleTerminalStateRefresh(chat);
    if (chat._connectionStatus && chat._connectionStatus !== 'connected') {
      chat._connectionStatus = 'connected';
    }
  }
  updateAwaitingInput(chat);
}

/**
 * Full catch-up from the server is the only source of truth for scrollback (do not append to localStorage).
 * Avoids a duplicated _buffer and extra work when skipping catch-up.
 */
export function processAgentOutputCatchUp(chat, data) {
  if (!chat) return;
  const s = typeof data === 'string' ? data : String(data || '');
  chat._buffer = s.length > CHAT_BUFFER_MAX ? s.slice(-CHAT_BUFFER_MAX) : s;
  applyOutputFilters(chat, s, { catchUp: true });
  // Catch-up after a reload is not new output — do not artificially bump the state to "active".
  if (getChatAgentState(chat) !== 'idle') setAgentState(chat, 'idle');
  updateAwaitingInput(chat);
  persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

export function writeCatchUpToTerminal(term, data, onDone) {
  const text = typeof data === 'string' ? data : String(data || '');
  if (!term || !text) {
    if (typeof onDone === 'function') onDone();
    return;
  }
  const chunkSize = 4096;
  if (text.length <= chunkSize) {
    term.write(text, () => {
      if (typeof onDone === 'function') onDone();
    });
    return;
  }
  let offset = 0;
  const writeNext = () => {
    if (offset >= text.length) {
      if (typeof onDone === 'function') onDone();
      return;
    }
    const chunk = text.slice(offset, offset + chunkSize);
    offset += chunkSize;
    term.write(chunk, () => {
      setTimeout(writeNext, 0);
    });
  };
  writeNext();
}
