/**
 * Shared per-chat cache view used by `/api/usage/cache-freshness` and
 * `/api/usage/resume-advice`, so both endpoints agree on the cache retention
 * (observed 1h write or the opt-in `promptCaching1h` setting).
 */

import { readHarnessContextSamples } from './harness-context-telemetry.ts';
import { buildCacheCountdown, inferObservedCacheTtlMs } from './cache-countdown.ts';
import { getCacheFreshness, resolveCacheTtl } from './cache-state.ts';
import { resolveClaudeCacheSettings } from '../claude/claude-cache-settings.ts';
import { loadChats } from '../persist/chats-persist.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * @param {string} chatId
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {{ chat: Record<string, any>|null, harness: string, samples: Record<string, any>[], freshness: Record<string, any>, countdown: Record<string, any> }}
 */
export function buildChatCacheView(chatId, options: Partial<{ dataDir?: string, now?: number }> = {}) {
  const chat: Record<string, any> | null = loadChats().find((entry) => entry?.id === chatId) || null;
  // The 1 hour Claude cache is opt-in; the TTL has to follow that setting.
  const harness = chat?.agentTransport || '';
  const samples = readHarnessContextSamples({ dataDir: options.dataDir, chatId });
  const observedTtlMs = inferObservedCacheTtlMs(samples);
  const configuredExtended = harness === 'claude' && resolveClaudeCacheSettings().promptCaching1h;
  // A reported write lifetime beats the configured one.
  const retention = (observedTtlMs != null ? observedTtlMs > FIVE_MINUTES_MS : configuredExtended) ? 'extended' : undefined;
  const freshness = getCacheFreshness(chatId, { harness, retention, now: options.now });
  const ttl = resolveCacheTtl({ harness, retention });
  return { chat, harness, samples, freshness, countdown: buildCacheCountdown(freshness, samples, ttl, options.now) };
}
