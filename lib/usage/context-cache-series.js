/**
 * Harness-agnostic analysis of the shared context sample stream: turns one
 * chat's samples into a time series and flags where the prompt cache broke.
 * It reads only numeric fields, so any producer of context samples is covered.
 */

const MIN_CACHED_TOKENS = 2000;
const BREAK_RATIO = 0.5;
const TTL_GAP_MS = 5 * 60 * 1000;
const PREFIX_CATEGORIES = ['systemPrompt', 'systemTools', 'mcpTools', 'memory', 'skills', 'instructions', 'agents', 'mcpInstructions'];

function rowTokens(sample, id) {
  const row = sample?.breakdown?.rows?.find((entry) => entry?.id === id);
  return typeof row?.tokens === 'number' ? row.tokens : null;
}

/** True when a category that forms the cached prefix changed between two samples. */
function hasPrefixChanged(previous, current) {
  if (previous.prefixFingerprint && current.prefixFingerprint && previous.prefixFingerprint !== current.prefixFingerprint) return true;
  return PREFIX_CATEGORIES.some((id) => {
    const before = rowTokens(previous, id);
    const after = rowTokens(current, id);
    return before != null && after != null && before !== after;
  });
}

/**
 * Pick the most specific explanation available from neighbouring samples.
 * @returns {'compaction'|'model_change'|'idle_gap'|'prefix_change'|'new_run'|'unknown'}
 */
function classifyBreak(previous, current) {
  if (previous.model && current.model && previous.model !== current.model) return 'model_change';
  if ((previous.contextEpoch ?? 0) !== (current.contextEpoch ?? 0)) return current.contextEpochReason === 'compaction' ? 'compaction' : 'context_reset';
  const gap = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
  if (Number.isFinite(gap) && gap >= TTL_GAP_MS) return 'idle_gap';
  if (hasPrefixChanged(previous, current)) return 'prefix_change';
  if (previous.runId && current.runId && previous.runId !== current.runId) return 'new_run';
  return 'unknown';
}

/**
 * @param {Array<object>} samples context samples of one chat
 * @returns {{ points: object[], breaks: object[], latestBreakdown: object|null }}
 */
export function analyzeContextCacheSeries(samples) {
  const distinct = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    distinct.set(sample.measurementId ? `${sample.chatId}:${sample.contextEpoch ?? 0}:${sample.measurementId}` : `${sample.chatId}:${sample.observedAt}`, sample);
  }
  const ordered = [...distinct.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const points = ordered.map((sample) => ({
    observedAt: sample.observedAt,
    model: sample.model || '',
    runId: sample.runId || '',
    contextEpoch: sample.contextEpoch ?? 0,
    totalTokens: sample.totalTokens,
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens ?? null,
    cacheReadTokens: sample.cacheReadTokens ?? null,
    cacheWriteTokens: sample.cacheWriteTokens ?? null,
    contextWindowTokens: sample.contextWindowTokens ?? null,
    fillPercent: sample.contextWindowTokens > 0 ? sample.totalTokens / sample.contextWindowTokens * 100 : null,
    cachePercent: sample.cacheReadTokens != null && sample.inputTokens > 0 ? sample.cacheReadTokens / sample.inputTokens * 100 : null,
  }));
  const breaks = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const before = previous.cacheReadTokens;
    const after = current.cacheReadTokens;
    if (before == null || after == null || before < MIN_CACHED_TOKENS) continue;
    if (after >= before * BREAK_RATIO) continue;
    // A smaller but still highly cached prompt is not a cache-reuse regression.
    if (!(previous.inputTokens > 0) || !(current.inputTokens > 0)) continue;
    if (after / current.inputTokens >= (before / previous.inputTokens) * BREAK_RATIO) continue;
    // Tokens that had to be processed again instead of being read from cache.
    const rewritten = Math.max(0, current.inputTokens - after);
    breaks.push({
      index, observedAt: current.observedAt, cause: classifyBreak(previous, current),
      cacheReadBefore: before, cacheReadAfter: after, rewrittenTokens: rewritten,
      uncachedInputTokens: rewritten, cacheWriteTokens: current.cacheWriteTokens ?? null, confidence: 'inferred',
      gapMs: Math.max(0, Date.parse(current.observedAt) - Date.parse(previous.observedAt)) || 0,
    });
  }
  // The newest sample that carries a breakdown, so details survive a page reload.
  const withBreakdown = ordered.filter((sample) => sample.breakdown?.rows?.length).pop();
  const latestBreakdown = withBreakdown
    ? { ...withBreakdown.breakdown, observedAt: withBreakdown.observedAt, totalTokens: withBreakdown.totalTokens, contextWindowTokens: withBreakdown.contextWindowTokens ?? null }
    : null;
  return { points, breaks, latestBreakdown };
}
