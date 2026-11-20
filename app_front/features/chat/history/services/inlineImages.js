/**
 * Inline image detection, thumbnails and the shared image lightbox.
 */

import { t } from '../../../../i18n/index.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { initImageLightboxZoom } from './imageLightboxZoom.js';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i;
const SCREENSHOT_MARKER_RE = /\[Screenshot:\s*([^\]\n]+)\]/gi;
const VIDEO_MARKER_RE = /\[Video:\s*([^\]\n]+)\]/gi;
const IMAGE_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|bmp|svg)(?:[^\s<>"')]*)?/gi;
let sdkImageLightboxEl = null;
let sdkImageLightboxImgEl = null;
let sdkImageLightboxCaptionEl = null;
let sdkImageLightboxCloseBtnEl = null;
let sdkImageLightboxEscapeBound = false;
let sdkImageLightboxZoom = null;

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
  VIDEO_MARKER_RE.lastIndex = 0;
  return raw
    .replace(SCREENSHOT_MARKER_RE, '')
    .replace(VIDEO_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Collects `[Video: <path>]` markers that point at Cretli uploads.
 *
 * @param {string} text
 * @returns {Array<{ source: string, href: string }>}
 */
export function collectInlineVideoRefs(text) {
  const raw = String(text || '');
  const refs = [];
  const seen = new Set();
  VIDEO_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = VIDEO_MARKER_RE.exec(raw)) !== null) {
    const source = String(match[1] || '').trim();
    const name = source.replace(/\\/g, '/').match(/(?:^|\/)uploads\/([a-f0-9-]{36}\.(?:mp4|mov|webm|mkv|m4v|3gp))$/i);
    if (!name || seen.has(name[1])) continue;
    seen.add(name[1]);
    refs.push({ source, href: `/api/uploads/${encodeURIComponent(name[1])}` });
  }
  return refs;
}

/**
 * Renders playable video previews (first frame as poster, native controls).
 *
 * @param {HTMLElement} container
 * @param {Array<{ source: string, href: string }>} refs
 */
export function appendInlineVideos(container, refs) {
  if (!(container instanceof HTMLElement) || !Array.isArray(refs) || refs.length === 0) return;
  const strip = document.createElement('div');
  strip.className = 'sdk-rich-inline-videos';
  refs.forEach((ref) => {
    const video = document.createElement('video');
    video.className = 'sdk-rich-inline-video';
    video.src = `${ref.href}#t=0.1`;
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.title = ref.source;
    // Deleted by retention or a format the browser cannot play: drop the player quietly.
    video.addEventListener('error', () => { video.hidden = true; });
    strip.appendChild(video);
  });
  container.appendChild(strip);
}

/**
 * @param {HTMLElement} container
 * @param {Array<{ source: string, href: string }>} refs
 * @param {{ large?: boolean }} [options] `large` shows the image itself rather than a chip.
 */
export function appendInlineImageThumbs(container, refs, { large = false } = {}) {
  if (!(container instanceof HTMLElement)) return;
  if (!Array.isArray(refs) || refs.length === 0) return;
  const strip = document.createElement('div');
  strip.className = large ? 'sdk-rich-inline-thumbs sdk-rich-inline-thumbs--large' : 'sdk-rich-inline-thumbs';
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
    // Eager: these are small, immutable-cached files, and a deferred lazy load
    // leaves empty grey tiles on a busy page.
    img.loading = 'eager';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { thumbBtn.hidden = true; });
    thumbBtn.appendChild(img);
    strip.appendChild(thumbBtn);
  });
  if (strip.childElementCount === 0) return;
  container.appendChild(strip);
}

function closeSdkImageLightbox() {
  if (!(sdkImageLightboxEl instanceof HTMLElement)) return;
  sdkImageLightboxEl.hidden = true;
  sdkImageLightboxZoom?.reset();
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
    '<div class="sdk-image-lightbox-viewport"><img class="sdk-image-lightbox-img" alt="" draggable="false" /></div>' +
    '<div class="sdk-image-lightbox-caption"></div>' +
    '</div>';
  document.body.appendChild(host);
  sdkImageLightboxEl = host;
  sdkImageLightboxImgEl = host.querySelector('.sdk-image-lightbox-img');
  sdkImageLightboxCaptionEl = host.querySelector('.sdk-image-lightbox-caption');
  sdkImageLightboxCloseBtnEl = host.querySelector('.sdk-image-lightbox-close');
  sdkImageLightboxZoom = initImageLightboxZoom(host.querySelector('.sdk-image-lightbox-viewport'), sdkImageLightboxImgEl);

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

export function openSdkImageLightbox(href, caption) {
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
  sdkImageLightboxZoom?.reset();
  document.body.classList.add('sdk-image-lightbox-open');
  sdkImageLightboxCloseBtnEl?.focus();
}

const CHAT_MEDIA_URL_RE = /^\/api\/chats\/[A-Za-z0-9_-]{1,64}\/media\/[0-9]{10,16}-[a-f0-9-]{36}\.(?:jpg|png|webp|gif)$/;
const IMAGE_MARKER_RE = /\[image:\s*(\/api\/chats\/\S+?)(?:\s[^\]]*)?\]/g;
const PREVIEW_LINE_RE = /^Preview:\s*(\S+)\s*$/gm;
const CHAT_MEDIA_PATH_RE = /chat-media\/([A-Za-z0-9_-]{1,64})\/([0-9]{10,16}-[a-f0-9-]{36}\.(?:jpg|png|webp|gif))/g;

/**
 * Validated refs of a server `local_images` event: same-origin chat media only,
 * because history records are data and must not choose what the page loads.
 *
 * @param {Record<string, any>} ev
 * @returns {Array<{ source: string, href: string }>}
 */
export function collectLocalImageRefs(ev) {
  if (!Array.isArray(ev?.images)) return [];
  return ev.images
    .map((image) => ({ href: String(image?.href || ''), source: String(image?.source || '') }))
    .filter((image) => CHAT_MEDIA_URL_RE.test(image.href));
}

/**
 * True when a tool output is nothing but `[image: <chat media url> ...]` markers,
 * so the thumbnails say everything and the raw marker text is noise.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isImageOnlyToolOutput(text) {
  const raw = String(text ?? '');
  if (!raw.includes('[image:')) return false;
  const rest = raw.replace(IMAGE_MARKER_RE, '').trim();
  IMAGE_MARKER_RE.lastIndex = 0;
  return rest.length === 0 && raw.trim().length > 0;
}

/**
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 */
function collectStrings(value, out, depth) {
  if (depth > 6 || out.length > 200) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out, depth + 1));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out, depth + 1));
}

/**
 * Finds durable chat-media images referenced by a tool event: structured
 * `frame.mediaUrl`, a `Preview: <url>` line in text, or a `chat-media` path in
 * the args. Only same-origin `/api/chats/...` URLs are returned, deduplicated.
 *
 * @param {Record<string, any>} ev
 * @returns {Array<{ source: string, href: string }>}
 */
export function collectToolImageRefs(ev) {
  const refs = [];
  const seen = new Set();
  const filePath = [ev?.args?.file_path, ev?.args?.path].find((value) => typeof value === 'string' && value.trim());
  const add = (href) => {
    if (!CHAT_MEDIA_URL_RE.test(href) || seen.has(href)) return;
    seen.add(href);
    refs.push({ source: filePath ? filePath.trim() : t('sdkView.toolScreenshot'), href });
  };
  if (!ev || typeof ev !== 'object') return refs;
  const result = ev.result;
  const structured = result?.structuredContent?.frame?.mediaUrl ?? result?.frame?.mediaUrl;
  if (typeof structured === 'string') add(structured.trim());
  const texts = [];
  collectStrings(result, texts, 0);
  texts.forEach((text) => {
    PREVIEW_LINE_RE.lastIndex = 0;
    let m;
    while ((m = PREVIEW_LINE_RE.exec(text)) !== null) add(m[1]);
    IMAGE_MARKER_RE.lastIndex = 0;
    while ((m = IMAGE_MARKER_RE.exec(text)) !== null) add(m[1]);
  });
  const argTexts = [];
  collectStrings(ev.args, argTexts, 0);
  argTexts.forEach((text) => {
    CHAT_MEDIA_PATH_RE.lastIndex = 0;
    let m;
    while ((m = CHAT_MEDIA_PATH_RE.exec(text)) !== null) add(`/api/chats/${m[1]}/media/${m[2]}`);
  });
  return refs;
}
