/** Pure helpers for the live counters shown in the Todo tab headers. */
import { FEEDBACK_ROOT_MARKER, isFeedbackReport } from '../../../lib/feedback-marker.js';

export { isFeedbackReport as isFeedbackReportTodo } from '../../../lib/feedback-marker.js';

/**
 * Number of deferred root todos (a deferred todo whose parent is absent or not
 * deferred). Matches the "Later" section header count.
 *
 * @param {Array<Record<string, any>> | null | undefined} items
 * @returns {number}
 */
export function countDeferredRoots(items) {
  const rows = Array.isArray(items) ? items : [];
  const byId = new Map(rows.map((row) => [String(row?.id ?? ''), row]));
  const isDeferred = (row) => String(row?.status || '').trim().toLowerCase() === 'deferred';
  return rows.filter((row) => {
    if (!isDeferred(row)) return false;
    const parentId = String(row.parentId ?? row.parent_id ?? '');
    return !(parentId && isDeferred(byId.get(parentId)));
  }).length;
}

/**
 * The legacy `cretli_feedback` container. The slim list keeps a body preview, which
 * always covers the leading marker.
 *
 * @param {Record<string, any> | null | undefined} item
 * @returns {boolean}
 */
export function isFeedbackRootTodo(item) {
  return !String(item?.parentId ?? item?.parent_id ?? '')
    && String(item?.body ?? '').trimStart().startsWith(FEEDBACK_ROOT_MARKER);
}

/**
 * Open category members, excluding completed and deferred reports.
 *
 * @param {Array<Record<string, any>> | null | undefined} items
 * @returns {number}
 */
export function countOpenFeedback(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows.filter((row) => {
    const status = String(row?.status || '').trim().toLowerCase();
    return isFeedbackReport(row) && status !== 'done' && status !== 'deferred';
  }).length;
}
