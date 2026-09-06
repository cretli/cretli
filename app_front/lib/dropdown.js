import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';

/** @type {Set<{ forceClose: () => void, isOpen: () => boolean }>} */
const openDropdownApis = new Set();

/**
 * Index the roving focus should move to inside an open dropdown.
 * Returns null for keys that are not list navigation, so they keep their
 * default behaviour.
 *
 * @param {string} key Value of KeyboardEvent.key
 * @param {number} index Currently focused option, -1 when focus is elsewhere
 *   (for example in a search field)
 * @param {number} count Number of visible options
 * @returns {number|null}
 */
export function resolveDropdownNextIndex(key, index, count) {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  // Focus outside the list (search field): enter it from the matching end
  // rather than stepping relative to a position that does not exist.
  if (index < 0) {
    if (key === 'ArrowDown') return 0;
    if (key === 'ArrowUp') return count - 1;
    return null;
  }
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  return null;
}

/**
 * Closes every registered dropdown (used on PWA background/resume).
 *
 * @returns {number} Count of dropdowns that were open
 */
export function closeAllOpenDropdowns() {
  let closedCount = 0;
  for (const api of openDropdownApis) {
    try {
      if (!api.isOpen?.()) continue;
      api.forceClose?.();
      closedCount += 1;
    } catch {
      // Dropdown cleanup must never break the app shell.
    }
  }
  return closedCount;
}

/**
 * Generic dropdown controller built on Floating UI.
 * By default it closes on outside click and Escape.
 */
export function initDropdown(options = {}) {
  const triggerEl = options.triggerEl || null;
  const floatingEl = options.floatingEl || null;
  if (!triggerEl || !floatingEl) {
    return {
      open: () => {},
      close: () => {},
      toggle: () => {},
      isOpen: () => false,
      destroy: () => {},
    };
  }

  const placement = options.placement || 'bottom-start';
  const offsetPx = Number.isFinite(options.offsetPx) ? options.offsetPx : 6;
  const viewportPadding = Number.isFinite(options.viewportPadding) ? options.viewportPadding : 8;
  const minWidthPx = Number.isFinite(options.minWidthPx) ? options.minWidthPx : 220;
  const maxHeightPx = Number.isFinite(options.maxHeightPx) ? options.maxHeightPx : 360;
  const matchTriggerWidth = options.matchTriggerWidth === true;
  const compact = options.compact === true;
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : null;
  const onClose = typeof options.onClose === 'function' ? options.onClose : null;
  const optionSelector = typeof options.optionSelector === 'string' && options.optionSelector
    ? options.optionSelector
    : '[role="option"], [role="menuitem"], [role="menuitemradio"], button:not([disabled])';

  let cleanupAutoUpdate = null;
  let open = false;

  function cleanupPositioning() {
    if (typeof cleanupAutoUpdate === 'function') {
      cleanupAutoUpdate();
      cleanupAutoUpdate = null;
    }
  }

  function applyPosition() {
    return computePosition(triggerEl, floatingEl, {
      strategy: 'fixed',
      placement,
      middleware: [
        offset(offsetPx),
        flip({ padding: viewportPadding }),
        shift({ padding: viewportPadding }),
        size({
          padding: viewportPadding,
          apply({ availableWidth, availableHeight, rects, elements }) {
            const widthFromTrigger = Math.floor(rects.reference.width);
            const minW = matchTriggerWidth
              ? Math.max(minWidthPx, widthFromTrigger)
              : minWidthPx;
            const maxW = Math.max(minWidthPx, Math.floor(availableWidth));
            elements.floating.style.minWidth = `${Math.min(minW, maxW)}px`;
            elements.floating.style.maxWidth = `${maxW}px`;
            elements.floating.style.maxHeight = `${Math.max(120, Math.min(maxHeightPx, Math.floor(availableHeight)))}px`;
          },
        }),
      ],
    }).then(({ x, y }) => {
      floatingEl.style.left = `${x}px`;
      floatingEl.style.top = `${y}px`;
    });
  }

  function resetFloatingStyles() {
    floatingEl.hidden = true;
    floatingEl.style.left = '';
    floatingEl.style.top = '';
    floatingEl.style.minWidth = '';
    floatingEl.style.maxWidth = '';
    floatingEl.style.maxHeight = '';
    triggerEl.setAttribute('aria-expanded', 'false');
  }

  function forceClose() {
    const wasOpen = open;
    cleanupPositioning();
    open = false;
    resetFloatingStyles();
    if (wasOpen && onClose) onClose();
  }

  function close() {
    if (!open) return;
    forceClose();
  }

  function openDropdown() {
    if (open) return;
    open = true;
    floatingEl.hidden = false;
    triggerEl.setAttribute('aria-expanded', 'true');
    cleanupPositioning();
    cleanupAutoUpdate = autoUpdate(triggerEl, floatingEl, () => {
      applyPosition().catch(() => {});
    });
    applyPosition().catch(() => {});
    if (onOpen) onOpen();
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    openDropdown();
  }

  function onDocumentClick(event) {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (floatingEl.contains(target) || triggerEl.contains(target)) return;
    close();
  }

  function onDocumentKeydown(event) {
    if (!open) return;
    if (event.key !== 'Escape') return;
    close();
  }

  /** Visible, focusable options inside the panel. */
  function readOptions() {
    return Array.from(floatingEl.querySelectorAll(optionSelector)).filter(
      (el) => el instanceof HTMLElement && !el.hidden && el.getClientRects().length > 0,
    );
  }

  /** @param {number} index Wraps around both ends. */
  function focusOptionAt(index) {
    const items = readOptions();
    if (!items.length) return;
    const target = items[(index + items.length) % items.length];
    target.focus();
    // The panel scrolls, so the focused option has to be pulled into view.
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function onFloatingKeydown(event) {
    if (!open) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    // A search field inside the panel (cr-searchable-select) must keep normal
    // typing, so only arrows are intercepted there.
    const isTextField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    const items = readOptions();
    if (!items.length) return;
    const current = target.closest(optionSelector);
    const index = current instanceof HTMLElement ? items.indexOf(current) : -1;
    // In a search field only the arrows are ours; Home/End move the caret.
    const navKey = isTextField && event.key !== 'ArrowDown' && event.key !== 'ArrowUp'
      ? null
      : resolveDropdownNextIndex(event.key, index, items.length);
    if (navKey !== null) {
      event.preventDefault();
      focusOptionAt(navKey);
      return;
    }
    if (isTextField) return;
    if ((event.key === 'Enter' || event.key === ' ') && current instanceof HTMLElement) {
      event.preventDefault();
      current.click();
    }
  }

  function onTriggerKeydown(event) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (!open) openDropdown();
    // Let the panel render before moving focus into it.
    requestAnimationFrame(() => focusOptionAt(0));
  }

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  floatingEl.addEventListener('keydown', onFloatingKeydown);
  triggerEl.addEventListener('keydown', onTriggerKeydown);
  if (compact) floatingEl.classList.add('dropdown-panel--compact');
  close();

  const api = {
    open: openDropdown,
    close,
    forceClose,
    toggle,
    isOpen: () => open,
    destroy: () => {
      forceClose();
      openDropdownApis.delete(api);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeydown);
      floatingEl.removeEventListener('keydown', onFloatingKeydown);
      triggerEl.removeEventListener('keydown', onTriggerKeydown);
      if (compact) floatingEl.classList.remove('dropdown-panel--compact');
    },
  };
  openDropdownApis.add(api);
  return api;
}
