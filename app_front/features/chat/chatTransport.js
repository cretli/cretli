
import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.ts';
import { beginSdkHistoryHydration, finishSdkHistoryHydration, isSdkOpenTerminalHydrating } from './sdkEventReplayGuard.js';

import { traceUiFreeze } from '../../lib/uiFreezeTrace.js';

import { extractSdkRunOutcomeSnapshot, maybeRecoverMissedSdkRunOutcome } from './sdkRunOutcomeRecovery.js';
import { getWidgetAccessToken } from '../../core/api/index.js';
import { clearPushInboxCache } from '../pwa/pushInbox.js';

import { applyChatAuthSessionBoundary } from './chatSessionBoundary.js';
import {
  buildAgentWsUrl,
  buildSocketDiagnostics,
  shouldIgnoreDuplicateCatchUp as shouldIgnoreDuplicateCatchUpFrame,
} from './transport/connection.js';
import { dispatchTodoReconnectEvent } from './transport/events.js';
import { createTransportQueues } from './transport/queue.js';
import { createSocketMessageHandler } from './transport/socketMessages.js';
import {
  REPLAY_BUSY_ASSERTING_TYPES,
  sdkStreamReset,
} from './transport/frameHelpers.js';
import { createResumeState } from './transport/resumption.js';
export { dispatchTodoChangedEvent, dispatchTodoReconnectEvent } from './transport/events.js';
import { t } from '../../i18n/index.js';
import {
  noteReconnectAttempt,
  planChatReconnect,
  recordReconnectOpen,
  resetReconnectState,
} from './chatReconnectScheduler.js';
import { clearLastBackgroundDurationMs, getLastBackgroundDurationMs, isPageCurrentlyHidden } from '../../lib/pageBackgroundGrace.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { notifyChatConnectionRestored } from './chatServerRecovery.js';
import { isClaudeContextMeterChat, resetChatContextMeterState } from './chatContextMeter.js';
import { resolveBackgroundMonitorMode, selectBackgroundWsChatIds, selectMonitoredChatIds, shouldKeepChatSocket } from './chatBackgroundPolicy.js';
import { isBlockingPersistedLocalChatHarnessState } from './persistedLocalChatState.js';
import { MOBILE_WS_REPLAY_DEADLINE_MS, MOBILE_WS_REPLAY_FALLBACK_MS, RESUME_BACKGROUND_WS_QUIET_MOBILE_MS, shouldRecycleActiveChatSocketOnResume, shouldRunResumeChatHistorySync, shouldSkipHttpHistorySyncForMobileWsReplay, shouldSyncActiveChatHistoryOnResume } from './chatResumePolicy.js';
import { CHAT_STALE_PONG_MS, recordPingSent, resolveResumeProbePongTimeoutMs, shouldCloseSocketForResumeProbeTimeout, shouldCloseSocketForStalePong, listChatsNeedingPing, CHAT_PING_LOOP_INTERVAL_MS } from './chatPingPolicy.js';
import { PAGE_RESUME_FINALIZE_MS, PAGE_RESUME_LOG_TAG, buildPageResumeLogPayload, resolvePageResumeStartedAt, createPageResumeTrace, markPageResumeProbeTimeout, markPageResumeStage, setPageResumeDecision } from './pageResumeTrace.js';
import { canOpenChatWebSocketNow, isSdkSetupErrorCoolingDown, resolveBackgroundReconnectBatchDelayMs, resolveBackgroundReconnectBatchSize, resolveSdkSetupErrorRetryMs } from './chatWsReconnectPolicy.js';

import { setChatHistorySyncInFlight, markHistorySyncInFlightForWsReplay } from './chatHistoryConvergence.js';
import { normalizeHarnessTransport } from './sdk-transport-labels.js';

export function createChatTransport(deps) {
  const {
    WS_PATH_AGENT_SDK,
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
    onChatsChanged = null,
    onSidebarLayout = null,
    onAgentPresence = null,
    onNotificationsChanged = null,
    onBackgroundSyncComplete = null,
  } = deps;

  const onSdkModeChange = deps.onSdkModeChange;
  let hiddenAt = 0;

  function syncSdkModeToServer(chat) {
    if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
    chat.ws.send(JSON.stringify({ type: 'setSdkMode', mode: normalizeSdkMode(chat.sdkMode) }));
  }

  function syncSdkSteerComposerUi(chat) {
    if (!chat || (chat.agentTransport !== 'sdk' && chat.agentTransport !== 'claude')) return;
    const sendBar = chat.pane?._sendBar;
    if (!sendBar || typeof sendBar.setPlaceholder !== 'function') return;
    if (chat._sdkSteerSupported === true && chat._sdkServerBusy === true) {
      sendBar.setPlaceholder(t('chat.sdkSteerPlaceholder'));
      return;
    }
    sendBar.setPlaceholder(t('chat.commandPlaceholder'));
  }

  function applySdkRoomCapabilityFields(chat, message) {
    if (!chat || !message || typeof message !== 'object') return;
    if (typeof message.steerSupported === 'boolean') {
      chat._sdkSteerSupported = message.steerSupported;
    }
    if (Number.isFinite(Number(message.backgroundOutstanding))) {
      chat._sdkBackgroundOutstanding = Math.max(0, Number(message.backgroundOutstanding));
    }
    chat._sdkRichView?.setBackgroundWorkOutstanding?.(chat._sdkBackgroundOutstanding);
    syncSdkSteerComposerUi(chat);
  }

  function requestActiveSdkWarmup(chat) {
    // A blocked persisted local chat has no SDK runtime: never warm it up, even if a
    // stale socket reference survives a transition.
    if (!chat || isBlockingPersistedLocalChatHarnessState(chat)) return;
    if (chat.id !== getActiveChatId()) return;
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

  /**
   * @param {Record<string, unknown> | null | undefined} msg
   * @returns {{ historySeq: number, roomEventSeq: number, eventStreamId: string }}
   */
  function readSdkViewOrderMeta(msg) {
    const eventStreamId = typeof msg?.eventStreamId === 'string' ? msg.eventStreamId.trim() : '';
    return {
      historySeq: Number(msg?.historySeq) || 0,
      roomEventSeq: Number(msg?.roomEventSeq) || 0,
      eventStreamId,
    };
  }

  function markChatConnectionHealthy(chat) {
    if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
    notifyChatConnectionRestored(chat);
  }

  /**
   * Emit the single 'page-resume' log entry for the current active-chat return.
   *
   * @param {object | null | undefined} chat
   * @param {string} completedBy
   */
  function finalizePageResumeTrace(chat, completedBy) {
    const trace = chat?._pageResumeTrace;
    if (!trace || trace.logged === true) return;
    trace.logged = true;
    if (chat._pageResumeFinalizeTimer != null) {
      clearTimeout(chat._pageResumeFinalizeTimer);
      delete chat._pageResumeFinalizeTimer;
    }
    appLogger.log(PAGE_RESUME_LOG_TAG, 'resume timings', buildPageResumeLogPayload(trace, completedBy));
    delete chat._pageResumeTrace;
  }

  /**
   * Start a new trace, flushing an unfinished one from a previous return.
   *
   * @param {object} chat
   * @param {{ reason: string, backgroundMs: number, readyState: number | undefined }} input
   * @returns {object}
   */
  function beginPageResumeTrace(chat, input) {
    if (chat._pageResumeTrace) finalizePageResumeTrace(chat, 'superseded');
    const trace = createPageResumeTrace({
      chatId: chat.id,
      reason: input.reason,
      backgroundMs: input.backgroundMs,
      mobile: isMobileLikeClient(),
      readyState: input.readyState,
      notification:
        input.notification === true || String(input.reason || '').trim() === 'notification',
      startedAt: resolvePageResumeStartedAt({ firstEventAt: input.firstEventAt, now: Date.now() }),
    });
    chat._pageResumeTrace = trace;
    if (chat._pageResumeFinalizeTimer != null) clearTimeout(chat._pageResumeFinalizeTimer);
    chat._pageResumeFinalizeTimer = setTimeout(() => {
      finalizePageResumeTrace(chat, 'deadline');
    }, PAGE_RESUME_FINALIZE_MS);
    return trace;
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
    const previousModel = String(chat.model || '').trim();
    if (isClaudeContextMeterChat(chat) && previousModel && previousModel !== nextModel) {
      resetChatContextMeterState(chat, { reason: 'model_change' });
    }
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
  /** @type {Set<object>} */
  const openPingChats = new Set();
  let chatBackgroundMonitorIntervalId = null;
  let visibilityBound = false;
  const CHAT_PING_BACKGROUND_INTERVAL_MS = 60000;
  const CHAT_BACKGROUND_MONITOR_INTERVAL_MS = 12000;
  const CHAT_CATCHUP_DEDUP_MS = 15000;
  const RESUME_BACKGROUND_SYNC_DEFER_MS = 4500;
  const RESUME_BACKGROUND_SYNC_DEFER_MOBILE_MS = 8000;
  // Active-chat resume connects immediately; this only coalesces the
  // visibilitychange/pageshow pair that fires together on return.
  const RESUME_ACTIVE_CHAT_COALESCE_MS = 50;
  let activeWsConnectCount = 0;
  /** @type {any} */
  const transportQueues = createTransportQueues();
  const pendingConnectQueue = transportQueues.pendingConnect;
  /** @type {any} */
  const resumeState = createResumeState();
  /** @type {Map<string, object>} */
  const backgroundReconnectQueue = transportQueues.backgroundReconnect;
  let deferredBackgroundSyncTimerId = null;
  let mobileResumeQuietUntil = 0;
  /** @type {Map<string, number>} */
  const lastRoomStateGapSyncAt = new Map();

  function clearSdkWsReplayWaitState(chat) {
    if (!chat || typeof chat !== 'object') return;
    delete chat._sdkAwaitingWsReplay;
    delete chat._sdkReplayWaitStartedAt;
    if (chat._sdkReplayFallbackTimer != null) {
      clearTimeout(chat._sdkReplayFallbackTimer);
      delete chat._sdkReplayFallbackTimer;
    }
  }

  function completePageResumeAfterCatchUp(chat) {
    if (!chat?._pageResumeTrace) return;
    markPageResumeStage(chat._pageResumeTrace, 'catchUp');
    markPageResumeStage(chat._pageResumeTrace, 'uiReady');
    finalizePageResumeTrace(chat, 'catch_up_complete');
  }

  function requestHttpCatchUpAfterReplay(chat, reason) {
    if (typeof onSdkResume !== 'function') {
      if (chat._sdkHistoryHydrating === true && !isSdkOpenTerminalHydrating(chat)) {
        completeSdkHistoryHydration(chat, []);
      }
      return;
    }
    Promise.resolve(onSdkResume(chat, { reason }))
      .then(() => completePageResumeAfterCatchUp(chat))
      .catch(() => {});
  }

  function fireSdkWsReplayFallback(chat) {
    if (!chat) return;
    delete chat._sdkReplayFallbackTimer;
    const startedAt = Number(chat._sdkReplayWaitStartedAt) || 0;
    const now = Date.now();
    const withinDeadline =
      startedAt > 0 && now - startedAt < MOBILE_WS_REPLAY_DEADLINE_MS;
    if (chat._sdkReplayBatchActive === true && withinDeadline) {
      scheduleSdkWsReplayFallback(chat, true);
      return;
    }
    delete chat._sdkAwaitingWsReplay;
    requestHttpCatchUpAfterReplay(chat, 'replay_fallback');
  }

  function scheduleSdkWsReplayFallback(chat, force = false) {
    if (!chat || chat._sdkAwaitingWsReplay !== true) return;
    if (chat._sdkReplayFallbackTimer != null && force !== true) return;
    if (chat._sdkReplayFallbackTimer != null) {
      clearTimeout(chat._sdkReplayFallbackTimer);
    }
    if (!Number.isFinite(chat._sdkReplayWaitStartedAt)) {
      chat._sdkReplayWaitStartedAt = Date.now();
    }
    chat._sdkReplayFallbackTimer = setTimeout(() => {
      fireSdkWsReplayFallback(chat);
    }, MOBILE_WS_REPLAY_FALLBACK_MS);
  }

  function detachChatSocket(socket) {
    if (!socket) return;
    socket.onmessage = null;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  function bumpChatSocketGeneration(chat) {
    chat._wsGeneration = (Number(chat._wsGeneration) || 0) + 1;
    return chat._wsGeneration;
  }

  function applyPingState(chat, next) {
    chat._lastPingAt = next.lastPingAt;
    chat._unackedPingAt = next.unackedPingAt;
  }

  function applyPongState(chat, next) {
    chat._lastPongAt = next.lastPongAt;
    chat._unackedPingAt = next.unackedPingAt;
    chat._awaitingResumeProbePong = next.awaitingResumeProbePong;
    if (chat._resumeProbeTimer != null) {
      clearTimeout(chat._resumeProbeTimer);
      delete chat._resumeProbeTimer;
    }
    delete chat._resumeProbeAt;
    delete chat._resumeProbeGeneration;
  }

  function sendChatPing(chat) {
    if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return false;
    try {
      chat.ws.send(JSON.stringify({ type: 'ping' }));
    } catch (_) {
      return false;
    }
    const next = recordPingSent({
      unackedPingAt: chat._unackedPingAt,
      lastPingAt: chat._lastPingAt,
      lastPongAt: chat._lastPongAt,
      sentAt: Date.now(),
    });
    applyPingState(chat, next);
    return true;
  }

  function startResumeSocketProbe(chat) {
    if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
    chat._awaitingResumeProbePong = true;
    chat._resumeProbeAt = Date.now();
    chat._resumeProbeGeneration = chat._wsGeneration || 0;
    const probeTimeoutMs = resolveResumeProbePongTimeoutMs(isMobileLikeClient());
    markPageResumeStage(chat._pageResumeTrace, 'probeSent');
    sendChatPing(chat);
    if (chat._resumeProbeTimer != null) clearTimeout(chat._resumeProbeTimer);
    const generation = chat._resumeProbeGeneration;
    chat._resumeProbeTimer = setTimeout(() => {
      delete chat._resumeProbeTimer;
      if (
        shouldCloseSocketForResumeProbeTimeout({
          awaitingResumeProbePong: chat._awaitingResumeProbePong === true,
          resumeProbeAt: chat._resumeProbeAt,
          now: Date.now(),
          probeTimeoutMs,
          socketGeneration: chat._wsGeneration,
          probeGeneration: generation,
        })
      ) {
        markPageResumeProbeTimeout(chat._pageResumeTrace);
        // A suspended socket's close handshake can hang until the browser's
        // closing timeout, so do not wait for onclose: detach it and reconnect now.
        const deadSocket = chat.ws;
        detachChatSocket(deadSocket);
        chat.ws = null;
        delete chat._wsConnectingSince;
        openPingChats.delete(chat);
        releaseWsConnectSlot(chat);
        try {
          deadSocket?.close();
        } catch (_) {}
        chat._reconnectAttempts = 0;
        if (chat._reconnectTimer) {
          clearTimeout(chat._reconnectTimer);
          chat._reconnectTimer = null;
        }
        if (!isPageCurrentlyHidden()) ensureChatConnection(chat);
      }
    }, probeTimeoutMs);
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
    if (transportQueues.pendingConnectDrainTimerId != null) return;
    transportQueues.pendingConnectDrainTimerId = setTimeout(() => {
      transportQueues.pendingConnectDrainTimerId = null;
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
      if (isBlockingPersistedLocalChatHarnessState(chat)) {
        teardownBlockedChatRuntime(chat);
        continue;
      }
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
    if (transportQueues.pendingConnectDrainTimerId == null) return;
    clearTimeout(transportQueues.pendingConnectDrainTimerId);
    transportQueues.pendingConnectDrainTimerId = null;
  }

  function clearBackgroundReconnectQueue() {
    backgroundReconnectQueue.clear();
    if (transportQueues.backgroundReconnectTimerId == null) return;
    clearTimeout(transportQueues.backgroundReconnectTimerId);
    transportQueues.backgroundReconnectTimerId = null;
  }

  function drainBackgroundReconnectQueue() {
    transportQueues.backgroundReconnectTimerId = null;
    if (backgroundReconnectQueue.size === 0) return;
    const batchSize = resolveBackgroundReconnectBatchSize(isMobileResumeQuietPeriod());
    const batchDelay = resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod());
    const batch = Array.from(backgroundReconnectQueue.values()).slice(0, batchSize);
    for (const chat of batch) {
      backgroundReconnectQueue.delete(chat.id);
      if (isBlockingPersistedLocalChatHarnessState(chat)) {
        teardownBlockedChatRuntime(chat);
        continue;
      }
      ensureChatConnection(chat);
      requestActiveSdkWarmup(chat);
    }
    if (backgroundReconnectQueue.size > 0) {
      transportQueues.backgroundReconnectTimerId = setTimeout(drainBackgroundReconnectQueue, batchDelay);
    }
  }

  function enqueueBackgroundChatReconnect(chat) {
    // Never queue or warm up a blocked persisted local chat. This is the path a
    // `skipAutoSelect` list refresh reaches through `syncBackgroundChatConnections`, so a
    // chat that turned blocking while a socket/pane was already live must be torn down
    // here instead of only dropping its queue entry.
    if (isBlockingPersistedLocalChatHarnessState(chat)) {
      teardownBlockedChatRuntime(chat);
      return;
    }
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
    if (transportQueues.backgroundReconnectTimerId != null) return;
    transportQueues.backgroundReconnectTimerId = setTimeout(
      drainBackgroundReconnectQueue,
      resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod())
    );
  }

  function handleBackgroundAgentWsOutput(chat, msg) {
    if (!msg || msg.type !== 'output' || msg.data == null) return;
    if (msg.catchUp && getSkipCatchUpOnResume()) return;
    if (msg.catchUp) {
      if (shouldIgnoreDuplicateCatchUpFrame(chat, msg.data, buildCatchUpSignature, CHAT_CATCHUP_DEDUP_MS)) return;
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

  /**
   * The server rejected the handshake with a setup error (missing API key/CLI): wait the
   * growing cooldown instead of the 1 s reconnect backoff, then try one handshake again.
   */
  function scheduleSdkSetupErrorRetry(chat) {
    stopChatReconnect(chat);
    chat._connectionStatus = 'disconnected';
    if (chat.id === getActiveChatId()) setChatStatus('disconnected');
    renderChatTerminalState(chat);
    const elapsed = Date.now() - (Number(chat._sdkSetupErrorAt) || 0);
    const delay = Math.max(1000, resolveSdkSetupErrorRetryMs(chat._sdkSetupErrorCount || 1) - elapsed);
    appLogger.log('chat-ws', 'setup error retry scheduled', {
      chatId: chat.id,
      code: chat._sdkSetupErrorCode || null,
      delayMs: delay,
      count: chat._sdkSetupErrorCount || 1,
    });
    chat._reconnectTimer = setTimeout(() => {
      chat._reconnectTimer = null;
      ensureChatConnection(chat);
    }, delay);
  }

  function scheduleChatReconnect(chat) {
    // A persisted local chat whose plugin is missing/disabled/incompatible must never
    // schedule an SDK WebSocket retry, including background recovery.
    if (isBlockingPersistedLocalChatHarnessState(chat)) {
      stopChatReconnect(chat);
      return;
    }
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
    const now = Date.now();
    const plan = planChatReconnect(chat, now);
    // An open breaker keeps retrying (long pause) for background chats too.
    chat._connectionStatus = 'reconnecting';
    if (chat.id === getActiveChatId()) setChatStatus('reconnecting');
    renderChatTerminalState(chat);
    if (plan.notifyBreaker) {
      chat._sdkRichView?.appendMetaNotice?.(t('chat.reconnectBreakerNotice'), { silent: true });
      if (typeof onConnectionLost === 'function') {
        onConnectionLost(chat, { reason: 'reconnect_exhausted' });
      }
    }
    const delay = plan.delayMs;
    noteReconnectAttempt(chat._reconnectSchedule, now + delay);
    appLogger.log('chat-ws', 'reconnect scheduled', {
      chatId: chat.id,
      delayMs: delay,
      attempt: chat._reconnectAttempts,
      breakerOpen: plan.breakerOpen,
      ...buildSocketDiagnostics(chat),
    });
    chat._reconnectTimer = setTimeout(() => {
      chat._reconnectTimer = null;
      ensureChatConnection(chat);
    }, delay);
  }

  /**
   * Drop every live SDK resource for a persisted local chat that became blocked: an open
   * or connecting socket, reconnect timers, queued connect/reconnect entries, ping/replay
   * waiters, and the connect slot. The chat stays visible through the blocked pane.
   *
   * @param {object | null | undefined} chat
   */
  function teardownBlockedChatRuntime(chat) {
    if (!chat || typeof chat !== 'object') return;
    stopChatReconnect(chat);
    pendingConnectQueue.delete(chat.id);
    backgroundReconnectQueue.delete(chat.id);
    openPingChats.delete(chat);
    if (chat._resumeProbeTimer != null) {
      clearTimeout(chat._resumeProbeTimer);
      delete chat._resumeProbeTimer;
    }
    clearSdkWsReplayWaitState(chat);
    const socket = chat.ws;
    chat.ws = null;
    if (socket) {
      detachChatSocket(socket);
      try {
        socket.close();
      } catch (_) {}
      releaseWsConnectSlot(chat);
    }
    chat._connectionStatus = 'disconnected';
    if (chat.id === getActiveChatId()) setChatStatus('disconnected');
  }

  function ensureChatConnection(chat) {
    // Blocked persisted local chats have no usable SDK runtime: never open a socket
    // (auto-select, recovery, or background), never leave a reconnect timer armed, and
    // cleanly detach/close any socket that was already open before the state blocked.
    if (isBlockingPersistedLocalChatHarnessState(chat)) {
      teardownBlockedChatRuntime(chat);
      renderChatTerminalState(chat);
      return;
    }
    if (!shouldKeepChatSocket(chat, getChats())) return;
    if (!chat?.cursorSessionId) return;
    if (isSdkSetupErrorCoolingDown(chat)) {
      if (!chat._reconnectTimer) scheduleSdkSetupErrorRetry(chat);
      return;
    }
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
        detachChatSocket(chat.ws);
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
      url: buildAgentWsUrl(chat, WS_PATH_AGENT_SDK),
      ...buildSocketDiagnostics(chat),
    });
    const widgetAccessToken = getWidgetAccessToken();
    const socket = widgetAccessToken
      ? new WebSocket(buildAgentWsUrl(chat, WS_PATH_AGENT_SDK), ['cretli-widget', widgetAccessToken])
      : new WebSocket(buildAgentWsUrl(chat, WS_PATH_AGENT_SDK));
    socket.onmessage = createSocketMessageHandler(chat, socket, {
      appendSdkQueuedPromptLine,
      appendSdkTermChunk,
      appendSdkUserPromptLine,
      appendTransportNotice,
      appLogger,
      applyPongState,
      applySdkModeFromServer,
      applySdkRoomCapabilityFields,
      clearSdkWsReplayWaitState,
      completeSdkHistoryHydration,
      confirmPendingModelChange,
      consumeOptimisticSdkPrompt,
      consumeOptimisticSdkQueuedPrompt,
      extractModelIdFromLaunchCommandLine,
      finalizePageResumeTrace,
      flushSdkStructuredHistoryNow,
      formatDurationSeconds,
      handleBackgroundAgentWsOutput,
      handleRemoteChatGone,
      lastRoomStateGapSyncAt,
      logSdkVerbose,
      markChatConnectionHealthy,
      onAgentPresence,
      onChatsChanged,
      onNotificationsChanged,
      onSdkInvalidSession,
      onSdkModeChange,
      onSdkResume,
      onSdkRunFinished,
      onSidebarLayout,
      promoteSdkQueuedPromptLine,
      readSdkViewOrderMeta,
      recoverMissedSdkRunOutcomeFromMessage,
      removeSdkQueuedPromptLine,
      renderChatTerminalState,
      requestActiveSdkWarmup,
      requestHttpCatchUpAfterReplay,
      scheduleSdkWsReplayFallback,
      setAgentState,
      setLaunchCommand,
      shouldHandleSdkRunFinished,
      shouldIgnoreStaleServerSdkMode,
      stopChatReconnect,
      syncSdkModeToServer,
    });
    // In-process re-entry hands over the object; `data` is serialized lazily.
    const dispatchParsedFrame = (message) => socket.onmessage({ parsed: message, get data() { return JSON.stringify(message); } });
    chat._processSdkSocketMessage = (message) => {
      if (chat.ws !== socket || typeof socket.onmessage !== 'function') return;
      const isBusyReplay = message?.replay === true && REPLAY_BUSY_ASSERTING_TYPES.has(message.type);
      if (!isBusyReplay) {
        dispatchParsedFrame(message);
        return;
      }
      // A replayed event describes a past run. Its handler flips the chat to
      // "working", which would flash the sidebar status when a finished chat is
      // opened. The live hello / room state / sdkBusy frames own the busy flag.
      const prev = {
        busy: chat._sdkServerBusy,
        queued: chat._sdkServerQueuedCount,
        agentState: chat._agentState,
      };
      dispatchParsedFrame(message);
      chat._sdkServerBusy = prev.busy;
      chat._sdkServerQueuedCount = prev.queued;
      if (chat._agentState !== prev.agentState) setAgentState(chat, prev.agentState || 'idle');
    };
    chat._flushPendingSdkRoomEvents = (pending) => flushPendingSdkRoomEvents(chat, pending);
    socket.onclose = (event) => {
      delete chat._wsConnectingSince;
      openPingChats.delete(chat);
      appLogger.log('chat-ws', 'socket closed', {
        chatId: chat.id,
        code: event?.code,
        reason: event?.reason || '',
        wasClean: !!event?.wasClean,
        ...buildSocketDiagnostics(chat),
      });
      if (event?.code === 4401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
        void applyChatAuthSessionBoundary({ reason: '4401' }).finally(() => {
          void clearPushInboxCache();
          const currentPath = `${window.location.pathname || '/'}${window.location.search || ''}`;
          const shouldDropNext = currentPath === '/login' || currentPath.startsWith('/login?');
          const next = encodeURIComponent(shouldDropNext ? '/' : currentPath);
          window.location.replace(`/login?next=${next}`);
        });
        return;
      }
      chat.ws = null;
      releaseWsConnectSlot(chat);
      if (chat._remoteDeleted === true) {
        chat._connectionStatus = 'disconnected';
        return;
      }
      if (isSdkSetupErrorCoolingDown(chat)) {
        scheduleSdkSetupErrorRetry(chat);
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
      // scheduleChatReconnect repaints its proceed paths, but its guard-returns (maintain
      // sessions off, socket not kept, blocking harness) leave the row stale. Repaint this
      // row directly; for a background chat renderChatTerminalState schedules only [chat.id].
      renderChatTerminalState(chat);
    };
    socket.onopen = () => {
      delete chat._wsConnectingSince;
      const reconnected = (chat._reconnectAttempts || 0) > 0 || chat._connectionStatus === 'reconnecting';
      if (reconnected) dispatchTodoReconnectEvent();
      // Attempts are not zeroed here: the schedule resets only after a connection that lasts >= 30 s.
      if (chat._reconnectSchedule) recordReconnectOpen(chat._reconnectSchedule, Date.now());
      if (!reconnected) chat._reconnectAttempts = 0;
      chat._lastPongAt = Date.now();
      chat._lastPingAt = 0;
      chat._unackedPingAt = 0;
      chat._awaitingResumeProbePong = false;
      chat._connectionStatus = 'connected';
      markPageResumeStage(chat._pageResumeTrace, 'wsOpen');
      appLogger.log('chat-ws', 'socket opened', {
        chatId: chat.id,
        ...buildSocketDiagnostics(chat),
      });
      if (chat.id === getActiveChatId()) setChatStatus('connected');
      if (chat._sdkRichView) {
        if (chat._sdkHistoryHydrating !== true) {
          sdkStreamReset(chat);
          // A retry after a setup error usually hits the same error again; skip the banner.
          if (!chat._sdkSetupErrorAt && !reconnected) chat._sdkRichView.appendBannerConnected({
              transport: normalizeHarnessTransport(chat?.agentTransport),
            });
        }
      }
      startGlobalChatPingLoop();
      markChatConnectionHealthy(chat);
      openPingChats.add(chat);
    };
    chat._wsConnectingSince = Date.now();
    bumpChatSocketGeneration(chat);
    chat.ws = socket;
  }

  function completeSdkHistoryHydration(chat, records) {
    if (!chat || typeof chat !== 'object') return;
    const pending = finishSdkHistoryHydration(chat, records);
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
    openPingChats.delete(chat);
    if (chat._reconnectTimer) {
      clearTimeout(chat._reconnectTimer);
      chat._reconnectTimer = null;
    }
    if (!chat.ws) {
      if (chat._connectionStatus !== 'disconnected') {
        chat._connectionStatus = 'disconnected';
      }
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
    // The sidebar row folds the monitor mode into its status (chatExpectsLiveSocket and
    // applySidebarConnectionPolicy), so a mode flip changes the displayed row. Collect only
    // the chats whose mode or connection actually moved. The ws chats get repainted through
    // the socket handlers -> renderChatTerminalState, but disconnectBackgroundChat's no-socket
    // branch flips _connectionStatus WITHOUT a render, so those ids must be captured here too.
    const dirtyBackgroundIds = [];
    for (const chat of chats) {
      if (!chat?.cursorSessionId) continue;
      const prevMode = chat._backgroundMonitorMode;
      const prevConnection = chat._connectionStatus;
      chat._backgroundMonitorMode = resolveBackgroundMonitorMode(
        chat,
        wsChatIds,
        monitoredChatIds,
        activeChatId
      );
      if (wsChatIds.has(chat.id)) {
        wsCount += 1;
        enqueueBackgroundChatReconnect(chat);
      } else {
        if (monitoredChatIds.has(chat.id)) pollCount += 1;
        disconnectBackgroundChat(chat);
      }
      if ((chat._backgroundMonitorMode !== prevMode || chat._connectionStatus !== prevConnection)
        && chat.id) {
        dirtyBackgroundIds.push(chat.id);
      }
    }
    if (typeof onBackgroundSyncComplete === 'function') onBackgroundSyncComplete(dirtyBackgroundIds);
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
      setChatHistorySyncInFlight(chat, false, renderChatTerminalState);
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
      if (typeof document !== 'undefined' && document.hidden) return;
      if (openPingChats.size === 0) return;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const minPingInterval = hidden ? CHAT_PING_BACKGROUND_INTERVAL_MS : CHAT_PING_INTERVAL_MS;
      const now = Date.now();
      for (const chat of listChatsNeedingPing(openPingChats, now, minPingInterval)) {
        if (
          shouldCloseSocketForStalePong({
            unackedPingAt: chat._unackedPingAt,
            lastPingAt: chat._lastPingAt,
            lastPongAt: chat._lastPongAt,
            now,
            staleMs: CHAT_STALE_PONG_MS,
          })
        ) {
          try {
            chat.ws.close();
          } catch (_) {}
          continue;
        }
        sendChatPing(chat);
      }
    }, CHAT_PING_LOOP_INTERVAL_MS);
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

  function resumeActiveChat(reason, forceReconnect = false, traceOptions = {}) {
    const active = getChats().find((chat) => chat.id === getActiveChatId());
    if (!active?.cursorSessionId) return;
    // A blocked persisted local chat must not resume SDK history sync or probing.
    if (isBlockingPersistedLocalChatHarnessState(active)) return;
    if (isSdkOpenTerminalHydrating(active)) return;
    const backgroundMs = getLastBackgroundDurationMs();
    const wasPageHidden = backgroundMs > 0 || hiddenAt > 0;
    const shouldResumeHistorySync = shouldRunResumeChatHistorySync(
      reason,
      backgroundMs,
      forceReconnect,
      wasPageHidden
    );
    const isMobileLike = isMobileLikeClient();
    // readyState is captured before any recycle so the log shows what the app saw.
    const readyState = active.ws?.readyState;
    const trace = beginPageResumeTrace(active, {
      reason,
      backgroundMs,
      readyState,
      firstEventAt: traceOptions?.firstEventAt,
      notification: traceOptions?.notification === true,
    });
    // The pane may already show cached history when the page comes back; timestamp it at
    // trace start so `cachedRender` (and totalMs) reflects the visible-content baseline.
    if (active._sdkRichView?.hasRenderedHistory?.()) {
      markPageResumeStage(trace, 'cachedRender');
    }
    if (
      shouldRecycleActiveChatSocketOnResume(
        backgroundMs,
        forceReconnect,
        readyState,
        isMobileLike
      )
    ) {
      active._reconnectAttempts = 0;
      if (active._reconnectTimer) {
        clearTimeout(active._reconnectTimer);
        active._reconnectTimer = null;
      }
      if (active.ws) {
        const staleSocket = active.ws;
        detachChatSocket(staleSocket);
        active.ws = null;
        delete active._wsConnectingSince;
        try {
          staleSocket.close();
        } catch (_) {}
      }
      setPageResumeDecision(trace, 'recycle');
      markPageResumeStage(trace, 'decision');
    }
    clearLastBackgroundDurationMs();
    const needsReconnect = !active.ws || active.ws.readyState !== WebSocket.OPEN;
    if (trace && trace.decision === 'unknown') {
      setPageResumeDecision(trace, needsReconnect ? 'reconnect' : 'probe');
      markPageResumeStage(trace, 'decision');
    }
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
      startResumeSocketProbe(active);
    };
    // Active chat connects immediately: the short coalescing window above already
    // merged visibilitychange/pageshow. Background chats keep their own quiet
    // period (RESUME_BACKGROUND_WS_QUIET_MOBILE_MS) in the background monitor.
    connectActiveChat();
    updateAwaitingInput(active);
    const skipHttpSyncForWsReplay = shouldSkipHttpHistorySyncForMobileWsReplay(
      needsReconnect,
      isMobileLike
    );
    if (skipHttpSyncForWsReplay) {
      active._sdkAwaitingWsReplay = true;
      if (!Number.isFinite(active._sdkReplayWaitStartedAt)) {
        active._sdkReplayWaitStartedAt = Date.now();
      }
      markHistorySyncInFlightForWsReplay(active, true, renderChatTerminalState);
      scheduleSdkWsReplayFallback(active);
    }
    const shouldSyncHistory =
      shouldResumeHistorySync &&
      !skipHttpSyncForWsReplay &&
      (needsReconnect ||
        shouldSyncActiveChatHistoryOnResume(backgroundMs, forceReconnect, readyState));
    if (trace) {
      trace.expectsCatchUp = skipHttpSyncForWsReplay || shouldSyncHistory;
    }
    if (!shouldSyncHistory) {
      if (
        active._sdkHistoryHydrating === true &&
        !skipHttpSyncForWsReplay &&
        !isSdkOpenTerminalHydrating(active)
      ) {
        completeSdkHistoryHydration(active, []);
      }
      // The trace closes on the resume-probe pong or the finalize deadline.
      return;
    }
    if (typeof onSdkResume !== 'function') {
      completePageResumeAfterCatchUp(active);
      return;
    }
    Promise.resolve(onSdkResume(active, { reason }))
      .then(() => completePageResumeAfterCatchUp(active))
      .catch((error) => {
        appLogger.log('chat-sync', 'resume catch-up failed', {
          chatId: active.id,
          reason,
          error: String(error),
        });
        finalizePageResumeTrace(active, 'catch_up_failed');
      });
  }

  function scheduleResumeActiveChat(reason, forceReconnect = false) {
    resumeState.reason = reason;
    resumeState.forceReconnect = resumeState.forceReconnect || forceReconnect;
    if (resumeState.firstEventAt == null) resumeState.firstEventAt = Date.now();
    if (reason === 'notification') resumeState.notification = true;
    if (resumeState.timerId != null) return;
    resumeState.timerId = setTimeout(() => {
      resumeState.timerId = null;
      const nextReason = resumeState.reason || 'visibility';
      const nextForceReconnect = resumeState.forceReconnect;
      const firstEventAt = resumeState.firstEventAt;
      const notification = resumeState.notification;
      resumeState.reason = null;
      resumeState.forceReconnect = false;
      resumeState.firstEventAt = null;
      resumeState.notification = false;
      resumeActiveChat(nextReason, nextForceReconnect, { firstEventAt, notification });
    }, RESUME_ACTIVE_CHAT_COALESCE_MS);
  }

  function bindChatVisibilityAndReconnect() {
    if (visibilityBound || typeof document === 'undefined') return;
    visibilityBound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        pauseChatTransportForHiddenPage();
        if (resumeState.timerId != null) {
          clearTimeout(resumeState.timerId);
          resumeState.timerId = null;
        }
        resumeState.reason = null;
        resumeState.forceReconnect = false;
        resumeState.firstEventAt = null;
        resumeState.notification = false;
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
    teardownBlockedChatRuntime,
    scheduleChatReconnect,
    syncBackgroundChatConnections,
    bindChatVisibilityAndReconnect,
    scheduleResumeActiveChat,
    startChatBackgroundMonitor,
    startGlobalChatPingLoop,
    stopGlobalChatPingLoop,
    stopChatBackgroundMonitor,
    completeSdkHistoryHydration,
  };
}
