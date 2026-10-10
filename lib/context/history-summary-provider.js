/**
 * Concrete cheap-model wiring for `history-summary.js`.
 *
 * The summarizer itself is pure and takes an injected `summarize(prompt, opts)`
 * seam. This module provides that seam by REUSING the existing one-shot chat
 * title provider (`chat-title-providers.js`), which already resolves to a cheap
 * model for whichever harness is configured:
 *
 * - OpenRouter: `openai/gpt-4o-mini` (or the configured `autoTitle.model`)
 * - DeepSeek:   `deepseek-flash`
 * - Qwen:       the provider default
 * - Codex:      `gpt-4o-mini` / configured plan model
 * - Claude:     `claude-haiku-4-5` / `haiku` on a subscription
 *
 * No premium model is called and no temporary chat is created. The title
 * adapters were built for one-line titles (a 60-token completion cap); the
 * summary passes a larger `maxOutputTokens` through the optional passthrough on
 * `generateTitleViaProvider`, so the fixed structure is not truncated.
 *
 * Caveat (documented, not hidden): the Claude-subscription and ChatGPT-plan
 * adapters run one-shot agents with a title-specific system prompt. They return
 * the model text, but an operator who needs a long structured summary should
 * configure an HTTP-key provider (OpenRouter / DeepSeek / Qwen / Anthropic).
 *
 * Tests never import this module: they inject a fake `summarize` into the pure
 * module, so unit tests stay network-free.
 */

import { generateTitleViaProvider } from '../chat-title-providers.js';
import { createHistorySummarizer } from './history-summary.js';

/**
 * Completion budget for a structured summary. A five-section summary with
 * pointers is a few hundred tokens; the cap is headroom, not a target.
 */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2000;

/** Human-readable list of the cheap models the reused seam resolves to. */
export const CHEAP_SUMMARY_MODEL_HINT =
  'Reuses the auto-title provider: gpt-4o-mini (OpenRouter), deepseek-flash, the Qwen default, or Claude Haiku.';

/**
 * Injectable `summarize` seam backed by the existing cheap one-shot provider.
 *
 * Returns `''` when no provider is available, which
 * `summarizeHistoryFromOriginals` reports as an invalid/empty parse instead of
 * throwing.
 *
 * @param {string} prompt
 * @param {{ model?: string, signal?: AbortSignal, maxOutputTokens?: number }} [options]
 * @returns {Promise<string>}
 */
export async function summarizeViaCheapProvider(prompt, options = {}) {
  const text = await generateTitleViaProvider({
    prompt,
    model: options.model,
    signal: options.signal,
    maxOutputTokens: options.maxOutputTokens ?? SUMMARY_MAX_OUTPUT_TOKENS,
  });
  return typeof text === 'string' ? text : '';
}

/**
 * Composes the pure summarizer with the cheap provider seam. Pass `summarize`
 * to override (tests / a different cheap provider).
 *
 * @param {{
 *   summarize?: (prompt: string, options: { signal?: AbortSignal }) => Promise<string> | string,
 *   defaults?: { chatId?: string, keepsLastN?: number, contextEpoch?: number },
 * }} [deps]
 * @returns {ReturnType<typeof createHistorySummarizer>}
 */
export function createCheapHistorySummarizer(deps = {}) {
  return createHistorySummarizer({
    summarize: deps.summarize || summarizeViaCheapProvider,
    defaults: deps.defaults,
  });
}
