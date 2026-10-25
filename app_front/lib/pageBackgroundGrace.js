import { BG_DISCONNECT_GRACE_MS } from '../config.js';

let hiddenAt = 0;
let lastHiddenDurationMs = 0;
let initialized = false;

export function getBackgroundGraceMs() {
  return BG_DISCONNECT_GRACE_MS;
}

export function initPageBackgroundGrace() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt > 0) {
      lastHiddenDurationMs = Date.now() - hiddenAt;
      hiddenAt = 0;
    }
  });
}

export function isPageCurrentlyHidden() {
  return typeof document !== 'undefined' && document.hidden;
}

export function getLastBackgroundDurationMs() {
  return lastHiddenDurationMs;
}

export function clearLastBackgroundDurationMs() {
  lastHiddenDurationMs = 0;
}

export function wasRecentBackgroundSwitch(graceMs = BG_DISCONNECT_GRACE_MS) {
  return lastHiddenDurationMs > 0 && lastHiddenDurationMs <= graceMs;
}

/**
 * Reconnect modal delay in ms. null means "do not show" (tab is in the background).
 * @param {{ hidden: boolean, recentBackgroundMs: number, graceMs?: number }} opts
 * @returns {number | null}
 */
export function getReconnectModalDelayMs({
  hidden,
  recentBackgroundMs,
  graceMs = BG_DISCONNECT_GRACE_MS,
}) {
  if (hidden) return null;
  if (recentBackgroundMs > 0 && recentBackgroundMs <= graceMs) return graceMs;
  return graceMs;
}
