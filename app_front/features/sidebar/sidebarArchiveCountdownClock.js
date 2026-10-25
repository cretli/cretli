/**
 * One coarse timer that keeps the sidebar auto-archive countdown fresh.
 *
 * Sidebar rows are patched in place from presence/status events, which arrive
 * irregularly. A countdown label would otherwise freeze while the app is idle,
 * so this clock re-triggers the existing coalesced full repaint once per tick.
 * It runs only while auto-archive is enabled AND a listener is registered, so
 * the default configuration schedules nothing.
 */

import { getChatAutoArchiveConfig, subscribeChatAutoArchiveConfig } from '../chat/chatAutoArchiveConfig.js';

/** Fraction-of-a-minute label changes are not visible, so 30s is plenty. */
export const SIDEBAR_ARCHIVE_COUNTDOWN_TICK_MS = 30_000;

/** @type {ReturnType<typeof setInterval> | null} */
let timerId = null;
/** @type {(() => void) | null} */
let listener = null;

function stopClock() {
  if (timerId === null) return;
  clearInterval(timerId);
  timerId = null;
}

function startClock() {
  if (timerId !== null) return;
  timerId = setInterval(() => {
    if (listener) listener();
  }, SIDEBAR_ARCHIVE_COUNTDOWN_TICK_MS);
}

function syncClock() {
  if (getChatAutoArchiveConfig().enabled && listener) startClock();
  else stopClock();
}

subscribeChatAutoArchiveConfig(syncClock);

/**
 * Register (or clear) the repaint callback and reconcile the timer state.
 *
 * @param {(() => void) | null} fn
 * @returns {void}
 */
export function setSidebarArchiveCountdownListener(fn) {
  listener = typeof fn === 'function' ? fn : null;
  syncClock();
}

/** Test seam: whether the shared timer is currently scheduled. */
export function __isSidebarArchiveCountdownClockRunningForTest() {
  return timerId !== null;
}
