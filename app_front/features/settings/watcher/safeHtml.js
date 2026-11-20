/**
 * Safe boundary for the legacy string renderers used by the Watcher settings.
 *
 * The renderers in `features/watcher/*` escape every user-controlled value, but
 * they still return markup as strings. This module parses that markup in an
 * inert document, strips everything that can execute or navigate, and hands
 * Lit a ready DocumentFragment. Nothing is ever re-serialised, so there is no
 * mutation-XSS window, and Lit owns the node range, so a re-render replaces the
 * previous content instead of stacking next to it.
 */

/** Elements that can run script, load documents or rewrite the page. */
const BLOCKED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'LINK', 'META', 'BASE', 'TEMPLATE', 'NOSCRIPT', 'NOEMBED', 'NOFRAMES', 'XMP',
  'PLAINTEXT', 'PORTAL',
  // SVG animation elements can retarget `href` to a script URL.
  'ANIMATE', 'ANIMATEMOTION', 'ANIMATETRANSFORM', 'SET', 'DISCARD', 'HANDLER', 'LISTENER',
]);

/** Attributes whose value is a URL (or a list of URLs). */
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'srcset', 'imagesrcset', 'xlink:href', 'action', 'formaction', 'poster',
  'background', 'data', 'ping', 'cite', 'longdesc', 'manifest', 'codebase', 'usemap',
  'lowsrc', 'dynsrc', 'profile', 'icon', 'archive',
]);

/** Attributes that carry markup or script text of their own. */
const FORBIDDEN_ATTRIBUTES = new Set(['srcdoc', 'is']);

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Browsers ignore ASCII whitespace and control characters inside a URL scheme
 * (`java\tscript:`), so they are removed before the scheme is read.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeUrl(value) {
  // eslint-disable-next-line no-control-regex
  const compact = String(value ?? '').replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  if (compact === '') return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  return !scheme || SAFE_SCHEMES.has(`${scheme[1].toLowerCase()}:`);
}

/**
 * A `srcset` is a comma-separated list of `<url> [descriptor]` candidates; one
 * unsafe candidate rejects the whole attribute.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeSrcset(value) {
  return String(value ?? '')
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] || '')
    .every((url) => isSafeUrl(url));
}

/**
 * Inline styles may not pull remote resources or carry script-ish constructs.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isSafeStyle(value) {
  return !/url\s*\(|expression\s*\(|javascript:|@import|behaviou?r\s*:|-moz-binding/i.test(String(value ?? ''));
}

/**
 * @param {Element} element
 */
function scrubAttributes(element) {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const keep = !name.startsWith('on')
      && !FORBIDDEN_ATTRIBUTES.has(name)
      && (!URL_ATTRIBUTES.has(name)
        || (name === 'srcset' || name === 'imagesrcset' ? isSafeSrcset(attribute.value) : isSafeUrl(attribute.value)))
      && (name !== 'style' || isSafeStyle(attribute.value));
    if (!keep) element.removeAttribute(attribute.name);
  }
}

/**
 * Parse trusted-but-unvetted markup into a sanitised DocumentFragment that
 * belongs to `doc`. Returns an empty fragment for empty input.
 *
 * @param {unknown} source
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function watcherFragment(source, doc = document) {
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><body><template>${String(source ?? '')}</template></body>`,
    'text/html',
  );
  const template = parsed.body.querySelector('template');
  if (!template) return doc.createDocumentFragment();
  const walker = parsed.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const elements = [];
  while (walker.nextNode()) elements.push(/** @type {Element} */ (walker.currentNode));
  for (const element of elements) {
    if (BLOCKED_TAGS.has(element.tagName.toUpperCase())) {
      element.remove();
      continue;
    }
    scrubAttributes(element);
  }
  return /** @type {DocumentFragment} */ (doc.importNode(template.content, true));
}
