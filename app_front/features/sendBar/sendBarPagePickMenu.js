/**
 * Page-element picking only works inside the embedded widget.
 * Hide the row in the standalone app instead of showing it disabled.
 *
 * @param {{
 *   item?: { hidden?: boolean, classList?: { toggle: Function }, setAttribute: Function, querySelector?: Function } | null,
 *   label?: { textContent?: string } | null,
 *   enabled?: boolean,
 *   enabledLabel?: string,
 * }} options
 */
export function applyPagePickMenuVisibility(options = {}) {
  const item = options.item;
  if (!item || typeof item.setAttribute !== 'function') return;
  const enabled = options.enabled === true;
  item.hidden = !enabled;
  item.classList?.toggle('is-hidden', !enabled);
  item.classList?.toggle('is-disabled', !enabled);
  item.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  const label = options.label
    || (typeof item.querySelector === 'function' ? item.querySelector('.chat-list-item-title') : null);
  if (!label || !options.enabledLabel) return;
  label.textContent = options.enabledLabel;
}
