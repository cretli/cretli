/**
 * Replace a host's children only when their content key changed. Every child
 * mutation of a slotted host fires `slotchange` on the shadow slot and dirties
 * style, so a periodic refresh with identical content must not touch the DOM.
 */

/** @type {WeakMap<object, string>} */
const renderedKeys = new WeakMap();

/**
 * DOM-free decision: should the children be replaced?
 *
 * @param {string | undefined} previousKey Key of the last applied content
 * @param {string} nextKey Key of the content about to be applied
 * @returns {boolean}
 */
export function shouldReplaceChildren(previousKey, nextKey) {
  return previousKey !== nextKey;
}

/**
 * @param {{ replaceChildren: (...nodes: unknown[]) => void }} host
 * @param {string} key Stable serialisation of the content
 * @param {() => unknown[]} buildNodes Called only when the key changed
 * @returns {boolean} true when the children were replaced
 */
export function syncChildren(host, key, buildNodes) {
  if (!shouldReplaceChildren(renderedKeys.get(host), key)) return false;
  renderedKeys.set(host, key);
  host.replaceChildren(...buildNodes());
  return true;
}
