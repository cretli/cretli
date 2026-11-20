/**
 * Delegation / mailbox history cards — bounded Markdown preview and expand pages.
 *
 * Full report text stays in an in-memory store (never mounted as one DOM text
 * node). Markdown runs only on preview or one expand page at a time.
 */

import {
  UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES,
  UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES,
  UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES,
} from './uiFreezeRenderBudgets.js';

export {
  UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES,
  UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES,
  UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES,
};

/** @typedef {{ text: string, utf8Bytes: number, truncated: boolean }} Utf8TextSlice */

/** @type {Map<string, string>} */
const fullTextByContentKey = new Map();

/** @type {Map<string, string>} */
const markdownHtmlCache = new Map();

let markdownRenderInvocations = 0;

/**
 * Test-only reset of module singleton state.
 */
export function resetHistoryCardReportRuntimeForTests() {
  fullTextByContentKey.clear();
  markdownHtmlCache.clear();
  markdownRenderInvocations = 0;
}

/**
 * @returns {number}
 */
export function getHistoryCardReportMarkdownRenderCount() {
  return markdownRenderInvocations;
}

/**
 * @param {number} code Unit UTF-16 code unit ( BMP or lead surrogate ).
 * @returns {number}
 */
function utf8BytesForCodeUnit(code) {
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code <= 0xffff) return 3;
  return 4;
}

/**
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
function nextStringIndex(source, index) {
  const code = source.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) return index + 2;
  return index + 1;
}

/**
 * @param {string} text
 * @returns {number}
 */
export function measureUtf8ByteLength(text) {
  const source = String(text || '');
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(source).length;
  }
  let bytes = 0;
  for (let i = 0; i < source.length; i = nextStringIndex(source, i)) {
    bytes += utf8BytesForCodeUnit(source.charCodeAt(i));
  }
  return bytes;
}

/**
 * @param {string} fullText
 * @returns {number}
 */
function fnv1aUtf16Hash(fullText) {
  let hash = 2166136261;
  for (let i = 0; i < fullText.length; i += 1) {
    hash ^= fullText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Extra disambiguation when FNV collides on different bodies with same length.
 *
 * @param {string} fullText
 * @returns {string}
 */
function computeHistoryCardReportCollisionSuffix(fullText) {
  const len = fullText.length;
  if (len === 0) return '0';
  const head = fullText.slice(0, Math.min(64, len));
  const tail = fullText.slice(Math.max(0, len - 64));
  const midStart = Math.max(0, Math.floor(len / 2) - 32);
  const mid = fullText.slice(midStart, midStart + 64);
  const sample = `${head}|${mid}|${tail}`;
  return fnv1aUtf16Hash(sample).toString(16);
}

/**
 * Stable key for deduplicating Markdown work across delegation + mailbox cards.
 *
 * @param {string} fullText
 * @returns {string}
 */
export function computeHistoryCardReportContentKey(fullText) {
  const s = String(fullText || '');
  const utf8Bytes = measureUtf8ByteLength(s);
  const hash = fnv1aUtf16Hash(s);
  return `${hash.toString(16)}-${utf8Bytes}-${s.length}`;
}

/**
 * @param {string} fullText
 * @returns {string}
 */
export function registerHistoryCardReportFullText(fullText) {
  const text = String(fullText || '');
  let contentKey = computeHistoryCardReportContentKey(text);
  const existing = fullTextByContentKey.get(contentKey);
  if (existing !== undefined && existing !== text) {
    contentKey = `${contentKey}-c${computeHistoryCardReportCollisionSuffix(text)}`;
  }
  fullTextByContentKey.set(contentKey, text);
  return contentKey;
}

/**
 * @param {string} contentKey
 * @returns {string}
 */
export function getHistoryCardReportFullText(contentKey) {
  return fullTextByContentKey.get(String(contentKey || '')) || '';
}

/**
 * @param {string} text
 * @param {number} maxUtf8Bytes
 * @returns {Utf8TextSlice}
 */
export function truncateUtf8Text(text, maxUtf8Bytes) {
  const source = String(text || '');
  const limit = Math.max(0, Number(maxUtf8Bytes) || 0);
  if (limit <= 0) {
    const totalBytes = source.length > 0 ? measureUtf8ByteLength(source) : 0;
    return { text: '', utf8Bytes: 0, truncated: totalBytes > 0 };
  }
  let byteCount = 0;
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    const charBytes = utf8BytesForCodeUnit(code);
    if (byteCount + charBytes > limit) break;
    byteCount += charBytes;
    index = nextStringIndex(source, index);
  }
  if (index >= source.length) {
    return { text: source, utf8Bytes: byteCount, truncated: false };
  }
  return { text: source.slice(0, index), utf8Bytes: byteCount, truncated: true };
}

/**
 * @param {string} text
 * @param {number} startUtf8ByteOffset
 * @param {number} maxUtf8Bytes
 * @returns {{ text: string, utf8Bytes: number, nextUtf8ByteOffset: number, hasMore: boolean }}
 */
export function sliceUtf8TextPage(text, startUtf8ByteOffset, maxUtf8Bytes) {
  const source = String(text || '');
  const start = Math.max(0, Number(startUtf8ByteOffset) || 0);
  const limit = Math.max(0, Number(maxUtf8Bytes) || 0);
  if (limit <= 0) {
    return { text: '', utf8Bytes: 0, nextUtf8ByteOffset: start, hasMore: start < measureUtf8ByteLength(source) };
  }
  let byteCursor = 0;
  let charStart = 0;
  while (charStart < source.length && byteCursor < start) {
    const code = source.charCodeAt(charStart);
    const charBytes = utf8BytesForCodeUnit(code);
    if (byteCursor + charBytes > start) break;
    byteCursor += charBytes;
    charStart = nextStringIndex(source, charStart);
  }
  if (charStart >= source.length) {
    return { text: '', utf8Bytes: 0, nextUtf8ByteOffset: start, hasMore: false };
  }
  let pageBytes = 0;
  let pageEnd = charStart;
  while (pageEnd < source.length && pageBytes < limit) {
    const code = source.charCodeAt(pageEnd);
    const charBytes = utf8BytesForCodeUnit(code);
    if (pageBytes + charBytes > limit) break;
    pageBytes += charBytes;
    pageEnd = nextStringIndex(source, pageEnd);
  }
  const nextUtf8ByteOffset = start + pageBytes;
  return {
    text: source.slice(charStart, pageEnd),
    utf8Bytes: pageBytes,
    nextUtf8ByteOffset,
    hasMore: pageEnd < source.length,
  };
}

/**
 * @param {{
 *   fullText: string,
 *   previewUtf8Bytes?: number,
 *   expandPageUtf8Bytes?: number,
 * }} input
 */
export function buildHistoryCardReportViewModel(input) {
  const fullText = String(input?.fullText || '');
  const previewLimit = Number(input?.previewUtf8Bytes) || UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES;
  const expandLimit = Number(input?.expandPageUtf8Bytes) || UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES;
  const contentKey = registerHistoryCardReportFullText(fullText);
  const fullUtf8Bytes = measureUtf8ByteLength(fullText);
  const preview = truncateUtf8Text(fullText, previewLimit);
  return {
    contentKey,
    fullUtf8Bytes,
    previewText: preview.text,
    previewUtf8Bytes: preview.utf8Bytes,
    isTruncated: preview.truncated,
    expandPageUtf8Bytes: expandLimit,
  };
}

/**
 * @param {string} cacheKey
 * @param {string} markdownSource
 * @param {(source: string) => string} renderMarkdown
 * @returns {string}
 */
export function renderHistoryCardReportMarkdownCached(cacheKey, markdownSource, renderMarkdown) {
  const key = `${String(cacheKey || '')}:${measureUtf8ByteLength(markdownSource)}`;
  const cached = markdownHtmlCache.get(key);
  if (typeof cached === 'string') return cached;
  markdownRenderInvocations += 1;
  const html = renderMarkdown(String(markdownSource || ''));
  markdownHtmlCache.set(key, html);
  return html;
}

/**
 * @param {string} text
 * @param {{
 *   escapeHtml: (value: string) => string,
 *   t: (key: string, params?: Record<string, string>) => string,
 *   renderMarkdown: (source: string) => string,
 * }} deps
 * @returns {string}
 */
export function buildHistoryCardReportHostHtml(text, deps, options = {}) {
  const preserveWhitespace = options.preserveWhitespace === true;
  const raw = preserveWhitespace ? String(text || '') : String(text || '').trim();
  if (!raw) return '';
  const model = buildHistoryCardReportViewModel({ fullText: raw });
  const mdSource = model.isTruncated ? model.previewText : raw;
  const mdHtml = renderHistoryCardReportMarkdownCached(
    `${model.contentKey}:view:0`,
    mdSource,
    deps.renderMarkdown,
  );
  const safeKey = deps.escapeHtml(model.contentKey);
  if (!model.isTruncated) {
    return [
      `<div class="sdk-rich-delegation-report-host" data-report-content-key="${safeKey}"`,
      ` data-report-byte-offset="${String(model.fullUtf8Bytes)}">`,
      `<div class="sdk-md sdk-rich-md sdk-rich-delegation-report">${mdHtml}</div>`,
      '</div>',
    ].join('');
  }
  const note = deps.escapeHtml(deps.t('chat.delegationReportPreviewNote', {
    shown: String(model.previewUtf8Bytes),
    total: String(model.fullUtf8Bytes),
  }));
  return [
    `<div class="sdk-rich-delegation-report-host" data-report-content-key="${safeKey}"`,
    ` data-report-byte-offset="${String(model.previewUtf8Bytes)}">`,
    `<p class="sdk-rich-delegation-report-note">${note}</p>`,
    `<div class="sdk-md sdk-rich-md sdk-rich-delegation-report">${mdHtml}</div>`,
    '<div class="sdk-rich-delegation-report-toolbar">',
    `<button type="button" class="sdk-rich-delegation-btn sdk-rich-delegation-report-show-more"`,
    ` data-report-action="expand">${deps.escapeHtml(deps.t('chat.delegationReportShowMore'))}</button>`,
    `<button type="button" class="sdk-rich-delegation-btn sdk-rich-delegation-report-copy"`,
    ` data-report-action="copy">${deps.escapeHtml(deps.t('chat.delegationReportCopyFull'))}</button>`,
    `<button type="button" class="sdk-rich-delegation-btn sdk-rich-delegation-report-download"`,
    ` data-report-action="download">${deps.escapeHtml(deps.t('chat.delegationReportDownload'))}</button>`,
    '</div>',
    '</div>',
  ].join('');
}

/**
 * @param {ParentNode} root
 * @param {{
 *   t: (key: string, params?: Record<string, string>) => string,
 *   renderMarkdown: (source: string) => string,
 *   writeTextToClipboard: (text: string) => void | Promise<void>,
 *   decorateCodeForCopy: (el: HTMLElement) => void,
 *   expandPageUtf8Bytes?: number,
 * }} deps
 */
export function wireHistoryCardReportControls(root, deps) {
  const expandLimit = Number(deps.expandPageUtf8Bytes) || UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES;
  const hosts = root.querySelectorAll('.sdk-rich-delegation-report-host:not([data-report-wired])');
  hosts.forEach((host) => {
    if (!(host instanceof HTMLElement)) return;
    host.dataset.reportWired = '1';
    host.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest('[data-report-action]');
      if (!(btn instanceof HTMLElement) || !host.contains(btn)) return;
      const action = String(btn.dataset.reportAction || '');
      const contentKey = String(host.dataset.reportContentKey || '');
      const fullText = getHistoryCardReportFullText(contentKey);
      if (!fullText) return;
      if (action === 'copy') {
        void deps.writeTextToClipboard(fullText);
        return;
      }
      if (action === 'download') {
        const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'delegation-report.txt';
        link.click();
        URL.revokeObjectURL(url);
        return;
      }
      if (action !== 'expand') return;
      const body = host.querySelector('.sdk-rich-delegation-report');
      if (!(body instanceof HTMLElement)) return;
      const offset = Number(host.dataset.reportByteOffset) || 0;
      const page = sliceUtf8TextPage(fullText, offset, expandLimit);
      if (!page.text) {
        btn.disabled = true;
        return;
      }
      const mdHtml = renderHistoryCardReportMarkdownCached(
        `${contentKey}:view:${offset}`,
        page.text,
        deps.renderMarkdown,
      );
      const maxPages = Math.max(
        1,
        Math.floor(Number(deps.expandMaxDomPages) || UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES),
      );
      while (host.querySelectorAll('.sdk-rich-delegation-report-page').length >= maxPages) {
        const first = host.querySelector('.sdk-rich-delegation-report-page');
        if (!(first instanceof HTMLElement)) break;
        first.remove();
      }
      const pageEl = document.createElement('div');
      pageEl.className = 'sdk-rich-delegation-report-page';
      pageEl.innerHTML = mdHtml;
      body.appendChild(pageEl);
      deps.decorateCodeForCopy(pageEl);
      host.dataset.reportByteOffset = String(page.nextUtf8ByteOffset);
      const note = host.querySelector('.sdk-rich-delegation-report-note');
      if (note instanceof HTMLElement) {
        note.textContent = deps.t('chat.delegationReportExpandNote', {
          shown: String(page.nextUtf8ByteOffset),
          total: String(measureUtf8ByteLength(fullText)),
        });
      }
      if (!page.hasMore) {
        btn.disabled = true;
        btn.textContent = deps.t('chat.delegationReportEnd');
      }
    });
  });
}

/**
 * Rough DOM node budget estimator for tests (tag open count in HTML string).
 *
 * @param {string} html
 * @returns {number}
 */
export function estimateHtmlElementCount(html) {
  const matches = String(html || '').match(/<[a-zA-Z][^>]*>/g);
  return matches ? matches.length : 0;
}

/**
 * @param {ParentNode} root
 * @returns {number}
 */
export function countHistoryCardReportDomNodes(root) {
  return root.querySelectorAll('.sdk-rich-delegation-report-host, .sdk-rich-delegation-report-host *').length;
}
