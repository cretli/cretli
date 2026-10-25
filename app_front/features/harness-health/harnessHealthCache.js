/**
 * DOM-free cache + request-generation guard for the harness health GET.
 *
 * The card reuses one shared payload for every expanded harness. Two rules keep
 * that payload honest:
 *
 * 1. Only the newest request may commit its response. Responses that arrive
 *    after a newer request was issued are discarded, so a GET that started
 *    before a lockout-clearing POST can never write the stale lockout back.
 * 2. `invalidate()` drops the memoized payload immediately. A forced `load()`
 *    then always issues a fresh GET even while an older request is in flight,
 *    and a failed refresh leaves the cache empty instead of re-serving it.
 *    The forced request is flagged `fresh: true` so the API client cannot
 *    re-attach it to a URL-deduped GET that started before the clearing POST.
 *
 * Kept dependency-free so the race behaviour is unit-testable under Node.
 */

/** Serve memoized health for 60 s before a new expand triggers a fetch. */
export const HARNESS_HEALTH_CACHE_TTL_MS = 60 * 1000;

/**
 * @param {{
 *   fetchHealth: (query: { from: string, to: string, fresh?: boolean }) => Promise<object>,
 *   rangeQuery: (now: number) => { from: string, to: string },
 *   ttlMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {{
 *   load: (force?: boolean) => Promise<object>,
 *   invalidate: () => void,
 *   hasCache: () => boolean,
 *   isCacheFresh: () => boolean,
 *   getCached: () => object|null,
 * }}
 */
export function createHarnessHealthCache(options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs))
    ? Number(options.ttlMs)
    : HARNESS_HEALTH_CACHE_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchHealth = options.fetchHealth;
  const rangeQuery = options.rangeQuery;
  if (typeof fetchHealth !== 'function') throw new TypeError('fetchHealth must be a function');
  if (typeof rangeQuery !== 'function') throw new TypeError('rangeQuery must be a function');

  /** @type {{ at: number, payload: object|null }} */
  let cache = { at: 0, payload: null };
  /** @type {Promise<object>|null} */
  let inflight = null;
  /** Monotonic request id; the highest id owns the right to commit the cache. */
  let latestSeq = 0;

  /** @returns {object|null} */
  function getCached() {
    return cache.payload;
  }

  /** @returns {boolean} */
  function hasCache() {
    return Boolean(cache.payload);
  }

  /** @returns {boolean} */
  function isCacheFresh() {
    return hasCache() && now() - cache.at < ttlMs;
  }

  /** Drops the memoized payload; the next load must hit the network. */
  function invalidate() {
    cache = { at: 0, payload: null };
  }

  /**
   * @param {boolean} [force] skip the fresh-cache shortcut and supersede any in-flight request
   * @returns {Promise<object|null>} the payload, or null when the request was superseded
   */
  function load(force = false) {
    if (!force && isCacheFresh()) return Promise.resolve(cache.payload);
    if (inflight && !force) return inflight;
    const seq = ++latestSeq;
    const { from, to } = rangeQuery(now());
    const request = Promise.resolve()
      .then(() => fetchHealth(force ? { from, to, fresh: true } : { from, to }))
      .then((data) => {
        if (!data?.ok) throw new Error(data?.error || 'health request failed');
        // Only the newest request may commit; older ones resolve but are inert.
        if (seq !== latestSeq) return null;
        cache = { at: now(), payload: data };
        return data;
      })
      .catch((error) => {
        // A superseded request that failed must not surface as the card's error.
        if (seq !== latestSeq) return null;
        throw error;
      });
    const tracked = request.finally(() => {
      if (inflight === tracked) inflight = null;
    });
    inflight = tracked;
    return tracked;
  }

  return { load, invalidate, hasCache, isCacheFresh, getCached };
}
