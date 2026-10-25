/**
 * "New chat with summary" flow of the cheap-resume banner.
 *
 * Opt-in only: this runs solely from an explicit user click (POST
 * /api/chats/:id/fork-with-summary), never from the advice endpoint. It makes one
 * cheap-model call over the ORIGINAL saved events, then creates a reference-mode
 * chat whose first prompt is the rendered seed (summary + cretli-ref pointers).
 *
 * Any summary failure (provider error, empty/invalid answer, closed gate, stale
 * context epoch) degrades to a plain reference chat and reports `summaryFallback`
 * so the UI can show why. The seed is never persisted or written into a live session.
 */

import { executeConversationFork } from '../conversation-fork-execute.js';
import { loadChatHistory } from '../persist/chat-history-service.js';
import { summarizeChatHistoryUsage } from '../persist/chat-history-usage.js';
import { buildNewSessionSeedPrompt, resolveSummaryEpochGuard, resolveSummaryGate } from './history-summary.ts';
import { createCheapHistorySummarizer } from './history-summary-provider.ts';

/** Machine-readable reasons the summary was skipped and a plain reference chat was made. */
export const SUMMARY_FALLBACK = Object.freeze({
  GATE_BLOCKED: 'summary_gate_blocked',
  PROVIDER_ERROR: 'summary_provider_error',
  INVALID_SUMMARY: 'summary_invalid',
  NOTHING_TO_SUMMARIZE: 'summary_nothing_to_summarize',
  EPOCH_CHANGED: 'context_epoch_changed',
});

async function readEvents(chatId) {
  const doc = await loadChatHistory(chatId);
  return Array.isArray(doc?.events) ? doc.events : [];
}

/** Latest context epoch of the saved history (null when unknown). */
export async function readCurrentContextEpoch(chatId) {
  const epoch = /** @type {Record<string, any>} */ (summarizeChatHistoryUsage(await readEvents(chatId)))?.latestContextEpoch;
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : null;
}

/**
 * @param {{
 *   parentChat: Record<string, any>,
 *   message?: string,
 *   fork?: Record<string, any>,
 *   signal?: AbortSignal,
 *   deps?: {
 *     summarize?: (prompt: string, options: { signal?: AbortSignal }) => Promise<string>|string,
 *     getContextEpoch?: (chatId: string) => Promise<number|null>|number|null,
 *     checkGate?: (chatId: string) => { allowed: boolean, reason?: string },
 *   },
 * }} input
 * @returns {Promise<{ chat: Record<string, any>, initialPrompt: string, summarized: boolean, summaryFallback: null|{ code: string, error: string } }>}
 */
export async function executeSummaryFork(input) {
  const { parentChat } = input;
  const deps = input.deps || {};
  const getEpoch = deps.getContextEpoch || readCurrentContextEpoch;
  const forkBase = { ...(input.fork || {}), parentChat, message: input.message, mode: 'reference' };

  const fallback = async (code, error) => {
    const forked = await executeConversationFork(forkBase);
    return {
      chat: forked.chat,
      initialPrompt: forked.initialPrompt,
      summarized: false,
      summaryFallback: { code, error: String(error || code) },
    };
  };

  const gate = deps.checkGate ? deps.checkGate(parentChat.id) : { allowed: true };
  if (!gate?.allowed) return fallback(SUMMARY_FALLBACK.GATE_BLOCKED, gate?.reason || 'gate closed');

  const events = await readEvents(parentChat.id);
  const epochAtStart = await getEpoch(parentChat.id);
  const summarizer = createCheapHistorySummarizer({ summarize: deps.summarize });
  let result;
  try {
    result = await summarizer.summarizeHistory({
      events,
      chatId: parentChat.id,
      contextEpoch: epochAtStart,
      signal: input.signal,
    });
  } catch (err) {
    return fallback(SUMMARY_FALLBACK.PROVIDER_ERROR, err?.message);
  }
  if (result.reason === 'nothing_to_summarize') return fallback(SUMMARY_FALLBACK.NOTHING_TO_SUMMARIZE, result.reason);
  if (!result.ok || !result.parsed) return fallback(SUMMARY_FALLBACK.INVALID_SUMMARY, 'summary did not match the required structure');

  // The model call can take seconds; a compaction in between rewrites the prefix,
  // so a summary made at the old epoch must not seed the new chat.
  const epochNow = await getEpoch(parentChat.id);
  const guard = resolveSummaryEpochGuard({ summaryContextEpoch: epochAtStart, currentContextEpoch: epochNow });
  if (guard.stale) return fallback(SUMMARY_FALLBACK.EPOCH_CHANGED, guard.reason);

  const kept = new Set(result.promptMeta?.keptSeqs || []);
  const seed = buildNewSessionSeedPrompt({
    summary: result.parsed,
    chatId: parentChat.id,
    contextEpoch: epochAtStart,
    lastTurns: events.filter((row) => kept.has(row.seq)),
  });
  const forked = await executeConversationFork(forkBase);
  return {
    chat: forked.chat,
    // Seed first (summary + pointers), then the standard reference-fork guidance.
    initialPrompt: `${seed.prompt}\n\n${forked.initialPrompt}`,
    summarized: true,
    summaryFallback: null,
  };
}

/** Production gate: cold cache or large context, from the shared cache view. */
export function createProductionGate(buildCacheView, dataDir) {
  return (chatId) => {
    const view = buildCacheView(chatId, { dataDir });
    return resolveSummaryGate({
      cacheState: view.freshness?.cache,
      estimatedContextTokens: view.freshness?.context?.inputTokens,
    });
  };
}
