/**
 * Inline image detection, thumbnails and the shared image lightbox.
 */

import { t } from '../../../../i18n/index.js';
import { escapeHtml } from '../../chatHtmlUtils.js';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i;
const SCREENSHOT_MARKER_RE = /\[Screenshot:\s*([^\]\n]+)\]/gi;
const IMAGE_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[^\s<>"')]*)?/gi;
let sdkImageLightboxEl = null;
let sdkImageLightboxImgEl = null;
let sdkImageLightboxCaptionEl = null;
let sdkImageLightboxCloseBtnEl = null;
let sdkImageLightboxEscapeBound = false;

/**
 * @param {string} href
 * @returns {boolean}
 */
export function isImageLikeHref(href) {
  const value = String(href || '').trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  return IMAGE_EXT_RE.test(value);
}

/**
 * @param {string} rawPath
 * @returns {string}
 */
export function screenshotPathToPreviewUrl(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  if (/^(https?:|data:image\/|blob:)/i.test(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)uploads\/([a-f0-9-]{36}\.jpg)$/i);
  if (!match) return '';
  return `/api/uploads/${encodeURIComponent(match[1])}`;
}

/**
 * @param {string} text
 * @returns {Array<{ source: string, href: string }>}
 */
export function collectInlineImageRefs(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const refs = [];
  const seen = new Set();

  SCREENSHOT_MARKER_RE.lastIndex = 0;
  let markerMatch;
  while ((markerMatch = SCREENSHOT_MARKER_RE.exec(raw)) !== null) {
    const source = String(markerMatch[1] || '').trim();
    if (!source) continue;
    const href = screenshotPathToPreviewUrl(source) || (isImageLikeHref(source) ? source : '');
    if (!href || seen.has(href)) continue;
    seen.add(href);
    refs.push({ source, href });
  }

  IMAGE_URL_RE.lastIndex = 0;
  let urlMatch;
  while ((urlMatch = IMAGE_URL_RE.exec(raw)) !== null) {
    const source = String(urlMatch[0] || '').trim();
    if (!source) continue;
    if (!isImageLikeHref(source) || seen.has(source)) continue;
    seen.add(source);
    refs.push({ source, href: source });
  }

  return refs;
}

/**
 * Strips technical screenshot markers from the displayed content.
 * Thumbnails are still rendered separately from those markers.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripScreenshotMarkers(text) {
  const raw = String(text || '');
  if (!raw) return '';
  SCREENSHOT_MARKER_RE.lastIndex = 0;
  return raw
    .replace(SCREENSHOT_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {HTMLElement} container
 * @param {Array<{ source: string, href: string }>} refs
 */
export function appendInlineImageThumbs(container, refs) {
  if (!(container instanceof HTMLElement)) return;
  if (!Array.isArray(refs) || refs.length === 0) return;
  const strip = document.createElement('div');
  strip.className = 'sdk-rich-inline-thumbs';
  refs.forEach((ref) => {
    if (!ref || typeof ref !== 'object') return;
    const href = String(ref.href || '').trim();
    if (!href) return;
    const source = String(ref.source || href);

    const thumbBtn = document.createElement('button');
    thumbBtn.type = 'button';
    thumbBtn.className = 'sdk-rich-inline-thumb';
    thumbBtn.title = source;
    thumbBtn.setAttribute('aria-label', t('sdkView.imagePreviewOf', { source }));
    thumbBtn.addEventListener('click', () => {
      openSdkImageLightbox(href, source);
    });

    const img = document.createElement('img');
    img.src = href;
    img.alt = source;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    thumbBtn.appendChild(img);
    strip.appendChild(thumbBtn);
  });
  if (strip.childElementCount === 0) return;
  container.appendChild(strip);
}

function closeSdkImageLightbox() {
  if (!(sdkImageLightboxEl instanceof HTMLElement)) return;
  sdkImageLightboxEl.hidden = true;
  document.body.classList.remove('sdk-image-lightbox-open');
  if (sdkImageLightboxImgEl instanceof HTMLImageElement) {
    sdkImageLightboxImgEl.removeAttribute('src');
    sdkImageLightboxImgEl.alt = '';
  }
  if (sdkImageLightboxCaptionEl instanceof HTMLElement) {
    sdkImageLightboxCaptionEl.textContent = '';
  }
}

/** Closes SDK image preview if it stayed open after PWA resume. */
export function dismissSdkImageLightboxIfOpen() {
  if (!(sdkImageLightboxEl instanceof HTMLElement)) return false;
  if (sdkImageLightboxEl.hidden !== false) return false;
  closeSdkImageLightbox();
  return true;
}

function ensureSdkImageLightbox() {
  if (sdkImageLightboxEl instanceof HTMLElement) return sdkImageLightboxEl;
  if (typeof document === 'undefined') return null;
  const host = document.createElement('div');
  host.className = 'sdk-image-lightbox';
  host.hidden = true;
  host.innerHTML =
    '<div class="sdk-image-lightbox-backdrop"></div>' +
    `<div class="sdk-image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('sdkView.imagePreview'))}">` +
    `<button type="button" class="sdk-image-lightbox-close" aria-label="${escapeHtml(t('sdkView.closePreview'))}">×</button>` +
    '<img class="sdk-image-lightbox-img" alt="" />' +
    '<div class="sdk-image-lightbox-caption"></div>' +
    '</div>';
  document.body.appendChild(host);
  sdkImageLightboxEl = host;
  sdkImageLightboxImgEl = host.querySelector('.sdk-image-lightbox-img');
  sdkImageLightboxCaptionEl = host.querySelector('.sdk-image-lightbox-caption');
  sdkImageLightboxCloseBtnEl = host.querySelector('.sdk-image-lightbox-close');

  host.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.classList.contains('sdk-image-lightbox-backdrop')) {
      closeSdkImageLightbox();
    }
  });
  sdkImageLightboxCloseBtnEl?.addEventListener('click', () => {
    closeSdkImageLightbox();
  });

  if (!sdkImageLightboxEscapeBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeSdkImageLightbox();
    });
    sdkImageLightboxEscapeBound = true;
  }
  return host;
}

function openSdkImageLightbox(href, caption) {
  const host = ensureSdkImageLightbox();
  if (!(host instanceof HTMLElement)) return;
  const imageSrc = String(href || '').trim();
  if (!imageSrc) return;
  if (sdkImageLightboxImgEl instanceof HTMLImageElement) {
    sdkImageLightboxImgEl.src = imageSrc;
    sdkImageLightboxImgEl.alt = caption || t('sdkView.imagePreview');
  }
  if (sdkImageLightboxCaptionEl instanceof HTMLElement) {
    sdkImageLightboxCaptionEl.textContent = caption || '';
  }
  host.hidden = false;
  document.body.classList.add('sdk-image-lightbox-open');
  sdkImageLightboxCloseBtnEl?.focus();
}
