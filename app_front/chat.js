/**
 * Chat panel: chat list, openTerminal(chat), ensureChatConnection, closeChat, selectChat, newChat, model select, send-keys.
 */
import * as api from './core/api/index.js';
import { applyDefaultNewChatHarnessToModal } from './harnessSettings.js';
import { getChatAgentTransport } from '../lib/agent-transport.js';
import { appLogger } from './logger.js';
import {
  CHAT_RECONNECT_MAX,
  CHAT_RECONNECT_DELAYS,
  WS_PATH_AGENT_SDK,
  AUTO_TITLE_PROMPT,
  CHAT_PING_INTERVAL_MS,
  CHAT_BUFFER_MAX,
  CHAT_HISTORY_INITIAL_TAIL,
  CHAT_HISTORY_OLDER_PAGE,
  CHAT_BUFFER_LOCALSTORAGE_PREFIX,
  CHAT_RESIZE_SEND_DEBOUNCE_MS,
} from './config.js';
import { writeTextToClipboard } from './lib/clipboard.js';
import { setChatStatus } from './connectionStatus.js';
import { createSendBar } from './sendBar.js';
import { initModal } from './lib/modal.js';
import { showChoiceDialog } from './lib/choiceDialog.js';
import { t } from './i18n/index.js';
import { initDropdown } from './lib/dropdown.js';
import { createFavoritesStore } from './lib/favorites.js';
import {
  clearChatBuffer,
  hydrateChatBuffer,
  persistChatBuffer,
  readChatBufferSync,
} from './lib/chatBufferStore.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
} from './lib/storageKeyAlias.js';
import {
  buildCatchUpSignature,
  enqueueCatchUpOutputChunk,
  drainCatchUpOutputChunks,
} from '../lib/catchup-flow.js';
import {
  sendSequenceToTerminalState,
  sendTextWithEnterToTerminalState,
} from './inputDispatch.js';
import { parseTerminalInteraction, resolveTerminalState } from '../lib/status-parser.js';
import {
  hasLiveHarnessWork,
  readHarnessPendingFlags,
  resolveChatListDotState,
  resolveHarnessChatStateMeta,
} from './features/chat/chatStatusMeta.js';
import { normalizeSdkMode } from '../lib/sdk/sdk-mode.js';
import { maybeRecoverMissedSdkRunOutcome } from './features/chat/sdkRunOutcomeRecovery.js';
import { normalizeSdkUiMode } from '../lib/sdk/sdk-ui-mode.js';
import * as chatStore from './features/chat/chatStore.js';
import { createChatTransport } from './features/chat/chatTransport.js';
import { buildHarnessLaunchLabel } from './features/chat/sdk-transport-labels.js';
import {
  handleChatConnectionLost,
  notifyChatBackendReachable,
  initChatServerRecovery,
  dismissStaleReconnectUiOnResume,
} from './features/chat/chatServerRecovery.js';
import { registerPageResumeCleanupHook } from './lib/pageResumeCleanup.js';
import { traceUiFreeze } from './lib/uiFreezeTrace.js';
import {
  armContextCompressionWatchdog,
  disarmContextCompressionWatchdog,
  initChatContextCompressionRecovery,
  recoverChatAfterCompressionFailure,
} from './features/chat/chatContextCompressionRecovery.js';
import {
  formatContextTokenCount,
  isContextAdvisoryEnabled,
  normalizeContextAdvisoryWarnPercent,
} from '../lib/sdk/sdk-context-advisory.js';
import {
  buildSeedSummaryFromSummaries,
  normalizeAutoContextCompressionThresholdPercent,
  shouldTriggerAutoContextCompression,
} from '../lib/context-compression.js';
import { initChatHistorySyncPoll } from './features/chat/chatHistorySyncPoll.js';
import { getResumeHistorySyncDeferMs } from './features/chat/chatResumePolicy.js';
import { isMobileLikeClient } from './lib/mobileClient.js';
import { getLastBackgroundDurationMs } from './lib/pageBackgroundGrace.js';
import {
  allowSdkLiveEventsDuringHydration,
  beginSdkOpenTerminalHydration,
  clearSdkOpenTerminalHydrating,
  isSdkOpenTerminalHydrating,
  takeMissingSdkHistoryRecords,
} from './features/chat/sdkEventReplayGuard.js';
import {
  partitionRecordsByWindowStart,
  rememberHistoryWindowStart,
  sortRecordsByCreatedAt,
} from './features/chat/chatHistoryWindowOrder.js';
import { createSdkRichView } from './lib/sdk-rich-view.js';
import { getChatSpeaker } from './features/voice/chatSpeaker.js';
import { createVoiceReadOptions } from './features/voice/voiceReadControls.js';
import { buildContextSeedPayload } from './lib/context-seed-payload.js';
import {
  appendSdkChatHistoryRecordsSync,
  mirrorSdkChatHistoryToIndexedDb,
  syncChatHistoryDeltaFromServer,
  pullChatHistoryFromServer,
  pullChatHistoryOlderFromServer,
  getOldestLoadedSeq,
  flushPendingPush,
  clearSdkChatHistory,
  readSdkChatHistoryStateAsync,
  replaceSdkChatHistoryRecords,
  sdkHistoryRecordsFromAgentMessageRows,
} from './lib/sdk-chat-history-store.js';
import { createChatView } from './features/chat/chatView.js';
import { createChatController } from './features/chat/chatController.js';
import {
  matchWorkspaceBySpokenName,
  workspaceSpokenLabel,
} from './features/voice/voiceWorkspaceMatch.js';
import { writeLocalStorageSafe } from './features/chat/chatLocalStorage.js';
import {
  SHOW_SEND_FIELD_KEY,
  SHOW_CHAT_DIAG_KEY,
  SDK_VERBOSE_LOGS_KEY,
  normalizeModelValue,
  readLastSelectedModel,
  readLastSelectedHarness,
  saveLastSelectedModel,
  saveLastSelectedHarness,
  getAutoNameChatEnabled,
  setAutoNameChatEnabled,
  getAutoUpdateChatTitleEnabled,
  setAutoUpdateChatTitleEnabled,
  getSkipCatchUpOnResume,
  setSkipCatchUpOnResume,
  getMaintainSessionsEnabled,
  getChatCanvasAddonEnabled,
  setChatCanvasAddonEnabled,
  getReadChatBufferFromLocalStorageEnabled,
  setReadChatBufferFromLocalStorageEnabled,
  isChatDiagEnabled,
  getSdkVerboseLogsEnabled,
} from './features/chat/chatSettingsPrefs.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';
import {
  scheduleChatSendBarReserveSync,
  getChatSendBarResizeObserver,
  setChatSendBarResizeObserver,
} from './features/chat/chatSendBarLayout.js';
import {
  previewStr,
  stripAnsi,
  tryExtractTitleFromBuffer,
  tryExtractStandaloneTitleJson,
  splitTrailingTitleJson,
} from './features/chat/chatTitleParsing.js';
import {
  AUTO_TITLE_RESPONSE_AFTER_MS,
  AUTO_TITLE_TIMEOUT_MS,
  FORK_MIN_TEXT_LEN,
  PASSIVE_TITLE_DEDUP_MS,
  createChatTitleFork,
} from './features/chat/chatTitleFork.js';
import {
  syncWidgetPinUrlUi as renderWidgetPinUrlUi,
  getChatWidgetPinnedUrl,
  notifyWidgetParentPagePinChanged as postWidgetParentPagePinChanged,
} from './features/chat/chatWidgetPin.js';
import { createChatModelSelect } from './features/chat/chatModelSelect.js';
import {
  CHAT_CONTEXT_USAGE_SYNC_MS,
  createChatDiagnostics,
} from './features/chat/chatDiagnostics.js';
import { createChatContextMeter } from './features/chat/chatContextMeter.js';
import {
  hostScreenshotResultToFile,
  isWidgetHostScreenshotAvailable,
  requestWidgetHostScreenshot,
} from './embed/widgetHostScreenshot.js';
import {
  formatHostPagePickContextBlock,
  getHostPagePickLabel,
  isWidgetHostPagePickAvailable,
  requestWidgetHostPagePick,
} from './embed/widgetHostPagePick.js';
import {
  clearPendingWidgetChatSelection,
  consumePendingWidgetChatSelection,
  findChatPinnedToPageUrl,
  isSamePageUrl,
  isWidgetHostNavigationAvailable,
  markPendingWidgetChatSelection,
  navigateWidgetHost,
  requestWidgetHostUrl,
} from './embed/widgetHostNavigation.js';
import { initAgentWakeLock, syncAgentWakeLock } from './features/pwa/wakeLock.js';
import './components/chat/cr-sdk-mode-bar.js';
import './components/chat/cr-chat-diag.js';
const LAST_CHAT_ID_KEY = 'cretli-last-chat-id';

async function captureWidgetHostScreenshotForSendBar() {
  if (!isWidgetHostScreenshotAvailable()) {
    return {
      ok: false,
      error: t('chat.hostPageNotConnected'),
      debug: { reason: 'widget-host-port-missing' },
    };
  }
  const isMobileLike = typeof navigator !== 'undefined'
    && /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
  const attempts = isMobileLike
    ? [
      { mode: 'dom', label: 'dom' },
      { mode: 'display', label: 'display' },
    ]
    : [
      { mode: 'display', label: 'display' },
      { mode: 'dom', label: 'dom' },
    ];
  /** @type {Error | null} */
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await requestWidgetHostScreenshot(attempt.mode);
      const file = await hostScreenshotResultToFile(result);
      return { ok: true, file };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || 'Screenshot failed'));
    }
  }
  return {
    ok: false,
    error: lastError?.message || t('chat.hostPageScreenshotFailed'),
    debug: {
      reason: 'widget-host-screenshot-failed',
      errorMessage: lastError?.message || '',
    },
  };
}

function resolveSendBarHostScreenshotCapture() {
  if (!isWidgetHostScreenshotAvailable()) return null;
  return captureWidgetHostScreenshotForSendBar;
}

function resolveSendBarHostPagePick() {
  if (!isWidgetHostPagePickAvailable()) return null;
  return requestWidgetHostPagePick;
}
const chatFavorites = createFavoritesStore('cretli-favorites-chats');
const CHAT_NAV_SEQUENCES = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

function getChatLastUsedAt(chatId) {
  return chatStore.getChatLastUsedAt(chatId);
}

function recordChatLastUsed(chatId) {
  chatStore.recordChatLastUsed(chatId);
}

function getChatActivityAt(chat) {
  return chatStore.getChatActivityAt(chat, getChatLastUsedAt);
}

function recordChatActivity(chatId) {
  chatStore.recordChatActivity(chatId);
}

function getResizeColsRows(cols, rows) {
  return chatStore.getResizeColsRows(cols, rows);
}

/** Modal APIs (chat settings, new chat) from lib/modal.js */
let chatSettingsModalApi;
let chatSettingsVoiceRead;
let chatNewModalApi;
let chatDeleteConfirmModalApi;
let chatContextDetailsModalApi;
let pendingDeleteChatId = null;
let chatNewModelDropdownApi = null;
let chatNewFolderDropdownApi = null;

/**
 * Clear all local data tied to a chat (localStorage).
 * Single place for every key — content buffer, etc.
 * @param {string} id - chat id (uuid)
 */
function clearChatLocalData(id) {
  clearChatBuffer(id, CHAT_BUFFER_LOCALSTORAGE_PREFIX);
  chatStore.clearChatLocalData(id);
  void clearSdkChatHistory(id).catch(() => {});
}

function readChatDraft(id) {
  return chatStore.readChatDraft(id);
}

function writeChatDraft(id, value) {
  chatStore.writeChatDraft(id, value);
}

function getSkipChatDeleteConfirm() {
  return chatStore.getSkipChatDeleteConfirm();
}

function setSkipChatDeleteConfirm(value) {
  chatStore.setSkipChatDeleteConfirm(value);
}

/** Delay (ms) before sending Enter after text — shared by the Send field and the title request. */
const SEND_ENTER_DELAY_MS = 80;
/** Short margin after xterm focus before sending a bare Enter. */
const ENTER_FOCUS_DELAY_MS = 35;
const CHAT_TITLES_SYNC_INTERVAL_MS = 15000;

function isDebugAutoTitle() {
  if (typeof window === 'undefined') return false;
  const q = typeof window.location !== 'undefined' && window.location.search || '';
  if (/\b(debug|cretli-debug=1)\b/.test(q)) return true;
  try {
    return readStorageValueWithAlias(localStorage, 'cretli-debug-auto-title', '') === '1';
  } catch (_) {
    return false;
  }
}

const AUTO_TITLE_PANEL_TAGS = ['patch', 'patchChat response', 'patchChat error', 'extract regex ok', 'extract line JSON ok', 'timeout', 'request'];

function debugAutoTitle(...args) {
  if (isDebugAutoTitle()) {
    console.log('[auto-title]', ...args);
    if (args[0] && AUTO_TITLE_PANEL_TAGS.includes(args[0])) {
      appLogger.log('auto-title', ...args);
    }
  }
}

/** Enable fork logs (title / summary): URL ?debug-fork or localStorage 'cretli-debug-fork' = '1'. */
function isDebugFork() {
  if (typeof window === 'undefined') return false;
  const q = typeof window.location !== 'undefined' && window.location.search || '';
  if (/\bdebug-fork\b/.test(q)) return true;
  try {
    return readStorageValueWithAlias(localStorage, 'cretli-debug-fork', '') === '1';
  } catch (_) {
    return false;
  }
}
function debugFork(tag, ...args) {
  if (isDebugFork()) {
    console.log('[fork-' + tag + ']', ...args);
    appLogger.log('fork-' + tag, ...args);
  }
}

/** Enable chat status logs (state change + parsing tail): ?debug-status or localStorage 'cretli-debug-status' = '1'. */
function isDebugStatus() {
  if (typeof window === 'undefined') return false;
  const q = typeof window.location !== 'undefined' && window.location.search || '';
  if (/\bdebug-status\b/.test(q)) return true;
  try {
    return readStorageValueWithAlias(localStorage, 'cretli-debug-status', '') === '1';
  } catch (_) {
    return false;
  }
}

if (typeof window !== 'undefined') {
  console.log(
    '[cretli] Chat loaded. Logs: auto-title ?debug | fork ?debug-fork | status ?debug-status'
  );
}

export {
  getAutoNameChatEnabled,
  setAutoNameChatEnabled,
  getAutoUpdateChatTitleEnabled,
  setAutoUpdateChatTitleEnabled,
  getSkipCatchUpOnResume,
  setSkipCatchUpOnResume,
  getMaintainSessionsEnabled,
  setMaintainSessionsEnabled,
  getConnectAllChatsOnStartEnabled,
  setConnectAllChatsOnStartEnabled,
  getChatCanvasAddonEnabled,
  setChatCanvasAddonEnabled,
  getReadChatBufferFromLocalStorageEnabled,
  setReadChatBufferFromLocalStorageEnabled,
} from './features/chat/chatSettingsPrefs.js';
export { escapeHtml } from './features/chat/chatHtmlUtils.js';

/** Reads the buffer from localStorage ignoring the checkbox (e.g. SDK mode, which has no server catch-up). */
function readChatBufferRawFromLocalStorage(chatId) {
  return readChatBufferSync(chatId, CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

function readChatBufferFromLocalStorage(chatId) {
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
function patchChatTitle(chat, title, opts = {}) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  if (!chat || !normalized) return false;
  if ((chat.title || '').trim() === normalized) return false;
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
    if (modal && !modal.hidden && chat.id === activeChatId && titleInput) {
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

function filterOutputAutoTitle(chat, data) {
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
function filterOutputPassiveTitle(chat, data, opts = {}) {
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

/** Appends output to the chat buffer (max CHAT_BUFFER_MAX) and persists it to localStorage (throttled to 5s). */
function appendToChatBuffer(chat, data) {
  if (!chat || !data) return;
  chat._buffer = (chat._buffer || '') + (typeof data === 'string' ? data : String(data));
  if (chat._buffer.length > CHAT_BUFFER_MAX) {
    chat._buffer = chat._buffer.slice(-CHAT_BUFFER_MAX);
  }
  persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

/** Agent output filters — each receives (chat, data). More filters can be added. */
const outputFilters = [filterOutputAutoTitle, filterOutputPassiveTitle];

/** Run agent output through filters (e.g. catching JSON with the chat name). */
function applyOutputFilters(chat, data, opts = {}) {
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
function processAgentOutput(chat, data, opts = {}) {
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
function processAgentOutputCatchUp(chat, data) {
  if (!chat) return;
  const s = typeof data === 'string' ? data : String(data || '');
  chat._buffer = s.length > CHAT_BUFFER_MAX ? s.slice(-CHAT_BUFFER_MAX) : s;
  applyOutputFilters(chat, s, { catchUp: true });
  // Catch-up after a reload is not new output — do not artificially bump the state to "active".
  if (getChatAgentState(chat) !== 'idle') setAgentState(chat, 'idle');
  updateAwaitingInput(chat);
  persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

function writeCatchUpToTerminal(term, data, onDone) {
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

function startGlobalChatPingLoop() {
  chatTransport.startGlobalChatPingLoop();
}

function startChatBackgroundMonitor() {
  chatTransport.startChatBackgroundMonitor();
}

function bindChatVisibilityAndReconnect() {
  chatTransport.bindChatVisibilityAndReconnect();
}

function syncBackgroundChatConnections() {
  chatTransport.syncBackgroundChatConnections();
}

/**
 * One WebSocket per chat: always collect output; write to the terminal only when chat.term exists.
 */
function requestWidgetChatBinding(chat) {
  if (typeof window === 'undefined') return;
  if (!chat?.cursorSessionId) return;
  window.dispatchEvent(new CustomEvent('cr-widget-bind-chat-request', {
    detail: { chatSessionKey: chat.cursorSessionId },
  }));
}

function syncWidgetPinUrlUi(chat = null) {
  renderWidgetPinUrlUi(isEmbedWidgetMode(), isWidgetHostNavigationAvailable, chat);
}

function notifyWidgetParentPagePinChanged() {
  postWidgetParentPagePinChanged(isEmbedWidgetMode());
}

async function createEmbedChatRecordOnly() {
  if (embedChatCreationPromise) return embedChatCreationPromise;
  const context = getWorkspaceContextForChat();
  if (!context?.workspaceFile || !context?.workspaceFolder) return null;
  const transport = normalizeNewChatHarness(selectedHarness || 'sdk');

  embedChatCreationPromise = api.postChat({
    workspaceFile: context.workspaceFile,
    workspaceFolder: context.workspaceFolder,
    model: window.__crEmbedModel || 'auto',
    agentTransport: transport,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  }).then((data) => {
    if (!data?.ok || !data.chat) return null;
    const chat = data.chat;
    chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || transport);
    chat.sdkMode = normalizeSdkMode(chat.sdkMode);
    chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
    chats.push(chat);
    renderChatList();
    openTerminal(chat);
    return chat;
  }).finally(() => {
    embedChatCreationPromise = null;
  });
  return embedChatCreationPromise;
}

/**
 * When the user picks a chat pinned to a URL other than the current host page,
 * navigate the host page to the pinned URL and select that chat after reload.
 * @param {string} requestedId
 * @returns {Promise<string|null>}
 */
async function resolveChatSelectionForCurrentHostPage(requestedId) {
  const requestedChat = chats.find((c) => c.id === requestedId);
  if (!requestedChat) return null;

  const pinnedUrl = getChatWidgetPinnedUrl(requestedChat);
  if (!pinnedUrl) return requestedId;

  let currentUrl = '';
  try {
    const current = await requestWidgetHostUrl();
    currentUrl = typeof current?.url === 'string' ? current.url.trim() : '';
  } catch {
    return requestedId;
  }

  if (!currentUrl || isSamePageUrl(pinnedUrl, currentUrl)) {
    return requestedId;
  }

  markPendingWidgetChatSelection(requestedId);
  try {
    const result = await navigateWidgetHost(pinnedUrl);
    if (result?.skipped) {
      clearPendingWidgetChatSelection();
      return requestedId;
    }
    return null;
  } catch (error) {
    clearPendingWidgetChatSelection();
    throw error;
  }
}

let pinnedChatSelectionGuard = false;

async function toggleWidgetUrlPin(chat, hintEl = null) {
  if (!chat) {
    setTransientChatActionHint(hintEl, t('chat.noActiveChat'));
    return;
  }
  if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) {
    setTransientChatActionHint(hintEl, t('chat.pinUrlWidgetOnly'));
    return;
  }

  const currentPinnedUrl = typeof chat.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
  const nextPinnedUrl = currentPinnedUrl ? null : (await requestWidgetHostUrl()).url;
  if (!currentPinnedUrl && !nextPinnedUrl) {
    setTransientChatActionHint(hintEl, t('chat.pinUrlHostUrlFailed'));
    return;
  }

  appLogger.log('api-request', `PATCH /api/chats/${chat.id} (widgetPinnedUrl)`, {
    widgetPinnedUrl: nextPinnedUrl,
  });
  try {
    const data = await api.patchChat(chat.id, { widgetPinnedUrl: nextPinnedUrl });
    appLogger.log('api-response', `PATCH /api/chats/${chat.id} (widgetPinnedUrl)`, data);
    if (!data?.ok || !data.chat) {
      const err = typeof data?.error === 'string' && data.error.trim()
        ? data.error.trim()
        : t('chat.pinUrlSaveFailed');
      setTransientChatActionHint(hintEl, err);
      return;
    }
    Object.assign(chat, data.chat);
    if (nextPinnedUrl) {
      chats.forEach((item) => {
        if (item.id === chat.id) return;
        const pinnedUrl = getChatWidgetPinnedUrl(item);
        if (pinnedUrl && isSamePageUrl(pinnedUrl, nextPinnedUrl)) {
          delete item.widgetPinnedUrl;
        }
      });
    }
    syncWidgetPinUrlUi(chat);
    notifySidebar();
    renderChatList();
    notifyWidgetParentPagePinChanged();
    if (nextPinnedUrl) {
      setTransientChatActionHint(hintEl, t('chat.pinUrlPinned', { url: nextPinnedUrl }));
      return;
    }
    setTransientChatActionHint(hintEl, t('chat.pinUrlUnpinned'));
  } catch (error) {
    appLogger.log('api-error', `PATCH /api/chats/${chat.id} (widgetPinnedUrl)`, String(error));
    setTransientChatActionHint(hintEl, t('chat.pinUrlSaveFailed'));
  }
}

/**
 * Resolves the chat pinned to a host page URL (widget embed).
 * @param {string} pageUrl
 * @returns {Promise<{ id: string, title: string } | null>}
 */
export async function resolvePagePinStateForUrl(pageUrl) {
  const url = String(pageUrl || '').trim();
  if (!url) return null;
  const data = await api.getChats({ pinnedTo: url });
  if (data?.linkedChat?.id) {
    const title = typeof data.linkedChat.title === 'string' ? data.linkedChat.title.trim() : '';
    return { id: data.linkedChat.id, title };
  }
  await loadChatsFromServer();
  const linked = findChatPinnedToPageUrl(getChatsList(), url);
  if (!linked?.id) return null;
  const title = typeof linked.title === 'string' ? linked.title.trim() : '';
  return { id: linked.id, title };
}

/**
 * Creates a new chat pinned to the host page URL, or selects an existing one.
 * @param {{ pageUrl?: string, pageTitle?: string }} params
 * @returns {Promise<{ ok: boolean, chat?: object, reused?: boolean, error?: string }>}
 */
export async function createPageLinkedChat(params = {}) {
  const pageUrl = String(params.pageUrl || '').trim();
  if (!pageUrl) {
    appLogger.log('widget-plus', 'createPageLinkedChat: missing pageUrl');
    return { ok: false, error: t('chat.missingPageUrl') };
  }
  const pageTitle = String(params.pageTitle || '').trim() || t('chat.pageChatTitle');
  const harness = normalizeNewChatHarness(params.harness || selectedHarness || 'sdk');
  const forceNew = params.forceNew === true;
  const workspaceFile = String(params.workspaceFile || '').trim();
  const workspaceFolder = String(params.workspaceFolder || '').trim();
  const rawModel = typeof params.model === 'string' ? params.model.trim() : '';
  const model = rawModel ? normalizeModelValue(rawModel) : '';
  const sdkMode = String(params.sdkMode || '').trim();
  const sdkUiMode = String(params.sdkUiMode || '').trim();
  appLogger.log('widget-plus', 'createPageLinkedChat start', { pageUrl, pageTitle });
  pinnedChatSelectionGuard = true;
  try {
    await waitForEmbedBootReady();
    appLogger.log('widget-plus', 'embed boot ready');
    const lookup = forceNew ? null : await api.getChats({ pinnedTo: pageUrl });
    const existing = lookup?.linkedChat?.id
      ? lookup.linkedChat
      : findChatPinnedToPageUrl(getChatsList(), pageUrl);
    if (!forceNew && existing?.id) {
      appLogger.log('widget-plus', 'reusing existing pinned chat', {
        chatId: existing.id.slice(0, 8),
        pinnedUrl: getChatWidgetPinnedUrl(existing) || pageUrl,
      });
      await loadChatsFromServer({ pinnedTo: pageUrl, skipAutoSelect: true });
      performSelectChat(existing.id);
      notifyWidgetParentPagePinChanged();
      return { ok: true, chat: existing, reused: true };
    }
    appLogger.log('widget-plus', 'POST /api/chats', {
      title: pageTitle,
      widgetPinnedUrl: pageUrl,
      agentTransport: harness,
      forceNewPinnedChat: forceNew,
    });
    const payload = {
      title: pageTitle,
      widgetPinnedUrl: pageUrl,
      agentTransport: harness,
      forceNewPinnedChat: forceNew,
      ...(workspaceFile ? { workspaceFile } : {}),
      ...(workspaceFolder ? { workspaceFolder } : {}),
      ...(model ? { model } : {}),
      ...(sdkMode ? { sdkMode } : {}),
      ...(sdkUiMode ? { sdkUiMode } : {}),
    };
    const data = await api.postChat(payload);
    appLogger.log('widget-plus', 'POST /api/chats response', {
      ok: data?.ok === true,
      chatId: data?.chat?.id ? String(data.chat.id).slice(0, 8) : null,
      widgetPinnedUrl: data?.chat?.widgetPinnedUrl || null,
      error: data?.error || null,
    });
    if (!data?.ok || !data.chat?.id) {
      return { ok: false, error: data?.error || t('chat.createChatFailed') };
    }
    await loadChatsFromServer({ pinnedTo: pageUrl, skipAutoSelect: true });
    const createdChat = getChatsList().find((entry) => entry.id === data.chat.id) || data.chat;
    performSelectChat(data.chat.id);
    syncWidgetPinUrlUi(createdChat);
    notifySidebar();
    renderChatList();
    notifyWidgetParentPagePinChanged();
    appLogger.log('widget-plus', 'created and selected', {
      chatId: data.chat.id.slice(0, 8),
      pinnedUrl: getChatWidgetPinnedUrl(createdChat) || pageUrl,
      hasPane: !!createdChat?.pane,
    });
    return { ok: true, chat: data.chat, reused: false };
  } catch (error) {
    appLogger.log('widget-plus', 'createPageLinkedChat error', String(error));
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    pinnedChatSelectionGuard = false;
  }
}

function ensureChatConnection(chat) {
  requestWidgetChatBinding(chat);
  chatTransport.ensureChatConnection(chat);
}

/** SDK event types present in the API snapshot (agentConversationTurn). */
const STANDARD_SDK_EVENT_TYPES = new Set([
  'system',
  'user',
  'assistant',
  'thinking',
  'tool_call',
  'status',
  'task',
  'request',
]);

/**
 * @param {unknown} rec
 * @returns {'standard' | 'raw' | null} timeline record type (for merge order)
 */
function sdkTimelineRecordKind(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind === 'localUser') return 'standard';
  if (r.kind !== 'sdk' || !r.event || typeof r.event !== 'object') return null;
  const ev = /** @type {Record<string, unknown>} */ (r.event);
  const t = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
  return t && STANDARD_SDK_EVENT_TYPES.has(t) ? 'standard' : 'raw';
}

/**
 * Merges the authoritative standard records from the API with raw SDK events from the local
 * store (e.g. `usage` that the API does not return), keeping their place on the timeline.
 *
 * Raw event position is derived from the number of preceding standard events
 * in the local log (written chronologically).
 *
 * @param {Array<Record<string, unknown>>} apiRecords
 * @param {{ cursorSessionId?: string, events?: unknown[] } | null} localState
 * @param {string} sessionKey
 * @returns {Array<Record<string, unknown>>}
 */
function mergeSdkHistoryWithRawEvents(apiRecords, localState, sessionKey) {
  const base = Array.isArray(apiRecords) ? apiRecords : [];
  if (!localState || !Array.isArray(localState.events)) return base;
  if (sessionKey && localState.cursorSessionId && localState.cursorSessionId !== sessionKey) {
    return base;
  }

  /** @type {Array<{ pos: number, rec: Record<string, unknown> }>} */
  const raw = [];
  let standardCount = 0;
  for (const rec of localState.events) {
    const kind = sdkTimelineRecordKind(rec);
    if (kind === 'raw') {
      raw.push({ pos: standardCount, rec: /** @type {Record<string, unknown>} */ (rec) });
    } else if (kind === 'standard') {
      standardCount += 1;
    }
  }
  if (raw.length === 0) return base;

  // Drift diagnostics: if the API standard-event count diverges a lot from local,
  // positioning raw events by the local counter can scramble order (a possible cause of
  // garbled thinking/assistant). Log a warning — do not abort (KISS).
  if (typeof console !== 'undefined' && console.warn) {
    const apiStdCount = base.length;
    const drift = Math.abs(apiStdCount - standardCount);
    if (drift > 2) {
      console.warn(
        `[chat] mergeSdkHistoryWithRawEvents: standard counter drift (api=${apiStdCount}, local=${standardCount}, raw=${raw.length}) — raw event order may be approximate`
      );
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  let ri = 0;
  let stdSeen = 0;
  for (const rec of base) {
    while (ri < raw.length && raw[ri].pos <= stdSeen) {
      out.push(raw[ri].rec);
      ri += 1;
    }
    out.push(rec);
    stdSeen += 1;
  }
  while (ri < raw.length) {
    out.push(raw[ri].rec);
    ri += 1;
  }
  return out;
}

/**
 * @param {unknown} rec
 * @returns {'assistant' | 'thinking' | null}
 */
function sdkHistoryStreamKindForQueue(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind !== 'sdk' || !r.event || typeof r.event !== 'object') return null;
  const ev = /** @type {Record<string, unknown>} */ (r.event);
  const t = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
  if (t === 'assistant' || t === 'thinking') return t;
  return null;
}

/**
 * Queue for SDK structured history writes (localStorage) so we do not write on every assistant token.
 *
 * @param {object} chat
 * @param {unknown} rec
 */
function enqueueSdkStructuredHistoryRecord(chat, rec) {
  if (!chat?.id) return;
  if (!rec || typeof rec !== 'object') return;
  if (!chat.cursorSessionId) return;
  if (!Array.isArray(chat._sdkHistoryPending)) chat._sdkHistoryPending = [];

  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind === 'localUser' && typeof r.text === 'string') {
    const text = r.text.trim();
    if (chat._sdkHistoryPending.some((entry) => entry?.kind === 'localUser' && entry?.text === text)) {
      return;
    }
  }
  if (r.kind === 'meta' && r.variant === 'queued' && typeof r.payload === 'string') {
    const payload = r.payload.trim();
    if (
      chat._sdkHistoryPending.some(
        (entry) => entry?.kind === 'meta' && entry?.variant === 'queued' && entry?.payload === payload,
      )
    ) {
      return;
    }
  }

  const streamKind = sdkHistoryStreamKindForQueue(rec);
  if (streamKind) {
    const pend = chat._sdkHistoryPending;
    const prevKind = sdkHistoryStreamKindForQueue(pend[pend.length - 1]);
    if (prevKind === streamKind) {
      const previous = pend[pend.length - 1];
      pend[pend.length - 1] = {
        ...rec,
        createdAt:
          typeof previous?.createdAt === 'string' ? previous.createdAt : rec.createdAt,
      };
    } else {
      pend.push(rec);
    }
  } else {
    chat._sdkHistoryPending.push(rec);
  }

  if (chat._sdkHistoryFlushTimer) return;
  chat._sdkHistoryFlushTimer = setTimeout(() => {
    chat._sdkHistoryFlushTimer = null;
    const batch = chat._sdkHistoryPending || [];
    chat._sdkHistoryPending = [];
    if (batch.length === 0) return;
    // The server-side tap (cursor-agent-sdk-ws.js) is the authoritative writer of SDK history.
    // The client only keeps a local mirror (IDB) for fast offline reloads and never pushes to the server.
    appendSdkChatHistoryRecordsSync(chat.id, chat.cursorSessionId || '', batch);
    void mirrorSdkChatHistoryToIndexedDb(chat.id).catch(() => {});
  }, 320);
}

/**
 * Flushes the queue without debounce — e.g. on tab hide, pagehide or beforeunload.
 * @param {object} chat
 */
function flushSdkStructuredHistoryNow(chat) {
  if (!chat?.id) return;
  if (!chat.cursorSessionId) return;
  if (chat._sdkHistoryFlushTimer) {
    clearTimeout(chat._sdkHistoryFlushTimer);
    chat._sdkHistoryFlushTimer = null;
  }
  const batch = chat._sdkHistoryPending || [];
  chat._sdkHistoryPending = [];
  if (batch.length === 0) return;
  appendSdkChatHistoryRecordsSync(chat.id, chat.cursorSessionId || '', batch);
  void mirrorSdkChatHistoryToIndexedDb(chat.id).catch(() => {});
}

function appendSdkUserPromptLine(chat, userText) {
  const raw = userText == null ? '' : String(userText);
  // A new prompt makes the previous answer stale — stop reading it mid-sentence.
  getChatSpeaker().resetAnswer();
  chat._sdkLastLocalUserEcho = raw;
  const line = `\n> ${raw}\n`;
  processAgentOutput(chat, line);
  if (chat._sdkRichView) {
    chat._sdkRichView.appendUserPrompt(raw);
  }
}

/**
 * @param {object} chat
 */
function ensureSdkOptimisticPromptState(chat) {
  if (!Array.isArray(chat?._sdkOptimisticSentNow)) {
    chat._sdkOptimisticSentNow = [];
  }
  if (!Array.isArray(chat?._sdkOptimisticSentQueued)) {
    chat._sdkOptimisticSentQueued = [];
  }
}

/**
 * Immediate echo after clicking Send so UX feels instant.
 * When the agent is busy, show the queued variant immediately.
 *
 * @param {object} chat
 * @param {string} userText
 */
function appendOptimisticSdkPrompt(chat, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!chat || !raw) return;
  allowSdkLiveEventsDuringHydration(chat);
  ensureSdkOptimisticPromptState(chat);
  const shouldQueue =
    chat._agentState === 'active' ||
    chat._sdkServerBusy === true ||
    (chat._sdkRichView?.queuedCount || 0) > 0;
  if (shouldQueue) {
    const nextPos = (chat._sdkRichView?.queuedCount || 0) + 1;
    chat._sdkOptimisticSentQueued.push(raw);
    appendSdkQueuedPromptLine(chat, raw, nextPos);
    return;
  }
  chat._sdkOptimisticSentNow.push(raw);
  appendSdkUserPromptLine(chat, raw);
}

/**
 * @param {object} chat
 * @param {string} userText
 * @returns {boolean}
 */
function consumeOptimisticSdkPrompt(chat, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!raw) return false;
  ensureSdkOptimisticPromptState(chat);
  const idx = chat._sdkOptimisticSentNow.indexOf(raw);
  if (idx === -1) return false;
  chat._sdkOptimisticSentNow.splice(idx, 1);
  return true;
}

/**
 * @param {object} chat
 * @param {string} userText
 * @returns {boolean}
 */
function consumeOptimisticSdkQueuedPrompt(chat, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  ensureSdkOptimisticPromptState(chat);
  const idx = chat._sdkOptimisticSentQueued.indexOf(raw);
  if (idx === -1) return false;
  chat._sdkOptimisticSentQueued.splice(idx, 1);
  return true;
}

function appendSdkQueuedPromptLine(chat, userText, position) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!raw) return;
  if (chat._sdkRichView?.hasQueuedOrSentUserText?.(raw)) return;
  const pos = Math.max(1, Number(position) || 1);
  const line = `\n> [kolejka #${pos}] ${raw}\n`;
  processAgentOutput(chat, line);
  if (chat._sdkRichView) {
    chat._sdkRichView.appendQueuedPrompt(raw, pos);
  }
}

function promoteSdkQueuedPromptLine(chat, userText) {
  const raw = userText == null ? '' : String(userText);
  if (chat._sdkRichView) {
    chat._sdkRichView.promoteQueuedPrompt(raw);
    return;
  }
  appendSdkUserPromptLine(chat, raw);
}

function removeSdkQueuedPromptLine(chat, userText) {
  const raw = userText == null ? '' : String(userText);
  if (!chat?._sdkRichView) return;
  chat._sdkRichView.removeQueuedPrompt(raw);
}

function sendQueueControl(chat, type, text) {
  if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type, text: String(text || '') }));
}

function sendOpenCodeQuestionReply(chat, payload) {
  if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'opencodeQuestionReply', ...(payload || {}) }));
}

function sendOpenCodePermissionReply(chat, payload) {
  if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'opencodePermissionReply', ...(payload || {}) }));
}

let sharedSdkModeBar = null;
let switchHarnessInFlight = false;
/** @type {{ chatId: string, harness: string } | null} */
let pendingWidgetHarnessSwitch = null;

function normalizeHarnessActionChoice(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'd' || raw === 'delete' || raw === 'remove') return 'delete';
  if (raw === 'k' || raw === 'keep' || raw === 'skip') return 'keep';
  return 'archive';
}

function resolvePendingHarnessSwitch(bar, chat) {
  const fromBar = String(bar?.pendingHarness || '').trim();
  const fromState = pendingWidgetHarnessSwitch?.chatId === chat?.id
    ? String(pendingWidgetHarnessSwitch.harness || '').trim()
    : '';
  const pending = fromBar || fromState;
  if (!pending) return '';
  const nextHarness = normalizeNewChatHarness(pending);
  const currentHarness = normalizeNewChatHarness(chat?.agentTransport || 'sdk');
  if (nextHarness === currentHarness) return '';
  return nextHarness;
}

function isPendingHarnessSwitch(bar, chat) {
  return resolvePendingHarnessSwitch(bar, chat) !== '';
}

async function refreshSdkModeBarCombinedPicker(options = {}) {
  const bar = document.querySelector('cr-sdk-mode-bar');
  if (!bar) return;
  await bar.updateComplete;
  const picker = bar.shadowRoot?.querySelector('.combined-picker');
  picker?.refreshOptions?.();
  if (options.reopenDropdown === true) {
    picker?.openDropdown?.();
  }
}

function resolveOpenCodeCatalogParamCandidates(chat = null) {
  const activeChat = chat || (activeChatId ? chats.find((c) => c.id === activeChatId) : null);
  const ctx = getWorkspaceContextForChat();
  const seen = new Set();
  /** @type {Array<{ workspaceFolder?: string }>} */
  const candidates = [];
  const pushFolder = (folder) => {
    const trimmed = String(folder || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ workspaceFolder: trimmed });
  };
  pushFolder(serverSettingsWorkspaceFolder);
  // Server default folder before embed/chat folders — OpenCode runs per folder and the
  // widget embed folder may not have a warm instance while the server workspace does.
  candidates.push({});
  pushFolder(activeChat?.workspaceFolder);
  pushFolder(ctx?.workspaceFolder);
  pushFolder(selectedWorkspaceFolder);
  return candidates;
}

function syncPendingHarnessBarModels(bar, harness) {
  if (!bar) return;
  const nextHarness = normalizeNewChatHarness(harness);
  chatModelSelectApi.setModelPickerHarness(nextHarness);
  bar.models = chatModelSelectApi.getSdkModeBarModelOptions();
}

async function fetchOpenCodeModelsCatalog(chat = null) {
  const candidates = resolveOpenCodeCatalogParamCandidates(chat);
  let lastOk = null;
  let lastResult = null;
  for (const params of candidates) {
    try {
      const data = await api.getOpenCodeModels(params);
      lastResult = data;
      if (!data?.ok) continue;
      lastOk = data;
      if (Array.isArray(data.models) && data.models.length > 0) return data;
    } catch (err) {
      lastResult = { ok: false, error: err?.message || 'fetch failed' };
    }
  }
  return lastOk || lastResult;
}

function loadModelsForPendingHarness(bar, harness, resetModel = true) {
  const nextHarness = normalizeNewChatHarness(harness);
  bar.pendingHarness = nextHarness;
  bar.pickerStep = 'model';
  if (resetModel) bar.model = '';
  syncPendingHarnessBarModels(bar, nextHarness);
  if (bar.models.length === 0) {
    void refreshPendingHarnessModelCatalog(nextHarness);
  }
}

function refreshPendingHarnessModelCatalog(harness) {
  const nextHarness = normalizeNewChatHarness(harness);
  if (nextHarness === 'opencode') {
    if (pendingOpenCodeCatalogFetch) return pendingOpenCodeCatalogFetch;
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    pendingOpenCodeCatalogFetch = reloadOpenCodeModelsCatalog(chat).finally(() => {
      pendingOpenCodeCatalogFetch = null;
    });
    return pendingOpenCodeCatalogFetch;
  }
  if (nextHarness === 'openrouter') {
    return api.getOpenRouterModels().then((data) => {
      if (data?.ok) chatModelSelectApi.applyAvailableModelsFromOpenRouter(data);
      chatModelSelectApi.refreshModelSelectLabels();
    }).catch(() => {});
  }
  return refreshModelCatalogFromServer();
}

function rememberPendingHarnessSwitch(chat, harness) {
  const nextHarness = normalizeNewChatHarness(harness);
  pendingWidgetHarnessSwitch = chat?.id
    ? { chatId: chat.id, harness: nextHarness }
    : null;
}

function beginPendingHarnessSwitch(chat, harness) {
  rememberPendingHarnessSwitch(chat, harness);
  const bar = chat?.sdkModeBarEl || sharedSdkModeBar;
  if (bar) loadModelsForPendingHarness(bar, harness, true);
}

function clearPendingHarnessSwitch(chat) {
  pendingWidgetHarnessSwitch = null;
  const bar = chat?.sdkModeBarEl || sharedSdkModeBar;
  if (bar) {
    bar.pendingHarness = '';
    bar.pickerStep = 'harness';
  }
  if (chat) syncChatSdkModeUi(chat);
}

function getOldChatDispositionOptions() {
  return [
    {
      value: 'archive',
      label: t('chat.harnessSwitchOldChatArchive'),
      hint: t('chat.harnessSwitchOldChatArchiveHint'),
      variant: 'primary',
    },
    {
      value: 'delete',
      label: t('chat.harnessSwitchOldChatDelete'),
      hint: t('chat.harnessSwitchOldChatDeleteHint'),
      variant: 'danger',
    },
    {
      value: 'keep',
      label: t('chat.harnessSwitchOldChatKeep'),
      hint: t('chat.harnessSwitchOldChatKeepHint'),
    },
  ];
}

async function promptOldChatDispositionChoice() {
  await new Promise((resolve) => {
    window.setTimeout(resolve, 250);
  });
  const answer = await showChoiceDialog({
    heading: t('chat.harnessSwitchOldChatTitle'),
    body: t('chat.harnessSwitchOldChatBody'),
    cancelLabel: t('chat.cancel'),
    options: getOldChatDispositionOptions(),
  });
  if (answer == null) return null;
  return normalizeHarnessActionChoice(answer);
}

async function applyOldChatDisposition(oldChat, newChatId, action) {
  if (!oldChat?.id) return 'keep';
  if (action === 'delete') {
    let data = null;
    try {
      data = await api.deleteChat(oldChat.id);
    } catch {
      data = null;
    }
    if (!data?.ok) {
      window.alert(data?.error || t('chat.harnessSwitchDeleteFailed'));
      closeChat(oldChat.id, { skipApiDelete: false, switchToChatId: newChatId });
      return 'delete';
    }
    removedChatIds.add(oldChat.id);
    closeChat(oldChat.id, { skipApiDelete: true, switchToChatId: newChatId });
    return 'delete';
  }
  if (action === 'archive') {
    await requestArchiveChat(oldChat.id, { switchToChatId: newChatId });
    return 'archive';
  }
  try {
    const data = await api.patchChat(oldChat.id, { widgetPinnedUrl: null });
    if (data?.ok && data.chat) {
      Object.assign(oldChat, data.chat);
      renderChatList();
    }
  } catch {}
  return 'keep';
}

async function switchChatHarnessInWidget(chat, harness, model) {
  if (!chat?.id || switchHarnessInFlight) return;
  const bar = chat.sdkModeBarEl || sharedSdkModeBar;
  const requestedHarness = String(harness || '').trim();
  const nextHarness = requestedHarness
    ? normalizeNewChatHarness(requestedHarness)
    : resolvePendingHarnessSwitch(bar, chat);
  const currentHarness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (!nextHarness || nextHarness === currentHarness) {
    if (model) void setChatModel(chat, model);
    clearPendingHarnessSwitch(chat);
    return;
  }
  rememberPendingHarnessSwitch(chat, nextHarness);
  const nextModel = normalizeModelValue(model || selectedModel || 'auto');
  switchHarnessInFlight = true;
  try {
    const disposition = await promptOldChatDispositionChoice();
    if (disposition == null) {
      clearPendingHarnessSwitch(chat);
      return;
    }
    if (!isEmbedWidgetMode()) {
      window.alert(t('chat.harnessSwitchWidgetOnly'));
      clearPendingHarnessSwitch(chat);
      return;
    }
    const host = await requestWidgetHostUrl().catch(() => ({ url: '' }));
    const hostPageUrl = typeof host?.url === 'string' ? host.url.trim() : '';
    const pageUrl = hostPageUrl || getChatWidgetPinnedUrl(chat) || '';
    if (!pageUrl) {
      window.alert(t('chat.harnessSwitchMissingPageUrl'));
      clearPendingHarnessSwitch(chat);
      return;
    }
    const oldChatId = chat.id;
    const result = await createPageLinkedChat({
      pageUrl,
      pageTitle: chat.title,
      harness: nextHarness,
      forceNew: true,
      workspaceFile: chat.workspaceFile,
      workspaceFolder: chat.workspaceFolder,
      model: nextModel,
      sdkMode: chat.sdkMode,
      sdkUiMode: chat.sdkUiMode,
    });
    if (!result?.ok || !result.chat?.id) {
      window.alert(result?.error || t('chat.harnessSwitchFailed'));
      clearPendingHarnessSwitch(chat);
      return;
    }
    selectedHarness = nextHarness;
    saveLastSelectedHarness(selectedHarness);
    await applyOldChatDisposition({ id: oldChatId }, result.chat.id, disposition);
    await loadChatsFromServer({
      pinnedTo: pageUrl,
      includeArchived: true,
      preferChatId: result.chat.id,
      skipAutoSelect: true,
    });
    if (disposition === 'delete' && chats.some((entry) => entry.id === oldChatId)) {
      closeChat(oldChatId, { skipApiDelete: false, switchToChatId: result.chat.id });
    }
    performSelectChat(result.chat.id);
  } finally {
    switchHarnessInFlight = false;
    pendingWidgetHarnessSwitch = null;
    if (sharedSdkModeBar) sharedSdkModeBar.pendingHarness = '';
  }
}

function getSharedSdkModeBar() {
  if (sharedSdkModeBar) return sharedSdkModeBar;
  const bar = document.createElement('cr-sdk-mode-bar');
  bar.addEventListener('cr-sdk-mode-change', (event) => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    const nextMode = event?.detail?.mode;
    void setChatSdkMode(chat, nextMode);
  });
  bar.addEventListener('cr-sdk-build-plan', () => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    void (async () => {
      if (chat.todoId) {
        try {
          await api.postChatSyncTodoPlan(chat.id, { approved: true });
        } catch {
          // Plan sync is best-effort; implementation can still proceed.
        }
      }
      await setChatSdkMode(chat, 'agent');
      const planFile = chat.id
        ? `.cursor/plans/cretli-${String(chat.id).replace(/[^a-zA-Z0-9._-]/g, '')}.md`
        : '';
      const buildPrompt = planFile
        ? `Zaimplementuj zatwierdzony plan z pliku ${planFile}.`
        : 'Zaimplementuj zatwierdzony plan.';
      sendTextToAgent(chat, buildPrompt, { sdkMode: 'agent' });
    })();
  });
  bar.addEventListener('cr-sdk-model-change', (event) => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    const nextModel = event?.detail?.model;
    void setChatModel(chat, nextModel);
  });
  bar.addEventListener('cr-sdk-harness-intent', (event) => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    beginPendingHarnessSwitch(chat, event?.detail?.harness);
  });
  bar.addEventListener('cr-sdk-harness-cancel', () => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    clearPendingHarnessSwitch(chat);
  });
  bar.addEventListener('cr-sdk-harness-commit', (event) => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    void switchChatHarnessInWidget(chat, event?.detail?.harness, event?.detail?.model);
  });
  bar.addEventListener('cr-context-details-open', () => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat) return;
    openChatContextDetailsModal(chat);
  });
  sharedSdkModeBar = bar;
  return bar;
}

function mountSdkModeBarInToolbar() {
  const toolbar = document.querySelector('.chat-fullscreen-bar');
  if (!toolbar) return;
  const bar = getSharedSdkModeBar();
  const moreActionsBtn = toolbar.querySelector('#chat-toolbar-more-btn');
  if (bar.parentNode === toolbar) {
    if (!moreActionsBtn) return;
    if (bar.nextElementSibling === moreActionsBtn) return;
    toolbar.insertBefore(bar, moreActionsBtn);
    return;
  }
  if (!moreActionsBtn) {
    toolbar.appendChild(bar);
    return;
  }
  toolbar.insertBefore(bar, moreActionsBtn);
}

function bindChatToSharedSdkModeBar(chat) {
  if (!chat) return;
  const bar = getSharedSdkModeBar();
  chat.sdkModeBarEl = bar;
  if (!chat.sdkMode) chat.sdkMode = 'agent';
  mountSdkModeBarInToolbar();
  syncChatSdkModeUi(chat);
}

function syncChatSdkModeUi(chat) {
  const bar = chat?.sdkModeBarEl;
  if (!bar) return;
  if (chat.id !== activeChatId) return;
  bar.activeChatId = chat.id;
  const mode = normalizeSdkMode(chat?.sdkMode);
  bar.mode = mode;
  bar.showBuild = mode === 'plan';
  if (isPendingHarnessSwitch(bar, chat)) {
    loadModelsForPendingHarness(bar, bar.pendingHarness, false);
    return;
  }
  bar.pendingHarness = '';
  bar.model = normalizeModelValue(chat?.model || bar.model || 'auto');
  bar.harness = normalizeNewChatHarness(chat?.agentTransport || 'sdk');
  chatDiagnosticsApi?.updateChatContextMeter?.(
    chat,
    chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || bar.model || 'auto'),
  );
  chatModelSelectApi.setModelPickerHarness(normalizeNewChatHarness(chat?.agentTransport));
  bar.models = chatModelSelectApi.getSdkModeBarModelOptions();
}

function sdkModeLaunchCommand(chat, mode) {
  const normalized = normalizeSdkMode(mode);
  const sessionRef =
    (chat?.cursorSessionId && String(chat.cursorSessionId).slice(0, 8)) ||
    (chat?.id && String(chat.id).slice(0, 8)) ||
    '?';
  return buildHarnessLaunchLabel({
    transport: chat?.agentTransport,
    mode: normalized,
    sessionRef,
  });
}

/**
 * Voice tools and other callers switch Plan/Agent on the active chat.
 * @param {unknown} mode
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
export async function setActiveChatSdkMode(mode) {
  const normalized = mode === 'plan' || mode === 'agent' ? mode : '';
  if (!normalized) return { ok: false, error: 'Mode must be plan or agent' };
  const chat = activeChatId ? chats.find((item) => item.id === activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  await setChatSdkMode(chat, normalized);
  return { ok: true, mode: normalizeSdkMode(chat.sdkMode) };
}

async function setChatSdkMode(chat, mode) {
  if (!chat) return;
  const normalized = normalizeSdkMode(mode);
  if (chat.sdkMode === normalized) {
    syncChatSdkModeUi(chat);
    return;
  }
  chat.sdkMode = normalized;
  chat._sdkModeUserSetAt = Date.now();
  syncChatSdkModeUi(chat);
  setLaunchCommand(chat, sdkModeLaunchCommand(chat, normalized), '');
  if (chat._sdkRichView) {
    chat._sdkRichView.appendModeChange(normalized);
  }
  if (chat.ws?.readyState === WebSocket.OPEN) {
    chat.ws.send(JSON.stringify({ type: 'setSdkMode', mode: normalized }));
  }
  try {
    await api.patchChat(chat.id, { sdkMode: normalized });
  } catch (_) {}
}

async function setChatModel(chat, model) {
  if (!chat) return;
  const nextModel = normalizeModelValue(model);
  const prevModel = normalizeModelValue(chat.model || 'auto');
  if (nextModel === prevModel) {
    syncChatSdkModeUi(chat);
    return;
  }
  appLogger.log('api-request', 'PATCH /api/chats/' + chat.id + ' (model)', { model: nextModel });
  let data = null;
  try {
    data = await api.patchChat(chat.id, { model: nextModel });
  } catch (err) {
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id + ' (model)', String(err));
    syncChatSdkModeUi(chat);
    return;
  }
  appLogger.log('api-response', 'PATCH /api/chats/' + chat.id + ' (model)', data);
  if (!data?.ok) {
    syncChatSdkModeUi(chat);
    return;
  }
  chat.model = nextModel;
  selectedModel = nextModel;
  saveLastSelectedModel(nextModel);
  chat._pendingModelChange = {
    requestedModel: nextModel,
    requestedAt: Date.now(),
  };
  const line = `\r\n\x1b[33m${t('chat.modelChangeNotice', { model: nextModel })}\x1b[0m\r\n`;
  processAgentOutput(chat, line);
  if (chat._sdkRichView) {
    chat._sdkRichView.appendMetaNotice(stripAnsi(line).trim());
  }
  delete chat._sdkWarmupRequestedForStream;
  forceReconnectChat(chat);
  chatModelSelectApi.refreshModelSelectLabels();
}

function onChatSdkModeChange(chat, mode) {
  if (!chat) return;
  chat.sdkMode = normalizeSdkMode(mode);
  syncChatSdkModeUi(chat);
}

function sendTextToAgent(chat, text, opts = {}) {
  const sdkMode = normalizeSdkMode(opts.sdkMode ?? chat?.sdkMode);
  const internal = opts.internal === true;
  const rawText = text == null ? '' : String(text);
  let payloadText = rawText;
  let pendingSeedSummary = '';
  if (!internal && chat && typeof chat._contextSeedSummary === 'string' && chat._contextSeedSummary.trim()) {
    pendingSeedSummary = chat._contextSeedSummary.trim();
    delete chat._contextSeedSummary;
    payloadText = buildContextSeedPayload(pendingSeedSummary, rawText);
  }
  sendTextWithEnterToTerminalState(chat, payloadText, {
    sendEnterDelayMs: SEND_ENTER_DELAY_MS,
    enterFocusDelayMs: ENTER_FOCUS_DELAY_MS,
    sdkMode,
    onBeforeSend: () => {
      if (chat.id) recordChatActivity(chat.id);
    },
    onAfterSdkSend: (t) => {
      if (!internal) {
        if (pendingSeedSummary && chat._sdkRichView) {
          chat._sdkRichView.appendContextSeedBlock(pendingSeedSummary);
        }
        appendOptimisticSdkPrompt(chat, opts.displayText ?? rawText ?? t);
        setAgentState(chat, 'active');
      }
    },
  });
}

export function sendKeySequenceToActiveChat(sequence) {
  if (!sequence) return false;
  const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  return sendSequenceToTerminalState(chat, sequence, {
    onBeforeSend: () => {
      if (chat?.id) recordChatActivity(chat.id);
    },
  });
}

/**
 * Send a navigation key (arrow) to the active chat.
 * @param {'up'|'down'|'left'|'right'} direction
 * @returns {boolean} true when sent
 */
export function sendNavKeyToActiveChat(direction) {
  const sequence = CHAT_NAV_SEQUENCES[direction];
  if (!sequence) return false;
  return sendKeySequenceToActiveChat(sequence);
}


const chats = [];
/** Chat ids removed locally this session; stale GET responses must not resurrect them. */
const removedChatIds = new Set();

let requestAutoTitleFromAgent;
let requestTitleFromFork;
let requestSummaryFromFork;
let requestSummaryFromForkAsync;
let resolveChatTextForFork = async () => '';

/** @type {ReturnType<typeof createChatModelSelect>|null} */
let chatModelSelectApi = null;
/** @type {ReturnType<typeof createChatDiagnostics>|null} */
let chatDiagnosticsApi = null;

function initChatModelSelectApi() {
  chatModelSelectApi = createChatModelSelect({
    getActiveChatId: () => activeChatId,
    getChats: () => chats,
    getChatsForCurrentWorkspace,
    getTerminalStateMeta,
    getSelectedModel: () => selectedModel,
    syncChatSdkModeUi,
  });
}

function initChatDiagnosticsApi() {
  const contextMeterApi = createChatContextMeter({
    t,
    maybeScheduleAutoContextCompression,
    runIntentionalSummary,
  });
  const diagnosticsApi = createChatDiagnostics({
    api,
    appLogger,
    t,
    getActiveChatId: () => activeChatId,
    updateChatContextMeter: contextMeterApi.updateChatContextMeter,
    resolveContextMeterModelId: contextMeterApi.resolveContextMeterModelId,
    renderChatTerminalState,
    ensureChatConnection: (chat) => chatTransport.ensureChatConnection(chat),
    setTransientChatActionHint,
    maybeRecoverMissedSdkRunOutcome,
  });
  chatDiagnosticsApi = {
    ...contextMeterApi,
    ...diagnosticsApi,
  };
}

function initChatTitleForkApi() {
  const apiBundle = createChatTitleFork({
    api,
    appLogger,
    getActiveChatId: () => activeChatId,
    getChats: () => chats,
    sendTextToAgent,
    getActiveSendInput,
    debugFork,
    debugAutoTitle,
    getWorkspaceContextForChat,
    readChatBufferFromLocalStorage,
    renderChatList,
    openTemporaryForkChat,
    dismissTemporaryForkChat,
  });
  requestAutoTitleFromAgent = apiBundle.requestAutoTitleFromAgent;
  requestTitleFromFork = apiBundle.requestTitleFromFork;
  requestSummaryFromFork = apiBundle.requestSummaryFromFork;
  requestSummaryFromForkAsync = apiBundle.requestSummaryFromForkAsync;
  resolveChatTextForFork = apiBundle.resolveChatTextForFork;
}

let activeChatId = null;
let workspaces = [];
let selectedWorkspaceFile = null;
let selectedWorkspaceFolder = null;
/** Workspace folder from server settings — OpenCode is usually ready here. */
let serverSettingsWorkspaceFolder = '';
/** @type {Promise<unknown>|null} */
let pendingOpenCodeCatalogFetch = null;
let selectedModel = readLastSelectedModel();
let selectedHarness = readLastSelectedHarness();
let chatTitlesSyncTimer = null;
let chatTitlesSyncInFlight = false;

/**
 * @returns {Promise<void>}
 */
function yieldToMainThread() {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

async function syncSdkHistoryOnResume(chat, context = {}) {
  if (!chat?.id) return;
  const reason = String(context.reason || 'unknown');
  if (isSdkOpenTerminalHydrating(chat) && reason !== 'selectChat') return;
  if (chat._sdkResumeSyncPromise) return chat._sdkResumeSyncPromise;
  const syncStartedAt = Date.now();
  appLogger.log('chat-sync', 'resume sync start', {
    chatId: chat.id,
    reason: context.reason || 'unknown',
  });
  traceUiFreeze('chat-sync', 'start', {
    chatId: chat.id,
    reason: context.reason || 'unknown',
    hydrating: chat._sdkHistoryHydrating === true,
  });

  const syncPromise = (async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    const resumeDeferMs = getResumeHistorySyncDeferMs(
      String(context.reason || ''),
      isMobileLikeClient(),
      getLastBackgroundDurationMs()
    );
    if (resumeDeferMs > 0) {
      appLogger.log('chat-sync', 'resume sync deferred', {
        chatId: chat.id,
        reason: context.reason || 'unknown',
        deferMs: resumeDeferMs,
      });
      await new Promise((resolve) => setTimeout(resolve, resumeDeferMs));
    }
    if (typeof document !== 'undefined' && document.hidden) return;
    const fetchStartedAt = Date.now();
    const serverState = await syncChatHistoryDeltaFromServer(chat.id, chat.cursorSessionId || '');
    const fetchMs = Date.now() - fetchStartedAt;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!serverState) {
      if (chat._sdkHistoryHydrating === true && !isSdkOpenTerminalHydrating(chat)) {
        chatTransport.completeSdkHistoryHydration(chat, []);
      }
      appLogger.log('chat-sync', 'resume sync empty', {
        chatId: chat.id,
        fetchMs,
        reason: context.reason || 'unknown',
      });
      return;
    }

    const records = Array.isArray(serverState.events) ? serverState.events : [];
    let applied = 0;
    let applyMs = 0;
    if (chat._sdkRichView) {
      await yieldToMainThread();
      const applyStartedAt = Date.now();
      applied = await applyCatchUpSdkHistoryRecords(chat, records);
      applyMs = Date.now() - applyStartedAt;
      if (applied > 0) syncRichViewPlainBuffer(chat);
      updateAwaitingInput(chat);
      renderChatTerminalState(chat);
    }
    chatTransport.completeSdkHistoryHydration(chat, records);

    traceUiFreeze('chat-sync', 'complete', {
      chatId: chat.id,
      reason: context.reason || 'unknown',
      received: records.length,
      applied,
      fetchMs,
      applyMs,
      totalMs: Date.now() - syncStartedAt,
    });

    appLogger.log('chat-sync', 'resume catch-up complete', {
      chatId: chat.id,
      reason: context.reason || 'unknown',
      received: records.length,
      applied,
      fetchMs,
      applyMs,
      totalMs: Date.now() - syncStartedAt,
      headSeq: serverState.headSeq,
      ackSeq: serverState.ackSeq,
      hasRichView: !!chat._sdkRichView,
    });
    chat._pendingRemoteHistory = false;
    notifyChatBackendReachable(chat);
  })();

  chat._sdkResumeSyncPromise = syncPromise;
  try {
    await syncPromise;
  } catch (err) {
    appLogger.log('chat-sync', 'resume catch-up failed', {
      chatId: chat.id,
      reason: context.reason || 'unknown',
      error: String(err?.message || err),
    });
  } finally {
    if (chat._sdkResumeSyncPromise === syncPromise) {
      delete chat._sdkResumeSyncPromise;
    }
  }
}

const chatTransport = createChatTransport({
  WS_PATH_AGENT_SDK,
  CHAT_RECONNECT_MAX,
  CHAT_RECONNECT_DELAYS,
  CHAT_PING_INTERVAL_MS,
  CHAT_RESIZE_SEND_DEBOUNCE_MS,
  getChats: () => chats,
  getActiveChatId: () => activeChatId,
  getMaintainSessionsEnabled,
  getChatActivityAt,
  getSkipCatchUpOnResume,
  appLogger,
  setChatStatus,
  setAgentState,
  renderChatTerminalState,
  buildCatchUpSignature,
  enqueueCatchUpOutputChunk,
  drainCatchUpOutputChunks,
  getResizeColsRows,
  processAgentOutput,
  processAgentOutputCatchUp,
  writeCatchUpToTerminal,
  updateAwaitingInput,
  flushSdkStructuredHistoryNow,
  setLaunchCommand,
  scrollChatTerminalToBottom,
  appendSdkQueuedPromptLine,
  promoteSdkQueuedPromptLine,
  removeSdkQueuedPromptLine,
  appendSdkUserPromptLine,
  consumeOptimisticSdkPrompt,
  consumeOptimisticSdkQueuedPrompt,
  getSdkVerboseLogsEnabled,
  onSdkModeChange: onChatSdkModeChange,
  onSdkRunFinished: onChatSdkRunFinished,
  onSdkResume: syncSdkHistoryOnResume,
  onSdkModelChange: (chat) => syncChatSdkModeUi(chat),
  onSdkInvalidSession: (chat) => resetChatSdkContext(chat, null),
  onConnectionLost: handleChatConnectionLost,
});

function appendChatRecoveryNotice(chat, text, _tone = 'warn') {
  if (!chat?._sdkRichView) return;
  chat._sdkRichView.appendMetaNotice(text);
}

initChatServerRecovery({
  getChats: () => chats,
  getActiveChatId: () => activeChatId,
  ensureChatConnection: chatTransport.ensureChatConnection,
  forceReconnectChat,
  syncBackgroundChatConnections,
  syncSdkHistoryOnResume,
  appendRecoveryNotice: appendChatRecoveryNotice,
  appLogger,
});
registerPageResumeCleanupHook(dismissStaleReconnectUiOnResume);

initChatContextCompressionRecovery({
  setAgentState,
  ensureChatConnection: chatTransport.ensureChatConnection,
  syncBackgroundChatConnections,
  forceReconnectChat,
  appLogger,
});

const chatView = createChatView({
  initDropdown,
  chatFavorites,
  getChatsForCurrentWorkspace,
  getArchivedChatsForCurrentWorkspace,
  getActiveChatId: () => activeChatId,
  getChatLastUsedAt,
  getChatAgentState,
  getTerminalStateMeta,
  escapeHtml,
  selectChat,
  requestDeleteChat,
  requestArchiveChat,
  requestRestoreChat,
  refreshModelSelectLabels: () => chatModelSelectApi?.refreshModelSelectLabels(),
  onFavoritesChanged: renderChatList,
  isEmbedMode: () => typeof document !== 'undefined' && document.body?.classList.contains('embed-mode'),
  canPinChatToUrl,
  toggleChatUrlPinById,
  openNewChatModal,
  hasPendingRemoteHistory: (chat) => chat?._pendingRemoteHistory === true,
  getPendingRemoteHistoryLabel: () => t('chat.pendingRemoteHistory'),
});

initChatHistorySyncPoll({
  getChats: () => chats,
  getActiveChatId: () => activeChatId,
  syncSdkHistoryOnResume,
  appLogger,
  onPendingHistoryChange: () => {
    renderChatList();
  },
});

const chatController = createChatController({
  api,
  CHAT_BUFFER_MAX,
  LAST_CHAT_ID_KEY,
  getChats: () => chats,
  getActiveChatId: () => activeChatId,
  setActiveChatId: (nextId) => {
    activeChatId = nextId;
  },
  getWorkspaces: () => workspaces,
  setWorkspaces: (next) => {
    workspaces = next;
  },
  getSelectedWorkspaceFile: () => selectedWorkspaceFile,
  setSelectedWorkspaceFile: (next) => {
    selectedWorkspaceFile = next;
  },
  getSelectedWorkspaceFolder: () => selectedWorkspaceFolder,
  setSelectedWorkspaceFolder: (next) => {
    selectedWorkspaceFolder = next;
  },
  getSelectedModel: () => selectedModel,
  setSelectedModel: (next) => {
    selectedModel = normalizeModelValue(next);
    saveLastSelectedModel(selectedModel);
  },
  readChatBufferForChatRestore,
  updateFolderSelect,
  renderModelSelectOptions: (selectEl, selectedValue) =>
    chatModelSelectApi?.renderModelSelectOptions(selectEl, selectedValue),
  renderChatList,
  updateChatBarSelect,
  selectChat,
  syncBackgroundChatConnections,
  bindChatVisibilityAndReconnect,
  startChatBackgroundMonitor,
  startGlobalChatPingLoop,
  ensureChatConnection,
  openTerminal,
  getChatsForCurrentWorkspace,
  setChatStatus,
});

/** Chats assigned to the current header workspace. Older chats (no workspaceFile) are hidden. */
function getWorkspaceContextForChat() {
  const trigger = document.getElementById('header-workspace-trigger');
  const headerWorkspaceFile = trigger?.dataset?.workspaceFile || '';
  const headerWorkspaceFolder = trigger?.dataset?.workspaceFolder || '';
  if (headerWorkspaceFile || headerWorkspaceFolder) {
    return {
      workspaceFile: headerWorkspaceFile,
      workspaceFolder: headerWorkspaceFolder,
    };
  }
  const embedOverride = (typeof window !== 'undefined' && window.__crWorkspaceOverride)
    ? window.__crWorkspaceOverride
    : null;
  const workspaceFile = embedOverride?.workspaceFile || '';
  const workspaceFolder = embedOverride?.workspaceFolder || '';
  if (!workspaceFile && !workspaceFolder) return null;
  return {
    workspaceFile,
    workspaceFolder,
  };
}

function resolveChatCreationWorkspaceContext() {
  const workspaceSel = document.getElementById('chat-new-workspace-select');
  const folderSel = document.getElementById('chat-new-folder-select');
  const workspaceFile = (
    workspaceSel?.value ||
    selectedWorkspaceFile ||
    getWorkspaceContextForChat()?.workspaceFile ||
    ''
  ).trim();
  const workspaceFolder = (
    folderSel?.value ||
    selectedWorkspaceFolder ||
    getWorkspaceContextForChat()?.workspaceFolder ||
    ''
  ).trim();
  return {
    workspaceFile,
    workspaceFolder,
  };
}

function getChatsForCurrentWorkspace() {
  const ctx = getWorkspaceContextForChat();
  const headerWorkspace = ctx?.workspaceFile || null;
  if (!headerWorkspace) return [];
  const headerNorm = normalizePath(headerWorkspace);
  return chats.filter((chat) => {
    if (!chat.workspaceFile || normalizePath(chat.workspaceFile) !== headerNorm) return false;
    return !chat.archivedAt;
  });
}

function getArchivedChatsForCurrentWorkspace() {
  const ctx = getWorkspaceContextForChat();
  const headerWorkspace = ctx?.workspaceFile || null;
  if (!headerWorkspace) return [];
  const headerNorm = normalizePath(headerWorkspace);
  return chats.filter((chat) => {
    if (!chat.workspaceFile || normalizePath(chat.workspaceFile) !== headerNorm) return false;
    return !!chat.archivedAt;
  });
}

export function applyChatEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyChatEnabledModels(enabledKeys);
}

export function applyOpenRouterEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyOpenRouterEnabledModels(enabledKeys);
}

export function applyOpenCodeEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyOpenCodeEnabledModels(enabledKeys);
}

/** Agent state: 'idle' | 'active' | 'disconnected'. Used on the chat list. */
const AGENT_STATE_IDLE_MS = 1500;
const TERMINAL_RECENT_OUTPUT_MS = 8000;

function getChatAgentState(chat) {
  return chat._agentState || 'disconnected';
}

export function getChatsList() {
  return chats;
}

export function getWorkspacesList() {
  return workspaces;
}

export function getActiveChatIdValue() {
  return activeChatId;
}

export function getChatListAgentStatePublic(chat) {
  return getChatListAgentState(chat);
}

export function getTerminalStateMetaPublic(chat) {
  return getTerminalStateMeta(chat);
}

export function getChatFavoritesStore() {
  return chatFavorites;
}

export function getChatLastUsedAtPublic(chatId) {
  return getChatLastUsedAt(chatId);
}

export function canPinChatToUrl() {
  return isEmbedWidgetMode() && isWidgetHostNavigationAvailable();
}

export function toggleChatUrlPinById(chatId, hintEl = null) {
  const chat = chats.find((item) => item.id === chatId);
  return toggleWidgetUrlPin(chat, hintEl);
}

let sidebarRenderHook = null;
export function setSidebarRenderHook(fn) {
  sidebarRenderHook = typeof fn === 'function' ? fn : null;
}

/** @type {(() => void)|null} */
let sidebarOpenHook = null;

/**
 * App.js registers the sidebar drawer here so voice tools can open it
 * without importing App (that would close a cycle through the send bar).
 * @param {(() => void)|null} fn
 * @returns {void}
 */
export function setSidebarOpenHook(fn) {
  sidebarOpenHook = typeof fn === 'function' ? fn : null;
}

/**
 * Open the workspace/chat list sidebar. Idempotent when already open.
 * @returns {boolean}
 */
export function openChatSidebar() {
  if (typeof sidebarOpenHook !== 'function') return false;
  sidebarOpenHook();
  return true;
}

/** @type {(() => void)|null} */
let sidebarCloseHook = null;

/**
 * App.js registers the sidebar drawer close here for voice tools.
 * @param {(() => void)|null} fn
 * @returns {void}
 */
export function setSidebarCloseHook(fn) {
  sidebarCloseHook = typeof fn === 'function' ? fn : null;
}

/**
 * Hide the workspace/chat list sidebar. Idempotent when already closed.
 * @returns {boolean}
 */
export function closeChatSidebar() {
  if (typeof sidebarCloseHook !== 'function') return false;
  sidebarCloseHook();
  return true;
}

function notifySidebar() {
  if (sidebarRenderHook) sidebarRenderHook();
}

function hasOngoingTerminalAction(chat) {
  const interaction = chat?._terminalInteraction;
  if (!interaction) return false;
  const hasRecentOutput =
    typeof chat._lastOutputAt === 'number' && Date.now() - chat._lastOutputAt < TERMINAL_RECENT_OUTPUT_MS;
  if (!hasRecentOutput) return false;
  return !!(
    interaction.running ||
    interaction.generating ||
    interaction.reading ||
    interaction.grepping ||
    interaction.editing ||
    interaction.thinking
  );
}

function getChatListAgentState(chat) {
  if (!chat) return 'disconnected';
  return resolveChatListDotState(getTerminalStateMeta(chat).tone);
}

function setAgentState(chat, state) {
  if (chat._agentStateIdleTimer) {
    clearTimeout(chat._agentStateIdleTimer);
    chat._agentStateIdleTimer = null;
  }
  chat._agentState = state;
  renderChatTerminalState(chat);
  updateChatListModalStates();
  chatModelSelectApi.refreshModelSelectLabels();
  syncAgentWakeLock(chats.some((entry) => entry._agentState === 'active'));
}

function scheduleAgentIdleTransition(chat) {
  if (!chat) return;
  if (chat._agentStateIdleTimer) clearTimeout(chat._agentStateIdleTimer);
  chat._agentStateIdleTimer = setTimeout(() => {
    chat._agentStateIdleTimer = null;
    if (hasOngoingTerminalAction(chat) || hasLiveHarnessWork(chat)) {
      setAgentState(chat, 'active');
      scheduleAgentIdleTransition(chat);
      return;
    }
    setAgentState(chat, 'idle');
  }, AGENT_STATE_IDLE_MS);
}

function onAgentOutput(chat) {
  if (!chat) return;
  if (chat?.id) recordChatActivity(chat.id);
  setAgentState(chat, 'active');
  scheduleAgentIdleTransition(chat);
}

function scheduleTerminalStateRefresh(chat) {
  if (!chat) return;
  if (chat._recentOutputExpireTimer) {
    clearTimeout(chat._recentOutputExpireTimer);
    chat._recentOutputExpireTimer = null;
  }
  if (!chat._lastOutputAt) return;
  const waitMs = chat._lastOutputAt + TERMINAL_RECENT_OUTPUT_MS - Date.now();
  if (waitMs <= 0) {
    renderChatTerminalState(chat);
    updateChatListModalStates();
    chatModelSelectApi.refreshModelSelectLabels();
    return;
  }
  chat._recentOutputExpireTimer = setTimeout(() => {
    chat._recentOutputExpireTimer = null;
    renderChatTerminalState(chat);
    updateChatListModalStates();
    chatModelSelectApi.refreshModelSelectLabels();
  }, waitMs + 20);
}

function updateChatListModalStates() {
  updateSidebarChatStates();
  const modal = document.getElementById('chat-list-modal');
  const listEl = document.getElementById('chat-list-items');
  if (!modal || modal.hidden || !listEl) return;
  listEl.querySelectorAll('.chat-list-item').forEach((li) => {
    const id = li.dataset.chatId;
    const chat = id ? chats.find((c) => c.id === id) : null;
    const state = getChatListAgentState(chat);
    const meta = chat ? getTerminalStateMeta(chat) : { tone: 'disconnected', label: t('status.disconnected') };
    const indicator = li.querySelector('.chat-list-item-state');
    if (indicator) {
      indicator.className = 'chat-list-item-state chat-list-item-state--' + state;
      indicator.setAttribute('title', meta.label);
    }
    const awaitingEl = li.querySelector('.chat-list-item-awaiting');
    if (awaitingEl) {
      const show = meta.tone !== 'idle';
      awaitingEl.className = 'chat-list-item-awaiting chat-list-item-awaiting--' + meta.tone;
      awaitingEl.hidden = !show;
      awaitingEl.textContent = meta.label;
      awaitingEl.setAttribute('title', t('chat.stateTitle', { label: meta.label }));
    }
  });
}

/** In-place chat status update in the sidebar (no full re-render). */
function updateSidebarChatStates() {
  const aside = document.getElementById('app-sidebar');
  if (!aside || aside.hidden) return;
  const body = aside.querySelector('.sidebar-body');
  if (!body) return;
  body.querySelectorAll('.sidebar-chat-item').forEach((li) => {
    const id = li.dataset.chatId;
    const chat = id ? chats.find((c) => c.id === id) : null;
    const state = getChatListAgentState(chat);
    const meta = chat ? getTerminalStateMeta(chat) : { tone: 'disconnected', label: t('status.disconnected') };
    const indicator = li.querySelector('.sidebar-chat-item-state');
    if (indicator) {
      indicator.className = 'sidebar-chat-item-state sidebar-chat-item-state--' + state;
      indicator.setAttribute('title', meta.label);
    }
    const awaitingEl = li.querySelector('.sidebar-chat-item-awaiting');
    if (awaitingEl) {
      const show = meta.tone !== 'idle';
      awaitingEl.className = 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--' + meta.tone;
      awaitingEl.hidden = !show;
      awaitingEl.textContent = meta.label;
      awaitingEl.setAttribute('title', t('chat.stateTitle', { label: meta.label }));
    }
  });
}

export function refreshSidebarChatStates() {
  updateSidebarChatStates();
}

function isTerminalTextareaMode(chat) {
  return !!(chat && chat._terminalInteraction && chat._terminalInteraction.textarea);
}

function updateAwaitingInput(chat) {
  if (!chat) return { textarea: false, choice: false, awaiting: false };
  const parsed = parseTerminalInteraction(chat._buffer || '');
  const {
    approval,
    grepping,
    reading,
    thinking,
    running,
    generating,
    editing,
    textarea,
    choice,
    question,
    awaiting,
    generatingRaw,
    normalizedTail,
    lastLines,
  } = parsed;
  chat._statusTailPreview = lastLines.slice(-700);
  if (isDebugStatus() && activeChatId && chat.id === activeChatId) {
    const hasRunWord = /\b(running|generating)\b/i.test(normalizedTail);
    const now = Date.now();
    const canDebug = !chat._statusDebugAt || now - chat._statusDebugAt > 1200;
    if (hasRunWord && canDebug) {
      chat._statusDebugAt = now;
      appLogger.log('status-debug', 'run/generate seen in tail', {
        chatId: chat.id,
        genLast: generatingRaw,
        genTail: generatingRaw,
        generatingRaw,
        generating,
        reading,
        grepping,
        editing,
        thinking,
        approval,
        awaiting,
        lastLines: lastLines.slice(-500),
      });
    }
  }
  chat._terminalInteraction = { approval, grepping, reading, thinking, running, generating, editing, textarea, choice, question, awaiting };
  chat._awaitingInput = awaiting;
  if (isDebugStatus() && activeChatId && chat.id === activeChatId) {
    const meta = getTerminalStateMeta(chat);
    const lastTone = chat._lastStateTone || null;
    if (meta.tone !== lastTone) {
      chat._lastStateTone = meta.tone;
      appLogger.log('status', 'active chat state change', {
        chatId: chat.id,
        tone: meta.tone,
        label: meta.label,
        generating,
        reading,
        grepping,
        editing,
        thinking,
        approval,
        awaiting,
        tail: chat._statusTailPreview,
      });
    }
  }
  renderChatTerminalState(chat);
  updateChatListModalStates();
  chatModelSelectApi.refreshModelSelectLabels();
  return chat._terminalInteraction;
}

/**
 * After an SDK run the agent is `idle`, but `chat._buffer` still holds the text
 * of the last reply (Markdown, rhetorical questions). CLI heuristics then set
 * `awaiting` / `question` and the chat list shows “Needs action” with no SDK request.
 *
 * @param {object|null|undefined} chat
 * @param {object} interaction
 * @returns {object}
 */
function terminalInteractionForStateResolve(chat, interaction) {
  const i = interaction || {};
  if (!chat) return i;
  if (getChatAgentState(chat) !== 'idle') return i;
  return {
    ...i,
    awaiting: false,
    approval: false,
    textarea: false,
    choice: false,
    question: false,
  };
}

/**
 * Harness chats (rich-view) use protocol pending flags, not PTY buffer heuristics.
 *
 * @param {object|null|undefined} chat
 * @returns {{ tone: string, label: string } | null}
 */
function resolveSdkChatStateMeta(chat) {
  if (!chat?._sdkRichView) return null;
  const pending = readHarnessPendingFlags(chat);
  const queuedCount = chat._sdkRichView?.queuedCount || Number(chat._sdkServerQueuedCount) || 0;
  return resolveHarnessChatStateMeta({
    connection: chat._connectionStatus || 'disconnected',
    agent: getChatAgentState(chat),
    hasPendingQuestion: pending.hasPendingQuestion,
    hasPendingPermission: pending.hasPendingPermission,
    queuedCount,
    translate: t,
  });
}

function getTerminalStateMeta(chat) {
  const sdkMeta = resolveSdkChatStateMeta(chat);
  if (sdkMeta) return sdkMeta;
  const interaction = terminalInteractionForStateResolve(chat, chat?._terminalInteraction || {});
  const connection = chat?._connectionStatus || 'disconnected';
  const recentOutput = chat?._lastOutputAt && Date.now() - chat._lastOutputAt < TERMINAL_RECENT_OUTPUT_MS;
  const agent = getChatAgentState(chat);
  const state = resolveTerminalState(interaction, connection, agent, recentOutput);
  // status-parser is shared with the backend, so it returns a key instead of a
  // translated label.
  return state.labelKey ? { ...state, label: t(state.labelKey) } : state;
}

function renderChatTerminalState(chat, metaOverride = null) {
  const bar = chat?.sdkModeBarEl;
  if (!bar || chat.id !== activeChatId) {
    updateChatListModalStates();
    return;
  }
  const meta =
    metaOverride ||
    getTerminalStateMeta(chat);
  bar.statusLabel = meta.label;
  bar.statusTone = meta.tone;
  if (isPendingHarnessSwitch(bar, chat)) return;
  bar.model = normalizeModelValue(chat?.model || 'auto');
  chatDiagnosticsApi?.updateChatContextMeter?.(
    chat,
    chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
  );
}

function renderChatList() {
  chatView.renderChatList();
  notifySidebar();
}

function updateChatBarSelect() {
  chatView.updateChatBarSelect();
}

function closeChatListModal() {
  chatView.closeChatListModal();
}

function closeChatActionsModal() {
  chatView.closeChatActionsModal();
}

function bindChatToolbarActionItem(itemEl, onActivate) {
  if (!itemEl || typeof onActivate !== 'function') return;
  itemEl.addEventListener('click', onActivate);
  itemEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  });
}

/** After a header workspace change — refresh the chat list and maybe switch the active chat. */
export function refreshChatListForWorkspace() {
  chatController.refreshChatListForWorkspace();
  notifySidebar();
}

function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

function updateFolderSelect(workspaceFile, preferredFolder = '') {
  const normalized = normalizePath(workspaceFile);
  const w = workspaces.find((x) => normalizePath(x.workspaceFile) === normalized);
  const folderSel = document.getElementById('chat-new-folder-select');
  if (!folderSel) return;
  if (!w) {
    folderSel.innerHTML = '';
    selectedWorkspaceFolder = null;
    return;
  }
  const options = [];
  if (w.workspaceDir) {
    options.push(
      '<option value="' + escapeHtml(w.workspaceDir) + '">' + escapeHtml(t('chat.workspaceParent')) + '</option>'
    );
  }
  (w.folders || []).forEach((f) => {
    if (f.resolvedPath && normalizePath(f.resolvedPath) !== normalizePath(w.workspaceDir)) {
      options.push(
        '<option value="' +
          escapeHtml(f.resolvedPath) +
          '">' +
          escapeHtml(f.name) +
          '</option>'
      );
    }
  });
  folderSel.innerHTML = options.join('');
  if (!folderSel.options.length) {
    selectedWorkspaceFolder = null;
    chatNewFolderDropdownApi?.refresh?.();
    return;
  }
  const preferred = (preferredFolder || selectedWorkspaceFolder || '').trim();
  const preferredOption = Array.from(folderSel.options).find(
    (option) => normalizePath(option.value) === normalizePath(preferred)
  );
  if (preferredOption) {
    folderSel.value = preferredOption.value;
    selectedWorkspaceFolder = preferredOption.value;
    chatNewFolderDropdownApi?.refresh?.();
    return;
  }
  const fallbackFolder = w.workspaceDir || (w.folders && w.folders[0] && w.folders[0].resolvedPath) || '';
  const fallbackOption = Array.from(folderSel.options).find(
    (option) => normalizePath(option.value) === normalizePath(fallbackFolder)
  );
  folderSel.value = fallbackOption ? fallbackOption.value : folderSel.options[0].value;
  selectedWorkspaceFolder = folderSel.value || null;
  chatNewFolderDropdownApi?.refresh?.();
}

function setLaunchCommand(chat, commandLine, cwd) {
  const el = chat.launchCommandEl;
  if (!el) return;
  chat._sdkLaunchCommand = commandLine || '';
  chat._sdkLaunchCwd = cwd || '';
  el.style.display = 'none';
}

/** After new output, scroll the terminal to the bottom so the latest replies stay visible. */
function scrollChatTerminalToBottom(term) {
  if (!term || typeof term.scrollToBottom !== 'function') return;
  requestAnimationFrame(() => {
    try {
      term.scrollToBottom();
    } catch (_) {}
  });
}

const EMBED_BOOT_READY_EVENT = 'cr-embed-boot-ready';
const EMBED_BOOT_READY_TIMEOUT_MS = 10_000;
const OPEN_TERMINAL_RETRY_MS = 50;
const OPEN_TERMINAL_MAX_ATTEMPTS = 80;

function isEmbedBootDomReady() {
  if (typeof document === 'undefined') return true;
  if (!document.body?.classList.contains('embed-mode')) return true;
  return !!document.getElementById('chat-tabs');
}

/** Waits until embed SPA finished boot (chat-tabs in DOM). No-op outside embed mode. */
export function waitForEmbedBootReady() {
  if (isEmbedBootDomReady()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener(EMBED_BOOT_READY_EVENT, onReady);
      resolve();
    };
    const onReady = () => finish();
    window.addEventListener(EMBED_BOOT_READY_EVENT, onReady, { once: true });
    window.setTimeout(finish, EMBED_BOOT_READY_TIMEOUT_MS);
  });
}

function syncRichViewPlainBuffer(chat) {
  if (!chat?._sdkRichView) return;
  const synthesized = stripAnsi(chat._sdkRichView.getCopyText());
  chat._buffer =
    synthesized.length > CHAT_BUFFER_MAX ? synthesized.slice(-CHAT_BUFFER_MAX) : synthesized;
  persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

/**
 * Renders only the newest slice of a record list and parks the rest as the first
 * "older" page — cached records are free to render, no round trip needed.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {unknown[]} the slice that was handed to the view
 */
function takeSdkHistoryWindow(chat, records) {
  const list = Array.isArray(records) ? records : [];
  if (list.length <= CHAT_HISTORY_INITIAL_TAIL) {
    chat._historyOlderLocal = [];
    return list;
  }
  const cut = list.length - CHAT_HISTORY_INITIAL_TAIL;
  chat._historyOlderLocal = list.slice(0, cut);
  return list.slice(cut);
}

/**
 * @param {object} chat
 * @param {{ v: number, cursorSessionId: string, events: unknown[] } | null} localState
 * @param {string} sessionKey
 * @returns {Promise<{ hydratedRecords: unknown[], structuredReplayDone: boolean }>}
 */
async function hydrateSdkRichViewFromLocalCache(chat, localState, sessionKey) {
  if (!chat?._sdkRichView || !sessionKey) {
    return { hydratedRecords: [], structuredReplayDone: false };
  }
  const hasLocalEvents =
    !!localState && Array.isArray(localState.events) && localState.events.length > 0;
  if (!hasLocalEvents) {
    return { hydratedRecords: [], structuredReplayDone: false };
  }
  const localSessionId =
    typeof localState.cursorSessionId === 'string' ? localState.cursorSessionId.trim() : '';
  if (localSessionId && localSessionId !== sessionKey) {
    return { hydratedRecords: [], structuredReplayDone: false };
  }
  if (localSessionId !== sessionKey) {
    await replaceSdkChatHistoryRecords(chat.id, sessionKey, localState.events);
  }
  const chronological = sortRecordsByCreatedAt(localState.events);
  const windowed = takeSdkHistoryWindow(chat, chronological);
  rememberHistoryWindowStart(chat, windowed, { reset: true });
  chat._sdkRichView.replayHistoryRecords(windowed, { instant: true });
  syncRichViewPlainBuffer(chat);
  return { hydratedRecords: chronological, structuredReplayDone: true };
}

/**
 * @param {object} chat
 * @param {unknown[]} serverEvents
 * @param {string} sessionKey
 * @param {boolean} structuredReplayDone
 * @returns {Promise<{ hydratedRecords: unknown[], structuredReplayDone: boolean }>}
 */
/**
 * Applies a server catch-up batch without putting older streams under the
 * already-rendered window. localUser rows have no stream id, so takeMissing
 * skips them — prepend the whole older slice of the incoming batch instead.
 *
 * @param {object} chat
 * @param {unknown[]} incomingRecords
 * @returns {Promise<number>} number of records applied to the view
 */
async function applyCatchUpSdkHistoryRecords(chat, incomingRecords) {
  if (!chat?._sdkRichView || !Array.isArray(incomingRecords) || incomingRecords.length === 0) {
    return 0;
  }
  const missing = takeMissingSdkHistoryRecords(chat, incomingRecords);
  const windowOldestAt =
    typeof chat._historyWindowOldestAt === 'string' ? chat._historyWindowOldestAt : '';
  const missingParts = partitionRecordsByWindowStart(missing, windowOldestAt);
  let applied = 0;
  if (missingParts.older.length > 0) {
    const older = partitionRecordsByWindowStart(incomingRecords, windowOldestAt).older;
    const toPrepend = older.length > 0 ? older : missingParts.older;
    chat._sdkRichView.prependHistoryRecords(toPrepend);
    rememberHistoryWindowStart(chat, toPrepend);
    applied += toPrepend.length;
  }
  if (missingParts.newer.length > 0) {
    await chat._sdkRichView.appendHistoryRecords(missingParts.newer, { instant: true });
    applied += missingParts.newer.length;
  }
  return applied;
}

async function mergeServerSdkHistoryIntoRichView(chat, serverEvents, sessionKey, structuredReplayDone) {
  if (!chat?._sdkRichView || !Array.isArray(serverEvents) || serverEvents.length === 0) {
    return { hydratedRecords: serverEvents || [], structuredReplayDone };
  }
  const resolvedSessionKey = sessionKey || '';
  if (structuredReplayDone) {
    const applied = await applyCatchUpSdkHistoryRecords(chat, serverEvents);
    if (applied > 0) syncRichViewPlainBuffer(chat);
    if (resolvedSessionKey) {
      await replaceSdkChatHistoryRecords(chat.id, resolvedSessionKey, serverEvents);
    }
    return { hydratedRecords: serverEvents, structuredReplayDone: true };
  }
  if (resolvedSessionKey) {
    await replaceSdkChatHistoryRecords(chat.id, resolvedSessionKey, serverEvents);
  }
  rememberHistoryWindowStart(chat, serverEvents, { reset: true });
  chat._sdkRichView.replayHistoryRecords(serverEvents, { instant: true });
  syncRichViewPlainBuffer(chat);
  return { hydratedRecords: serverEvents, structuredReplayDone: true };
}

/**
 * Supplies the rich view with one page of older history: cached records first (free),
 * then pages from the server walking back from the oldest seq we hold.
 *
 * @param {object} chat
 * @returns {Promise<{ records: unknown[], hasOlder: boolean } | null>}
 */
async function loadOlderSdkHistoryPage(chat) {
  // null is reserved for a failed fetch (the view offers a retry); a chat without an id can
  // never produce pages, so report it as exhausted instead of looping on retry.
  if (!chat?.id) return { records: [], hasOlder: false };
  const cached = Array.isArray(chat._historyOlderLocal) ? chat._historyOlderLocal : [];
  if (cached.length > 0) {
    const cut = Math.max(0, cached.length - CHAT_HISTORY_OLDER_PAGE);
    chat._historyOlderLocal = cached.slice(0, cut);
    const records = cached.slice(cut);
    rememberHistoryWindowStart(chat, records);
    return {
      records,
      hasOlder: cut > 0 || resolveOlderHistoryCursor(chat) > 0,
    };
  }
  const beforeSeq = resolveOlderHistoryCursor(chat);
  if (beforeSeq <= 0) return { records: [], hasOlder: false };
  const page = await pullChatHistoryOlderFromServer(chat.id, {
    beforeSeq,
    limit: CHAT_HISTORY_OLDER_PAGE,
  });
  if (!page) return null;
  chat._historyOldestSeq = page.hasOlder ? page.oldestLoadedSeq : 0;
  rememberHistoryWindowStart(chat, page.events);
  return { records: page.events, hasOlder: page.hasOlder };
}

/**
 * In-session cursor for paging back; falls back to the persisted window edge so a reload
 * (which renders the cache, not a fresh tail) can keep scrolling further back.
 *
 * @param {object} chat
 * @returns {number}
 */
function resolveOlderHistoryCursor(chat) {
  if (Number.isSafeInteger(chat._historyOldestSeq)) return chat._historyOldestSeq;
  return getOldestLoadedSeq(chat.id);
}

/**
 * Arms auto-loading of older history once hydration settled and the view sits at the bottom —
 * arming earlier would make the top sentinel fire against a still-empty stream.
 *
 * @param {object} chat
 */
function armOlderSdkHistory(chat) {
  const view = chat?._sdkRichView;
  if (!view) return;
  view.scrollToBottom();
  const hasCached = Array.isArray(chat._historyOlderLocal) && chat._historyOlderLocal.length > 0;
  const available = hasCached || resolveOlderHistoryCursor(chat) > 0;
  // Two frames: one for the forced scroll to land, one for layout to settle before observing.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (chat._sdkRichView !== view) return;
      view.setOlderHistoryAvailable(available);
    });
  });
}

function scheduleOpenTerminalWhenReady(chat, attempt = 0) {
  if (!chat || chat.pane) return;
  if (isEmbedBootDomReady()) {
    openTerminal(chat);
    return;
  }
  if (attempt >= OPEN_TERMINAL_MAX_ATTEMPTS) return;
  window.setTimeout(() => scheduleOpenTerminalWhenReady(chat, attempt + 1), OPEN_TERMINAL_RETRY_MS);
}

function openTerminal(chat) {
  if (chat.pane) return;
  if (!document.getElementById('chat-tabs')) {
    scheduleOpenTerminalWhenReady(chat);
    return;
  }
  const pane = document.createElement('div');
  pane.className = 'chat-tab-pane';
  pane.dataset.chatId = chat.id;
  const launchDiv = document.createElement('div');
  launchDiv.className = 'chat-launch-command';
  launchDiv.setAttribute('aria-hidden', 'true');
  launchDiv.style.display = 'none';
  pane.appendChild(launchDiv);
  chat.launchCommandEl = launchDiv;
  if (!chat.sdkMode) chat.sdkMode = 'agent';
  bindChatToSharedSdkModeBar(chat);
  pane.appendChild(chatDiagnosticsApi.createChatDiagPanel(chat));
  if (isChatDiagEnabled()) chatDiagnosticsApi.startChatDiagPolling(chat);
  const viewportWrap = document.createElement('div');
  viewportWrap.className = 'terminal-viewport-wrap';
  const container = document.createElement('div');
  viewportWrap.appendChild(container);
  pane.appendChild(viewportWrap);

  function sendKeyToAgent(sequence) {
    const focusDelayMs = sequence === '\r' ? ENTER_FOCUS_DELAY_MS : 0;
    sendSequenceToTerminalState(chat, sequence, {
      focusDelayMs,
      onBeforeSend: () => {
        if (chat.id) recordChatActivity(chat.id);
      },
    });
  }

  function chatOnSend(text, meta = {}) {
    chat._awaitingInput = false;
    const rawText = typeof meta.rawText === 'string' ? meta.rawText : text || '';
    const trimmed = (text || '').trim();
    const hasPageSelection = !!meta.pageSelectionContext;
    const hasAttachments = Array.isArray(meta.attachmentPaths) && meta.attachmentPaths.some(Boolean);
    const textareaMode = isTerminalTextareaMode(chat);
    if (!trimmed && !hasPageSelection && !hasAttachments) {
      if (textareaMode) return false;
      sendKeyToAgent('\r');
      return true;
    }
    if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) {
      ensureChatConnection(chat);
      chat._sdkRichView?.appendMetaNotice?.(t('chat.agentConnectionLostResend'));
      return false;
    }
    const isTitlePrompt =
      trimmed === AUTO_TITLE_PROMPT.trim() ||
      (trimmed.includes('Reply with a single line of JSON') && trimmed.includes('"title"'));
    if (isTitlePrompt) {
      debugAutoTitle('sendKeys', { chatId: chat.id, setPending: true, msg: 'prompt sent from the input field – now waiting for the JSON reply' });
      if (chat._autoTitleTimeout) {
        clearTimeout(chat._autoTitleTimeout);
        chat._autoTitleTimeout = null;
      }
      chat._pendingAutoTitle = true;
      chat._autoTitleBuffer = '';
      chat._autoTitleRequestAt = Date.now();
      chat._autoTitleTimeout = setTimeout(() => {
        debugAutoTitle('timeout (Enter)', { chatId: chat.id, msg: 'expired – no longer waiting for the JSON reply' });
        chat._pendingAutoTitle = false;
        chat._autoTitleBuffer = '';
        chat._autoTitleTimeout = null;
      }, AUTO_TITLE_TIMEOUT_MS);
    }
    let payloadText = rawText;
    if (hasPageSelection) {
      const pageBlock = formatHostPagePickContextBlock(meta.pageSelectionContext);
      payloadText = pageBlock + (rawText.trim() ? `\n\n${rawText}` : '');
    }
    sendTextToAgent(chat, payloadText, { displayText: rawText });
    writeChatDraft(chat.id, '');
    return true;
  }

  const sendBar = createSendBar({
    placeholder: t('chat.commandPlaceholder'),
    showToggleExtra: true,
    getExtraBarWrap: () => document.getElementById('chat-extra-bar-wrap'),
    showArrows: false,
    showStop: true,
    onSend: chatOnSend,
    onArrowUp: () => {},
    onArrowDown: () => {},
    onStop: () => sendKeyToAgent('\x03'),
    showScreenshotButton: true,
    showVoiceReadButton: true,
    uploadScreenshot: api.uploadScreenshot,
    captureHostScreenshot: resolveSendBarHostScreenshotCapture(),
    getCaptureHostScreenshot: resolveSendBarHostScreenshotCapture,
    requestHostPagePick: resolveSendBarHostPagePick(),
    getRequestHostPagePick: resolveSendBarHostPagePick,
    getHostPagePickLabel,
    sendActions: [
      {
        id: 'fork-chat',
        label: t('sendBar.forkChatWithMessage'),
        icon: 'mdi-source-fork',
        onSelect: (message) => createChatFromSendAction(chat, message, true),
      },
      {
        id: 'new-chat',
        label: t('sendBar.newChatWithMessage'),
        icon: 'mdi-message-plus-outline',
        onSelect: (message) => createChatFromSendAction(chat, message, false),
      },
    ],
  });
  pane._sendBar = sendBar;
  pane.appendChild(sendBar.root);
  if (getChatSendBarResizeObserver() && sendBar.root instanceof HTMLElement) {
    getChatSendBarResizeObserver().observe(sendBar.root);
  }
  scheduleChatSendBarReserveSync();
  const restoredDraft = readChatDraft(chat.id);
  if (restoredDraft) {
    const inputEl = sendBar.input;
    if (inputEl) inputEl.value = restoredDraft;
  }
  pane.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.classList.contains('send-keys-input')) return;
    writeChatDraft(chat.id, target.value || '');
  });
  chat._stopDictationOnSend = sendBar.stopDictation;
  chat._startDictation = sendBar.startDictation;

  const chatTabs = document.getElementById('chat-tabs');
  if (!chatTabs) {
    scheduleOpenTerminalWhenReady(chat);
    return;
  }
  chatTabs.appendChild(pane);

  function scrollChatPaneIntoView() {
    const scrollIntoView = () => {
      viewportWrap.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };
    if (typeof window !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent)) {
      setTimeout(scrollIntoView, 150);
    } else {
      scrollIntoView();
    }
  }
  pane.addEventListener('focusin', scrollChatPaneIntoView);

  chat._connectionStatus = 'connecting';
  if (chat.id === activeChatId) setChatStatus('connecting');
  chat.pane = pane;

  chat._sdkRichView = createSdkRichView(chat, container, {
    appendPlain: (s) => processAgentOutput(chat, s),
    onHistoryRecord: (rec) => enqueueSdkStructuredHistoryRecord(chat, rec),
    loadOlderHistory: () => loadOlderSdkHistoryPage(chat),
    onFinishTitle: (title) => {
      patchChatTitle(chat, title, {
        source: 'finish-summary',
        logLabel: 'auto-title (finish summary):',
      });
    },
    onAssistantText: (text) => {
      // Only the chat on screen talks; background runs would overlap voices.
      if (chat.id === activeChatId) getChatSpeaker().handleAssistantText(text);
    },
    onAnswerEnd: () => {
      if (chat.id === activeChatId) getChatSpeaker().endAnswer();
    },
    onForceSendQueueItem: (text) => sendQueueControl(chat, 'queueForceSend', text),
    onRemoveQueueItem: (text) => sendQueueControl(chat, 'queueRemove', text),
    onOpenCodeQuestionReply: (payload) => sendOpenCodeQuestionReply(chat, payload),
    onOpenCodePermissionReply: (payload) => sendOpenCodePermissionReply(chat, payload),
  });
  chat.term = null;
  chat.fitAddon = null;
  chat._termContainer = container;
  chat._sdkOpenedAt = Date.now();
  beginSdkOpenTerminalHydration(chat);
  ensureChatConnection(chat);
  updateAwaitingInput(chat);
  renderChatTerminalState(chat);

  void (async () => {
      /** @type {unknown[]} */
      let hydratedRecords = [];
      try {
      const sessionKey = typeof chat.cursorSessionId === 'string' ? chat.cursorSessionId : '';
      const localState = await readSdkChatHistoryStateAsync(chat.id);

      // Flag: whether history was restored structurally (replay / applyAgentMessagesHistory).
      // If so — do NOT call appendRestoredPlainBuffer (double-restore bug: flattened
      // getCopyText() with banners/statuses would land as an extra "Reply" block).
      let structuredReplayDone = false;
      // Whether we only had formatted text (API without messages) — then a text fallback is OK.
      let fromApiFormattedOnly = false;

      const localHydration = await hydrateSdkRichViewFromLocalCache(chat, localState, sessionKey);
      hydratedRecords = localHydration.hydratedRecords;
      structuredReplayDone = localHydration.structuredReplayDone;

      // --- 1. SYNC WITH BACKEND: pull the log from the server (source of truth) ---
      try {
        const serverState = await pullChatHistoryFromServer(chat.id, {
          tail: CHAT_HISTORY_INITIAL_TAIL,
        });
        // A tail pull redefines the cache window, so the server cursor — not the leftover
        // local prefix — owns paging back from here on.
        if (serverState && typeof serverState.oldestLoadedSeq === 'number') {
          chat._historyOldestSeq = serverState.hasOlder ? serverState.oldestLoadedSeq : 0;
          chat._historyOlderLocal = [];
        }
        if (serverState && Array.isArray(serverState.events) && serverState.events.length > 0) {
          const events = serverState.events;
          const merged = await mergeServerSdkHistoryIntoRichView(
            chat,
            events,
            sessionKey || serverState.cursorSessionId || '',
            structuredReplayDone
          );
          hydratedRecords = merged.hydratedRecords;
          structuredReplayDone = merged.structuredReplayDone;
          // After pull, also try to flush a pending push (if the offline queue had events).
          void flushPendingPush(chat.id, sessionKey).catch(() => {});
        } else if (serverState && serverState.headSeq === 0) {
          // Empty server: do NOT backfill from local IDB — old local logs can be
          // corrupted (thinking fragments stored as deltas instead of snapshots).
          // Fallback: Cursor SDK API (Agent.messages.list) — the client only renders;
          // the server stays the authoritative history writer after the first run from this device.
        }
      } catch (_) {}

      // --- 2. FALLBACK: SDK API (Agent.messages.list) — only when the server had no history ---
      if (!structuredReplayDone) {
        try {
          const r = await api.getChatSdkMessages(chat.id, { limit: 250 });
          if (
            r?.ok &&
            Array.isArray(r.messages) &&
            r.messages.length > 0 &&
            typeof r.formatted === 'string'
          ) {
            chat._buffer = r.formatted.slice(-CHAT_BUFFER_MAX);
            persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
            const sdkHistoryRows = r.messages;
            const records = sdkHistoryRecordsFromAgentMessageRows(
              /** @type {Array<Record<string, unknown>>} */ (sdkHistoryRows)
            );
            const merged = mergeSdkHistoryWithRawEvents(records, localState, sessionKey);
            if (merged.length > 0 && sessionKey) {
              await replaceSdkChatHistoryRecords(chat.id, sessionKey, merged);
            }
            hydratedRecords = merged.length > 0 ? merged : records;
            if (chat._sdkRichView) {
              if (merged.length > records.length) {
                const windowed = takeSdkHistoryWindow(chat, sortRecordsByCreatedAt(merged));
                rememberHistoryWindowStart(chat, windowed, { reset: true });
                chat._sdkRichView.replayHistoryRecords(windowed, { instant: true });
              } else {
                rememberHistoryWindowStart(chat, records, { reset: true });
                chat._sdkRichView.applyAgentMessagesHistory(sdkHistoryRows);
              }
              structuredReplayDone = true;
              syncRichViewPlainBuffer(chat);
            }
          } else if (r?.ok && typeof r.formatted === 'string' && r.formatted.trim()) {
            chat._buffer = r.formatted.slice(-CHAT_BUFFER_MAX);
            persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
            fromApiFormattedOnly = true;
          }
        } catch (_) {}
      }

      // --- 3. FALLBACK: local store (IndexedDB / localStorage) — when server and API are silent ---
      if (!structuredReplayDone && !fromApiFormattedOnly && chat._sdkRichView) {
          const hasLocalEvents =
            !!localState && Array.isArray(localState.events) && localState.events.length > 0;
          if (sessionKey && hasLocalEvents) {
            if (localState.cursorSessionId !== sessionKey) {
              await replaceSdkChatHistoryRecords(chat.id, sessionKey, localState.events);
            }
            const chronological = sortRecordsByCreatedAt(localState.events);
            hydratedRecords = chronological;
            const windowed = takeSdkHistoryWindow(chat, chronological);
            rememberHistoryWindowStart(chat, windowed, { reset: true });
            chat._sdkRichView.replayHistoryRecords(windowed, { instant: true });
            structuredReplayDone = true;
            syncRichViewPlainBuffer(chat);
          } else {
            let sdkRestoreBuf = chat._buffer || '';
            if (!sdkRestoreBuf && chat.id) {
              // Await IDB hydration — readChatBufferSync (sync) may return '' when data is only in IDB.
              const saved = await hydrateChatBuffer(chat.id, CHAT_BUFFER_LOCALSTORAGE_PREFIX);
              if (saved) {
                sdkRestoreBuf = saved.slice(-CHAT_BUFFER_MAX);
                chat._buffer = sdkRestoreBuf;
              }
            }
          }
      }

      // --- 4. FINAL TEXT FALLBACK: only when no structural path succeeded ---
      // Do not stack a block on top of a correct replay (double-restore bug fix).
      if (!structuredReplayDone && chat._sdkRichView) {
        const plain = stripAnsi(chat._buffer || '');
        if (plain.trim()) {
          if (fromApiFormattedOnly) {
            chat._sdkRichView.appendRestoredPlainBuffer(
              plain,
              t('chat.restoredApiConversation', { chars: plain.length })
            );
          } else {
            chat._sdkRichView.appendRestoredPlainBuffer(plain);
          }
        }
      }

      } finally {
        clearSdkOpenTerminalHydrating(chat);
        chatTransport.completeSdkHistoryHydration(chat, hydratedRecords);
        ensureChatConnection(chat);
        updateAwaitingInput(chat);
        renderChatTerminalState(chat);
        armOlderSdkHistory(chat);
      }
    })();
}

function closeChatDeleteConfirmModal() {
  pendingDeleteChatId = null;
  chatDeleteConfirmModalApi?.close();
}

export function requestDeleteChat(chatId, options = {}) {
  if (!chatId) return;
  const skipConfirm = options.skipConfirm === true || getSkipChatDeleteConfirm();
  const preserveListOpen = options.preserveListOpen === true;
  if (skipConfirm) {
    if (!preserveListOpen) closeChatSettingsModal();
    if (!preserveListOpen) closeChatListModal();
    closeChat(chatId);
    return;
  }
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  pendingDeleteChatId = chatId;
  const titleEl = document.getElementById('chat-delete-confirm-chat-title');
  if (titleEl) titleEl.textContent = chat.title || chatId;
  if (!preserveListOpen) closeChatSettingsModal();
  if (!preserveListOpen) closeChatListModal();
  chatDeleteConfirmModalApi?.open();
}

function confirmDeleteChat(skipNextPrompt) {
  const chatId = pendingDeleteChatId;
  if (!chatId) {
    chatDeleteConfirmModalApi?.close();
    return;
  }
  if (skipNextPrompt) setSkipChatDeleteConfirm(true);
  closeChatDeleteConfirmModal();
  closeChat(chatId);
}

function findLastVisibleChatId(excludeChatId = '') {
  for (let index = chats.length - 1; index >= 0; index -= 1) {
    const chat = chats[index];
    if (!chat || chat.id === excludeChatId) continue;
    if (chat.archivedAt) continue;
    return chat.id;
  }
  return null;
}

async function requestArchiveChat(chatId, options = {}) {
  if (!chatId) return false;
  const switchToChatId =
    typeof options.switchToChatId === 'string' && options.switchToChatId.trim()
      ? options.switchToChatId.trim()
      : findLastVisibleChatId(chatId);
  let data = null;
  try {
    data = await api.archiveChat(chatId, true);
  } catch {
    data = null;
  }
  if (!data?.ok) {
    alert(data?.error || t('chat.archiveFailed'));
    return false;
  }
  closeChat(chatId, {
    skipApiDelete: true,
    switchToChatId,
  });
  await loadChatsFromServer({
    includeArchived: true,
    preferChatId: switchToChatId || '',
    skipAutoSelect: false,
  });
  if (switchToChatId && chats.some((entry) => entry.id === switchToChatId)) {
    selectChat(switchToChatId);
  }
  return true;
}

async function requestRestoreChat(chatId) {
  if (!chatId) return false;
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
    preferChatId: chatId,
    skipAutoSelect: false,
  });
  if (chats.some((entry) => entry.id === chatId)) {
    selectChat(chatId);
  }
  return true;
}

/**
 * Full chat delete: close the connection, UI, clear localStorage, remove on the backend.
 * @param {string} id - chat id (uuid)
 * @param {{ skipApiDelete?: boolean, switchToChatId?: string|null }} [options]
 */
export function closeChat(id, options = {}) {
  const idx = chats.findIndex((c) => c.id === id);
  const chat = idx === -1 ? null : chats[idx];
  const switchToChatId =
    typeof options.switchToChatId === 'string' && options.switchToChatId.trim()
      ? options.switchToChatId.trim()
      : null;
  if (!chat) {
    if (!options.skipApiDelete) {
      removedChatIds.add(id);
      api.deleteChat(id).catch(() => {});
    }
    if (activeChatId === id) {
      const fallbackId =
        switchToChatId && chats.some((c) => c.id === switchToChatId && !c.archivedAt)
          ? switchToChatId
          : findLastVisibleChatId(id);
      activeChatId = fallbackId;
      if (activeChatId) selectChat(activeChatId);
    }
    renderChatList();
    return;
  }
  if (chat._sdkHistoryFlushTimer) {
    clearTimeout(chat._sdkHistoryFlushTimer);
    chat._sdkHistoryFlushTimer = null;
  }
  chat._sdkHistoryPending = [];
  if (chat._recentOutputExpireTimer) {
    clearTimeout(chat._recentOutputExpireTimer);
    chat._recentOutputExpireTimer = null;
  }
  if (chat._reconnectTimer) {
    clearTimeout(chat._reconnectTimer);
    chat._reconnectTimer = null;
  }
  if (chat.ws && chat.ws.readyState !== WebSocket.CLOSED) chat.ws.close();
  if (chat._sdkRichView && typeof chat._sdkRichView.destroy === 'function') {
    chat._sdkRichView.destroy();
    chat._sdkRichView = null;
  }
  chatDiagnosticsApi.stopChatDiagPolling(chat);
  if (chat.term && typeof chat.term.dispose === 'function') chat.term.dispose();
  chat._termContainer = null;
  chat.pane?._sendBar?.destroy?.();
  if (chat.pane && chat.pane.parentNode) chat.pane.remove();
  chats.splice(idx, 1);
  clearChatLocalData(id);
  if (!options.skipApiDelete) {
    removedChatIds.add(id);
    api.deleteChat(id).catch(() => {});
  }
  if (activeChatId === id) {
    const fallbackId =
      switchToChatId && chats.some((c) => c.id === switchToChatId && !c.archivedAt)
        ? switchToChatId
        : findLastVisibleChatId(id);
    activeChatId = fallbackId;
    if (activeChatId) {
      selectChat(activeChatId);
    } else {
      if (typeof localStorage !== 'undefined') removeStorageValueWithAlias(localStorage, LAST_CHAT_ID_KEY);
      document.querySelectorAll('.chat-tab-pane').forEach((p) => p.classList.remove('active'));
    }
  }
  renderChatList();
}

/**
 * Return the Send field in the active chat pane (for quick commands).
 * When a send bar exists (e.g. multiline mode with a textarea above the bar), its input wins.
 * @returns {HTMLInputElement | HTMLTextAreaElement | null}
 */
export function getActiveSendInput() {
  const bar = getActiveSendBar();
  if (bar && bar.input) return bar.input;
  const pane = document.querySelector('.chat-tab-pane.active');
  return pane ? pane.querySelector('.send-keys-input') : null;
}

/**
 * Return the send bar of the active chat pane (for multiline mode).
 * @returns {{ setMultiline: (b: boolean) => void, isMultiline: () => boolean } | null}
 */
export function getActiveSendBar() {
  const pane = document.querySelector('.chat-tab-pane.active');
  return pane?._sendBar ?? null;
}

/**
 * Returns the terminal / transport state of the active chat (PTY, copying, special characters).
 * @returns {{ term: import('@xterm/xterm').Terminal | null, ws: WebSocket | null, agentTransport?: string }}
 */
export function getActiveChatTerminalState() {
  const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  if (!chat) return { term: null, ws: null };
  return {
    term: chat.term ?? null,
    ws: chat.ws || null,
    agentTransport: getChatAgentTransport(chat),
  };
}

/**
 * Copies from the active chat: xterm (selection / buffer) or SDK mode (text from the buffer).
 * @returns {Promise<boolean>}
 */
export async function copyActiveChatToClipboard() {
  const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  if (!chat?._sdkRichView) return false;
  const text = chat._sdkRichView.getCopyText().trimEnd();
  if (!text) return false;
  return writeTextToClipboard(text);
}

export function getActiveChatBufferTail(limit = 4000) {
  const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  if (!chat || typeof chat._buffer !== 'string') return '';
  return chat._buffer.slice(-Math.max(1, Number(limit) || 4000));
}

function openCreatedChatWithPrompt(chat, initialPrompt, displayText) {
  if (!chat?.id) return;
  chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  chat.sdkMode = normalizeSdkMode(chat.sdkMode);
  chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
  chats.push(chat);
  renderChatList();
  openTerminal(chat);
  selectChat(chat.id);

  let attempts = 0;
  const trySend = () => {
    attempts += 1;
    if (chat.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        sendTextToAgent(chat, initialPrompt, {
          displayText,
          sdkMode: chat.sdkMode,
        });
      }, 400);
      return;
    }
    if (attempts >= 80) return;
    setTimeout(trySend, 250);
  };
  ensureChatConnection(chat);
  trySend();
}

async function createChatFromSendAction(parentChat, message, forkConversation) {
  if (!parentChat?.id || !message?.trim()) return false;
  const parentTransport = normalizeNewChatHarness(parentChat?.agentTransport || 'sdk');
  let data;
  try {
    if (forkConversation) {
      const historySynced = await flushPendingPush(
        parentChat.id,
        parentChat.cursorSessionId || ''
      );
      if (!historySynced) {
        alert(t('sendBar.forkSyncFailed'));
        return false;
      }
      let sourceText = stripAnsi(
        parentChat._sdkRichView?.getCopyText?.() ||
        (typeof parentChat._buffer === 'string' ? parentChat._buffer : '') ||
        readChatBufferFromLocalStorage(parentChat.id)
      ).trim();
      if (sourceText.length < FORK_MIN_TEXT_LEN) {
        const fallbackText = await resolveChatTextForFork(parentChat);
        if (fallbackText.length > sourceText.length) sourceText = fallbackText;
      }
      data = await api.postChatFork(parentChat.id, { message, sourceText });
    } else {
      data = await api.postChat({
        workspaceFile: parentChat.workspaceFile,
        workspaceFolder: parentChat.workspaceFolder,
        model: parentChat.model,
        agentTransport: parentTransport,
        sdkMode: parentChat.sdkMode,
        sdkUiMode: parentChat.sdkUiMode,
      });
    }
  } catch (_) {
    alert(t('chat.serverConnectionError'));
    return false;
  }
  if (!data?.ok || !data.chat) {
    alert(data?.error || t('chat.createFailed', { detail: t('chat.unknownError') }));
    return false;
  }
  const workspaceContext = getWorkspaceContextForChat();
  data.chat.workspaceFile ||= parentChat.workspaceFile || workspaceContext?.workspaceFile;
  data.chat.workspaceFolder ||= parentChat.workspaceFolder || workspaceContext?.workspaceFolder;
  const initialPrompt = forkConversation ? data.initialPrompt || message : message;
  openCreatedChatWithPrompt(data.chat, initialPrompt, message);
  writeChatDraft(parentChat.id, '');
  return true;
}

const AGENT_MONITOR_PROMPT = [
  'This is a separate analytical chat about the agent running in the source chat.',
  'Using the context below, diagnose what the agent is doing right now: is it working, stuck, or waiting for input, what are the risks and what should happen next.',
  'Answer briefly and concretely, in these sections:',
  '1) Current state',
  '2) What it means',
  '3) Recommended next steps (max 5 bullets)',
  '4) What is missing for a confident diagnosis',
  'Do not trigger any external actions or callbacks.',
].join('\n');

function buildAgentMonitorMessage(chat) {
  if (!chat?.id) return AGENT_MONITOR_PROMPT;
  const status = getTerminalStateMeta(chat);
  const connection = typeof chat._connectionStatus === 'string' ? chat._connectionStatus : 'unknown';
  const agentState = getChatAgentState(chat);
  const awaiting = chat._awaitingInput === true ? 'yes' : 'no';
  const contextTokens =
    Number.isFinite(chat._contextUsageTotalTokens) && chat._contextUsageTotalTokens > 0
      ? String(chat._contextUsageTotalTokens)
      : 'unknown';
  return [
    AGENT_MONITOR_PROMPT,
    '',
    '[Source chat state snapshot]',
    `chatId: ${chat.id}`,
    `title: ${chat.title || 'untitled'}`,
    `connection: ${connection}`,
    `agentState: ${agentState}`,
    `terminalTone: ${status.tone}`,
    `terminalLabel: ${status.label}`,
    `awaitingInput: ${awaiting}`,
    `contextTokens: ${contextTokens}`,
  ].join('\n');
}

async function createAgentMonitorChat(parentChat, hintEl = null) {
  if (!parentChat?.id) {
    setTransientChatActionHint(hintEl, t('chat.noActiveChat'));
    return false;
  }
  const workspaceTarget = pickWorkspaceForAgentMonitor(parentChat);
  if (!workspaceTarget) return false;
  const message = buildAgentMonitorMessage(parentChat);
  let sourceText = stripAnsi(
    parentChat._sdkRichView?.getCopyText?.() ||
      (typeof parentChat._buffer === 'string' ? parentChat._buffer : '') ||
      readChatBufferFromLocalStorage(parentChat.id)
  ).trim();
  if (sourceText.length < FORK_MIN_TEXT_LEN) {
    sourceText = await resolveChatTextForFork(parentChat);
  }
  let data;
  try {
    data = await api.postChatFork(parentChat.id, {
      message,
      sourceText,
      workspaceFile: workspaceTarget.workspaceFile || undefined,
      workspaceFolder: workspaceTarget.workspaceFolder || undefined,
    });
  } catch (_) {
    setTransientChatActionHint(hintEl, t('chat.serverConnectionError'));
    return false;
  }
  if (!data?.ok || !data.chat) {
    setTransientChatActionHint(
      hintEl,
      data?.error || t('chat.createFailed', { detail: t('chat.unknownError') })
    );
    return false;
  }
  const workspaceContext = getWorkspaceContextForChat();
  data.chat.workspaceFile ||= parentChat.workspaceFile || workspaceContext?.workspaceFile;
  data.chat.workspaceFolder ||= parentChat.workspaceFolder || workspaceContext?.workspaceFolder;
  const initialPrompt = data.initialPrompt || message;
  openCreatedChatWithPrompt(
    data.chat,
    initialPrompt,
    t('chat.monitorAgentDisplayPrompt')
  );
  setTransientChatActionHint(hintEl, t('chat.monitorAgentStarted'));
  return true;
}

function getWorkspaceDefaultFolder(workspace) {
  if (!workspace || typeof workspace !== 'object') return '';
  if (typeof workspace.workspaceDir === 'string' && workspace.workspaceDir.trim()) {
    return workspace.workspaceDir.trim();
  }
  if (!Array.isArray(workspace.folders) || workspace.folders.length === 0) return '';
  const first = workspace.folders.find(
    (folder) => folder && typeof folder.resolvedPath === 'string' && folder.resolvedPath.trim()
  );
  return first?.resolvedPath?.trim() || '';
}

function pickWorkspaceForAgentMonitor(parentChat) {
  const items = Array.isArray(workspaces)
    ? workspaces.filter(
        (entry) =>
          entry &&
          typeof entry.workspaceFile === 'string' &&
          entry.workspaceFile.trim()
      )
    : [];
  if (items.length === 0) {
    return {
      workspaceFile: parentChat.workspaceFile || '',
      workspaceFolder: parentChat.workspaceFolder || '',
    };
  }
  if (items.length === 1) {
    const only = items[0];
    return {
      workspaceFile: only.workspaceFile,
      workspaceFolder:
        parentChat.workspaceFile === only.workspaceFile && parentChat.workspaceFolder
          ? parentChat.workspaceFolder
          : getWorkspaceDefaultFolder(only),
    };
  }
  const activeContext = getWorkspaceContextForChat();
  const preferredWorkspace = (parentChat.workspaceFile || activeContext?.workspaceFile || '').trim();
  const defaultIndex = Math.max(
    0,
    items.findIndex((entry) => entry.workspaceFile === preferredWorkspace)
  );
  const optionsText = items
    .map((entry, idx) => `${idx + 1}. ${entry.name || entry.workspaceFile}`)
    .join('\n');
  const picked = window.prompt(
    `${t('chat.monitorWorkspacePrompt')}\n\n${optionsText}`,
    String(defaultIndex + 1)
  );
  if (picked == null) return null;
  const index = Number.parseInt(String(picked).trim(), 10);
  if (!Number.isInteger(index) || index < 1 || index > items.length) {
    alert(t('chat.monitorWorkspaceInvalid'));
    return null;
  }
  const selected = items[index - 1];
  return {
    workspaceFile: selected.workspaceFile,
    workspaceFolder:
      parentChat.workspaceFile === selected.workspaceFile && parentChat.workspaceFolder
        ? parentChat.workspaceFolder
        : getWorkspaceDefaultFolder(selected),
  };
}

/**
 * Open the chat linked to a Todo (new or existing) and optionally send a start prompt.
 * @param {object} chat
 * @param {{ initialPrompt?: string, reused?: boolean }} [options]
 */
export function openTodoAgentChat(chat, options = {}) {
  if (!chat?.id) return;
  const existing = chats.find((c) => c.id === chat.id);
  if (existing) {
    const next = { ...chat };
    if (!next.agentTransport) delete next.agentTransport;
    if (!next.sdkMode) delete next.sdkMode;
    if (next.agentTransport) {
      next.agentTransport = normalizeNewChatHarness(next.agentTransport);
    }
    Object.assign(existing, next);
  } else {
    chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || 'sdk');
    if (!chat.sdkMode) chat.sdkMode = 'plan';
    chats.push(chat);
  }
  renderChatList();
  openTerminal(existing || chat);
  const active = chats.find((c) => c.id === chat.id) || chat;
  selectChat(active.id);

  const initialPrompt = typeof options.initialPrompt === 'string' ? options.initialPrompt.trim() : '';
  if (!initialPrompt || options.reused) return;

  const maxAttempts = 80;
  let attempts = 0;
  const trySend = () => {
    attempts += 1;
    if (active.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        sendTextWithEnterToTerminalState(active, initialPrompt, {
          sdkMode: active.sdkMode || 'plan',
          focusDelayMs: 600,
          sendEnterDelayMs: 250,
        });
      }, 400);
      return;
    }
    if (attempts >= maxAttempts) return;
    setTimeout(trySend, 250);
  };
  ensureChatConnection(active);
  trySend();
}

/**
 * Register a temporary fork chat on the list, connect in the background, and send the start prompt.
 * @param {object} chat
 * @param {{ initialPrompt?: string }} [options]
 */
function openTemporaryForkChat(chat, options = {}) {
  if (!chat?.id) return;
  chat.agentTransport = 'sdk';
  if (!chat.sdkMode) chat.sdkMode = 'agent';
  chat.isTemporary = true;
  const ctx = getWorkspaceContextForChat();
  if (!chat.workspaceFile && ctx?.workspaceFile) chat.workspaceFile = ctx.workspaceFile;
  if (!chat.workspaceFolder && ctx?.workspaceFolder) chat.workspaceFolder = ctx.workspaceFolder;
  const existing = chats.find((c) => c.id === chat.id);
  if (existing) {
    Object.assign(existing, chat);
  } else {
    chats.push(chat);
  }
  renderChatList();
  appLogger.log('fork-temp-chat', 'temporary chat added', {
    tempChatId: chat.id,
    forkParentChatId: chat.forkParentChatId,
    forkKind: chat.forkKind,
  });
  const active = chats.find((c) => c.id === chat.id) || chat;

  const initialPrompt = typeof options.initialPrompt === 'string' ? options.initialPrompt.trim() : '';
  if (!initialPrompt) {
    syncBackgroundChatConnections();
    return;
  }

  const maxAttempts = 80;
  let attempts = 0;
  const trySend = () => {
    attempts += 1;
    if (active.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        sendTextWithEnterToTerminalState(active, initialPrompt, {
          sdkMode: active.sdkMode || 'agent',
          focus: false,
          focusDelayMs: 400,
        });
      }, 400);
      return;
    }
    if (attempts >= maxAttempts) {
      appLogger.log('fork-temp-chat', 'initial prompt send exhausted', {
        tempChatId: active.id,
        forkKind: active.forkKind,
      });
      active._sdkRichView?.appendMetaNotice?.(t('chat.summaryForkWsFailed'));
      if (active.forkKind === 'summary' && active.forkParentChatId) {
        const parentChat = chats.find((entry) => entry.id === active.forkParentChatId);
        if (parentChat) {
          recoverChatAfterCompressionFailure(parentChat, 'summary_fork_ws_exhausted');
        }
      }
      return;
    }
    setTimeout(trySend, 250);
  };
  ensureChatConnection(active);
  syncBackgroundChatConnections();
  trySend();
}

/**
 * Removes the temporary fork chat from the UI; the server deletes it after the callback.
 * @param {string|null|undefined} tempChatId
 * @param {string|null|undefined} parentChatId
 */
function dismissTemporaryForkChat(tempChatId, parentChatId) {
  if (!tempChatId) return;
  const chat = chats.find((c) => c.id === tempChatId);
  if (!chat?.isTemporary) return;
  closeChat(tempChatId, {
    skipApiDelete: true,
    switchToChatId: parentChatId || chat.forkParentChatId || null,
  });
}

export function selectChat(id) {
  if (pinnedChatSelectionGuard) {
    performSelectChat(id);
    return;
  }

  if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) {
    performSelectChat(id);
    return;
  }

  pinnedChatSelectionGuard = true;
  void resolveChatSelectionForCurrentHostPage(id)
    .then((resolvedId) => {
      pinnedChatSelectionGuard = false;
      if (!resolvedId) return;
      performSelectChat(resolvedId);
    })
    .catch((error) => {
      pinnedChatSelectionGuard = false;
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
      pinnedTo: pinnedTo || undefined,
      skipAutoSelect: true,
      preferChatId: normalizedId,
    });
  }
  performSelectChat(normalizedId);
  forcedEmbedChatId = null;
}

function performSelectChat(id) {
  chats.forEach((chat) => {
    chat.pane?._sendBar?.closeSendMenu?.();
    chatDiagnosticsApi.stopChatContextUsageSync(chat);
  });
  recordChatLastUsed(id);
  recordChatActivity(id);
  notifySidebar();
  chatController.selectChat(id);
  scheduleChatSendBarReserveSync();
  const chat = chats.find((c) => c.id === id);
  if (chat && !chat.pane) openTerminal(chat);
  if (chat) {
    requestWidgetChatBinding(chat);
    syncWidgetPinUrlUi(chat);
    syncChatSdkModeUi(chat);
    renderChatTerminalState(chat);
    chatDiagnosticsApi.startChatContextUsageSync(chat);
    if (chat._sdkRichView) {
      setTimeout(() => chat._sdkRichView.scrollToBottom(), 50);
      if (!chat._sdkHistoryHydrating) {
        void syncSdkHistoryOnResume(chat, { reason: 'selectChat' }).catch((err) => {
          appLogger.log('chat-sync', 'selectChat catch-up failed', {
            chatId: chat.id,
            error: String(err?.message || err),
          });
        });
      }
      // Fetch real token usage from server diag in the background.
      const now = Date.now();
      if (!chat._contextUsageSyncAt || now - chat._contextUsageSyncAt > CHAT_CONTEXT_USAGE_SYNC_MS) {
        chat._contextUsageSyncAt = now;
        void api.getChatDiag(chat.id).then((res) => {
          chatDiagnosticsApi.applyServerContextUsageFromDiag(chat, res);
        }).catch((err) => {
          appLogger.log('chat-diag', 'server diag fetch failed', {
            chatId: chat.id,
            error: String(err?.message || err),
          });
        });
      }
    }
  }
  notifySidebar();
}

export function loadWorkspaces() {
  return chatController.loadWorkspaces().then(() => {
    chatNewModelDropdownApi?.refresh?.();
  });
}

export function loadChatsFromServer(query = {}) {
  return chatController.loadChatsFromServer(query).then(() => {
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

let embedChatCreationPromise = null;
/** Preferred chat id from widget host (plus / pin open) — wins over ensureEmbedChat fallback. */
let forcedEmbedChatId = null;

/**
 * @param {string | null | undefined} chatId
 */
export function setForcedEmbedChatId(chatId) {
  const normalized = String(chatId || '').trim();
  forcedEmbedChatId = normalized || null;
}

function findFirstUnpinnedChat(chatList) {
  if (!Array.isArray(chatList)) return null;
  return chatList.find((chat) => !getChatWidgetPinnedUrl(chat)) || null;
}

/**
 * @param {Array<object>} existing
 * @returns {Promise<{ chatId: string|null, skipPinnedNavigation: boolean, shouldCreate: boolean, pinnedTo?: string }>}
 */
async function resolveEmbedChatSelectionId(existing) {
  const pendingChatId = consumePendingWidgetChatSelection();
  if (pendingChatId && existing.some((chat) => chat.id === pendingChatId)) {
    forcedEmbedChatId = null;
    return { chatId: pendingChatId, skipPinnedNavigation: true, shouldCreate: false };
  }

  if (forcedEmbedChatId) {
    const forcedId = forcedEmbedChatId;
    if (existing.some((chat) => chat.id === forcedId)) {
      forcedEmbedChatId = null;
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
  if (forcedEmbedChatId) {
    return {
      chatId: forcedEmbedChatId,
      skipPinnedNavigation: true,
      shouldCreate: false,
      reloadPreferChatId: forcedEmbedChatId,
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

async function applyEmbedChatSelection(existing) {
  const resolved = await resolveEmbedChatSelectionId(existing);
  // Host plus/select may win while this async resolution was in flight.
  if (forcedEmbedChatId) {
    const forcedId = forcedEmbedChatId;
    await loadChatsFromServer({
      skipAutoSelect: true,
      preferChatId: forcedId,
      pinnedTo: resolved?.pinnedTo || undefined,
    });
    performSelectChat(forcedId);
    forcedEmbedChatId = null;
    return getChatsList().find((chat) => chat.id === forcedId) || null;
  }
  if (resolved?.noPinnedForPage) {
    return null;
  }
  if (resolved?.pinnedTo || resolved?.reloadPreferChatId) {
    await loadChatsFromServer({
      pinnedTo: resolved.pinnedTo || undefined,
      skipAutoSelect: true,
      preferChatId: resolved.reloadPreferChatId || resolved.chatId || undefined,
    });
  }
  if (forcedEmbedChatId) {
    const forcedId = forcedEmbedChatId;
    performSelectChat(forcedId);
    forcedEmbedChatId = null;
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
  if (forcedEmbedChatId) {
    const forcedId = forcedEmbedChatId;
    performSelectChat(forcedId);
    forcedEmbedChatId = null;
    return getChatsList().find((chat) => chat.id === forcedId) || null;
  }
  performSelectChat(preferredId);
  return getChatsList().find((chat) => chat.id === preferredId) || null;
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

/**
 * Pull only name/model changes from the backend and merge them into the local list.
 * Does not touch terminals/WS, so it also works for an inactive chat.
 */
function syncChatTitlesFromServer() {
  if (chatTitlesSyncInFlight) return;
  if (typeof document !== 'undefined') {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    const chatPanel = document.getElementById('chat-panel');
    if (!chatPanel?.classList.contains('active')) return;
  }
  if (chats.length === 0) return;
  chatTitlesSyncInFlight = true;
  api.getChats().then((data) => {
    if (!data?.ok || !Array.isArray(data.chats)) return;
    const serverIds = new Set(data.chats.map((c) => c.id));
    let changed = false;
    for (const local of [...chats]) {
      if (!local.isTemporary || serverIds.has(local.id)) continue;
      closeChat(local.id, {
        skipApiDelete: true,
        switchToChatId: local.forkParentChatId || null,
      });
      changed = true;
    }
    for (const serverChat of data.chats) {
      const local = chats.find((c) => c.id === serverChat.id);
      if (!local) continue;
      const nextTitle = typeof serverChat.title === 'string' ? serverChat.title : local.title;
      const nextModel = typeof serverChat.model === 'string' ? serverChat.model : local.model;
      if ((local.title || '') !== (nextTitle || '')) {
        local.title = nextTitle;
        changed = true;
      }
      if ((local.model || 'auto') !== (nextModel || 'auto')) {
        local.model = nextModel || 'auto';
      }
    }
    if (!changed) return;
    renderChatList();
    updateChatBarSelect();
  }).catch(() => {
  }).finally(() => {
    chatTitlesSyncInFlight = false;
  });
}

/**
 * Open the “New chat” modal. Workspace comes from the header/sidebar context,
 * and in the form the user can change only the folder.
 */
let cachedSdkReady = null;
let cachedOpenRouterReady = null;
let cachedOpenCodeReady = null;

/**
 * @param {unknown} value
 * @returns {'sdk' | 'openrouter' | 'opencode'}
 */
function normalizeNewChatHarness(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'opencode') return 'opencode';
  return 'sdk';
}

function getSelectedNewChatHarness() {
  const harnessSel = document.getElementById('chat-new-harness-select');
  return normalizeNewChatHarness(harnessSel?.value || 'sdk');
}

/** Harness readiness error shown in the new-chat modal. Resolved lazily so i18n is initialized. */
function getNewChatHarnessError(harness) {
  if (harness === 'openrouter') return t('chat.harnessErrorOpenrouter');
  if (harness === 'opencode') return t('chat.harnessErrorOpencode');
  return t('chat.harnessErrorSdk');
}

function applyNewChatHarnessStatus(harness, ready, errorMessage) {
  const resolvedHarness = normalizeNewChatHarness(harness);
  const createBtn = document.getElementById('chat-new-create');
  const hint = document.getElementById('chat-new-sdk-hint');
  if (resolvedHarness === 'openrouter') {
    cachedOpenRouterReady = ready;
  } else if (resolvedHarness === 'opencode') {
    cachedOpenCodeReady = ready;
  } else {
    cachedSdkReady = ready;
  }
  if (createBtn) createBtn.disabled = !ready;
  if (!hint) return;
  if (ready) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }
  hint.hidden = false;
  hint.textContent = errorMessage || getNewChatHarnessError(resolvedHarness);
}

function isEmbedWidgetMode() {
  return typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
}

function ensureEmbedNewChatFolderSelect() {
  if (!isEmbedWidgetMode()) return;
  const ctx = getWorkspaceContextForChat();
  if (!ctx?.workspaceFolder) return;
  const folderSel = document.getElementById('chat-new-folder-select');
  if (!folderSel) return;
  if (folderSel.options.length > 0) return;
  const folderName = ctx.workspaceFolder.split('/').filter(Boolean).pop() || ctx.workspaceFolder;
  folderSel.innerHTML =
    '<option value="' +
    escapeHtml(ctx.workspaceFolder) +
    '">' +
    escapeHtml(folderName) +
    '</option>';
  folderSel.value = ctx.workspaceFolder;
  selectedWorkspaceFolder = ctx.workspaceFolder;
  chatNewFolderDropdownApi?.refresh?.();
}

function applySdkStatusToUi(r) {
  // The backend localises this error, so match both languages it can return.
  if (
    r &&
    r.ok === false &&
    /unavailable in a widget session|niedostępny w sesji widgetu/i.test(String(r.error || ''))
  ) {
    applyNewChatHarnessStatus('sdk', false, t('chat.sdkWidgetNeedsServerUpdate'));
    return;
  }
  const modelsChanged = chatModelSelectApi.applyAvailableModelsFromSdkStatus(r);
  if (getSelectedNewChatHarness() === 'sdk') {
    chatModelSelectApi.refreshNewChatModelPicker('sdk');
  } else if (modelsChanged) {
    chatModelSelectApi.refreshModelSelectLabels();
  }
  const ready = !!(r && r.ok && r.ready);
  if (getSelectedNewChatHarness() === 'sdk') {
    applyNewChatHarnessStatus('sdk', ready);
  } else {
    cachedSdkReady = ready;
  }
}

function applyOpenRouterStatusToUi(r) {
  if (Array.isArray(r?.models)) {
    chatModelSelectApi.applyAvailableModelsFromOpenRouter(r);
  }
  const invalidFormat = !!r?.openrouterApiKeyInvalidFormat;
  const ready = !!(r && r.openrouterApiKeyEffective);
  if (getSelectedNewChatHarness() === 'openrouter') {
    chatModelSelectApi.refreshNewChatModelPicker('openrouter');
    applyNewChatHarnessStatus(
      'openrouter',
      ready,
      invalidFormat
        ? 'Invalid OpenRouter API key format — use a key from openrouter.ai/keys (starts with sk-or-v1-).'
        : undefined,
    );
  } else {
    cachedOpenRouterReady = ready;
  }
}

function refreshNewChatSdkStatus() {
  return api
    .getAgentSdkStatus()
    .then((r) => applySdkStatusToUi(r))
    .catch(() => {
      if (getSelectedNewChatHarness() === 'sdk') {
        applyNewChatHarnessStatus(
          'sdk',
          false,
          t('chat.sdkCheckFailed'),
        );
      } else {
        cachedSdkReady = false;
      }
    });
}

function refreshNewChatOpenRouterStatus() {
  return api
    .getOpenRouterStatus()
    .then((status) => {
      applyOpenRouterStatusToUi(status);
      if (!status?.openrouterApiKeyEffective) return null;
      return api.getOpenRouterModels().then((models) => {
        chatModelSelectApi.applyAvailableModelsFromOpenRouter(models);
        if (getSelectedNewChatHarness() === 'openrouter') {
          chatModelSelectApi.refreshNewChatModelPicker('openrouter');
        }
      });
    })
    .catch(() => {
      if (getSelectedNewChatHarness() === 'openrouter') {
        applyNewChatHarnessStatus(
          'openrouter',
          false,
          t('chat.openrouterStatusFailed'),
        );
      } else {
        cachedOpenRouterReady = false;
      }
    });
}

function refreshNewChatOpenCodeStatus(options = {}) {
  const params = resolveOpenCodeCatalogParamCandidates()[0] || {};
  const pickerOptions = { forceCloseDropdown: options.forceCloseDropdown === true };
  return api
    .getOpenCodeStatus(params)
    .then((status) => {
      const keyOk = !!status?.opencodeApiKeyEffective;
      const ready = !!(status && status.opencodeReady);
      if (getSelectedNewChatHarness() === 'opencode') {
        applyNewChatHarnessStatus(
          'opencode',
          ready,
          keyOk ? status?.error : t('chat.opencodeKeyMissing'),
        );
      } else {
        cachedOpenCodeReady = ready;
      }
      if (!keyOk) return null;
      return fetchOpenCodeModelsCatalog().then((models) => {
        if (models?.ok) chatModelSelectApi.applyAvailableModelsFromOpenCode(models);
        const hasModels = !!(models?.ok && Array.isArray(models.models) && models.models.length > 0);
        if (getSelectedNewChatHarness() === 'opencode') {
          chatModelSelectApi.refreshNewChatModelPicker('opencode', pickerOptions);
          applyNewChatHarnessStatus(
            'opencode',
            ready && hasModels,
            models?.error || (hasModels ? undefined : t('chat.opencodeNoModels')),
          );
        } else {
          chatModelSelectApi.refreshModelSelectLabels();
          void refreshSdkModeBarCombinedPicker();
        }
        cachedOpenCodeReady = ready && hasModels;
      });
    })
    .catch(() => {
      if (getSelectedNewChatHarness() === 'opencode') {
        applyNewChatHarnessStatus(
          'opencode',
          false,
          t('chat.opencodeStatusFailed'),
        );
      } else {
        cachedOpenCodeReady = false;
      }
    });
}

function reloadOpenCodeModelsCatalog(chat = null) {
  return fetchOpenCodeModelsCatalog(chat).then(async (data) => {
    if (data?.ok) chatModelSelectApi.applyAvailableModelsFromOpenCode(data);
    chatModelSelectApi.refreshModelSelectLabels();
    const bar = document.querySelector('cr-sdk-mode-bar');
    const pendingHarness = String(bar?.pendingHarness || '').trim();
    if (bar && pendingHarness) {
      syncPendingHarnessBarModels(bar, pendingHarness);
    }
    await refreshSdkModeBarCombinedPicker({
      reopenDropdown: !!pendingHarness && bar?.pickerStep === 'model',
    });
    return data;
  });
}

function refreshNewChatHarnessStatus(options = {}) {
  const harness = getSelectedNewChatHarness();
  chatModelSelectApi.refreshNewChatModelPicker(harness, {
    forceCloseDropdown: options.forceCloseDropdown === true,
  });
  if (harness === 'openrouter') {
    return refreshNewChatOpenRouterStatus(options);
  }
  if (harness === 'opencode') {
    return refreshNewChatOpenCodeStatus(options);
  }
  return refreshNewChatSdkStatus();
}

function refreshModelCatalogFromServer() {
  return api
    .getAgentSdkStatus()
    .then((r) => {
      const changed = chatModelSelectApi.applyAvailableModelsFromSdkStatus(r);
      if (changed) chatModelSelectApi.refreshModelSelectLabels();
      cachedSdkReady = !!(r && r.ok && r.ready);
    })
    .catch(() => {});
}

export function openNewChatModal(options = {}) {
  if (!chatNewModalApi) return;
  applyDefaultNewChatHarnessToModal();
  const harnessSel = document.getElementById('chat-new-harness-select');
  if (harnessSel instanceof HTMLSelectElement && selectedHarness) {
    harnessSel.value = normalizeNewChatHarness(selectedHarness);
  }
  chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
  const preferredWorkspaceFile =
    options && typeof options.workspaceFile === 'string' ? options.workspaceFile.trim() : '';
  const preferredWorkspaceFolder =
    options && typeof options.workspaceFolder === 'string' ? options.workspaceFolder.trim() : '';
  const ctx = getWorkspaceContextForChat();
  selectedWorkspaceFile =
    preferredWorkspaceFile || ctx?.workspaceFile || (workspaces[0] && workspaces[0].workspaceFile) || null;
  selectedWorkspaceFolder = preferredWorkspaceFolder || ctx?.workspaceFolder || null;
  chatController.renderWorkspacesSelects();
  ensureEmbedNewChatFolderSelect();
  const model = document.getElementById('chat-new-model-select');
  if (model) {
    model.value = selectedModel || 'auto';
    chatNewModelDropdownApi?.refresh?.();
  }
  chatNewFolderDropdownApi?.refresh?.();
  const titleInput = document.getElementById('chat-new-title-input');
  if (titleInput) {
    titleInput.value = '';
    titleInput.placeholder = t('chat.optionalNamePlaceholder');
  }
  const createBtn = document.getElementById('chat-new-create');
  const harness = getSelectedNewChatHarness();
  const harnessReady =
    harness === 'openrouter'
      ? cachedOpenRouterReady !== null
        ? cachedOpenRouterReady
        : false
      : harness === 'opencode'
        ? cachedOpenCodeReady !== null
          ? cachedOpenCodeReady
          : false
        : cachedSdkReady !== null
          ? cachedSdkReady
          : false;
  if (createBtn) createBtn.disabled = !harnessReady;
  const hint = document.getElementById('chat-new-sdk-hint');
  if (hint && !harnessReady) {
    hint.hidden = false;
    hint.textContent = getNewChatHarnessError(harness);
  } else if (hint) {
    hint.hidden = true;
    hint.textContent = '';
  }
  chatNewModalApi.open();
  if (titleInput) titleInput.focus();
  void loadWorkspaces().then(() => {
    ensureEmbedNewChatFolderSelect();
    chatNewModelDropdownApi?.refresh?.();
    const m = document.getElementById('chat-new-model-select');
    if (m) m.value = selectedModel || 'auto';
  });
  void refreshNewChatHarnessStatus();
}

function closeNewChatModal() {
  chatNewFolderDropdownApi?.close?.();
  chatNewModelDropdownApi?.close?.();
  chatNewModalApi?.close();
}

/**
 * Creates a chat from voice Live: active workspace, or the one the user named.
 *
 * @param {{ title?: string, workspace?: string }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   chatId?: string,
 *   title?: string,
 *   workspace?: string,
 *   harness?: string,
 *   error?: string,
 *   workspaces?: string[],
 * }>}
 */
export async function createVoiceChat(options = {}) {
  const title = String(options.title || '').trim();
  const spoken = String(options.workspace || '').trim();
  await loadWorkspaces();
  const items = Array.isArray(workspaces)
    ? workspaces.filter((entry) => entry && String(entry.workspaceFile || '').trim())
    : [];
  const activeChat = chats.find((chat) => chat.id === activeChatId) || null;
  const ctx = getWorkspaceContextForChat();
  let chosen = null;
  if (spoken) {
    const result = matchWorkspaceBySpokenName(items, spoken);
    if (result.ambiguous) {
      return {
        ok: false,
        error: `Several workspaces match "${spoken}"`,
        workspaces: result.candidates,
      };
    }
    if (!result.match) {
      return {
        ok: false,
        error: `Workspace not found: ${spoken}`,
        workspaces: items.map((entry) => workspaceSpokenLabel(entry)).slice(0, 12),
      };
    }
    chosen = result.match;
  } else {
    const preferredFile = (activeChat?.workspaceFile || ctx?.workspaceFile || '').trim();
    chosen =
      items.find((entry) => normalizePath(entry.workspaceFile) === normalizePath(preferredFile)) ||
      items[0] ||
      null;
  }
  const workspaceFile = String(
    chosen?.workspaceFile || activeChat?.workspaceFile || ctx?.workspaceFile || ''
  ).trim();
  if (!workspaceFile) return { ok: false, error: 'No workspace available' };
  const sameAsActive = normalizePath(workspaceFile) === normalizePath(activeChat?.workspaceFile || '');
  const sameAsHeader = normalizePath(workspaceFile) === normalizePath(ctx?.workspaceFile || '');
  const workspaceFolder = String(
    (sameAsActive && activeChat?.workspaceFolder) ||
      (sameAsHeader && ctx?.workspaceFolder) ||
      getWorkspaceDefaultFolder(chosen) ||
      ''
  ).trim();
  if (!workspaceFolder) return { ok: false, error: 'Workspace has no folder' };
  const harness = normalizeNewChatHarness(selectedHarness || activeChat?.agentTransport || 'sdk');
  const payload = {
    workspaceFile,
    workspaceFolder,
    agentTransport: harness,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  };
  if (title) payload.title = title;
  let data;
  try {
    data = await api.postChat(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data?.ok || !data.chat?.id) {
    return { ok: false, error: data?.error || 'Could not create the chat' };
  }
  const chat = data.chat;
  chat.agentTransport = normalizeNewChatHarness(chat.agentTransport);
  chat.sdkMode = normalizeSdkMode(chat.sdkMode);
  chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
  chat.workspaceFile ||= workspaceFile;
  chat.workspaceFolder ||= workspaceFolder;
  if (!chats.some((entry) => entry.id === chat.id)) chats.push(chat);
  const headerFile = String(ctx?.workspaceFile || '').trim();
  if (headerFile && normalizePath(headerFile) !== normalizePath(workspaceFile)) {
    window.dispatchEvent(
      new CustomEvent('cretli-request-workspace', {
        detail: { workspaceFile, workspaceFolder },
      })
    );
  }
  renderChatList();
  openTerminal(chat);
  selectChat(chat.id);
  notifySidebar();
  return {
    ok: true,
    chatId: chat.id,
    title: String(chat.title || title || '').trim() || 'untitled',
    workspace: chosen ? workspaceSpokenLabel(chosen) : workspaceSpokenLabel({ workspaceFile }),
    harness,
  };
}

/**
 * Create a new chat from the modal values (folder and model; workspace from context).
 */
function createChatFromModal() {
  const modelSel = document.getElementById('chat-new-model-select');
  ensureEmbedNewChatFolderSelect();
  const createCtx = resolveChatCreationWorkspaceContext();
  if (!createCtx.workspaceFile) {
    alert(t('chat.noWorkspaceSelected'));
    return;
  }
  if (!createCtx.workspaceFolder) {
    if (isEmbedWidgetMode()) {
      alert(t('chat.widgetMissingWorkspaceFolder'));
    } else {
      alert(t('chat.selectFolderInNewChatForm'));
    }
    return;
  }
  const titleInput = document.getElementById('chat-new-title-input');
  const title = (titleInput?.value || '').trim();
  const chosenModel = normalizeModelValue(modelSel?.value);
  const harness = getSelectedNewChatHarness();
  const createBtn = document.getElementById('chat-new-create');
  if (createBtn?.disabled) {
    alert(
      harness === 'openrouter'
        ? t('chat.openrouterDisabled')
        : harness === 'opencode'
          ? t('chat.opencodeDisabled')
          : t('chat.sdkDisabled')
    );
    return;
  }
  const payload = {
    workspaceFile: createCtx.workspaceFile,
    workspaceFolder: createCtx.workspaceFolder,
    model: chosenModel,
    agentTransport: harness,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  };
  if (title) payload.title = title;
  const attachHostUrlPin = () => {
    if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) {
      return Promise.resolve('');
    }
    return requestWidgetHostUrl()
      .then((current) => (typeof current?.url === 'string' ? current.url.trim() : ''))
      .catch(() => '');
  };
  selectedModel = chosenModel;
  selectedHarness = normalizeNewChatHarness(harness);
  saveLastSelectedModel(chosenModel);
  saveLastSelectedHarness(selectedHarness);
  void attachHostUrlPin().then((hostPageUrl) => {
    if (hostPageUrl) payload.widgetPinnedUrl = hostPageUrl;
    return api.postChat(payload);
  })
    .then((data) => {
      if (!data.ok) {
        alert(t('chat.createFailed', { detail: data.error || t('chat.unknownError') }));
        return;
      }
      const chat = data.chat;
      chat.agentTransport = normalizeNewChatHarness(chat.agentTransport);
      chat.sdkMode = normalizeSdkMode(chat.sdkMode);
      chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
      if (typeof data.chat?.widgetPinnedUrl === 'string' && data.chat.widgetPinnedUrl.trim()) {
        chat.widgetPinnedUrl = data.chat.widgetPinnedUrl.trim();
      }
      chats.push(chat);
      renderChatList();
      openTerminal(chat);
      selectChat(chat.id);
      syncWidgetPinUrlUi(chat);
      notifyWidgetParentPagePinChanged();
      closeNewChatModal();
    })
    .catch(() => alert(t('chat.serverConnectionError')));
}

export function fitAllChats() {
  const active = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  active?._sdkRichView?.scrollToBottom?.();
}

/**
 * Toggle chat fullscreen mode (pseudo-fullscreen).
 */
function toggleChatFullscreen() {
  const body = document.body;
  const btn = document.getElementById('chat-fullscreen-btn');
  const isOn = body.classList.toggle('chat-fullscreen-active');
  if (btn) {
    const label = isOn ? t('chat.fullscreenExit') : t('chat.fullscreen');
    const icon = isOn ? 'mdi-fullscreen-exit' : 'mdi-fullscreen';
    btn.setAttribute('data-fullscreen', isOn ? 'on' : 'off');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    btn.innerHTML =
      `<span class="mdi ${icon}" aria-hidden="true"></span>` +
      `<span class="chat-toolbar-action-label">${escapeHtml(label)}</span>`;
  }
  if (isOn) fitAllChats();
}

/**
 * Apply the “show send field” preference (class on #chat-panel).
 */
function applySendFieldPreference() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  const show =
    typeof localStorage !== 'undefined' &&
    readStorageValueWithAlias(localStorage, SHOW_SEND_FIELD_KEY, '') !== 'false';
  panel.classList.toggle('hide-send-field', !show);
  scheduleChatSendBarReserveSync();
}

/**
 * Force a chat WebSocket reconnect (close the current one and call ensureChatConnection).
 * @param {object} chat
 */
function forceReconnectChat(chat) {
  if (chatDiagnosticsApi?.forceReconnectChat) {
    chatDiagnosticsApi.forceReconnectChat(chat);
    return;
  }
  if (!chat) return;
  chat._intentionalWsReconnectAt = Date.now();
  if (chat._reconnectTimer) {
    clearTimeout(chat._reconnectTimer);
    chat._reconnectTimer = null;
  }
  chat._reconnectAttempts = 0;
  delete chat._wsConnectingSince;
  if (chat.ws) {
    try {
      chat.ws.onclose = null;
      chat.ws.close();
    } catch (_) { /* ignore */ }
    chat.ws = null;
  }
  ensureChatConnection(chat);
}

async function resetSdkChatRoom(chat, hintEl) {
  if (chatDiagnosticsApi?.resetSdkChatRoom) {
    return chatDiagnosticsApi.resetSdkChatRoom(chat, hintEl);
  }
}

/**
 * Send cancel to the current SDK run of the chat.
 * @param {object} chat
 */
function cancelChatRun(chat) {
  if (!chat) return;
  if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'cancel' }));
}

function normalizeAutoContextCompressionThreshold(value) {
  return normalizeAutoContextCompressionThresholdPercent(value);
}

function maybeScheduleAutoContextCompression(chat, fillPercent) {
  if (!isAutoContextCompressionEnabled(chat)) return;
  if (chat._autoContextCompressionPending) return;
  if (chat._contextCompressionRunning) return;
  const threshold = normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold);
  if (!shouldTriggerAutoContextCompression(fillPercent, threshold)) return;
  chat._autoContextCompressionPending = true;
  chat._sdkRichView?.appendMetaNotice?.(
    t('chat.autoContextCompressionScheduled', { percent: threshold })
  );
}

function isAutoContextCompressionEnabled(chat) {
  if (!chat || chat.agentTransport !== 'sdk') return false;
  return chat.autoContextCompressionEnabled === true;
}

function shouldResetAfterContextCompression(chat) {
  if (!chat) return true;
  return chat.autoContextCompressionReset !== false;
}

function setTransientChatActionHint(hintEl, message, timeoutMs = 6000) {
  if (!hintEl) return;
  hintEl.textContent = message;
  setTimeout(() => {
    if (hintEl.textContent === message) hintEl.textContent = '';
  }, timeoutMs);
}

async function runIntentionalSummary(chat, hintEl = null, source = 'manual') {
  if (!chat || chat.agentTransport !== 'sdk') {
    setTransientChatActionHint(hintEl, t('chat.contextSummarySdkOnly'));
    return false;
  }
  if (chat._contextCompressionRunning) {
    setTransientChatActionHint(hintEl, t('chat.contextSummaryRunning'));
    return false;
  }
  chat._contextCompressionRunning = true;
  armContextCompressionWatchdog(chat);
  const creatingMessage = t('chat.contextSummaryCreating');
  if (hintEl) hintEl.textContent = creatingMessage;
  chat._sdkRichView?.appendMetaNotice?.(creatingMessage);
  try {
    const { result, error } = await requestSummaryFromForkAsync(chat, (tempChat) => {
      if (!hintEl) return;
      hintEl.textContent = t('chat.contextSummaryTempChat', {
        title: tempChat.title || '[Temp]',
      });
    });
    if (!result || typeof result.summary !== 'string' || !result.summary.trim()) {
      const message = error || t('chat.contextSummaryFailed');
      chat._autoContextCompressionPending = false;
      if (hintEl) hintEl.textContent = message;
      chat._sdkRichView?.appendMetaNotice?.(t('chat.contextSummaryErrorMeta', { message }));
      appLogger.log('fork-summary', 'intentional summary failed', { chatId: chat.id, error: message });
      recoverChatAfterCompressionFailure(chat, 'summary_failed');
      return false;
    }
    const summary = result.summary.trim();
    chat._autoContextCompressionPending = false;
    chat._contextAdvisoryDismissed = false;
    if (shouldResetAfterContextCompression(chat)) {
      const resetOk = await resetChatSdkContext(chat, hintEl);
      if (!resetOk) return false;
      const seedSummary = buildSeedSummaryFromSummaries(chat.summaries) || summary;
      chat._contextSeedSummary = seedSummary;
      chat._sdkRichView?.appendMetaNotice?.(t('chat.contextSummaryReadySeedMeta'));
      if (hintEl) {
        hintEl.textContent =
          source === 'auto'
            ? t('chat.contextSummaryReadyResetAuto')
            : t('chat.contextSummaryReadyResetManual');
      }
      chatDiagnosticsApi?.updateChatContextMeter?.(
        chat,
        chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
      );
      return true;
    }
    chat._sdkRichView?.appendMetaNotice?.(t('chat.contextSummarySavedNoReset'));
    if (hintEl) hintEl.textContent = t('chat.contextSummarySavedNoReset');
    return true;
  } catch (err) {
    const message = String(err?.message || err || t('chat.contextSummaryFailed'));
    chat._autoContextCompressionPending = false;
    if (hintEl) hintEl.textContent = message;
    chat._sdkRichView?.appendMetaNotice?.(t('chat.contextSummaryErrorMeta', { message }));
    appLogger.log('fork-summary', 'intentional summary error', { chatId: chat.id, error: message });
    recoverChatAfterCompressionFailure(chat, 'summary_error');
    return false;
  } finally {
    disarmContextCompressionWatchdog(chat);
    chat._contextCompressionRunning = false;
    if (hintEl) {
      setTimeout(() => {
        if (hintEl.textContent) hintEl.textContent = '';
      }, 7000);
    }
  }
}

function onChatSdkRunFinished(chat, msg) {
  const acc = typeof chat?._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
  const finishTitle = splitTrailingTitleJson(acc).title;
  if (finishTitle) {
    patchChatTitle(chat, finishTitle, {
      source: 'finish-summary',
      logLabel: 'auto-title (finish summary):',
    });
  }
  if (!isAutoContextCompressionEnabled(chat)) return;
  if (chat._contextCompressionRunning) return;
  if (!chat._autoContextCompressionPending) return;
  const status = typeof msg?.status === 'string' ? msg.status.trim().toLowerCase() : '';
  if (
    !status ||
    status === 'idle_timeout' ||
    status === 'error' ||
    status === 'run_failed' ||
    status === 'cancelled' ||
    status === 'plan_guard_cancelled'
  ) {
    return;
  }
  const remaining = Number(msg?.remaining);
  if (Number.isFinite(remaining) && remaining > 0) return;
  queueMicrotask(() => {
    void runIntentionalSummary(chat, null, 'auto');
  });
}

/**
 * Start a fresh SDK agent session: cancel the current run, clear the view, reset context.
 * @param {object} chat
 * @param {HTMLElement | null} [hintEl]
 */
async function startNewAgent(chat, hintEl = null) {
  if (!chat || chat.agentTransport !== 'sdk') {
    setTransientChatActionHint(hintEl, t('chat.newAgentSdkOnly'));
    return false;
  }
  if (chat._sdkContextResetPending) {
    setTransientChatActionHint(hintEl, t('chat.newAgentStarting'));
    return false;
  }
  cancelChatRun(chat);
  chat._sdkRichView?.onStreamReset?.();
  return resetChatSdkContext(chat, hintEl);
}

/**
 * Reset the SDK agent context for the chat and force a fresh session.
 * @param {object} chat
 * @param {HTMLElement | null} [hintEl]
 */
async function resetChatSdkContext(chat, hintEl = null) {
  if (!chat || chat.agentTransport !== 'sdk') {
    setTransientChatActionHint(hintEl, t('chat.resetContextSdkOnly'));
    return false;
  }
  if (chat._sdkContextResetPending) {
    setTransientChatActionHint(hintEl, t('chat.resetContextRunning'));
    return false;
  }
  chat._sdkContextResetPending = true;
  if (hintEl) hintEl.textContent = t('chat.resetContextInProgress');
  try {
    const res = await api.postChatResetSdkContext(chat.id);
    if (!res?.ok) {
      throw new Error(res?.error || t('chat.resetContextFailedAgent'));
    }
    if (res.chat && typeof res.chat === 'object') {
      Object.assign(chat, res.chat);
    }
    chat.sdkAgentId = null;
    chat._lastHandledSdkRunFinishedId = '';
    chat._sdkServerBusy = false;
    chat._sdkServerQueuedCount = 0;
    chat._sdkOptimisticSentNow = [];
    chat._sdkOptimisticSentQueued = [];
    chat._contextUsageInputTokens = null;
    chat._contextUsageOutputTokens = null;
    chat._contextUsageTotalTokens = null;
    delete chat._contextUsageSource;
    delete chat._contextUsageUpdatedAt;
    delete chat._contextWarnings;
    delete chat._contextUsageSnapshot;
    delete chat._contextFillPercent;
    delete chat._contextPeakFillPercent;
    delete chat._contextLikelyPressure;
    delete chat._contextUsageModelId;
    chat._sdkContextFreshSession = true;
    chat._contextAdvisoryDismissed = false;
    chatDiagnosticsApi?.updateChatContextMeter?.(
      chat,
      chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
    );
    chat._sdkRichView?.appendMetaNotice?.(t('chat.resetContextDoneMeta'));
    appLogger.log('sdk-context-reset', 'completed', { chatId: chat.id });
    forceReconnectChat(chat);
    if (hintEl) {
      const connectingHint = t('chat.resetContextConnecting');
      hintEl.textContent = connectingHint;
      setTimeout(() => {
        if (hintEl.textContent === connectingHint) hintEl.textContent = '';
      }, 4500);
    }
    return true;
  } catch (err) {
    const message = String(err?.message || err || t('chat.resetContextFailed'));
    if (hintEl) {
      hintEl.textContent = message;
      setTimeout(() => {
        if (hintEl.textContent === message) {
          hintEl.textContent = '';
        }
      }, 6000);
    }
    chat._sdkRichView?.appendMetaNotice?.(t('chat.resetContextErrorMeta', { message }));
    appLogger.log('sdk-context-reset', 'failed', { chatId: chat.id, error: message });
    return false;
  } finally {
    chat._sdkContextResetPending = false;
  }
}

function formatContextDetailsPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  return `${numeric.toFixed(1)}%`;
}

function formatContextDetailsUpdatedAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  return new Date(numeric).toLocaleString();
}

function resolveContextDetailsSourceLabel(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'sdk-live') return t('chat.contextDetailsSourceSdkLive');
  if (normalized === 'sdk-history') return t('chat.contextDetailsSourceSdkHistory');
  if (normalized === 'opencode-estimated') return t('chat.contextDetailsSourceOpencodeEstimated');
  if (normalized.endsWith('-estimated')) return t('chat.contextDetailsSourceEstimated');
  if (normalized.endsWith('-history')) return t('chat.contextDetailsSourceHistory');
  if (normalized.endsWith('-live')) return t('chat.contextDetailsSourceLive');
  return t('chat.contextDetailsSourceUnknown');
}

function resolveContextDetailsTransportLabel(transport) {
  const normalized = String(transport || '').trim().toLowerCase();
  if (normalized === 'sdk') return t('chat.contextDetailsTransportSdk');
  if (normalized === 'opencode') return t('chat.contextDetailsTransportOpencode');
  if (normalized === 'openrouter') return t('chat.contextDetailsTransportOpenrouter');
  return normalized || '—';
}

function resolveContextDetailsWarningLabel(code) {
  const normalized = String(code || '').trim();
  if (!normalized) return '';
  const keys = {
    context_fill_high: 'chat.contextWarningFillHigh',
    context_over_model_window: 'chat.contextWarningOverWindow',
    context_peak_over_model_window: 'chat.contextWarningPeakOverWindow',
    local_store_large: 'chat.contextWarningLocalStoreLarge',
    history_head_seq_large: 'chat.contextWarningHistoryHeadSeqLarge',
  };
  const key = keys[normalized];
  return key ? t(key) : normalized;
}

function renderChatContextDetails(chat) {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  if (!chat) {
    const qualityEl = document.getElementById('chat-context-details-quality');
    if (qualityEl) {
      qualityEl.textContent = '—';
      qualityEl.classList.remove('chat-diag-badge-ok', 'chat-diag-badge-warn', 'chat-diag-badge-bad');
    }
    setText('chat-context-details-summary', t('chat.contextDetailsUnavailable'));
    setText('chat-context-details-transport', '—');
    setText('chat-context-details-model', '—');
    setText('chat-context-details-source', t('chat.contextDetailsSourceUnknown'));
    setText('chat-context-details-updated', '—');
    setText('chat-context-details-fill', '—');
    setText('chat-context-details-peak', '—');
    setText('chat-context-details-window', '—');
    setText('chat-context-details-input', '—');
    setText('chat-context-details-output', '—');
    setText('chat-context-details-total', '—');
    setText('chat-context-details-warnings', t('chat.contextDetailsNoWarnings'));
    return;
  }
  const stateSnapshot = chat?._contextUsageSnapshot && typeof chat._contextUsageSnapshot === 'object'
    ? chat._contextUsageSnapshot
    : null;
  const snapshot = stateSnapshot || chatDiagnosticsApi?.buildChatContextSnapshot?.(
    chat,
    chatDiagnosticsApi?.resolveContextMeterModelId?.(chat, chat?.model || 'auto'),
  ) || null;
  const qualityEl = document.getElementById('chat-context-details-quality');
  if (qualityEl) {
    const estimated = snapshot?.isEstimated === true;
    qualityEl.textContent = estimated ? t('chat.contextDetailsEstimated') : t('chat.contextDetailsExact');
    qualityEl.classList.remove('chat-diag-badge-ok', 'chat-diag-badge-warn', 'chat-diag-badge-bad');
    qualityEl.classList.add(estimated ? 'chat-diag-badge-warn' : 'chat-diag-badge-ok');
  }
  const warnings = Array.isArray(snapshot?.warnings)
    ? snapshot.warnings.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  setText('chat-context-details-summary', snapshot?.label || t('chat.contextDetailsOpen'));
  setText(
    'chat-context-details-transport',
    resolveContextDetailsTransportLabel(snapshot?.transport || chat.agentTransport || 'sdk'),
  );
  setText('chat-context-details-model', snapshot?.modelId || normalizeModelValue(chat?.model || 'auto'));
  setText('chat-context-details-source', resolveContextDetailsSourceLabel(snapshot?.source || ''));
  setText('chat-context-details-updated', formatContextDetailsUpdatedAt(snapshot?.updatedAt));
  setText('chat-context-details-fill', formatContextDetailsPercent(snapshot?.fillPercent));
  setText('chat-context-details-peak', formatContextDetailsPercent(snapshot?.peakFillPercent));
  setText('chat-context-details-window', formatContextTokenCount(snapshot?.contextWindowTokens));
  setText('chat-context-details-input', formatContextTokenCount(snapshot?.inputTokens));
  setText('chat-context-details-output', formatContextTokenCount(snapshot?.outputTokens));
  setText('chat-context-details-total', formatContextTokenCount(snapshot?.totalTokens));
  setText(
    'chat-context-details-warnings',
    warnings.length > 0
      ? warnings.map((code) => resolveContextDetailsWarningLabel(code)).join(', ')
      : t('chat.contextDetailsNoWarnings'),
  );
}

async function refreshChatContextDetailsFromServer(chat) {
  if (!chat?.id) return;
  try {
    const res = await api.getChatDiag(chat.id);
    if (!res?.ok) return;
    chatDiagnosticsApi?.applyServerContextUsageFromDiag?.(chat, res);
  } catch (_) {
    // Best-effort refresh for details modal.
  }
  renderChatContextDetails(chat);
}

function openChatContextDetailsModal(chat) {
  if (!chat) return;
  renderChatContextDetails(chat);
  chatContextDetailsModalApi?.open();
  void refreshChatContextDetailsFromServer(chat);
}

function closeChatContextDetailsModal() {
  chatContextDetailsModalApi?.close();
}

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

function initChatSettingsTabs() {
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
function openChatSettingsModal() {
  const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  if (!chat) return;
  const modal = document.getElementById('chat-settings-modal');
  const modalDialog = modal?.querySelector('.chat-settings-dialog');
  const titleInput = document.getElementById('chat-settings-title-input');
  const showSendFieldCheckbox = document.getElementById('chat-settings-show-send-field');
  const autoUpdateTitleCheckbox = document.getElementById('chat-settings-auto-update-title');
  const showDiagCheckbox = document.getElementById('chat-settings-show-diag');
  const sdkVerboseLogsCheckbox = document.getElementById('chat-settings-sdk-verbose-logs');
  const sdkUiModeSelect = document.getElementById('chat-settings-sdk-ui-mode');
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
  if (showSendFieldCheckbox) {
    showSendFieldCheckbox.checked =
      typeof localStorage === 'undefined' || readStorageValueWithAlias(localStorage, SHOW_SEND_FIELD_KEY, '') !== 'false';
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
  if (autoContextCompressionEnabledCheckbox) {
    autoContextCompressionEnabledCheckbox.checked = isAutoContextCompressionEnabled(chat);
  }
  if (autoContextCompressionThresholdInput) {
    autoContextCompressionThresholdInput.value = String(
      normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold)
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
    contextSummaryResetCheckbox.checked = shouldResetAfterContextCompression(chat);
  }
  const updateTitleHint = document.getElementById('chat-settings-update-title-hint');
  if (updateTitleHint) updateTitleHint.textContent = '';
  if (sessionMetaEl) {
    const chatId = chat.id ? String(chat.id) : '—';
    const sessionId = chat.cursorSessionId ? String(chat.cursorSessionId) : '—';
    const agentId = chat.sdkAgentId ? String(chat.sdkAgentId) : '—';
    sessionMetaEl.hidden = false;
    sessionMetaEl.textContent = t('chat.sessionMeta', { chatId, sessionId, agentId });
  }
  const voiceReadMount = document.getElementById('chat-settings-voice-read');
  if (voiceReadMount && !chatSettingsVoiceRead) {
    chatSettingsVoiceRead = createVoiceReadOptions();
    voiceReadMount.replaceChildren(chatSettingsVoiceRead.root);
  }
  chatSettingsVoiceRead?.refresh();
  applyChatSettingsTab('chat');
  chatSettingsModalApi?.open();
  if (modalDialog instanceof HTMLElement) {
    modalDialog.scrollTop = 0;
  }
  const formEl = modal.querySelector('.chat-settings-form');
  if (formEl instanceof HTMLElement) {
    formEl.scrollTop = 0;
  }
  chatDiagnosticsApi.renderChatDiagnosis(chat);
  titleInput.focus();
}

function closeChatSettingsModal() {
  chatSettingsModalApi?.close();
}

/**
 * Saves chat settings from the modal (PATCH) and closes the modal.
 */
function saveChatSettings() {
  const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
  if (!chat) {
    closeChatSettingsModal();
    return;
  }
  const titleInput = document.getElementById('chat-settings-title-input');
  if (!titleInput) return;
  const newTitle = (titleInput.value || '').trim();
  const payload = {};
  if (newTitle !== (chat.title || '')) payload.title = newTitle;
  const sdkUiModeSelect = document.getElementById('chat-settings-sdk-ui-mode');
  const nextSdkUiMode = normalizeSdkUiMode(sdkUiModeSelect?.value);
  if (nextSdkUiMode !== normalizeSdkUiMode(chat.sdkUiMode)) {
    payload.sdkUiMode = nextSdkUiMode;
  }
  const showSendFieldCheckbox = document.getElementById('chat-settings-show-send-field');
  const autoUpdateTitleCheckbox = document.getElementById('chat-settings-auto-update-title');
  if (showSendFieldCheckbox) {
    writeLocalStorageSafe(
      SHOW_SEND_FIELD_KEY,
      showSendFieldCheckbox.checked ? 'true' : 'false',
      'saveChatSettings.showSendField'
    );
    applySendFieldPreference();
  }
  if (autoUpdateTitleCheckbox) {
    setAutoUpdateChatTitleEnabled(autoUpdateTitleCheckbox.checked);
    const globalAutoUpdateTitleCheckbox = document.getElementById('auto-update-chat-title-checkbox');
    if (globalAutoUpdateTitleCheckbox) globalAutoUpdateTitleCheckbox.checked = autoUpdateTitleCheckbox.checked;
  }
  const showDiagCheckbox = document.getElementById('chat-settings-show-diag');
  if (showDiagCheckbox) {
    writeLocalStorageSafe(
      SHOW_CHAT_DIAG_KEY,
      showDiagCheckbox.checked ? 'true' : 'false',
      'saveChatSettings.showDiag'
    );
    const activeChat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (activeChat) {
      chatDiagnosticsApi.syncChatDiagEnabled(activeChat);
    }
  }
  const sdkVerboseLogsCheckbox = document.getElementById('chat-settings-sdk-verbose-logs');
  if (sdkVerboseLogsCheckbox) {
    writeLocalStorageSafe(
      SDK_VERBOSE_LOGS_KEY,
      sdkVerboseLogsCheckbox.checked ? 'true' : 'false',
      'saveChatSettings.sdkVerboseLogs'
    );
  }
  const autoContextCompressionEnabledCheckbox = document.getElementById(
    'chat-settings-auto-context-compression-enabled'
  );
  if (autoContextCompressionEnabledCheckbox) {
    const enabled = autoContextCompressionEnabledCheckbox.checked === true;
    if (enabled !== isAutoContextCompressionEnabled(chat)) {
      payload.autoContextCompressionEnabled = enabled;
    }
  }
  const autoContextCompressionThresholdInput = document.getElementById(
    'chat-settings-auto-context-compression-threshold'
  );
  if (autoContextCompressionThresholdInput) {
    const threshold = normalizeAutoContextCompressionThreshold(autoContextCompressionThresholdInput.value);
    if (threshold !== normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold)) {
      payload.autoContextCompressionThreshold = threshold;
    }
  }
  const contextAdvisoryEnabledCheckbox = document.getElementById('chat-settings-context-advisory-enabled');
  if (contextAdvisoryEnabledCheckbox) {
    const enabled = contextAdvisoryEnabledCheckbox.checked !== false;
    if (enabled !== isContextAdvisoryEnabled(chat)) {
      payload.contextAdvisoryEnabled = enabled;
    }
  }
  const contextAdvisoryWarnPercentInput = document.getElementById(
    'chat-settings-context-advisory-warn-percent'
  );
  if (contextAdvisoryWarnPercentInput) {
    const warnPercent = normalizeContextAdvisoryWarnPercent(contextAdvisoryWarnPercentInput.value);
    if (warnPercent !== normalizeContextAdvisoryWarnPercent(chat.contextAdvisoryWarnPercent)) {
      payload.contextAdvisoryWarnPercent = warnPercent;
    }
  }
  const contextSummaryResetCheckbox = document.getElementById('chat-settings-context-summary-reset');
  if (contextSummaryResetCheckbox) {
    const resetEnabled = contextSummaryResetCheckbox.checked === true;
    if (resetEnabled !== shouldResetAfterContextCompression(chat)) {
      payload.autoContextCompressionReset = resetEnabled;
    }
  }

  if (Object.keys(payload).length === 0) {
    closeChatSettingsModal();
    return;
  }
  appLogger.log('api-request', 'PATCH /api/chats/' + chat.id + ' (ustawienia)', payload);
  api.patchChat(chat.id, payload).then((data) => {
    appLogger.log('api-response', 'PATCH /api/chats/' + chat.id + ' (ustawienia)', data);
    if (!data.ok) return;
    if (payload.title !== undefined) {
      chat.title = newTitle;
      appLogger.log('chat-title', 'settings (manual change):', newTitle);
      updateChatBarSelect();
    }
    if (payload.sdkUiMode !== undefined) {
      chat.sdkUiMode = nextSdkUiMode;
      chat._sdkRichView?.setUiMode?.(nextSdkUiMode);
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
    chatDiagnosticsApi?.updateChatContextMeter?.(
      chat,
      chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
    );
    closeChatSettingsModal();
  }).catch((err) => {
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id + ' (ustawienia)', String(err));
  });
}

/**
 * Initialize the chat panel: bar (chat, +, settings, fullscreen), modals (new chat, settings).
 */
export function initChatPanel() {
  initAgentWakeLock();
  initChatModelSelectApi();
  initChatDiagnosticsApi();
  initChatTitleForkApi();
  bindChatVisibilityAndReconnect();
  chatController.initChatPanelBridge();
  mountSdkModeBarInToolbar();

  if (typeof window !== 'undefined') {
    // The status label is passed into the mode bar as a plain string, so it has
    // to be recomputed when the language changes.
    window.addEventListener('cr-lang-changed', () => {
      const chat = chats.find((c) => c.id === activeChatId);
      if (chat) renderChatTerminalState(chat);
    });
    const flushAllSdkStructuredHistory = () => {
      for (const c of chats) {
        if (c.id) flushSdkStructuredHistoryNow(c);
      }
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      flushAllSdkStructuredHistory();
    });
    window.addEventListener('pagehide', flushAllSdkStructuredHistory);
    window.addEventListener('beforeunload', flushAllSdkStructuredHistory);
    window.addEventListener('resize', scheduleChatSendBarReserveSync);
    window.addEventListener('orientationchange', scheduleChatSendBarReserveSync);
    window.addEventListener('cr-keyboard-offset-change', scheduleChatSendBarReserveSync);
    window.addEventListener('cr-widget-connected', () => {
      syncWidgetPinUrlUi(activeChatId ? chats.find((c) => c.id === activeChatId) : null);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleChatSendBarReserveSync);
      window.visualViewport.addEventListener('scroll', scheduleChatSendBarReserveSync);
    }
    if (typeof ResizeObserver !== 'undefined' && !getChatSendBarResizeObserver()) {
      setChatSendBarResizeObserver(new ResizeObserver(() => {
        scheduleChatSendBarReserveSync();
      }));
    }
    if (getChatSendBarResizeObserver()) {
      document.querySelectorAll('#chat-panel .chat-pane-toolbar.chat-send-bar').forEach((el) => {
        if (el instanceof HTMLElement) getChatSendBarResizeObserver().observe(el);
      });
    }
  }

  chatNewModalApi = initModal(document.getElementById('chat-new-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  chatDeleteConfirmModalApi = initModal(document.getElementById('chat-delete-confirm-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  chatContextDetailsModalApi = initModal(document.getElementById('chat-context-details-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  const chatDeleteBackdrop = document.querySelector('#chat-delete-confirm-modal .chat-settings-backdrop');
  if (chatDeleteBackdrop) {
    chatDeleteBackdrop.addEventListener('click', () => {
      pendingDeleteChatId = null;
    });
  }
  const newCancelBtn = document.getElementById('chat-new-cancel');
  const newCreateBtn = document.getElementById('chat-new-create');
  const newHarnessSel = document.getElementById('chat-new-harness-select');
  if (newCancelBtn) newCancelBtn.addEventListener('click', (e) => { e.preventDefault(); closeNewChatModal(); });
  if (newCreateBtn) newCreateBtn.addEventListener('click', (e) => { e.preventDefault(); createChatFromModal(); });
  if (newHarnessSel) {
    newHarnessSel.addEventListener('change', () => {
      chatNewModelDropdownApi?.close?.();
      void refreshNewChatHarnessStatus({ forceCloseDropdown: true });
    });
  }
  const deleteConfirmCancelBtn = document.getElementById('chat-delete-confirm-cancel');
  const deleteConfirmBtn = document.getElementById('chat-delete-confirm-delete');
  const deleteConfirmSkipBtn = document.getElementById('chat-delete-confirm-delete-skip');
  const contextDetailsCloseBtn = document.getElementById('chat-context-details-close');
  if (deleteConfirmCancelBtn) {
    deleteConfirmCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeChatDeleteConfirmModal();
    });
  }
  if (deleteConfirmBtn) {
    deleteConfirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmDeleteChat(false);
    });
  }
  if (deleteConfirmSkipBtn) {
    deleteConfirmSkipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmDeleteChat(true);
    });
  }
  if (contextDetailsCloseBtn) {
    contextDetailsCloseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeChatContextDetailsModal();
    });
  }

  chatNewModelDropdownApi = chatModelSelectApi.ensureFloatingModelSelect(document.getElementById('chat-new-model-select'));
  chatNewFolderDropdownApi = chatModelSelectApi.ensureFloatingFolderSelect(document.getElementById('chat-new-folder-select'));
  void refreshModelCatalogFromServer();
  void api.getOpenRouterModels().then((data) => {
    if (!data?.ok) return;
    const changed = chatModelSelectApi.applyAvailableModelsFromOpenRouter(data);
    if (changed) chatModelSelectApi.refreshModelSelectLabels();
  }).catch(() => {});
  api.getSettings().then((data) => {
    if (!data?.ok) return;
    applyChatEnabledModels(data.chatEnabledModels || []);
    applyOpenRouterEnabledModels(data.openrouterChatEnabledModels || []);
    applyOpenCodeEnabledModels(data.opencodeChatEnabledModels || []);
    serverSettingsWorkspaceFolder = typeof data.workspaceFolder === 'string'
      ? data.workspaceFolder.trim()
      : '';
    const ctx = getWorkspaceContextForChat();
    const folder = ctx?.workspaceFolder || serverSettingsWorkspaceFolder;
    if (folder && !selectedWorkspaceFolder) selectedWorkspaceFolder = folder;
    return fetchOpenCodeModelsCatalog().then((modelsData) => {
      if (!modelsData?.ok) return;
      chatModelSelectApi.applyAvailableModelsFromOpenCode(modelsData);
      chatModelSelectApi.refreshModelSelectLabels();
    });
  }).catch(() => {});
  if (typeof window !== 'undefined') {
    window.addEventListener('cretli-chat-models-changed', (event) => {
      const detail = event?.detail;
      applyChatEnabledModels(detail?.chatEnabledModels || []);
    });
    window.addEventListener('cretli-openrouter-models-changed', (event) => {
      const detail = event?.detail;
      applyOpenRouterEnabledModels(detail?.openrouterChatEnabledModels || []);
    });
    window.addEventListener('cretli-opencode-models-changed', (event) => {
      const detail = event?.detail;
      applyOpenCodeEnabledModels(detail?.opencodeChatEnabledModels || []);
    });
    window.addEventListener('cretli-opencode-key-changed', () => {
      void reloadOpenCodeModelsCatalog();
      void refreshNewChatOpenCodeStatus();
    });
    window.addEventListener('cretli-default-harness-changed', () => {
      applyDefaultNewChatHarnessToModal();
    });
  }
  void loadWorkspaces();

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
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      if (!chat) {
        setTransientChatActionHint(hint, t('chat.noActiveChat'));
        return;
      }
      void resetChatSdkContext(chat, hint);
    });
  }
  const newAgentBtn = document.getElementById('chat-new-agent-btn');
  if (newAgentBtn) {
    bindChatToolbarActionItem(newAgentBtn, () => {
      closeChatActionsModal();
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
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
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
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
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      void createAgentMonitorChat(chat, hint);
    });
  }

  const pinUrlMenuBtn = document.getElementById('chat-pin-url-menu-btn');
  if (pinUrlMenuBtn) {
    bindChatToolbarActionItem(pinUrlMenuBtn, () => {
      closeChatActionsModal();
      const hint = document.getElementById('chat-toolbar-status-hint');
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      void toggleWidgetUrlPin(chat, hint);
    });
  }
  syncWidgetPinUrlUi(activeChatId ? chats.find((c) => c.id === activeChatId) : null);

  const deleteMenuBtn = document.getElementById('chat-delete-menu-btn');
  if (deleteMenuBtn) {
    bindChatToolbarActionItem(deleteMenuBtn, () => {
      closeChatActionsModal();
      const id = activeChatId;
      if (!id) return;
      requestDeleteChat(id);
    });
  }
  const deleteBtn = document.getElementById('chat-delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const id = activeChatId;
      if (!id) return;
      requestDeleteChat(id);
    });
  }

  chatView.initDropdownWiring();

  chatSettingsModalApi = initModal(document.getElementById('chat-settings-modal'), {
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
      requestAutoTitleFromAgent();
    });
    const titleFromForkBtn = document.getElementById('chat-settings-title-from-fork-btn');
    if (titleFromForkBtn) {
      titleFromForkBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
        const hint = document.getElementById('chat-settings-update-title-hint');
        if (!chat) {
          if (hint) hint.textContent = t('chat.noActiveChat');
          return;
        }
        if (hint) hint.textContent = t('chat.creatingTempAgent');
        titleFromForkBtn.disabled = true;
        requestTitleFromFork(
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
        const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
        const hint = document.getElementById('chat-settings-update-title-hint');
        if (!chat) {
          if (hint) hint.textContent = t('chat.noActiveChat');
          return;
        }
        if (hint) hint.textContent = t('chat.tempAgentAnalyzing');
        summaryForkBtn.disabled = true;
        requestSummaryFromFork(
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
        const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
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
  if (!chatTitlesSyncTimer && typeof window !== 'undefined') {
    chatTitlesSyncTimer = setInterval(syncChatTitlesFromServer, CHAT_TITLES_SYNC_INTERVAL_MS);
  }
  scheduleChatSendBarReserveSync();

  const showSendFieldCheckbox = document.getElementById('chat-settings-show-send-field');
  if (showSendFieldCheckbox) {
    showSendFieldCheckbox.addEventListener('change', () => {
      writeLocalStorageSafe(
        SHOW_SEND_FIELD_KEY,
        showSendFieldCheckbox.checked ? 'true' : 'false',
        'chatSettings.showSendField.change'
      );
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

  const diagRefreshBtn = document.getElementById('chat-diag-refresh');
  if (diagRefreshBtn) {
    diagRefreshBtn.addEventListener('click', () => {
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      chatDiagnosticsApi.renderChatDiagnosis(chat);
    });
  }
  const diagFetchServerBtn = document.getElementById('chat-diag-fetch-server');
  if (diagFetchServerBtn) {
    diagFetchServerBtn.addEventListener('click', () => {
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      void chatDiagnosticsApi.fetchAndRenderServerDiag(chat);
    });
  }
  const diagReconnectBtn = document.getElementById('chat-diag-reconnect');
  if (diagReconnectBtn) {
    diagReconnectBtn.addEventListener('click', () => {
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
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
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      if (!chat) return;
      const hint = document.getElementById('chat-diag-hint');
      void resetSdkChatRoom(chat, hint);
    });
  }
  const diagResetContextBtn = document.getElementById('chat-diag-reset-context');
  if (diagResetContextBtn) {
    diagResetContextBtn.addEventListener('click', () => {
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      if (!chat) return;
      const hint = document.getElementById('chat-diag-hint');
      void resetChatSdkContext(chat, hint);
    });
  }
  const diagProbeSdkBtn = document.getElementById('chat-diag-probe-sdk');
  if (diagProbeSdkBtn) {
    diagProbeSdkBtn.addEventListener('click', () => {
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      if (!chat) return;
      const hint = document.getElementById('chat-diag-hint');
      void chatDiagnosticsApi.runSdkAgentProbe(chat, hint);
    });
  }
  const diagCancelBtn = document.getElementById('chat-diag-cancel');
  if (diagCancelBtn) {
    diagCancelBtn.addEventListener('click', () => {
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      if (!chat) return;
      cancelChatRun(chat);
      const hint = document.getElementById('chat-diag-hint');
      if (hint) {
        hint.textContent = t('chat.diagCancelSent');
        setTimeout(() => { hint.textContent = ''; }, 4000);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (chatView.isChatListDropdownOpen()) {
      closeChatListModal();
      return;
    }
    if (chatView.isChatActionsDropdownOpen()) {
      closeChatActionsModal();
      return;
    }
    const settingsModal = document.getElementById('chat-settings-modal');
    if (settingsModal && !settingsModal.hidden) {
      closeChatSettingsModal();
      return;
    }
    const contextDetailsModal = document.getElementById('chat-context-details-modal');
    if (contextDetailsModal && !contextDetailsModal.hidden) {
      closeChatContextDetailsModal();
      return;
    }
    const newModalEl = document.getElementById('chat-new-modal');
    if (newModalEl && !newModalEl.hidden) {
      closeNewChatModal();
      return;
    }
    const deleteConfirmModal = document.getElementById('chat-delete-confirm-modal');
    if (deleteConfirmModal && !deleteConfirmModal.hidden) {
      closeChatDeleteConfirmModal();
      return;
    }
    if (!document.body.classList.contains('chat-fullscreen-active')) return;
    document.body.classList.remove('chat-fullscreen-active');
    const fb = document.getElementById('chat-fullscreen-btn');
    if (fb) {
      const fullscreenLabel = t('chat.fullscreen');
      fb.setAttribute('data-fullscreen', 'off');
      fb.setAttribute('title', fullscreenLabel);
      fb.setAttribute('aria-label', fullscreenLabel);
      fb.innerHTML =
        '<span class="mdi mdi-fullscreen" aria-hidden="true"></span>' +
        `<span class="chat-toolbar-action-label">${escapeHtml(fullscreenLabel)}</span>`;
    }
  });
}
