/**
 * Mobile terminal viewport: scaling through fontSize (no line wrapping, no CSS transform)
 * plus a soft column cap so the backend never assumes more columns than actually fit on screen.
 * Used by terminal.js and chat.js on fit() and resize.
 *
 * Width: getViewportWidth() clamps to the real screen width (min of clientWidth/innerWidth) so the
 * xterm canvas does not cut text off on the right. CSS (terminal-viewport-wrap) keeps max-width: 100%
 * and min-width: 0.
 * Height: the reserve for the fixed send bar lives in the CSS variable --terminal-send-bar-reserve
 * (padding-bottom on .terminal-viewport-wrap), so the xterm container gets a correct height from flex.
 */

import {
  MOBILE_TERMINAL_MIN_COLS,
  MOBILE_TERMINAL_SCALE_SAFETY,
  MOBILE_TERMINAL_SCALE_SAFETY_HIGH_DPR,
  MOBILE_VIEWPORT_BREAKPOINT_PX,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_FONT_SIZE_KEY,
} from './config.js';
import { readStorageValueWithAlias } from './lib/storageKeyAlias.js';

const WRAPPER_CLASS = 'terminal-scale-wrapper';

const DEBUG =
  (typeof process !== 'undefined' && process.env?.DEBUG_TERMINAL_VIEWPORT === '1') ||
  (typeof localStorage !== 'undefined' && readStorageValueWithAlias(localStorage, 'DEBUG_TERMINAL_VIEWPORT', '') === '1');

export function isMobile() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT_PX;
}

export function getMobileMinCols() {
  return MOBILE_TERMINAL_MIN_COLS;
}

/**
 * Returns the stored terminal font size override, or 0 when the size is automatic.
 */
export function getTerminalFontSizeOverride() {
  if (typeof localStorage === 'undefined') return 0;
  const v = readStorageValueWithAlias(localStorage, TERMINAL_FONT_SIZE_KEY, '');
  if (v === null || v === '') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 8 && n <= 32 ? n : 0;
}

/** Terminal viewport width: the smaller of the container and the visible viewport, so nothing scrolls horizontally. */
function getViewportWidth(container) {
  if (typeof window === 'undefined') return 800;
  const innerW = window.innerWidth || 800;
  const docW = document.documentElement?.clientWidth;
  const visibleW = typeof docW === 'number' && docW > 0 ? Math.min(innerW, docW) : innerW;
  const cw = container?.clientWidth;
  if (typeof cw === 'number' && cw > 0) return Math.min(cw, visibleW);
  const pw = container?.parentElement?.clientWidth;
  if (typeof pw === 'number' && pw > 0) return Math.min(pw, visibleW);
  return visibleW;
}

/**
 * Removes the legacy scaling wrapper left over from the transform-scale implementation.
 */
function removeScaleWrapperIfPresent(container) {
  const wrapper = container?.parentElement?.classList?.contains(WRAPPER_CLASS) ? container.parentElement : null;
  if (!wrapper?.parentElement) return;
  container.style.position = '';
  container.style.left = '';
  container.style.top = '';
  container.style.width = '';
  container.style.height = '';
  container.style.transform = '';
  container.style.transformOrigin = '';
  wrapper.parentElement.insertBefore(container, wrapper);
  wrapper.remove();
}

/**
 * On mobile, picks a fontSize that gives each cell a predictable width so MOBILE_TERMINAL_MIN_COLS columns fit.
 */
function applyMobileFontSize(term, container) {
  const viewportWidth = getViewportWidth(container);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const safety =
    dpr >= 2 && MOBILE_TERMINAL_SCALE_SAFETY_HIGH_DPR != null
      ? MOBILE_TERMINAL_SCALE_SAFETY_HIGH_DPR
      : MOBILE_TERMINAL_SCALE_SAFETY ?? 0.9;
  const fontSize = Math.max(8, Math.floor((viewportWidth * safety) / MOBILE_TERMINAL_MIN_COLS));
  term.options.fontSize = fontSize;
  if (container) {
    container.setAttribute('data-terminal-mobile', '1');
  }
  if (DEBUG) {
    console.log('[terminalViewport] mobile fontSize', { viewportWidth, fontSize, dpr, safety });
  }
}

/**
 * Runs the fit addon; on mobile it scales via fontSize (no transform), on desktop it restores the default font.
 * @param {import('xterm').Terminal} term
 * @param {import('xterm-addon-fit').FitAddon} fitAddon
 * @param {HTMLElement} [container] - terminal container, used for viewport width and legacy wrapper cleanup
 */
export function safeFit(term, fitAddon, container) {
  if (!term || !fitAddon) return;
  const fontSizeOverride = getTerminalFontSizeOverride();
  if (fontSizeOverride > 0) {
    if (container) {
      removeScaleWrapperIfPresent(container);
      container.removeAttribute('data-terminal-mobile');
      container.style.removeProperty('--terminal-font-size');
    }
    term.options.fontSize = fontSizeOverride;
    fitAddon.fit();
    return;
  }

  const mobile = isMobile();

  if (!mobile) {
    if (container) {
      removeScaleWrapperIfPresent(container);
      container.removeAttribute('data-terminal-mobile');
      container.style.removeProperty('--terminal-font-size');
    }
    term.options.fontSize = TERMINAL_DEFAULT_FONT_SIZE;
    fitAddon.fit();
    return;
  }

  if (container) removeScaleWrapperIfPresent(container);

  function doFit() {
    applyMobileFontSize(term, container);
    fitAddon.fit();
  }
  requestAnimationFrame(doFit);
}

/**
 * Observes container resizes and calls onResize (typically safeFit), but only on mobile.
 */
export function observeContainerResize(container, onResize) {
  if (typeof ResizeObserver === 'undefined' || !container || !onResize) return () => {};
  const ro = new ResizeObserver(() => {
    if (isMobile()) onResize();
  });
  ro.observe(container);
  return () => ro.disconnect();
}
