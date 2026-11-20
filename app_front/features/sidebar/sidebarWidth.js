/**
 * Viewport-aware clamp for the left sidebar drawer width.
 * Max leaves a sliver of backdrop so the drawer can still be dismissed on mobile.
 */

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH_RATIO = 0.96;
export const SIDEBAR_MAX_WIDTH_GAP = 32;
export const SIDEBAR_RESIZE_STEP = 20;

/**
 * @param {number} value
 * @param {number} [viewportWidth]
 * @returns {number}
 */
export function clampSidebarWidth(value, viewportWidth = 0) {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  if (viewportWidth <= 0) return Math.max(SIDEBAR_MIN_WIDTH, rounded);
  const min = Math.min(SIDEBAR_MIN_WIDTH, Math.max(0, viewportWidth - SIDEBAR_MAX_WIDTH_GAP));
  const max = Math.max(
    min,
    Math.min(
      Math.floor(viewportWidth * SIDEBAR_MAX_WIDTH_RATIO),
      viewportWidth - SIDEBAR_MAX_WIDTH_GAP
    )
  );
  return Math.min(Math.max(rounded, min), max);
}
