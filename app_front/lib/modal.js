/**
 * Modal helpers: shared open/close/init logic for the app's dialog windows.
 */

/**
 * @param {HTMLElement | null} modalEl
 */
export function open(modalEl) {
  if (modalEl) modalEl.hidden = false;
}

/**
 * @param {HTMLElement | null} modalEl
 */
export function close(modalEl) {
  if (modalEl) modalEl.hidden = true;
}

/**
 * @param {HTMLElement | null} modalEl
 * @returns {boolean}
 */
export function isOpen(modalEl) {
  return !!modalEl && !modalEl.hidden;
}

/**
 * Initializes a modal: closes it up front and wires the backdrop click to close.
 * @param {HTMLElement | null} modalEl
 * @param {{ backdropSelector?: string }} [options]
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean }}
 */
export function initModal(modalEl, options = {}) {
  const backdropSelector = options.backdropSelector ?? '.chat-settings-backdrop';
  if (modalEl) {
    close(modalEl);
    const backdrop = modalEl.querySelector(backdropSelector);
    if (backdrop) {
      backdrop.addEventListener('click', () => close(modalEl));
    }
  }
  return {
    open: () => open(modalEl),
    close: () => close(modalEl),
    isOpen: () => isOpen(modalEl),
  };
}
