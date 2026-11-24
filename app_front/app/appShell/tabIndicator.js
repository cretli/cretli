/**
 * Sliding underline for the top panel tabs. The router only toggles `.active`
 * on a tab; this module watches that class and moves one shared indicator to
 * the active tab, so the line animates between tabs instead of jumping.
 */
export function initTabIndicator(root = document.querySelector('.tabs')) {
  if (!(root instanceof HTMLElement) || root.querySelector(':scope > .tabs-indicator')) return;
  const bar = document.createElement('span');
  bar.className = 'tabs-indicator no-anim';
  bar.setAttribute('aria-hidden', 'true');
  root.append(bar);
  root.classList.add('has-indicator');
  let placed = false;
  let frame = 0;

  function place() {
    frame = 0;
    const btn = /** @type {HTMLElement | null} */ (root.querySelector('.tab.active:not([hidden])'));
    if (!btn || !btn.offsetWidth) {
      bar.style.opacity = '0';
      return;
    }
    bar.style.opacity = '1';
    bar.style.setProperty('--tab-x', `${btn.offsetLeft}px`);
    bar.style.setProperty('--tab-w', `${btn.offsetWidth}px`);
    if (!placed) {
      // The first placement (and the first one after the bar was hidden)
      // snaps into place; only later tab changes animate.
      placed = true;
      void bar.offsetWidth;
      bar.classList.remove('no-anim');
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };

  new MutationObserver((records) => {
    if (records.some((record) => record.target !== bar)) schedule();
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(root);
  window.addEventListener('cr-lang-changed', schedule);
  document.fonts?.ready?.then(schedule);
  schedule();
}
