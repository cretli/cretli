/** Context details modal: countdowns, tabs and server refresh. */
import { tickCacheCountdowns } from '../chatContextCacheCountdownView.js';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { getHarnessUiMeta } from '../../../core/harness/harnessUiRegistry.js';
import { describeContextQualityRows } from '../chatContextQuality.js';
import { chatRuntime } from '../state/chatRuntimeState.js';
import { chatHost } from '../services/chatHost.js';

export function formatContextDetailsPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  return `${numeric.toFixed(1)}%`;
}

export function formatContextDetailsUpdatedAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  return new Date(numeric).toLocaleString();
}

export function resolveContextDetailsSourceLabel(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'sdk-live') return t('chat.contextDetailsSourceSdkLive');
  if (normalized === 'sdk-history') return t('chat.contextDetailsSourceSdkHistory');
  if (normalized === 'codex-measured') return t('chat.contextDetailsSourceCodexMeasured');
  if (normalized === 'claude-measured') return t('chat.contextDetailsSourceClaudeMeasured');
  if (normalized === 'claude-estimated') return t('chat.contextDetailsSourceClaudeEstimated');
  if (normalized === 'claude-no-data') return t('chat.contextDetailsSourceClaudeNoData');
  if (normalized === 'opencode-estimated') return t('chat.contextDetailsSourceOpencodeEstimated');
  if (normalized.endsWith('-estimated')) return t('chat.contextDetailsSourceEstimated');
  if (normalized.endsWith('-history')) return t('chat.contextDetailsSourceHistory');
  if (normalized.endsWith('-live')) return t('chat.contextDetailsSourceLive');
  return t('chat.contextDetailsSourceUnknown');
}

export function resolveContextDetailsTransportLabel(transport) {
  const normalized = String(transport || '').trim().toLowerCase();
  const labelKey = getHarnessUiMeta(normalized)?.contextTransportLabelKey;
  if (labelKey) return t(labelKey);
  return normalized || '—';
}

export function resolveContextDetailsWarningLabel(code) {
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

export function renderContextQualityRows(snapshot, setText) {
  const rows = describeContextQualityRows(snapshot, t);
  for (const [id, value] of Object.entries(rows)) setText(`chat-context-details-q-${id}`, value);
}

async function refreshChatContextDetailsFromServer(chat) {
  if (!chat?.id) return;
  try {
    const res = await api.getChatDiag(chat.id);
    if (!res?.ok) return;
    chatRuntime.chatDiagnosticsApi?.applyServerContextUsageFromDiag?.(chat, res);
  } catch (_) {
    // Best-effort refresh for details modal.
  }
  chatHost.renderChatContextDetails(chat);
}

async function refreshChatContextPlanLimits(chat) {
  try {
    chat._contextPlanLimits = chat.agentTransport === 'claude'
      ? await api.getClaudePlanLimits(chat.id)
      : await api.getCodexPlanLimits();
  } catch (_) {
    chat._contextPlanLimits = { available: false, reason: 'read-failed' };
  }
  if (chatRuntime.activeChatId === chat.id) chatHost.renderChatContextDetails(chat);
}

let chatContextCountdownTimer = null;

let chatContextFreshnessTimer = null;

function stopChatContextCountdown() {
  clearInterval(chatContextCountdownTimer);
  clearInterval(chatContextFreshnessTimer);
  chatContextCountdownTimer = null;
  chatContextFreshnessTimer = null;
}

/** Read the server-side expiry estimate and tick it locally once per second while the dialog is open. */
async function refreshChatContextCacheCountdown(chat) {
  try {
    const res = await api.getUsageCacheFreshness(chat.id);
    chat._cacheCountdown = res?.ok ? res.countdown || null : null;
  } catch (_) {
    chat._cacheCountdown = null;
  }
  if (chatRuntime.activeChatId === chat.id) chatHost.renderChatContextDetails(chat);
}

function startChatContextCountdown(chat) {
  stopChatContextCountdown();
  void refreshChatContextCacheCountdown(chat);
  chatContextCountdownTimer = setInterval(() => {
    const modal = document.getElementById('chat-context-details-modal');
    if (!modal || modal.hidden) { stopChatContextCountdown(); return; }
    tickCacheCountdowns(modal);
  }, 1000);
  // New calls move the expiry; re-read it so the countdown follows them.
  chatContextFreshnessTimer = setInterval(() => void refreshChatContextCacheCountdown(chat), 15000);
}

/** Shared by every harness: reads the common context sample stream for this chat. */
async function refreshChatContextSeries(chat) {
  try {
    const res = await api.getContextCacheSeries(chat.id);
    chat._contextCacheSeries = res?.ok ? { points: res.points, breaks: res.breaks, compactions: res.compactions || [], latestBreakdown: res.latestBreakdown || null } : null;
  } catch (_) {
    chat._contextCacheSeries = null;
  }
  if (chatRuntime.activeChatId === chat.id) chatHost.renderChatContextDetails(chat);
}

/** Show one tab of the context details dialog; tabs are plain buttons with data-context-tab. */
function selectChatContextTab(tabId) {
  const modal = document.getElementById('chat-context-details-modal');
  if (!modal) return;
  modal.querySelectorAll('[data-context-tab]').forEach((button) => {
    const active = button.dataset.contextTab === tabId;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  modal.querySelectorAll('[data-context-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.contextPanel !== tabId;
  });
}

export function bindChatContextTabs() {
  document.getElementById('chat-context-details-modal')?.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement | null} */ (event.target instanceof Element ? event.target.closest('[data-context-tab]') : null);
    if (!button) return;
    selectChatContextTab(button.dataset.contextTab);
    if (button.dataset.contextTab === 'chatcontext') {
      const panel = /** @type {any} */ (document.getElementById('chat-context-details-chatcontext'));
      if (panel) {
        panel.chatId = chatRuntime.activeChatId || '';
        void panel.refresh?.();
      }
    }
  });
}

export function openChatContextDetailsModal(chat) {
  if (!chat) return;
  selectChatContextTab('overview');
  startChatContextCountdown(chat);
  void refreshChatContextSeries(chat);
  chatHost.renderChatContextDetails(chat);
  chatRuntime.chatContextDetailsModalApi?.open();
  void refreshChatContextDetailsFromServer(chat);
  if (chat.agentTransport === 'codex' || chat.agentTransport === 'claude') void refreshChatContextPlanLimits(chat);
}

export function closeChatContextDetailsModal() {
  stopChatContextCountdown();
  chatRuntime.chatContextDetailsModalApi?.close();
}
