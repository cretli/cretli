/**
 * Turns provider-specific usage payloads into the canonical token bag.
 */

import { emptyUsageTokens } from './usage-event.js';
import { resolveUsageContract } from './usage-contract.js';

/**
 * Shape a harness delivers at the adapter boundary.
 *
 * `raw` means the adapter must translate provider snake_case fields; `resolved`
 * means the harness already sends the canonical camelCase shape. Callers must
 * branch on this instead of assuming one shape and subtracting cache twice.
 *
 * @param {unknown} harness
 * @returns {'raw'|'resolved'|null}
 */
export function resolveHarnessUsageShape(harness) {
  return resolveUsageContract(harness).usageShape;
}

/**
 * How the harness relates reasoning to output: `subset_of_output` (subtract),
 * `separate` (additive) or `unknown` (diagnostic only, never additive).
 *
 * @param {unknown} harness
 * @returns {'subset_of_output'|'separate'|'unknown'}
 */
export function resolveHarnessReasoningRelation(harness) {
  return resolveUsageContract(harness).reasoningRelation;
}

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
 * OpenRouter / OpenAI-compatible `usage`. `prompt_tokens` already contains
 * `prompt_tokens_details.cached_tokens`, so the cached subset is split out to
 * keep the stored bag disjoint (stage 2 verified the relation).
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromOpenRouterUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  const cached = toCount(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const prompt = toCount(usage.prompt_tokens ?? usage.input_tokens);
  tokens.cachedInput = cached;
  tokens.textInput = Math.max(0, prompt - cached);
  tokens.textOutput = toCount(usage.completion_tokens ?? usage.output_tokens);
  return tokens;
}

/**
 * Mistral chat-completions `usage` (OpenAI-compatible): `prompt_tokens`
 * contains the cached subset, which is split out to keep the bag disjoint.
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromMistralUsage(usage) {
  return fromOpenRouterUsage(usage);
}

/**
 * Codex `turn.completed` usage (OpenAI Responses shape). `input_tokens`
 * already contains cached tokens, so cached input is split out to avoid
 * charging it twice.
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromCodexUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  const cached = toCount(
    usage.cached_input_tokens
      ?? usage.cachedInputTokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
  );
  const cacheWrite = toCount(usage.cache_write_input_tokens ?? usage.cacheWriteInputTokens);
  const input = toCount(usage.prompt_tokens ?? usage.input_tokens);
  tokens.cachedInput = cached;
  tokens.cacheWrite = cacheWrite;
  tokens.textInput = Math.max(0, input - cached - cacheWrite);
  tokens.textOutput = toCount(usage.completion_tokens ?? usage.output_tokens);
  tokens.reasoning = toCount(usage.reasoning_output_tokens ?? usage.reasoning_tokens);
  return tokens;
}

/**
 * Qwen Code SDK `result` usage (`ExtendedUsage` shape: snake_case).
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromQwenUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  const cacheRead = toCount(usage.cache_read_input_tokens);
  const cacheWrite = toCount(usage.cache_creation_input_tokens ?? usage.cacheWriteTokens);
  tokens.cachedInput = cacheRead;
  tokens.cacheWrite = cacheWrite;
  tokens.textInput = Math.max(0, toCount(usage.input_tokens) - cacheRead - cacheWrite);
  tokens.textOutput = toCount(usage.output_tokens);
  return tokens;
}

/**
 * DeepSeek Harness `TokenUsage` — `assistant/message.usage` in DSH session
 * events or a raw DeepSeek wire `usage` payload.
 *
 * DSH normalizes usage to camelCase and makes the counts DISJOINT:
 * `inputTokens` already excludes `cacheReadTokens`, so it maps straight to
 * `textInput`. A raw wire payload (snake_case) keeps DeepSeek's convention
 * where `prompt_tokens` INCLUDES cache hits (`prompt_tokens =
 * prompt_cache_hit_tokens + prompt_cache_miss_tokens`), so cache reads are
 * subtracted out to avoid charging them twice.
 *
 * @param {object} usage
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromDeepSeekUsage(usage) {
  const tokens = emptyUsageTokens();
  if (!usage || typeof usage !== 'object') return tokens;
  if (usage.inputTokens != null || usage.outputTokens != null) {
    tokens.cachedInput = toCount(usage.cacheReadTokens);
    tokens.cacheWrite = toCount(usage.cacheWriteTokens);
    tokens.textInput = toCount(usage.inputTokens);
    tokens.textOutput = toCount(usage.outputTokens);
    tokens.reasoning = toCount(usage.reasoningTokens);
    return tokens;
  }
  const cacheRead = toCount(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  tokens.cachedInput = cacheRead;
  tokens.textInput = Math.max(0, toCount(usage.prompt_tokens) - cacheRead);
  tokens.textOutput = toCount(usage.completion_tokens);
  tokens.reasoning = toCount(usage.completion_tokens_details?.reasoning_tokens);
  return tokens;
}

/**
 * OpenCode `AssistantMessage.tokens` shape: `{ input, output, reasoning, cache: { read, write } }`.
 * Counts are disjoint: `input` is non-cached prompt tokens; `cache.read` is billed separately.
 *
 * @param {object} tokens
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromOpenCodeUsage(tokens) {
  const out = emptyUsageTokens();
  if (!tokens || typeof tokens !== 'object') return out;
  out.textInput = toCount(tokens.input);
  out.cachedInput = toCount(tokens.cache?.read);
  out.cacheWrite = toCount(tokens.cache?.write);
  out.textOutput = toCount(tokens.output);
  out.reasoning = toCount(tokens.reasoning);
  return out;
}

/**
 * Claude resolved usage (already normalized by `resolveClaudeResultUsage`).
 * `inputTokens` is the full prompt: uncached input plus cache reads and cache
 * writes. Both cache buckets are split out so the stored bag is disjoint.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} [resolved]
 * @returns {ReturnType<typeof emptyUsageTokens>}
 */
export function fromClaudeUsage(resolved) {
  const tokens = emptyUsageTokens();
  if (!resolved || typeof resolved !== 'object') return tokens;
  const cacheRead = toCount(resolved.cacheReadTokens);
  const cacheWrite = toCount(resolved.cacheWriteTokens);
  tokens.cachedInput = cacheRead;
  tokens.cacheWrite = cacheWrite;
  tokens.textInput = Math.max(0, toCount(resolved.inputTokens) - cacheRead - cacheWrite);
  tokens.textOutput = toCount(resolved.outputTokens);
  return tokens;
}

/**
 * Cursor SDK `SDKUsageMessage.usage` — a per-turn token snapshot.
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
  tokens.cacheWrite = toCount(usage.cacheWriteTokens);
  tokens.reasoning = toCount(usage.reasoningTokens);
  return tokens;
}

/**
 * Legacy events only have an API provider. `voice` is the harness behind the
 * OpenAI/Google/Azure voice providers in this ledger; anything unknown stays
 * `unknown` so summaries can surface it instead of silently dropping it.
 */
const PROVIDER_HARNESS = Object.freeze({
  cursor: 'sdk',
  openrouter: 'openrouter',
  mistral: 'mistral',
  openai: 'voice',
  google: 'voice',
  azure: 'voice',
});

/**
 * @param {unknown} provider
 * @returns {string}
 */
export function mapProviderToHarness(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return PROVIDER_HARNESS[key] || 'unknown';
}
