/** Sidebar chat-state refresh, awaiting-input and terminal state resolution. */
import { resolveChatListDotState, hasKeepAliveHarnessWork, readHarnessPendingFlags, resolveHarnessChatStateMeta, resolveChatStatusWithHistorySync } from '../chatStatusMeta.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { syncAgentWakeLock } from '../../pwa/wakeLock.js';
import { t } from '../../../i18n/index.js';
import { chatListVisualKey, shouldSkipChatListItemWrite, buildChatByIdMap, createRafDebouncer } from '../chatListStateRefresh.js';
import { patchSidebarChatRowVisualState } from '../../sidebar/sidebarChatRowVisualPatch.js';
import { escapeHtml } from '../chatHtmlUtils.js';
import { isUiFreezeTraceActive } from '../../../lib/uiFreezeTrace.js';
import { dispatchSidebarChatRowStatusPatch } from '../../sidebar/sidebarChatRowRefreshBus.js';
import { getUiFreezeMetrics } from '../../sidebar/sidebarRenderMetrics.js';
import { parseTerminalInteraction, resolveTerminalState } from '../../../../lib/status-parser.js';
import { isDebugStatus } from './chatDebugLogs.js';
import { appLogger } from '../../../core/logging/logger.js';
import { isPendingHarnessSwitch } from './harnessModelCatalog.js';
import { normalizeModelValue } from '../chatSettingsPrefs.js';
import { getUiFreezeCounters } from '../../../lib/uiFreezeCounters.js';
import { AGENT_STATE_IDLE_MS, TERMINAL_RECENT_OUTPUT_MS, applySidebarConnectionPolicy, chatExpectsLiveSocket, getChatAgentState, getSidebarChatStateMeta, notifySidebar, sidebarStatusStabilizer } from './chatSidebarHooks.js';
import { syncArchivedChatSendUi } from './chatDeleteArchive.js';
import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

export function hasOngoingTerminalAction(chat) {
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

export function getChatListAgentState(chat) {
  if (!chat) return 'disconnected';
  return resolveChatListDotState(getSidebarChatStateMeta(chat).tone);
}

export function setAgentState(chat, state) {
  if (chat._agentStateIdleTimer) {
    clearTimeout(chat._agentStateIdleTimer);
    chat._agentStateIdleTimer = null;
  }
  chat._agentState = state;
  if (state === 'idle') {
    chat._sdkRichView?.onHarnessIdle?.();
  }
  renderChatTerminalState(chat);
  scheduleChatListStateRefresh(chat?.id ? [chat.id] : []);
  if (chat.id === chatRuntime.activeChatId) chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
  syncAgentWakeLock(chats.some((entry) => entry._agentState === 'active'));
}

export function scheduleAgentIdleTransition(chat) {
  if (!chat) return;
  if (chat._agentStateIdleTimer) clearTimeout(chat._agentStateIdleTimer);
  chat._agentStateIdleTimer = setTimeout(() => {
    chat._agentStateIdleTimer = null;
    if (hasOngoingTerminalAction(chat) || hasKeepAliveHarnessWork(chat)) {
      setAgentState(chat, 'active');
      scheduleAgentIdleTransition(chat);
      return;
    }
    setAgentState(chat, 'idle');
  }, AGENT_STATE_IDLE_MS);
}

export function onAgentOutput(chat) {
  if (!chat) return;
  if (chat?.id) chatHost.recordChatActivity(chat.id);
  setAgentState(chat, 'active');
  scheduleAgentIdleTransition(chat);
}

export function scheduleTerminalStateRefresh(chat) {
  if (!chat) return;
  if (chat._recentOutputExpireTimer) {
    clearTimeout(chat._recentOutputExpireTimer);
    chat._recentOutputExpireTimer = null;
  }
  if (!chat._lastOutputAt) return;
  const waitMs = chat._lastOutputAt + TERMINAL_RECENT_OUTPUT_MS - Date.now();
  if (waitMs <= 0) {
    renderChatTerminalState(chat);
    scheduleChatListStateRefresh([chat.id]);
    if (chat.id === chatRuntime.activeChatId) chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
    return;
  }
  chat._recentOutputExpireTimer = setTimeout(() => {
    chat._recentOutputExpireTimer = null;
    renderChatTerminalState(chat);
    scheduleChatListStateRefresh([chat.id]);
    if (chat.id === chatRuntime.activeChatId) chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
  }, waitMs + 20);
}

export function applyChatListItemVisualState(li, chat, kind) {
  const disconnectedMeta = { tone: 'disconnected', label: t('status.disconnected') };
  const meta = chat ? getSidebarChatStateMeta(chat) : disconnectedMeta;
  const state = chat ? resolveChatListDotState(meta.tone) : 'disconnected';
  const nextKey = chatListVisualKey(state, meta.tone, meta.label);
  if (kind === 'modal') {
    if (shouldSkipChatListItemWrite(li.dataset.visualKey, nextKey)) return;
    li.dataset.visualKey = nextKey;
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
    return;
  }
  patchSidebarChatRowVisualState(li, chat, {
    t,
    escapeHtml,
    getSidebarChatStateMeta,
  });
}

export function updateChatListModalStates() {
  const byId = buildChatByIdMap(chats);
  updateSidebarChatStates(byId);
  // Settled-group summaries + the active-row highlight live outside the sidebar
  // signature, so a status/refresh frame must repaint them here (the row chips
  // above are the hot path; this is a bounded extra walk, guarded for a hidden
  // drawer). This must run even when the chat-list modal is closed: otherwise a
  // stale active row survives until the next structural render — the "reopen the
  // drawer and the previously active (settled) child is still highlighted" bug.
  if (chatShell.sidebarTransientPatchHook) chatShell.sidebarTransientPatchHook();
  const modal = document.getElementById('chat-list-modal');
  const listEl = document.getElementById('chat-list-items');
  if (!modal || modal.hidden || !listEl) return;
  listEl.querySelectorAll('.chat-list-item').forEach((li) => {
    const id = li.dataset.chatId;
    applyChatListItemVisualState(li, id ? byId.get(id) : null, 'modal');
  });
}

export const chatListStateRefresh = createRafDebouncer(() => {
  updateChatListModalStates();
});

/**
 * Queue an in-place repaint of the named sidebar rows only. A call with no ids, an
 * empty array, or an array that carries no valid id does nothing: it neither plans a
 * frame nor marks the whole list dirty. The full-list branch is driven exclusively by
 * scheduleChatListStateRefreshAll(), which the drawer-open path uses.
 */
export function scheduleChatListStateRefresh(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  let added = false;
  for (const id of ids) {
    if (!id) continue;
    chatShell.pendingSidebarDirtyIds.add(id);
    added = true;
  }
  if (!added) return;
  chatListStateRefresh.schedule();
}

/**
 * Full-list repaint. The wildcard wins over any per-chat ids queued in the same frame.
 * Only the drawer-open path (`openSidebar` -> `refreshStates` -> refreshSidebarChatStates)
 * reaches this; a single chat's status change never does.
 */
export function scheduleChatListStateRefreshAll() {
  chatShell.pendingSidebarDirtyIds.add('*');
  chatListStateRefresh.schedule();
}

/** In-place chat status update in the sidebar (no full re-render). */
export function updateSidebarChatStates(chatById = null) {
  const aside = document.getElementById('app-sidebar');
  const body = aside?.querySelector('.sidebar-body');
  // Requirement 3b: rows rewritten per call, split patchAll vs per-dirty. Guarded at
  // the callsite so an inactive trace allocates/counts nothing (patchAll reads the
  // already-built NodeList length; per-dirty increments only while tracing).
  const trace = isUiFreezeTraceActive();
  const byId = chatById || buildChatByIdMap(chats);
  const dirty = chatShell.pendingSidebarDirtyIds;
  chatShell.pendingSidebarDirtyIds = new Set();
  // A coalesced frame with nothing dirty emits no patch at all — bail before the walk.
  if (dirty.size === 0) return;
  dispatchSidebarChatRowStatusPatch({
    dirty,
    all: dirty.has('*'),
    chatById: byId,
    getSidebarChatStateMeta,
  });
  if (!aside || aside.hidden || !body) return;
  if (dirty.has('*')) {
    const items = body.querySelectorAll('.sidebar-chat-item');
    items.forEach((li) => {
      const id = li.dataset.chatId;
      applyChatListItemVisualState(li, id ? byId.get(id) : null, 'sidebar');
    });
    if (trace) getUiFreezeMetrics()?.recordSidebarPatch({ patchAll: true, rows: items.length });
    return;
  }
  let rewritten = 0;
  for (const id of dirty) {
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(id)
      : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const li = body.querySelector(`.sidebar-chat-item[data-chat-id="${escaped}"]`);
    if (!li) continue;
    if (trace) rewritten += 1;
    applyChatListItemVisualState(li, byId.get(id) || null, 'sidebar');
  }
  if (trace) getUiFreezeMetrics()?.recordSidebarPatch({ patchAll: false, rows: rewritten });
}

export function refreshSidebarChatStates() {
  scheduleChatListStateRefreshAll();
}

export function isTerminalTextareaMode(chat) {
  return !!(chat && chat._terminalInteraction && chat._terminalInteraction.textarea);
}

export function updateAwaitingInput(chat) {
  if (!chat) return { textarea: false, choice: false, awaiting: false };
  if (!chat.term) {
    renderChatTerminalState(chat);
    scheduleChatListStateRefresh([chat.id]);
    if (chat.id === chatRuntime.activeChatId) chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
    return chat._terminalInteraction || { textarea: false, choice: false, awaiting: false };
  }
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
  if (isDebugStatus() && chatRuntime.activeChatId && chat.id === chatRuntime.activeChatId) {
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
  if (isDebugStatus() && chatRuntime.activeChatId && chat.id === chatRuntime.activeChatId) {
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
  scheduleChatListStateRefresh([chat.id]);
  if (chat.id === chatRuntime.activeChatId) chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
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
export function terminalInteractionForStateResolve(chat, interaction) {
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
 * @param {'bar' | 'sidebar'} [surface]
 * @returns {{ tone: string, label: string } | null}
 */
export function resolveSdkChatStateMeta(chat, surface = 'bar') {
  if (!chat?._sdkRichView && !chat?._serverRunState) return null;
  const pending = readHarnessPendingFlags(chat);
  const queuedCount = chat._sdkRichView?.queuedCount || Number(chat._sdkServerQueuedCount) || 0;
  const connection = chat._connectionStatus || 'disconnected';
  const input = {
    surface,
    connection,
    agent: getChatAgentState(chat),
    hasPendingQuestion: pending.hasPendingQuestion,
    hasPendingPermission: pending.hasPendingPermission,
    queuedCount,
    serverRunState: chat._serverRunState || null,
    lastRunStatus: chat._sdkLastRunStatus || '',
    translate: t,
  };
  if (surface === 'sidebar') {
    input.connectingForMs = sidebarStatusStabilizer.connectingForMs(chat.id, connection);
    input.socketExpected = chatExpectsLiveSocket(chat);
  }
  return resolveHarnessChatStateMeta(input);
}

/**
 * @param {object|null|undefined} chat
 * @param {'bar' | 'sidebar'} [surface] Sidebar rows suppress the history-sync
 *   overlay and the short-lived connecting/disconnected churn.
 * @returns {{ tone: string, label: string }}
 */
export function getTerminalStateMeta(chat, surface = 'bar') {
  const sdkMeta = resolveSdkChatStateMeta(chat, surface);
  if (sdkMeta) {
    if (surface === 'sidebar') return sdkMeta;
    return resolveChatStatusWithHistorySync(chat?._historySyncInFlight === true, sdkMeta, t);
  }
  const interaction = terminalInteractionForStateResolve(chat, chat?._terminalInteraction || {});
  const connection = chat?._connectionStatus || 'disconnected';
  const recentOutput = chat?._lastOutputAt && Date.now() - chat._lastOutputAt < TERMINAL_RECENT_OUTPUT_MS;
  const agent = getChatAgentState(chat);
  const state = resolveTerminalState(interaction, connection, agent, recentOutput);
  // status-parser is shared with the backend, so it returns a key instead of a
  // translated label.
  const fallback = state.labelKey ? { ...state, label: t(state.labelKey) } : state;
  if (surface === 'sidebar') return applySidebarConnectionPolicy(fallback, chat);
  return resolveChatStatusWithHistorySync(chat?._historySyncInFlight === true, fallback, t);
}

export function renderChatTerminalState(chat, metaOverride = null) {
  const bar = chat?.sdkModeBarEl;
  if (!bar || chat.id !== chatRuntime.activeChatId) {
    scheduleChatListStateRefresh(chat?.id ? [chat.id] : []);
    return;
  }
  const meta =
    metaOverride ||
    getTerminalStateMeta(chat);
  bar.statusLabel = meta.label;
  bar.statusTone = meta.tone;
  // The active chat keeps a row in the list as well, so repaint that row (was: only
  // the bar). Without the full `*`, nothing else would refresh the active row here.
  scheduleChatListStateRefresh([chat.id]);
  if (isPendingHarnessSwitch(bar, chat)) return;
  bar.model = normalizeModelValue(chat?.model || 'auto');
  chatRuntime.chatDiagnosticsApi?.updateChatContextMeter?.(
    chat,
    chatRuntime.chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || 'auto'),
  );
}

export function renderChatList() {
  // Task 0.1: count full list refreshes. The poll-apply span in
  // chatHistorySyncPoll measures how long the synchronous ones take.
  getUiFreezeCounters()?.bump('ui.renders');
  chatHost.chatView.renderChatList();
  chats.forEach(syncArchivedChatSendUi);
  notifySidebar();
}

export function updateChatBarSelect() {
  chatHost.chatView.updateChatBarSelect();
}

export function closeChatListModal() {
  chatHost.chatView.closeChatListModal();
}

export function closeChatActionsModal() {
  chatHost.chatView.closeChatActionsModal();
}

export function bindChatToolbarActionItem(itemEl, onActivate) {
  if (!itemEl || typeof onActivate !== 'function') return;
  itemEl.addEventListener('click', onActivate);
  itemEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  });
}
