/**
 * Writes text into an element whose only content is ONE Lit text binding
 * (e.g. html`<span>${summary}</span>`).
 *
 * `el.textContent = x` removes Lit's marker comments and text node, so the next
 * Lit commit reads a null `nextSibling` and throws "Cannot set properties of
 * null (setting data)". Updating the existing text node's `data` keeps the part
 * intact.
 *
 * Contract: the element must have exactly one text node child and no element
 * children. Anything else (static prefix/suffix, several bindings, nested
 * elements) cannot be mapped to a single part, so it is left untouched and the
 * function returns false. An element with no children at all gets a new text node.
 * @param {Element} el
 * @param {string} text
 * @returns {boolean} true when the text was written
 */
export function setSingleBindingText(el, text) {
  const next = String(text ?? '');
  const nodes = [...el.childNodes];
  if (!nodes.length) {
    el.appendChild(el.ownerDocument.createTextNode(next));
    return true;
  }
  const textNodes = nodes.filter((n) => n.nodeType === 3);
  if (textNodes.length !== 1 || nodes.some((n) => n.nodeType === 1)) return false;
  const textNode = /** @type {Text} */ (textNodes[0]);
  if (textNode.data !== next) textNode.data = next;
  return true;
}
