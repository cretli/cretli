/**
 * Opens Settings → Usage and scrolls to the billing section. Kept free of app
 * imports so it can be unit-tested with a mock document.
 */

/**
 * @typedef {{
 *   querySelector: (sel: string) => any,
 *   getElementById: (id: string) => any,
 * }} DocLike
 */

/** Upper bound of frames to wait for the Usage panel to become visible. */
const MAX_WAIT_FRAMES = 30;

/**
 * Clicks the Usage settings tab, then scrolls `#usage-billing` into view once
 * the panel is visible. Motion follows `prefers-reduced-motion`.
 *
 * @param {{
 *   doc?: DocLike,
 *   matchMedia?: (q: string) => { matches: boolean },
 *   defer?: (fn: () => void) => void,
 * }} [deps]
 * @returns {void}
 */
export function openUsageBilling(deps = {}) {
  const doc = deps.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  // Select the Billing sub-view before the tab opens, so the tab loads only it.
  const viewBtn = doc.querySelector('[data-usage-view-tab="billing"]');
  if (viewBtn && typeof viewBtn.click === 'function') viewBtn.click();
  const tabBtn = doc.querySelector('#settings-tabs [data-settings-tab="usage"]')
    || doc.querySelector('.settings-tab[data-settings-tab="usage"]');
  if (tabBtn && typeof tabBtn.click === 'function') tabBtn.click();
  const mm = deps.matchMedia || (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia.bind(window) : null);
  const reduced = Boolean(mm && mm('(prefers-reduced-motion: reduce)').matches);
  const defer = deps.defer
    || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0));
  const scroll = () => {
    const target = doc.getElementById('usage-billing');
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
  };
  // The tab click starts an asynchronous SPA navigation, so poll frame by
  // frame until the billing host has layout (its panel is no longer hidden).
  // After the bound, give up silently: the Usage tab is already open, so the
  // user just sees the top instead of a scroll against a hidden element.
  let frames = 0;
  const tick = () => {
    const target = doc.getElementById('usage-billing');
    const laidOut = target && (typeof target.getClientRects !== 'function' || target.getClientRects().length > 0);
    if (laidOut) {
      scroll();
      return;
    }
    if (frames >= MAX_WAIT_FRAMES) return;
    frames += 1;
    defer(tick);
  };
  defer(tick);
}
