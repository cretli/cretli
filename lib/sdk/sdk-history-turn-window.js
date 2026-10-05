/**
 * SDK history windows and pages must start on a user turn.
 *
 * Activity trays are rebuilt from the events between user turns. A window (or
 * page) that starts mid-run drops the leading Thinking block, so the first tool
 * calls land in a standalone Activity tray while later calls of the same run
 * attach to a different one. Aligning every window/page to a user turn makes a
 * replay rebuild the same groups the live stream had; assistant boundaries
 * inside the run still start their own intended trays, so distinct trays stay
 * distinct.
 */

/**
 * @param {unknown} record
 * @returns {boolean}
 */
export function isUserTurnBoundaryRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const rec = /** @type {Record<string, unknown>} */ (record);
  if (rec.kind === 'localUser') return true;
  if (rec.kind !== 'sdk') return false;
  const event = rec.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  return String(/** @type {Record<string, unknown>} */ (event).type || '').toLowerCase() === 'user';
}

/**
 * An SDK event that belongs to an agent run and is not itself the user turn.
 * Watcher notices and other meta rows are standalone: a page of them does not
 * need a run opening, and holding them back would dump the whole feed at once.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isHistoryRunFragmentRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const rec = /** @type {Record<string, unknown>} */ (record);
  if (rec.kind !== 'sdk') return false;
  const event = rec.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  return String(/** @type {Record<string, unknown>} */ (event).type || '').toLowerCase() !== 'user';
}

/**
 * @param {unknown[]} records
 * @returns {boolean}
 */
function listHasRunFragment(records) {
  return records.some((record) => isHistoryRunFragmentRecord(record));
}

/**
 * Tail of at most `limit` records, expanded backwards to the user turn that
 * opens the run containing the cut. A tail made only of standalone notices
 * (watcher feed, other meta) stays at `limit`. When the list starts mid-run
 * (no opening user turn), the next user turn is used so the rendered window
 * still starts on a turn boundary.
 *
 * @param {unknown[]} records
 * @param {number} limit
 * @returns {unknown[]}
 */
export function selectTurnAlignedHistoryWindow(records, limit) {
  const list = Array.isArray(records) ? records : [];
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(Number(limit))) : 0;
  if (list.length <= size) return list.slice();
  const tail = list.slice(list.length - size);
  if (!listHasRunFragment(tail)) return tail;
  const cut = list.length - size;
  for (let index = cut; index >= 0; index -= 1) {
    if (isUserTurnBoundaryRecord(list[index])) return list.slice(index);
  }
  for (let index = cut + 1; index < list.length; index += 1) {
    if (isUserTurnBoundaryRecord(list[index])) return list.slice(index);
  }
  return list.slice();
}

/**
 * Splits a fetched page so the rendered part starts on a user turn. A page that
 * holds no user turn and contains a run fragment is buffered whole: rendering
 * it would start a run in the middle and split its Activity tray. A page of
 * standalone notices is rendered as-is.
 *
 * @param {unknown[]} records
 * @returns {{ buffered: unknown[], renderable: unknown[] }}
 */
export function splitHistoryPageAtUserTurn(records) {
  const list = Array.isArray(records) ? records : [];
  const boundary = list.findIndex((record) => isUserTurnBoundaryRecord(record));
  if (boundary === 0) return { buffered: [], renderable: list.slice() };
  if (boundary < 0) {
    if (!listHasRunFragment(list)) return { buffered: [], renderable: list.slice() };
    return { buffered: list.slice(), renderable: [] };
  }
  return { buffered: list.slice(0, boundary), renderable: list.slice(boundary) };
}

/**
 * Server-side page extension: walk a backwards-paginated slice back to the user
 * turn that opens the run containing its first event, bounded by `maxLen`.
 *
 * @param {Array<{ seq: number, rec: unknown }>} pool
 * @param {Array<{ seq: number, rec: unknown }>} slice
 * @param {number} maxLen
 * @returns {Array<{ seq: number, rec: unknown }>}
 */
export function extendHistorySliceToTurnStart(pool, slice, maxLen) {
  if (!Array.isArray(pool) || pool.length === 0) return Array.isArray(slice) ? slice : [];
  if (!Array.isArray(slice) || slice.length === 0) return slice;
  const startIdx = pool.length - slice.length;
  if (startIdx < 0) return slice;
  if (isUserTurnBoundaryRecord(pool[startIdx]?.rec)) return slice;
  if (!slice.some((row) => isHistoryRunFragmentRecord(row?.rec))) return slice;
  const cap = Math.max(slice.length, Number(maxLen) || slice.length);
  const minIdx = Math.max(0, pool.length - cap);
  let index = startIdx;
  while (index > minIdx) {
    index -= 1;
    if (isUserTurnBoundaryRecord(pool[index]?.rec)) return pool.slice(index);
  }
  return pool.slice(index);
}
