import {
  estimateContextFillPercent,
  formatContextTokenCount,
  getContextPressureLevel,
  getModelContextWindowTokens,
  readReportedTokenCount,
  resolveExactTotalTokens,
} from '../../../lib/sdk/sdk-context-advisory.js';
import { getContextMeterVisualState, updateChatContextAdvisoryUi } from './chatContextAdvisory.js';
import { normalizeModelValue } from './chatSettingsPrefs.js';

/**
 * @param {object|null|undefined} chat
 * @returns {{ inputTokens: number|null, estimated: boolean }}
 */
export function resolveChatContextUsage(chat) {
  const reportedTokens = Number(chat?._contextUsageInputTokens);
  if (Number.isFinite(reportedTokens) && reportedTokens > 0) {
    return { inputTokens: reportedTokens, estimated: false };
  }
  if (chat?._sdkContextFreshSession === true) {
    return { inputTokens: null, estimated: false };
  }
  const richText =
    typeof chat?._sdkRichView?.getCopyText === 'function'
      ? String(chat._sdkRichView.getCopyText() || '')
      : '';
  const transcript = richText.trim() || String(chat?._buffer || '').trim();
  if (!transcript) return { inputTokens: null, estimated: false };
  return {
    inputTokens: Math.max(1, Math.ceil(transcript.length / 4)),
    estimated: true,
  };
}

/**
 * @param {object|null|undefined} chat
 * @param {unknown} modelIdOrPayload
 * @returns {string}
 */
export function resolveContextMeterModelId(chat, modelIdOrPayload = null) {
  const payload = typeof modelIdOrPayload === 'object' && modelIdOrPayload ? modelIdOrPayload : null;
  const explicitModel = typeof modelIdOrPayload === 'string' ? modelIdOrPayload : null;
  const candidates = [
    chat?._contextUsageModelId,
    payload?.room?.modelId,
    payload?.model,
    explicitModel,
    chat?.model,
    chat?.sdkModeBarEl?.model,
  ];
  for (const raw of candidates) {
    const normalized = normalizeModelValue(raw);
    if (normalized && normalized !== 'auto') return normalized;
  }
  return normalizeModelValue(chat?.model || explicitModel || 'auto');
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function readPositiveTokenValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function readPercentValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 10) / 10;
}

/**
 * @param {object|null|undefined} chat
 * @param {{ estimated: boolean, hasReportedUsage: boolean }} usageState
 * @returns {string}
 */
export function resolveChatContextUsageSource(chat, usageState) {
  const transport = String(chat?.agentTransport || 'sdk').trim() || 'sdk';
  const explicitSource = String(chat?._contextUsageSource || '').trim();
  if (usageState.estimated) {
    if (transport === 'opencode') return 'opencode-estimated';
    return `${transport}-estimated`;
  }
  if (explicitSource) return explicitSource;
  if (usageState.hasReportedUsage) {
    if (transport === 'sdk') return 'sdk-live';
    return `${transport}-live`;
  }
  return `${transport}-unknown`;
}

/**
 * @param {object|null|undefined} chat
 * @param {unknown} modelIdOrPayload
 * @param {(inputTokens: number|null|undefined, modelId: string, percent: number|null|undefined, estimated?: boolean) => string} formatLabel
 * @returns {{
 *   transport: string,
 *   modelId: string,
 *   source: string,
 *   isEstimated: boolean,
 *   inputTokens: number|null,
 *   outputTokens: number|null,
 *   totalTokens: number|null,
 *   contextWindowTokens: number|null,
 *   fillPercent: number|null,
 *   peakFillPercent: number|null,
 *   pressureLevel: string,
 *   likelyPressure: boolean,
 *   warnings: string[],
 *   updatedAt: number|null,
 *   label: string,
 * }}
 */
export function buildChatContextSnapshot(chat, modelIdOrPayload, formatLabel = () => '') {
  const modelId = resolveContextMeterModelId(chat, modelIdOrPayload);
  const usage = resolveChatContextUsage(chat);
  const reportedInputTokens = readPositiveTokenValue(chat?._contextUsageInputTokens);
  const inputTokens = readPositiveTokenValue(usage.inputTokens);
  const isEstimated = usage.estimated === true;
  const outputTokens = isEstimated ? null : readReportedTokenCount(chat?._contextUsageOutputTokens);
  const totalTokens = isEstimated
    ? null
    : resolveExactTotalTokens({
        inputTokens,
        outputTokens,
        totalTokens: chat?._contextUsageTotalTokens,
      });
  const windowTokens = readPositiveTokenValue(getModelContextWindowTokens(modelId));
  let fillPercent = estimateContextFillPercent(inputTokens, modelId);
  const serverFillPercent = readPercentValue(chat?._contextFillPercent);
  if (serverFillPercent != null) fillPercent = serverFillPercent;
  const peakFillPercent = readPercentValue(chat?._contextPeakFillPercent);
  const hasReportedUsage = reportedInputTokens != null;
  const source = resolveChatContextUsageSource(chat, {
    estimated: isEstimated,
    hasReportedUsage,
  });
  const updatedAt = Number(chat?._contextUsageUpdatedAt);
  const pressureLevel = getContextPressureLevel(fillPercent);
  const warnings = Array.isArray(chat?._contextWarnings)
    ? chat._contextWarnings.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  return {
    transport: String(chat?.agentTransport || 'sdk').trim() || 'sdk',
    modelId,
    source,
    isEstimated,
    inputTokens,
    outputTokens,
    totalTokens,
    contextWindowTokens: windowTokens,
    fillPercent: readPercentValue(fillPercent),
    peakFillPercent,
    pressureLevel,
    likelyPressure: chat?._contextLikelyPressure === true,
    warnings,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : null,
    label: formatLabel(inputTokens, modelId, fillPercent, isEstimated),
  };
}

/**
 * @typedef {Object} ChatContextMeterDeps
 * @property {(key: string, params?: object) => string} t
 * @property {(chat: object, fillPercent: number|null|undefined) => void} maybeScheduleAutoContextCompression
 * @property {(chat: object, hintEl?: Element|null) => (void|Promise<boolean>)} runIntentionalSummary
 */

/**
 * @param {ChatContextMeterDeps} deps
 */
export function createChatContextMeter(deps) {
  const { t, maybeScheduleAutoContextCompression, runIntentionalSummary } = deps;

  /**
   * @param {number|null|undefined} inputTokens
   * @param {string} modelId
   * @param {number|null|undefined} percent
   * @param {boolean} [estimated]
   */
  function formatLocalizedContextUsageLabel(inputTokens, modelId, percent, estimated = false) {
    if (percent == null) return '';
    const percentLabel = percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1);
    const windowTokens = getModelContextWindowTokens(modelId);
    const inputLabel = formatContextTokenCount(inputTokens);
    if (Number.isFinite(windowTokens) && windowTokens > 0) {
      const key = estimated ? 'chat.contextMeterEstimated' : 'chat.contextMeter';
      return t(key, {
        percent: percentLabel,
        input: inputLabel,
        window: formatContextTokenCount(windowTokens),
      });
    }
    return t('chat.contextMeterTokensOnly', {
      percent: percentLabel,
      input: inputLabel,
    });
  }

  /**
   * @param {number|null|undefined} percent
   * @param {string} label
   */
  function setChatContextMeter(percent, label) {
    const meter = document.getElementById('chat-context-meter');
    if (!meter) return;
    const fill = meter.querySelector('.chat-context-meter-fill');
    const visual = getContextMeterVisualState(percent);
    const usagePercent = Number(percent);
    const hasPercent = Number.isFinite(usagePercent) && usagePercent >= 0;
    if (fill) fill.style.width = `${visual.fillWidth.toFixed(3)}%`;
    meter.classList.toggle('has-usage', hasPercent && visual.fillWidth > 0);
    meter.classList.toggle('is-warn', visual.level === 'warn');
    meter.classList.toggle('is-danger', visual.level === 'danger');
    meter.classList.toggle('is-critical', visual.level === 'critical');
    meter.classList.toggle('is-overlimit', visual.isOverLimit);
    meter.setAttribute('aria-valuenow', hasPercent ? usagePercent.toFixed(2) : '0');
    if (label) {
      meter.setAttribute('title', label);
      meter.setAttribute('aria-label', label);
    }
  }

  /**
   * @param {object|null|undefined} chat
   * @param {string|null|undefined} modelId
   */
  function updateChatContextMeter(chat, modelId) {
    const snapshot = buildChatContextSnapshot(chat, modelId, formatLocalizedContextUsageLabel);
    if (chat && typeof chat === 'object') {
      chat._contextUsageSnapshot = snapshot;
    }
    setChatContextMeter(snapshot.fillPercent, snapshot.label);
    if (chat?.sdkModeBarEl) {
      const bar = chat.sdkModeBarEl;
      if (bar.activeChatId && chat?.id && String(bar.activeChatId) !== String(chat.id)) {
        return;
      }
      bar.contextPercent = snapshot.fillPercent;
      bar.contextLevel = snapshot.pressureLevel;
      bar.contextLabel = snapshot.label || t('chat.contextDetailsOpen');
      bar.contextEstimated = snapshot.isEstimated;
      bar.contextVisible = snapshot.inputTokens != null || snapshot.fillPercent != null;
    }
    maybeScheduleAutoContextCompression(chat, snapshot.fillPercent);
    updateChatContextAdvisoryUi({
      chat,
      fillPercent: snapshot.fillPercent,
      label: snapshot.label,
      likelyPressure: snapshot.likelyPressure,
      richView: chat?._sdkRichView ?? null,
      t,
      onSummarize: () => {
        const hint = document.getElementById('chat-toolbar-status-hint');
        void runIntentionalSummary(chat, hint);
      },
      onDismiss: () => {},
    });
  }

  return {
    resolveContextMeterModelId,
    resolveChatContextUsage,
    buildChatContextSnapshot,
    resolveChatContextUsageSource,
    updateChatContextMeter,
    setChatContextMeter,
  };
}
