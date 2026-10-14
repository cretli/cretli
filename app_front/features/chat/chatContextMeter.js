import {
  buildContextPressureAssessment,
  estimateContextFillPercentForWindow,
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
  delete chat._contextMeasuredTokens;
  delete chat._contextMeasuredUpdatedAt;
  delete chat._contextMeasuredWindowTokens;
  delete chat._contextBreakdown;
  delete chat._contextCacheReadTokens;
  delete chat._contextCacheInputTokens;
  delete chat._codexContextSignature;
  delete chat._codexContextObservedAt;
  chat._contextHistoryHydrated = true;
  if (options.markFreshSession === true) {
    chat._sdkContextFreshSession = true;
  } else {
    delete chat._sdkContextFreshSession;
  }
}

/**
 * Apply the latest Codex CLI call, including cached prompt tokens and generated output.
 * @param {object|null|undefined} chat
 * @param {object|null|undefined} event
 * @returns {boolean}
 */
export function applyCodexMeasuredContextUsage(chat, event) {
  if (chat?.agentTransport !== 'codex' || !event) return false;
  const signature = JSON.stringify(event);
  const observedAt = Date.parse(event.observedAt);
  if (signature === chat._codexContextSignature) return false;
  if (Number.isFinite(observedAt) && observedAt < Number(chat._codexContextObservedAt)) return false;
  if (event.reset) {
    resetChatContextMeterState(chat, { reason: 'compaction', markFreshSession: true });
    chat._codexContextSignature = signature;
    chat._codexContextObservedAt = observedAt;
    return true;
  }
  const totalTokens = readPositiveTokenValue(event.usage?.totalTokens);
  const inputTokens = readReportedTokenCount(event.usage?.inputTokens);
  if (totalTokens == null || inputTokens == null) return false;
  chat._codexContextSignature = signature;
  chat._codexContextObservedAt = observedAt;
  const previousModel = chat._contextUsageModelId;
  const previousPeak = readPercentValue(chat._contextPeakFillPercent);
  delete chat._sdkContextFreshSession;
  storeMeasuredContext(chat, totalTokens, event.model, Number.isFinite(observedAt) ? observedAt : Date.now(), event.contextWindowTokens);
  chat._contextUsageInputTokens = inputTokens;
  chat._contextUsageOutputTokens = readReportedTokenCount(event.usage.outputTokens);
  chat._contextUsageTotalTokens = totalTokens;
  const cached = readReportedTokenCount(event.usage.cacheReadTokens);
  chat._contextCacheReadTokens = cached != null && cached <= inputTokens ? cached : null;
  chat._contextBreakdown = event.breakdown || null;
  chat._contextUsageSource = 'codex-measured';
  chat._contextUsageUpdatedAt = chat._contextMeasuredUpdatedAt;
  delete chat._contextFillPercent;
  const fillPercent = estimateContextFillPercentForWindow(totalTokens, chat._contextMeasuredWindowTokens);
  if (fillPercent != null) {
    chat._contextPeakFillPercent = Math.max(fillPercent, previousModel === chat._contextUsageModelId ? previousPeak || 0 : 0);
  } else delete chat._contextPeakFillPercent;
  const pressure = buildContextPressureAssessment({ modelId: chat._contextUsageModelId, contextWindowTokens: chat._contextMeasuredWindowTokens, lastUsageInputTokens: totalTokens });
  chat._contextWarnings = pressure.warnings;
  chat._contextLikelyPressure = pressure.likelyContextPressure;
  return true;
}

/**
 * Records the newest main-thread Claude API call as the measured context.
 * `usage.totalTokens` is that call's prompt plus its output: the transcript as
 * the next call will read it, minus tool results appended after the call.
 *
 * @param {object|null|undefined} chat
 * @param {{ totalTokens?: unknown } | null | undefined} usage
 * @param {unknown} model concrete model id of that call
 * @param {unknown} [contextWindowTokens] window the SDK reported for that model
 * @returns {boolean} true when a measurement was stored
 */
export function applyClaudeMeasuredContextUsage(chat, usage, model, contextWindowTokens = null) {
  if (!isClaudeContextMeterChat(chat)) return false;
  const tokens = readPositiveTokenValue(usage?.totalTokens);
  if (tokens == null) return false;
  delete chat._sdkContextFreshSession;
  storeMeasuredContext(chat, tokens, model, Date.now(), contextWindowTokens);
  const cached = readReportedTokenCount(usage?.cacheReadTokens);
  const input = readReportedTokenCount(usage?.inputTokens);
  // A run-level usage event can omit the cache split; keep the last measured one.
  if (cached != null && input != null && cached <= input) {
    chat._contextCacheReadTokens = cached;
    chat._contextCacheInputTokens = input;
  }
  return true;
}

/**
 * Attach the SDK per-category breakdown that belongs to the latest measured call.
 * @param {object|null|undefined} chat
 * @param {object|null|undefined} breakdown
 * @returns {boolean}
 */
export function applyClaudeContextBreakdown(chat, breakdown) {
  if (!isClaudeContextMeterChat(chat) || !breakdown || !Array.isArray(breakdown.rows)) return false;
  chat._contextBreakdown = breakdown;
  return true;
}

/**
 * One-shot hydration from persisted history. A reset or a live measurement
 * always wins, so a stored value never replaces what the session has since seen.
 *
 * @param {object|null|undefined} chat
 * @param {{ lastCallContextTokens?: unknown, lastCallModel?: unknown, lastCallContextWindowTokens?: unknown } | null | undefined} history
 * @returns {boolean} true when the stored value was applied
 */
export function applyClaudeHistoryContextUsage(chat, history) {
  if (!isClaudeContextMeterChat(chat) || chat._contextHistoryHydrated === true) return false;
  chat._contextHistoryHydrated = true;
  if (readPositiveTokenValue(chat._contextMeasuredTokens) != null) {
    return adoptClaudeHistoryContextWindow(chat, history);
  }
  const tokens = readPositiveTokenValue(history?.lastCallContextTokens);
  if (tokens == null) return false;
  storeMeasuredContext(chat, tokens, history.lastCallModel, null, history.lastCallContextWindowTokens);
  return true;
}

/**
 * A live call measured before the process learned the model's window keeps its
 * token count but takes the window the last stored run reported for that model.
 *
 * @param {object} chat
 * @param {{ lastCallModel?: unknown, lastCallContextWindowTokens?: unknown } | null | undefined} history
 * @returns {boolean} true when a window was adopted
 */
function adoptClaudeHistoryContextWindow(chat, history) {
  if (readPositiveTokenValue(chat._contextMeasuredWindowTokens) != null) return false;
  const reportedWindow = readPositiveTokenValue(history?.lastCallContextWindowTokens);
  if (reportedWindow == null) return false;
  if (normalizeModelValue(history.lastCallModel) !== chat._contextUsageModelId) return false;
  chat._contextMeasuredWindowTokens = reportedWindow;
  return true;
}

/**
 * @param {object} chat
 * @param {number} tokens
 * @param {unknown} model
 * @param {number|null} measuredAt
 * @param {unknown} contextWindowTokens
 */
function storeMeasuredContext(chat, tokens, model, measuredAt, contextWindowTokens) {
  chat._contextMeasuredTokens = tokens;
  if (measuredAt) chat._contextMeasuredUpdatedAt = measuredAt;
  else delete chat._contextMeasuredUpdatedAt;
  const concreteModel = normalizeModelValue(model);
  const modelChanged = Boolean(concreteModel)
    && concreteModel !== 'auto'
    && concreteModel !== chat._contextUsageModelId;
  if (modelChanged) chat._contextUsageModelId = concreteModel;
  // A live call is sent without a window until the first run of the process
  // reports one; keep the last reported window while the model is unchanged.
  const reportedWindow = readPositiveTokenValue(contextWindowTokens);
  if (reportedWindow != null) chat._contextMeasuredWindowTokens = reportedWindow;
  else if (modelChanged) delete chat._contextMeasuredWindowTokens;
}

/**
 * The SDK-reported window of a Claude chat wins over the per-model table: one
 * model id runs on a 200K or a 1M window depending on the account.
 *
 * @param {object|null|undefined} chat
 * @param {string} modelId
 * @returns {number|null}
 */
export function resolveChatContextWindowTokens(chat, modelId) {
  if (isClaudeContextMeterChat(chat) || chat?.agentTransport === 'codex') {
    const reportedWindow = readPositiveTokenValue(chat?._contextMeasuredWindowTokens);
    if (reportedWindow != null) return reportedWindow;
  }
  return readPositiveTokenValue(getModelContextWindowTokens(modelId));
}

/**
 * @param {object|null|undefined} chat
 * @returns {{ inputTokens: number|null, estimated: boolean, provenance: ContextFillProvenance }}
 */
export function resolveChatContextUsage(chat) {
  if (isClaudeContextMeterChat(chat) || chat?.agentTransport === 'codex') {
    return resolveMeasuredChatContextUsage(chat);
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
 * Claude and Codex occupancy is the newest main-thread API call;
 * the run-level `usage` total sums every call and is not a context size. Without
 * a measurement we fall back to the local transcript estimate or no data.
 *
 * @param {object|null|undefined} chat
 * @returns {{ inputTokens: number|null, estimated: boolean, provenance: ContextFillProvenance }}
 */
function resolveMeasuredChatContextUsage(chat) {
  const measuredTokens = readPositiveTokenValue(chat?._contextMeasuredTokens);
  if (measuredTokens != null) {
    return { inputTokens: measuredTokens, estimated: false, provenance: 'measured' };
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
 * @param {(inputTokens: number|null|undefined, modelId: string, percent: number|null|undefined, estimated?: boolean, provenance?: ContextFillProvenance, isClaude?: boolean, windowTokens?: number|null) => string} formatLabel
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
  const occupancyTokens = readPositiveTokenValue(usage.inputTokens);
  const isCodex = chat?.agentTransport === 'codex';
  const inputTokens = isCodex && !usage.estimated
    ? readReportedTokenCount(chat?._contextUsageInputTokens) : occupancyTokens;
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
  const windowTokens = resolveChatContextWindowTokens(chat, modelId);
  let fillPercent = occupancyTokens != null
    ? estimateContextFillPercentForWindow(occupancyTokens, windowTokens)
    : null;
  if (!isClaude && !isCodex) {
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
    breakdown: chat?._contextBreakdown || null,
    cacheReadTokens: (isCodex || isClaude) && !isEstimated ? readReportedTokenCount(chat?._contextCacheReadTokens) : null,
    cacheInputTokens: isClaude && !isEstimated ? readReportedTokenCount(chat?._contextCacheInputTokens) : null,
    fillPercent: readPercentValue(fillPercent),
    peakFillPercent,
    pressureLevel,
    likelyPressure: !isClaude && chat?._contextLikelyPressure === true,
    warnings,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : null,
    contextMeterEpoch: Number.isFinite(epochRaw) && epochRaw > 0 ? Math.floor(epochRaw) : null,
    label: formatLabel(occupancyTokens, modelId, fillPercent, isEstimated, fillProvenance, isClaude, windowTokens),
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
 * @param {(key: string, params?: object) => string} t
 * @param {number|null|undefined} inputTokens
 * @param {string} modelId
 * @param {number|null|undefined} percent
 * @param {boolean} [estimated]
 * @param {ContextFillProvenance} [provenance]
 * @param {boolean} [isClaude]
 * @param {number|null} [contextWindowTokens] resolved window; defaults to the model table
 * @returns {string}
 */
export function formatChatContextUsageLabel(
  t,
  inputTokens,
  modelId,
  percent,
  estimated = false,
  provenance = estimated ? 'estimated' : 'measured',
  isClaude = false,
  contextWindowTokens = null,
) {
  if (provenance === 'none' || inputTokens == null) {
    return t('chat.contextMeterNoData');
  }
  const isEstimate = provenance === 'estimated' || estimated;
  const inputLabel = formatContextTokenCount(inputTokens);
  if (percent == null) {
    return t(
      isEstimate ? 'chat.contextMeterEstimatedTokensNoWindow' : 'chat.contextMeterTokensNoWindow',
      { input: inputLabel },
    );
  }
  const percentLabel = percent.toFixed(1);
  const windowTokens = contextWindowTokens ?? getModelContextWindowTokens(modelId);
  if (Number.isFinite(windowTokens) && windowTokens > 0) {
    let key = 'chat.contextMeter';
    if (isEstimate) {
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

  function formatLocalizedContextUsageLabel(inputTokens, modelId, percent, estimated, provenance, isClaude, windowTokens) {
    return formatChatContextUsageLabel(t, inputTokens, modelId, percent, estimated, provenance, isClaude, windowTokens);
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
      bar.contextVisible = snapshot.fillPercent != null;
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
