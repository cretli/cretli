/**
 * Short TTL cache with in-flight de-dup for heavy whole-table aggregates
 * (delegation runtime, stats, review-loop stats). A burst of panel requests
 * shares one computation; a failed computation is never cached.
 */

const DEFAULT_MAX_ENTRIES = 50;

/**
 * @param {{ ttlMs: number, maxEntries?: number, now?: () => number }} options
 * @returns {{ read: <T>(key: string, compute: () => T | Promise<T>) => Promise<T>, size: () => number }}
 */
export function createStatsTtlCache(options) {
  const ttlMs = Number(options?.ttlMs);
  const maxEntries = Number(options?.maxEntries) > 0 ? Number(options.maxEntries) : DEFAULT_MAX_ENTRIES;
  const now = typeof options?.now === 'function' ? options.now : Date.now;
  /** @type {Map<string, { at: number, value?: unknown, pending?: Promise<unknown> }>} */
  const entries = new Map();
  async function read(key, compute) {
    if (!(ttlMs > 0)) return compute();
    const hit = entries.get(key);
    if (hit?.pending) return hit.pending;
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const pending = Promise.resolve().then(compute);
    entries.set(key, { at: now(), pending });
    try {
      const value = await pending;
      entries.set(key, { at: now(), value });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    } catch (err) {
      entries.delete(key);
      throw err;
    }
  }
  return { read, size: () => entries.size };
}

/**
 * Cache key carrying everything that scopes an aggregate for this caller:
 * widget installation vs full access, workspace folder/file and leaf.
 *
 * @param {string} name
 * @param {{ widgetAccess?: { installationId?: string } | null, query?: Record<string, unknown>, body?: Record<string, unknown> }} req
 * @returns {string}
 */
export function buildStatsCacheKey(name, req) {
  const query = req?.query || {};
  return JSON.stringify([
    name,
    req?.widgetAccess ? `widget:${req.widgetAccess.installationId || ''}` : 'full',
    String(query.workspaceFolder || req?.body?.workspaceFolder || '').trim(),
    String(query.workspaceFile || '').trim(),
    String(query.leafId || query.leaf_id || '').trim(),
  ]);
}
