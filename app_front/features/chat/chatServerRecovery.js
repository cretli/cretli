import { getSettings } from '../../core/api/index.js';
import { initModal } from '../../lib/modal.js';
import {
  SERVER_RESTART_READY_EVENT,
  notifyServerRestartRecoveryComplete,
  kickServerRestartRecoveryIfStuck,
  shouldSuppressServerDisconnectUi,
} from '../../app/serverRestartCoordinator.js';
import {
  clearLastBackgroundDurationMs,
  getBackgroundGraceMs,
  getLastBackgroundDurationMs,
  getReconnectModalDelayMs,
  isPageCurrentlyHidden,
} from '../../lib/pageBackgroundGrace.js';
import { t } from '../../i18n/index.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';

const SERVER_INSTANCE_TOKEN_STORAGE_KEY = 'cretli-server-instance-token';
const RECOVERY_POLL_INTERVAL_MS = 1500;
const RECOVERY_TIMEOUT_MS = 120000;
const CONNECTING_STALE_MS = 15000;

/** @type {ChatServerRecoveryDeps | null} */
let deps = null;
let recoveryTimerId = null;
let recoveryStartedAt = 0;
let reconnectModalDelayTimerId = null;
let listenerBound = false;
let backgroundListenerBound = false;
let reconnectModalApi = null;
let serverRestartDetected = false;

/**
 * @typedef {object} ChatServerRecoveryDeps
 * @property {() => object[]} getChats
 * @property {() => string | null} getActiveChatId
 * @property {(chat: object) => void} ensureChatConnection
 * @property {(chat: object) => void} [forceReconnectChat]
 * @property {() => void} [syncBackgroundChatConnections]
 * @property {(chat: object, context?: object) => Promise<void>} syncSdkHistoryOnResume
 * @property {(chat: object, text: string, tone?: string) => void} appendRecoveryNotice
 * @property {{ log: (tag: string, message: string, payload?: object) => void }} appLogger
 */

function readStoredServerInstanceToken() {
  if (typeof localStorage === 'undefined') return '';
  try {
    const token = readStorageValueWithAlias(localStorage, SERVER_INSTANCE_TOKEN_STORAGE_KEY, '');
    if (!token || typeof token !== 'string') return '';
    return token.trim();
  } catch {
    return '';
  }
}

function writeStoredServerInstanceToken(token) {
  if (typeof localStorage === 'undefined') return;
  if (!token || typeof token !== 'string') return;
  const clean = token.trim();
  if (!clean) return;
  try {
    writeStorageValueWithAlias(localStorage, SERVER_INSTANCE_TOKEN_STORAGE_KEY, clean);
  } catch {
    // ignore
  }
}

function extractServerInstanceToken(settingsData) {
  if (!settingsData || typeof settingsData !== 'object') return '';
  if (typeof settingsData.serverInstanceToken !== 'string') return '';
  return settingsData.serverInstanceToken.trim();
}

function didServerRestart(settingsData) {
  const currentToken = extractServerInstanceToken(settingsData);
  if (!currentToken) return false;
  const previousToken = readStoredServerInstanceToken();
  writeStoredServerInstanceToken(currentToken);
  if (!previousToken) return false;
  return previousToken !== currentToken;
}

function cacheServerInstanceTokenOnInit() {
  getSettings()
    .then((data) => {
      if (!data?.ok) return;
      const token = extractServerInstanceToken(data);
      if (!token) return;
      writeStoredServerInstanceToken(token);
    })
    .catch((err) => {
      deps?.appLogger?.log('chat-recovery', 'initial settings read failed', {
        error: String(err?.message || err),
      });
    });
}

function isIntentionalWsReconnect(chat) {
  const intentionalAt = Number(chat?._intentionalWsReconnectAt);
  if (!Number.isFinite(intentionalAt)) return false;
  return Date.now() - intentionalAt < 8000;
}

function clearIntentionalWsReconnect(chat) {
  if (!chat || typeof chat !== 'object') return;
  delete chat._intentionalWsReconnectAt;
}

function isActiveChatSocketOpen() {
  if (!deps) return false;
  const activeChatId = deps.getActiveChatId();
  const activeChat = deps.getChats().find((chat) => chat.id === activeChatId);
  return activeChat?.ws?.readyState === WebSocket.OPEN;
}

function reconnectChatInRecovery(chat, isActive) {
  if (!deps) return;
  if (isActive && typeof deps.forceReconnectChat === 'function') {
    deps.forceReconnectChat(chat);
    return;
  }
  deps.ensureChatConnection(chat);
}

function ensureChatReconnectModal() {
  if (reconnectModalApi) return reconnectModalApi;
  const modal = document.getElementById('chat-reconnect-modal');
  if (!modal) return null;
  reconnectModalApi = initModal(modal, { backdropSelector: '.chat-settings-backdrop' });
  const retryBtn = document.getElementById('chat-reconnect-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (!deps) return;
      recoveryStartedAt = Date.now();
      recoverChatConnections({ serverRestarted: serverRestartDetected });
      if (isActiveChatSocketOpen()) {
        stopReconnectRecovery();
        return;
      }
      stopReconnectPolling();
      scheduleReconnectRecovery(0);
    });
  }
  return reconnectModalApi;
}

function showChatReconnectModal(message) {
  const modalApi = ensureChatReconnectModal();
  if (!modalApi) return;
  const text = document.getElementById('chat-reconnect-text');
  if (text && message) text.textContent = message;
  modalApi.open();
}

function hideChatReconnectModal() {
  const modalApi = ensureChatReconnectModal();
  if (!modalApi) return;
  modalApi.close();
}

function stopReconnectModalDelay() {
  if (reconnectModalDelayTimerId == null) return;
  clearTimeout(reconnectModalDelayTimerId);
  reconnectModalDelayTimerId = null;
}

function scheduleReconnectModalIfNeeded(message) {
  if (shouldSuppressServerDisconnectUi()) return;
  if (reconnectModalDelayTimerId != null) return;
  const delayMs = getReconnectModalDelayMs({
    hidden: isPageCurrentlyHidden(),
    recentBackgroundMs: getLastBackgroundDurationMs(),
    graceMs: getBackgroundGraceMs(),
  });
  if (delayMs == null) return;
  reconnectModalDelayTimerId = setTimeout(() => {
    reconnectModalDelayTimerId = null;
    if (shouldSuppressServerDisconnectUi()) return;
    showChatReconnectModal(message);
  }, delayMs);
}

function stopReconnectPolling() {
  if (recoveryTimerId == null) return;
  clearTimeout(recoveryTimerId);
  recoveryTimerId = null;
  recoveryStartedAt = 0;
  serverRestartDetected = false;
}

function stopReconnectRecovery() {
  stopReconnectPolling();
  stopReconnectModalDelay();
  hideChatReconnectModal();
}

function isRecoveryUiActive() {
  return !!recoveryStartedAt
    || reconnectModalApi?.isOpen?.() === true
    || reconnectModalDelayTimerId != null;
}

/**
 * Hides the blocking reconnect modal when HTTP/history sync works but WS is still reconnecting.
 *
 * @param {object} [chat]
 */
export function notifyChatBackendReachable(chat) {
  if (!deps) return;
  const activeChatId = deps.getActiveChatId();
  if (!chat?.id || chat.id !== activeChatId) return;
  if (!isRecoveryUiActive()) return;
  stopReconnectModalDelay();
  hideChatReconnectModal();
  deps.appLogger.log('chat-recovery', 'backend reachable while ws reconnects', { chatId: chat.id });
}

/**
 * Clears recovery UI and polling when the active chat WebSocket is healthy again.
 *
 * @param {object} [chat]
 */
export function notifyChatConnectionRestored(chat) {
  if (!deps) return;
  const activeChatId = deps.getActiveChatId();
  if (!chat?.id || chat.id !== activeChatId) return;
  clearIntentionalWsReconnect(chat);
  if (chat.ws?.readyState !== WebSocket.OPEN) return;
  notifyServerRestartRecoveryComplete();
  if (!isRecoveryUiActive()) return;
  deps.appLogger.log('chat-recovery', 'connection restored', { chatId: chat.id });
  stopReconnectRecovery();
  notifyServerRestartRecoveryComplete();
}

function scheduleReconnectRecovery(delayMs = RECOVERY_POLL_INTERVAL_MS) {
  if (recoveryTimerId != null) return;
  recoveryTimerId = setTimeout(() => {
    recoveryTimerId = null;
    pollReconnectRecovery();
  }, delayMs);
}

function wasChatBusyBeforeRecovery(chat) {
  if (!chat) return false;
  if (chat._recoveryWasBusy === true) return true;
  return chat._sdkServerBusy === true || chat._agentState === 'active';
}

function resetStaleConnectingSocket(chat) {
  if (!chat || chat.ws?.readyState !== WebSocket.CONNECTING) return false;
  const connectingSince = Number(chat._wsConnectingSince);
  if (!Number.isFinite(connectingSince)) return false;
  if (Date.now() - connectingSince <= CONNECTING_STALE_MS) return false;
  delete chat._wsConnectingSince;
  deps?.appLogger?.log('chat-recovery', 'stale connecting socket reset', { chatId: chat.id });
  reconnectChatInRecovery(chat, true);
  return true;
}

/**
 * Reconnects only the active chat during backend recovery. Background slots use the
 * batched monitor policy so resume does not open dozens of WebSockets at once.
 *
 * @param {ChatServerRecoveryDeps} recoveryDeps
 * @param {{ serverRestarted?: boolean }} [options]
 * @returns {{ activeChatId: string | null, reconnectedActive: boolean, backgroundSyncScheduled: boolean }}
 */
export function applyChatConnectionRecovery(recoveryDeps, { serverRestarted = false } = {}) {
  const activeChatId = recoveryDeps.getActiveChatId?.() || null;
  let reconnectedActive = false;
  if (serverRestarted) {
    for (const chat of recoveryDeps.getChats?.() || []) {
      if (!chat?.cursorSessionId) continue;
      chat._reconnectAttempts = 0;
    }
  }
  const activeChat = (recoveryDeps.getChats?.() || []).find((chat) => chat?.id === activeChatId);
  if (activeChat?.cursorSessionId) {
    if (serverRestarted) {
      recoveryDeps.appendRecoveryNotice?.(activeChat, t('chat.serverRestarted'), 'warn');
      if (wasChatBusyBeforeRecovery(activeChat)) {
        recoveryDeps.appendRecoveryNotice?.(activeChat, t('chat.runInterruptedByRestart'), 'warn');
      }
    }
    if (typeof recoveryDeps.forceReconnectChat === 'function') {
      recoveryDeps.forceReconnectChat(activeChat);
    } else {
      recoveryDeps.ensureChatConnection?.(activeChat);
    }
    reconnectedActive = true;
    void recoveryDeps
      .syncSdkHistoryOnResume?.(activeChat, {
        reason: serverRestarted ? 'server_restart' : 'backend_recovery',
      })
      .then(() => {
        notifyChatBackendReachable(activeChat);
      })
      .catch((err) => {
        recoveryDeps.appLogger?.log?.('chat-recovery', 'history sync failed during recovery', {
          chatId: activeChat.id,
          error: String(err?.message || err),
        });
      });
  }
  let backgroundSyncScheduled = false;
  if (typeof recoveryDeps.syncBackgroundChatConnections === 'function') {
    recoveryDeps.syncBackgroundChatConnections();
    backgroundSyncScheduled = true;
  }
  recoveryDeps.appLogger?.log?.('chat-recovery', 'connections recovery applied', {
    activeChatId,
    reconnectedActive,
    backgroundSyncScheduled,
    serverRestarted,
    totalChats: (recoveryDeps.getChats?.() || []).length,
  });
  return { activeChatId, reconnectedActive, backgroundSyncScheduled };
}

function recoverChatConnections({ serverRestarted = false }) {
  if (!deps) return;
  applyChatConnectionRecovery(deps, { serverRestarted });
}

function pollReconnectRecovery() {
  if (!deps) return;
  if (!recoveryStartedAt) recoveryStartedAt = Date.now();
  if (Date.now() - recoveryStartedAt > RECOVERY_TIMEOUT_MS) {
    stopReconnectPolling();
    showChatReconnectModal(t('chat.recoveryTimeout'));
    return;
  }
  ensureChatReconnectModal();
  getSettings()
    .then((data) => {
      if (!data?.ok) {
        scheduleReconnectModalIfNeeded(t('chat.serverDisconnected'));
        scheduleReconnectRecovery();
        return;
      }
      if (shouldSuppressServerDisconnectUi()) {
        kickServerRestartRecoveryIfStuck();
      }
      const serverRestarted = didServerRestart(data);
      if (serverRestarted) {
        serverRestartDetected = true;
        deps.appLogger.log('chat-recovery', 'server restart detected', {});
      }
      recoverChatConnections({ serverRestarted });
      const activeChatId = deps.getActiveChatId();
      const activeChat = deps.getChats().find((chat) => chat.id === activeChatId);
      notifyChatBackendReachable(activeChat);
      const socketConnecting = activeChat?.ws?.readyState === WebSocket.CONNECTING;
      const socketOpen = activeChat?.ws?.readyState === WebSocket.OPEN;
      if (socketOpen) {
        stopReconnectRecovery();
        notifyServerRestartRecoveryComplete();
        return;
      }
      if (socketConnecting) {
        resetStaleConnectingSocket(activeChat);
        notifyChatBackendReachable(activeChat);
        scheduleReconnectRecovery(3000);
        return;
      }
      if (serverRestarted) {
        showChatReconnectModal(t('chat.serverRestarted'));
      } else {
        scheduleReconnectModalIfNeeded(t('chat.serverDisconnected'));
      }
      scheduleReconnectRecovery();
    })
    .catch((err) => {
      deps?.appLogger?.log('chat-recovery', 'settings poll failed', {
        error: String(err?.message || err),
      });
      scheduleReconnectModalIfNeeded(t('chat.serverDisconnected'));
      scheduleReconnectRecovery();
    });
}

/**
 * Hides stale reconnect UI after PWA resume when the backend or WS is already healthy.
 *
 * @returns {string | undefined} Fix id for page-resume logging
 */
export function dismissStaleReconnectUiOnResume() {
  if (!deps) return undefined;
  stopReconnectModalDelay();
  if (isActiveChatSocketOpen()) {
    stopReconnectRecovery();
    return 'reconnect-ui';
  }
  const activeChatId = deps.getActiveChatId();
  const activeChat = deps.getChats().find((chat) => chat.id === activeChatId);
  const wsState = activeChat?.ws?.readyState;
  if (wsState === WebSocket.CONNECTING) {
    hideChatReconnectModal();
    return 'reconnect-ui';
  }
  void getSettings()
    .then((data) => {
      if (!data?.ok) return;
      hideChatReconnectModal();
      if (isActiveChatSocketOpen()) stopReconnectRecovery();
    })
    .catch(() => {});
  return undefined;
}

function bindBackgroundReconnectUi() {
  if (backgroundListenerBound || typeof document === 'undefined') return;
  backgroundListenerBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopReconnectModalDelay();
      return;
    }
    dismissStaleReconnectUiOnResume();
    if (!recoveryStartedAt) return;
    clearLastBackgroundDurationMs();
    scheduleReconnectRecovery(0);
    scheduleReconnectModalIfNeeded(t('chat.serverDisconnected'));
  });
}

function bindServerRestartRecovery() {
  if (listenerBound || typeof window === 'undefined') return;
  listenerBound = true;
  window.addEventListener(SERVER_RESTART_READY_EVENT, () => {
    try {
      serverRestartDetected = true;
      if (!shouldSuppressServerDisconnectUi()) {
        showChatReconnectModal(t('chat.serverRestarted'));
      }
      recoverChatConnections({ serverRestarted: true });
      if (isActiveChatSocketOpen()) {
        notifyServerRestartRecoveryComplete();
      }
    } catch (err) {
      deps?.appLogger?.log('chat-recovery', 'server restart handler failed', {
        error: String(err?.message || err),
      });
    } finally {
      stopReconnectRecovery();
    }
  });
}

/**
 * @param {ChatServerRecoveryDeps} dependencies
 */
export function initChatServerRecovery(dependencies) {
  deps = dependencies;
  ensureChatReconnectModal();
  cacheServerInstanceTokenOnInit();
  bindServerRestartRecovery();
  bindBackgroundReconnectUi();
}

/**
 * Starts backend polling when chat WS is down (server restart or network blip).
 *
 * @param {object} chat
 * @param {{ reason?: string, code?: number }} [context]
 */
export function handleChatConnectionLost(chat, context = {}) {
  if (!deps || !chat?.cursorSessionId) return;
  if (chat._remoteDeleted === true) return;
  if (shouldSuppressServerDisconnectUi()) return;
  if (chat.id !== deps.getActiveChatId()) return;
  if (isIntentionalWsReconnect(chat)) {
    clearIntentionalWsReconnect(chat);
    return;
  }
  if (chat.ws?.readyState === WebSocket.OPEN) {
    notifyChatConnectionRestored(chat);
    return;
  }
  chat._recoveryWasBusy = chat._sdkServerBusy === true || chat._agentState === 'active';
  if (!recoveryStartedAt) recoveryStartedAt = Date.now();
  deps.appLogger.log('chat-recovery', 'connection lost', {
    chatId: chat.id,
    reason: context.reason || 'unknown',
    code: Number.isFinite(context.code) ? context.code : null,
    wasBusy: chat._recoveryWasBusy === true,
  });
  scheduleReconnectModalIfNeeded(t('chat.serverDisconnected'));
  if (recoveryTimerId != null) return;
  scheduleReconnectRecovery(isPageCurrentlyHidden() ? 500 : 300);
}
