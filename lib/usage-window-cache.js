/**
 * Short-TTL cache for a rolling "last N days" read. The key is the window
 * length only (never the moving `to`), so repeated requests inside the TTL
 * share one read while data stays at most `ttlMs` stale.
 *
 * @template T
 * @param {{
 *   read: (range: { from: string, to: string }) => T,
 *   windowMs: number,
 *   ttlMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {{ get: () => T, clear: () => void }}
 */
export function createRollingWindowCache({ read, windowMs, ttlMs = 20_000, now = Date.now }) {
  let cached = null;
  return {
    get() {
      const at = now();
      if (cached && at - cached.at >= 0 && at - cached.at < ttlMs) return cached.value;
      const value = read({
        from: new Date(at - windowMs).toISOString(),
        to: new Date(at).toISOString(),
      });
      cached = { at, value };
      return value;
    },
    clear() {
      cached = null;
    },
  };
}
