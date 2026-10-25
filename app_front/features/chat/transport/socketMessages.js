import { getSdkEventTerminalChunk } from '../../../lib/sdk-chat-format.js';
import { normalizeSdkMode, parseExplicitSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { bufferSdkRoomEventDuringHydration, isSdkOpenTerminalHydrating, isServerAuthoredHistoryMeta, noteRenderedSdkRoomEvent, rememberUnrenderedSdkRoomEvent, shouldApplySdkRoomEvent, syncSdkEventStream } from '../sdkEventReplayGuard.js';
import { bufferLiveEventDuringHistoryReplay } from '../chatHistoryHydrationLive.js';
import { isUiFreezeTraceActive, traceUiFreeze, traceUiFreezeWs } from '../../../lib/uiFreezeTrace.js';
import { measureSpan } from '../../../lib/chatPerfBudget.js';
import { getUiFreezeMetrics, presenceFrameReason } from '../../sidebar/sidebarRenderMetrics.js';
import { resolveAgentStateFromMessage } from '../sdkStateResolver.js';
import { isSdkChatGoneErrorCode } from '../../../../lib/sdk/sdk-ws-chat-gone.ts';
import { resolveAgentStateFromRoomState, shouldSyncHistoryFromRoomState } from '../../../../lib/sdk/sdk-room-state.ts';
import { dispatchTodoChangedEvent } from './events.js';
import { t } from '../../../i18n/index.js';
import { applyClaudeMeasuredContextUsage, applyClaudeContextBreakdown, applyCodexMeasuredContextUsage, applyServerContextOccupancy, isClaudeContextMeterChat, resetChatContextMeterState } from '../chatContextMeter.js';
import { ROOM_STATE_GAP_SYNC_COOLDOWN_MS, shouldHttpCatchUpAfterWsReplay } from '../chatResumePolicy.js';
import { recordPongReceived, shouldMarkResumeSocketHealthy } from '../chatPingPolicy.js';
import { markPageResumeStage, notePageResumeFirstMessage } from '../pageResumeTrace.js';
import { isSdkSetupErrorCode } from '../chatWsReconnectPolicy.js';
import { applyLiveServerHistoryCards } from '../chatHistoryViewApply.js';
import { noteServerHistoryIdentity } from '../../../lib/sdk-chat-history-store.js';
import { clearHistorySyncInFlightAfterWsReplay } from '../chatHistoryConvergence.js';
import { buildHarnessLaunchLabel, isHarnessHelloTransport, resolveHarnessDisplayLabel, resolveHarnessModeLabel } from '../sdk-transport-labels.js';
import {
  noteInAppSignalIfLive,
  resolveSdkRunFailureNotice,
  sdkStreamReset,
} from './frameHelpers.js';

/**
 * Build the `socket.onmessage` handler for one chat socket. The handler is the
 * frame dispatcher: it routes every server frame to the chat state, the
 * history replay guards and the host callbacks. `ctx` carries the
 * transport-scoped helpers that live in the `createChatTransport` closure.
 *
 * @param {any} chat
 * @param {WebSocket} socket
 * @param {Record<string, any>} ctx
 * @returns {(ev: { data: string }) => void}
 */
export function createSocketMessageHandler(chat, socket, ctx) {
  const {
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
  } = ctx;
  return (ev) => {
    let messageType = 'unknown';
    /** @type {Record<string, unknown> | undefined} */
    let msg;
    try {
      msg = JSON.parse(ev.data);
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
        // Presence-frame baseline (requirement 4a/4c). Guarded here at the callsite.
        // chat.id is the socket discriminator: each chat's agent socket re-delivers
        // the same shared bus seq, so a repeat of one seq across chat ids is a dup.
        if (msg.type === 'agentPresence') {
          getUiFreezeMetrics()?.recordPresenceFrame({
            reason: presenceFrameReason(msg),
            seq: msg.seq,
            socketId: chat.id,
          });
        }
      }
      notePageResumeFirstMessage(chat._pageResumeTrace, messageType);
      if (msg.type === 'sdkTtft' && !Number.isFinite(msg.clientReceivedAt)) {
        msg.clientReceivedAt = Date.now();
      }
      if (msg.type === 'pong') {
        applyPongState(chat, recordPongReceived(Date.now()));
        if (shouldMarkResumeSocketHealthy({
          awaitingResumeProbePong: chat._awaitingResumeProbePong === true,
        })) {
          markChatConnectionHealthy(chat);
        }
        if (chat._pageResumeTrace && chat._pageResumeTrace.expectsCatchUp !== true) {
          markPageResumeStage(chat._pageResumeTrace, 'uiReady');
          finalizePageResumeTrace(chat, 'probe_pong');
        }
        return;
      }
      if (msg.type === 'chatsChanged') {
        if (typeof onChatsChanged === 'function') onChatsChanged(msg);
        return;
      }
      if (msg.type === 'todosChanged') {
        // Server-owned `todo.review` snapshot changed: hand the Todo panel a
        // DOM event on the existing socket, no new channel.
        dispatchTodoChangedEvent(msg);
        return;
      }
      if (msg.type === 'sidebarLayout') {
        if (typeof onSidebarLayout === 'function') onSidebarLayout(msg);
        return;
      }
      if (msg.type === 'agentPresence') {
        if (typeof onAgentPresence === 'function') onAgentPresence(msg);
        return;
      }
      if (msg.type === 'notificationsChanged') {
        // The frame carries only { revision, reason }: the notification store
        // ignores a stale revision and otherwise does a full GET.
        if (typeof onNotificationsChanged === 'function') onNotificationsChanged(msg);
        return;
      }
      if (msg.type === 'sdkHistoryChanged') {
        // The history identity the write carried: a changed chat epoch invalidates the local delta cursor.
        if (msg.identity && chat?.id) noteServerHistoryIdentity(chat.id, msg.identity);
        // Keep metadata through initial history hydration, even when live
        // model frames are allowed through. The view may still be replaced.
        if (chat._sdkHistoryHydrating === true) {
          if (!Array.isArray(chat._sdkPendingRoomEvents)) chat._sdkPendingRoomEvents = [];
          chat._sdkPendingRoomEvents.push(msg);
          return;
        }
        const records = (Array.isArray(msg.records) ? msg.records : [])
          .filter((record) => isServerAuthoredHistoryMeta(record));
        if (records.length > 0 && chat._sdkRichView) {
          // These rows are already persisted. Do not advance the store ACK:
          // there may be intervening model events still to pull.
          void applyLiveServerHistoryCards(chat, records).catch((error) => {
            appLogger.log('history', 'live card failed', { error: String(error) });
          });
        }
        return;
      }
      if (msg.type === 'replayBatchStart') {
        chat._sdkReplayBatchActive = true;
        chat._sdkReplayBatchExpected = Number(msg.totalEvents) || 0;
        scheduleSdkWsReplayFallback(chat);
        traceUiFreeze('sdk-replay', 'batch-start', {
          chatId: chat.id,
          totalEvents: chat._sdkReplayBatchExpected,
          hydrating: chat._sdkHistoryHydrating === true,
        });
        return;
      }
      if (msg.type === 'replayBatch' && Array.isArray(msg.events)) {
        // Re-enter the socket handler so hydration can buffer, and so room
        // watermarks move only on the same path that actually renders.
        const events = msg.events;
        const deliver = () => {
          for (const event of events) {
            if (!event || typeof event !== 'object') continue;
            chat._processSdkSocketMessage?.({ ...event, replay: true });
          }
        };
        if (!isUiFreezeTraceActive()) {
          deliver();
          return;
        }
        measureSpan('ws.replayBatch', { events: events.length }, deliver);
        return;
      }
      if (msg.type === 'replayBatchEnd') {
        traceUiFreeze('sdk-replay', 'batch-end', {
          chatId: chat.id,
          expected: chat._sdkReplayBatchExpected || 0,
          hydrating: chat._sdkHistoryHydrating === true,
        });
        markPageResumeStage(chat._pageResumeTrace, 'replayEnd');
        delete chat._sdkReplayBatchActive;
        delete chat._sdkReplayBatchExpected;
        clearSdkWsReplayWaitState(chat);
        if (shouldHttpCatchUpAfterWsReplay()) {
          requestHttpCatchUpAfterReplay(chat, 'replay_complete');
          return;
        }
        clearHistorySyncInFlightAfterWsReplay(chat, false, renderChatTerminalState);
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
        if (Object.prototype.hasOwnProperty.call(msg, 'lastRunStatus')) {
          chat._sdkLastRunStatus = typeof msg.lastRunStatus === 'string' ? msg.lastRunStatus : '';
        }
        applySdkRoomCapabilityFields(chat, msg);
        if (chat._sdkServerBusy) chat._sdkRichView?.onHarnessBusy?.();
        else chat._sdkRichView?.onHarnessIdle?.();
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
        // A hello means the server accepted the handshake: the setup error is fixed.
        delete chat._sdkSetupErrorAt;
        delete chat._sdkSetupErrorCode;
        delete chat._sdkSetupErrorCount;
        chat.agentTransport = msg.transport === 'cursor-sdk' ? 'sdk' : String(msg.transport);
        syncSdkEventStream(chat, msg.eventStreamId);
        chat._sdkReplayTagged = msg.replayTagged === true;
        chat._sdkServerBusy = msg.busy === true;
        chat._sdkServerQueuedCount = Array.isArray(msg.queuedPrompts) ? msg.queuedPrompts.length : 0;
        applySdkRoomCapabilityFields(chat, msg);
        chat._sdkOptimisticSentNow = [];
        chat._sdkOptimisticSentQueued = [];
        sdkStreamReset(chat);
        if (chat._sdkServerBusy) chat._sdkRichView?.onHarnessBusy?.();
        else chat._sdkRichView?.onHarnessIdle?.();
        const helloState = resolveAgentStateFromMessage(chat._agentState || 'idle', msg);
        if (helloState) setAgentState(chat, helloState);
        const helloModel = typeof msg.modelId === 'string' ? msg.modelId.trim() : '';
        if (helloModel) confirmPendingModelChange(chat, helloModel, 'hello');
        const helloMode = parseExplicitSdkMode(msg.sdkMode) || null;
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
      if (bufferLiveEventDuringHistoryReplay(chat, msg)) return;
      if (bufferSdkRoomEventDuringHydration(chat, msg)) return;
      if (!shouldApplySdkRoomEvent(chat, msg)) return;
      if (msg.type === 'sdkSteerAck') {
        const outcome = typeof msg.outcome === 'string' ? msg.outcome : '';
        if (outcome === 'complete_delivered') {
          chat._sdkRichView?.appendMetaNotice?.(t('chat.sdkSteerDelivered'));
        } else {
          chat._sdkRichView?.appendMetaNotice?.(t('chat.sdkSteerReverted'));
        }
        return;
      }
      if (msg.type === 'sdkSteerError') {
        const steerMessage = typeof msg.message === 'string' ? msg.message.trim() : '';
        chat._sdkRichView?.appendMetaNotice?.(
          t('chat.sdkSteerFailed', { message: steerMessage || String(msg.code || '') })
        );
        return;
      }
      if (msg.type === 'sdkBackgroundWork') {
        const outstanding = Math.max(0, Number(msg.outstanding) || 0);
        chat._sdkBackgroundOutstanding = outstanding;
        chat._sdkRichView?.setBackgroundWorkOutstanding?.(outstanding);
        const phase = typeof msg.phase === 'string' ? msg.phase : '';
        if (phase === 'budget_exceeded') {
          chat._sdkRichView?.appendMetaNotice?.(t('chat.sdkBackgroundWorkBudget'));
        } else if (outstanding > 0) {
          chat._sdkRichView?.appendMetaNotice?.(
            t('chat.sdkBackgroundWorkRunning', { count: outstanding })
          );
        }
        return;
      }
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
        const runMode = parseExplicitSdkMode(msg.sdkMode) || null;
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
      if (msg.type === 'sdkMode' && (msg.mode === 'plan' || msg.mode === 'agent' || msg.mode === 'ask')) {
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
      if (msg.type === 'questionReplyRejected') {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        if (requestId) {
          chat._sdkRichView?.resolveOpenCodeQuestion?.(requestId, {
            status: msg.reason === 'expired' ? 'expired' : 'cancelled',
          });
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
        }
        appendTransportNotice(chat, t('sdkView.questionExpired'), 'warn');
        return;
      }
      if (msg.type === 'opencodeQuestionResolved' || msg.type === 'questionResolved') {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        const status = typeof msg.status === 'string' ? msg.status : 'answered';
        chat._sdkRichView?.resolveOpenCodeQuestion?.(requestId, { status });
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
      if (msg.type === 'opencodePermissionDecision') {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        chat._sdkRichView?.showOpenCodePermissionDecision?.(requestId, msg);
        return;
      }
      if (msg.type === 'opencodePermissionAdvisorPick') {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        const reply = typeof msg.reply === 'string' ? msg.reply : 'once';
        const applyAfterMs = Number(msg.applyAfterMs);
        const advisorDecision = typeof msg.advisorDecision === 'string' ? msg.advisorDecision : '';
        chat._sdkRichView?.showOpenCodePermissionAdvisorPick?.(requestId, reply, applyAfterMs, {
          advisorDecision,
        });
        return;
      }
      if (msg.type === 'opencodePermissionAdvisorStatus') {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        const status = typeof msg.status === 'string' ? msg.status : '';
        const advisorDecision = typeof msg.advisorDecision === 'string' ? msg.advisorDecision : '';
        const reason = typeof msg.reason === 'string' ? msg.reason : '';
        const localCategories = Array.isArray(msg.localCategories)
          ? msg.localCategories.filter((entry) => typeof entry === 'string')
          : [];
        chat._sdkRichView?.showOpenCodePermissionAdvisorStatus?.(requestId, {
          status,
          advisorDecision,
          finalDecision: typeof msg.finalDecision === 'string' ? msg.finalDecision : '',
          reason,
          advisorName: typeof msg.advisorName === 'string' ? msg.advisorName : '',
          advisorProtocol: typeof msg.advisorProtocol === 'string' ? msg.advisorProtocol : '',
          localRisk: typeof msg.localRisk === 'string' ? msg.localRisk : '',
          localCategories,
          alwaysAvailable: msg.alwaysAvailable === true,
          advisoryAssessment: msg.advisoryAssessment && typeof msg.advisoryAssessment === 'object'
            ? msg.advisoryAssessment
            : null,
        });
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
      if (msg.type === 'sdkContextUsage') {
        const measured = applyClaudeMeasuredContextUsage(chat, msg.usage, msg.model, msg.contextWindowTokens);
        const withBreakdown = applyClaudeContextBreakdown(chat, msg.breakdown);
        if (measured || withBreakdown) renderChatTerminalState(chat);
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
          noteInAppSignalIfLive(msg, 'question', msg.event.requestId, chat);
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
          noteInAppSignalIfLive(msg, 'permission', msg.event.requestId, chat);
        }
        if (msg.event.type === 'context_usage' && chat.agentTransport === 'codex') {
          if (applyCodexMeasuredContextUsage(chat, msg.event)) renderChatTerminalState(chat);
          noteRenderedSdkRoomEvent(chat, msg);
          return;
        }
        if (msg.event.type === 'context_usage' && !isClaudeContextMeterChat(chat)) {
          if (applyServerContextOccupancy(chat, msg.event)) renderChatTerminalState(chat);
          noteRenderedSdkRoomEvent(chat, msg);
          return;
        }
        if (msg.event && typeof msg.event === 'object' && msg.event.type === 'usage') {
          const transport = String(chat.agentTransport || 'sdk').trim() || 'sdk';
          // Claude run usage is not current context occupancy (sdk-limits-context-contract §6).
          if (isClaudeContextMeterChat(chat)) {
            applyClaudeMeasuredContextUsage(
              chat,
              msg.event.lastCallUsage,
              msg.event.lastCallModel,
              msg.event.lastCallContextWindowTokens,
            );
          } else if (transport !== 'codex') {
            // Billing totals are not occupancy: only the server-stamped
            // snapshot (usageMeta) feeds the meter for these harnesses.
            applyServerContextOccupancy(chat, msg.event);
          }
          if (transport !== 'codex') delete chat._sdkContextFreshSession;
          renderChatTerminalState(chat);
        }
        setAgentState(chat, 'active');
        delete chat._sdkLastRunStatus;
        if (chat._sdkRichView) {
          chat._sdkRichView.applyEvent(msg.event, readSdkViewOrderMeta(msg));
          noteRenderedSdkRoomEvent(chat, msg);
          return;
        }
        const chunk = getSdkEventTerminalChunk(chat, msg.event);
        if (!chunk) return;
        appendSdkTermChunk(chat, chunk);
        noteRenderedSdkRoomEvent(chat, msg);
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
        chat._sdkLastRunStatus = typeof msg.status === 'string' ? msg.status : '';
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
        noteInAppSignalIfLive(msg, 'finished', msg.runId, chat);
        if (chat._sdkRichView) {
          chat._sdkRichView.appendRunFinished(runStatus, {
            ...readSdkViewOrderMeta(msg),
            lastErrorCode: typeof msg.lastErrorCode === 'string' ? msg.lastErrorCode.trim() : '',
          });
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
        if (msg.busy === true) delete chat._sdkLastRunStatus;
        const busyState = resolveAgentStateFromMessage(chat._agentState || 'idle', msg);
        if (busyState) setAgentState(chat, busyState);
        if (msg.busy === false) {
          chat._sdkRichView?.onHarnessIdle?.();
          renderChatTerminalState(chat);
          return;
        }
        chat._sdkRichView?.onHarnessBusy?.();
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
        delete chat._sdkLastRunStatus;
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
        if (isClaudeContextMeterChat(chat)) {
          const noticeType = typeof msg.noticeType === 'string' ? msg.noticeType.trim() : '';
          if (noticeType === 'compact' || noticeType === 'session_reset') {
            resetChatContextMeterState(chat, { reason: noticeType });
            renderChatTerminalState(chat);
          }
        }
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
        } else if (phase === 'notice' || phase === 'retry') {
          notice = typeof msg.message === 'string' ? msg.message.trim() : '';
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
              transport: msg.transport,
              message: msg.message,
              noticeType: msg.noticeType,
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
        if (isSdkSetupErrorCode(msg.code)) {
          const setupText = String(msg.message || msg.code).trim();
          const repeated = !!chat._sdkSetupErrorAt && chat._lastShownSdkErrorText === setupText;
          chat._sdkSetupErrorAt = Date.now();
          chat._sdkSetupErrorCode = String(msg.code);
          chat._sdkSetupErrorCount = (chat._sdkSetupErrorCount || 0) + 1;
          stopChatReconnect(chat);
          // Each retry gets the same answer; show it once instead of on every handshake.
          if (repeated) return;
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
      rememberUnrenderedSdkRoomEvent(chat, msg);
      appLogger.log('chat-ws', 'socket message handler failed', {
        chatId: chat.id,
        messageType,
        error: String(err?.message || err),
      });
    }
  };
}
