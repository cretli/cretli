/**
 * Countdown to prompt-cache expiry for one chat. Prefers the in-memory cache
 * tracker; after a restart it falls back to the persisted context samples, so
 * the countdown survives a server restart (flagged as estimated).
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The lifetime the provider actually applied, read from the write split of the
 * newest write in the current context epoch. Null when no write reported it.
 * @param {Array<Record<string, any>>} samples
 * @returns {number|null}
 */
export function inferObservedCacheTtlMs(samples) {
  const list = (Array.isArray(samples) ? samples : []).slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const epoch = list.length ? list[list.length - 1].contextEpoch ?? 0 : 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const sample = list[index];
    if ((sample.contextEpoch ?? 0) !== epoch) break;
    if (sample.cacheWrite1hTokens > 0) return ONE_HOUR_MS;
    if (sample.cacheWrite5mTokens > 0) return FIVE_MINUTES_MS;
  }
  return null;
}

/**
 * @param {{ cache?: Record<string, any> }|null} freshness result of `getCacheFreshness`
 * @param {Array<Record<string, any>>} samples context samples of the chat, any order
 * @param {{ ttlMs: number|null, refreshOnHit: boolean }} ttl resolved cache TTL
 * @param {number} [now]
 * @returns {{ state: 'warm'|'cold'|'unknown', expiresAt: number|null, expiresInMs: number|null, ttlMs: number|null, refreshOnHit: boolean, lastCachedTurnAt: number|null, source: 'tracker'|'samples'|'none' }}
 */
export function buildCacheCountdown(freshness, samples, ttl, now = Date.now()) {
  const cache = freshness?.cache || {};
  const observedTtlMs = inferObservedCacheTtlMs(samples);
  const configuredTtlMs = cache.ttlKnown && cache.ttlMs > 0 ? cache.ttlMs : (ttl?.ttlMs > 0 ? ttl.ttlMs : null);
  // What the provider reported on a write wins over the configured guess.
  const ttlMs = observedTtlMs ?? configuredTtlMs;
  const ttlSource = observedTtlMs != null ? 'observed' : 'configured';
  const refreshOnHit = cache.refreshOnHit === true || ttl?.refreshOnHit === true;
  const base = { ttlMs, refreshOnHit, ttlSource, ttlApproximate: ttl?.approximate === true && observedTtlMs == null };
  if (cache.state === 'warm' && cache.lastCachedTurnAt != null && ttlMs) {
    // Re-derive from the observed lifetime: the tracker may have assumed another one.
    const expiresAt = cache.lastCachedTurnAt + ttlMs;
    if (expiresAt > now) {
      return { ...base, state: 'warm', expiresAt, expiresInMs: expiresAt - now, lastCachedTurnAt: cache.lastCachedTurnAt, source: 'tracker' };
    }
    return { ...base, state: 'cold', expiresAt: null, expiresInMs: null, lastCachedTurnAt: cache.lastCachedTurnAt, source: 'tracker' };
  }
  if (cache.state === 'cold' && cache.reason !== 'ttl_expired' && cache.lastCachedTurnAt != null) {
    // Reset by compaction or a restarted session: the old cache is not reusable.
    return { ...base, state: 'cold', expiresAt: null, expiresInMs: null, lastCachedTurnAt: cache.lastCachedTurnAt, source: 'tracker' };
  }
  if (!ttlMs) {
    const lastHit = (Array.isArray(samples) ? samples : []).filter((sample) => sample.cacheReadTokens > 0).sort((a, b) => a.observedAt.localeCompare(b.observedAt)).pop();
    return { ...base, state: 'unknown', expiresAt: null, expiresInMs: null,
      lastCachedTurnAt: cache.lastCachedTurnAt ?? (lastHit ? Date.parse(lastHit.observedAt) : null), source: cache.lastCachedTurnAt != null ? 'tracker' : lastHit ? 'samples' : 'none' };
  }
  const latest = (Array.isArray(samples) ? samples : []).slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt)).pop();
  const last = (Array.isArray(samples) ? samples : [])
    .filter((sample) => (sample.contextEpoch ?? 0) === (latest?.contextEpoch ?? 0) && sample.model === latest?.model)
    .filter((sample) => (sample.cacheReadTokens > 0 || sample.cacheWriteTokens > 0) && Number.isFinite(Date.parse(sample.observedAt)))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt)).pop();
  if (!last) return { ...base, state: 'unknown', expiresAt: null, expiresInMs: null, lastCachedTurnAt: null, source: 'none' };
  const lastCachedTurnAt = Date.parse(last.observedAt);
  const expiresAt = lastCachedTurnAt + ttlMs;
  const warm = expiresAt > now;
  return {
    ...base, state: warm ? 'warm' : 'cold', expiresAt: warm ? expiresAt : null,
    expiresInMs: warm ? expiresAt - now : null, lastCachedTurnAt, source: 'samples',
  };
}
