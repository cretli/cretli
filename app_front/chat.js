/**
 * Chat panel: chat list, openTerminal(chat), ensureChatConnection, closeChat, selectChat, newChat, model select, send-keys.
 */
import * as api from './core/api/index.js';
import {
  applyDefaultNewChatHarnessToModal,
  applyEnabledHarnesses,
  applyHarnessOrder,
  getEnabledHarnessIds,
  isHarnessEnabledInSettings,
} from './harnessSettings.js';
import { AGENT_TRANSPORTS, getChatAgentTransport } from '../lib/agent-transport.js';
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
import {
  buildHarnessHandoffPrompt,
  parseInheritedPrompt,
  resolveInheritedPromptEcho,
  resolvePendingInheritedSend,
} from '../lib/conversation-fork.js';
import { resolveHarnessSwitchNest } from '../lib/chat-tree.js';
import { buildApprovedPlanImplementPrompt } from '../lib/chat-plan-path.js';
import {
  parseDelegationCommand,
  readLastDelegationExecutor,
  startDelegationFromParent,
  prepareBuildPlanModal,
  prepareMessageDelegationModal,
  clearDelegationPlanPreview,
  getDelegationApprovedPlanRevision,
  readDelegationPreviewExtra,
  readDelegationExecutionMode,
  peekDelegationIdempotencyKey,
  clearDelegationIdempotencyKey,
  hashTextSha256,
} from './features/chat/chatDelegations.js';
import { t } from './i18n/index.js';
import { initDropdown } from './lib/dropdown.js';
import { createFavoritesStore } from './lib/favorites.js';
import {
  CHAT_PRESETS_CHANGED_EVENT,
  chatPresetKey,
  createChatPresetsStore,
  normalizeChatPreset,
} from './features/chat/chatPresets.js';
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
  hasActiveAgentRun,
  hasLiveHarnessWork,
  readHarnessPendingFlags,
  resolveChatListDotState,
  resolveHarnessChatStateMeta,
} from './features/chat/chatStatusMeta.js';
import { shouldSkipChatDeleteConfirm } from './features/chat/chatDeleteConfirm.js';
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
import { initChatListResumeSync } from './features/chat/chatListResumeSync.js';
import { getResumeHistorySyncDeferMs } from './features/chat/chatResumePolicy.js';
import { isMobileLikeClient } from './lib/mobileClient.js';
import { getLastBackgroundDurationMs } from './lib/pageBackgroundGrace.js';
import {
  allowSdkLiveEventsDuringHydration,
  beginSdkOpenTerminalHydration,
  clearSdkOpenTerminalHydrating,
  isSdkOpenTerminalHydrating,
  takeMissingSdkHistoryRecords,
  hasSdkHistoryRoomWatermarks,
} from './features/chat/sdkEventReplayGuard.js';
import {
  partitionRecordsByWindowStart,
  rememberHistoryWindowStart,
  sortRecordsByCreatedAt,
} from './features/chat/chatHistoryWindowOrder.js';
import { createSdkRichView } from './lib/sdk-rich-view.js';
import { getChatSpeaker } from './features/voice/chatSpeaker.js';
import { createVoiceReadOptions } from './features/voice/voiceReadControls.js';
import {
  getStoredDictationResumeAfterSend,
  setStoredDictationResumeAfterSend,
} from './features/sendBar/sendBarMedia.js';
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
  collectWorkspaceFolders,
  matchFolderBySpokenName,
  matchWorkspaceBySpokenName,
  workspaceSpokenLabel,
} from './features/voice/voiceWorkspaceMatch.js';
import { writeLocalStorageSafe } from './features/chat/chatLocalStorage.js';
import {
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
  getShowSendFieldEnabled,
  setShowSendFieldEnabled,
  healLegacyShowSendFieldPreference,
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
import { applySidebarChatStatusEl } from './features/sidebar/sidebarChatStatus.js';
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
const chatPresets = createChatPresetsStore();
const CHAT_NAV_SEQUENCES = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
  escape: '\x1b',
  y: 'y',
  n: 'n',
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
/** @type {string|null} */
let forkSourceChatId = null;
/** Inclusive history cut for per-message fork; null means copy the full parent. */
/** @type {string|null} */
let forkUpToCreatedAt = null;
/** @type {string|null} */
let monitorSourceChatId = null;
/** @type {string|null} */
let buildPlanSourceChatId = null;
/** @type {string|null} */
let passMessageSourceChatId = null;
/** @type {{ historySeq: number, createdAt: string, text: string }} */
let passMessageMeta = { historySeq: 0, createdAt: '', text: '' };
let chatDeleteConfirmModalApi;
let chatContextDetailsModalApi;
let pendingDeleteChatId = null;
let chatNewModelDropdownApi = null;
let chatNewFolderDropdownApi = null;
let chatNewFavoritePresetDropdownApi = null;

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

/** Matches the default title the server assigns when a chat is created without a name ("Chat 12"). */
const DEFAULT_CHAT_TITLE_RE = /^chat \d+$/i;

/** Max length of the first message sent to the backend title generator. */
const AUTO_NAME_PROMPT_MAX_CHARS = 4000;

/**
 * @param {unknown} title
 * @returns {boolean} true when the chat still carries the auto-assigned default name
 */
function isDefaultChatTitle(title) {
  return DEFAULT_CHAT_TITLE_RE.test(String(title || '').trim());
}

/**
 * When "Automatic name for a new chat" is enabled and the chat still has the
 * default title, generate a title from the first message via the backend
 * one-shot agent and patch the chat (the conversation itself is untouched).
 * @param {object} chat
 * @param {string} messageText
 */
function maybeAutoNameNewChat(chat, messageText) {
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
      await loadChatsFromServer({
        pinnedTo: pageUrl,
        skipAutoSelect: true,
        preferChatId: existing.id,
      });
      adoptCreatedChat(existing);
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
    setForcedEmbedChatId(data.chat.id);
    await loadChatsFromServer({
      pinnedTo: pageUrl,
      skipAutoSelect: true,
      preferChatId: data.chat.id,
    });
    const createdChat = adoptCreatedChat(data.chat) || data.chat;
    syncWidgetPinUrlUi(createdChat);
    notifySidebar();
    renderChatList();
    notifyWidgetParentPagePinChanged();
    appLogger.log('widget-plus', 'created and selected', {
      chatId: data.chat.id.slice(0, 8),
      pinnedUrl: getChatWidgetPinnedUrl(createdChat) || pageUrl,
      hasPane: !!createdChat?.pane,
    });
    return { ok: true, chat: createdChat, reused: false };
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

function inheritedPromptLabels() {
  return {
    fork: t('chat.forkContinueDisplayText'),
    handoff: t('chat.harnessHandoffDisplayText'),
    analyze: t('chat.monitorAgentDisplayPrompt'),
  };
}

function inheritedPromptLabelForKind(kind) {
  const labels = inheritedPromptLabels();
  if (kind === 'handoff') return labels.handoff;
  if (kind === 'analyze') return labels.analyze;
  return labels.fork;
}

/**
 * Use the stored fork/handoff prompt on the first user send instead of auto-sending it.
 *
 * @param {object} chat
 * @param {string} userText
 * @returns {{ payloadText: string, displayText: string } | null}
 */
function consumePendingInheritedPrompt(chat, userText) {
  const pending = typeof chat?._pendingInheritedPrompt === 'string'
    ? chat._pendingInheritedPrompt.trim()
    : '';
  if (!pending) return null;
  const defaultDraft = typeof chat._pendingInheritedDisplayText === 'string'
    ? chat._pendingInheritedDisplayText
    : '';
  delete chat._pendingInheritedPrompt;
  delete chat._pendingInheritedDisplayText;
  return resolvePendingInheritedSend(pending, defaultDraft, userText);
}

/**
 * @param {string[]} list
 * @param {string} userText
 * @returns {number}
 */
function findOptimisticPromptIndex(list, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!raw || !Array.isArray(list)) return -1;
  const direct = list.indexOf(raw);
  if (direct !== -1) return direct;
  const inherited = parseInheritedPrompt(raw);
  if (!inherited.wrapped) return -1;
  const echo = resolveInheritedPromptEcho(raw, inheritedPromptLabels()).trim();
  if (echo) {
    const echoIdx = list.indexOf(echo);
    if (echoIdx !== -1) return echoIdx;
  }
  const label = inheritedPromptLabelForKind(inherited.kind);
  return list.indexOf(label);
}

function appendSdkUserPromptLine(chat, userText) {
  const raw = resolveInheritedPromptEcho(
    userText == null ? '' : String(userText),
    inheritedPromptLabels()
  );
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
  const idx = findOptimisticPromptIndex(chat._sdkOptimisticSentNow, raw);
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
  const idx = findOptimisticPromptIndex(chat._sdkOptimisticSentQueued, raw);
  if (idx === -1) return false;
  chat._sdkOptimisticSentQueued.splice(idx, 1);
  return true;
}

function appendSdkQueuedPromptLine(chat, userText, position) {
  const raw = resolveInheritedPromptEcho(
    userText == null ? '' : String(userText).trim(),
    inheritedPromptLabels()
  ).trim();
  if (!raw) return;
  if (chat._sdkRichView?.hasQueuedOrSentUserText?.(raw)) return;
  const pos = Math.max(1, Number(position) || 1);
  const line = `\n> ${t('chatUi.queuedPlainTag', { n: pos })} ${raw}\n`;
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
  const catalogFetchAlreadyAttempted = bar._pendingModelCatalogFetchHarness === nextHarness;
  if (bar.models.length === 0 && !catalogFetchAlreadyAttempted) {
    bar._pendingModelCatalogFetchHarness = nextHarness;
    void refreshPendingHarnessModelCatalog(nextHarness);
  }
}

function refreshPendingHarnessModelCatalog(harness) {
  const nextHarness = normalizeNewChatHarness(harness);
  const syncLoadedModelsToModeBar = async () => {
    const bar = document.querySelector('cr-sdk-mode-bar');
    const pendingHarness = String(bar?.pendingHarness || '').trim();
    if (!bar || normalizeNewChatHarness(pendingHarness) !== nextHarness) return;
    syncPendingHarnessBarModels(bar, nextHarness);
    await refreshSdkModeBarCombinedPicker({
      reopenDropdown: bar.pickerStep === 'model',
    });
  };
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
      return syncLoadedModelsToModeBar();
    }).catch(() => {});
  }
  if (nextHarness === 'codebuddy') {
    return api.getCodeBuddyModels().then((data) => {
      if (data?.ok) chatModelSelectApi.applyAvailableModelsFromCodeBuddy(data);
      chatModelSelectApi.refreshModelSelectLabels();
      return syncLoadedModelsToModeBar();
    }).catch(() => {});
  }
  if (nextHarness === 'deepseek') {
    return api.getDeepSeekModels().then((data) => {
      if (data?.ok) chatModelSelectApi.applyAvailableModelsFromDeepSeek(data);
      chatModelSelectApi.refreshModelSelectLabels();
      return syncLoadedModelsToModeBar();
    }).catch(() => {});
  }
  if (nextHarness === 'qwen') {
    return api.getQwenModels().then((data) => {
      if (data?.ok) chatModelSelectApi.applyAvailableModelsFromQwen(data);
      chatModelSelectApi.refreshModelSelectLabels();
      return syncLoadedModelsToModeBar();
    }).catch(() => {});
  }
  if (nextHarness === 'codex') {
    return api.getCodexModels().then((data) => {
      if (data?.ok) chatModelSelectApi.applyAvailableModelsFromCodex(data);
      chatModelSelectApi.refreshModelSelectLabels();
      return syncLoadedModelsToModeBar();
    }).catch(() => {});
  }
  return refreshModelCatalogFromServer().then(syncLoadedModelsToModeBar);
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
    delete bar._pendingModelCatalogFetchHarness;
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
    checkboxLabel: t('chat.harnessSwitchIncludeContext'),
    checkboxHint: t('chat.harnessSwitchIncludeContextHint'),
    checkboxChecked: true,
    options: getOldChatDispositionOptions(),
  });
  if (answer == null) return null;
  const action = typeof answer === 'string' ? answer : answer.value;
  return {
    action: normalizeHarnessActionChoice(action),
    includeContext: typeof answer === 'object' && answer.checked === true,
  };
}

async function applyOldChatDisposition(oldChat, newChatId, action) {
  if (!oldChat?.id) return 'keep';
  const nest = resolveHarnessSwitchNest(oldChat, newChatId);
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
    } else {
      removedChatIds.add(oldChat.id);
      closeChat(oldChat.id, { skipApiDelete: true, switchToChatId: newChatId });
    }
    if (nest?.childId === newChatId) {
      await nestChatUnderParent(nest.childId, nest.parentId);
    }
    return 'delete';
  }
  if (nest) await nestChatUnderParent(nest.childId, nest.parentId);
  if (action === 'archive') {
    await requestArchiveChat(oldChat.id, { switchToChatId: newChatId });
    return 'archive';
  }
  try {
    const data = await api.patchChat(oldChat.id, { widgetPinnedUrl: null });
    if (data?.ok && data.chat) {
      const live = chats.find((entry) => entry.id === oldChat.id);
      if (live) Object.assign(live, data.chat);
      renderChatList();
      notifySidebar();
    }
  } catch (err) {
    console.warn('[chat] unpin widget url failed:', err?.message || err);
  }
  return 'keep';
}

/**
 * Persist sidebar nesting after a harness switch.
 *
 * @param {string} childId
 * @param {string} parentId
 * @returns {Promise<void>}
 */
async function nestChatUnderParent(childId, parentId) {
  const id = String(childId || '').trim();
  const nextParentId = String(parentId || '').trim();
  if (!id || !nextParentId || id === nextParentId) return;
  const live = chats.find((entry) => entry.id === id);
  if (live) live.forkParentChatId = nextParentId;
  notifySidebar();
  try {
    const data = await api.patchChat(id, { forkParentChatId: nextParentId });
    if (!data?.ok || !data.chat) return;
    const next = chats.find((entry) => entry.id === id);
    if (!next) return;
    if (typeof data.chat.forkParentChatId === 'string' && data.chat.forkParentChatId.trim()) {
      next.forkParentChatId = data.chat.forkParentChatId.trim();
    } else {
      delete next.forkParentChatId;
    }
    notifySidebar();
    refreshRelatedChatHistoryLinks(next);
    refreshRelatedChatHistoryLinks(chats.find((entry) => entry.id === nextParentId));
  } catch (err) {
    console.warn('[chat] nest harness chat failed:', err?.message || err);
  }
}

/**
 * Show clickable parent/child links in the open chat stream.
 *
 * @param {object | null | undefined} chat
 */
export function refreshRelatedChatHistoryLinks(chat) {
  const view = chat?._sdkRichView;
  if (!chat?.id || typeof view?.ensureRelatedChatLinks !== 'function') return;
  const parentId = String(chat.forkParentChatId || chat.delegationParentChatId || '').trim();
  const parent = parentId ? chats.find((entry) => entry.id === parentId) : null;
  const children = chats.filter((entry) => {
    if (!entry?.id || entry.id === chat.id || entry.isTemporary === true) return false;
    const kind = String(entry.forkKind || '');
    if (kind === 'title' || kind === 'summary') return false;
    return String(entry.forkParentChatId || '') === chat.id
      || String(entry.delegationParentChatId || '') === chat.id;
  });
  view.ensureRelatedChatLinks({
    parent: parentId
      ? {
        chatId: parentId,
        title: parent?.title || parentId.slice(0, 8),
        reason: String(chat.forkKind || ''),
      }
      : null,
    children: children.map((entry) => ({
      chatId: entry.id,
      title: entry.title || String(entry.id).slice(0, 8),
      reason: String(entry.forkKind || ''),
    })),
  });
}

/**
 * Creates a new workspace chat with another harness (regular app, not widget).
 *
 * @param {object} chat
 * @param {string} nextHarness
 * @param {string} nextModel
 * @returns {Promise<{ ok: boolean, chat?: object, error?: string }>}
 */
async function createAppChatForHarnessSwitch(chat, nextHarness, nextModel) {
  const ctx = getWorkspaceContextForChat();
  const workspaceFile = String(chat?.workspaceFile || ctx?.workspaceFile || '').trim();
  const workspaceFolder = String(chat?.workspaceFolder || ctx?.workspaceFolder || '').trim();
  if (!workspaceFile) {
    return { ok: false, error: t('chat.noWorkspaceSelected') };
  }
  if (!workspaceFolder) {
    return { ok: false, error: t('chat.selectFolderInNewChatForm') };
  }
  const payload = {
    workspaceFile,
    workspaceFolder,
    agentTransport: nextHarness,
    model: nextModel,
    sdkMode: String(chat?.sdkMode || 'agent').trim() || 'agent',
    sdkUiMode: String(chat?.sdkUiMode || 'compact').trim() || 'compact',
  };
  let data = null;
  try {
    data = await api.postChat(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data?.ok || !data.chat?.id) {
    return { ok: false, error: data?.error || t('chat.harnessSwitchFailed') };
  }
  const created = data.chat;
  created.agentTransport = normalizeNewChatHarness(created.agentTransport);
  created.sdkMode = normalizeSdkMode(created.sdkMode);
  created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode);
  if (!chats.some((entry) => entry.id === created.id)) chats.push(created);
  renderChatList();
  notifySidebar();
  return { ok: true, chat: created };
}

/**
 * @param {object} chat
 * @returns {Promise<string>}
 */
async function readChatTranscriptForHandoff(chat) {
  if (!chat?.id) return '';
  let sourceText = stripAnsi(
    chat._sdkRichView?.getCopyText?.() ||
      (typeof chat._buffer === 'string' ? chat._buffer : '') ||
      readChatBufferFromLocalStorage(chat.id)
  ).trim();
  if (sourceText.length >= FORK_MIN_TEXT_LEN) return sourceText;
  const fallbackText = await resolveChatTextForFork(chat);
  if (fallbackText.length > sourceText.length) return fallbackText;
  return sourceText;
}

/**
 * @param {object} chat
 * @param {string} initialPrompt
 * @param {string} [displayText]
 */
function sendPromptWhenChatReady(chat, initialPrompt, displayText) {
  if (!chat?.id) return;
  const prompt = typeof initialPrompt === 'string' ? initialPrompt.trim() : '';
  if (!prompt) return;
  let attempts = 0;
  const trySend = () => {
    const live = chats.find((entry) => entry.id === chat.id) || chat;
    attempts += 1;
    if (live.ws?.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        sendTextToAgent(live, prompt, {
          displayText,
          sdkMode: live.sdkMode,
        });
        maybeAutoNameNewChat(live, prompt);
      }, 400);
      return;
    }
    if (attempts >= 80) return;
    setTimeout(trySend, 250);
  };
  ensureChatConnection(chat);
  trySend();
}

/**
 * Create a new chat on another harness and optionally hand off the transcript.
 *
 * @param {object} chat
 * @param {string} nextHarness
 * @param {string} nextModel
 * @param {{ action: string, includeContext: boolean }} choice
 * @returns {Promise<{ ok: boolean, chatId?: string, title?: string, harness?: string, oldChat?: string, handoff?: boolean, error?: string }>}
 */
async function executeHarnessSwitch(chat, nextHarness, nextModel, choice) {
  const currentHarness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  const disposition = choice.action;
  const includeContext = choice.includeContext === true;
  let handoffPrompt = '';
  if (includeContext) {
    const sourceText = await readChatTranscriptForHandoff(chat);
    handoffPrompt = buildHarnessHandoffPrompt({
      sourceText,
      fromHarness: currentHarness,
      toHarness: nextHarness,
      fromModel: chat.model,
      toModel: nextModel,
      sourceChatId: chat.id,
      sourceChatTitle: chat.title,
    });
  }
  const oldChatId = chat.id;
  const widgetMode = isEmbedWidgetMode();
  let pageUrl = '';
  /** @type {{ ok?: boolean, chat?: { id?: string }, error?: string } | null} */
  let result = null;
  if (widgetMode) {
    const host = await requestWidgetHostUrl().catch(() => ({ url: '' }));
    const hostPageUrl = typeof host?.url === 'string' ? host.url.trim() : '';
    pageUrl = hostPageUrl || getChatWidgetPinnedUrl(chat) || '';
    if (!pageUrl) {
      return { ok: false, error: t('chat.harnessSwitchMissingPageUrl') };
    }
    result = await createPageLinkedChat({
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
  } else {
    result = await createAppChatForHarnessSwitch(chat, nextHarness, nextModel);
  }
  if (!result?.ok || !result.chat?.id) {
    return { ok: false, error: result?.error || t('chat.harnessSwitchFailed') };
  }
  selectedHarness = nextHarness;
  saveLastSelectedHarness(selectedHarness);
  await applyOldChatDisposition(chat, result.chat.id, disposition);
  if (widgetMode && pageUrl) {
    await loadChatsFromServer({
      pinnedTo: pageUrl,
      includeArchived: true,
      preferChatId: result.chat.id,
      skipAutoSelect: true,
    });
  }
  if (disposition === 'delete' && chats.some((entry) => entry.id === oldChatId)) {
    closeChat(oldChatId, { skipApiDelete: false, switchToChatId: result.chat.id });
  }
  adoptCreatedChat(result.chat);
  if (handoffPrompt) {
    const liveChat = chats.find((entry) => entry.id === result.chat.id) || result.chat;
    sendPromptWhenChatReady(liveChat, handoffPrompt, t('chat.harnessHandoffDisplayText'));
  }
  return {
    ok: true,
    chatId: result.chat.id,
    title: String(result.chat.title || '').trim() || 'untitled',
    harness: nextHarness,
    oldChat: disposition,
    handoff: includeContext,
  };
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
    const choice = await promptOldChatDispositionChoice();
    if (choice == null) {
      clearPendingHarnessSwitch(chat);
      return;
    }
    const result = await executeHarnessSwitch(chat, nextHarness, nextModel, choice);
    if (!result.ok) {
      window.alert(result.error || t('chat.harnessSwitchFailed'));
      clearPendingHarnessSwitch(chat);
    }
  } finally {
    switchHarnessInFlight = false;
    pendingWidgetHarnessSwitch = null;
    if (sharedSdkModeBar) sharedSdkModeBar.pendingHarness = '';
  }
}

/**
 * Persist an approved plan to the linked Todo when present.
 * Best-effort: implementation can still proceed if sync fails.
 *
 * @param {object} chat
 * @returns {Promise<void>}
 */
async function approveChatPlan(chat) {
  if (!chat?.id) return;
  try {
    const data = await api.postChatSyncTodoPlan(chat.id, { approved: true });
    const nextTodoId = typeof data?.chat?.todoId === 'string' ? data.chat.todoId.trim() : '';
    if (nextTodoId) chat.todoId = nextTodoId;
  } catch {
    // Plan sync is best-effort; implementation can still proceed.
  }
}

/**
 * @param {object} chat
 * @param {string} extraInstructions
 */
async function handleExecuteDelegationCommand(chat, extraInstructions) {
  if (!chat?.id) return;
  try {
    const listed = await api.getChatDelegations(chat.id);
    const active = Array.isArray(listed?.delegations)
      ? listed.delegations.find((row) => {
        const status = String(row?.status || '');
        return status === 'queued' || status === 'starting' || status === 'running'
          || status === 'waiting_for_input' || status === 'cancelling';
      })
      : null;
    if (active) {
      chat._sdkRichView?.appendMetaNotice?.(t('chat.delegationAlreadyActive'));
      return;
    }
  } catch {
    // listing is best-effort; start may still succeed
  }
  const saved = readLastDelegationExecutor();
  if (!saved.harness || !saved.model) {
    await approveChatPlan(chat);
    openNewChatModal({
      buildPlanFromChatId: chat.id,
      workspaceFile: chat.workspaceFile,
      workspaceFolder: chat.workspaceFolder,
    });
    return;
  }
  await approveChatPlan(chat);
  const result = await startDelegationFromParent(chat, {
    harness: saved.harness,
    model: saved.model,
    extraInstructions,
  });
  if (!result?.ok) {
    if (result?.code === 'plan_missing') {
      alert(result.error || t('chat.delegationNoPlan'));
      return;
    }
    if (result?.code === 'plan_revision_conflict' || !saved.harness) {
      openNewChatModal({
        buildPlanFromChatId: chat.id,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
      return;
    }
    alert(result?.error || t('chat.delegationStartFailed'));
    return;
  }
  if (result.chat?.id) {
    result.chat.agentTransport = normalizeNewChatHarness(result.chat.agentTransport || saved.harness);
    result.chat.sdkMode = 'agent';
    adoptCreatedChat(result.chat);
  }
  notifySidebar();
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
      await approveChatPlan(chat);
      await setChatSdkMode(chat, 'agent');
      sendTextToAgent(chat, buildApprovedPlanImplementPrompt(chat.id), {
        sdkMode: 'agent',
        displayText: t('chat.buildPlanDisplayText'),
      });
    })();
  });
  bar.addEventListener('cr-sdk-build-plan-new-agent', () => {
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
    if (!chat?.id) return;
    void (async () => {
      await approveChatPlan(chat);
      openNewChatModal({
        buildPlanFromChatId: chat.id,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
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
  bar.enabledHarnesses = getEnabledHarnessIds();
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
  const normalized = mode === 'plan' || mode === 'agent' || mode === 'ask' ? mode : '';
  if (!normalized) return { ok: false, error: 'Mode must be plan, agent, or ask' };
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
  if (!chat) return false;
  const nextModel = normalizeModelValue(model);
  const prevModel = normalizeModelValue(chat.model || 'auto');
  if (nextModel === prevModel) {
    syncChatSdkModeUi(chat);
    return true;
  }
  appLogger.log('api-request', 'PATCH /api/chats/' + chat.id + ' (model)', { model: nextModel });
  let data = null;
  try {
    data = await api.patchChat(chat.id, { model: nextModel });
  } catch (err) {
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id + ' (model)', String(err));
    syncChatSdkModeUi(chat);
    return false;
  }
  appLogger.log('api-response', 'PATCH /api/chats/' + chat.id + ' (model)', data);
  if (!data?.ok) {
    syncChatSdkModeUi(chat);
    return false;
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
  return true;
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
    displayText: opts.displayText,
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
 * Click a pending OpenCode permission or question control in the active chat.
 *
 * @param {'up'|'down'|'left'|'right'|'enter'|'escape'|'y'|'n'} direction
 * @returns {boolean}
 */
function clickPendingChatPrompt(direction) {
  const chat = activeChatId ? chats.find((entry) => entry.id === activeChatId) : null;
  const pane = chat?.pane;
  if (!pane) return false;
  const permission = pane.querySelector(
    '.sdk-rich-opencode-permission:not(.sdk-rich-opencode-permission--answered):not(.sdk-rich-opencode-permission--resolved)'
  );
  if (permission instanceof HTMLElement) {
    if (direction === 'y' || direction === 'enter') {
      const onceBtn = permission.querySelector('.sdk-rich-opencode-permission-once');
      if (onceBtn instanceof HTMLElement) {
        onceBtn.click();
        return true;
      }
    }
    if (direction === 'n' || direction === 'escape') {
      const rejectBtn = permission.querySelector('.sdk-rich-opencode-permission-reject');
      if (rejectBtn instanceof HTMLElement) {
        rejectBtn.click();
        return true;
      }
    }
  }
  const question = pane.querySelector(
    '.sdk-rich-opencode-question:not(.sdk-rich-opencode-question--answered):not(.sdk-rich-opencode-question--rejected)'
  );
  if (question instanceof HTMLElement) {
    if (direction === 'y' || direction === 'enter') {
      const submitBtn = question.querySelector('.sdk-rich-opencode-question-submit');
      if (submitBtn instanceof HTMLElement) {
        submitBtn.click();
        return true;
      }
    }
    if (direction === 'n' || direction === 'escape') {
      const rejectBtn = question.querySelector('.sdk-rich-opencode-question-reject');
      if (rejectBtn instanceof HTMLElement) {
        rejectBtn.click();
        return true;
      }
    }
  }
  return false;
}

/**
 * Send a navigation or confirm key to the active chat.
 * PTY chats get the raw sequence; harness chats click a pending permission/question.
 *
 * @param {'up'|'down'|'left'|'right'|'enter'|'escape'|'y'|'n'} direction
 * @returns {boolean} true when sent
 */
export function sendNavKeyToActiveChat(direction) {
  const sequence = CHAT_NAV_SEQUENCES[direction];
  if (sequence && sendKeySequenceToActiveChat(sequence)) return true;
  return clickPendingChatPrompt(direction);
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
  onChatGone: (chat) => {
    if (!chat?.id) return;
    if (chat._sdkContextResetPending || chat._sdkContextFreshSession) return;
    removedChatIds.add(chat.id);
    closeChat(chat.id, { skipApiDelete: true });
  },
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
  onAgentStatesChange: () => {
    refreshSidebarChatStates();
    updateChatListModalStates();
  },
});

initChatListResumeSync({
  refresh: (query) => loadChatsFromServer(query),
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

export function applyCodeBuddyEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyCodeBuddyEnabledModels(enabledKeys);
}

export function applyDeepSeekEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyDeepSeekEnabledModels(enabledKeys);
}

export function applyQwenEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyQwenEnabledModels(enabledKeys);
}

export function applyCodexEnabledModels(enabledKeys) {
  chatModelSelectApi?.applyCodexEnabledModels(enabledKeys);
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

/** @type {((workspaceFile: string, workspaceFolder?: string) => Promise<boolean>|boolean)|null} */
let workspaceSwitchHook = null;

/**
 * App.js registers header workspace switching here so voice tools can change
 * project without importing App (that would close a cycle through the send bar).
 * @param {((workspaceFile: string, workspaceFolder?: string) => Promise<boolean>|boolean)|null} fn
 * @returns {void}
 */
export function setWorkspaceSwitchHook(fn) {
  workspaceSwitchHook = typeof fn === 'function' ? fn : null;
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
      applySidebarChatStatusEl(awaitingEl, meta, {
        escapeHtml,
        title: t('sidebar.stateTitle', { label: meta.label }),
      });
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
  if (!chat?._sdkRichView && !chat?._serverRunState) return null;
  const pending = readHarnessPendingFlags(chat);
  const queuedCount = chat._sdkRichView?.queuedCount || Number(chat._sdkServerQueuedCount) || 0;
  return resolveHarnessChatStateMeta({
    connection: chat._connectionStatus || 'disconnected',
    agent: getChatAgentState(chat),
    hasPendingQuestion: pending.hasPendingQuestion,
    hasPendingPermission: pending.hasPendingPermission,
    queuedCount,
    serverRunState: chat._serverRunState || null,
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
  if (structuredReplayDone && hasSdkHistoryRoomWatermarks(chat)) {
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
  if (!chat || isChatPaneMounted(chat)) return;
  if (isEmbedBootDomReady()) {
    openTerminal(chat);
    return;
  }
  if (attempt >= OPEN_TERMINAL_MAX_ATTEMPTS) return;
  window.setTimeout(() => scheduleOpenTerminalWhenReady(chat, attempt + 1), OPEN_TERMINAL_RETRY_MS);
}

function isChatPaneMounted(chat) {
  return !!(chat?.pane && chat.pane.isConnected);
}

function openTerminal(chat) {
  if (isChatPaneMounted(chat)) return;
  if (chat.pane && !chat.pane.isConnected) {
    try {
      chat._sdkRichView?.destroy?.();
    } catch {
      // Detached pane — rebuild a fresh one with a send bar.
    }
    chat.pane = null;
    chat._sdkRichView = null;
    chat.term = null;
    chat.fitAddon = null;
  }
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
  if (chat.delegationParentChatId) {
    const parentLink = document.createElement('button');
    parentLink.type = 'button';
    parentLink.className = 'chat-delegation-parent-link';
    parentLink.textContent = t('chat.delegationOpenParent');
    parentLink.addEventListener('click', () => {
      selectChat(chat.delegationParentChatId);
    });
    pane.appendChild(parentLink);
  }
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
    const executeCommand = parseDelegationCommand(rawText);
    if (executeCommand) {
      void handleExecuteDelegationCommand(chat, executeCommand.extraInstructions);
      writeChatDraft(chat.id, '');
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
    let displayText = rawText;
    if (hasPageSelection) {
      const pageBlock = formatHostPagePickContextBlock(meta.pageSelectionContext);
      payloadText = pageBlock + (rawText.trim() ? `\n\n${rawText}` : '');
    }
    if (!isTitlePrompt) {
      const inherited = consumePendingInheritedPrompt(chat, payloadText);
      if (inherited) {
        payloadText = inherited.payloadText;
        displayText = inherited.displayText || rawText;
      }
      maybeAutoNameNewChat(chat, rawText);
    }
    sendTextToAgent(chat, payloadText, { displayText });
    writeChatDraft(chat.id, '');
    return true;
  }

  const sendBar = createSendBar({
    placeholder: t('chat.commandPlaceholder'),
    showToggleExtra: true,
    getExtraBarWrap: () => document.getElementById('chat-extra-bar-wrap'),
    showArrows: false,
    // Stop lives in chat settings (next to Delete chat), not on the send bar.
    showStop: false,
    showExtraBarStop: false,
    onSend: chatOnSend,
    onArrowUp: () => {},
    onArrowDown: () => {},
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
  if (chat.id === activeChatId) pane.classList.add('active');

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
    onForkFromPoint: ({ createdAt }) => {
      const point = typeof createdAt === 'string' ? createdAt.trim() : '';
      if (!point || !chat?.id) return;
      openNewChatModal({
        forkFromChatId: chat.id,
        upToCreatedAt: point,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    },
    onPassMessageToChild: (point) => {
      if (!chat?.id || !point?.text) return;
      openNewChatModal({
        passMessageFromChatId: chat.id,
        historySeq: point.historySeq,
        createdAt: point.createdAt,
        text: point.text,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    },
    onReplyMessageToParent: (point) => {
      if (!chat?.id || !point?.text) return;
      if (chat._mailboxReplyBusy) return;
      const parentId = String(chat.delegationParentChatId || '').trim();
      const parent = parentId ? chats.find((row) => row.id === parentId) : null;
      const key = peekDelegationIdempotencyKey(`${chat.id}:reply:${point.historySeq || point.createdAt || point.text.slice(0, 24)}`);
      void (async () => {
        const choice = await showChoiceDialog({
          heading: t('chat.mailboxReplyPreviewHeading'),
          body: t('chat.mailboxReplyPreviewBody', { parent: parent?.title || parentId || '—' }),
          cancelLabel: t('chat.cancel'),
          options: [{ value: 'send', label: t('chat.mailboxReplySend'), variant: 'primary' }],
        });
        if (choice !== 'send' && choice?.value !== 'send') return;
        chat._mailboxReplyBusy = true;
        try {
          const contentHash = await hashTextSha256(point.text);
          const res = await api.postChatMailboxReply(chat.id, {
            historySeq: point.historySeq,
            contentHash,
            textSnapshot: point.text,
            idempotencyKey: key,
          });
          if (res?.ok && !res.replayed) {
            clearDelegationIdempotencyKey(`${chat.id}:reply:${point.historySeq || point.createdAt || point.text.slice(0, 24)}`);
          }
          if (!res?.ok) {
            alert(res?.error || t('chat.mailboxReplyFailed'));
            return;
          }
          chat._sdkRichView?.appendMetaNotice?.(t('chat.mailboxReplySent', {
            parent: parent?.title || parentId || '—',
          }));
        } catch {
          alert(t('chat.serverConnectionError'));
        } finally {
          chat._mailboxReplyBusy = false;
        }
      })();
    },
    onOpenCodeQuestionReply: (payload) => sendOpenCodeQuestionReply(chat, payload),
    onOpenCodePermissionReply: (payload) => sendOpenCodePermissionReply(chat, payload),
    onOpenDelegationChat: (childChatId) => {
      if (childChatId) selectChat(childChatId);
    },
    onCancelDelegation: (delegationId) => {
      if (!delegationId) return;
      void api.postDelegationCancel(delegationId);
    },
    onAcknowledgeDelegation: (delegationId) => {
      if (!delegationId) return;
      void api.postDelegationAck(delegationId, { reason: 'reviewed' }).then((res) => {
        if (!res?.ok) return;
        if (chat._sdkHistoryHydrating) return;
        void syncSdkHistoryOnResume(chat, { reason: 'delegation_ack' }).catch(() => {});
      }).catch(() => {});
    },
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
        refreshRelatedChatHistoryLinks(chat);
      }
    })();
}

function closeChatDeleteConfirmModal() {
  pendingDeleteChatId = null;
  chatDeleteConfirmModalApi?.close();
}

function syncChatDeleteConfirmModal(isAgentWorking) {
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
    skipPreference: getSkipChatDeleteConfirm(),
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
  pendingDeleteChatId = chatId;
  const titleEl = document.getElementById('chat-delete-confirm-chat-title');
  if (titleEl) titleEl.textContent = title;
  syncChatDeleteConfirmModal(isAgentWorking);
  if (!preserveListOpen) closeChatSettingsModal();
  if (!preserveListOpen) closeChatListModal();
  openChatDeleteConfirmModal();
}

function openChatDeleteConfirmModal() {
  if (!chatDeleteConfirmModalApi) {
    const modalEl = document.getElementById('chat-delete-confirm-modal');
    if (modalEl) {
      chatDeleteConfirmModalApi = initModal(modalEl, {
        backdropSelector: '.chat-settings-backdrop',
      });
    }
  }
  chatDeleteConfirmModalApi?.open();
  const modalEl = document.getElementById('chat-delete-confirm-modal');
  if (modalEl) modalEl.hidden = false;
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

/**
 * Selects a chat that was just created on the current host page.
 * Skips widget URL navigation so the new pane is shown immediately.
 * @param {string} chatId
 */
function selectNewlyCreatedChat(chatId) {
  if (!chatId) return;
  pinnedChatSelectionGuard = true;
  try {
    performSelectChat(chatId);
  } finally {
    pinnedChatSelectionGuard = false;
  }
}

/**
 * Merge server fields onto an existing runtime chat without dropping the pane/WS.
 * @param {object} target
 * @param {object} source
 */
function mergeCreatedChatRecord(target, source) {
  target.agentTransport = normalizeNewChatHarness(source.agentTransport || target.agentTransport || 'sdk');
  target.sdkMode = normalizeSdkMode(source.sdkMode || target.sdkMode);
  target.sdkUiMode = normalizeSdkUiMode(source.sdkUiMode || target.sdkUiMode);
  if (source.title) target.title = source.title;
  if (source.model) target.model = source.model;
  if (source.workspaceFile) target.workspaceFile = source.workspaceFile;
  if (source.workspaceFolder) target.workspaceFolder = source.workspaceFolder;
  if (typeof source.widgetPinnedUrl === 'string' && source.widgetPinnedUrl.trim()) {
    target.widgetPinnedUrl = source.widgetPinnedUrl.trim();
  }
  if (typeof source.todoId === 'string' && source.todoId.trim()) {
    target.todoId = source.todoId.trim();
  }
}

/**
 * Inserts a newly created chat (or reuses the existing row) and shows its pane.
 * @param {object} chat
 * @returns {object | null}
 */
function adoptCreatedChat(chat) {
  if (!chat?.id) return null;
  chat.agentTransport = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  chat.sdkMode = normalizeSdkMode(chat.sdkMode);
  chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
  const pinnedUrl = getChatWidgetPinnedUrl(chat);
  if (pinnedUrl) {
    chats.forEach((item) => {
      if (item.id === chat.id) return;
      const otherPinned = getChatWidgetPinnedUrl(item);
      if (otherPinned && isSamePageUrl(otherPinned, pinnedUrl)) {
        delete item.widgetPinnedUrl;
      }
    });
  }
  const existing = chats.find((entry) => entry.id === chat.id);
  if (existing) {
    mergeCreatedChatRecord(existing, chat);
    if (!existing.pane) openTerminal(existing);
    renderChatList();
    selectNewlyCreatedChat(existing.id);
    return existing;
  }
  chats.push(chat);
  renderChatList();
  openTerminal(chat);
  selectNewlyCreatedChat(chat.id);
  return chat;
}

function openCreatedChatWithPrompt(chat, initialPrompt, displayText) {
  const live = adoptCreatedChat(chat);
  if (!live) return null;
  sendPromptWhenChatReady(live, initialPrompt, displayText);
  return live;
}

/**
 * Open a conversation fork without sending. The continue/handoff prompt stays in
 * the send field and is delivered on the first user send.
 *
 * @param {object} chat
 * @param {string} initialPrompt
 * @param {string} [displayText]
 * @returns {object|null}
 */
function openCreatedForkChat(chat, initialPrompt, displayText) {
  const prompt = typeof initialPrompt === 'string' ? initialPrompt.trim() : '';
  const draft = typeof displayText === 'string' ? displayText.trim() : '';
  if (chat?.id && draft) writeChatDraft(chat.id, draft);
  const live = adoptCreatedChat(chat);
  if (!live) return null;
  if (prompt) {
    live._pendingInheritedPrompt = prompt;
    live._pendingInheritedDisplayText = draft;
  }
  return live;
}

/**
 * Pins an explicit new chat to the current widget host page.
 * forceNewPinnedChat avoids reusing the chat already linked to that URL.
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
async function attachWidgetHostPinToCreatePayload(payload) {
  if (!isEmbedWidgetMode() || !isWidgetHostNavigationAvailable()) return payload;
  try {
    const current = await requestWidgetHostUrl();
    const hostPageUrl = typeof current?.url === 'string' ? current.url.trim() : '';
    if (!hostPageUrl) return payload;
    payload.widgetPinnedUrl = hostPageUrl;
    payload.forceNewPinnedChat = true;
  } catch {
    // Pin is optional; the new chat can still start.
  }
  return payload;
}

/**
 * Moves the current page pin onto a chat created by fork/analyze.
 * @param {object} chat
 */
async function pinCreatedChatToHostIfWidget(chat) {
  if (!chat?.id) return;
  const payload = {};
  await attachWidgetHostPinToCreatePayload(payload);
  const hostPageUrl = typeof payload.widgetPinnedUrl === 'string' ? payload.widgetPinnedUrl.trim() : '';
  if (!hostPageUrl) return;
  try {
    const data = await api.patchChat(chat.id, { widgetPinnedUrl: hostPageUrl });
    chat.widgetPinnedUrl = data?.chat?.widgetPinnedUrl || hostPageUrl;
  } catch {
    chat.widgetPinnedUrl = hostPageUrl;
  }
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
      const payload = {
        workspaceFile: parentChat.workspaceFile,
        workspaceFolder: parentChat.workspaceFolder,
        model: parentChat.model,
        agentTransport: parentTransport,
        sdkMode: parentChat.sdkMode,
        sdkUiMode: parentChat.sdkUiMode,
      };
      await attachWidgetHostPinToCreatePayload(payload);
      data = await api.postChat(payload);
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
  if (forkConversation) {
    await pinCreatedChatToHostIfWidget(data.chat);
  }
  const initialPrompt = forkConversation ? data.initialPrompt || message : message;
  const live = openCreatedChatWithPrompt(data.chat, initialPrompt, message);
  syncWidgetPinUrlUi(live || data.chat);
  notifyWidgetParentPagePinChanged();
  writeChatDraft(parentChat.id, '');
  return true;
}

const AGENT_MONITOR_PROMPT = [
  'This is a new sub-chat that analyzes another Cretli chat.',
  'You do not inherit that chat history. Diagnose the parent from its id and the live status snapshot below.',
  'Is the agent working, stuck, waiting for input, or idle? What are the risks and what should happen next.',
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
  const queuedCount = chat._sdkRichView?.queuedCount || Number(chat._sdkServerQueuedCount) || 0;
  const contextTokens =
    Number.isFinite(chat._contextUsageTotalTokens) && chat._contextUsageTotalTokens > 0
      ? String(chat._contextUsageTotalTokens)
      : 'unknown';
  return [
    AGENT_MONITOR_PROMPT,
    '',
    '[Parent chat snapshot]',
    `chatId: ${chat.id}`,
    `title: ${chat.title || 'untitled'}`,
    `harness: ${chat.agentTransport || 'unknown'}`,
    `model: ${chat.model || 'unknown'}`,
    `connection: ${connection}`,
    `agentState: ${agentState}`,
    `terminalTone: ${status.tone}`,
    `terminalLabel: ${status.label}`,
    `awaitingInput: ${awaiting}`,
    `queuedCount: ${queuedCount}`,
    `contextTokens: ${contextTokens}`,
  ].join('\n');
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
      skipAutoSelect: true,
      preferChatId: normalizedId,
      includeArchived: true,
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
  if (chat?._serverRunState?.state === 'waiting' && chat._serverRunState.delegationId) {
    void api.postDelegationAck(chat._serverRunState.delegationId, { reason: 'open_child' }).then((res) => {
      if (!res?.ok || !res.delegation) return;
      chat._serverRunState = {
        ...chat._serverRunState,
        attention: false,
        state: chat._serverRunState.state === 'waiting' ? 'idle' : chat._serverRunState.state,
      };
      refreshSidebarChatStates();
    }).catch(() => {});
  }
  if (chat) openTerminal(chat);
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
  }).catch((err) => {
    console.warn('[chat] title sync failed:', err?.message || err);
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
let cachedCodeBuddyReady = null;
let cachedDeepSeekReady = null;
let cachedQwenReady = null;
let cachedCodexReady = null;

/** True while a chat is being created from the “New chat” modal — blocks double-submit. */
let chatCreateInFlight = false;

/**
 * Resolve whether the given harness is currently ready, based on the last cached status.
 * @param {string} harness
 */
function isNewChatHarnessReady(harness) {
  if (harness === 'openrouter') return cachedOpenRouterReady !== null ? cachedOpenRouterReady : false;
  if (harness === 'opencode') return cachedOpenCodeReady !== null ? cachedOpenCodeReady : false;
  if (harness === 'codebuddy') return cachedCodeBuddyReady !== null ? cachedCodeBuddyReady : false;
  if (harness === 'deepseek') return cachedDeepSeekReady !== null ? cachedDeepSeekReady : false;
  if (harness === 'qwen') return cachedQwenReady !== null ? cachedQwenReady : false;
  if (harness === 'codex') return cachedCodexReady !== null ? cachedCodexReady : false;
  return cachedSdkReady !== null ? cachedSdkReady : false;
}

/**
 * Toggle the loading/disabled state of the “Create chat” button while a chat is being created.
 * @param {boolean} busy
 */
function setNewChatCreateBusy(busy) {
  const btn = document.getElementById('chat-new-create');
  if (!btn) return;
  btn.classList.toggle('is-loading', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) {
    if (btn.dataset.originalLabel === undefined) btn.dataset.originalLabel = btn.textContent;
    btn.textContent = t('chat.creating');
    btn.disabled = true;
  } else {
    if (btn.dataset.originalLabel !== undefined) {
      btn.textContent = btn.dataset.originalLabel;
      delete btn.dataset.originalLabel;
    }
    btn.disabled = !isNewChatHarnessReady(getSelectedNewChatHarness());
  }
}

/**
 * @param {unknown} value
 * @returns {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen'}
 */
function normalizeNewChatHarness(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'opencode') return 'opencode';
  if (raw === 'codebuddy') return 'codebuddy';
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'codex') return 'codex';
  if (raw === 'qwen') return 'qwen';
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
  if (harness === 'codebuddy') return t('chat.harnessErrorCodeBuddy');
  if (harness === 'deepseek') return t('chat.harnessErrorDeepSeek');
  if (harness === 'qwen') return t('chat.harnessErrorQwen');
  if (harness === 'codex') return t('chat.harnessErrorCodex');
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
  } else if (resolvedHarness === 'codebuddy') {
    cachedCodeBuddyReady = ready;
  } else if (resolvedHarness === 'deepseek') {
    cachedDeepSeekReady = ready;
  } else if (resolvedHarness === 'qwen') {
    cachedQwenReady = ready;
  } else if (resolvedHarness === 'codex') {
    cachedCodexReady = ready;
  } else {
    cachedSdkReady = ready;
  }
  // While a chat is being created, never re-enable the button mid-flight.
  if (createBtn) createBtn.disabled = chatCreateInFlight || !ready;
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
      const keyOk = !!status?.opencodeCredentialsEffective;
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

function refreshNewChatCodeBuddyStatus() {
  return api
    .getCodeBuddyStatus()
    .then((status) => {
      const ready = !!(status && status.ready);
      if (getSelectedNewChatHarness() === 'codebuddy') {
        applyNewChatHarnessStatus(
          'codebuddy',
          ready,
          status?.error
            || (!status?.sdkAvailable
              ? t('chat.codebuddySdkMissing')
              : (!status?.cliFound ? t('chat.codebuddyCliMissing') : undefined)),
        );
      } else {
        cachedCodeBuddyReady = ready;
      }
      if (!status?.codebuddyApiKeyEffective) return null;
      return api.getCodeBuddyModels().then((models) => {
        if (models?.ok) chatModelSelectApi.applyAvailableModelsFromCodeBuddy(models);
        if (getSelectedNewChatHarness() === 'codebuddy') {
          chatModelSelectApi.refreshNewChatModelPicker('codebuddy');
        }
      });
    })
    .catch(() => {
      if (getSelectedNewChatHarness() === 'codebuddy') {
        applyNewChatHarnessStatus(
          'codebuddy',
          false,
          t('chat.codebuddyStatusFailed'),
        );
      } else {
        cachedCodeBuddyReady = false;
      }
    });
}

function refreshNewChatDeepSeekStatus() {
  return api
    .getDeepSeekStatus()
    .then((status) => {
      const ready = !!(status && status.ready);
      if (getSelectedNewChatHarness() === 'deepseek') {
        applyNewChatHarnessStatus(
          'deepseek',
          ready,
          status?.error
            || (!status?.sdkAvailable
              ? t('chat.deepseekSdkMissing')
              : (!status?.cliFound ? t('chat.deepseekCliMissing') : undefined)),
        );
      } else {
        cachedDeepSeekReady = ready;
      }
      if (!status?.deepseekApiKeyEffective) return null;
      return api.getDeepSeekModels().then((models) => {
        if (models?.ok) chatModelSelectApi.applyAvailableModelsFromDeepSeek(models);
        if (getSelectedNewChatHarness() === 'deepseek') {
          chatModelSelectApi.refreshNewChatModelPicker('deepseek');
        }
      });
    })
    .catch(() => {
      if (getSelectedNewChatHarness() === 'deepseek') {
        applyNewChatHarnessStatus(
          'deepseek',
          false,
          t('chat.deepseekStatusFailed'),
        );
      } else {
        cachedDeepSeekReady = false;
      }
    });
}

function refreshNewChatQwenStatus() {
  return api
    .getQwenStatus()
    .then((status) => {
      const ready = !!(status && status.ready);
      if (getSelectedNewChatHarness() === 'qwen') {
        applyNewChatHarnessStatus(
          'qwen',
          ready,
          status?.error
            || (!status?.sdkAvailable ? t('chat.qwenSdkMissing') : undefined),
        );
      } else {
        cachedQwenReady = ready;
      }
      if (!status?.qwenApiKeyEffective) return null;
      return api.getQwenModels().then((models) => {
        if (models?.ok) chatModelSelectApi.applyAvailableModelsFromQwen(models);
        if (getSelectedNewChatHarness() === 'qwen') {
          chatModelSelectApi.refreshNewChatModelPicker('qwen');
        }
      });
    })
    .catch(() => {
      if (getSelectedNewChatHarness() === 'qwen') {
        applyNewChatHarnessStatus(
          'qwen',
          false,
          t('chat.qwenStatusFailed'),
        );
      } else {
        cachedQwenReady = false;
      }
    });
}

function refreshNewChatCodexStatus() {
  return api
    .getCodexStatus()
    .then((status) => {
      const ready = !!(status && status.ready);
      if (getSelectedNewChatHarness() === 'codex') {
        applyNewChatHarnessStatus(
          'codex',
          ready,
          status?.error
            || (!status?.sdkAvailable
              ? t('chat.codexSdkMissing')
              : (!status?.cliFound ? (status?.cliHint || t('chat.codexCliMissing')) : undefined)),
        );
      } else {
        cachedCodexReady = ready;
      }
      if (!status?.ready) return null;
      return api.getCodexModels().then((models) => {
        if (models?.ok) chatModelSelectApi.applyAvailableModelsFromCodex(models);
        if (getSelectedNewChatHarness() === 'codex') {
          chatModelSelectApi.refreshNewChatModelPicker('codex');
        }
      });
    })
    .catch(() => {
      if (getSelectedNewChatHarness() === 'codex') {
        applyNewChatHarnessStatus(
          'codex',
          false,
          t('chat.codexStatusFailed'),
        );
      } else {
        cachedCodexReady = false;
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
  let refreshPromise;
  if (harness === 'openrouter') {
    refreshPromise = refreshNewChatOpenRouterStatus(options);
  } else if (harness === 'opencode') {
    refreshPromise = refreshNewChatOpenCodeStatus(options);
  } else if (harness === 'codebuddy') {
    refreshPromise = refreshNewChatCodeBuddyStatus();
  } else if (harness === 'deepseek') {
    refreshPromise = refreshNewChatDeepSeekStatus();
  } else if (harness === 'qwen') {
    refreshPromise = refreshNewChatQwenStatus();
  } else if (harness === 'codex') {
    refreshPromise = refreshNewChatCodexStatus();
  } else {
    refreshPromise = refreshNewChatSdkStatus();
  }
  return Promise.resolve(refreshPromise).finally(() => {
    syncNewChatFavoritePresetUi();
  });
}

const NEW_CHAT_HARNESS_LABEL_KEYS = {
  sdk: 'settings.harnessSdk',
  openrouter: 'settings.harnessOpenRouter',
  opencode: 'settings.harnessOpenCode',
  codebuddy: 'settings.harnessCodeBuddy',
  deepseek: 'settings.harnessDeepSeek',
  qwen: 'settings.harnessQwen',
  codex: 'settings.harnessCodex',
};

function getNewChatFavoritePreset() {
  const model = document.getElementById('chat-new-model-select');
  return normalizeChatPreset({
    harness: getSelectedNewChatHarness(),
    model: model?.value || '',
  });
}

function getNewChatFavoritePresetLabel(preset) {
  const harnessLabel = t(NEW_CHAT_HARNESS_LABEL_KEYS[preset.harness] || preset.harness);
  const modelLabel = chatModelSelectApi?.getModelLabelByValue(preset.model, preset.harness)
    || preset.model;
  return `${harnessLabel} · ${modelLabel}`;
}

function renderNewChatFavoritePresetOptions() {
  const list = document.getElementById('chat-new-favorite-preset-items');
  const triggerLabel = document.getElementById('chat-new-favorite-preset-trigger-label');
  if (!list) return;
  const current = getNewChatFavoritePreset();
  const currentKey = current ? chatPresetKey(current) : '';
  const presets = chatPresets.getPresets();
  const selectedPreset = presets.find((preset) => chatPresetKey(preset) === currentKey);
  if (triggerLabel) {
    triggerLabel.textContent = selectedPreset
      ? getNewChatFavoritePresetLabel(selectedPreset)
      : presets.length
        ? t('chat.favoritePresetPlaceholder')
        : t('chat.favoritePresetEmpty');
  }
  list.textContent = '';
  if (presets.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'chat-list-item chat-list-item-empty';
    empty.setAttribute('role', 'presentation');
    empty.textContent = t('chat.favoritePresetEmpty');
    list.appendChild(empty);
    return;
  }
  for (const preset of presets) {
    const option = document.createElement('li');
    const key = chatPresetKey(preset);
    option.className = 'chat-list-item' + (key === currentKey ? ' is-active' : '');
    option.setAttribute('role', 'option');
    option.setAttribute('tabindex', '0');
    option.setAttribute('aria-selected', key === currentKey ? 'true' : 'false');
    option.dataset.presetKey = key;
    option.textContent = getNewChatFavoritePresetLabel(preset);
    option.addEventListener('click', () => {
      applyNewChatFavoritePreset(key);
      chatNewFavoritePresetDropdownApi?.close?.();
    });
    list.appendChild(option);
  }
}

function syncNewChatFavoritePresetUi() {
  renderNewChatFavoritePresetOptions();
  const button = document.getElementById('chat-new-favorite-preset-toggle');
  if (!button) return;
  const current = getNewChatFavoritePreset();
  const active = !!current && chatPresets.isFavorite(current);
  button.disabled = !current;
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  const label = t(active ? 'chat.removeFavoritePreset' : 'chat.addFavoritePreset');
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = button.querySelector('.mdi');
  if (icon) icon.className = `mdi ${active ? 'mdi-star' : 'mdi-star-outline'}`;
  const hint = document.getElementById('chat-new-favorite-preset-hint');
  if (hint) hint.textContent = chatPresets.getPresets().length
    ? t('chat.favoritePresetHint')
    : t('chat.favoritePresetEmpty');
}

function applyNewChatFavoritePreset(value) {
  const preset = chatPresets.getPresets().find((row) => chatPresetKey(row) === String(value || ''));
  if (!preset) return;
  const harnessSelect = document.getElementById('chat-new-harness-select');
  const modelSelect = document.getElementById('chat-new-model-select');
  if (!(harnessSelect instanceof HTMLSelectElement) || !(modelSelect instanceof HTMLSelectElement)) return;
  harnessSelect.value = preset.harness;
  chatModelSelectApi.setModelPickerHarness(preset.harness);
  chatModelSelectApi.renderModelSelectOptions(modelSelect, preset.model);
  modelSelect.value = preset.model;
  chatNewModelDropdownApi?.refresh?.();
  chatNewFavoritePresetDropdownApi?.close?.();
  syncNewChatFavoritePresetUi();
  void refreshNewChatHarnessStatus({ forceCloseDropdown: true }).then(() => {
    // A freshly loaded catalog can replace the model value; re-apply the chosen preset.
    if (getSelectedNewChatHarness() !== preset.harness) return;
    chatModelSelectApi.setModelPickerHarness(preset.harness);
    chatModelSelectApi.renderModelSelectOptions(modelSelect, preset.model);
    modelSelect.value = preset.model;
    chatNewModelDropdownApi?.refresh?.();
    syncNewChatFavoritePresetUi();
  });
}

function toggleNewChatFavoritePreset() {
  const current = getNewChatFavoritePreset();
  if (!current) return;
  chatPresets.toggleFavorite(current);
  syncNewChatFavoritePresetUi();
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

function applyNewChatModalForkLabels() {
  const heading = document.getElementById('chat-new-heading');
  const createBtn = document.getElementById('chat-new-create');
  let headingText = t('chat.new');
  let createText = t('chat.create');
  if (monitorSourceChatId) {
    headingText = t('chat.monitorHeading');
    createText = t('chat.monitorCreate');
  } else if (passMessageSourceChatId) {
    headingText = t('chat.passMessageHeading');
    const parent = getNewChatModalSourceChat();
    createText = readDelegationExecutionMode(parent) === 'agent' && String(parent?.sdkMode || '') === 'plan'
      ? t('chat.passMessageCreateAgent')
      : t('chat.passMessageCreate');
  } else if (buildPlanSourceChatId) {
    headingText = t('chat.buildPlanHeading');
    const parent = getNewChatModalSourceChat();
    createText = readDelegationExecutionMode(parent) === 'agent' && String(parent?.sdkMode || '') === 'plan'
      ? t('chat.buildPlanCreateAgent')
      : t('chat.buildPlanCreate');
  } else if (forkSourceChatId) {
    headingText = forkUpToCreatedAt ? t('chat.forkFromMessageHeading') : t('chat.forkHeading');
    createText = t('chat.forkCreate');
  }
  if (heading) heading.textContent = headingText;
  if (createBtn) createBtn.textContent = createText;
}

function getNewChatModalSourceChat() {
  const id = monitorSourceChatId || passMessageSourceChatId || buildPlanSourceChatId || forkSourceChatId;
  if (!id) return null;
  return chats.find((entry) => entry.id === id) || null;
}

/**
 * Open the new-chat modal. Fork/monitor/build-plan modes reuse the harness+model form.
 *
 * @param {{
 *   forkFromChatId?: string,
 *   upToCreatedAt?: string,
 *   monitorFromChatId?: string,
 *   buildPlanFromChatId?: string,
 *   passMessageFromChatId?: string,
 *   historySeq?: number,
 *   createdAt?: string,
 *   text?: string,
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 * }} [options]
 */
export function openNewChatModal(options = {}) {
  if (!chatNewModalApi) return;
  const requestedForkId =
    options && typeof options.forkFromChatId === 'string' ? options.forkFromChatId.trim() : '';
  const requestedMonitorId =
    options && typeof options.monitorFromChatId === 'string'
      ? options.monitorFromChatId.trim()
      : '';
  const requestedBuildPlanId =
    options && typeof options.buildPlanFromChatId === 'string'
      ? options.buildPlanFromChatId.trim()
      : '';
  const requestedPassMessageId =
    options && typeof options.passMessageFromChatId === 'string'
      ? options.passMessageFromChatId.trim()
      : '';
  const forkChat = requestedForkId ? chats.find((entry) => entry.id === requestedForkId) : null;
  const monitorChat = requestedMonitorId
    ? chats.find((entry) => entry.id === requestedMonitorId)
    : null;
  const buildPlanChat = requestedBuildPlanId
    ? chats.find((entry) => entry.id === requestedBuildPlanId)
    : null;
  const passMessageChat = requestedPassMessageId
    ? chats.find((entry) => entry.id === requestedPassMessageId)
    : null;
  if (
    (requestedForkId && !forkChat) ||
    (requestedMonitorId && !monitorChat) ||
    (requestedBuildPlanId && !buildPlanChat) ||
    (requestedPassMessageId && !passMessageChat)
  ) {
    forkSourceChatId = null;
    forkUpToCreatedAt = null;
    monitorSourceChatId = null;
    buildPlanSourceChatId = null;
    passMessageSourceChatId = null;
    alert(t('chat.noActiveChat'));
    return;
  }
  const requestedCut =
    options && typeof options.upToCreatedAt === 'string' ? options.upToCreatedAt.trim() : '';
  if (monitorChat) {
    monitorSourceChatId = monitorChat.id;
    forkSourceChatId = null;
    forkUpToCreatedAt = null;
    buildPlanSourceChatId = null;
    passMessageSourceChatId = null;
  } else if (passMessageChat) {
    passMessageSourceChatId = passMessageChat.id;
    passMessageMeta = {
      historySeq: Number(options.historySeq) > 0 ? Number(options.historySeq) : 0,
      createdAt: typeof options.createdAt === 'string' ? options.createdAt.trim() : '',
      text: typeof options.text === 'string' ? options.text : '',
    };
    forkSourceChatId = null;
    forkUpToCreatedAt = null;
    monitorSourceChatId = null;
    buildPlanSourceChatId = null;
  } else if (buildPlanChat) {
    buildPlanSourceChatId = buildPlanChat.id;
    forkSourceChatId = null;
    forkUpToCreatedAt = null;
    monitorSourceChatId = null;
    passMessageSourceChatId = null;
  } else {
    forkSourceChatId = forkChat?.id || null;
    forkUpToCreatedAt = forkChat && requestedCut ? requestedCut : null;
    monitorSourceChatId = null;
    buildPlanSourceChatId = null;
    passMessageSourceChatId = null;
  }
  const sourceChat = monitorChat || passMessageChat || buildPlanChat || forkChat;
  applyDefaultNewChatHarnessToModal();
  const harnessSel = document.getElementById('chat-new-harness-select');
  const lastExecutor = (buildPlanChat || passMessageChat)
    ? readLastDelegationExecutor()
    : { harness: '', model: '' };
  if (harnessSel instanceof HTMLSelectElement && selectedHarness) {
    harnessSel.value = normalizeNewChatHarness(selectedHarness);
  }
  if (harnessSel instanceof HTMLSelectElement && sourceChat) {
    harnessSel.value = normalizeNewChatHarness(sourceChat.agentTransport || 'sdk');
  }
  if (harnessSel instanceof HTMLSelectElement && lastExecutor.harness) {
    harnessSel.value = normalizeNewChatHarness(lastExecutor.harness);
  }
  const preferredWorkspaceFile =
    options && typeof options.workspaceFile === 'string' ? options.workspaceFile.trim() : '';
  const preferredWorkspaceFolder =
    options && typeof options.workspaceFolder === 'string' ? options.workspaceFolder.trim() : '';
  const ctx = getWorkspaceContextForChat();
  selectedWorkspaceFile =
    preferredWorkspaceFile ||
    sourceChat?.workspaceFile ||
    ctx?.workspaceFile ||
    (workspaces[0] && workspaces[0].workspaceFile) ||
    null;
  selectedWorkspaceFolder =
    preferredWorkspaceFolder || sourceChat?.workspaceFolder || ctx?.workspaceFolder || null;
  chatController.renderWorkspacesSelects();
  ensureEmbedNewChatFolderSelect();
  const model = document.getElementById('chat-new-model-select');
  if (model) {
    model.value = lastExecutor.model || sourceChat?.model || selectedModel || 'auto';
  }
  chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
  if (model) {
    chatNewModelDropdownApi?.refresh?.();
  }
  syncNewChatFavoritePresetUi();
  chatNewFolderDropdownApi?.refresh?.();
  const titleInput = document.getElementById('chat-new-title-input');
  if (titleInput) {
    titleInput.value = monitorChat
      ? t('chat.monitorDefaultTitle', { title: monitorChat.title || 'Chat' })
      : passMessageChat
        ? t('chat.passMessageDefaultTitle', { title: passMessageChat.title || 'Chat' })
        : buildPlanChat
        ? t('chat.buildPlanDefaultTitle', { title: buildPlanChat.title || 'Chat' })
        : '';
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
        : harness === 'codebuddy'
          ? cachedCodeBuddyReady !== null
            ? cachedCodeBuddyReady
            : false
          : harness === 'deepseek'
            ? cachedDeepSeekReady !== null
              ? cachedDeepSeekReady
              : false
            : harness === 'qwen'
              ? cachedQwenReady !== null
                ? cachedQwenReady
                : false
            : harness === 'codex'
              ? cachedCodexReady !== null
                ? cachedCodexReady
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
  applyNewChatModalForkLabels();
  chatNewModalApi.open();
  if (titleInput) titleInput.focus();
  void loadWorkspaces().then(() => {
    ensureEmbedNewChatFolderSelect();
    const m = document.getElementById('chat-new-model-select');
    const source = getNewChatModalSourceChat();
    if (m) m.value = source?.model || selectedModel || 'auto';
    chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
    chatNewModelDropdownApi?.refresh?.();
    syncNewChatFavoritePresetUi();
  });
  void refreshNewChatHarnessStatus();
  if (passMessageChat) {
    void prepareMessageDelegationModal(passMessageChat, passMessageMeta).then(() => {
      const modelSel = document.getElementById('chat-new-model-select');
      chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
      if (modelSel instanceof HTMLSelectElement && lastExecutor.model) {
        modelSel.value = lastExecutor.model;
      }
      chatNewModelDropdownApi?.refresh?.();
      syncNewChatFavoritePresetUi();
      void refreshNewChatHarnessStatus();
      document.getElementById('chat-new-plan-preview-child-agent')?.addEventListener('change', applyNewChatModalForkLabels);
      applyNewChatModalForkLabels();
    });
  } else if (buildPlanChat) {
    void prepareBuildPlanModal(buildPlanChat).then(() => {
      const modelSel = document.getElementById('chat-new-model-select');
      chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
      if (modelSel instanceof HTMLSelectElement && lastExecutor.model) {
        modelSel.value = lastExecutor.model;
      }
      chatNewModelDropdownApi?.refresh?.();
      syncNewChatFavoritePresetUi();
      void refreshNewChatHarnessStatus();
      document.getElementById('chat-new-plan-preview-child-agent')?.addEventListener('change', applyNewChatModalForkLabels);
      applyNewChatModalForkLabels();
    });
  } else {
    clearDelegationPlanPreview();
  }
}

function closeNewChatModal() {
  chatNewFolderDropdownApi?.close?.();
  chatNewModelDropdownApi?.close?.();
  chatNewFavoritePresetDropdownApi?.close?.();
  forkSourceChatId = null;
  forkUpToCreatedAt = null;
  monitorSourceChatId = null;
  buildPlanSourceChatId = null;
  passMessageSourceChatId = null;
  passMessageMeta = { historySeq: 0, createdAt: '', text: '' };
  clearDelegationPlanPreview();
  applyNewChatModalForkLabels();
  chatNewModalApi?.close();
}

function listLoadedWorkspaces() {
  return Array.isArray(workspaces)
    ? workspaces.filter((entry) => entry && String(entry.workspaceFile || '').trim())
    : [];
}

function findLoadedWorkspaceByFile(workspaceFile) {
  const wanted = normalizePath(workspaceFile);
  if (!wanted) return null;
  return listLoadedWorkspaces().find((entry) => normalizePath(entry.workspaceFile) === wanted) || null;
}

function voiceWidgetBlocked() {
  if (!isEmbedWidgetMode()) return null;
  return { ok: false, error: 'not available in widget' };
}

/**
 * @param {string} workspaceFile
 * @param {string} [workspaceFolder]
 * @returns {Promise<boolean>}
 */
async function applyVoiceWorkspaceSwitch(workspaceFile, workspaceFolder) {
  const file = String(workspaceFile || '').trim();
  const folder = String(workspaceFolder || '').trim();
  if (!file) return false;
  if (typeof workspaceSwitchHook === 'function') {
    return !!(await workspaceSwitchHook(file, folder));
  }
  window.dispatchEvent(
    new CustomEvent('cretli-request-workspace', {
      detail: { workspaceFile: file, workspaceFolder: folder },
    })
  );
  return true;
}

function voiceWorkspaceSnapshot() {
  const ctx = getWorkspaceContextForChat();
  const active = findLoadedWorkspaceByFile(ctx?.workspaceFile);
  const folderPath = String(ctx?.workspaceFolder || '').replace(/\\/g, '/');
  return {
    workspace: active
      ? workspaceSpokenLabel(active)
      : workspaceSpokenLabel({ workspaceFile: ctx?.workspaceFile }),
    folder: folderPath.split('/').filter(Boolean).pop() || folderPath || '',
    chatCount: getChatsForCurrentWorkspace().length,
  };
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
    await applyVoiceWorkspaceSwitch(workspaceFile, workspaceFolder);
  }
  renderChatList();
  openTerminal(chat);
  selectChat(chat.id);
  chatModelSelectApi?.setModelPickerHarness(harness);
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
 * @returns {Promise<{
 *   ok: boolean,
 *   workspaces?: Array<{ name: string, active: boolean, folderCount: number }>,
 *   error?: string,
 * }>}
 */
export async function listVoiceWorkspaces() {
  await loadWorkspaces();
  const ctx = getWorkspaceContextForChat();
  const headerNorm = normalizePath(ctx?.workspaceFile);
  const workspacesOut = listLoadedWorkspaces().map((entry) => ({
    name: workspaceSpokenLabel(entry),
    active: normalizePath(entry.workspaceFile) === headerNorm,
    folderCount: collectWorkspaceFolders(entry).length,
  }));
  return { ok: true, workspaces: workspacesOut };
}

/**
 * @param {{ workspace?: string, folder?: string }} [options]
 * @returns {Promise<object>}
 */
export async function switchVoiceWorkspace(options = {}) {
  const blocked = voiceWidgetBlocked();
  if (blocked) return blocked;
  const spoken = String(options.workspace || '').trim();
  if (!spoken) return { ok: false, error: 'Missing workspace name' };
  await loadWorkspaces();
  const items = listLoadedWorkspaces();
  const result = matchWorkspaceBySpokenName(items, spoken);
  if (result.ambiguous) {
    return { ok: false, error: `Several workspaces match "${spoken}"`, workspaces: result.candidates };
  }
  if (!result.match) {
    return {
      ok: false,
      error: `Workspace not found: ${spoken}`,
      workspaces: items.map((entry) => workspaceSpokenLabel(entry)).slice(0, 12),
    };
  }
  const chosen = result.match;
  const folders = collectWorkspaceFolders(chosen);
  const spokenFolder = String(options.folder || '').trim();
  let folderPath = getWorkspaceDefaultFolder(chosen);
  if (spokenFolder) {
    const folderResult = matchFolderBySpokenName(folders, spokenFolder);
    if (folderResult.ambiguous) {
      return { ok: false, error: `Several folders match "${spokenFolder}"`, folders: folderResult.candidates };
    }
    if (!folderResult.match) {
      return {
        ok: false,
        error: `Folder not found: ${spokenFolder}`,
        folders: folders.map((entry) => entry.name).slice(0, 12),
      };
    }
    folderPath = folderResult.match.path;
  }
  const switched = await applyVoiceWorkspaceSwitch(chosen.workspaceFile, folderPath);
  if (!switched) return { ok: false, error: 'Could not switch workspace' };
  return { ok: true, ...voiceWorkspaceSnapshot() };
}

/**
 * @returns {Promise<object>}
 */
export async function listVoiceFolders() {
  await loadWorkspaces();
  const ctx = getWorkspaceContextForChat();
  const current = findLoadedWorkspaceByFile(ctx?.workspaceFile);
  if (!current) return { ok: false, error: 'No workspace is active' };
  const activePath = normalizePath(ctx?.workspaceFolder);
  const folders = collectWorkspaceFolders(current).map((entry) => ({
    name: entry.name,
    active: normalizePath(entry.path) === activePath,
  }));
  return { ok: true, workspace: workspaceSpokenLabel(current), folders };
}

/**
 * @param {{ folder?: string }} [options]
 * @returns {Promise<object>}
 */
export async function switchVoiceFolder(options = {}) {
  const blocked = voiceWidgetBlocked();
  if (blocked) return blocked;
  const spoken = String(options.folder || '').trim();
  if (!spoken) return { ok: false, error: 'Missing folder name' };
  await loadWorkspaces();
  const ctx = getWorkspaceContextForChat();
  const current = findLoadedWorkspaceByFile(ctx?.workspaceFile);
  if (!current) return { ok: false, error: 'No workspace is active' };
  const folders = collectWorkspaceFolders(current);
  const folderResult = matchFolderBySpokenName(folders, spoken);
  if (folderResult.ambiguous) {
    return { ok: false, error: `Several folders match "${spoken}"`, folders: folderResult.candidates };
  }
  if (!folderResult.match) {
    return {
      ok: false,
      error: `Folder not found: ${spoken}`,
      folders: folders.map((entry) => entry.name).slice(0, 12),
    };
  }
  const switched = await applyVoiceWorkspaceSwitch(current.workspaceFile, folderResult.match.path);
  if (!switched) return { ok: false, error: 'Could not switch folder' };
  return { ok: true, ...voiceWorkspaceSnapshot() };
}

/**
 * @param {{ chatId: string }} options
 * @returns {Promise<object>}
 */
export async function closeVoiceChat(options = {}) {
  const chatId = String(options.chatId || '').trim();
  if (!chatId) return { ok: false, error: 'Missing chat id' };
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat) return { ok: false, error: 'Chat not found' };
  const title = String(chat.title || '').trim() || 'untitled';
  const archived = await requestArchiveChat(chatId);
  if (!archived) return { ok: false, error: 'Could not archive the chat' };
  return { ok: true, chatId, title, archived: true };
}

/**
 * @param {{ chatId: string, title: string }} options
 * @returns {Promise<object>}
 */
export async function renameVoiceChat(options = {}) {
  const chatId = String(options.chatId || '').trim();
  const nextTitle = String(options.title || '').trim();
  if (!chatId) return { ok: false, error: 'Missing chat id' };
  if (!nextTitle) return { ok: false, error: 'Missing title' };
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat) return { ok: false, error: 'Chat not found' };
  try {
    const data = await api.patchChat(chat.id, { title: nextTitle });
    if (!data?.ok) return { ok: false, error: data?.error || 'Could not rename the chat' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  chat.title = nextTitle;
  renderChatList();
  notifySidebar();
  return { ok: true, chatId: chat.id, title: nextTitle };
}

function isVoiceHarnessUsable(harness) {
  if (!isHarnessEnabledInSettings(harness)) return false;
  if (harness === 'openrouter') return cachedOpenRouterReady !== false;
  if (harness === 'opencode') return cachedOpenCodeReady !== false;
  if (harness === 'codebuddy') return cachedCodeBuddyReady !== false;
  if (harness === 'deepseek') return cachedDeepSeekReady !== false;
  if (harness === 'qwen') return cachedQwenReady !== false;
  if (harness === 'codex') return cachedCodexReady !== false;
  return cachedSdkReady !== false;
}

function listReadyVoiceHarnesses() {
  return getEnabledHarnessIds().filter((id) => isVoiceHarnessUsable(id));
}

function isVoiceToolConfirm(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * @param {object} chat
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForVoiceModelCatalog(chat, timeoutMs = 8000) {
  if (!chat || !chatModelSelectApi) return false;
  const harness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    chatModelSelectApi.setModelPickerHarness(harness);
    const models = chatModelSelectApi.getSdkModeBarModelOptions();
    if (models.length > 0) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  chatModelSelectApi.setModelPickerHarness(harness);
  return chatModelSelectApi.getSdkModeBarModelOptions().length > 0;
}

/**
 * @param {object} chat
 * @param {{ timeoutMs?: number, waitForAgentIdle?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function waitForVoiceChatReady(chat, options = {}) {
  if (!chat) return false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const waitForAgentIdle = options.waitForAgentIdle !== false;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const connected = chat.ws?.readyState === WebSocket.OPEN;
    const connecting = chat._connectionStatus === 'connecting' || chat._connectionStatus === 'reconnecting';
    if (connected && !connecting) {
      if (!waitForAgentIdle) return true;
      if (getChatListAgentState(chat) !== 'active') return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  const connected = chat.ws?.readyState === WebSocket.OPEN;
  if (!connected) return false;
  if (!waitForAgentIdle) return true;
  return getChatListAgentState(chat) !== 'active';
}

/**
 * @returns {Promise<{ ok: boolean, harness?: string, current?: string, models?: Array<{ id: string, label: string, active: boolean }>, error?: string }>}
 */
export async function listVoiceModels() {
  const chat = activeChatId ? chats.find((entry) => entry.id === activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  if (!chatModelSelectApi) return { ok: false, error: 'Model list is not available' };
  const harness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (!isHarnessEnabledInSettings(harness)) {
    return {
      ok: true,
      harness,
      current: normalizeModelValue(chat.model || 'auto'),
      models: [],
      harnessEnabled: false,
      hint: 'This harness is disabled in settings. Enable it to offer its models.',
    };
  }
  chatModelSelectApi.setModelPickerHarness(harness);
  let models = chatModelSelectApi.getSdkModeBarModelOptions();
  if (models.length === 0) {
    const ready = await waitForVoiceModelCatalog(chat, 8000);
    if (!ready) return { ok: false, error: 'Model list is still loading — try again in a moment' };
    models = chatModelSelectApi.getSdkModeBarModelOptions();
  }
  const current = normalizeModelValue(chat.model || 'auto');
  return {
    ok: true,
    harness,
    current,
    models: models.map((model) => ({
      id: model.value,
      label: String(model.label || model.value || '').trim() || model.value,
      active: model.value === current,
    })),
    harnessEnabled: true,
  };
}

/**
 * @param {{ model?: string }} [options]
 * @returns {Promise<object>}
 */
export async function setVoiceChatModel(options = {}) {
  const model = String(options.model || '').trim();
  if (!model) return { ok: false, error: 'Missing model' };
  const chat = activeChatId ? chats.find((entry) => entry.id === activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  if (!chatModelSelectApi) return { ok: false, error: 'Model switch is not available' };
  const harness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  chatModelSelectApi.setModelPickerHarness(harness);
  if (chatModelSelectApi.getSdkModeBarModelOptions().length === 0) {
    const catalogReady = await waitForVoiceModelCatalog(chat, 10000);
    if (!catalogReady) {
      return { ok: false, error: 'Model list is still loading — try again in a moment' };
    }
  }
  const ready = await waitForVoiceChatReady(chat, { timeoutMs: 12000, waitForAgentIdle: true });
  if (!ready) {
    if (chat.ws?.readyState !== WebSocket.OPEN) {
      return { ok: false, error: 'Chat is still connecting — try again in a moment' };
    }
    if (getChatListAgentState(chat) === 'active') {
      return { ok: false, error: 'Agent is still working — stop the run first or wait a moment' };
    }
  }
  const changed = await setChatModel(chat, model);
  if (!changed) return { ok: false, error: 'Could not change the model' };
  return {
    ok: true,
    model: normalizeModelValue(chat.model || model),
    harness,
  };
}

/**
 * @param {{
 *   harness?: string,
 *   confirm?: boolean,
 *   handoff?: unknown,
 *   keep_old?: unknown,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function switchVoiceHarness(options = {}) {
  const nextHarness = String(options.harness || '').trim().toLowerCase();
  if (!AGENT_TRANSPORTS.includes(nextHarness)) {
    return {
      ok: false,
      error: 'Unknown harness. Try cursor, opencode, openrouter, codebuddy, deepseek, codex, qwen.',
      harnesses: listReadyVoiceHarnesses(),
    };
  }
  const chat = activeChatId ? chats.find((entry) => entry.id === activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  const currentHarness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (nextHarness === currentHarness) {
    return { ok: true, harness: nextHarness, unchanged: true };
  }
  if (!isVoiceHarnessUsable(nextHarness)) {
    return {
      ok: false,
      error: `Harness ${nextHarness} is not ready`,
      harnesses: listReadyVoiceHarnesses(),
    };
  }
  const keepOld = isVoiceToolConfirm(options.keep_old);
  const includeContext = options.handoff !== false && options.handoff !== 'false';
  if (!isVoiceToolConfirm(options.confirm)) {
    return {
      ok: false,
      needsConfirm: true,
      from: currentHarness,
      to: nextHarness,
      keepOld,
      handoff: includeContext,
      error: keepOld
        ? `Confirm switch from ${currentHarness} to ${nextHarness}. The current chat stays open. Call switch_harness again with confirm=true.`
        : `Confirm switch from ${currentHarness} to ${nextHarness}. The current chat will be archived. Call switch_harness again with confirm=true.`,
    };
  }
  if (switchHarnessInFlight) return { ok: false, error: 'A harness switch is already in progress' };
  const nextModel = normalizeModelValue(chat.model || selectedModel || 'auto');
  switchHarnessInFlight = true;
  try {
    const result = await executeHarnessSwitch(chat, nextHarness, nextModel, {
      action: keepOld ? 'keep' : 'archive',
      includeContext,
    });
    return result;
  } finally {
    switchHarnessInFlight = false;
    pendingWidgetHarnessSwitch = null;
    if (sharedSdkModeBar) sharedSdkModeBar.pendingHarness = '';
  }
}

/**
 * @param {{ title?: string, harness?: string }} [options]
 * @returns {Promise<object>}
 */
export async function forkVoiceChat(options = {}) {
  const chat = activeChatId ? chats.find((entry) => entry.id === activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  const historySynced = await flushPendingPush(chat.id, chat.cursorSessionId || '');
  if (!historySynced) return { ok: false, error: 'Could not sync chat history' };
  const sourceText = await readChatTranscriptForHandoff(chat);
  const nextHarness = String(options.harness || '').trim()
    ? normalizeNewChatHarness(options.harness)
    : normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (!isHarnessEnabledInSettings(nextHarness)) {
    return { ok: false, error: `Harness ${nextHarness} is disabled in settings` };
  }
  const title = String(options.title || '').trim();
  const payload = {
    sourceText,
    agentTransport: nextHarness,
    model: normalizeModelValue(chat.model || selectedModel || 'auto'),
    workspaceFile: chat.workspaceFile,
    workspaceFolder: chat.workspaceFolder,
  };
  if (title) payload.title = title;
  let data;
  try {
    data = await api.postChatFork(chat.id, payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data?.ok || !data.chat?.id) {
    return { ok: false, error: data?.error || 'Could not fork the chat' };
  }
  const created = data.chat;
  created.agentTransport = normalizeNewChatHarness(created.agentTransport || nextHarness);
  created.sdkMode = normalizeSdkMode(created.sdkMode);
  created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode);
  created.workspaceFile ||= chat.workspaceFile;
  created.workspaceFolder ||= chat.workspaceFolder;
  const sameHarness =
    normalizeNewChatHarness(chat.agentTransport || 'sdk') === created.agentTransport;
  const displayText = sameHarness
    ? t('chat.forkContinueDisplayText')
    : t('chat.harnessHandoffDisplayText');
  openCreatedForkChat(created, data.initialPrompt || '', displayText);
  notifySidebar();
  return {
    ok: true,
    chatId: created.id,
    title: String(created.title || title || '').trim() || 'untitled',
    harness: nextHarness,
  };
}

/**
 * Create a conversation fork or an agent-analysis sub-chat from the new-chat modal.
 *
 * @param {object} parentChat
 * @param {{
 *   title: string,
 *   harness: string,
 *   model: string,
 *   workspaceFile: string,
 *   workspaceFolder: string,
 *   message?: string,
 *   displayText?: string,
 *   analyze?: boolean,
 *   upToCreatedAt?: string,
 * }} values
 * @returns {Promise<void>}
 */
async function createForkChatFromModal(parentChat, values) {
  const analyze = values.analyze === true;
  const cutPoint = typeof values.upToCreatedAt === 'string' ? values.upToCreatedAt.trim() : '';
  if (!analyze) {
    const historySynced = await flushPendingPush(
      parentChat.id,
      parentChat.cursorSessionId || ''
    );
    if (!historySynced) {
      alert(t('sendBar.forkSyncFailed'));
      return;
    }
  }
  const workspaceFile = values.workspaceFile || parentChat.workspaceFile;
  const workspaceFolder = values.workspaceFolder || parentChat.workspaceFolder;
  const payload = {
    agentTransport: values.harness,
    model: values.model,
    workspaceFile,
    workspaceFolder,
  };
  if (!analyze && cutPoint) payload.upToCreatedAt = cutPoint;
  if (!analyze && !cutPoint) {
    payload.sourceText = await readChatTranscriptForHandoff(parentChat);
  }
  if (values.title) payload.title = values.title;
  if (values.message) payload.message = values.message;
  if (analyze) payload.analyze = true;
  let data;
  try {
    data = await api.postChatFork(parentChat.id, payload);
  } catch (_) {
    alert(t('chat.serverConnectionError'));
    return;
  }
  if (!data?.ok || !data.chat) {
    alert(data?.error || t('chat.createFailed', { detail: t('chat.unknownError') }));
    return;
  }
  const created = data.chat;
  created.agentTransport = normalizeNewChatHarness(created.agentTransport || values.harness);
  created.sdkMode = normalizeSdkMode(created.sdkMode);
  created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode);
  created.workspaceFile ||= workspaceFile;
  created.workspaceFolder ||= workspaceFolder;
  await pinCreatedChatToHostIfWidget(created);
  const sameHarness =
    normalizeNewChatHarness(parentChat.agentTransport || 'sdk') === created.agentTransport;
  const displayText =
    values.displayText ||
    (sameHarness ? t('chat.forkContinueDisplayText') : t('chat.harnessHandoffDisplayText'));
  const initialPrompt = data.initialPrompt || values.message || '';
  const live = analyze
    ? openCreatedChatWithPrompt(created, initialPrompt, displayText)
    : openCreatedForkChat(created, initialPrompt, displayText);
  syncWidgetPinUrlUi(live || created);
  notifyWidgetParentPagePinChanged();
  notifySidebar();
  closeNewChatModal();
}

/**
 * Create a fresh Agent chat that implements the approved plan from the source chat.
 *
 * @param {object} parentChat
 * @param {{
 *   title: string,
 *   harness: string,
 *   model: string,
 *   workspaceFile: string,
 *   workspaceFolder: string,
 * }} values
 * @returns {Promise<void>}
 */
async function createBuildPlanChatFromModal(parentChat, values) {
  if (!parentChat?.id) return;
  const result = await startDelegationFromParent(parentChat, {
    title: values.title,
    harness: values.harness,
    model: values.model,
    planRevision: getDelegationApprovedPlanRevision(),
    extraInstructions: readDelegationPreviewExtra(),
    sourceKind: values.sourceKind,
    historySeq: values.historySeq,
    createdAt: values.createdAt,
    textSnapshot: values.textSnapshot,
    contentHash: values.contentHash,
    executionMode: values.executionMode || readDelegationExecutionMode(parentChat),
  });
  if (!result?.ok) {
    if (result?.code === 'plan_revision_conflict') {
      alert(result.error || t('chat.delegationPlanConflict'));
      return;
    }
    alert(result?.error || t('chat.createFailed', { detail: t('chat.unknownError') }));
    return;
  }
  const created = result.chat;
  if (created?.id) {
    created.agentTransport = normalizeNewChatHarness(created.agentTransport || values.harness);
    created.sdkMode = created.sdkMode || values.executionMode || 'agent';
    created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode || parentChat.sdkUiMode);
    adoptCreatedChat(created);
  }
  notifySidebar();
  closeNewChatModal();
}

/**
 * Create a new chat from the modal values (folder and model; workspace from context).
 */
function createChatFromModal() {
  if (chatCreateInFlight) return;
  const modelSel = document.getElementById('chat-new-model-select');
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
          : harness === 'codebuddy'
            ? t('chat.codebuddyDisabled')
            : harness === 'deepseek'
              ? t('chat.deepseekDisabled')
              : harness === 'qwen'
                ? t('chat.qwenDisabled')
              : harness === 'codex'
                ? t('chat.codexDisabled')
            : t('chat.sdkDisabled')
    );
    return;
  }
  selectedModel = chosenModel;
  selectedHarness = normalizeNewChatHarness(harness);
  saveLastSelectedModel(chosenModel);
  saveLastSelectedHarness(selectedHarness);
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
  const monitorParent = monitorSourceChatId
    ? chats.find((entry) => entry.id === monitorSourceChatId)
    : null;
  const forkParent = forkSourceChatId
    ? chats.find((entry) => entry.id === forkSourceChatId)
    : null;
  const sourceParent = monitorParent || forkParent;
  if (sourceParent?.id) {
    chatCreateInFlight = true;
    setNewChatCreateBusy(true);
    const values = {
      title,
      harness,
      model: chosenModel,
      workspaceFile: createCtx.workspaceFile,
      workspaceFolder: createCtx.workspaceFolder,
    };
    if (forkParent?.id && forkUpToCreatedAt) values.upToCreatedAt = forkUpToCreatedAt;
    if (monitorParent?.id) {
      values.message = buildAgentMonitorMessage(monitorParent);
      values.displayText = t('chat.monitorAgentDisplayPrompt');
      values.analyze = true;
      if (!values.title) {
        values.title = t('chat.monitorDefaultTitle', { title: monitorParent.title || 'Chat' });
      }
    }
    void createForkChatFromModal(sourceParent, values).finally(() => {
      chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
    return;
  }
  const passMessageParent = passMessageSourceChatId
    ? chats.find((entry) => entry.id === passMessageSourceChatId)
    : null;
  if (passMessageParent?.id) {
    chatCreateInFlight = true;
    setNewChatCreateBusy(true);
    const values = {
      title,
      harness,
      model: chosenModel,
      workspaceFile: createCtx.workspaceFile,
      workspaceFolder: createCtx.workspaceFolder,
      sourceKind: 'message',
      historySeq: passMessageMeta.historySeq,
      createdAt: passMessageMeta.createdAt,
      textSnapshot: passMessageMeta.text,
      executionMode: readDelegationExecutionMode(passMessageParent),
    };
    if (!values.title) {
      values.title = t('chat.passMessageDefaultTitle', { title: passMessageParent.title || 'Chat' });
    }
    void createBuildPlanChatFromModal(passMessageParent, values).finally(() => {
      chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
    return;
  }
  const buildPlanParent = buildPlanSourceChatId
    ? chats.find((entry) => entry.id === buildPlanSourceChatId)
    : null;
  if (buildPlanParent?.id) {
    chatCreateInFlight = true;
    setNewChatCreateBusy(true);
    const values = {
      title,
      harness,
      model: chosenModel,
      workspaceFile: createCtx.workspaceFile,
      workspaceFolder: createCtx.workspaceFolder,
    };
    if (!values.title) {
      values.title = t('chat.buildPlanDefaultTitle', { title: buildPlanParent.title || 'Chat' });
    }
    void createBuildPlanChatFromModal(buildPlanParent, values).finally(() => {
      chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
    return;
  }
  chatCreateInFlight = true;
  setNewChatCreateBusy(true);
  const payload = {
    workspaceFile: createCtx.workspaceFile,
    workspaceFolder: createCtx.workspaceFolder,
    model: chosenModel,
    agentTransport: harness,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  };
  if (title) payload.title = title;
  void attachWidgetHostPinToCreatePayload(payload)
    .then(() => api.postChat(payload))
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
      const live = adoptCreatedChat(chat);
      syncWidgetPinUrlUi(live);
      notifyWidgetParentPagePinChanged();
      closeNewChatModal();
    })
    .catch(() => alert(t('chat.serverConnectionError')))
    .finally(() => {
      chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
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
 * WebKit reports checkbox.checked=false when the control sits in a
 * display:none settings tab. Saving then persisted a false preference.
 *
 * @param {Element | null} el
 * @returns {boolean}
 */
function isChatSettingsControlOnVisibleTab(el) {
  if (!(el instanceof HTMLElement)) return false;
  const panel = el.closest('.chat-settings-tab-panel');
  if (!(panel instanceof HTMLElement)) return true;
  return !panel.hidden;
}

/**
 * Apply the “show send field” preference (class on #chat-panel).
 */
function applySendFieldPreference() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  healLegacyShowSendFieldPreference();
  panel.classList.toggle('hide-send-field', !getShowSendFieldEnabled());
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
 * Create a new Agent chat on the current widget page instead of resetting in place.
 * Resetting the SDK room can drop the pane (chat-gone while the session rotates).
 * @param {object} chat
 * @param {HTMLElement | null} [hintEl]
 */
async function startFreshWidgetAgentChat(chat, hintEl = null) {
  if (!chat) {
    setTransientChatActionHint(hintEl, t('chat.noActiveChat'));
    return false;
  }
  if (chat._sdkContextResetPending) {
    setTransientChatActionHint(hintEl, t('chat.newAgentStarting'));
    return false;
  }
  const host = await requestWidgetHostUrl().catch(() => ({ url: '' }));
  const hostPageUrl = typeof host?.url === 'string' ? host.url.trim() : '';
  const pageUrl = hostPageUrl || getChatWidgetPinnedUrl(chat) || '';
  if (!pageUrl) {
    return resetInPlaceNewAgent(chat, hintEl);
  }
  setTransientChatActionHint(hintEl, t('chat.newAgentStarting'));
  const result = await createPageLinkedChat({
    pageUrl,
    pageTitle: chat.title,
    harness: normalizeNewChatHarness(chat.agentTransport || 'sdk'),
    forceNew: true,
    workspaceFile: chat.workspaceFile,
    workspaceFolder: chat.workspaceFolder,
    model: chat.model,
    sdkMode: 'agent',
    sdkUiMode: chat.sdkUiMode,
  });
  if (!result?.ok || !result.chat?.id) {
    setTransientChatActionHint(hintEl, result?.error || t('chat.createChatFailed'));
    return false;
  }
  return true;
}

/**
 * Start a fresh SDK agent session: cancel the current run, clear the view, reset context.
 * @param {object} chat
 * @param {HTMLElement | null} [hintEl]
 */
async function startNewAgent(chat, hintEl = null) {
  if (!chat) {
    setTransientChatActionHint(hintEl, t('chat.noActiveChat'));
    return false;
  }
  if (isEmbedWidgetMode()) {
    return startFreshWidgetAgentChat(chat, hintEl);
  }
  return resetInPlaceNewAgent(chat, hintEl);
}

async function resetInPlaceNewAgent(chat, hintEl = null) {
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
    if (/chat not found/i.test(message)) {
      closeChat(chat.id, { skipApiDelete: true });
      return false;
    }
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
  if (normalized === 'codebuddy') return t('chat.contextDetailsTransportCodeBuddy');
  if (normalized === 'deepseek') return t('chat.contextDetailsTransportDeepSeek');
  if (normalized === 'qwen') return t('chat.contextDetailsTransportQwen');
  if (normalized === 'codex') return t('chat.contextDetailsTransportCodex');
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
  if (voiceReadMount && !chatSettingsVoiceRead) {
    chatSettingsVoiceRead = createVoiceReadOptions();
    voiceReadMount.replaceChildren(chatSettingsVoiceRead.root);
  }
  chatSettingsVoiceRead?.refresh();
  const resumeDictationCheckbox = document.getElementById('chat-settings-resume-dictation');
  if (resumeDictationCheckbox) {
    resumeDictationCheckbox.checked = getStoredDictationResumeAfterSend();
  }
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
  if (showSendFieldCheckbox && isChatSettingsControlOnVisibleTab(showSendFieldCheckbox)) {
    setShowSendFieldEnabled(showSendFieldCheckbox.checked);
    applySendFieldPreference();
  }
  if (autoUpdateTitleCheckbox && isChatSettingsControlOnVisibleTab(autoUpdateTitleCheckbox)) {
    setAutoUpdateChatTitleEnabled(autoUpdateTitleCheckbox.checked);
    const globalAutoUpdateTitleCheckbox = document.getElementById('auto-update-chat-title-checkbox');
    if (globalAutoUpdateTitleCheckbox) globalAutoUpdateTitleCheckbox.checked = autoUpdateTitleCheckbox.checked;
  }
  const resumeDictationCheckbox = document.getElementById('chat-settings-resume-dictation');
  if (resumeDictationCheckbox && isChatSettingsControlOnVisibleTab(resumeDictationCheckbox)) {
    setStoredDictationResumeAfterSend(!!resumeDictationCheckbox.checked);
  }
  const showDiagCheckbox = document.getElementById('chat-settings-show-diag');
  if (showDiagCheckbox && isChatSettingsControlOnVisibleTab(showDiagCheckbox)) {
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
  if (sdkVerboseLogsCheckbox && isChatSettingsControlOnVisibleTab(sdkVerboseLogsCheckbox)) {
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
    && isChatSettingsControlOnVisibleTab(autoContextCompressionEnabledCheckbox)
  ) {
    const enabled = autoContextCompressionEnabledCheckbox.checked === true;
    if (enabled !== isAutoContextCompressionEnabled(chat)) {
      payload.autoContextCompressionEnabled = enabled;
    }
  }
  const autoContextCompressionThresholdInput = document.getElementById(
    'chat-settings-auto-context-compression-threshold'
  );
  if (
    autoContextCompressionThresholdInput
    && isChatSettingsControlOnVisibleTab(autoContextCompressionThresholdInput)
  ) {
    const threshold = normalizeAutoContextCompressionThreshold(autoContextCompressionThresholdInput.value);
    if (threshold !== normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold)) {
      payload.autoContextCompressionThreshold = threshold;
    }
  }
  const contextAdvisoryEnabledCheckbox = document.getElementById('chat-settings-context-advisory-enabled');
  if (contextAdvisoryEnabledCheckbox && isChatSettingsControlOnVisibleTab(contextAdvisoryEnabledCheckbox)) {
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
    && isChatSettingsControlOnVisibleTab(contextAdvisoryWarnPercentInput)
  ) {
    const warnPercent = normalizeContextAdvisoryWarnPercent(contextAdvisoryWarnPercentInput.value);
    if (warnPercent !== normalizeContextAdvisoryWarnPercent(chat.contextAdvisoryWarnPercent)) {
      payload.contextAdvisoryWarnPercent = warnPercent;
    }
  }
  const contextSummaryResetCheckbox = document.getElementById('chat-settings-context-summary-reset');
  if (contextSummaryResetCheckbox && isChatSettingsControlOnVisibleTab(contextSummaryResetCheckbox)) {
    const resetEnabled = contextSummaryResetCheckbox.checked === true;
    if (resetEnabled !== shouldResetAfterContextCompression(chat)) {
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
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id + ' (' + t('chat.settings') + ')', String(err));
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
      syncNewChatFavoritePresetUi();
      void refreshNewChatHarnessStatus({ forceCloseDropdown: true });
    });
  }
  const newModelSel = document.getElementById('chat-new-model-select');
  if (newModelSel) {
    newModelSel.addEventListener('change', () => {
      syncNewChatFavoritePresetUi();
    });
  }
  const newFavoritePresetTrigger = document.getElementById('chat-new-favorite-preset-trigger');
  const newFavoritePresetModal = document.getElementById('chat-new-favorite-preset-modal');
  if (newFavoritePresetTrigger && newFavoritePresetModal) {
    // Keep the floating panel out of the scrollable dialog stacking context,
    // just like cr-searchable-select does for the model and folder pickers.
    if (newFavoritePresetModal.parentElement !== document.body) {
      document.body.appendChild(newFavoritePresetModal);
    }
    chatNewFavoritePresetDropdownApi = initDropdown({
      triggerEl: newFavoritePresetTrigger,
      floatingEl: newFavoritePresetModal,
      compact: true,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 220,
      maxHeightPx: 360,
      optionSelector: '[role="option"]',
      onOpen: () => {
        chatNewModelDropdownApi?.close?.();
        chatNewFolderDropdownApi?.close?.();
        renderNewChatFavoritePresetOptions();
      },
    });
    newFavoritePresetTrigger.addEventListener('click', () => {
      chatNewFavoritePresetDropdownApi?.toggle?.();
    });
  }
  const newFavoritePresetToggle = document.getElementById('chat-new-favorite-preset-toggle');
  if (newFavoritePresetToggle) {
    newFavoritePresetToggle.addEventListener('click', (event) => {
      event.preventDefault();
      toggleNewChatFavoritePreset();
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
  void api.getCodeBuddyModels().then((data) => {
    if (!data?.ok) return;
    const changed = chatModelSelectApi.applyAvailableModelsFromCodeBuddy(data);
    if (changed) chatModelSelectApi.refreshModelSelectLabels();
  }).catch(() => {});
  void api.getDeepSeekModels().then((data) => {
    if (!data?.ok) return;
    const changed = chatModelSelectApi.applyAvailableModelsFromDeepSeek(data);
    if (changed) chatModelSelectApi.refreshModelSelectLabels();
  }).catch(() => {});
  void api.getQwenModels().then((data) => {
    if (!data?.ok) return;
    const changed = chatModelSelectApi.applyAvailableModelsFromQwen(data);
    if (changed) chatModelSelectApi.refreshModelSelectLabels();
  }).catch(() => {});
  void api.getCodexModels().then((data) => {
    if (!data?.ok) return;
    const changed = chatModelSelectApi.applyAvailableModelsFromCodex(data);
    if (changed) chatModelSelectApi.refreshModelSelectLabels();
  }).catch(() => {});
  api.getSettings().then((data) => {
    if (!data?.ok) return;
    applyHarnessOrder(data.harnessOrder);
    applyEnabledHarnesses(data.enabledHarnesses);
    if (sharedSdkModeBar) sharedSdkModeBar.enabledHarnesses = getEnabledHarnessIds();
    applyChatEnabledModels(data.chatEnabledModels || []);
    applyOpenRouterEnabledModels(data.openrouterChatEnabledModels || []);
    applyOpenCodeEnabledModels(data.opencodeChatEnabledModels || []);
    applyCodeBuddyEnabledModels(data.codebuddyChatEnabledModels || []);
    applyDeepSeekEnabledModels(data.deepseekChatEnabledModels || []);
    applyQwenEnabledModels(data.qwenChatEnabledModels || []);
    applyCodexEnabledModels(data.codexChatEnabledModels || []);
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
    window.addEventListener(CHAT_PRESETS_CHANGED_EVENT, () => {
      syncNewChatFavoritePresetUi();
    });
    window.addEventListener('cretli-enabled-harnesses-changed', (event) => {
      if (event?.detail?.harnessOrder) applyHarnessOrder(event.detail.harnessOrder);
      applyEnabledHarnesses(event?.detail?.enabledHarnesses);
      if (sharedSdkModeBar) sharedSdkModeBar.enabledHarnesses = getEnabledHarnessIds();
    });
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
    window.addEventListener('cretli-codebuddy-models-changed', (event) => {
      const detail = event?.detail;
      applyCodeBuddyEnabledModels(detail?.codebuddyChatEnabledModels || []);
    });
    window.addEventListener('cretli-deepseek-models-changed', (event) => {
      const detail = event?.detail;
      applyDeepSeekEnabledModels(detail?.deepseekChatEnabledModels || []);
    });
    window.addEventListener('cretli-qwen-models-changed', (event) => {
      const detail = event?.detail;
      applyQwenEnabledModels(detail?.qwenChatEnabledModels || []);
    });
    window.addEventListener('cretli-codex-models-changed', (event) => {
      const detail = event?.detail;
      if (detail?.codexChatEnabledModels) {
        applyCodexEnabledModels(detail.codexChatEnabledModels);
      }
      if (!detail?.catalog && !detail?.models) return;
      chatModelSelectApi.applyAvailableModelsFromCodex({
        ok: true,
        catalog: detail.catalog,
        models: detail.models,
      });
      chatModelSelectApi.refreshModelSelectLabels();
    });
    window.addEventListener('cretli-opencode-key-changed', () => {
      void reloadOpenCodeModelsCatalog();
      void refreshNewChatOpenCodeStatus();
    });
    window.addEventListener('cretli-codebuddy-key-changed', () => {
      void refreshNewChatCodeBuddyStatus();
    });
    window.addEventListener('cretli-deepseek-key-changed', () => {
      void refreshNewChatDeepSeekStatus();
    });
    window.addEventListener('cretli-qwen-key-changed', () => {
      void refreshNewChatQwenStatus();
    });
    window.addEventListener('cretli-codex-key-changed', () => {
      void refreshNewChatCodexStatus();
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
  const forkMenuBtn = document.getElementById('chat-fork-menu-btn');
  if (forkMenuBtn) {
    bindChatToolbarActionItem(forkMenuBtn, () => {
      closeChatActionsModal();
      const chat = activeChatId ? chats.find((entry) => entry.id === activeChatId) : null;
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
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
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
      const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : null;
      void toggleWidgetUrlPin(chat, hint);
    });
  }
  syncWidgetPinUrlUi(activeChatId ? chats.find((c) => c.id === activeChatId) : null);

  const stopMenuBtn = document.getElementById('chat-stop-menu-btn');
  if (stopMenuBtn) {
    bindChatToolbarActionItem(stopMenuBtn, () => {
      closeChatActionsModal();
      const id = activeChatId;
      if (!id) return;
      sendKeySequenceToActiveChat('\x03');
    });
  }

  const deleteMenuBtn = document.getElementById('chat-delete-menu-btn');
  if (deleteMenuBtn) {
    bindChatToolbarActionItem(deleteMenuBtn, () => {
      closeChatActionsModal();
      const id = activeChatId;
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
    window.addEventListener('pagehide', () => {
      if (!chatTitlesSyncTimer) return;
      clearInterval(chatTitlesSyncTimer);
      chatTitlesSyncTimer = null;
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
