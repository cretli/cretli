/**
 * Browser-safe context advisory helpers (no Node fs/path).
 * Server-only stats live in sdk-context-stats.js.
 */

export const CONTEXT_ADVISORY_WARN_PERCENT = 75;
export const CONTEXT_ADVISORY_DANGER_PERCENT = 85;
export const CONTEXT_ADVISORY_CRITICAL_PERCENT = 100;
const DYNAMIC_MODEL_CONTEXT_WINDOWS = new Map();

/**
 * @param {unknown} modelId
 * @returns {string[]}
 */
function buildModelLookupKeys(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  if (!raw) return [];
  const withoutParams = raw.includes('::') ? raw.split('::')[0] : raw;
  const keys = [withoutParams];
  const slashIndex = withoutParams.indexOf('/');
  if (slashIndex > 0 && slashIndex < withoutParams.length - 1) {
    keys.push(withoutParams.slice(slashIndex + 1));
  }
  return Array.from(new Set(keys));
}

/**
 * @param {unknown} modelId
 * @returns {number | null}
 */
function getDynamicModelContextWindowTokens(modelId) {
  const keys = buildModelLookupKeys(modelId);
  for (const key of keys) {
    const value = Number(DYNAMIC_MODEL_CONTEXT_WINDOWS.get(key));
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return null;
}

/**
 * Registers runtime-discovered context windows, e.g. from OpenCode model metadata.
 *
 * @param {unknown} rows
 */
export function setDynamicModelContextWindows(rows) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const contextWindowTokens = Number(
      row.contextWindowTokens ?? row.contextWindow ?? row.contextLimitTokens
    );
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) continue;
    const rawCandidates = [row.id, row.modelId, row.value];
    for (const candidate of rawCandidates) {
      const keys = buildModelLookupKeys(candidate);
      for (const key of keys) {
        DYNAMIC_MODEL_CONTEXT_WINDOWS.set(key, Math.round(contextWindowTokens));
      }
    }
  }
}

/**
 * @param {unknown} modelId
 * @returns {number | null}
 */
export function getModelContextWindowTokens(modelId) {
  const model = String(modelId || '').trim().toLowerCase();
  if (!model || model === 'auto') return null;
  const dynamicLimit = getDynamicModelContextWindowTokens(model);
  if (Number.isFinite(dynamicLimit) && dynamicLimit > 0) return dynamicLimit;
  const modelCandidates = buildModelLookupKeys(model);
  const defaults = [
    ['gpt-5', 272000],
    ['composer-2', 272000],
    ['claude-opus-4', 200000],
    ['claude-sonnet-4', 200000],
    ['claude-haiku-4', 200000],
    ['gemini-3', 1048576],
    ['gemini-2', 1048576],
    ['kimi-k2', 256000],
    ['glm-5', 128000],
    ['grok-4.6', 500000],
    ['grok-4.5', 500000],
    ['grok-', 256000],
    ['x-preview-f-free', 1000000],
    ['hy3-free', 190000],
  ];
  for (const candidate of modelCandidates) {
    for (const [prefix, limit] of defaults) {
      if (candidate.startsWith(prefix)) return limit;
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatContextTokenCount(value) {
  if (value == null) return '—';
  if (typeof value === 'string' && value.trim() === '') return '—';
  if (typeof value === 'boolean') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(numeric));
}

/**
 * Reads a reported token count. Distinguishes missing values from explicit 0.
 * Callers must not coerce with Number() first — `Number(null) === 0`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function readReportedTokenCount(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

/**
 * Resolves billed/session total for exact usage. Missing or 0 total falls back to input + output.
 *
 * @param {{
 *   inputTokens?: unknown,
 *   outputTokens?: unknown,
 *   totalTokens?: unknown,
 * }} input
 * @returns {number | null}
 */
export function resolveExactTotalTokens(input = {}) {
  const reportedTotal = readReportedTokenCount(input.totalTokens);
  if (reportedTotal != null && reportedTotal > 0) return reportedTotal;
  const inputTokens = readReportedTokenCount(input.inputTokens);
  if (inputTokens == null || inputTokens <= 0) return reportedTotal;
  const outputTokens = readReportedTokenCount(input.outputTokens);
  return inputTokens + (outputTokens ?? 0);
}

/**
 * Finds the latest SDK usage payload, preferring an in-memory cache over the event log.
 *
 * @param {Array<{ payload?: unknown } | Record<string, unknown>> | null | undefined} entries
 * @param {unknown} cachedUsage
 * @returns {Record<string, unknown> | null}
 */
export function findLastUsageEventPayload(entries, cachedUsage = null) {
  if (cachedUsage && typeof cachedUsage === 'object' && !Array.isArray(cachedUsage)) {
    return /** @type {Record<string, unknown>} */ (cachedUsage);
  }
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const payload =
      entry && typeof entry === 'object' && 'payload' in entry ? entry.payload : entry;
    if (!payload || typeof payload !== 'object' || payload.type !== 'sdkEvent') continue;
    const event = payload.event;
    if (!event || typeof event !== 'object' || event.type !== 'usage') continue;
    if (!event.usage || typeof event.usage !== 'object') continue;
    return event.usage;
  }
  return null;
}

/**
 * @param {unknown} inputTokens
 * @param {unknown} modelId
 * @returns {number | null}
 */
export function estimateContextFillPercent(inputTokens, modelId) {
  const used = Number(inputTokens);
  if (!Number.isFinite(used) || used <= 0) return null;
  const windowTokens = getModelContextWindowTokens(modelId);
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return null;
  const percent = (used / windowTokens) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.round(percent * 10) / 10);
}

/**
 * @param {unknown} fillPercent
 * @returns {number}
 */
export function getContextMeterFillPercent(fillPercent) {
  const numeric = Number(fillPercent);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.min(100, numeric));
}

/**
 * @param {unknown} fillPercent
 * @returns {'none' | 'ok' | 'warn' | 'danger' | 'critical'}
 */
export function getContextPressureLevel(fillPercent) {
  const numeric = Number(fillPercent);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'none';
  if (numeric >= CONTEXT_ADVISORY_CRITICAL_PERCENT) return 'critical';
  if (numeric >= CONTEXT_ADVISORY_DANGER_PERCENT) return 'danger';
  if (numeric >= CONTEXT_ADVISORY_WARN_PERCENT) return 'warn';
  if (numeric >= 65) return 'ok';
  return 'ok';
}

/**
 * @param {{
 *   inputTokens?: unknown,
 *   modelId?: unknown,
 *   fillPercent?: unknown,
 *   estimated?: boolean,
 * }} input
 * @returns {string}
 */
export function formatContextUsageLabel(input = {}) {
  const fillPercent = Number(input.fillPercent);
  if (!Number.isFinite(fillPercent) || fillPercent <= 0) return '';
  const modelId = String(input.modelId || '').trim();
  const windowTokens = getModelContextWindowTokens(modelId);
  const estimated = input.estimated === true;
  const prefix = estimated ? 'Estimated context' : 'Context';
  const tokenPrefix = estimated ? '~' : '';
  const percentLabel = fillPercent > 0 && fillPercent < 0.1 ? '<0.1' : fillPercent.toFixed(1);
  const inputTokens = Number(input.inputTokens);
  if (Number.isFinite(windowTokens) && windowTokens > 0 && Number.isFinite(inputTokens)) {
    return `${prefix}: ${percentLabel}% (${tokenPrefix}${formatContextTokenCount(inputTokens)} / ${formatContextTokenCount(windowTokens)} tokens)`;
  }
  if (Number.isFinite(inputTokens)) {
    return `${prefix}: ${percentLabel}% (${tokenPrefix}${formatContextTokenCount(inputTokens)} input tokens)`;
  }
  return `${prefix}: ${percentLabel}%`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeContextAdvisoryWarnPercent(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return CONTEXT_ADVISORY_WARN_PERCENT;
  return Math.min(95, Math.max(50, parsed));
}

/**
 * @param {{ contextAdvisoryEnabled?: unknown }} chat
 * @returns {boolean}
 */
export function isContextAdvisoryEnabled(chat) {
  if (!chat || typeof chat !== 'object') return true;
  if (chat.contextAdvisoryEnabled === false) return false;
  return true;
}

/**
 * @param {unknown} fillPercent
 * @param {unknown} warnPercent
 * @returns {boolean}
 */
export function shouldSuggestContextMaintenance(fillPercent, warnPercent) {
  const numeric = Number(fillPercent);
  if (!Number.isFinite(numeric)) return false;
  return numeric >= normalizeContextAdvisoryWarnPercent(warnPercent);
}

/**
 * Resolves current agent context usage for advisory/meter.
 * After SDK context reset the live room has no usage yet — do not fall back to persisted history.
 *
 * @param {{
 *   chat?: { sdkAgentId?: unknown } | null,
 *   room?: { lastUsageInputTokens?: unknown } | null,
 *   historyStats?: {
 *     lastEffectiveUsageInputTokens?: unknown,
 *     lastUsageInputTokens?: unknown,
 *   } | null,
 * }} input
 * @returns {number | null}
 */
export function resolveLiveContextUsageInputTokens(input = {}) {
  const room = input.room && typeof input.room === 'object' ? input.room : null;
  const historyStats =
    input.historyStats && typeof input.historyStats === 'object' ? input.historyStats : null;
  const chat = input.chat && typeof input.chat === 'object' ? input.chat : null;
  const roomUsage = Number(room?.lastUsageInputTokens);
  if (room) {
    if (Number.isFinite(roomUsage) && roomUsage > 0) return roomUsage;
    return null;
  }
  if (!chat?.sdkAgentId) return null;
  const historyUsage = Number(
    historyStats?.lastEffectiveUsageInputTokens ?? historyStats?.lastUsageInputTokens
  );
  if (Number.isFinite(historyUsage) && historyUsage > 0) return historyUsage;
  return null;
}

/**
 * Estimates non-cached input tokens (input minus cache reads when reported).
 *
 * @param {unknown} inputTokens
 * @param {unknown} cacheReadTokens
 * @returns {number | null}
 */
export function estimateEffectiveUsageInputTokens(inputTokens, cacheReadTokens) {
  const input = Number(inputTokens);
  if (!Number.isFinite(input) || input <= 0) return null;
  const cacheRead = Number(cacheReadTokens);
  if (Number.isFinite(cacheRead) && cacheRead > 0 && cacheRead < input) {
    return Math.max(0, Math.round(input - cacheRead));
  }
  return Math.round(input);
}

/**
 * @param {unknown} inputTokens
 * @param {unknown} windowTokens
 * @returns {number | null}
 */
function computeContextFillPercent(inputTokens, windowTokens) {
  const used = Number(inputTokens);
  const window = Number(windowTokens);
  if (!Number.isFinite(used) || used <= 0 || !Number.isFinite(window) || window <= 0) {
    return null;
  }
  return Math.round((used / window) * 1000) / 10;
}

/**
 * @param {{
 *   modelId?: unknown,
 *   lastUsageInputTokens?: unknown,
 *   maxUsageInputTokens?: unknown,
 *   rawLastUsageInputTokens?: unknown,
 *   rawMaxUsageInputTokens?: unknown,
 *   localStoreTotalBytes?: unknown,
 *   headSeq?: unknown,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildContextPressureAssessment(input = {}) {
  const modelId = String(input.modelId || '').trim();
  const windowTokens = getModelContextWindowTokens(modelId);
  const lastInputTokens = Number(input.lastUsageInputTokens);
  const maxInputTokens = Number(input.maxUsageInputTokens);
  const rawLastInputTokens = Number(input.rawLastUsageInputTokens);
  const rawMaxInputTokens = Number(input.rawMaxUsageInputTokens);
  const currentInputTokens =
    Number.isFinite(lastInputTokens) && lastInputTokens > 0 ? lastInputTokens : null;
  const peakInputTokens =
    Number.isFinite(maxInputTokens) && maxInputTokens > 0 ? maxInputTokens : null;
  const localStoreBytes = Number(input.localStoreTotalBytes);
  const headSeq = Number(input.headSeq);
  const contextFillPercent = computeContextFillPercent(currentInputTokens, windowTokens);
  const peakContextFillPercent = computeContextFillPercent(peakInputTokens, windowTokens);
  const warnings = [];
  if (contextFillPercent != null && contextFillPercent >= CONTEXT_ADVISORY_WARN_PERCENT) {
    warnings.push('context_fill_high');
  }
  if (contextFillPercent != null && contextFillPercent >= CONTEXT_ADVISORY_CRITICAL_PERCENT) {
    warnings.push('context_over_model_window');
  }
  if (peakContextFillPercent != null && peakContextFillPercent >= CONTEXT_ADVISORY_CRITICAL_PERCENT) {
    warnings.push('context_peak_over_model_window');
  }
  if (Number.isFinite(localStoreBytes) && localStoreBytes >= 50 * 1024 * 1024) {
    warnings.push('local_store_large');
  }
  if (Number.isFinite(headSeq) && headSeq >= 8000) {
    warnings.push('history_head_seq_large');
  }
  const pressureWarnings = warnings.filter(
    (warning) => warning === 'context_fill_high' || warning === 'context_over_model_window'
  );
  return {
    modelId: modelId || null,
    contextWindowTokens: windowTokens,
    lastUsageInputTokens: currentInputTokens,
    maxUsageInputTokens: peakInputTokens,
    rawLastUsageInputTokens:
      Number.isFinite(rawLastInputTokens) && rawLastInputTokens > 0 ? rawLastInputTokens : null,
    rawMaxUsageInputTokens:
      Number.isFinite(rawMaxInputTokens) && rawMaxInputTokens > 0 ? rawMaxInputTokens : null,
    contextFillPercent,
    peakContextFillPercent,
    localStoreTotalBytes: Number.isFinite(localStoreBytes) ? localStoreBytes : null,
    headSeq: Number.isFinite(headSeq) ? headSeq : null,
    warnings,
    likelyContextPressure: pressureWarnings.length > 0,
  };
}
