/**
 * Replaces the children of `el` with markup built from already-escaped HTML strings.
 * Parsed through DOMParser so scripts never run and no HTML-property assignment is needed.
 * @param {Element} el
 * @param {string} html
 */
export function replaceChildrenWithHtml(el, html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  el.replaceChildren(...Array.from(doc.body.childNodes));
}
