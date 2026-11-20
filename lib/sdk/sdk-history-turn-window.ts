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
 *
 * Stage 4 caps the mounted slice after turn alignment so one long run cannot
 * mount hundreds of cards; older slices stay in the parked prefix for prepend.
 */

export function isUserTurnBoundaryRecord(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const rec = record as Record<string, unknown>;
  if (rec.kind === 'localUser') return true;
  if (rec.kind !== 'sdk') return false;
  const event = rec.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  return String((event as Record<string, unknown>).type || '').toLowerCase() === 'user';
}

/**
 * An SDK event that belongs to an agent run and is not itself the user turn.
 * Watcher notices and other meta rows are standalone: a page of them does not
 * need a run opening, and holding them back would dump the whole feed at once.
 */
export function isHistoryRunFragmentRecord(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const rec = record as Record<string, unknown>;
  if (rec.kind !== 'sdk') return false;
  const event = rec.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  return String((event as Record<string, unknown>).type || '').toLowerCase() !== 'user';
}

function listHasRunFragment(records: unknown[]): boolean {
  return records.some((record) => isHistoryRunFragmentRecord(record));
}

function resolveTurnAlignedStartIndex(list: unknown[], tailSize: number): number {
  if (list.length <= tailSize) return 0;
  const cut = list.length - tailSize;
  const tail = list.slice(cut);
  if (!listHasRunFragment(tail)) return cut;
  for (let index = cut; index >= 0; index -= 1) {
    if (isUserTurnBoundaryRecord(list[index])) return index;
  }
  for (let index = cut + 1; index < list.length; index += 1) {
    if (isUserTurnBoundaryRecord(list[index])) return index;
  }
  return 0;
}

/** @param visibleStartOffset index inside the aligned run (0 = user turn) */
export function buildHistoryTurnSegment(
  alignedLength: number,
  mountedCap: number,
  visibleStartOffset: number,
): HistoryTurnSegment | null {
  const total = Math.max(0, Math.floor(Number(alignedLength) || 0));
  const cap = Math.max(1, Math.floor(Number(mountedCap) || 0));
  const offset = Math.max(0, Math.floor(Number(visibleStartOffset) || 0));
  if (total <= cap) return null;
  const partCount = Math.ceil(total / cap);
  const partIndex = Math.min(partCount, Math.floor(offset / cap) + 1);
  return {
    partIndex,
    partCount,
    includesTurnOpen: offset === 0,
  };
}

type HistorySliceRow = { seq: number; rec: unknown };

export type HistoryTurnSegment = { partIndex: number; partCount: number; includesTurnOpen: boolean };

export type TurnAlignedHistoryWindowResult = {
  /** Mounted slice (chronological). */
  records: unknown[];
  /** Prefix not mounted (chronological). */
  parked: unknown[];
  turnSegment: HistoryTurnSegment | null;
};

/**
 * Tail of at most `tailLimit` records, expanded backwards to the user turn that
 * opens the run containing the cut, then capped to `mountedCap` cards. Parked
 * records stay available for prepend / server paging.
 *
 * @param tailLimit initial tail before turn alignment
 * @param mountedCap max mounted records after alignment; default unbounded
 */
export function resolveTurnAlignedHistoryWindow(
  records: unknown[],
  tailLimit: number,
  mountedCap: number = Number.POSITIVE_INFINITY,
): TurnAlignedHistoryWindowResult {
  const list = Array.isArray(records) ? records : [];
  const tailSize = Number.isFinite(tailLimit) ? Math.max(0, Math.floor(Number(tailLimit))) : 0;
  const cap = Number.isFinite(mountedCap) ? Math.max(0, Math.floor(Number(mountedCap))) : Number.POSITIVE_INFINITY;
  if (list.length === 0) {
    return { records: [], parked: [], turnSegment: null };
  }
  if (list.length <= tailSize) {
    return { records: list.slice(), parked: [], turnSegment: null };
  }
  const startIndex = resolveTurnAlignedStartIndex(list, tailSize);
  const aligned = list.slice(startIndex);
  const parkedBeforeAligned = list.slice(0, startIndex);
  if (aligned.length === 0) {
    return { records: [], parked: list.slice(), turnSegment: null };
  }
  if (!Number.isFinite(cap) || aligned.length <= cap) {
    return { records: aligned.slice(), parked: parkedBeforeAligned, turnSegment: null };
  }
  const hiddenInTurn = aligned.slice(0, aligned.length - cap);
  const visible = aligned.slice(-cap);
  const visibleStartOffset = hiddenInTurn.length;
  const turnSegment = buildHistoryTurnSegment(aligned.length, cap, visibleStartOffset);
  return {
    records: visible,
    parked: parkedBeforeAligned.concat(hiddenInTurn),
    turnSegment,
  };
}

export function selectTurnAlignedHistoryWindow(
  records: unknown[],
  limit: number,
  mountedCap: number = Number.POSITIVE_INFINITY,
): unknown[] {
  return resolveTurnAlignedHistoryWindow(records, limit, mountedCap).records;
}

/**
 * Splits a fetched page so the rendered part starts on a user turn. A page that
 * holds no user turn and contains a run fragment is buffered whole: rendering
 * it would start a run in the middle and split its Activity tray. A page of
 * standalone notices is rendered as-is.
 *
 * When `allowMidRunContinuation` is true, a mid-run page is rendered anyway
 * (bounded turn segments prepended above an existing run tail).
 */
export function splitHistoryPageAtUserTurn(
  records: unknown[],
  options: { allowMidRunContinuation?: boolean } = {},
): { buffered: unknown[]; renderable: unknown[] } {
  const list = Array.isArray(records) ? records : [];
  const boundary = list.findIndex((record) => isUserTurnBoundaryRecord(record));
  if (boundary === 0) return { buffered: [], renderable: list.slice() };
  if (boundary < 0) {
    if (!listHasRunFragment(list)) return { buffered: [], renderable: list.slice() };
    if (options.allowMidRunContinuation === true) {
      return { buffered: [], renderable: list.slice() };
    }
    return { buffered: list.slice(), renderable: [] };
  }
  return { buffered: list.slice(0, boundary), renderable: list.slice(boundary) };
}

/**
 * Server-side page extension: walk a backwards-paginated slice back to the user
 * turn that opens the run containing its first event, bounded by `maxLen`.
 */
export function extendHistorySliceToTurnStart(
  pool: HistorySliceRow[],
  slice: HistorySliceRow[],
  maxLen: number,
): HistorySliceRow[] {
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
