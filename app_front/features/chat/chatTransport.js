import { getSdkEventTerminalChunk, resetSdkStreamState } from '../../lib/sdk-chat-format.js';
import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import {
  advanceSdkRoomEventWatermarksFromMessages,
  bufferSdkRoomEventDuringHydration,
  beginSdkHistoryHydration,
  finishSdkHistoryHydration,
  isSdkOpenTerminalHydrating,
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
} from './sdkEventReplayGuard.js';
import {
  isUiFreezeTraceActive,
  traceUiFreeze,
  traceUiFreezeWs,
} from '../../lib/uiFreezeTrace.js';
import { resolveAgentStateFromMessage } from './sdkStateResolver.js';
import { isSdkChatGoneErrorCode } from '../../../lib/sdk/sdk-ws-chat-gone.js';
import {
  resolveAgentStateFromRoomState,
  shouldSyncHistoryFromRoomState,
} from '../../../lib/sdk/sdk-room-state.js';
import { resolveSdkRunFailureDetail } from '../../../lib/sdk/sdk-run-outcome.js';
import {
  extractSdkRunOutcomeSnapshot,
  maybeRecoverMissedSdkRunOutcome,
} from './sdkRunOutcomeRecovery.js';
import { getWidgetAccessToken } from '../../api.js';
import { getClientInstanceId } from '../../lib/clientInstance.js';
import { t } from '../../i18n/index.js';
import {
  clearLastBackgroundDurationMs,
  getLastBackgroundDurationMs,
  isPageCurrentlyHidden,
} from '../../lib/pageBackgroundGrace.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { notifyChatConnectionRestored } from './chatServerRecovery.js';
import {
  resolveBackgroundMonitorMode,
  selectBackgroundWsChatIds,
  selectMonitoredChatIds,
  shouldKeepChatSocket,
} from './chatBackgroundPolicy.js';
import {
  MOBILE_WS_REPLAY_FALLBACK_MS,
  RESUME_BACKGROUND_WS_QUIET_MOBILE_MS,
  ROOM_STATE_GAP_SYNC_COOLDOWN_MS,
  shouldRecycleActiveChatSocketOnResume,
  shouldRunResumeChatHistorySync,
  shouldSkipHttpHistorySyncForMobileWsReplay,
  shouldSyncActiveChatHistoryOnResume,
} from './chatResumePolicy.js';
import {
  canOpenChatWebSocketNow,
  resolveBackgroundReconnectBatchDelayMs,
  resolveBackgroundReconnectBatchSize,
} from './chatWsReconnectPolicy.js';
import {
  buildHarnessLaunchLabel,
  isHarnessHelloTransport,
  normalizeHarnessTransport,
  resolveHarnessDisplayLabel,
  resolveHarnessModeLabel,
} from './sdk-transport-labels.js';

/**
 * @param {object} chat
 */
function sdkStreamReset(chat) {
  resetSdkStreamState(chat);
  chat._sdkRichView?.onStreamReset?.();
}

/**
 * @param {Record<string, unknown>} msg
 * @returns {string}
 */
function resolveSdkRunFailureNotice(msg) {
  const failureDetail = resolveSdkRunFailureDetail({
    status: msg.status,
    result: msg.result,
    lastErrorMessage: msg.lastErrorMessage,
    lastErrorCode: msg.lastErrorCode,
  });
  const code = typeof msg.lastErrorCode === 'string' ? msg.lastErrorCode.trim() : '';
  const status = typeof msg.status === 'string' ? msg.status.trim().toLowerCase() : '';
  if (
    code === 'cursor_auth_error'
    || code === 'cursor_rate_limit'
    || code === 'qwen_quota'
    || code === 'qwen_rate_limit'
    || code === 'qwen_auth'
    || code === 'opencode_error'
  ) {
    return '';
  }
  if (status === 'plan_guard_cancelled') {
    return '';
  }
  if (status === 'cancelled') {
    if (code === 'run_stuck_auto_recovery') {
      return t('chat.runStuckAutoRecovery');
    }
    return t('chat.runCancelled', { detail: failureDetail || '' });
  }
  return failureDetail;
}

export function createChatTransport(deps) {
  const {
    WS_PATH_AGENT_SDK,
    CHAT_RECONNECT_MAX,
    CHAT_RECONNECT_DELAYS,
    CHAT_PING_INTERVAL_MS,
    getChats,
    getActiveChatId,
    getMaintainSessionsEnabled,
    getChatActivityAt,
    getSkipCatchUpOnResume,
    appLogger,
    setChatStatus,
    setAgentState,
    renderChatTerminalState,
    buildCatchUpSignature,
    processAgentOutput,
    processAgentOutputCatchUp,
    updateAwaitingInput,
    flushSdkStructuredHistoryNow = () => {},
    setLaunchCommand,
    scrollChatTerminalToBottom,
    appendSdkQueuedPromptLine = () => {},
    promoteSdkQueuedPromptLine = () => {},
    removeSdkQueuedPromptLine = () => {},
    appendSdkUserPromptLine = () => {},
    consumeOptimisticSdkPrompt = () => false,
    consumeOptimisticSdkQueuedPrompt = () => false,
    getSdkVerboseLogsEnabled = () => false,
    onSdkRunFinished = null,
    onSdkResume = null,
    onSdkModelChange = null,
    onSdkInvalidSession = null,
    onChatGone = null,
    onConnectionLost = null,
  } = deps;

  const onSdkModeChange = deps.onSdkModeChange;
  let hiddenAt = 0;

  function syncSdkModeToServer(chat) {
    if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
    chat.ws.send(JSON.stringify({ type: 'setSdkMode', mode: normalizeSdkMode(chat.sdkMode) }));
  }

  function requestActiveSdkWarmup(chat) {
    if (!chat || chat.id !== getActiveChatId()) return;
    if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) return;
    const streamId =
      typeof chat._sdkEventStreamId === 'string' ? chat._sdkEventStreamId.trim() : '';
    if (!streamId || chat._sdkWarmupRequestedForStream === streamId) return;
    chat._sdkWarmupRequestedForStream = streamId;
    chat.ws.send(JSON.stringify({ type: 'warmup' }));
  }

  function shouldIgnoreStaleServerSdkMode(chat, serverMode) {
    const localMode = normalizeSdkMode(chat?.sdkMode);
    const remoteMode = normalizeSdkMode(serverMode);
    if (localMode === remoteMode) return false;
    const userSetAt = Number(chat?._sdkModeUserSetAt);
    if (!Number.isFinite(userSetAt)) return false;
    return Date.now() - userSetAt < 15000;
  }

  function applySdkModeFromServer(chat, mode, source, options = {}) {
    const normalized = normalizeSdkMode(mode);
    if (options.force !== true && shouldIgnoreStaleServerSdkMode(chat, normalized)) {
      syncSdkModeToServer(chat);
      if (typeof onSdkModeChange === 'function') onSdkModeChange(chat, normalizeSdkMode(chat.sdkMode));
      return;
    }
    const changed = normalizeSdkMode(chat.sdkMode) !== normalized;
    chat.sdkMode = normalized;
    if (typeof onSdkModeChange === 'function') onSdkModeChange(chat, normalized);
    if (changed && chat._sdkRichView && source === 'sdkMode') {
      chat._sdkRichView.appendModeChange(normalized);
    }
  }

  function appendSdkTermChunk(chat, chunk) {
    if (!chunk || !chat?.term) return;
    processAgentOutput(chat, chunk);
    chat.term.write(chunk);
    scrollChatTerminalToBottom(chat.term);
  }

  function markChatConnectionHealthy(chat) {
    if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
    notifyChatConnectionRestored(chat);
  }

  function appendTransportNotice(chat, text, tone = 'info') {
    if (!chat) return;
    const message = String(text || '').trim();
    if (!message) return;
    if (chat._sdkRichView) {
      chat._sdkRichView.appendMetaNotice(message);
    }
    if (!chat.term) return;
    const color = tone === 'success' ? '32' : tone === 'warn' ? '33' : '36';
    appendSdkTermChunk(chat, `\r\n\x1b[${color}m${message}\x1b[0m\r\n`);
  }

  function isSdkVerboseLoggingEnabled() {
    if (typeof getSdkVerboseLogsEnabled !== 'function') return false;
    try {
      return !!getSdkVerboseLogsEnabled();
    } catch (_) {
      return false;
    }
  }

  function logSdkVerbose(tag, message, payload = null) {
    if (!isSdkVerboseLoggingEnabled()) return;
    if (payload && typeof payload === 'object') {
      appLogger.log(tag, message, payload);
      return;
    }
    appLogger.log(tag, message);
  }

  function formatDurationSeconds(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds}s`;
  }

  function recoverMissedSdkRunOutcomeFromMessage(chat, message) {
    const recovered = maybeRecoverMissedSdkRunOutcome(
      chat,
      extractSdkRunOutcomeSnapshot(message),
      {
        onHistorySync: (targetChat, reason) => {
          if (typeof onSdkResume !== 'function') return;
          Promise.resolve(onSdkResume(targetChat, { reason })).catch(() => {});
        },
      }
    );
    if (!recovered) return;
    flushSdkStructuredHistoryNow(chat);
    renderChatTerminalState(chat);
  }

  function shouldHandleSdkRunFinished(chat, msg) {
    const runId = typeof msg?.runId === 'string' ? msg.runId.trim() : '';
    if (!runId) return true;
    if (chat?._lastHandledSdkRunFinishedId === runId) return false;
    chat._lastHandledSdkRunFinishedId = runId;
    return true;
  }

  function extractModelIdFromLaunchCommandLine(commandLine) {
    const line = String(commandLine || '').trim();
    if (!line) return '';
    const match = line.match(/(?:^|\s)--model\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    if (!match) return '';
    return (match[1] || match[2] || match[3] || '').trim();
  }

  function confirmPendingModelChange(chat, confirmedModel, source) {
    if (!chat) return;
    const nextModel = String(confirmedModel || '').trim();
    if (!nextModel) return;
    const pending = chat._pendingModelChange;
    chat.model = nextModel;
    if (typeof onSdkModelChange === 'function') {
      onSdkModelChange(chat, nextModel);
    }
    if (!pending) return;
    delete chat._pendingModelChange;
    const requestedModel = String(pending.requestedModel || '').trim() || 'auto';
    if (requestedModel === nextModel) {
      appendTransportNotice(chat, t('chatUi.modelActive', { model: nextModel }), 'success');
      appLogger.log('chat-model', 'model change confirmed', {
        chatId: chat.id,
        requestedModel,
        confirmedModel: nextModel,
        source,
      });
      return;
    }
    appendTransportNotice(
      chat,
      t('chatUi.modelActiveFallback', { model: nextModel, requested: requestedModel }),
      'warn'
    );
    appLogger.log('chat-model', 'model change used a fallback', {
      chatId: chat.id,
      requestedModel,
      confirmedModel: nextModel,
      source,
    });
  }

  let chatPingIntervalId = null;
  let chatBackgroundMonitorIntervalId = null;
  let visibilityBound = false;
  const CHAT_PING_BACKGROUND_INTERVAL_MS = 60000;
  const CHAT_STALE_PONG_MS = 150000;
  const CHAT_BACKGROUND_MONITOR_INTERVAL_MS = 12000;
  const CHAT_CATCHUP_DEDUP_MS = 15000;
  const RESUME_BACKGROUND_SYNC_DEFER_MS = 4500;
  const RESUME_BACKGROUND_SYNC_DEFER_MOBILE_MS = 8000;
  const RESUME_ACTIVE_CHAT_COALESCE_MS = 350;
  const MOBILE_RESUME_CONNECT_DEFER_MS = 600;
  let activeWsConnectCount = 0;
  /** @type {Map<string, object>} */
  const pendingConnectQueue = new Map();
  let pendingConnectDrainTimerId = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let resumeActiveChatTimerId = null;
  /** @type {string | null} */
  let pendingResumeReason = null;
  let pendingResumeForceReconnect = false;
  /** @type {Map<string, object>} */
  const backgroundReconnectQueue = new Map();
  let backgroundReconnectTimerId = null;
  let deferredBackgroundSyncTimerId = null;
  let mobileResumeQuietUntil = 0;
  /** @type {Map<string, number>} */
  const lastRoomStateGapSyncAt = new Map();

  function clearSdkWsReplayWaitState(chat) {
    if (!chat || typeof chat !== 'object') return;
    delete chat._sdkAwaitingWsReplay;
    if (chat._sdkReplayFallbackTimer != null) {
      clearTimeout(chat._sdkReplayFallbackTimer);
      delete chat._sdkReplayFallbackTimer;
    }
  }

  function scheduleSdkWsReplayFallback(chat) {
    if (!chat || chat._sdkHistoryHydrating !== true || chat._sdkAwaitingWsReplay !== true) return;
    if (chat._sdkReplayFallbackTimer != null) return;
    chat._sdkReplayFallbackTimer = setTimeout(() => {
      delete chat._sdkReplayFallbackTimer;
      if (chat._sdkReplayBatchActive === true) return;
      delete chat._sdkAwaitingWsReplay;
      if (chat._sdkHistoryHydrating !== true) return;
      if (typeof onSdkResume === 'function') {
        Promise.resolve(onSdkResume(chat, { reason: 'replay_fallback' })).catch(() => {});
        return;
      }
      completeSdkHistoryHydration(chat, []);
    }, MOBILE_WS_REPLAY_FALLBACK_MS);
  }

  async function flushPendingSdkRoomEvents(chat, pending) {
    if (!chat || !Array.isArray(pending) || pending.length === 0) return;
    for (let index = 0; index < pending.length; index += 1) {
      chat._processSdkSocketMessage?.(pending[index]);
      if (index > 0 && (index + 1) % 8 === 0) {
        await new Promise((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
          else setTimeout(resolve, 0);
        });
      }
    }
  }

  function applyQueuedHelloPrompts(chat) {
    const queuedPrompts = Array.isArray(chat?._sdkHelloQueuedPrompts)
      ? chat._sdkHelloQueuedPrompts.splice(0)
      : [];
    delete chat._sdkHelloQueuedPrompts;
    if (queuedPrompts.length === 0 || chat?._sdkRichView?.queuedCount > 0) return;
    queuedPrompts.forEach((queuedText, index) => {
      if (chat._sdkRichView?.hasQueuedOrSentUserText?.(queuedText)) return;
      appendSdkQueuedPromptLine(chat, queuedText, index + 1);
    });
  }

  function isMobileResumeQuietPeriod() {
    return isMobileLikeClient() && Date.now() < mobileResumeQuietUntil;
  }

  function releaseWsConnectSlot(chat) {
    if (!chat?._wsConnectSlotHeld) return;
    delete chat._wsConnectSlotHeld;
    activeWsConnectCount = Math.max(0, activeWsConnectCount - 1);
    schedulePendingConnectDrain();
  }

  function schedulePendingConnectDrain() {
    if (pendingConnectDrainTimerId != null) return;
    pendingConnectDrainTimerId = setTimeout(() => {
      pendingConnectDrainTimerId = null;
      drainPendingConnectQueue();
    }, resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod()));
  }

  function drainPendingConnectQueue() {
    if (pendingConnectQueue.size === 0) return;
    const activeChatId = getActiveChatId();
    const batchSize = resolveBackgroundReconnectBatchSize(isMobileResumeQuietPeriod());
    const batch = Array.from(pendingConnectQueue.values())
      .sort((left, right) => {
        if (left.id === activeChatId) return -1;
        if (right.id === activeChatId) return 1;
        return 0;
      })
      .slice(0, batchSize);
    for (const chat of batch) {
      pendingConnectQueue.delete(chat.id);
      ensureChatConnection(chat);
    }
    if (pendingConnectQueue.size > 0) schedulePendingConnectDrain();
  }

  function enqueuePendingConnect(chat) {
    if (!chat?.id) return;
    pendingConnectQueue.set(chat.id, chat);
    schedulePendingConnectDrain();
  }

  function clearPendingConnectQueue() {
    pendingConnectQueue.clear();
    if (pendingConnectDrainTimerId == null) return;
    clearTimeout(pendingConnectDrainTimerId);
    pendingConnectDrainTimerId = null;
  }

  function clearBackgroundReconnectQueue() {
    backgroundReconnectQueue.clear();
    if (backgroundReconnectTimerId == null) return;
    clearTimeout(backgroundReconnectTimerId);
    backgroundReconnectTimerId = null;
  }

  function drainBackgroundReconnectQueue() {
    backgroundReconnectTimerId = null;
    if (backgroundReconnectQueue.size === 0) return;
    const batchSize = resolveBackgroundReconnectBatchSize(isMobileResumeQuietPeriod());
    const batchDelay = resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod());
    const batch = Array.from(backgroundReconnectQueue.values()).slice(0, batchSize);
    for (const chat of batch) {
      backgroundReconnectQueue.delete(chat.id);
      ensureChatConnection(chat);
      requestActiveSdkWarmup(chat);
    }
    if (backgroundReconnectQueue.size > 0) {
      backgroundReconnectTimerId = setTimeout(drainBackgroundReconnectQueue, batchDelay);
    }
  }

  function enqueueBackgroundChatReconnect(chat) {
    if (!shouldKeepChatSocket(chat, getChats())) return;
    if (!chat?.id || !chat?.cursorSessionId) return;
    if (chat.id === getActiveChatId()) {
      ensureChatConnection(chat);
      requestActiveSdkWarmup(chat);
      return;
    }
    if (chat.ws?.readyState === WebSocket.OPEN || chat.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    backgroundReconnectQueue.set(chat.id, chat);
    scheduleBackgroundReconnectDrain();
  }

  function scheduleBackgroundReconnectDrain() {
    if (backgroundReconnectTimerId != null) return;
    backgroundReconnectTimerId = setTimeout(
      drainBackgroundReconnectQueue,
      resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod())
    );
  }

  function getPageVisibilityState() {
    if (typeof document === 'undefined') return 'unknown';
    return document.visibilityState || (document.hidden ? 'hidden' : 'visible');
  }

  function buildSocketDiagnostics(chat) {
    const now = Date.now();
    const lastPingAt = Number.isFinite(chat?._lastPingAt) ? chat._lastPingAt : null;
    const lastPongAt = Number.isFinite(chat?._lastPongAt) ? chat._lastPongAt : null;
    return {
      visibility: getPageVisibilityState(),
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      reconnectAttempts: chat?._reconnectAttempts || 0,
      lastPingAgoMs: lastPingAt ? now - lastPingAt : null,
      lastPongAgoMs: lastPongAt ? now - lastPongAt : null,
    };
  }

  function shouldIgnoreDuplicateCatchUp(chat, data) {
    if (!chat) return false;
    const now = Date.now();
    const sig = buildCatchUpSignature(data);
    const sameSig = chat._lastCatchUpSig && chat._lastCatchUpSig === sig;
    const recent =
      typeof chat._lastCatchUpAt === 'number' && now - chat._lastCatchUpAt <= CHAT_CATCHUP_DEDUP_MS;
    chat._lastCatchUpSig = sig;
    chat._lastCatchUpAt = now;
    return sameSig && recent;
  }

  function agentWsUrl(chat) {
    const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof location !== 'undefined' ? location.host : '';
    const params = new URLSearchParams();
    params.set('session', chat.cursorSessionId);
    if (chat.workspaceFile) params.set('workspace', chat.workspaceFile);
    if (chat.workspaceFolder) params.set('workspaceFolder', chat.workspaceFolder);
    if (chat.model) params.set('model', chat.model);
    const clientInstanceId = getClientInstanceId();
    if (clientInstanceId) params.set('clientInstance', clientInstanceId);
    const q = params.toString();
    return protocol + '//' + host + WS_PATH_AGENT_SDK + (q ? '?' + q : '');
  }

  function handleBackgroundAgentWsOutput(chat, msg) {
    if (!msg || msg.type !== 'output' || msg.data == null) return;
    if (msg.catchUp && getSkipCatchUpOnResume()) return;
    if (msg.catchUp) {
      if (shouldIgnoreDuplicateCatchUp(chat, msg.data)) return;
      processAgentOutputCatchUp(chat, msg.data);
      return;
    }
    processAgentOutput(chat, msg.data);
  }

  function stopChatReconnect(chat) {
    if (!chat?._reconnectTimer) return;
    clearTimeout(chat._reconnectTimer);
    chat._reconnectTimer = null;
  }

  function handleRemoteChatGone(chat) {
    if (!chat || chat._remoteDeleted === true) return;
    chat._remoteDeleted = true;
    stopChatReconnect(chat);
    pendingConnectQueue.delete(chat.id);
    backgroundReconnectQueue.delete(chat.id);
    const socket = chat.ws;
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    if (typeof onChatGone === 'function') onChatGone(chat);
  }

  function scheduleChatReconnect(chat) {
    if (!shouldKeepChatSocket(chat, getChats())) return;
    if (!chat?.cursorSessionId) return;
    if (!getMaintainSessionsEnabled()) return;
    const wsChatIds = selectBackgroundWsChatIds(getChats(), getActiveChatId, getChatActivityAt);
    if (!wsChatIds.has(chat.id)) {
      chat._connectionStatus = 'disconnected';
      if (chat.id === getActiveChatId()) setChatStatus('disconnected');
      renderChatTerminalState(chat);
      return;
    }
    if (isPageCurrentlyHidden()) {
      chat._connectionStatus = 'reconnecting';
      if (chat.id === getActiveChatId()) setChatStatus('reconnecting');
      renderChatTerminalState(chat);
      return;
    }
    const isActiveChat = chat.id === getActiveChatId();
    chat._reconnectAttempts = (chat._reconnectAttempts || 0) + 1;
    const exceededMax = chat._reconnectAttempts > CHAT_RECONNECT_MAX;
    if (exceededMax && !isActiveChat) {
      chat._connectionStatus = 'disconnected';
      if (chat.id === getActiveChatId()) setChatStatus('disconnected');
      renderChatTerminalState(chat);
      return;
    }
    chat._connectionStatus = 'reconnecting';
    if (chat.id === getActiveChatId()) setChatStatus('reconnecting');
    renderChatTerminalState(chat);
    if (exceededMax && isActiveChat && typeof onConnectionLost === 'function') {
      onConnectionLost(chat, { reason: 'reconnect_exhausted' });
    }
    const delayIndex =
      exceededMax && isActiveChat
        ? CHAT_RECONNECT_DELAYS.length - 1
        : Math.min(chat._reconnectAttempts - 1, CHAT_RECONNECT_DELAYS.length - 1);
    const baseDelay = CHAT_RECONNECT_DELAYS[delayIndex] || 8000;
    const hidden = isPageCurrentlyHidden();
    let delay = hidden ? Math.min(30000, baseDelay * 3) : baseDelay;
    if (exceededMax && isActiveChat) {
      delay = Math.min(30000, delay + Math.floor(Math.random() * 2000));
    }
    appLogger.log('chat-ws', 'reconnect scheduled', {
      chatId: chat.id,
      delayMs: delay,
      attempt: chat._reconnectAttempts,
      activeUnlimited: isActiveChat && exceededMax,
      ...buildSocketDiagnostics(chat),
    });
    chat._reconnectTimer = setTimeout(() => {
      chat._reconnectTimer = null;
      ensureChatConnection(chat);
    }, delay);
  }

  function ensureChatConnection(chat) {
    if (!shouldKeepChatSocket(chat, getChats())) return;
    if (!chat?.cursorSessionId) return;
    if (
      getMaintainSessionsEnabled() &&
      chat.id !== getActiveChatId()
    ) {
      const wsChatIds = selectBackgroundWsChatIds(getChats(), getActiveChatId, getChatActivityAt);
      if (!wsChatIds.has(chat.id)) return;
    }
    if (chat.ws && chat.ws.readyState === WebSocket.OPEN) {
      startGlobalChatPingLoop();
      return;
    }
    if (chat.ws && chat.ws.readyState === WebSocket.CONNECTING) return;
    if (chat.ws && chat.ws.readyState === WebSocket.CLOSING) return;
    if (chat._reconnectTimer) {
      clearTimeout(chat._reconnectTimer);
      chat._reconnectTimer = null;
    }
    if (chat.ws) {
      try {
        chat.ws.onclose = null;
        chat.ws.close();
      } catch (_) {}
      chat.ws = null;
      releaseWsConnectSlot(chat);
    }
    const isActiveChat = chat.id === getActiveChatId();
    if (!canOpenChatWebSocketNow(activeWsConnectCount, isActiveChat)) {
      enqueuePendingConnect(chat);
      chat._connectionStatus = 'reconnecting';
      if (isActiveChat) setChatStatus('reconnecting');
      renderChatTerminalState(chat);
      appLogger.log('chat-ws', 'connect deferred (concurrency cap)', {
        chatId: chat.id,
        activeWsConnectCount,
        queued: pendingConnectQueue.size,
      });
      return;
    }
    chat._wsConnectSlotHeld = true;
    activeWsConnectCount += 1;
    chat._connectionStatus = 'connecting';
    if (chat.id === getActiveChatId()) setChatStatus('connecting');
    renderChatTerminalState(chat);
    appLogger.log('chat-ws', 'opening socket', {
      chatId: chat.id,
      url: agentWsUrl(chat),
      ...buildSocketDiagnostics(chat),
    });
    const widgetAccessToken = getWidgetAccessToken();
    const socket = widgetAccessToken
      ? new WebSocket(agentWsUrl(chat), ['cretli-widget', widgetAccessToken])
      : new WebSocket(agentWsUrl(chat));
    socket.onmessage = (ev) => {
      let messageType = 'unknown';
      try {
        const msg = JSON.parse(ev.data);
        if (typeof msg?.type === 'string' && msg.type.trim()) {
          messageType = msg.type;
        }
        if (isUiFreezeTraceActive()) {
          const wsExtra = {};
          if (msg.type === 'replayBatch' && Array.isArray(msg.events)) {
            wsExtra.eventCount = msg.events.length;
          }
          if (msg.replay === true) wsExtra.replay = true;
          traceUiFreezeWs('in', chat.id, msg.type || 'unknown', wsExtra);
        }
        if (msg.type === 'sdkTtft' && !Number.isFinite(msg.clientReceivedAt)) {
          msg.clientReceivedAt = Date.now();
        }
        if (msg.type === 'pong') {
          chat._lastPongAt = Date.now();
          return;
        }
        if (msg.type === 'replayBatchStart') {
          chat._sdkReplayBatchActive = true;
          chat._sdkReplayBatchExpected = Number(msg.totalEvents) || 0;
          clearSdkWsReplayWaitState(chat);
          traceUiFreeze('sdk-replay', 'batch-start', {
            chatId: chat.id,
            totalEvents: chat._sdkReplayBatchExpected,
            hydrating: chat._sdkHistoryHydrating === true,
          });
          return;
        }
        if (msg.type === 'replayBatch' && Array.isArray(msg.events)) {
          const replayEvents = msg.events.filter((event) => event && typeof event === 'object');
          if (chat._sdkRichView?.hasRenderedHistory?.() === true) {
            advanceSdkRoomEventWatermarksFromMessages(
              chat,
              replayEvents.map((event) => ({ ...event, replay: true }))
            );
            return;
          }
          for (const event of replayEvents) {
            const replayMsg = { ...event, replay: true };
            if (bufferSdkRoomEventDuringHydration(chat, replayMsg)) continue;
            if (!shouldApplySdkRoomEvent(chat, replayMsg)) continue;
            if (typeof chat._processSdkSocketMessage === 'function') {
              chat._processSdkSocketMessage(replayMsg);
            }
          }
          return;
        }
        if (msg.type === 'replayBatchEnd') {
          traceUiFreeze('sdk-replay', 'batch-end', {
            chatId: chat.id,
            expected: chat._sdkReplayBatchExpected || 0,
            hydrating: chat._sdkHistoryHydrating === true,
          });
          delete chat._sdkReplayBatchActive;
          delete chat._sdkReplayBatchExpected;
          clearSdkWsReplayWaitState(chat);
          if (chat._sdkHistoryHydrating === true && !isSdkOpenTerminalHydrating(chat)) {
            completeSdkHistoryHydration(chat, []);
          }
          return;
        }
        if (msg.type === 'sdkRoomState') {
          if (typeof msg.eventStreamId === 'string') {
            syncSdkEventStream(chat, msg.eventStreamId);
          }
          chat._sdkServerBusy = msg.busy === true;
          chat._sdkServerQueuedCount = Math.max(0, Number(msg.queuedCount) || 0);
          const pendingQuestionCount = Math.max(0, Number(msg.pendingQuestionCount) || 0);
          const pendingPermissionCount = Math.max(0, Number(msg.pendingPermissionCount) || 0);
          chat._sdkServerPendingQuestionCount = pendingQuestionCount;
          chat._sdkServerPendingPermissionCount = pendingPermissionCount;
          const isAwaitingInteractiveInput = pendingQuestionCount > 0 || pendingPermissionCount > 0;
          if (isAwaitingInteractiveInput) {
            chat._awaitingInput = true;
            chat._terminalInteraction = {
              ...(chat._terminalInteraction || {}),
              question: true,
              awaiting: true,
            };
          } else if (!chat._opencodePendingQuestion && !chat._opencodePendingPermission) {
            chat._awaitingInput = false;
            chat._terminalInteraction = {
              ...(chat._terminalInteraction || {}),
              question: false,
              awaiting: false,
            };
          }
          const roomState = resolveAgentStateFromRoomState(chat._agentState || 'idle', msg);
          if (roomState) setAgentState(chat, roomState);
          renderChatTerminalState(chat);
          markChatConnectionHealthy(chat);
          if (shouldSyncHistoryFromRoomState(chat, msg) && typeof onSdkResume === 'function') {
            const now = Date.now();
            const lastSyncAt = lastRoomStateGapSyncAt.get(chat.id) || 0;
            if (now - lastSyncAt >= ROOM_STATE_GAP_SYNC_COOLDOWN_MS) {
              lastRoomStateGapSyncAt.set(chat.id, now);
              Promise.resolve(onSdkResume(chat, { reason: 'room_state_gap' })).catch(() => {});
            }
          }
          recoverMissedSdkRunOutcomeFromMessage(chat, msg);
          return;
        }
        if (msg.type === 'hello' && isHarnessHelloTransport(msg.transport)) {
          chat.agentTransport = msg.transport === 'cursor-sdk' ? 'sdk' : String(msg.transport);
          syncSdkEventStream(chat, msg.eventStreamId);
          chat._sdkReplayTagged = msg.replayTagged === true;
          chat._sdkServerBusy = msg.busy === true;
          chat._sdkServerQueuedCount = Array.isArray(msg.queuedPrompts) ? msg.queuedPrompts.length : 0;
          chat._sdkOptimisticSentNow = [];
          chat._sdkOptimisticSentQueued = [];
          sdkStreamReset(chat);
          const helloState = resolveAgentStateFromMessage(chat._agentState || 'idle', msg);
          if (helloState) setAgentState(chat, helloState);
          const helloModel = typeof msg.modelId === 'string' ? msg.modelId.trim() : '';
          if (helloModel) confirmPendingModelChange(chat, helloModel, 'hello');
          const helloMode =
            msg.sdkMode === 'plan' || msg.sdkMode === 'agent' ? normalizeSdkMode(msg.sdkMode) : null;
          const localMode = normalizeSdkMode(chat.sdkMode || helloMode || 'agent');
          chat.sdkMode = localMode;
          if (typeof onSdkModeChange === 'function') onSdkModeChange(chat, localMode);
          if (helloMode && helloMode !== localMode) {
            syncSdkModeToServer(chat);
          }
          requestActiveSdkWarmup(chat);
          markChatConnectionHealthy(chat);
          const hasQueuedPrompts = Array.isArray(msg.queuedPrompts) && msg.queuedPrompts.length > 0;
          if (hasQueuedPrompts) {
            if (chat._sdkHistoryHydrating === true) {
              chat._sdkHelloQueuedPrompts = msg.queuedPrompts.slice();
            } else {
              msg.queuedPrompts.forEach((queuedText, index) => {
                if (chat._sdkRichView?.hasQueuedOrSentUserText?.(queuedText)) return;
                appendSdkQueuedPromptLine(chat, queuedText, index + 1);
              });
            }
          }
          setLaunchCommand(
            chat,
            buildHarnessLaunchLabel({
              transport: chat?.agentTransport,
              mode: localMode,
              sessionRef: (msg.sessionKey && String(msg.sessionKey).slice(0, 8)) || '?',
            }),
            ''
          );
          recoverMissedSdkRunOutcomeFromMessage(chat, msg);
          if (chat._sdkAwaitingWsReplay === true) {
            scheduleSdkWsReplayFallback(chat);
          }
          return;
        }
        if (bufferSdkRoomEventDuringHydration(chat, msg)) return;
        if (!shouldApplySdkRoomEvent(chat, msg)) return;
        if (msg.type === 'sdkTtft') {
          const clientSentAt = Number(msg.clientSentAt);
          const clientReceivedAt = Number(msg.clientReceivedAt);
          const clientTtftMs =
            Number.isFinite(clientSentAt) && Number.isFinite(clientReceivedAt)
              ? clientReceivedAt - clientSentAt
              : null;
          chat._sdkLastTtft = {
            ...msg,
            clientTtftMs,
          };
          appLogger.log('sdk-ttft', 'first assistant delta received', {
            chatId: chat.id,
            socketToServerMs: Number.isFinite(msg.socketToServerMs) ? msg.socketToServerMs : null,
            agentSetupMs: Number.isFinite(msg.agentSetupMs) ? msg.agentSetupMs : null,
            sendCallMs: Number.isFinite(msg.sendCallMs) ? msg.sendCallMs : null,
            sendToFirstEventMs: Number.isFinite(msg.sendToFirstEventMs)
              ? msg.sendToFirstEventMs
              : null,
            serverTtftMs: Number.isFinite(msg.serverTtftMs) ? msg.serverTtftMs : null,
            clientTtftMs,
          });
          return;
        }
        if (msg.type === 'sdkAgent') {
          const confirmedModel = typeof msg.modelId === 'string' ? msg.modelId.trim() : '';
          if (confirmedModel) confirmPendingModelChange(chat, confirmedModel, 'sdkAgent');
          const runMode =
            msg.sdkMode === 'plan' || msg.sdkMode === 'agent' ? normalizeSdkMode(msg.sdkMode) : null;
          if (runMode && !shouldIgnoreStaleServerSdkMode(chat, runMode)) {
            chat.sdkMode = runMode;
            if (typeof onSdkModeChange === 'function') onSdkModeChange(chat, runMode);
          }
          const transportLabel = resolveHarnessDisplayLabel(chat?.agentTransport);
          const modeLabel = resolveHarnessModeLabel(chat?.agentTransport, chat.sdkMode);
          setLaunchCommand(chat, `${transportLabel} · ${modeLabel} · ${msg.agentId || ''}`, '');
          return;
        }
        if (msg.type === 'sdkModelFallback') {
          const fallbackModel = typeof msg.modelId === 'string' ? msg.modelId.trim() : '';
          const previousModel = typeof msg.previousModelId === 'string' ? msg.previousModelId.trim() : '';
          if (fallbackModel) {
            appendTransportNotice(
              chat,
              previousModel
                ? t('chatUi.modelUnavailableSwitched', {
                  previous: previousModel,
                  model: fallbackModel,
                })
                : t('chatUi.modelSwitched', { model: fallbackModel }),
              'warn'
            );
            confirmPendingModelChange(chat, fallbackModel, 'sdkModelFallback');
          }
          return;
        }
        if (msg.type === 'sdkMode' && (msg.mode === 'plan' || msg.mode === 'agent')) {
          applySdkModeFromServer(chat, msg.mode, 'sdkMode', {
            force: msg.reason === 'plan_question_approved',
          });
          const sessionRef =
            (chat.cursorSessionId && String(chat.cursorSessionId).slice(0, 8)) || '?';
          setLaunchCommand(
            chat,
            buildHarnessLaunchLabel({
              transport: chat?.agentTransport,
              mode: msg.mode,
              sessionRef,
            }),
            ''
          );
          return;
        }
        if (msg.type === 'opencodeQuestionResolved' || msg.type === 'questionResolved') {
          const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
          chat._sdkRichView?.resolveOpenCodeQuestion?.(requestId);
          if (chat._opencodePendingQuestion?.requestId === requestId) {
            delete chat._opencodePendingQuestion;
          }
          if (!chat._opencodePendingQuestion && !chat._opencodePendingPermission) {
            chat._awaitingInput = false;
            if (chat._terminalInteraction) {
              chat._terminalInteraction = {
                ...chat._terminalInteraction,
                question: false,
                awaiting: false,
              };
            }
            renderChatTerminalState(chat);
          }
          return;
        }
        if (msg.type === 'opencodePermissionResolved') {
          const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
          chat._sdkRichView?.resolveOpenCodePermission?.(requestId);
          if (chat._opencodePendingPermission?.requestId === requestId) {
            delete chat._opencodePendingPermission;
          }
          if (!chat._opencodePendingQuestion && !chat._opencodePendingPermission) {
            chat._awaitingInput = false;
            if (chat._terminalInteraction) {
              chat._terminalInteraction = {
                ...chat._terminalInteraction,
                question: false,
                awaiting: false,
              };
            }
            renderChatTerminalState(chat);
          }
          return;
        }
        if (msg.type === 'sdkEvent' && msg.event) {
          chat._sdkLastLiveEventAt = Date.now();
          if (msg.event && typeof msg.event === 'object' && msg.event.type === 'opencode_question') {
            chat._opencodePendingQuestion = msg.event;
            chat._awaitingInput = true;
            chat._terminalInteraction = {
              ...(chat._terminalInteraction || {}),
              question: true,
              awaiting: true,
            };
            renderChatTerminalState(chat);
          }
          if (msg.event && typeof msg.event === 'object' && msg.event.type === 'opencode_permission') {
            chat._opencodePendingPermission = msg.event;
            chat._awaitingInput = true;
            chat._terminalInteraction = {
              ...(chat._terminalInteraction || {}),
              question: true,
              awaiting: true,
            };
            renderChatTerminalState(chat);
          }
          if (msg.event && typeof msg.event === 'object' && msg.event.type === 'usage') {
            const usage = msg.event.usage && typeof msg.event.usage === 'object' ? msg.event.usage : null;
            const inputTokens = Number(usage?.inputTokens);
            const outputTokens = Number(usage?.outputTokens);
            const totalTokens = Number(usage?.totalTokens);
            chat._contextUsageInputTokens = Number.isFinite(inputTokens) ? inputTokens : null;
            chat._contextUsageOutputTokens = Number.isFinite(outputTokens) ? outputTokens : null;
            chat._contextUsageTotalTokens = Number.isFinite(totalTokens) ? totalTokens : null;
            const transport = String(chat.agentTransport || 'sdk').trim() || 'sdk';
            chat._contextUsageSource = transport === 'sdk' ? 'sdk-live' : `${transport}-live`;
            chat._contextUsageUpdatedAt = Date.now();
            delete chat._sdkContextFreshSession;
            renderChatTerminalState(chat);
          }
          setAgentState(chat, 'active');
          if (chat._sdkRichView) {
            chat._sdkRichView.applyEvent(msg.event);
            return;
          }
          const chunk = getSdkEventTerminalChunk(chat, msg.event);
          if (!chunk) return;
          appendSdkTermChunk(chat, chunk);
          return;
        }
        if (msg.type === 'sdkRunFinished') {
          if (!shouldHandleSdkRunFinished(chat, msg)) {
            chat._lastShownSdkErrorText = '';
            const replayState = resolveAgentStateFromMessage(chat._agentState || 'active', msg);
            const hasVisibleQueue = (chat._sdkRichView?.queuedCount || 0) > 0;
            if (replayState) setAgentState(chat, hasVisibleQueue ? 'active' : replayState);
            return;
          }
          chat._sdkLastLiveEventAt = Date.now();
          const remaining = Math.max(
            0,
            Number(msg.remaining) || 0,
            chat._sdkRichView?.queuedCount || 0
          );
          chat._sdkServerBusy = remaining > 0;
          chat._sdkServerQueuedCount = remaining;
          chat._sdkOptimisticSentNow = [];
          sdkStreamReset(chat);
          const runStatus = typeof msg.status === 'string' ? msg.status : '';
          const failureDetail = resolveSdkRunFailureNotice(msg);
          appLogger.log('sdk-run', 'run finished', {
            chatId: chat.id,
            runId: typeof msg.runId === 'string' ? msg.runId : null,
            status: runStatus || null,
            hasFailureDetail: !!failureDetail,
          });
          if (chat._sdkRichView) {
            chat._sdkRichView.appendRunFinished(runStatus);
            const errorCode = typeof msg.lastErrorCode === 'string' ? msg.lastErrorCode.trim() : '';
            if (errorCode === 'cursor_rate_limit') {
              chat._sdkRichView.appendError(
                t('chat.sdkRateLimitError', {
                  detail: typeof msg.lastErrorMessage === 'string' ? msg.lastErrorMessage : '',
                })
              );
            } else if (failureDetail) {
              const shown = String(chat._lastShownSdkErrorText || '').trim();
              if (!shown || shown !== failureDetail) {
                chat._sdkRichView.appendMetaNotice(failureDetail);
              }
            }
            chat._lastShownSdkErrorText = '';
          } else {
            appendSdkTermChunk(chat, `\r\n\x1b[32m[run finished: ${runStatus}]\x1b[0m\r\n`);
            if (failureDetail) {
              appendSdkTermChunk(chat, `\r\n\x1b[33m[SDK] ${failureDetail}\x1b[0m\r\n`);
            }
          }
          flushSdkStructuredHistoryNow(chat);
          const nextState = resolveAgentStateFromMessage(chat._agentState || 'active', msg);
          setAgentState(chat, nextState || (remaining > 0 ? 'active' : 'idle'));
          if (typeof onSdkRunFinished === 'function') {
            try {
              onSdkRunFinished(chat, msg);
            } catch (err) {
              appLogger.log('chat-ws', 'onSdkRunFinished handler failed', {
                chatId: chat.id,
                error: String(err?.message || err),
              });
            }
          }
          return;
        }
        if (msg.type === 'sdkBusy') {
          chat._sdkLastLiveEventAt = Date.now();
          chat._sdkServerBusy = msg.busy === true;
          const busyState = resolveAgentStateFromMessage(chat._agentState || 'idle', msg);
          if (busyState) setAgentState(chat, busyState);
          if (msg.busy === false) {
            renderChatTerminalState(chat);
            return;
          }
          if (chat._sdkRichView) {
            chat._sdkRichView.appendBusy(typeof msg.message === 'string' ? msg.message : '');
          } else {
            const label = typeof msg.message === 'string' && msg.message.trim()
              ? msg.message.trim()
              : t('chatUi.sdkBusy');
            appendSdkTermChunk(chat, `\r\n\x1b[33m[SDK] ${label}\x1b[0m\r\n`);
          }
          return;
        }
        if (msg.type === 'sdkQueued') {
          chat._sdkLastLiveEventAt = Date.now();
          chat._sdkServerBusy = true;
          chat._sdkServerQueuedCount = Math.max(
            Number(chat._sdkServerQueuedCount) || 0,
            Number(msg.position) || 1
          );
          setAgentState(chat, 'active');
          if (consumeOptimisticSdkQueuedPrompt(chat, msg.text || '')) {
            renderChatTerminalState(chat);
            return;
          }
          if (consumeOptimisticSdkPrompt(chat, msg.text || '')) {
            chat._sdkRichView?.markUserPromptQueued?.(msg.text || '');
            renderChatTerminalState(chat);
            return;
          }
          appendSdkQueuedPromptLine(chat, msg.text || '', msg.position || 1);
          renderChatTerminalState(chat);
          return;
        }
        if (msg.type === 'sdkQueueRemoved') {
          chat._sdkServerQueuedCount = Math.max(0, (Number(chat._sdkServerQueuedCount) || 1) - 1);
          removeSdkQueuedPromptLine(chat, msg.text || '');
          renderChatTerminalState(chat);
          return;
        }
        if (msg.type === 'sdkPromptStarted') {
          chat._sdkLastLiveEventAt = Date.now();
          chat._sdkServerBusy = true;
          chat._sdkServerQueuedCount = Math.max(0, Number(msg.remaining) || 0);
          logSdkVerbose('sdk-run', 'prompt started', {
            chatId: chat.id,
            fromQueue: msg.fromQueue === true,
            remaining: Number.isFinite(msg.remaining) ? msg.remaining : null,
          });
          if (msg.fromQueue === true) {
            consumeOptimisticSdkQueuedPrompt(chat, msg.text || '');
            promoteSdkQueuedPromptLine(chat, msg.text || '');
          } else {
            if (consumeOptimisticSdkPrompt(chat, msg.text || '')) {
              setAgentState(chat, 'active');
              return;
            }
            if (consumeOptimisticSdkQueuedPrompt(chat, msg.text || '')) {
              promoteSdkQueuedPromptLine(chat, msg.text || '');
              setAgentState(chat, 'active');
              return;
            }
            appendSdkUserPromptLine(chat, msg.text || '');
          }
          setAgentState(chat, 'active');
          return;
        }
        if (msg.type === 'sdkRunProgress') {
          chat._sdkLastLiveEventAt = Date.now();
          setAgentState(chat, 'active');
          const phase = typeof msg.phase === 'string' ? msg.phase : '';
          const idleForMs = Number.isFinite(msg.idleForMs) ? Number(msg.idleForMs) : 0;
          const remainingMs = Number.isFinite(msg.remainingMs) ? Number(msg.remainingMs) : null;
          const timeoutMs = Number.isFinite(msg.timeoutMs) ? Number(msg.timeoutMs) : null;
          let notice = '';
          const transportLabel = resolveHarnessDisplayLabel(chat?.agentTransport);
          const idleLabel = formatDurationSeconds(idleForMs);
          if (phase === 'started') {
            notice = t('chatUi.runProgressStarted', { transport: transportLabel });
          } else if (phase === 'connecting' || phase === 'setup') {
            notice = t('chatUi.runProgressPreparingAgent', {
              transport: transportLabel,
              duration: idleLabel,
            });
          } else if (phase === 'preparing') {
            notice = t('chatUi.runProgressPreparingPrompt', {
              transport: transportLabel,
              duration: idleLabel,
            });
          } else if (phase === 'sending') {
            notice = t('chatUi.runProgressSendingPrompt', {
              transport: transportLabel,
              duration: idleLabel,
            });
          } else if (phase === 'setup_past_budget') {
            notice = t('chatUi.runProgressSetupPastBudget', {
              transport: transportLabel,
              duration: idleLabel,
            });
          } else if (phase === 'awaiting_first_event') {
            notice = t('chatUi.runProgressAwaitingFirstEvent', {
              transport: transportLabel,
              duration: idleLabel,
            });
          } else if (phase === 'awaiting_next_event') {
            notice = t('chatUi.runProgressAwaitingNextEvent', {
              transport: transportLabel,
              duration: idleLabel,
            });
          } else if (phase === 'awaiting_past_budget') {
            notice = t('chatUi.runProgressAwaitingPastBudget', {
              transport: transportLabel,
              duration: idleLabel,
            });
          }
          if (remainingMs != null && remainingMs > 0 && phase !== 'started') {
            notice += ` ${t('chatUi.runProgressWarnThreshold', {
              duration: formatDurationSeconds(remainingMs),
            })}`;
          }
          if (timeoutMs != null && timeoutMs > 0) {
            logSdkVerbose('sdk-progress', 'run waiting', {
              chatId: chat.id,
              phase,
              idleForMs,
              remainingMs,
              timeoutMs,
            });
          }
          if (notice) {
            if (chat._sdkRichView?.appendSdkRunProgress) {
              chat._sdkRichView.appendSdkRunProgress({
                phase,
                idleForMs,
                remainingMs,
                timeoutMs,
              });
              if (chat.term) {
                appendSdkTermChunk(chat, `\r\n\x1b[33m${notice}\x1b[0m\r\n`);
              }
            } else {
              appendTransportNotice(chat, notice, 'warn');
            }
          }
          return;
        }
        if (msg.type === 'sdkPlanGuard') {
          chat._sdkLastLiveEventAt = Date.now();
          const guardMsg = msg.message || t('chatUi.planGuardBlocked');
          if (chat._sdkRichView) {
            chat._sdkRichView.appendMetaNotice(guardMsg);
          } else {
            appendSdkTermChunk(chat, `\r\n\x1b[33m[PLAN] ${guardMsg}\x1b[0m\r\n`);
          }
          return;
        }
        if (msg.type === 'sdkError') {
          if (isSdkChatGoneErrorCode(msg.code)) {
            handleRemoteChatGone(chat);
            return;
          }
          chat._sdkLastLiveEventAt = Date.now();
          const queuedCount =
            chat._sdkRichView?.queuedCount || Number(chat._sdkServerQueuedCount) || 0;
          chat._sdkServerBusy = queuedCount > 0;
          chat._sdkOptimisticSentNow = [];
          sdkStreamReset(chat);
          appLogger.log('sdk-run', 'sdk error', {
            chatId: chat.id,
            code: msg.code || null,
            message: msg.message || null,
          });
          const pendingModel = chat?._pendingModelChange?.requestedModel;
          if (pendingModel) {
            appendTransportNotice(
              chat,
              t('chatUi.modelChangeFailed', { model: pendingModel }),
              'warn'
            );
            delete chat._pendingModelChange;
          }
          if (chat._sdkRichView) {
            if (msg.code === 'run_stuck_auto_recovery') {
              chat._sdkRichView.appendMetaNotice(
                msg.message || t('chat.runStuckAutoRecovery')
              );
            } else if (msg.code === 'cursor_rate_limit') {
              chat._sdkRichView.appendError(
                t('chat.sdkRateLimitError', { detail: msg.message || '' })
              );
            } else if (msg.code === 'cursor_auth_error') {
              chat._sdkRichView.appendError(
                t('chat.sdkAuthError', { detail: msg.message || '' })
              );
            } else if (msg.code === 'qwen_quota' || msg.code === 'qwen_rate_limit') {
              chat._sdkRichView.appendError(
                t('chat.qwenQuotaError', { detail: msg.message || '' })
              );
            } else if (msg.code === 'qwen_auth') {
              chat._sdkRichView.appendError(
                t('chat.qwenAuthError', { detail: msg.message || '' })
              );
            } else {
              const errorText = msg.message || msg.code || 'unknown';
              chat._lastShownSdkErrorText = String(errorText).trim();
              chat._sdkRichView.appendError(errorText);
            }
          } else {
            appendSdkTermChunk(
              chat,
              `\r\n\x1b[31m[SDK error] ${msg.message || msg.code || 'unknown'}\x1b[0m\r\n`
            );
          }
          if (msg.code === 'invalid_session' && typeof onSdkInvalidSession === 'function') {
            const now = Date.now();
            const lastRecoveryAt = Number(chat._sdkInvalidSessionRecoveryAt) || 0;
            const cooldownMs = 15000;
            const canRecover = now - lastRecoveryAt >= cooldownMs
              && chat._sdkInvalidSessionRecoveryPending !== true;
            if (canRecover) {
              chat._sdkInvalidSessionRecoveryAt = now;
              chat._sdkInvalidSessionRecoveryPending = true;
              chat._sdkRichView?.appendMetaNotice?.(t('chatUi.invalidSessionRecovering'));
              Promise.resolve(onSdkInvalidSession(chat, msg))
                .catch((recoveryError) => {
                  appLogger.log('sdk-run', 'auto recovery failed', {
                    chatId: chat.id,
                    error: String(recoveryError?.message || recoveryError),
                  });
                })
                .finally(() => {
                  chat._sdkInvalidSessionRecoveryPending = false;
                });
            }
          }
          flushSdkStructuredHistoryNow(chat);
          setAgentState(chat, queuedCount > 0 ? 'active' : 'idle');
          return;
        }
        if (msg.type === 'agentLaunch') {
          setLaunchCommand(chat, msg.commandLine || '', msg.cwd || '');
          const launchModel = extractModelIdFromLaunchCommandLine(msg.commandLine);
          if (launchModel) {
            confirmPendingModelChange(chat, launchModel, 'agentLaunch');
          }
          return;
        }
        if (msg.type === 'output') {
          handleBackgroundAgentWsOutput(chat, msg);
        }
      } catch (err) {
        appLogger.log('chat-ws', 'socket message handler failed', {
          chatId: chat.id,
          messageType,
          error: String(err?.message || err),
        });
      }
    };
    chat._processSdkSocketMessage = (message) => {
      if (chat.ws !== socket || typeof socket.onmessage !== 'function') return;
      socket.onmessage({ data: JSON.stringify(message) });
    };
    socket.onclose = (event) => {
      delete chat._wsConnectingSince;
      appLogger.log('chat-ws', 'socket closed', {
        chatId: chat.id,
        code: event?.code,
        reason: event?.reason || '',
        wasClean: !!event?.wasClean,
        ...buildSocketDiagnostics(chat),
      });
      if (event?.code === 4401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
        const currentPath = `${window.location.pathname || '/'}${window.location.search || ''}`;
        const shouldDropNext = currentPath === '/login' || currentPath.startsWith('/login?');
        const next = encodeURIComponent(shouldDropNext ? '/' : currentPath);
        window.location.replace(`/login?next=${next}`);
        return;
      }
      chat.ws = null;
      releaseWsConnectSlot(chat);
      if (chat._remoteDeleted === true) {
        chat._connectionStatus = 'disconnected';
        return;
      }
      if (isPageCurrentlyHidden()) {
        chat._connectionStatus = 'reconnecting';
        if (chat.id === getActiveChatId()) setChatStatus('reconnecting');
        renderChatTerminalState(chat);
        return;
      }
      chat._connectionStatus = 'disconnected';
      if (chat.id === getActiveChatId() && typeof onConnectionLost === 'function') {
        onConnectionLost(chat, { reason: 'socket_closed', code: event?.code });
      }
      scheduleChatReconnect(chat);
    };
    socket.onopen = () => {
      delete chat._wsConnectingSince;
      chat._reconnectAttempts = 0;
      chat._lastPongAt = Date.now();
      chat._lastPingAt = 0;
      chat._connectionStatus = 'connected';
      appLogger.log('chat-ws', 'socket opened', {
        chatId: chat.id,
        ...buildSocketDiagnostics(chat),
      });
      if (chat.id === getActiveChatId()) setChatStatus('connected');
      if (chat._sdkRichView) {
        if (chat._sdkHistoryHydrating !== true) {
          sdkStreamReset(chat);
            chat._sdkRichView.appendBannerConnected({
              transport: normalizeHarnessTransport(chat?.agentTransport),
            });
        }
      }
      syncSdkModeToServer(chat);
      startGlobalChatPingLoop();
      markChatConnectionHealthy(chat);
    };
    chat._wsConnectingSince = Date.now();
    chat.ws = socket;
  }

  function completeSdkHistoryHydration(chat, records) {
    if (!chat || typeof chat !== 'object') return;
    const pending = finishSdkHistoryHydration(chat, records);
    const hasRenderedHistory = chat._sdkRichView?.hasRenderedHistory?.() === true;
    if (
      hasRenderedHistory &&
      pending.length > 0 &&
      pending.every((message) => message && typeof message === 'object' && message.replay === true)
    ) {
      advanceSdkRoomEventWatermarksFromMessages(chat, pending);
      applyQueuedHelloPrompts(chat);
      return;
    }
    if (pending.length <= 8) {
      for (const message of pending) {
        chat._processSdkSocketMessage?.(message);
      }
      applyQueuedHelloPrompts(chat);
      return;
    }
    void flushPendingSdkRoomEvents(chat, pending).then(() => {
      applyQueuedHelloPrompts(chat);
    });
  }

  function stopGlobalChatPingLoop() {
    if (!chatPingIntervalId) return;
    clearInterval(chatPingIntervalId);
    chatPingIntervalId = null;
  }

  function stopChatBackgroundMonitor() {
    stopDeferredBackgroundSync();
    if (!chatBackgroundMonitorIntervalId) return;
    clearInterval(chatBackgroundMonitorIntervalId);
    chatBackgroundMonitorIntervalId = null;
  }

  function disconnectBackgroundChat(chat) {
    pendingConnectQueue.delete(chat.id);
    if (chat._reconnectTimer) {
      clearTimeout(chat._reconnectTimer);
      chat._reconnectTimer = null;
    }
    if (!chat.ws) {
      chat._connectionStatus = 'disconnected';
      renderChatTerminalState(chat);
      return;
    }
    try {
      chat.ws.onclose = null;
      chat.ws.close();
    } catch (_) {}
    chat.ws = null;
    releaseWsConnectSlot(chat);
    chat._connectionStatus = 'disconnected';
    renderChatTerminalState(chat);
  }

  function syncBackgroundChatConnections() {
    if (isPageCurrentlyHidden()) return;
    const chats = getChats();
    const activeChatId = getActiveChatId();
    const now = Date.now();
    let wsChatIds = selectBackgroundWsChatIds(chats, getActiveChatId, getChatActivityAt, now);
    if (isMobileLikeClient() && now < mobileResumeQuietUntil && activeChatId) {
      wsChatIds = new Set([activeChatId]);
    }
    const monitoredChatIds = selectMonitoredChatIds(chats, getActiveChatId, getChatActivityAt, now);
    let wsCount = 0;
    let pollCount = 0;
    for (const chat of chats) {
      if (!chat?.cursorSessionId) continue;
      chat._backgroundMonitorMode = resolveBackgroundMonitorMode(
        chat,
        wsChatIds,
        monitoredChatIds,
        activeChatId
      );
      if (wsChatIds.has(chat.id)) {
        wsCount += 1;
        enqueueBackgroundChatReconnect(chat);
        continue;
      }
      if (monitoredChatIds.has(chat.id)) pollCount += 1;
      disconnectBackgroundChat(chat);
    }
    appLogger?.log?.('chat-background', 'sync policy applied', {
      wsCount,
      pollCount,
      totalChats: chats.length,
      monitoredCount: monitoredChatIds.size,
    });
  }

  function scheduleBackgroundSyncCoalesced(deferMs = 0) {
    if (deferredBackgroundSyncTimerId != null) {
      clearTimeout(deferredBackgroundSyncTimerId);
      deferredBackgroundSyncTimerId = null;
    }
    if (deferMs <= 0) {
      syncBackgroundChatConnections();
      return;
    }
    appLogger?.log?.('chat-background', 'defer background sync after resume', { deferMs });
    deferredBackgroundSyncTimerId = setTimeout(() => {
      deferredBackgroundSyncTimerId = null;
      syncBackgroundChatConnections();
    }, deferMs);
  }

  function stopDeferredBackgroundSync() {
    if (deferredBackgroundSyncTimerId == null) return;
    clearTimeout(deferredBackgroundSyncTimerId);
    deferredBackgroundSyncTimerId = null;
  }

  function disconnectNonActiveChatsForMobileBackground() {
    if (!isMobileLikeClient()) return;
    const activeChatId = getActiveChatId();
    for (const chat of getChats()) {
      if (!chat?.cursorSessionId || chat.id === activeChatId) continue;
      disconnectBackgroundChat(chat);
    }
  }

  function pauseChatTransportForHiddenPage() {
    stopDeferredBackgroundSync();
    clearBackgroundReconnectQueue();
    clearPendingConnectQueue();
    stopGlobalChatPingLoop();
    stopChatBackgroundMonitor();
    for (const chat of getChats()) {
      clearSdkWsReplayWaitState(chat);
    }
    disconnectNonActiveChatsForMobileBackground();
  }

  function resolveResumeBackgroundSyncDeferMs(wasHidden) {
    if (!wasHidden) return 0;
    return isMobileLikeClient() ? RESUME_BACKGROUND_SYNC_DEFER_MOBILE_MS : RESUME_BACKGROUND_SYNC_DEFER_MS;
  }

  function startGlobalChatPingLoop() {
    stopGlobalChatPingLoop();
    if (!getMaintainSessionsEnabled()) return;
    if (isPageCurrentlyHidden()) return;
    chatPingIntervalId = setInterval(() => {
      if (isPageCurrentlyHidden()) return;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const minPingInterval = hidden ? CHAT_PING_BACKGROUND_INTERVAL_MS : CHAT_PING_INTERVAL_MS;
      const now = Date.now();
      for (const chat of getChats()) {
        if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) continue;
        if (now - (chat._lastPingAt || 0) < minPingInterval) continue;
        const lastPingAt = chat._lastPingAt || 0;
        const lastPongAt = chat._lastPongAt || 0;
        const awaitingPong = lastPingAt > lastPongAt;
        if (awaitingPong && now - lastPingAt > CHAT_STALE_PONG_MS) {
          try {
            chat.ws.close();
          } catch (_) {}
          continue;
        }
        try {
          chat.ws.send(JSON.stringify({ type: 'ping' }));
          chat._lastPingAt = now;
        } catch (_) {}
      }
    }, 1000);
  }

  function startChatBackgroundMonitor(deferInitialSyncMs = 0) {
    stopChatBackgroundMonitor();
    if (!getMaintainSessionsEnabled()) return;
    if (isPageCurrentlyHidden()) return;
    scheduleBackgroundSyncCoalesced(deferInitialSyncMs);
    chatBackgroundMonitorIntervalId = setInterval(() => {
      if (!getMaintainSessionsEnabled()) return;
      if (isPageCurrentlyHidden()) return;
      syncBackgroundChatConnections();
    }, CHAT_BACKGROUND_MONITOR_INTERVAL_MS);
  }

  function bindChatVisibilityAndReconnect() {
    if (visibilityBound || typeof document === 'undefined') return;
    visibilityBound = true;

    const resumeActiveChat = (reason, forceReconnect = false) => {
      const active = getChats().find((chat) => chat.id === getActiveChatId());
      if (!active?.cursorSessionId) return;
      if (isSdkOpenTerminalHydrating(active)) return;
      const backgroundMs = getLastBackgroundDurationMs();
      const wasPageHidden = backgroundMs > 0 || hiddenAt > 0;
      const shouldResumeHistorySync = shouldRunResumeChatHistorySync(
        reason,
        backgroundMs,
        forceReconnect,
        wasPageHidden
      );
      const readyState = active.ws?.readyState;
      if (shouldRecycleActiveChatSocketOnResume(backgroundMs, forceReconnect, readyState)) {
        active._reconnectAttempts = 0;
        if (active._reconnectTimer) {
          clearTimeout(active._reconnectTimer);
          active._reconnectTimer = null;
        }
        if (active.ws) {
          const staleSocket = active.ws;
          staleSocket.onclose = null;
          active.ws = null;
          delete active._wsConnectingSince;
          try {
            staleSocket.close();
          } catch (_) {}
        }
      }
      clearLastBackgroundDurationMs();
      const needsReconnect = !active.ws || active.ws.readyState !== WebSocket.OPEN;
      traceUiFreeze('chat-transport', 'resume-active', {
        chatId: active.id,
        reason,
        forceReconnect,
        backgroundMs,
        needsReconnect,
        readyState,
        hydrating: active._sdkHistoryHydrating === true,
      });
      const connectActiveChat = () => {
        if (!active.ws || active.ws.readyState !== WebSocket.OPEN) {
          if (
            needsReconnect &&
            active._sdkRichView &&
            active._sdkHistoryHydrating !== true &&
            shouldResumeHistorySync
          ) {
            beginSdkHistoryHydration(active);
          }
          ensureChatConnection(active);
          return;
        }
        markChatConnectionHealthy(active);
        try {
          active.ws.send(JSON.stringify({ type: 'ping' }));
        } catch (_) {}
      };
      if (isMobileLikeClient() && needsReconnect && typeof window !== 'undefined') {
        window.setTimeout(connectActiveChat, MOBILE_RESUME_CONNECT_DEFER_MS);
      } else {
        connectActiveChat();
      }
      updateAwaitingInput(active);
      const skipHttpSyncForWsReplay = shouldSkipHttpHistorySyncForMobileWsReplay(
        needsReconnect,
        isMobileLikeClient()
      );
      if (skipHttpSyncForWsReplay) {
        active._sdkAwaitingWsReplay = true;
      }
      const shouldSyncHistory =
        shouldResumeHistorySync &&
        !skipHttpSyncForWsReplay &&
        (needsReconnect ||
          shouldSyncActiveChatHistoryOnResume(backgroundMs, forceReconnect, readyState));
      if (!shouldSyncHistory) {
        if (
          active._sdkHistoryHydrating === true &&
          !skipHttpSyncForWsReplay &&
          !isSdkOpenTerminalHydrating(active)
        ) {
          completeSdkHistoryHydration(active, []);
        }
        return;
      }
      if (typeof onSdkResume !== 'function') return;
      Promise.resolve(onSdkResume(active, { reason })).catch((error) => {
        appLogger.log('chat-sync', 'resume catch-up failed', {
          chatId: active.id,
          reason,
          error: String(error),
        });
      });
    };

    const scheduleResumeActiveChat = (reason, forceReconnect = false) => {
      pendingResumeReason = reason;
      pendingResumeForceReconnect = pendingResumeForceReconnect || forceReconnect;
      if (resumeActiveChatTimerId != null) return;
      resumeActiveChatTimerId = setTimeout(() => {
        resumeActiveChatTimerId = null;
        const nextReason = pendingResumeReason || 'visibility';
        const nextForceReconnect = pendingResumeForceReconnect;
        pendingResumeReason = null;
        pendingResumeForceReconnect = false;
        resumeActiveChat(nextReason, nextForceReconnect);
      }, RESUME_ACTIVE_CHAT_COALESCE_MS);
    };

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        pauseChatTransportForHiddenPage();
        if (resumeActiveChatTimerId != null) {
          clearTimeout(resumeActiveChatTimerId);
          resumeActiveChatTimerId = null;
        }
        pendingResumeReason = null;
        pendingResumeForceReconnect = false;
        return;
      }
      startGlobalChatPingLoop();
      const wasHidden = hiddenAt > 0 || getLastBackgroundDurationMs() > 0;
      hiddenAt = 0;
      if (isMobileLikeClient() && wasHidden) {
        mobileResumeQuietUntil = Date.now() + RESUME_BACKGROUND_WS_QUIET_MOBILE_MS;
      }
      startChatBackgroundMonitor(resolveResumeBackgroundSyncDeferMs(wasHidden));
      if (!wasHidden) return;
      scheduleResumeActiveChat('visibility', false);
    });

    if (typeof window === 'undefined') return;
    window.addEventListener('pageshow', (event) => {
      if (document.hidden) return;
      const wasHidden = hiddenAt > 0 || getLastBackgroundDurationMs() > 0;
      if (!event.persisted && !wasHidden) return;
      scheduleResumeActiveChat('pageshow', event.persisted === true);
    });
    window.addEventListener('online', () => {
      if (document.hidden) return;
      scheduleResumeActiveChat('online', true);
    });
  }

  return {
    ensureChatConnection,
    scheduleChatReconnect,
    syncBackgroundChatConnections,
    bindChatVisibilityAndReconnect,
    startChatBackgroundMonitor,
    startGlobalChatPingLoop,
    stopGlobalChatPingLoop,
    stopChatBackgroundMonitor,
    completeSdkHistoryHydration,
  };
}

