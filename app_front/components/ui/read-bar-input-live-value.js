/**
 * Reads the current text from a `cr-bar-input` (or similar) host.
 * Autofill and programmatic fills often update the inner control without
 * updating the parent Lit state, so callers must read the live control.
 *
 * @param {Element | { value?: unknown, shadowRoot?: ShadowRoot | { querySelector: (selector: string) => { value?: unknown } | null } } | null | undefined} host
 * @returns {string}
 */
export function readBarInputLiveValue(host) {
  if (!host) return '';
  const inner = host.shadowRoot && typeof host.shadowRoot.querySelector === 'function'
    ? host.shadowRoot.querySelector('input, textarea')
    : null;
  if (inner && typeof inner.value === 'string') return inner.value;
  return typeof host.value === 'string' ? host.value : '';
}
