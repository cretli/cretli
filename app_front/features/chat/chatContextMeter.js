import {
  estimateContextFillPercent,
  estimateTokensFromText,
  formatContextTokenCount,
  getContextPressureLevel,
  getModelContextWindowTokens,
  readReportedTokenCount,
  resolveExactTotalTokens,
} from '../../../lib/sdk/sdk-context-advisory.js';
import { getContextMeterVisualState, updateChatContextAdvisoryUi } from './chatContextAdvisory.js';
import { normalizeModelValue } from './chatSettingsPrefs.js';

/** @typedef {'measured' | 'estimated' | 'none'} ContextFillProvenance */

/**
 * @param {object|null|undefined} chat
 * @returns {boolean}
 */
export function isClaudeContextMeterChat(chat) {
  return String(chat?.agentTransport || '').trim() === 'claude';
}

/**
 * Clears context-meter fields after compaction, session reset, or model change.
 * Run-level usage on the chat object is dropped so a mixed-plane ratio cannot
 * survive into the next context epoch (see docs/claude/sdk-limits-context-contract.md §6).
 *
 * @param {object|null|undefined} chat
 * @param {{ reason?: string, markFreshSession?: boolean }} [options]
 */
export function resetChatContextMeterState(chat, options = {}) {
  if (!chat || typeof chat !== 'object') return;
  const reason = String(options.reason || '').trim();
  const prevEpoch = Number(chat._contextMeterEpoch);
  chat._contextMeterEpoch = Number.isFinite(prevEpoch) && prevEpoch >= 0
    ? Math.floor(prevEpoch) + 1
    : 1;
  if (reason) chat._contextMeterBoundaryReason = reason;
  else delete chat._contextMeterBoundaryReason;
  chat._contextUsageInputTokens = null;
  chat._contextUsageOutputTokens = null;
  chat._contextUsageTotalTokens = null;
  delete chat._contextUsageSource;
  delete chat._contextUsageUpdatedAt;
  delete chat._contextUsageSnapshot;
  delete chat._contextFillPercent;
  delete chat._contextPeakFillPercent;
  delete chat._contextLikelyPressure;
  delete chat._contextWarnings;
  delete chat._contextUsageModelId;
  delete chat._contextMeasuredFillPercent;
  delete chat._contextMeasuredInputTokens;
  delete chat._contextMeasuredUpdatedAt;
  if (options.markFreshSession === true) {
    chat._sdkContextFreshSession = true;
  } else {
    delete chat._sdkContextFreshSession;
  }
}

/**
 * @param {object|null|undefined} chat
 * @returns {{ inputTokens: number|null, estimated: boolean, provenance: ContextFillProvenance }}
 */
export function resolveChatContextUsage(chat) {
  if (isClaudeContextMeterChat(chat)) {
    return resolveClaudeChatContextUsage(chat);
  }
  const reportedTokens = Number(chat?._contextUsageInputTokens);
  if (Number.isFinite(reportedTokens) && reportedTokens > 0) {
    return { inputTokens: reportedTokens, estimated: false, provenance: 'measured' };
  }
  if (chat?._sdkContextFreshSession === true) {
    return { inputTokens: null, estimated: false, provenance: 'none' };
  }
  const richText =
    typeof chat?._sdkRichView?.getCopyText === 'function'
      ? String(chat._sdkRichView.getCopyText() || '')
      : '';
  const transcript = richText.trim() || String(chat?._buffer || '').trim();
  if (!transcript) return { inputTokens: null, estimated: false, provenance: 'none' };
  return {
    inputTokens: Math.max(1, estimateTokensFromText(transcript)),
    estimated: true,
    provenance: 'estimated',
  };
}

/**
 * Claude run `usage` is plane 2 (per-turn main-loop totals), not current context
 * occupancy (contract §2, §6). Only SDK-confirmed context_usage / getContextUsage
 * may set measured fill; until then we expose local transcript estimate or no data.
 *
 * @param {object|null|undefined} chat
 * @returns {{ inputTokens: number|null, estimated: boolean, provenance: ContextFillProvenance }}
 */
function resolveClaudeChatContextUsage(chat) {
  const measuredPercent = readPercentValue(chat?._contextMeasuredFillPercent);
  if (measuredPercent != null) {
    const measuredInput = readPositiveTokenValue(chat?._contextMeasuredInputTokens);
    return {
      inputTokens: measuredInput,
      estimated: false,
      provenance: 'measured',
    };
  }
  if (chat?._sdkContextFreshSession === true) {
    return { inputTokens: null, estimated: false, provenance: 'none' };
  }
  const richText =
    typeof chat?._sdkRichView?.getCopyText === 'function'
      ? String(chat._sdkRichView.getCopyText() || '')
      : '';
  const transcript = richText.trim() || String(chat?._buffer || '').trim();
  if (!transcript) return { inputTokens: null, estimated: false, provenance: 'none' };
  return {
    inputTokens: Math.max(1, estimateTokensFromText(transcript)),
    estimated: true,
    provenance: 'estimated',
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
 * @param {{ estimated: boolean, hasReportedUsage: boolean, fillProvenance: ContextFillProvenance }} usageState
 * @returns {string}
 */
export function resolveChatContextUsageSource(chat, usageState) {
  const transport = String(chat?.agentTransport || 'sdk').trim() || 'sdk';
  const explicitSource = String(chat?._contextUsageSource || '').trim();
  if (transport === 'claude') {
    if (usageState.fillProvenance === 'measured') return 'claude-measured';
    if (usageState.fillProvenance === 'estimated') return 'claude-estimated';
    return 'claude-no-data';
  }
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
 * @param {(inputTokens: number|null|undefined, modelId: string, percent: number|null|undefined, estimated?: boolean, provenance?: ContextFillProvenance, isClaude?: boolean) => string} formatLabel
 * @returns {{
 *   transport: string,
 *   modelId: string,
 *   source: string,
 *   isEstimated: boolean,
 *   fillProvenance: ContextFillProvenance,
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
 *   contextMeterEpoch: number|null,
 *   label: string,
 * }}
 */
export function buildChatContextSnapshot(chat, modelIdOrPayload, formatLabel = () => '') {
  const modelId = resolveContextMeterModelId(chat, modelIdOrPayload);
  const usage = resolveChatContextUsage(chat);
  const fillProvenance = usage.provenance;
  const isClaude = isClaudeContextMeterChat(chat);
  const reportedInputTokens = isClaude
    ? null
    : readPositiveTokenValue(chat?._contextUsageInputTokens);
  const inputTokens = readPositiveTokenValue(usage.inputTokens);
  const isEstimated = usage.estimated === true;
  const outputTokens = isEstimated || isClaude
    ? null
    : readReportedTokenCount(chat?._contextUsageOutputTokens);
  const totalTokens = isEstimated || isClaude
    ? null
    : resolveExactTotalTokens({
        inputTokens,
        outputTokens,
        totalTokens: chat?._contextUsageTotalTokens,
      });
  const windowTokens = readPositiveTokenValue(getModelContextWindowTokens(modelId));
  let fillPercent = null;
  if (fillProvenance === 'measured') {
    const measuredPercent = readPercentValue(chat?._contextMeasuredFillPercent);
    if (measuredPercent != null) {
      fillPercent = measuredPercent;
    } else if (inputTokens != null) {
      fillPercent = estimateContextFillPercent(inputTokens, modelId);
    }
  } else if (fillProvenance === 'estimated' && inputTokens != null) {
    fillPercent = estimateContextFillPercent(inputTokens, modelId);
  }
  if (!isClaude) {
    const serverFillPercent = readPercentValue(chat?._contextFillPercent);
    if (serverFillPercent != null) fillPercent = serverFillPercent;
  }
  const peakFillPercent = isClaude ? null : readPercentValue(chat?._contextPeakFillPercent);
  const hasReportedUsage = reportedInputTokens != null;
  const source = resolveChatContextUsageSource(chat, {
    estimated: isEstimated,
    hasReportedUsage,
    fillProvenance,
  });
  const updatedAt = isClaude
    ? readContextMeterUpdatedAt(chat, fillProvenance)
    : Number(chat?._contextUsageUpdatedAt);
  const pressureLevel = getContextPressureLevel(fillPercent);
  const warnings = Array.isArray(chat?._contextWarnings) && !isClaude
    ? chat._contextWarnings.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  const epochRaw = Number(chat?._contextMeterEpoch);
  return {
    transport: String(chat?.agentTransport || 'sdk').trim() || 'sdk',
    modelId,
    source,
    isEstimated,
    fillProvenance,
    inputTokens,
    outputTokens,
    totalTokens,
    contextWindowTokens: windowTokens,
    fillPercent: readPercentValue(fillPercent),
    peakFillPercent,
    pressureLevel,
    likelyPressure: !isClaude && chat?._contextLikelyPressure === true,
    warnings,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : null,
    contextMeterEpoch: Number.isFinite(epochRaw) && epochRaw > 0 ? Math.floor(epochRaw) : null,
    label: formatLabel(inputTokens, modelId, fillPercent, isEstimated, fillProvenance, isClaude),
  };
}

/**
 * @param {object|null|undefined} chat
 * @param {ContextFillProvenance} fillProvenance
 * @returns {number|null}
 */
function readContextMeterUpdatedAt(chat, fillProvenance) {
  if (fillProvenance === 'measured') {
    const measuredAt = Number(chat?._contextMeasuredUpdatedAt);
    if (Number.isFinite(measuredAt) && measuredAt > 0) return measuredAt;
  }
  if (fillProvenance === 'estimated') return Date.now();
  return null;
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
   * @param {ContextFillProvenance} [provenance]
   * @param {boolean} [isClaude]
   */
  function formatLocalizedContextUsageLabel(
    inputTokens,
    modelId,
    percent,
    estimated = false,
    provenance = estimated ? 'estimated' : 'measured',
    isClaude = false,
  ) {
    if (provenance === 'none' || percent == null) {
      return t('chat.contextMeterNoData');
    }
    const percentLabel = percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1);
    const windowTokens = getModelContextWindowTokens(modelId);
    const inputLabel = formatContextTokenCount(inputTokens);
    if (Number.isFinite(windowTokens) && windowTokens > 0) {
      let key = 'chat.contextMeter';
      if (provenance === 'estimated' || estimated) {
        key = 'chat.contextMeterEstimated';
      } else if (isClaude && provenance === 'measured') {
        key = 'chat.contextMeterMeasured';
      }
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
      bar.contextVisible = snapshot.fillProvenance !== 'none' || snapshot.fillPercent != null;
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
    resetChatContextMeterState,
    isClaudeContextMeterChat,
  };
}
