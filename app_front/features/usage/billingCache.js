/**
 * Shared fetch cache for the billing view inputs (ledger, forecast, harness
 * links). Harness cards paint in a burst; they must share one request triple
 * instead of issuing one per card.
 */

/**
 * @param {{ getLedger: () => Promise<any>, getForecast: () => Promise<any>, getLinks: () => Promise<any> }} api
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {{ get: () => Promise<{ ledger: any, forecast: any, links: any }>, invalidate: () => void }}
 */
export function createBillingFetchCache(api, options = {}) {
  const ttlMs = options.ttlMs ?? 5000;
  const now = options.now || Date.now;
  let generation = 0;
  /** @type {{ promise: Promise<any> | null, at: number, failed: boolean, pending: boolean } | null} */
  let entry = null;

  function invalidate() {
    generation += 1;
    entry = null;
  }

  function get() {
    if (entry && !entry.failed && (now() - entry.at < ttlMs || entry.pending)) return entry.promise;
    const gen = generation;
    /** @type {{ promise: Promise<any> | null, at: number, failed: boolean, pending: boolean }} */
    const fresh = { promise: null, at: now(), failed: false, pending: true };
    fresh.promise = Promise.all([api.getLedger(), api.getForecast(), api.getLinks()])
      .then(([ledger, forecast, links]) => {
        fresh.pending = false;
        fresh.at = now();
        return { ledger, forecast, links };
      }, (error) => {
        // Never cache a failure: the next card retries.
        fresh.pending = false;
        fresh.failed = true;
        if (entry === fresh) entry = null;
        throw error;
      });
    // An invalidation during the flight leaves this result usable for its own
    // callers but keeps it out of the cache.
    if (gen === generation) entry = fresh;
    return fresh.promise;
  }

  return { get, invalidate };
}
