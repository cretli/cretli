/** Pure helpers for the live counters shown in the Todo tab headers. */

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
