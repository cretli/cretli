/**
 * View memory wiring for panels (stage 5).
 */

import { buildViewKey, readViewMemorySlice, restoreViewMemoryAfterPaint, writeViewMemorySlice } from './viewMemory.js';
import { getViewContextState } from './viewContextBridge.js';
import { readRouteFromLocation } from './spaNavigation.js';

/** @type {Record<string, (slice: object) => void>} */
const restoreHandlers = {};

/** @type {Record<string, ReturnType<typeof setTimeout>>} */
const captureTimers = {};

/**
 * @returns {import('../../../lib/spa-routes.js').SpaRouteState | null}
 */
export function resolveActiveRouteForViewMemory() {
  if (typeof window === 'undefined') return null;
  return readRouteFromLocation({
    pathname: window.location.pathname || '/',
    search: window.location.search || '',
  });
}

/**
 * @param {string} panelId
 * @param {object} slice
 */
export function persistPanelViewMemory(panelId, slice) {
  if (typeof sessionStorage === 'undefined') return;
  const key = typeof panelId === 'string' ? panelId.trim() : '';
  if (!key) return;
  const route = resolveActiveRouteForViewMemory();
  if (!route || String(route.panel || '').trim() !== key) return;
  const runtimeContext = getViewContextState()?.context;
  const viewKey = buildViewKey(route, runtimeContext || route?.context);
  writeViewMemorySlice(sessionStorage, viewKey, slice);
}

/**
 * @param {string} panelId
 * @param {() => object | null | undefined} buildSlice
 * @param {number} [delayMs]
 */
export function schedulePanelViewMemoryCapture(panelId, buildSlice, delayMs = 250) {
  const key = typeof panelId === 'string' ? panelId.trim() : '';
  if (!key || typeof buildSlice !== 'function') return;
  if (captureTimers[key]) clearTimeout(captureTimers[key]);
  captureTimers[key] = setTimeout(() => {
    captureTimers[key] = 0;
    try {
      const slice = buildSlice();
      if (slice && typeof slice === 'object') persistPanelViewMemory(key, slice);
    } catch {
      // Capture must never break the panel.
    }
  }, delayMs);
}

/**
 * @param {string} panelId
 * @param {(slice: object) => void} handler
 */
export function registerViewMemoryRestoreHandler(panelId, handler) {
  const key = typeof panelId === 'string' ? panelId.trim() : '';
  if (!key || typeof handler !== 'function') return;
  restoreHandlers[key] = handler;
}

/**
 * @param {import('../../../lib/spa-routes.js').SpaRouteState} route
 * @param {number} _token
 */
export async function restoreViewMemoryForRoute(route) {
  if (typeof sessionStorage === 'undefined') return;
  const runtimeContext = getViewContextState()?.context;
  const viewKey = buildViewKey(route, runtimeContext || route?.context);
  const slice = readViewMemorySlice(sessionStorage, viewKey);
  const panel = typeof route?.panel === 'string' ? route.panel.trim() : '';
  const handler = panel ? restoreHandlers[panel] : null;
  if (!slice || !handler) return;
  restoreViewMemoryAfterPaint(slice, handler);
}
