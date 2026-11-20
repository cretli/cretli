/**
 * Advice for resuming a chat whose prompt cache has likely expired.
 *
 * Pure: it makes no model request and reads no state. The route resolves the
 * cache view, settings, billing mode and run state and passes them in.
 */

import { CACHE_TTL_TABLE } from './cache-state.ts';
import { estimateTokenRates } from './usage-rates.js';
import { decodeModelValue } from '../model-catalog.js';
import { SUMMARY_LIMITS } from '../context/history-summary.ts';

const TOKENS_PER_MILLION = 1e6;
const USD_DECIMALS = 4;

/** Harnesses with a firm Anthropic-style price table; others stay unpriced. */
const PRICED_HARNESSES = new Set(['claude']);

/** Rough chars-per-token ratio for sizing the summary prompt. */
const CHARS_PER_TOKEN = 4;
/** Completion headroom of the summary call (mirrors SUMMARY_MAX_OUTPUT_TOKENS). */
const SUMMARY_OUTPUT_TOKENS = 2000;
/** Price reference for the cheap summary model when the harness is priced. */
const SUMMARY_PRICE_MODEL = 'claude-haiku-4-5';

/**
 * Upper-bound estimate of the opt-in "new chat with summary" call: the prompt is
 * capped at maxTranscriptChars, so the cost does not grow with the context.
 *
 * @param {{ harness: string, billingMode?: string }} input
 * @param {number} contextTokens
 * @returns {{ tokens: number, usd: number|null }}
 */
function estimateSummaryCall(input, contextTokens) {
  const tokens = Math.min(contextTokens, Math.ceil(SUMMARY_LIMITS.maxTranscriptChars / CHARS_PER_TOKEN));
  if (!PRICED_HARNESSES.has(input.harness) || input.billingMode === 'subscription') return { tokens, usd: null };
  const rates = estimateTokenRates(SUMMARY_PRICE_MODEL, '');
  if (!rates || !(rates.textInput > 0) || !(rates.textOutput > 0)) return { tokens, usd: null };
  const usd = (tokens * rates.textInput + SUMMARY_OUTPUT_TOKENS * rates.textOutput) / TOKENS_PER_MILLION;
  return { tokens, usd: Number(usd.toFixed(USD_DECIMALS)) };
}

/**
 * @param {Array<Record<string, any>>} samples
 * @returns {Record<string, any>|null} newest sample of the newest context epoch
 */
function latestSample(samples) {
  const list = (Array.isArray(samples) ? samples : []).slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  return list.length ? list[list.length - 1] : null;
}

/**
 * @param {{ harness: string, model?: string, provider?: string, billingMode?: string }} input
 * @param {number} contextTokens
 * @returns {{ usd: number|null, basis: string }}
 */
function estimateRewriteUsd(input, contextTokens) {
  if (!PRICED_HARNESSES.has(input.harness)) return { usd: null, basis: 'unpriced_harness' };
  if (input.billingMode === 'subscription') return { usd: null, basis: 'subscription' };
  const modelId = decodeModelValue(input.model || '').modelId;
  const rates = estimateTokenRates(modelId, input.provider || '');
  if (!rates || !(rates.textInput > 0)) return { usd: null, basis: 'no_rates' };
  const usd = (contextTokens * rates.textInput) / TOKENS_PER_MILLION;
  return { usd: Number(usd.toFixed(USD_DECIMALS)), basis: 'lower_bound_text_input' };
}

/**
 * @param {Record<string, any>} input
 * @param {string} input.harness
 * @param {string} [input.model]
 * @param {string} [input.provider]
 * @param {string} [input.billingMode]
 * @param {Record<string, any>} input.freshness result of `getCacheFreshness`
 * @param {Record<string, any>} input.countdown result of `buildCacheCountdown`
 * @param {Array<Record<string, any>>} [input.samples]
 * @param {{ enabled?: boolean, minContextTokens?: number }} [input.settings]
 * @param {boolean} [input.runActive]
 * @returns {Record<string, any>}
 */
export function buildResumeAdvice(input: Record<string, any> = {}) {
  const settings = input.settings || {};
  const enabled = settings.enabled !== false;
  const sample = latestSample(input.samples);
  const live = input.freshness?.context?.inputTokens;
  const contextTokens = Number.isFinite(live) && live > 0 ? live : (sample?.inputTokens > 0 ? sample.inputTokens : null);
  const contextWindowTokens = sample?.contextWindowTokens > 0 ? sample.contextWindowTokens : null;
  const cacheState = input.freshness?.cache?.state;
  const state = cacheState === 'cold' || (cacheState === 'unknown' && input.countdown?.state === 'cold')
    ? 'cold'
    : (cacheState === 'warm' ? 'warm' : 'unknown');
  const lastCachedTurnAt = input.freshness?.cache?.lastCachedTurnAt ?? input.countdown?.lastCachedTurnAt ?? null;
  const base = {
    show: false,
    reason: '',
    enabled,
    state,
    contextTokens,
    contextWindowTokens,
    fillRatio: contextTokens && contextWindowTokens ? Number((contextTokens / contextWindowTokens).toFixed(4)) : null,
    lastCachedTurnAt,
    estimatedRewriteUsd: null,
    estimateBasis: 'none',
    estimatedSummaryTokens: null,
    estimatedSummaryUsd: null,
  };
  if (!enabled) return { ...base, reason: 'disabled' };
  if (!CACHE_TTL_TABLE[input.harness]?.ttlKnown) return { ...base, reason: 'ttl_unknown' };
  if (input.runActive !== false) return { ...base, reason: 'run_active' };
  if (state !== 'cold' || lastCachedTurnAt == null) return { ...base, reason: state === 'warm' ? 'cache_warm' : 'cache_unknown' };
  if (contextTokens == null) return { ...base, reason: 'no_context_size' };
  const min = Number.isFinite(settings.minContextTokens) ? settings.minContextTokens : 0;
  if (contextTokens < min) return { ...base, reason: 'below_threshold' };
  const cost = estimateRewriteUsd(input, contextTokens);
  const summary = estimateSummaryCall(input, contextTokens);
  return {
    ...base,
    show: true,
    reason: 'cold_large_context',
    estimatedRewriteUsd: cost.usd,
    estimateBasis: cost.basis,
    estimatedSummaryTokens: summary.tokens,
    estimatedSummaryUsd: summary.usd,
  };
}
