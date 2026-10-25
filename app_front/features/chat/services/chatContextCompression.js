/** Context compression, summary and fresh-agent resets for open chats. */
import { chatRuntime } from '../state/chatRuntimeState.js';
import { normalizeAutoContextCompressionThresholdPercent, evaluateAutoContextCompressionGate, buildAutoContextCompressionAttemptKey, evaluateAutoContextCompressionBoundary, buildSeedSummaryFromSummaries } from '../../../../lib/context-compression.js';
import { t } from '../../../i18n/index.js';
import { armContextCompressionWatchdog, recoverChatAfterCompressionFailure, disarmContextCompressionWatchdog } from '../chatContextCompressionRecovery.js';
import { appLogger } from '../../../core/logging/logger.js';
import { splitTrailingTitleJson } from '../chatTitleParsing.js';
import { requestWidgetHostUrl } from '../../../embed/widgetHostNavigation.js';
import { getChatWidgetPinnedUrl } from '../chatWidgetPin.js';
import { normalizeNewChatHarness, isEmbedWidgetMode } from './newChatHarnessState.js';
import * as api from '../../../core/api/index.js';
import { patchChatTitle } from './chatTitlesOutput.js';
import { createPageLinkedChat } from './chatWidgetPin.js';
import { closeChat } from './chatLifecycle.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/**
 * Force a chat WebSocket reconnect (close the current one and call ensureChatConnection).
 * @param {object} chat
 */
export function forceReconnectChat(chat) {
  if (chatRuntime.chatDiagnosticsApi?.forceReconnectChat) {
    chatRuntime.chatDiagnosticsApi.forceReconnectChat(chat);
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
  chatHost.ensureChatConnection(chat);
}

export async function resetSdkChatRoom(chat, hintEl) {
  if (chatRuntime.chatDiagnosticsApi?.resetSdkChatRoom) {
    return chatRuntime.chatDiagnosticsApi.resetSdkChatRoom(chat, hintEl);
  }
}

/**
 * Send cancel to the current SDK run of the chat.
 * @param {object} chat
 */
export function cancelChatRun(chat) {
  if (!chat) return;
  if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'cancel' }));
}

export function normalizeAutoContextCompressionThreshold(value) {
  return normalizeAutoContextCompressionThresholdPercent(value);
}

export function maybeScheduleAutoContextCompression(chat, snapshot) {
  if (!isAutoContextCompressionEnabled(chat)) return;
  // Never decide from an estimate, a stale reading or an unknown limit.
  if (snapshot?.quality && !snapshot.quality.autoEligible) return;
  if (chat._autoContextCompressionPending) return;
  if (chat._contextCompressionRunning) return;
  const threshold = normalizeAutoContextCompressionThreshold(chat.autoContextCompressionThreshold);
  // Only a confirmed, current, same-epoch measurement may start auto-compression;
  // estimates and unknown/stale readings are advisory-only.
  const gate = evaluateAutoContextCompressionGate(
    snapshot ? { ...snapshot, currentEpoch: snapshot.contextMeterEpoch } : null,
    { thresholdPercent: threshold },
  );
  if (!gate.allowed) return;
  // One attempt per reading: a failed summary clears the pending flag, and the
  // same reading must not schedule it again.
  const attemptKey = buildAutoContextCompressionAttemptKey(snapshot);
  if (chat._autoContextCompressionAttemptKey === attemptKey) return;
  chat._autoContextCompressionAttemptKey = attemptKey;
  chat._autoContextCompressionPending = true;
  chat._autoContextCompressionEpoch = snapshot.contextMeterEpoch ?? null;
  chat._sdkRichView?.appendMetaNotice?.(
    t('chat.autoContextCompressionScheduled', { percent: threshold })
  );
}

/**
 * Boundary for the auto summarize + reset path (see lib/context-compression.js).
 * @param {Record<string, any>} chat
 */
export function readAutoContextCompressionBoundary(chat) {
  return evaluateAutoContextCompressionBoundary({
    serverBusy: chat?._sdkServerBusy === false ? false : chat?._sdkServerBusy === true ? true : undefined,
    queuedCount: chat?._sdkServerQueuedCount,
    optimisticPending:
      (chat?._sdkOptimisticSentNow?.length || 0) + (chat?._sdkOptimisticSentQueued?.length || 0),
    resetPending: chat?._sdkContextResetPending === true,
    scheduledEpoch: chat?._autoContextCompressionEpoch,
    currentEpoch: chat?._contextMeterEpoch,
  });
}

export function isAutoContextCompressionEnabled(chat) {
  if (!chat || chat.agentTransport !== 'sdk') return false;
  return chat.autoContextCompressionEnabled === true;
}

export function shouldResetAfterContextCompression(chat) {
  if (!chat) return true;
  return chat.autoContextCompressionReset !== false;
}

export function setTransientChatActionHint(hintEl, message, timeoutMs = 6000) {
  if (!hintEl) return;
  hintEl.textContent = message;
  setTimeout(() => {
    if (hintEl.textContent === message) hintEl.textContent = '';
  }, timeoutMs);
}

export async function runIntentionalSummary(chat, hintEl = null, source = 'manual') {
  if (!chat || chat.agentTransport !== 'sdk') {
    setTransientChatActionHint(hintEl, t('chat.contextSummarySdkOnly'));
    return false;
  }
  if (chat._contextCompressionRunning) {
    setTransientChatActionHint(hintEl, t('chat.contextSummaryRunning'));
    return false;
  }
  if (source === 'auto' && !readAutoContextCompressionBoundary(chat).ok) {
    // Not a safe boundary (active run, queued message, new epoch): drop the attempt, history untouched.
    chat._autoContextCompressionPending = false;
    return false;
  }
  chat._contextCompressionRunning = true;
  armContextCompressionWatchdog(chat);
  const creatingMessage = t('chat.contextSummaryCreating');
  if (hintEl) hintEl.textContent = creatingMessage;
  chat._sdkRichView?.appendMetaNotice?.(creatingMessage);
  try {
    const { result, error } = await chatShell.requestSummaryFromForkAsync(chat, (tempChat) => {
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
      // A message may have arrived while the summary was produced: keep the summary
      // saved in chat.summaries, skip the reset and leave the live session untouched.
      if (source === 'auto' && !readAutoContextCompressionBoundary(chat).ok) {
        chat._sdkRichView?.appendMetaNotice?.(t('chat.contextSummarySavedNoReset'));
        return true;
      }
      const resetOk = await resetChatSdkContext(chat, hintEl, { auto: source === 'auto' });
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
      chatRuntime.chatDiagnosticsApi?.updateChatContextMeter?.(
        chat,
        chatRuntime.chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
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

export function onChatSdkRunFinished(chat, msg) {
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
export async function startFreshWidgetAgentChat(chat, hintEl = null) {
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
export async function startNewAgent(chat, hintEl = null) {
  if (!chat) {
    setTransientChatActionHint(hintEl, t('chat.noActiveChat'));
    return false;
  }
  if (isEmbedWidgetMode()) {
    return startFreshWidgetAgentChat(chat, hintEl);
  }
  return resetInPlaceNewAgent(chat, hintEl);
}

export async function resetInPlaceNewAgent(chat, hintEl = null) {
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
export async function resetChatSdkContext(chat, hintEl = null, options = {}) {
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
    const res = await api.postChatResetSdkContext(chat.id, { auto: options.auto === true });
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
    chatRuntime.chatDiagnosticsApi?.resetChatContextMeterState?.(chat, {
      reason: 'sdk_reset',
      markFreshSession: true,
    });
    if (typeof chatRuntime.chatDiagnosticsApi?.resetChatContextMeterState !== 'function') {
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
    }
    chat._contextAdvisoryDismissed = false;
    chatRuntime.chatDiagnosticsApi?.updateChatContextMeter?.(
      chat,
      chatRuntime.chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
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
