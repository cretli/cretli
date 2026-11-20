/**
 * Short-lived cache for the worktree list read model. The list shells out to
 * Git for every worktree, so the Git tab would otherwise pay that cost on each
 * open. Entries live a few seconds, concurrent callers share one in-flight
 * computation, and every registry write or mutating route drops the cache.
 */

const DEFAULT_TTL_MS = 5000;

/** @type {Map<string, { at: number, value?: unknown, promise?: Promise<unknown> }>} */
const entries = new Map();
let generation = 0;

/**
 * Drop every cached list (any workspace). Cheap, so callers do not narrow it.
 */
export function invalidateWorktreeListCache() {
  generation += 1;
  entries.clear();
}

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} compute
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {Promise<T>}
 */
export async function cachedWorktreeList(key, compute, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now || Date.now;
  const hit = entries.get(key);
  if (hit) {
    if (hit.promise) return /** @type {Promise<T>} */ (hit.promise);
    if (now() - hit.at < ttlMs) return /** @type {T} */ (hit.value);
  }
  const startedGeneration = generation;
  const promise = compute();
  entries.set(key, { at: now(), promise });
  try {
    const value = await promise;
    // A write that landed while computing makes this result stale: serve it to
    // the waiters but do not keep it.
    if (startedGeneration === generation) entries.set(key, { at: now(), value });
    else if (entries.get(key)?.promise === promise) entries.delete(key);
    return value;
  } catch (error) {
    if (entries.get(key)?.promise === promise) entries.delete(key);
    throw error;
  }
}
