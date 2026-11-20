/**
 * Adapter from persisted harness context samples to `detectCacheRegression`.
 * Read-only and local: it only reshapes samples that were already collected.
 */

import { detectCacheRegression } from './cache-regression.ts';

/**
 * @param {Record<string, any>} sample
 * @returns {import('./cache-regression.ts').CacheObservation|null}
 */
function toObservation(sample) {
  const at = Date.parse(sample?.observedAt);
  // Synthetic samples (e.g. compaction markers) carry no real call.
  if (!Number.isFinite(at) || !(Number(sample.inputTokens) > 0)) return null;
  const cacheRead = sample.cacheReadTokens ?? null;
  return {
    at,
    cacheRead,
    inputTokens: sample.inputTokens,
    // Cache reads above the input total can only mean they are reported separately.
    inputExcludesCacheRead: cacheRead != null && Number(cacheRead) > Number(sample.inputTokens),
    prefixFingerprint: sample.prefixFingerprint || '',
    generation: sample.contextEpoch ?? 0,
  };
}

/**
 * Evaluate the newest sample of one chat against its warm baseline.
 * Samples without a cache metric yield `insufficient_data`, never a regression.
 *
 * @param {Record<string, any>[]} samples Context samples of one chat.
 * @param {{ ttlMs?: number|null }} [options]
 * @returns {ReturnType<typeof detectCacheRegression>}
 */
export function evaluateSamplesCacheRegression(samples, options: Partial<{ ttlMs?: number|null }> = {}) {
  const seen = new Set();
  const observations = (Array.isArray(samples) ? samples : [])
    .map(toObservation)
    .filter((row) => row && !seen.has(row.at) && seen.add(row.at));
  return detectCacheRegression(observations, { ttlMs: options.ttlMs });
}
