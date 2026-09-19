/**
 * Read-only tool profile for review assignments, independent of SDK mode name.
 */

/**
 * Explicit review assignment only. Plan mode is a separate read-only path.
 *
 * @param {unknown} assignment
 * @returns {boolean}
 */
export function isReviewReadOnlyAssignment(assignment) {
  return String(assignment || '').trim().toLowerCase() === 'review';
}
