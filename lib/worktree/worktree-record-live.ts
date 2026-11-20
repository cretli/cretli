/**
 * Liveness predicate for a durable worktree registry record.
 *
 * Kept in its own dependency-free module: it is shared with the browser
 * bundle (`lib/chat-list-payload.js` ← app_front), which must never pull the
 * server-side record/normalizer chain (`worktree-record.js` →
 * `worktree-result.js` → `node:crypto`, `node:path`) into webpack's
 * polyfill-free web build.
 */

/**
 * A record is live while it still owns a worktree for new work: neither
 * cleaned up (directory removed) nor released (directory kept on disk, but the
 * tree was explicitly moved back to project mode).
 */
export function isWorktreeRecordLive(
  record: { cleanedAt?: unknown; releasedAt?: unknown } | null | undefined,
): boolean {
  return Boolean(record && !record.cleanedAt && !record.releasedAt);
}
