/**
 * Turns provider-specific usage payloads into the canonical token bag.
 */

import { emptyUsageTokens } from './usage-event.js';

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {Array<{ modality?: string, tokenCount?: unknown }>} rows
 * @param {string} modality
 * @returns {number}
 */
function sumModality(rows, modality) {
  if (!Array.isArray(rows)) return 0;
  const wanted = String(modality || '').toUpperCase();
  return rows
    .filter((row) => String(row?.modality || '').toUpperCase() === wanted)
    .reduce((sum, row) => sum + toCount(row.tokenCount), 0);
}

/**
 * @param {object} current
 * @param {object} previous
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function deltaTokens(current, previous = emptyUsageTokens()) {
  const next = emptyUsageTokens();
  const prev = previous && typeof previous === 'object' ? previous : emptyUsageTokens();
  for (const key of Object.keys(next)) {
    next[key] = Math.max(0, toCount(current?.[key]) - toCount(prev[key]));
  }
  return next;
}

/**
 * OpenAI Realtime `response.done` usage. Cached tokens sit inside audio/text totals.
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromOpenAiRealtimeUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  const inputDetails = usage.input_token_details || {};
  const outputDetails = usage.output_token_details || {};
  const cachedDetails = inputDetails.cached_tokens_details || {};
  const cached = toCount(inputDetails.cached_tokens);
  const audioInput = toCount(inputDetails.audio_tokens);
  const textInput = toCount(inputDetails.text_tokens);
  const cachedAudio = toCount(cachedDetails.audio_tokens);
  const cachedText = toCount(cachedDetails.text_tokens);
  tokens.cachedInput = cached;
  tokens.audioInput = Math.max(0, audioInput - (cachedAudio || 0));
  tokens.textInput = Math.max(0, textInput - (cachedText || 0));
  tokens.audioOutput = toCount(outputDetails.audio_tokens);
  tokens.textOutput = toCount(outputDetails.text_tokens);
  return tokens;
}

/**
 * Gemini Live `usageMetadata` is cumulative. `previousTokens` is the last snapshot.
 *
 * @param {object} usage
 * @param {object} [previousTokens]
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromGeminiLiveUsage(usage, previousTokens = emptyUsageTokens()) {
  if (!usage || typeof usage !== 'object') return emptyUsageTokens();
  const details = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails : [];
  const outDetails = Array.isArray(usage.candidatesTokensDetails)
    ? usage.candidatesTokensDetails
    : [];
  const current = emptyUsageTokens();
  current.audioInput = sumModality(details, 'AUDIO');
  current.textInput = sumModality(details, 'TEXT');
  current.audioOutput = sumModality(outDetails, 'AUDIO');
  current.textOutput = sumModality(outDetails, 'TEXT');
  return deltaTokens(current, previousTokens);
}

/**
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function readGeminiLiveCumulative(usage) {
  const current = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return current;
  const details = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails : [];
  const outDetails = Array.isArray(usage.candidatesTokensDetails)
    ? usage.candidatesTokensDetails
    : [];
  current.audioInput = sumModality(details, 'AUDIO');
  current.textInput = sumModality(details, 'TEXT');
  current.audioOutput = sumModality(outDetails, 'AUDIO');
  current.textOutput = sumModality(outDetails, 'TEXT');
  return current;
}

/**
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromOpenRouterUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  tokens.textInput = toCount(usage.prompt_tokens ?? usage.input_tokens);
  tokens.textOutput = toCount(usage.completion_tokens ?? usage.output_tokens);
  tokens.cachedInput = toCount(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  return tokens;
}

/**
 * Cursor SDK `usage` snapshot (usually per turn).
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromSdkUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  tokens.textInput = toCount(usage.inputTokens);
  tokens.textOutput = toCount(usage.outputTokens);
  tokens.cachedInput = toCount(usage.cacheReadTokens);
  tokens.reasoning = toCount(usage.reasoningTokens);
  return tokens;
}
