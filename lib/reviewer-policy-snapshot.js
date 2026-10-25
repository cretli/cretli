/**
 * Import-free normalizer of the reviewer-policy snapshot stored on a review
 * delegation (kept apart from the resolver so the persistence layer can use it
 * without an import cycle).
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {object | null}
 */
export function normalizeReviewerPolicySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const members = Array.isArray(value.members)
    ? value.members.slice(0, 2).map((m) => ({ harness: text(m?.harness), model: text(m?.model) }))
    : [];
  const reuse = value.reuse && typeof value.reuse === 'object'
    ? {
      status: ['resumed', 'fresh', 'fallback'].includes(text(value.reuse.status)) ? text(value.reuse.status) : 'fallback',
      reasonCode: text(value.reuse.reasonCode),
      reason: text(value.reuse.reason),
      sourceDelegationId: text(value.reuse.sourceDelegationId),
    }
    : null;
  return {
    subject: text(value.subject),
    source: text(value.source),
    revision: text(value.revision),
    selection: text(value.selection),
    membersSource: text(value.membersSource),
    session: text(value.session),
    members,
    membership: text(value.membership),
    reuse,
  };
}
