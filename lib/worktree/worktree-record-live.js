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
 *
 * @param {object | null | undefined} record
 * @returns {boolean}
 */
export function isWorktreeRecordLive(record) {
  return Boolean(record && !record.cleanedAt && !record.releasedAt);
}
