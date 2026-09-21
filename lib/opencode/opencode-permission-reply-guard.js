/**
 * One-shot guard for OpenCode permission replies.
 *
 * A permission requestId may be answered at most once, whether the reply comes
 * from the local approval broker (`once`) or from the human card
 * (`opencodePermissionReply`). The guard is bounded so a long-lived room cannot
 * grow without limit; the pending map remains the primary liveness check.
 */

/**
 * @param {number} [limit]
 * @returns {{
 *   claim(requestId: unknown): boolean,
 *   release(requestId: unknown): void,
 *   has(requestId: unknown): boolean,
 *   readonly size: number,
 * }}
 */
export function createOpenCodePermissionReplyGuard(limit = 500) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
  const seen = new Set();
  return {
    claim(requestId) {
      const id = String(requestId || '').trim();
      if (!id) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > cap) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }
      return true;
    },
    release(requestId) {
      const id = String(requestId || '').trim();
      if (id) seen.delete(id);
    },
    has(requestId) {
      return seen.has(String(requestId || '').trim());
    },
    get size() {
      return seen.size;
    },
  };
}
