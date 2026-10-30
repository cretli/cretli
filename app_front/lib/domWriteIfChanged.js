/**
 * Write a DOM property or attribute only when the value differs, so a repeated
 * visual-state pass with unchanged state costs no style invalidation.
 *
 * @param {any} el
 * @param {string} name Property name, or attribute name when `asAttribute`
 * @param {unknown} value
 * @param {boolean} [asAttribute]
 * @returns {boolean} true when a write happened
 */
export function writeIfChanged(el, name, value, asAttribute = false) {
  if (asAttribute) {
    if (typeof el.getAttribute === 'function' && el.getAttribute(name) === String(value)) return false;
    el.setAttribute(name, String(value));
    return true;
  }
  if (el[name] === value) return false;
  el[name] = value;
  return true;
}
