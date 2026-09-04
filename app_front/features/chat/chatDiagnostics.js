import { formatRoomEventSeqDiag } from '../../../lib/sdk/sdk-room-state.js';
import { isSdkRunFailureStatus } from '../../../lib/sdk/sdk-run-outcome.js';
import {
  estimateContextFillPercent,
  getModelContextWindowTokens,
  readReportedTokenCount,
  resolveLiveContextUsageInputTokens,
} from '../../../lib/sdk/sdk-context-advisory.js';
import { isChatDiagEnabled } from './chatSettingsPrefs.js';
import { getCurrentLang, t } from '../../i18n/index.js';

export const CHAT_DIAG_POLL_MS = 2000;
export const CHAT_CONTEXT_USAGE_SYNC_MS = 30000;

/**
 * @param {number} readyState
 * @returns {string}
 */
function resolveWsReadyStateLabel(readyState) {
  if (readyState === WebSocket.OPEN) return 'OPEN';
  if (readyState === WebSocket.CONNECTING) return t('chatUi.wsStateConnecting');
  if (readyState === WebSocket.CLOSING) return t('chatUi.wsStateClosing');
  if (readyState === WebSocket.CLOSED) return t('chatUi.wsStateClosed');
  return String(readyState);
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatAgoMs(ms) {
  if (!ms || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return t('chatUi.agoMs', { value: Math.round(ms) });
  if (ms < 60000) return t('chatUi.agoSeconds', { value: (ms / 1000).toFixed(1) });
  if (ms < 3600000) return t('chatUi.agoMinutes', { value: Math.round(ms / 60000) });
  return t('chatUi.agoHours', { value: Math.round(ms / 3600000) });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatTokenCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '—';
  return new Intl.NumberFormat(getCurrentLang()).format(Math.round(numeric));
}

/**
 * @typedef {Object} ChatDiagnosticsDeps
 * @property {typeof import('../../core/api/index.js')} api
 * @property {import('../../logger.js').AppLogger} [appLogger]
 * @property {() => string|null} getActiveChatId
 * @property {(chat: object, modelId?: unknown) => void} updateChatContextMeter
 * @property {(chat: object, modelIdOrPayload?: unknown) => string} resolveContextMeterModelId
 * @property {(chat: object, metaOverride?: object|null) => void} renderChatTerminalState
 * @property {(chat: object) => void} [ensureChatConnection]
 * @property {(el: Element|null, text: string, timeoutMs?: number) => void} setTransientChatActionHint
 * @property {(chat: object, roomState: object) => void} maybeRecoverMissedSdkRunOutcome
 */

/**
 * @param {ChatDiagnosticsDeps} deps
 */
export function createChatDiagnostics(deps) {
  const {
    api,
    appLogger,
    getActiveChatId,
    updateChatContextMeter,
    resolveContextMeterModelId,
    renderChatTerminalState,
    ensureChatConnection,
    setTransientChatActionHint,
    maybeRecoverMissedSdkRunOutcome,
  } = deps;

  /**
   * @param {object|null|undefined} chat
   * @returns {string}
   */
  function getChatWsStateLabel(chat) {
    if (!chat?.ws) return 'CLOSED';
    switch (chat.ws.readyState) {
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return '—';
    }
  }

  /**
   * @param {object|null|undefined} chat
   * @param {object|null|undefined} room
   */
  function buildChatDiagSnapshot(chat, room) {
    const now = Date.now();
    const seqDiag = formatRoomEventSeqDiag(chat?._sdkLastRoomEventSeq, room?.lastEventSeq);
    return {
      wsState: getChatWsStateLabel(chat),
      connectionStatus: chat?._connectionStatus || 'disconnected',
      agentState: chat?._agentState || 'disconnected',
      lastPongAgoMs: Number.isFinite(chat?._lastPongAt) ? now - chat._lastPongAt : null,
      lastSdkEventAgoMs: Number.isFinite(chat?._sdkLastLiveEventAt) ? now - chat._sdkLastLiveEventAt : null,
      reconnectAttempts: chat?._reconnectAttempts ?? 0,
      serverBusy: !!room?.busy,
      serverStuckInSetup: !!room?.stuckInSetup,
      serverSetupPhase: room?.setupPhase || null,
      serverSetupAgoMs: Number.isFinite(room?.setupAgoMs) ? room.setupAgoMs : null,
      serverHasCurrentRun: !!room?.hasCurrentRun,
      serverClients: Number.isFinite(room?.clients) ? room.clients : null,
      queuedCount: room?.queuedCount ?? 0,
      serverLastEventAgoMs: Number.isFinite(room?.lastEventAgoMs) ? room.lastEventAgoMs : null,
      serverLastEventType: room?.lastEventType || null,
      clientRoomEventSeq: seqDiag.clientSeq,
      serverRoomEventSeq: seqDiag.serverSeq,
      roomEventSeqGap: seqDiag.gap,
      roomEventSeqGapLabel: seqDiag.gapLabel,
      roomEventSeqSynced: seqDiag.isSynced,
    };
  }

  /**
   * @param {object|null|undefined} chat
   * @param {object|null|undefined} room
   * @param {(id: string, text: string) => void} set
   */
  function applyRoomEventSeqDiagToUi(chat, room, set) {
    const seqDiag = formatRoomEventSeqDiag(chat?._sdkLastRoomEventSeq, room?.lastEventSeq);
    set('chat-diag-client-seq', seqDiag.clientSeq == null ? '—' : String(seqDiag.clientSeq));
    set('chat-diag-server-seq', seqDiag.serverSeq == null ? '—' : String(seqDiag.serverSeq));
    set('chat-diag-seq-gap', seqDiag.gapLabel);
    const gapEl = document.getElementById('chat-diag-seq-gap');
    if (gapEl) {
      gapEl.classList.toggle('chat-diag-value-warn', seqDiag.gap != null && seqDiag.gap > 0);
    }
    return seqDiag;
  }

  /** @param {object} chat */
  function createChatDiagPanel(chat) {
    const panel = document.createElement('cr-chat-diag');
    panel.enabled = isChatDiagEnabled();
    chat.diagPanelEl = panel;
    return panel;
  }

  /** @param {object|null|undefined} chat */
  function syncChatDiagEnabled(chat) {
    if (!chat?.diagPanelEl) return;
    const enabled = isChatDiagEnabled();
    chat.diagPanelEl.enabled = enabled;
    if (enabled) {
      startChatDiagPolling(chat);
    } else {
      stopChatDiagPolling(chat);
    }
  }

  /** @param {object|null|undefined} chat */
  function stopChatContextUsageSync(chat) {
    if (chat?._contextUsageSyncTimer) {
      clearInterval(chat._contextUsageSyncTimer);
      chat._contextUsageSyncTimer = null;
    }
  }

  /** @param {object|null|undefined} chat */
  function startChatContextUsageSync(chat) {
    if (!chat || chat.agentTransport !== 'sdk') return;
    stopChatContextUsageSync(chat);
    const tick = async () => {
      if (chat.id !== getActiveChatId()) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await api.getChatDiag(chat.id);
        applyServerContextUsageFromDiag(chat, res);
      } catch (_) {
        // Non-critical background sync.
      }
    };
    void tick();
    chat._contextUsageSyncTimer = setInterval(tick, CHAT_CONTEXT_USAGE_SYNC_MS);
  }

  /**
   * @param {object|null|undefined} chat
   * @param {{ ok?: boolean, room?: object, model?: string, contextStats?: { history?: object, pressure?: object } } | null | undefined} res
   */
  function applyServerContextUsageFromDiag(chat, res) {
    if (!chat || !res?.ok) return;
    const pressure = res.contextStats?.pressure;
    const history = res.contextStats?.history;
    const room = res.room;
    const modelId = resolveContextMeterModelId(chat, res);
    const resolvedUsage = resolveLiveContextUsageInputTokens({ chat, room, historyStats: history });
    if (Number.isFinite(resolvedUsage) && resolvedUsage > 0) {
      chat._contextUsageInputTokens = resolvedUsage;
      const transport = String(chat.agentTransport || 'sdk').trim() || 'sdk';
      chat._contextUsageSource = transport === 'sdk' ? 'sdk-history' : `${transport}-history`;
    } else {
      chat._contextUsageInputTokens = null;
      delete chat._contextUsageSource;
    }
    chat._contextUsageOutputTokens = readReportedTokenCount(room?.lastUsageOutputTokens);
    chat._contextUsageTotalTokens = readReportedTokenCount(room?.lastUsageTotalTokens);
    const fillCandidates = [
      estimateContextFillPercent(chat._contextUsageInputTokens, modelId),
      pressure?.contextFillPercent,
    ]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (fillCandidates.length > 0) {
      chat._contextFillPercent = fillCandidates[0];
    } else {
      delete chat._contextFillPercent;
    }
    const peakFill = Number(pressure?.peakContextFillPercent);
    if (Number.isFinite(peakFill) && peakFill > 0) {
      chat._contextPeakFillPercent = peakFill;
    } else {
      delete chat._contextPeakFillPercent;
    }
    chat._contextLikelyPressure = pressure?.likelyContextPressure === true;
    chat._contextWarnings = Array.isArray(pressure?.warnings)
      ? pressure.warnings.filter((entry) => typeof entry === 'string' && entry.trim())
      : [];
    if (modelId && modelId !== 'auto') {
      chat._contextUsageModelId = modelId;
    }
    const serverTime = Number(res.serverTime);
    chat._contextUsageUpdatedAt =
      Number.isFinite(serverTime) && serverTime > 0 ? Math.round(serverTime) : Date.now();
    updateChatContextMeter(chat, modelId);
  }

  /** @param {object|null|undefined} chat */
  function stopChatDiagPolling(chat) {
    if (chat?._diagPollTimer) {
      clearInterval(chat._diagPollTimer);
      chat._diagPollTimer = null;
    }
  }

  /** @param {object|null|undefined} chat */
  function startChatDiagPolling(chat) {
    if (!chat || !isChatDiagEnabled()) return;
    stopChatDiagPolling(chat);
    const tick = async () => {
      let room = null;
      let res = null;
      try {
        res = await api.getChatDiag(chat.id);
        if (res && res.ok && res.room) room = res.room;
      } catch (_) {
        // Diagnosis fetch errors are non-critical.
      }
      applyServerContextUsageFromDiag(chat, res);
      const snapshot = buildChatDiagSnapshot(chat, room);
      if (chat.diagPanelEl) chat.diagPanelEl.data = snapshot;
    };
    void tick();
    chat._diagPollTimer = setInterval(tick, CHAT_DIAG_POLL_MS);
  }

  /** @param {object|null|undefined} chat */
  function renderChatDiagnosis(chat) {
    if (!chat) return;
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const conn = chat._connectionStatus || '—';
    set('chat-diag-conn', conn);
    const wsState = chat.ws ? resolveWsReadyStateLabel(chat.ws.readyState) : t('chatUi.diagNone');
    set('chat-diag-ws', wsState);
    set('chat-diag-agent', chat._agentState || '—');
    set(
      'chat-diag-last-event',
      chat._sdkLastLiveEventAt ? formatAgoMs(Date.now() - chat._sdkLastLiveEventAt) : '—',
    );
    set('chat-diag-reconnects', String(chat._reconnectAttempts || 0));
    set('chat-diag-pong', chat._lastPongAt ? formatAgoMs(Date.now() - chat._lastPongAt) : '—');
    const queued = chat._sdkRichView && typeof chat._sdkRichView.queuedCount === 'number'
      ? chat._sdkRichView.queuedCount
      : 0;
    set('chat-diag-queue', String(queued));
    applyRoomEventSeqDiagToUi(chat, null, set);
    const badge = document.getElementById('chat-diag-server-status');
    if (badge) {
      badge.textContent = '—';
      badge.classList.remove('chat-diag-badge-ok', 'chat-diag-badge-warn', 'chat-diag-badge-bad');
    }
    const extra = document.getElementById('chat-diag-server-extra');
    if (extra) {
      extra.hidden = true;
      extra.textContent = '';
    }
  }

  /**
   * @param {Record<string, unknown> | null | undefined} contextStats
   * @returns {string[]}
   */
  function formatContextStatsExtraLines(contextStats) {
    if (!contextStats || typeof contextStats !== 'object') return [];
    const history =
      contextStats.history && typeof contextStats.history === 'object' ? contextStats.history : null;
    const localStore =
      contextStats.localStore && typeof contextStats.localStore === 'object' ? contextStats.localStore : null;
    const pressure =
      contextStats.pressure && typeof contextStats.pressure === 'object' ? contextStats.pressure : null;
    const lines = [];
    if (history) {
      lines.push(
        `history: headSeq=${history.headSeq ?? '—'} stored=${history.storedEvents ?? '—'} users=${history.localUserCount ?? '—'} sdk=${history.sdkEventCount ?? '—'} file=${history.historyFileBytes ?? '—'}B`,
      );
      if (history.lastStatusError) {
        lines.push(`historyLastError: ${history.lastStatusError}`);
      }
    }
    if (localStore) {
      const mb = Number(localStore.totalBytes) > 0 ? (Number(localStore.totalBytes) / (1024 * 1024)).toFixed(1) : '0';
      lines.push(`localStore: ${localStore.exists ? `${mb}MB` : 'none'} (${localStore.storeDir || '—'})`);
      if (Array.isArray(localStore.agents) && localStore.agents.length > 0) {
        lines.push(
          `localAgents: ${localStore.agents
            .map((row) => `${row?.agentId || '—'}:${row?.status || '—'}`)
            .join(' | ')}`,
        );
      }
    }
    if (pressure) {
      lines.push(
        `contextPressure: fill=${pressure.contextFillPercent ?? '—'}% peak=${pressure.peakContextFillPercent ?? '—'}% warnings=${Array.isArray(pressure.warnings) ? pressure.warnings.join(',') : '—'}`,
      );
    }
    return lines;
  }

  /**
   * @param {Record<string, unknown>} probe
   * @returns {string}
   */
  function formatSdkProbeExtraText(probe) {
    if (!probe || typeof probe !== 'object') return '';
    const lines = [
      `probeRecommendation: ${probe.recommendation || '—'}`,
      `probeSignals: ${Array.isArray(probe.signals) ? probe.signals.join(', ') : '—'}`,
    ];
    if (probe.resume && typeof probe.resume === 'object') {
      lines.push(
        `probeResume: ok=${probe.resume.ok === true} auth=${probe.resume.isAuthenticationError === true} status=${probe.resume.runStatus || probe.resume.error || '—'}`,
      );
    }
    if (probe.create && typeof probe.create === 'object') {
      lines.push(
        `probeCreate: ok=${probe.create.ok === true} auth=${probe.create.isAuthenticationError === true} status=${probe.create.runStatus || probe.create.error || '—'}`,
      );
    }
    if (probe.messages && typeof probe.messages === 'object') {
      lines.push(`probeMessages: ok=${probe.messages.ok === true} count=${probe.messages.messageCount ?? '—'}`);
    }
    return lines.join('\n');
  }

  /**
   * @param {object|null|undefined} chat
   * @param {Element|null} [hintEl]
   */
  async function runSdkAgentProbe(chat, hintEl = null) {
    if (!chat || chat.agentTransport !== 'sdk') {
      setTransientChatActionHint(hintEl, t('chatUi.diagProbeSdkOnly'));
      return null;
    }
    if (hintEl) hintEl.textContent = t('chat.diagProbeRunning');
    try {
      const res = await api.postSdkChatProbe(chat.id, { includeCreate: true, timeoutMs: 120000 });
      if (!res?.ok || !res.probe) {
        throw new Error(res?.error || t('chat.diagProbeFailed', { detail: 'unknown' }));
      }
      const extra = document.getElementById('chat-diag-server-extra');
      if (extra) {
        extra.hidden = false;
        const existing = extra.textContent ? `${extra.textContent.trim()}\n\n` : '';
        extra.textContent = `${existing}${formatSdkProbeExtraText(res.probe)}`;
      }
      if (hintEl) {
        hintEl.textContent = res.probe.recommendation || t('chat.diagProbeDone');
      }
      return res.probe;
    } catch (err) {
      const message = String(err?.message || err || 'unknown');
      if (hintEl) hintEl.textContent = t('chat.diagProbeFailed', { detail: message });
      return null;
    }
  }

  /** @param {object|null|undefined} chat */
  async function fetchAndRenderServerDiag(chat) {
    if (!chat) return;
    const hint = document.getElementById('chat-diag-hint');
    if (hint) hint.textContent = t('chatUi.diagFetchingServerState');
    const badge = document.getElementById('chat-diag-server-status');
    const extra = document.getElementById('chat-diag-server-extra');
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    try {
      const res = await api.getChatDiag(chat.id);
      if (!res || !res.ok) {
        if (badge) {
          badge.textContent = res?.error || t('chatUi.diagBadgeError');
          badge.classList.remove('chat-diag-badge-ok');
          badge.classList.add('chat-diag-badge-bad');
        }
        if (hint) hint.textContent = res?.error || t('chatUi.diagFetchServerFailed');
        return;
      }
      const room = res.room;
      if (!room || !room.exists) {
        if (badge) {
          badge.textContent = t('chatUi.diagBadgeRoomMissing');
          badge.classList.remove('chat-diag-badge-ok');
          badge.classList.add('chat-diag-badge-warn');
        }
        set('chat-diag-busy', '—');
        set('chat-diag-run', '—');
        set('chat-diag-server-queue', '—');
        set('chat-diag-clients', '—');
        set('chat-diag-server-last', '—');
        set('chat-diag-eventlog', '—');
        set('chat-diag-client-seq', '—');
        set('chat-diag-server-seq', '—');
        set('chat-diag-seq-gap', '—');
        if (extra) {
          extra.hidden = false;
          extra.textContent = t('chatUi.diagRoomMissingHint');
        }
        if (hint) hint.textContent = '';
        return;
      }
      if (badge) {
        const stale = room.lastEventAgoMs != null && room.lastEventAgoMs > 120000 && room.busy;
        const setupStuck = room.stuckInSetup && room.setupAgoMs != null && room.setupAgoMs > 30000;
        const lastRunFailed =
          isSdkRunFailureStatus(room.lastRunStatus) && !room.busy && !room.hasCurrentRun;
        badge.textContent = setupStuck
          ? t('chatUi.diagBadgeSetupStuck')
          : stale
            ? t('chatUi.diagBadgeMaybeStuck')
            : lastRunFailed
              ? t('chatUi.diagBadgeRunError')
              : t('chatUi.diagBadgeOk');
        badge.classList.remove('chat-diag-badge-ok', 'chat-diag-badge-warn', 'chat-diag-badge-bad');
        if (setupStuck || stale) {
          badge.classList.add('chat-diag-badge-warn');
        } else if (lastRunFailed) {
          badge.classList.add('chat-diag-badge-bad');
        } else {
          badge.classList.add('chat-diag-badge-ok');
        }
      }
      set('chat-diag-busy', room.busy ? t('chatUi.diagYes') : t('chatUi.diagNo'));
      set('chat-diag-run', room.hasCurrentRun ? t('chatUi.diagYes') : t('chatUi.diagNo'));
      set('chat-diag-server-queue', `${room.queuedCount} (${room.queued && room.queued.map((q) => q.text.slice(0, 24)).join(' | ') || ''})`);
      set('chat-diag-clients', String(room.clients));
      set('chat-diag-server-last', room.lastEventAgoMs != null ? formatAgoMs(room.lastEventAgoMs) : '—');
      set('chat-diag-eventlog', `${room.eventLogCount} (ost.: ${room.lastEventType || '—'})`);
      const seqDiag = applyRoomEventSeqDiagToUi(chat, room, set);
      const lastRunFailed =
        isSdkRunFailureStatus(room.lastRunStatus) && !room.busy && !room.hasCurrentRun;
      maybeRecoverMissedSdkRunOutcome(chat, {
        busy: room.busy === true,
        hasCurrentRun: room.hasCurrentRun === true,
        lastRunId: room.lastRunId,
        lastRunStatus: room.lastRunStatus,
        lastErrorMessage: room.lastErrorMessage,
      });
      if (hint) {
        if (room.stuckInSetup) {
          hint.textContent = t('chatUi.diagSetupStuckHint', {
            phase: room.setupPhase || 'setup',
          });
        } else if (room.lastErrorCode === 'run_setup_cancelled') {
          hint.textContent = t('chatUi.diagSetupCancelledHint');
        } else if (lastRunFailed) {
          if (room.lastErrorCode === 'cursor_auth_error') {
            hint.textContent = t('chat.diagAuthError', {
              detail: room.lastErrorMessage || room.lastRunStatus || 'error',
            });
          } else {
            hint.textContent = t('chat.diagLastRunFailed', {
              status: room.lastRunStatus || 'error',
            });
          }
        } else if (seqDiag.gap != null && seqDiag.gap > 0) {
          hint.textContent = t('chatUi.diagSeqGapHint', { gap: seqDiag.gap });
        } else {
          hint.textContent = '';
        }
      }
      if (extra) {
        const contextFillPercent = estimateContextFillPercent(room.lastUsageInputTokens, room.modelId);
        const contextFillLabel =
          contextFillPercent == null
            ? '—'
            : `${contextFillPercent.toFixed(1)}% (~${formatTokenCount(room.lastUsageInputTokens)} / ${formatTokenCount(
                getModelContextWindowTokens(room.modelId),
              )})`;
        const usageLine = `in=${formatTokenCount(room.lastUsageInputTokens)}, out=${formatTokenCount(
          room.lastUsageOutputTokens,
        )}, total=${formatTokenCount(room.lastUsageTotalTokens)}, cacheRead=${formatTokenCount(
          room.lastUsageCacheReadTokens,
        )}`;
        const recentEventsText = Array.isArray(room.recentEvents) && room.recentEvents.length > 0
          ? room.recentEvents
            .map((event) => {
              if (!event || typeof event !== 'object') return '—';
              const type = event.type || '—';
              const status = event.status ? ` status=${event.status}` : '';
              const code = event.code ? ` code=${event.code}` : '';
              return `${type}${status}${code}`;
            })
            .join(' | ')
          : '—';
        const lines = [
          `agentId: ${room.agentId || '—'}`,
          `model: ${room.modelId || '—'}`,
          `mode: ${room.sdkMode || '—'}`,
          `hasAgent: ${room.hasAgent ? 'yes' : 'no'}`,
          `setup: ${room.stuckInSetup ? `${room.setupPhase || 'setup'} (${room.setupAgoMs != null ? formatAgoMs(room.setupAgoMs) : '—'})` : 'no'}`,
          `shutdownScheduled: ${room.shutdownScheduled ? 'yes' : 'no'}`,
          `roomEventSeq: client=${seqDiag.clientSeq ?? '—'} server=${seqDiag.serverSeq ?? '—'} gap=${seqDiag.gapLabel}`,
          `backpressure: skips=${room.backpressureSkipCount ?? 0}, maxBuffered=${room.maxClientBufferedBytes ?? 0}B`,
          `contextFill~: ${contextFillLabel}`,
          `lastUsage: ${usageLine}`,
          `lastRun: ${room.lastRunStatus || '—'} (${room.lastRunId || '—'})`,
          `lastError: ${room.lastErrorCode || '—'}${room.lastErrorMessage ? ` — ${room.lastErrorMessage}` : ''}`,
          `recentEvents: ${recentEventsText}`,
          ...formatContextStatsExtraLines(res.contextStats),
        ];
        extra.hidden = false;
        extra.textContent = lines.join('\n');
      }
      applyServerContextUsageFromDiag(chat, res);
      renderChatTerminalState(chat);
    } catch (err) {
      if (badge) {
        badge.textContent = t('chatUi.diagBadgeError');
        badge.classList.add('chat-diag-badge-bad');
      }
      if (hint) hint.textContent = String(err);
    }
  }

  /** @param {object|null|undefined} chat */
  function forceReconnectChat(chat) {
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
    ensureChatConnection?.(chat);
    setTimeout(() => renderChatDiagnosis(chat), 300);
  }

  /**
   * @param {object|null|undefined} chat
   * @param {Element|null} [hintEl]
   */
  async function resetSdkChatRoom(chat, hintEl) {
    if (!chat?.id || !chat.cursorSessionId) return;
    if (hintEl) hintEl.textContent = t('chat.diagResetRoomDone');
    try {
      const res = await api.disposeSdkChatRoom(chat.id);
      if (!res?.ok) {
        throw new Error(res?.error || t('chat.diagResetRoomFailed'));
      }
      chat._sdkServerBusy = false;
      forceReconnectChat(chat);
      if (chat._sdkRichView) {
        chat._sdkRichView.appendMetaNotice(t('chat.diagResetRoomDone'));
      }
      setTimeout(() => renderChatDiagnosis(chat), 400);
    } catch (err) {
      const message = err?.message || t('chat.diagResetRoomFailed');
      if (hintEl) hintEl.textContent = message;
      appLogger?.log('chat-diag', 'reset sdk room failed', {
        chatId: chat.id,
        error: message,
      });
    }
  }

  return {
    getChatWsStateLabel,
    buildChatDiagSnapshot,
    applyRoomEventSeqDiagToUi,
    createChatDiagPanel,
    syncChatDiagEnabled,
    stopChatContextUsageSync,
    startChatContextUsageSync,
    resolveContextMeterModelId,
    applyServerContextUsageFromDiag,
    stopChatDiagPolling,
    startChatDiagPolling,
    renderChatDiagnosis,
    runSdkAgentProbe,
    fetchAndRenderServerDiag,
    forceReconnectChat,
    resetSdkChatRoom,
  };
}
