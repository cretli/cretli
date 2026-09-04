const DEFAULT_LIMITS = Object.freeze({
  domNodes: 1_500,
  domDepth: 20,
  domChars: 200_000,
  queryResults: 100,
  consoleEntries: 100,
  networkEntries: 100,
  screenshotBytes: 1200 * 1024,
});

const STYLE_PROPERTIES = [
  'display',
  'visibility',
  'position',
  'z-index',
  'width',
  'height',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'margin',
  'padding',
  'border',
  'opacity',
  'overflow',
];

const PRIVATE_SELECTOR = '[data-cr-widget], [data-cr-private]';
const FORM_VALUE_SELECTOR = 'input, textarea, select';
const OPEN = 1;

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clip(value, maxChars = 2_000) {
  const text = String(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function safeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (depth >= 3) return '[truncated]';
  if (value instanceof Error) {
    return { name: value.name, message: clip(value.message), stack: clip(value.stack || '', 4_000) };
  }
  if (typeof Element !== 'undefined' && value instanceof Element) return describeElement(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeValue(item, depth + 1, seen));
  const result = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    try {
      result[key] = safeValue(value[key], depth + 1, seen);
    } catch {
      result[key] = '[unavailable]';
    }
  }
  return result;
}

export function createRingBuffer(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  const values = [];
  return {
    push(value) {
      values.push(value);
      if (values.length > limit) values.splice(0, values.length - limit);
    },
    values() {
      return values.slice();
    },
    clear() {
      values.length = 0;
    },
    get size() {
      return values.length;
    },
  };
}

export function redactInputValue(element) {
  if (!element || typeof element !== 'object') return undefined;
  const tagName = String(element.tagName || '').toLowerCase();
  if (tagName !== 'input' && tagName !== 'textarea' && tagName !== 'select') return undefined;
  return String(element.type || '').toLowerCase() === 'password' ? '[redacted-password]' : '[redacted]';
}

export function isAllowedNavigation(target, allowedOrigins, baseUrl) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return false;
  let url;
  try {
    url = new URL(target, baseUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  return allowedOrigins.some((origin) => {
    try {
      const allowed = new URL(origin);
      return ['http:', 'https:'].includes(allowed.protocol)
        && !allowed.username
        && !allowed.password
        && allowed.origin === url.origin;
    } catch {
      return false;
    }
  });
}

function cssPath(element) {
  if (!element || element.nodeType !== 1) return null;
  if (element.id) {
    const escaped = globalThis.CSS?.escape ? CSS.escape(element.id) : element.id.replace(/[^\w-]/g, '\\$&');
    return `#${escaped}`;
  }
  const parts = [];
  let current = element;
  while (current?.nodeType === 1 && parts.length < 8) {
    let part = current.localName;
    if (!part) break;
    const parent = current.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((item) => item.localName === current.localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}

function describeElement(element) {
  if (!element || element.nodeType !== 1 || element.closest?.(PRIVATE_SELECTOR)) return null;
  const result = {
    tag: element.localName,
    selector: cssPath(element),
  };
  if (element.id) result.id = element.id;
  if (element.classList?.length) result.classes = [...element.classList].slice(0, 20);
  const role = element.getAttribute?.('role');
  if (role) result.role = role;
  const name = element.getAttribute?.('aria-label') || element.getAttribute?.('name');
  if (name) result.name = name.slice(0, 500);
  const text = element.matches?.(FORM_VALUE_SELECTOR)
    ? ''
    : element.textContent?.replace(/\s+/g, ' ').trim();
  if (text) result.text = text.slice(0, 1_000);
  const redacted = redactInputValue(element);
  if (redacted) result.value = redacted;
  return result;
}

function serializeAttributes(element) {
  const attributes = [];
  for (const attribute of element.attributes || []) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on') || name === 'value') continue;
    attributes.push(`${attribute.name}=${JSON.stringify(attribute.value.slice(0, 2_000))}`);
  }
  const redacted = redactInputValue(element);
  if (redacted) attributes.push(`value=${JSON.stringify(redacted)}`);
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

export function serializeDom(root, customLimits = {}) {
  if (!root) return '';
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  let nodes = 0;
  let output = '';
  let truncated = false;

  const append = (text) => {
    const remaining = limits.domChars - output.length;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    output += text.slice(0, remaining);
    if (text.length > remaining) truncated = true;
    return !truncated;
  };

  const visit = (node, depth) => {
    if (truncated) return;
    if (nodes >= limits.domNodes || depth > limits.domDepth) {
      truncated = true;
      return;
    }
    if (node.nodeType === 3) {
      const text = node.textContent?.replace(/\s+/g, ' ').trim();
      if (text) {
        nodes += 1;
        append(text);
      }
      return;
    }
    if (node.nodeType !== 1 || node.matches?.(PRIVATE_SELECTOR)) return;

    nodes += 1;
    const tag = node.localName || 'element';
    if (!append(`<${tag}${serializeAttributes(node)}>`)) return;
    if (!node.matches?.('input, textarea')) {
      for (const child of node.childNodes || []) visit(child, depth + 1);
    }
    append(`</${tag}>`);
  };

  visit(root, 0);
  if (truncated) output = `${output.slice(0, Math.max(0, limits.domChars - 15))}<!-- truncated -->`;
  return output;
}

function computedStyles(element, properties = STYLE_PROPERTIES) {
  if (!element || element.nodeType !== 1 || element.closest?.(PRIVATE_SELECTOR)) return null;
  const styles = getComputedStyle(element);
  const result = {};
  for (const property of properties.slice(0, 100)) result[property] = styles.getPropertyValue(property);
  return { element: describeElement(element), styles: result };
}

function selectedElement() {
  const selection = document.getSelection?.();
  const node = selection?.anchorNode;
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}

function query(selector) {
  requireString(selector, 'selector');
  const element = document.querySelector(selector);
  if (!element || element.closest?.(PRIVATE_SELECTOR)) throw new Error(`Element not found: ${selector}`);
  return element;
}

function dispatch(element, type, Constructor = Event) {
  element.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true }));
}

const SENSITIVE_STORAGE_KEY = /(?:password|secret|token|auth|api[_-]?key|credential)/i;
const MAX_STORAGE_ENTRIES = 100;
const MAX_FORM_FIELDS = 50;

/**
 * @param {string} key
 * @param {string|null} value
 * @returns {string}
 */
export function redactStorageEntry(key, value) {
  if (SENSITIVE_STORAGE_KEY.test(String(key || ''))) return '[redacted]';
  return clip(String(value ?? ''), 2_000);
}

/**
 * @param {'local' | 'session'} kind
 * @param {string[] | null | undefined} filterKeys
 * @returns {{ kind: 'local' | 'session', entries: Record<string, string>, truncated: boolean }}
 */
export function readWebStorage(kind, filterKeys = null) {
  if (kind !== 'local' && kind !== 'session') {
    throw new TypeError('kind must be "local" or "session"');
  }
  const storage = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
  if (!storage) throw new Error(`${kind}Storage is not available`);
  const allKeys = filterKeys && Array.isArray(filterKeys) && filterKeys.length > 0
    ? filterKeys.map((key) => String(key))
    : Object.keys(storage);
  const truncated = allKeys.length > MAX_STORAGE_ENTRIES;
  const entries = {};
  for (const key of allKeys.slice(0, MAX_STORAGE_ENTRIES)) {
    try {
      entries[key] = redactStorageEntry(key, storage.getItem(key));
    } catch {
      entries[key] = '[unavailable]';
    }
  }
  return { kind, entries, truncated };
}

/**
 * @param {unknown} text
 * @returns {Promise<{ copied: true, length: number }>}
 */
export async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('text is required');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return { copied: true, length: value.length };
    } catch {
      // fall back to execCommand
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Failed to copy text to clipboard');
  return { copied: true, length: value.length };
}

let activeHighlightCleanup = null;

/**
 * @param {Element} element
 * @param {number} durationMs
 * @returns {{ selector: string | null, durationMs: number, expiresInMs: number }}
 */
function highlightElement(element, durationMs) {
  if (activeHighlightCleanup) activeHighlightCleanup();
  const boundedDurationMs = Math.min(Math.max(Number(durationMs) || 3_000, 500), 30_000);
  const overlay = document.createElement('div');
  overlay.setAttribute('data-cr-highlight', '');
  Object.assign(overlay.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483646',
    boxSizing: 'border-box',
    border: '2px solid #2563eb',
    borderRadius: '4px',
    background: 'rgba(37, 99, 235, 0.12)',
    transition: 'opacity 120ms ease',
  });
  const updatePosition = () => {
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  updatePosition();
  document.body.appendChild(overlay);
  const timeoutId = setTimeout(() => cleanup(), boundedDurationMs);
  const onScroll = () => updatePosition();
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);
  const cleanup = () => {
    clearTimeout(timeoutId);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    overlay.remove();
    if (activeHighlightCleanup === cleanup) activeHighlightCleanup = null;
  };
  activeHighlightCleanup = cleanup;
  return {
    selector: cssPath(element),
    durationMs: boundedDurationMs,
    expiresInMs: boundedDurationMs,
  };
}

/**
 * @param {Element} element
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown> | null}
 */
function describeFormElement(element, args) {
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    element.checked = Boolean(args.checked ?? args.value);
    dispatch(element, 'input', InputEvent);
    dispatch(element, 'change');
    return describeElement(element);
  }
  if (element instanceof HTMLSelectElement) {
    const values = Array.isArray(args.value) ? args.value.map(String) : [String(args.value ?? args.text ?? '')];
    for (const option of element.options) option.selected = values.includes(option.value);
    dispatch(element, 'input', InputEvent);
    dispatch(element, 'change');
    return describeElement(element);
  }
  if (!('value' in element)) {
    throw new Error('Element does not accept form input');
  }
  element.focus();
  element.value = String(args.value ?? args.text ?? '');
  dispatch(element, 'input', InputEvent);
  dispatch(element, 'change');
  return describeElement(element);
}

function socketUrl(serverUrl) {
  const url = new URL(serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('serverUrl must be an HTTP(S) URL without credentials');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws-page-bridge';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function networkUrl(value) {
  let url;
  try {
    url = new URL(String(value), globalThis.location?.href);
  } catch {
    return '[unavailable-url]';
  }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/auth|credential|key|password|secret|signature|token/i.test(key)) {
      url.searchParams.set(key, '[redacted]');
    }
  }
  return clip(url.href);
}

function debounce(callback, wait) {
  let timer;
  const wrapped = () => {
    clearTimeout(timer);
    timer = setTimeout(callback, wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

function dataUrlBytes(dataUrl) {
  return new TextEncoder().encode(dataUrl).byteLength;
}

async function canvasJpeg(canvas, maxBytes) {
  let current = canvas;
  let quality = 0.92;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dataUrl = current.toDataURL('image/jpeg', quality);
    if (dataUrlBytes(dataUrl) <= maxBytes) {
      return { dataUrl, width: current.width, height: current.height, mimeType: 'image/jpeg' };
    }
    if (quality > 0.5) {
      quality -= 0.08;
      continue;
    }
    const resized = document.createElement('canvas');
    resized.width = Math.max(1, Math.floor(current.width * 0.85));
    resized.height = Math.max(1, Math.floor(current.height * 0.85));
    resized.getContext('2d').drawImage(current, 0, 0, resized.width, resized.height);
    current = resized;
    quality = 0.82;
  }
  throw new Error('Screenshot could not be reduced below size limit');
}

const SCREENSHOT_INLINE_STYLE_PROPS = [
  'display', 'visibility', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius',
  'box-shadow', 'outline', 'outline-offset',
  'background', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'background-clip',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space',
  'word-break', 'overflow', 'overflow-x', 'overflow-y', 'opacity',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-self', 'justify-content', 'justify-items', 'gap', 'row-gap', 'column-gap',
  'grid', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'object-fit', 'object-position', 'filter', 'transform', 'transform-origin',
  'list-style', 'list-style-type', 'vertical-align',
];

function getViewportScreenshotMetrics() {
  return {
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight)),
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0,
    dpr: Math.max(1, window.devicePixelRatio || 1),
  };
}

async function withPrivateElementsHidden(task) {
  const hidden = [];
  for (const el of document.querySelectorAll(PRIVATE_SELECTOR)) {
    if (!(el instanceof HTMLElement)) continue;
    hidden.push([el, el.style.visibility]);
    el.style.visibility = 'hidden';
  }
  try {
    return await task();
  } finally {
    for (const [el, visibility] of hidden) {
      el.style.visibility = visibility;
    }
  }
}

function sanitizeScreenshotClone(root) {
  for (const el of root.querySelectorAll('script, noscript, iframe, [data-cr-widget], [data-cr-private]')) {
    el.remove();
  }
}

function inlineComputedStylesOnClone(source, clone) {
  if (!(source instanceof Element) || !(clone instanceof Element)) return;
  const computed = getComputedStyle(source);
  const parts = [];
  for (const prop of SCREENSHOT_INLINE_STYLE_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value) parts.push(`${prop}:${value}`);
  }
  clone.setAttribute('style', parts.join(';'));
  if (source instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
    const redacted = redactInputValue(source);
    clone.setAttribute('value', redacted || source.getAttribute('placeholder') || '');
  }
  if (source instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
    clone.textContent = redactInputValue(source) || source.getAttribute('placeholder') || '';
  }
  if (source instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
    clone.value = source.value;
  }
  const sourceChildren = [...source.children];
  const cloneChildren = [...clone.children];
  const count = Math.min(sourceChildren.length, cloneChildren.length);
  for (let index = 0; index < count; index += 1) {
    inlineComputedStylesOnClone(sourceChildren[index], cloneChildren[index]);
  }
}

function copyCanvasSnapshots(sourceRoot, cloneRoot) {
  const sourceCanvases = sourceRoot.querySelectorAll('canvas');
  const cloneCanvases = cloneRoot.querySelectorAll('canvas');
  for (let index = 0; index < sourceCanvases.length; index += 1) {
    const sourceCanvas = sourceCanvases[index];
    const cloneCanvas = cloneCanvases[index];
    if (!(cloneCanvas instanceof HTMLCanvasElement)) continue;
    try {
      cloneCanvas.width = sourceCanvas.width;
      cloneCanvas.height = sourceCanvas.height;
      cloneCanvas.getContext('2d')?.drawImage(sourceCanvas, 0, 0);
    } catch {
      // Ignore tainted canvases.
    }
  }
}

function buildViewportScreenshotClone() {
  if (!document.body) throw new Error('Document body is unavailable');
  const metrics = getViewportScreenshotMetrics();
  const viewport = document.createElement('div');
  viewport.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  viewport.style.width = `${metrics.width}px`;
  viewport.style.height = `${metrics.height}px`;
  viewport.style.overflow = 'hidden';
  viewport.style.position = 'relative';
  viewport.style.margin = '0';
  viewport.style.padding = '0';
  viewport.style.background = effectiveBg(document.body) || effectiveBg(document.documentElement) || '#ffffff';
  const layer = document.createElement('div');
  layer.style.transform = `translate(${-metrics.scrollX}px, ${-metrics.scrollY}px)`;
  layer.style.transformOrigin = 'top left';
  layer.style.width = `${Math.max(document.documentElement.scrollWidth, metrics.width)}px`;
  layer.style.height = `${Math.max(document.documentElement.scrollHeight, metrics.height)}px`;
  const bodyClone = document.body.cloneNode(true);
  sanitizeScreenshotClone(bodyClone);
  inlineComputedStylesOnClone(document.body, bodyClone);
  copyCanvasSnapshots(document.body, bodyClone);
  layer.appendChild(bodyClone);
  viewport.appendChild(layer);
  return { viewport, metrics };
}

function serializeForeignObjectMarkup(node, width, height) {
  const serialized = new XMLSerializer().serializeToString(node);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<foreignObject width="100%" height="100%">`
    + serialized
    + '</foreignObject></svg>';
}

async function rasterizeSvgMarkup(svgMarkup, width, height, dpr) {
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = () => resolve(undefined);
      image.onerror = () => reject(new Error('SVG screenshot rasterization failed'));
      image.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.scale(dpr, dpr);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function renderForeignObjectScreenshot() {
  if (document.fonts?.ready) {
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2500))]);
  }
  return withPrivateElementsHidden(async () => {
    const { viewport, metrics } = buildViewportScreenshotClone();
    const svgMarkup = serializeForeignObjectMarkup(viewport, metrics.width, metrics.height);
    return rasterizeSvgMarkup(svgMarkup, metrics.width, metrics.height, metrics.dpr);
  });
}

function parseCssPx(value, fallback = 0) {
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

function rectInView(rect, vw, vh) {
  return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
}

function isVisible(el) {
  if (!(el instanceof Element)) return false;
  if (el.matches(PRIVATE_SELECTOR)) return false;
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  if (parseCssPx(s.opacity, 1) <= 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && rectInView(r, window.innerWidth, window.innerHeight);
}

function opaqueColor(c) {
  if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
  if (c.startsWith('rgba')) {
    const a = Number.parseFloat(c.split(',').at(-1) || '');
    if (!Number.isFinite(a) || a <= 0) return null;
  }
  return c;
}

function effectiveBg(el) {
  let cur = el;
  while (cur instanceof Element) {
    const bg = opaqueColor(getComputedStyle(cur).backgroundColor);
    if (bg) return bg;
    cur = cur.parentElement;
  }
  return null;
}

function canvasFont(s, scale) {
  let sz = parseCssPx(s.fontSize, 14);
  if (sz <= 1) sz = 14;
  const scaled = sz * scale;
  const style = s.fontStyle && s.fontStyle !== 'normal' ? s.fontStyle + ' ' : '';
  return `${style}${s.fontWeight || 'normal'} ${scaled}px ${s.fontFamily || 'sans-serif'}`;
}

function roundRect(ctx, x, y, w, h, radii) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radii);
  } else {
    const r = typeof radii === 'number' ? radii : (radii[0] || 0);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function paintBg(ctx, el, scale) {
  const s = getComputedStyle(el);
  const bg = opaqueColor(s.backgroundColor);
  if (!bg) return;
  const r = el.getBoundingClientRect();
  const br = parseCssPx(s.borderRadius);
  ctx.fillStyle = bg;
  if (br > 0) {
    roundRect(ctx, r.left * scale, r.top * scale, r.width * scale, r.height * scale, br * scale);
    ctx.fill();
  } else {
    ctx.fillRect(r.left * scale, r.top * scale, r.width * scale, r.height * scale);
  }
}

function paintBorder(ctx, el, scale) {
  const s = getComputedStyle(el);
  const bw = Math.max(
    parseCssPx(s.borderTopWidth), parseCssPx(s.borderRightWidth),
    parseCssPx(s.borderBottomWidth), parseCssPx(s.borderLeftWidth),
  );
  if (bw <= 0) return;
  const color = opaqueColor(s.borderTopColor) || opaqueColor(s.borderRightColor)
    || opaqueColor(s.borderBottomColor) || opaqueColor(s.borderLeftColor);
  if (!color) return;
  const r = el.getBoundingClientRect();
  const lw = Math.max(1, bw * scale);
  const br = parseCssPx(s.borderRadius);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  if (br > 0) {
    roundRect(ctx, r.left * scale + lw / 2, r.top * scale + lw / 2,
      Math.max(0, r.width * scale - lw), Math.max(0, r.height * scale - lw), br * scale);
    ctx.stroke();
  } else {
    ctx.strokeRect(r.left * scale + lw / 2, r.top * scale + lw / 2,
      Math.max(0, r.width * scale - lw), Math.max(0, r.height * scale - lw));
  }
}

function paintImage(ctx, el, scale, baseUrl) {
  if (!(el instanceof HTMLImageElement)) return;
  if (!el.complete || el.naturalWidth <= 0) return;
  const src = el.currentSrc || el.src;
  if (!src || isCrossOriginResource(src, baseUrl)) return;
  const r = el.getBoundingClientRect();
  try {
    ctx.drawImage(el, r.left * scale, r.top * scale, r.width * scale, r.height * scale);
  } catch { /* tainted */ }
}

function paintFormControl(ctx, el, scale) {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const x = r.left * scale, y = r.top * scale, w = r.width * scale, h = r.height * scale;

  const bg = opaqueColor(s.backgroundColor) || effectiveBg(el);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
  }
  paintBorder(ctx, el, scale);

  const value = redactInputValue(el)
    || el.getAttribute('placeholder')
    || el.getAttribute('aria-label') || '';
  if (!value) return;

  ctx.fillStyle = s.color || '#444';
  ctx.font = canvasFont(s, scale);
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value).slice(0, 120), x + 6 * scale, y + h / 2, Math.max(0, w - 12 * scale));
}

function paintText(ctx, scale, root) {
  if (!root) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest(PRIVATE_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    const cur = node;
    node = walker.nextNode();

    const txt = (cur.textContent || '');
    if (!txt.trim()) continue;

    const parent = cur.parentElement;
    if (!parent) continue;

    const range = document.createRange();
    range.selectNode(cur);
    const rects = range.getClientRects();
    if (!rects.length) continue;

    const s = getComputedStyle(parent);
    if (parseCssPx(s.fontSize, 14) <= 1) continue;

    ctx.fillStyle = s.color || '#444';
    ctx.font = canvasFont(s, scale);
    ctx.textBaseline = 'top';

    const textParts = txt.split(/\n/);
    let partIdx = 0;
    for (const rect of rects) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (!rectInView(rect, vw, vh)) continue;
      const part = textParts[partIdx] || txt;
      partIdx++;
      ctx.fillText(
        part.trim().slice(0, 300),
        rect.left * scale,
        rect.top * scale,
        Math.max(1, rect.width * scale),
      );
    }
  }
}

function paintIconLabels(ctx, scale, root) {
  if (!root) return;
  for (const el of root.querySelectorAll('button, [role="button"], .btn, a.btn')) {
    if (!isVisible(el)) continue;
    if ((el.innerText || '').trim()) continue;
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-label');
    if (!label) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    ctx.fillStyle = s.color || '#444';
    ctx.font = canvasFont(s, scale);
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 40), r.left * scale + 4 * scale,
      r.top * scale + r.height * scale / 2, Math.max(0, r.width * scale - 8 * scale));
  }
}

async function renderCanvasScreenshot() {
  if (document.fonts?.ready) {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]);
  }

  const metrics = getViewportScreenshotMetrics();
  const width = metrics.width;
  const height = metrics.height;
  const baseUrl = globalThis.location?.href || 'about:blank';

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * metrics.dpr));
  canvas.height = Math.max(1, Math.round(height * metrics.dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.scale(metrics.dpr, metrics.dpr);

  ctx.fillStyle = effectiveBg(document.body) || effectiveBg(document.documentElement) || '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const root = document.body;
  const all = root ? [...root.querySelectorAll('*')].filter(isVisible) : [];
  const scale = 1;

  for (const el of all) paintBg(ctx, el, scale);
  for (const el of all) paintBorder(ctx, el, scale);
  for (const el of all) paintImage(ctx, el, scale, baseUrl);
  for (const el of all) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      || el instanceof HTMLSelectElement) {
      paintFormControl(ctx, el, scale);
    }
  }

  paintText(ctx, scale, root);
  paintIconLabels(ctx, scale, root);

  return canvas;
}

export function isCrossOriginResource(url, baseUrl) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return false;
  try {
    return new URL(trimmed, baseUrl).origin !== new URL(baseUrl).origin;
  } catch {
    return true;
  }
}

async function domScreenshot(maxBytes) {
  try {
    const canvas = await renderForeignObjectScreenshot();
    return canvasJpeg(canvas, maxBytes);
  } catch {
    const canvas = await renderCanvasScreenshot();
    return canvasJpeg(canvas, maxBytes);
  }
}

async function displayScreenshot(maxBytes) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Display screenshot is not supported by this browser');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (error) {
    throw new Error(`Display screenshot requires a user gesture and screen-share approval: ${errorMessage(error)}`);
  }
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, video.videoWidth || 1);
    canvas.height = Math.max(1, video.videoHeight || 1);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return await canvasJpeg(canvas, maxBytes);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/**
 * @param {Element} element
 * @param {object} [customLimits]
 * @returns {object|null}
 */
export function buildElementPickContext(element, customLimits = {}) {
  if (!element || element.nodeType !== 1 || element.closest?.(PRIVATE_SELECTOR)) return null;
  const limits = {
    ...DEFAULT_LIMITS,
    domNodes: 800,
    domDepth: 12,
    domChars: 32_000,
    ...customLimits,
  };
  return {
    pickedAt: new Date().toISOString(),
    url: typeof location !== 'undefined' ? location.href : '',
    title: typeof document !== 'undefined' ? document.title : '',
    element: describeElement(element),
    subtreeDom: serializeDom(element, limits),
    computedStyles: computedStyles(element),
  };
}

function resolvePickerCandidate(clientX, clientY, overlay) {
  const candidate = document.elementFromPoint(clientX, clientY);
  if (!candidate || candidate === overlay || candidate.closest?.(PRIVATE_SELECTOR)) return null;
  return candidate;
}

function installPicker(signal, options = {}) {
  const withContext = options.withContext === true;
  const limits = options.limits || DEFAULT_LIMITS;
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.dataset.crWidget = 'page-picker';
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483647',
      border: '2px solid #4f8cff',
      background: 'rgba(79, 140, 255, .12)',
      display: 'none',
    });
    document.documentElement.append(overlay);
    let hovered = null;
    const cleanup = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('touchend', touchEnd, true);
      document.removeEventListener('keydown', keydown, true);
      signal?.removeEventListener('abort', abort);
      overlay.remove();
    };
    const finish = (action, value) => {
      cleanup();
      action(value);
    };
    const highlightCandidate = (candidate) => {
      if (!candidate) return;
      hovered = candidate;
      const rect = candidate.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: 'block',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    };
    const move = (event) => {
      const point = event.touches?.[0] || event;
      const candidate = resolvePickerCandidate(point.clientX, point.clientY, overlay);
      if (!candidate) return;
      highlightCandidate(candidate);
    };
    const resolvePick = (candidate) => {
      if (candidate?.nodeType !== 1 || candidate.closest?.(PRIVATE_SELECTOR)) return;
      const result = withContext
        ? buildElementPickContext(candidate, limits)
        : describeElement(candidate);
      if (!result) return;
      finish(resolve, result);
    };
    const click = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      resolvePick(hovered || event.target);
    };
    const touchEnd = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const touch = event.changedTouches?.[0];
      if (touch) {
        const candidate = resolvePickerCandidate(touch.clientX, touch.clientY, overlay);
        resolvePick(candidate || hovered);
        return;
      }
      resolvePick(hovered);
    };
    const keydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(reject, new Error('Element picking cancelled'));
    };
    const abort = () => finish(reject, new Error('Element picking cancelled'));
    document.addEventListener('mousemove', move, true);
    document.addEventListener('touchmove', move, { capture: true, passive: false });
    document.addEventListener('click', click, true);
    document.addEventListener('touchend', touchEnd, { capture: true, passive: false });
    document.addEventListener('keydown', keydown, true);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const installation = options.installation;
  if (!installation || typeof installation !== 'object' || Array.isArray(installation)) {
    throw new TypeError('installation must be an object');
  }
  return {
    serverUrl: requireString(options.serverUrl, 'serverUrl'),
    accessToken: requireString(options.accessToken, 'accessToken'),
    pageSessionId: requireString(options.pageSessionId, 'pageSessionId'),
    allowedOrigins: Array.isArray(installation.allowedOrigins) ? [...installation.allowedOrigins] : [],
    permissions: new Set(Array.isArray(installation.permissions) ? installation.permissions : []),
    onState: typeof options.onState === 'function' ? options.onState : null,
    WebSocketClass: options.WebSocketClass || globalThis.WebSocket,
    limits: { ...DEFAULT_LIMITS, ...(options.limits || {}) },
  };
}

export function createPageBridge(options) {
  const config = normalizeOptions(options);
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new Error('createPageBridge must run in a browser page context');
  }
  if (typeof config.WebSocketClass !== 'function') throw new Error('WebSocket is not available');

  const consoleEntries = createRingBuffer(config.limits.consoleEntries);
  const networkEntries = createRingBuffer(config.limits.networkEntries);
  const restorers = [];
  const observers = [];
  const pickerController = new AbortController();
  let socket = null;
  let destroyed = false;
  let revision = 0;
  let latestState = null;
  let boundChatSessionKey = '';

  const captureState = () => {
    const active = document.activeElement;
    const selected = selectedElement();
    latestState = {
      revision: ++revision,
      capturedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio,
      },
      activeElement: describeElement(active),
      selectedElement: describeElement(selected),
      selectedComputedStyles: computedStyles(selected),
      dom: serializeDom(document.documentElement, config.limits),
      console: consoleEntries.values(),
      network: networkEntries.values(),
    };
    try {
      config.onState?.(latestState);
    } catch {
      // A host callback must not interrupt bridge state delivery.
    }
    send({ type: 'pageState', state: latestState });
    return latestState;
  };
  const scheduleState = debounce(captureState, 150);

  const recordConsole = (level, args) => {
    consoleEntries.push({
      timestamp: new Date().toISOString(),
      level,
      args: args.map((value) => safeValue(value)),
    });
    scheduleState();
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level];
    console[level] = function pageBridgeConsole(...args) {
      recordConsole(level, args);
      return original.apply(this, args);
    };
    restorers.push(() => { console[level] = original; });
  }

  const onError = (event) => recordConsole('error', [{
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error,
  }]);
  const onRejection = (event) => recordConsole('error', [{ unhandledRejection: event.reason }]);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  restorers.push(() => window.removeEventListener('error', onError));
  restorers.push(() => window.removeEventListener('unhandledrejection', onRejection));

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = async function pageBridgeFetch(input, init = {}) {
      const started = performance.now();
      const method = String(init.method || input?.method || 'GET').toUpperCase();
      const url = networkUrl(input?.url || input);
      try {
        const response = await originalFetch.apply(this, arguments);
        networkEntries.push({
          type: 'fetch',
          method,
          url,
          status: response.status,
          ok: response.ok,
          durationMs: Math.round(performance.now() - started),
          timestamp: new Date().toISOString(),
        });
        scheduleState();
        return response;
      } catch (error) {
        networkEntries.push({
          type: 'fetch',
          method,
          url,
          error: errorMessage(error),
          durationMs: Math.round(performance.now() - started),
          timestamp: new Date().toISOString(),
        });
        scheduleState();
        throw error;
      }
    };
    restorers.push(() => { window.fetch = originalFetch; });
  }

  if (typeof window.XMLHttpRequest === 'function') {
    const prototype = window.XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    prototype.open = function pageBridgeXhrOpen(method, url) {
      this.__crPageBridge = { method: String(method).toUpperCase(), url: networkUrl(url) };
      return originalOpen.apply(this, arguments);
    };
    prototype.send = function pageBridgeXhrSend() {
      const metadata = this.__crPageBridge || { method: 'GET', url: '' };
      const started = performance.now();
      const done = () => {
        networkEntries.push({
          type: 'xhr',
          ...metadata,
          status: this.status,
          durationMs: Math.round(performance.now() - started),
          timestamp: new Date().toISOString(),
        });
        scheduleState();
      };
      this.addEventListener('loadend', done, { once: true });
      return originalSend.apply(this, arguments);
    };
    restorers.push(() => {
      prototype.open = originalOpen;
      prototype.send = originalSend;
    });
  }

  if (typeof PerformanceObserver === 'function') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          networkEntries.push({
            type: 'resource',
            initiatorType: entry.initiatorType,
            url: networkUrl(entry.name),
            durationMs: Math.round(entry.duration),
            transferSize: entry.transferSize,
            timestamp: new Date().toISOString(),
          });
        }
        scheduleState();
      });
      observer.observe({ type: 'resource', buffered: true });
      observers.push(observer);
    } catch {
      // Resource timing is optional.
    }
  }

  const mutationObserver = new MutationObserver(scheduleState);
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  observers.push(mutationObserver);
  for (const event of ['resize', 'scroll', 'focusin', 'selectionchange']) {
    const target = event === 'selectionchange' ? document : window;
    target.addEventListener(event, scheduleState, { passive: true });
    restorers.push(() => target.removeEventListener(event, scheduleState));
  }

  const handlers = {
    getContext: () => captureState(),
    getDom: (args) => serializeDom(
      args?.selector ? query(args.selector) : document.documentElement,
      { ...config.limits, ...(args?.limits || {}) },
    ),
    queryElements: (args) => {
      requireString(args?.selector, 'selector');
      return [...document.querySelectorAll(args.selector)]
        .filter((element) => !element.closest?.(PRIVATE_SELECTOR))
        .slice(0, config.limits.queryResults)
        .map(describeElement);
    },
    getComputedStyles: (args) => computedStyles(query(args?.selector), args?.properties),
    getConsole: () => consoleEntries.values(),
    getNetwork: () => networkEntries.values(),
    takeScreenshot: (args) => args?.mode === 'display'
      ? displayScreenshot(config.limits.screenshotBytes)
      : domScreenshot(config.limits.screenshotBytes),
    click: (args) => {
      const element = query(args?.selector);
      element.click();
      return describeElement(element);
    },
    type: (args) => {
      const element = query(args?.selector);
      if (!('value' in element)) throw new Error('Element does not accept text input');
      element.focus();
      element.value = String(args?.text ?? '');
      dispatch(element, 'input', InputEvent);
      dispatch(element, 'change');
      return describeElement(element);
    },
    select: (args) => {
      const element = query(args?.selector);
      if (!(element instanceof HTMLSelectElement)) throw new Error('Element is not a select');
      const values = Array.isArray(args?.value) ? args.value.map(String) : [String(args?.value ?? '')];
      for (const option of element.options) option.selected = values.includes(option.value);
      dispatch(element, 'input', InputEvent);
      dispatch(element, 'change');
      return describeElement(element);
    },
    scroll: (args) => {
      if (args?.selector) {
        const element = query(args.selector);
        element.scrollIntoView({
          behavior: args.behavior === 'smooth' ? 'smooth' : 'auto',
          block: args.block || 'center',
        });
        return describeElement(element);
      }
      window.scrollTo({
        left: Number(args?.x) || 0,
        top: Number(args?.y) || 0,
        behavior: args?.behavior === 'smooth' ? 'smooth' : 'auto',
      });
      return { x: window.scrollX, y: window.scrollY };
    },
    focus: (args) => {
      const element = query(args?.selector);
      element.focus();
      dispatch(element, 'focusin', FocusEvent);
      return describeElement(element);
    },
    reload: () => {
      location.reload();
      return { reloading: true };
    },
    navigate: (args) => {
      const target = requireString(args?.url, 'url');
      if (!isAllowedNavigation(target, config.allowedOrigins, location.href)) {
        throw new Error('Navigation origin is not allowed by this installation');
      }
      const url = new URL(target, location.href).href;
      location.assign(url);
      return { navigating: true, url };
    },
    waitFor: async (args) => {
      const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || 5_000, 1), 60_000);
      const intervalMs = Math.min(Math.max(Number(args?.intervalMs) || 100, 20), 2_000);
      const started = performance.now();
      while (performance.now() - started < timeoutMs) {
        const element = document.querySelector(requireString(args?.selector, 'selector'));
        if (element && !element.closest?.(PRIVATE_SELECTOR)) return describeElement(element);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error(`Timed out waiting for element: ${args.selector}`);
    },
    pickElement: () => installPicker(pickerController.signal),
    pressKey: (args) => {
      const key = requireString(args?.key, 'key');
      const target = args?.selector ? query(args.selector) : (document.activeElement || document.body);
      const eventInit = {
        key,
        code: typeof args?.code === 'string' && args.code.trim() ? args.code.trim() : key,
        bubbles: true,
        cancelable: true,
        ctrlKey: Boolean(args?.ctrlKey),
        shiftKey: Boolean(args?.shiftKey),
        altKey: Boolean(args?.altKey),
        metaKey: Boolean(args?.metaKey),
      };
      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      return describeElement(target instanceof Element ? target : document.body);
    },
    copyText: async (args) => copyTextToClipboard(args?.text),
    highlight: (args) => highlightElement(
      query(args?.selector),
      Number(args?.durationMs) || 3_000,
    ),
    hover: (args) => {
      const element = query(args?.selector);
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const init = { bubbles: true, cancelable: true, clientX, clientY, view: window };
      element.dispatchEvent(new MouseEvent('mouseover', init));
      element.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
      element.dispatchEvent(new MouseEvent('mousemove', init));
      return describeElement(element);
    },
    readStorage: (args) => {
      const kind = args?.kind === 'session' ? 'session' : 'local';
      const keys = Array.isArray(args?.keys) ? args.keys.map(String) : null;
      return readWebStorage(kind, keys);
    },
    fillForm: (args) => {
      if (!Array.isArray(args?.fields) || args.fields.length === 0) {
        throw new Error('fields must be a non-empty array');
      }
      return args.fields.slice(0, MAX_FORM_FIELDS).map((field) => {
        const selector = requireString(field?.selector, 'fields[].selector');
        return describeFormElement(query(selector), field || {});
      });
    },
  };

  const commandPermissions = {
    getContext: 'context',
    getDom: 'dom',
    queryElements: 'dom',
    getComputedStyles: 'dom',
    getConsole: 'console',
    getNetwork: 'network',
    takeScreenshot: 'screenshot',
    click: 'interact',
    type: 'interact',
    select: 'interact',
    scroll: 'interact',
    focus: 'interact',
    reload: 'navigate',
    navigate: 'navigate',
    waitFor: 'interact',
    pickElement: 'interact',
    pressKey: 'interact',
    copyText: 'interact',
    highlight: 'interact',
    hover: 'interact',
    fillForm: 'interact',
    readStorage: 'storage',
  };

  const send = (message) => {
    if (socket?.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const handleCommand = async (message) => {
    if (typeof message.id !== 'string' || typeof message.command !== 'string') return;
    const permission = commandPermissions[message.command];
    const handler = handlers[message.command];
    if (!handler || !permission) {
      send({
        type: 'commandResult',
        id: message.id,
        error: `Unsupported page command: ${message.command}`,
      });
      return;
    }
    if (!config.permissions.has(permission)) {
      send({
        type: 'commandResult',
        id: message.id,
        error: `Command requires permission: ${permission}`,
      });
      return;
    }
    try {
      const result = await handler(message.args || {});
      send({ type: 'commandResult', id: message.id, result });
      scheduleState();
    } catch (error) {
      send({
        type: 'commandResult',
        id: message.id,
        error: errorMessage(error),
      });
    }
  };

  const connect = () => {
    if (destroyed) throw new Error('Page bridge has been destroyed');
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    socket = new config.WebSocketClass(socketUrl(config.serverUrl));
    socket.onopen = () => {
      send({
        type: 'auth',
        token: config.accessToken,
        pageSessionId: config.pageSessionId,
      });
      captureState();
      if (boundChatSessionKey) {
        send({ type: 'bindChat', chatSessionKey: boundChatSessionKey });
      }
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.type === 'command') void handleCommand(message);
    };
    socket.onerror = () => {};
    return socket;
  };

  connect();

  return {
    bindChat(chatSessionKey) {
      const normalized = requireString(chatSessionKey, 'chatSessionKey');
      boundChatSessionKey = normalized;
      send({ type: 'bindChat', chatSessionKey: normalized });
    },
    async takeScreenshot(args = {}) {
      if (!config.permissions.has('screenshot')) {
        throw new Error('This widget installation lacks the screenshot permission');
      }
      const mode = args?.mode === 'display' ? 'display' : 'dom';
      return mode === 'display'
        ? displayScreenshot(config.limits.screenshotBytes)
        : domScreenshot(config.limits.screenshotBytes);
    },
    async pickElementWithContext() {
      if (!config.permissions.has('interact')) {
        throw new Error('This widget installation lacks the interact permission');
      }
      const result = await installPicker(pickerController.signal, {
        withContext: true,
        limits: config.limits,
      });
      if (!result) throw new Error('Element picking failed');
      return result;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scheduleState.cancel();
      pickerController.abort();
      for (const observer of observers) observer.disconnect();
      for (const restore of restorers.reverse()) restore();
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    },
    getState() {
      return latestState || captureState();
    },
    reconnect() {
      return connect();
    },
  };
}
