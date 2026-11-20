/**
 * Per-workspace archive virtual window persisted across sidebar render passes.
 */

/** @typedef {{ startIndex: number, endIndex: number, topSpacerPx: number, bottomSpacerPx: number, scrollTopPx?: number }} SidebarArchiveVirtualWindow */

/** @type {Map<string, SidebarArchiveVirtualWindow>} */
const windowBySidebarKey = new Map();

/**
 * @param {string} sidebarKey
 * @param {SidebarArchiveVirtualWindow} window
 */
export function setSidebarArchiveVirtualWindow(sidebarKey, window) {
  const key = String(sidebarKey || '').trim();
  if (!key || !window) return;
  windowBySidebarKey.set(key, {
    startIndex: Math.max(0, Math.round(window.startIndex)),
    endIndex: Math.max(0, Math.round(window.endIndex)),
    topSpacerPx: Math.max(0, Number(window.topSpacerPx) || 0),
    bottomSpacerPx: Math.max(0, Number(window.bottomSpacerPx) || 0),
    scrollTopPx: Number.isFinite(Number(window.scrollTopPx)) ? Number(window.scrollTopPx) : undefined,
  });
}

/**
 * @param {string} sidebarKey
 * @returns {SidebarArchiveVirtualWindow | null}
 */
export function getSidebarArchiveVirtualWindow(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key) return null;
  return windowBySidebarKey.get(key) || null;
}

/**
 * @param {string} sidebarKey
 */
export function clearSidebarArchiveVirtualWindow(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key) return;
  windowBySidebarKey.delete(key);
}

/** Test-only reset. */
export function __resetSidebarArchiveVirtualStateForTest() {
  windowBySidebarKey.clear();
}
