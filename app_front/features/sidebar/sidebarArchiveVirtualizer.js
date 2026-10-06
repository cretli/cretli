/**
 * Archive list window math (stage 7.2). Pure functions — no DOM.
 * Full archive metadata stays in RAM/IDB; only the mounted slice is derived here.
 */

/** Baseline test viewport: sidebar body height on the UI-freeze reference device (px). */
export const SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX = 400;

/** Matches `--sidebar-row-height: 2rem` at default root font size (px). */
export const SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX = 32;

/** Extra rows rendered above and below the viewport slice. */
export const SIDEBAR_ARCHIVE_OVERSCAN_ROWS = 4;

/** Safety cap so pathological viewports never exceed a fixed DOM budget. */
export const SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS = 64;

/**
 * @param {number} [viewportHeightPx]
 * @param {{ defaultRowHeightPx?: number, overscanRows?: number }} [options]
 * @returns {number}
 */
export function computeSidebarArchiveMountedRowLimit(viewportHeightPx, options = {}) {
  const viewport = Number.isFinite(Number(viewportHeightPx)) && Number(viewportHeightPx) > 0
    ? Number(viewportHeightPx)
    : SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX;
  const rowHeight = Number.isFinite(Number(options.defaultRowHeightPx))
    && Number(options.defaultRowHeightPx) > 0
    ? Number(options.defaultRowHeightPx)
    : SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX;
  const overscan = Number.isFinite(Number(options.overscanRows))
    ? Math.max(0, Math.round(Number(options.overscanRows)))
    : SIDEBAR_ARCHIVE_OVERSCAN_ROWS;
  const visibleRows = Math.max(1, Math.ceil(viewport / rowHeight));
  const budget = visibleRows + overscan * 2;
  return Math.min(SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS, budget);
}

/**
 * @param {number[]} heightsPx per-row heights (same length as item count)
 * @param {number} index
 * @returns {number}
 */
function heightAt(heightsPx, index) {
  if (index < 0 || index >= heightsPx.length) return SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX;
  const value = Number(heightsPx[index]);
  return Number.isFinite(value) && value > 0 ? value : SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX;
}

/**
 * @param {number[]} heightsPx
 * @returns {number[]}
 */
export function buildArchiveRowOffsetPrefix(heightsPx) {
  const prefix = [0];
  for (let i = 0; i < heightsPx.length; i += 1) {
    prefix.push(prefix[prefix.length - 1] + heightAt(heightsPx, i));
  }
  return prefix;
}

/**
 * @param {number[]} prefix sum of row heights (length items + 1)
 * @param {number} scrollTopPx offset from list top
 * @returns {number}
 */
export function findArchiveRowIndexAtScroll(prefix, scrollTopPx) {
  if (!prefix.length) return 0;
  const target = Math.max(0, Number(scrollTopPx) || 0);
  let lo = 0;
  let hi = prefix.length - 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (prefix[mid + 1] <= target) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(lo, prefix.length - 2));
}

/**
 * @param {number} totalRows
 * @param {number} scrollTopPx scroll offset relative to archive list top
 * @param {number} viewportHeightPx
 * @param {number[]} [rowHeightsPx]
 * @param {{ overscanRows?: number, maxMounted?: number, anchorIndex?: number }} [options]
 * @returns {{ startIndex: number, endIndex: number, topSpacerPx: number, bottomSpacerPx: number, totalHeightPx: number }}
 */
export function selectArchiveVisibleWindow(
  totalRows,
  scrollTopPx,
  viewportHeightPx,
  rowHeightsPx,
  options = {},
) {
  const total = Math.max(0, Math.round(Number(totalRows) || 0));
  if (total === 0) {
    return { startIndex: 0, endIndex: 0, topSpacerPx: 0, bottomSpacerPx: 0, totalHeightPx: 0 };
  }
  const heights = Array.isArray(rowHeightsPx) && rowHeightsPx.length >= total
    ? rowHeightsPx.slice(0, total)
    : Array.from({ length: total }, () => SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX);
  const prefix = buildArchiveRowOffsetPrefix(heights);
  const totalHeightPx = prefix[prefix.length - 1];
  const viewport = Number.isFinite(Number(viewportHeightPx)) && Number(viewportHeightPx) > 0
    ? Number(viewportHeightPx)
    : SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX;
  const overscan = Number.isFinite(Number(options.overscanRows))
    ? Math.max(0, Math.round(Number(options.overscanRows)))
    : SIDEBAR_ARCHIVE_OVERSCAN_ROWS;
  const maxMounted = Number.isFinite(Number(options.maxMounted))
    ? Math.max(1, Math.round(Number(options.maxMounted)))
    : computeSidebarArchiveMountedRowLimit(viewport);
  let startIndex = findArchiveRowIndexAtScroll(prefix, scrollTopPx);
  let endIndex = startIndex;
  const scrollBottom = Math.max(0, Number(scrollTopPx) || 0) + viewport;
  while (endIndex < total && prefix[endIndex] < scrollBottom) {
    endIndex += 1;
  }
  if (endIndex === startIndex) endIndex = Math.min(total, startIndex + 1);
  startIndex = Math.max(0, startIndex - overscan);
  endIndex = Math.min(total, endIndex + overscan);
  if (endIndex - startIndex > maxMounted) {
    endIndex = Math.min(total, startIndex + maxMounted);
  }
  const anchorIndex = Number.isFinite(Number(options.anchorIndex))
    ? Math.round(Number(options.anchorIndex))
    : -1;
  if (anchorIndex >= 0 && anchorIndex < total) {
    if (anchorIndex < startIndex) startIndex = anchorIndex;
    if (anchorIndex >= endIndex) endIndex = anchorIndex + 1;
    if (endIndex - startIndex > maxMounted) {
      const centeredStart = Math.max(0, anchorIndex - Math.floor(maxMounted / 2));
      startIndex = centeredStart;
      endIndex = Math.min(total, startIndex + maxMounted);
    }
  }
  const topSpacerPx = prefix[startIndex];
  const bottomSpacerPx = Math.max(0, totalHeightPx - prefix[endIndex]);
  return { startIndex, endIndex, topSpacerPx, bottomSpacerPx, totalHeightPx };
}

/**
 * Adjust scrollTop so content above the anchor row keeps the same screen position
 * after the top spacer height changes.
 *
 * @param {number} previousTopSpacerPx
 * @param {number} nextTopSpacerPx
 * @param {number} scrollTopPx
 * @returns {number}
 */
export function applyArchiveScrollAnchor(previousTopSpacerPx, nextTopSpacerPx, scrollTopPx) {
  const delta = nextTopSpacerPx - previousTopSpacerPx;
  if (!Number.isFinite(delta) || delta === 0) return scrollTopPx;
  return Math.max(0, (Number(scrollTopPx) || 0) + delta);
}

/**
 * Scroll compensation applies only when the visible window start is unchanged
 * but the top spacer height changed (row height remeasurement). When startIndex
 * moves, the spacer already accounts for scrolled-off rows.
 *
 * @param {number} previousStartIndex
 * @param {number} nextStartIndex
 * @param {number} previousTopSpacerPx
 * @param {number} nextTopSpacerPx
 * @returns {boolean}
 */
export function shouldArchiveScrollAnchorCompensate(
  previousStartIndex,
  nextStartIndex,
  previousTopSpacerPx,
  nextTopSpacerPx,
) {
  if (previousStartIndex !== nextStartIndex) return false;
  if (previousTopSpacerPx === nextTopSpacerPx) return false;
  return true;
}

/**
 * List-relative scrollTop that places anchorIndex within the viewport.
 *
 * @param {number} totalRows
 * @param {number} anchorIndex
 * @param {number} viewportHeightPx
 * @param {number[]} [rowHeightsPx]
 * @returns {number}
 */
export function computeArchiveListScrollTopForAnchor(
  totalRows,
  anchorIndex,
  viewportHeightPx,
  rowHeightsPx,
) {
  const total = Math.max(0, Math.round(Number(totalRows) || 0));
  const index = Math.round(Number(anchorIndex));
  if (total === 0 || index < 0 || index >= total) return 0;
  const heights = Array.isArray(rowHeightsPx) && rowHeightsPx.length >= total
    ? rowHeightsPx.slice(0, total)
    : Array.from({ length: total }, () => SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX);
  const prefix = buildArchiveRowOffsetPrefix(heights);
  const anchorTop = prefix[index];
  const anchorHeight = heightAt(heights, index);
  const viewport = Number.isFinite(Number(viewportHeightPx)) && Number(viewportHeightPx) > 0
    ? Number(viewportHeightPx)
    : SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX;
  return Math.max(0, anchorTop - Math.floor((viewport - anchorHeight) / 2));
}

/**
 * @param {{ startIndex: number, endIndex: number }} window
 * @param {Array<{ chat?: { id?: string } }>} archiveTree
 * @returns {string[]}
 */
export function archiveWindowChatIds(window, archiveTree) {
  const list = Array.isArray(archiveTree) ? archiveTree : [];
  const start = Math.max(0, window.startIndex);
  const end = Math.min(list.length, window.endIndex);
  const ids = [];
  for (let i = start; i < end; i += 1) {
    const id = String(list[i]?.chat?.id || '').trim();
    if (id) ids.push(id);
  }
  return ids;
}
