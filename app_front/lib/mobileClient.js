/**
 * True for phones/tablets (coarse pointer) and narrow viewports used by mobile layouts.
 *
 * @returns {boolean}
 */
export function isMobileLikeClient() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches) return true;
  return window.innerWidth < 769;
}

/**
 * @returns {boolean}
 */
export function isStandalonePwa() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    window.navigator?.standalone === true
  );
}
