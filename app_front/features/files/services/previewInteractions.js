/** Preview pane interactions: drag-to-resize height and pinch-to-zoom font scale. */
import { dom } from '../state/filesDom.js';
import {
  PREVIEW_FONT_SCALE_DEFAULT,
  PREVIEW_H_MIN,
  clampPreviewFontScale,
  getSavedPreviewFontScale,
  savePreviewFontScale,
  savePreviewHeight,
} from './filesPrefs.js';

const TREE_MIN_PX = 64;

export function setPreviewHeightPx(px) {
  const wrap = dom.previewWrap;
  if (!wrap) return;
  const layout = wrap.closest('.files-layout');
  if (!layout) return;
  const toolbarH = /** @type {HTMLElement | null} */ (layout.querySelector('.files-toolbar'))?.offsetHeight ?? 36;
  const layoutH = layout.getBoundingClientRect().height || 320;
  const maxPreview = Math.max(layoutH - toolbarH - TREE_MIN_PX - 8, PREVIEW_H_MIN + 80);
  const h = Math.round(Math.min(Math.max(px, PREVIEW_H_MIN), maxPreview));
  wrap.style.setProperty('--files-preview-height', `${h}px`);
  wrap.style.height = `${h}px`;
  savePreviewHeight(h);
}

let previewResizeBound = false;

/**
 * Pointer events + setPointerCapture + capturing window listeners keep the drag working
 * while scrolling and on touch devices. Bound once the preview toolbar exists.
 */
export function ensurePreviewResizeDrag() {
  const wrap = dom.previewWrap;
  if (!wrap || previewResizeBound) return;
  const toolbar =
    document.getElementById('files-preview-toolbar') ||
    wrap.querySelector('.files-preview-drag-handle') ||
    wrap.querySelector('.files-preview-toolbar');
  if (!toolbar) return;

  let dragging = false;
  let startY = 0;
  let startH = 0;

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', endDrag, true);
    document.body.classList.remove('files-preview-resizing');
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    setPreviewHeightPx(startH + (startY - e.clientY));
  }

  toolbar.addEventListener(
    'pointerdown',
    (e) => {
      const target = /** @type {Element | null} */ (e.target);
      if (target?.closest?.('button, input, label, .files-preview-markdown-toggle-wrap')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true;
      startY = e.clientY;
      startH = wrap.getBoundingClientRect().height;
      try {
        toolbar.setPointerCapture(e.pointerId);
      } catch (_) {
        /* older browsers */
      }
      window.addEventListener('pointermove', onMove, { capture: true, passive: false });
      window.addEventListener('pointerup', endDrag, true);
      window.addEventListener('pointercancel', endDrag, true);
      document.body.classList.add('files-preview-resizing');
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );

  previewResizeBound = true;
}

let previewFontScale = PREVIEW_FONT_SCALE_DEFAULT;
let pinchBound = false;

function applyPreviewFontScale(scale) {
  dom.previewContent?.style.setProperty('--files-preview-font-scale', String(scale));
}

function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

export function initPreviewPinch() {
  const el = dom.previewContent;
  if (!el || pinchBound) return;
  pinchBound = true;
  previewFontScale = getSavedPreviewFontScale();
  applyPreviewFontScale(previewFontScale);

  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartScale = PREVIEW_FONT_SCALE_DEFAULT;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    pinchActive = true;
    pinchStartDist = touchDistance(e.touches) || 1;
    pinchStartScale = previewFontScale;
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!pinchActive || e.touches.length !== 2) return;
    const next = clampPreviewFontScale(pinchStartScale * ((touchDistance(e.touches) || 1) / pinchStartDist));
    if (Math.abs(next - previewFontScale) >= 0.01) {
      previewFontScale = next;
      applyPreviewFontScale(next);
    }
    e.preventDefault();
  }, { passive: false });

  const endPinch = () => {
    if (!pinchActive) return;
    pinchActive = false;
    savePreviewFontScale(previewFontScale);
  };
  el.addEventListener('touchend', endPinch, { passive: true });
  el.addEventListener('touchcancel', endPinch, { passive: true });
}
