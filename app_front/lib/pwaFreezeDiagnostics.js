/**
 * Optional UI blocker snapshots after PWA resume (mobile freeze diagnosis).
 * Disabled by default — enabling adds listeners and logging that can worsen jank.
 */

export {
  UI_FREEZE_DIAG_LS_KEY,
  isUiFreezeDiagnosticsEnabled,
} from './uiFreezeTrace.js';

import {
  beginUiFreezeResumeSession,
  shouldLogUiFreezeLongTask,
  isUiFreezeDiagnosticsEnabled,
} from './uiFreezeTrace.js';
import { requestClientDebugRemoteFlush } from '../logger.js';

const SNAPSHOT_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000, 12000];
const TOUCH_TRACE_MS = 12000;
const MAIN_THREAD_WATCH_MS = 15000;

const MODAL_IDS = [
  'chat-reconnect-modal',
  'tasks-reconnect-modal',
  'restart-server-loading-modal',
  'chat-settings-modal',
  'chat-new-modal',
  'chat-delete-confirm-modal',
  'connection-status-dialog',
];

const OVERLAY_SCAN_SELECTORS = [
  '.chat-settings-modal:not([hidden])',
  '.chat-list-modal:not([hidden])',
  '.files-root-dropdown:not([hidden])',
  '.kib-radial-layer--visible',
  '.app-sidebar-backdrop:not([hidden])',
  '.sdk-image-lightbox:not([hidden])',
  '#cr-backend-unavailable',
  'cr-dialog[open]',
];

/**
 * cr-dialog uses `open`; legacy chat-settings modals use `hidden`.
 * @param {{ open?: boolean, hidden?: boolean } | null | undefined} el
 * @returns {boolean}
 */
function isListedModalOpen(el) {
  if (!el) return false;
  if (typeof el.open === 'boolean') return el.open === true;
  return el.hidden === false;
}

/** @type {{ log?: (tag: string, message: string, payload?: object) => void } | null} */
let logger = null;
let initialized = false;
/** @type {number[]} */
let snapshotTimerIds = [];
let touchTraceUntil = 0;
let lastSnapshotKey = '';
let longTaskObserver = null;
let mainThreadWatchTimerId = null;
let mainThreadWatchUntil = 0;
let continuousWatchTimerId = null;
let continuousWatchLastTick = 0;
let mainThreadWatchLastTick = 0;

/**
 * @param {Element | null | undefined} el
 * @returns {{ tag?: string, id?: string, className?: string } | null}
 */
export function describeUiElement(el) {
  if (!el || el.nodeType !== 1) return null;
  const className = typeof el.className === 'string' ? el.className.slice(0, 96) : undefined;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    className: className || undefined,
  };
}

/**
 * @param {Document} doc
 * @param {number} x
 * @param {number} y
 * @returns {{ tag?: string, id?: string, className?: string } | null}
 */
export function hitTestAt(doc, x, y) {
  if (!doc?.elementFromPoint || typeof x !== 'number' || typeof y !== 'number') return null;
  return describeUiElement(doc.elementFromPoint(x, y));
}

/**
 * @param {Document} doc
 * @param {number} x
 * @param {number} y
 * @param {number} [limit]
 * @returns {Array<{ tag?: string, id?: string, className?: string }>}
 */
export function hitTestStackAt(doc, x, y, limit = 4) {
  if (!doc?.elementsFromPoint || typeof x !== 'number' || typeof y !== 'number') {
    const single = hitTestAt(doc, x, y);
    return single ? [single] : [];
  }
  const stack = doc.elementsFromPoint(x, y).slice(0, limit);
  return stack.map((el) => describeUiElement(el)).filter(Boolean);
}

/**
 * Collects a compact snapshot of UI elements that can block taps after PWA resume.
 *
 * @param {Document} [doc]
 * @param {string} [reason]
 * @returns {Record<string, unknown>}
 */
export function collectUiBlockerSnapshot(doc = document, reason = 'manual') {
  const body = doc?.body;
  const html = doc?.documentElement;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
  const centerX = Math.round(viewportWidth / 2);
  const centerY = Math.round(viewportHeight / 2);
  const openModals = MODAL_IDS.filter((id) => {
    const el = doc.getElementById?.(id);
    return isListedModalOpen(el);
  });
  const overlays = [];
  if (doc?.querySelectorAll) {
    for (const selector of OVERLAY_SCAN_SELECTORS) {
      for (const node of doc.querySelectorAll(selector)) {
        if (!node || node.hidden === true) continue;
        const className = typeof node.className === 'string' ? node.className.slice(0, 72) : '';
        overlays.push(node.id || className || selector);
      }
    }
  }
  const bodyClasses = body?.classList
    ? Array.from(body.classList).filter((name) =>
        /sidebar|kib|lightbox|keyboard|fullscreen|embed|modal/i.test(name)
      )
    : [];
  return {
    reason,
    visibility: doc?.visibilityState || 'unknown',
    viewport: { w: viewportWidth, h: viewportHeight },
    openModals,
    overlays: overlays.slice(0, 12),
    bodyClasses,
    scrollLock: {
      htmlOverflow: html?.style?.overflow || '',
      bodyOverflow: body?.style?.overflow || '',
      bodyTouchAction: body?.style?.touchAction || '',
      htmlOverscroll: html?.style?.overscrollBehavior || '',
      bodyOverscroll: body?.style?.overscrollBehavior || '',
    },
    kib: {
      layerVisible: doc.getElementById?.('kib-radial-layer')?.classList?.contains('kib-radial-layer--visible') === true,
      bodyActive: body?.classList?.contains('kib-radial-active') === true,
    },
    sidebar: {
      open: body?.classList?.contains('sidebar-open') === true,
      asideHidden: doc.getElementById?.('app-sidebar')?.hidden !== false,
      backdropHidden: doc.getElementById?.('app-sidebar-backdrop')?.hidden !== false,
    },
    hitCenter: hitTestAt(doc, centerX, centerY),
    hitCenterStack: hitTestStackAt(doc, centerX, centerY),
    hitTop: hitTestAt(doc, centerX, Math.max(24, Math.round(viewportHeight * 0.12))),
    hitBottom: hitTestAt(doc, centerX, Math.max(24, viewportHeight - 48)),
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {string}
 */
export function snapshotFingerprint(snapshot) {
  return JSON.stringify({
    openModals: snapshot.openModals,
    overlays: snapshot.overlays,
    bodyClasses: snapshot.bodyClasses,
    scrollLock: snapshot.scrollLock,
    kib: snapshot.kib,
    sidebar: snapshot.sidebar,
    hitCenter: snapshot.hitCenter,
  });
}

/**
 * @param {Record<string, unknown>} previous
 * @param {Record<string, unknown>} next
 * @returns {string[]}
 */
export function diffUiBlockerSnapshot(previous, next) {
  const changes = [];
  const prevModals = Array.isArray(previous.openModals) ? previous.openModals : [];
  const nextModals = Array.isArray(next.openModals) ? next.openModals : [];
  for (const id of nextModals) {
    if (!prevModals.includes(id)) changes.push(`modal+:${id}`);
  }
  const prevOverlays = Array.isArray(previous.overlays) ? previous.overlays : [];
  const nextOverlays = Array.isArray(next.overlays) ? next.overlays : [];
  for (const item of nextOverlays) {
    if (!prevOverlays.includes(item)) changes.push(`overlay+:${item}`);
  }
  const prevHit = JSON.stringify(previous.hitCenter || null);
  const nextHit = JSON.stringify(next.hitCenter || null);
  if (prevHit !== nextHit) changes.push('hitCenter-changed');
  const prevLock = JSON.stringify(previous.scrollLock || null);
  const nextLock = JSON.stringify(next.scrollLock || null);
  if (prevLock !== nextLock) changes.push('scroll-lock-changed');
  return changes;
}

/**
 * @param {string} reason
 */
function logSnapshot(reason) {
  if (!logger) return;
  const snapshot = collectUiBlockerSnapshot(document, reason);
  const fingerprint = snapshotFingerprint(snapshot);
  const changes = lastSnapshotKey ? diffUiBlockerSnapshot(JSON.parse(lastSnapshotKey), snapshot) : [];
  lastSnapshotKey = fingerprint;
  logger.log('ui-freeze', reason, snapshot);
  if (changes.length > 0) {
    logger.log('ui-freeze', 'blocker delta', { reason, changes, snapshot });
  }
}

function clearSnapshotTimers() {
  if (typeof window === 'undefined') return;
  for (const timerId of snapshotTimerIds) window.clearTimeout(timerId);
  snapshotTimerIds = [];
}

function scheduleResumeSnapshots() {
  clearSnapshotTimers();
  lastSnapshotKey = '';
  touchTraceUntil = Date.now() + TOUCH_TRACE_MS;
  beginUiFreezeResumeSession('visibility');
  startMainThreadWatchdog();
  if (typeof window === 'undefined') return;
  for (const delayMs of SNAPSHOT_DELAYS_MS) {
    snapshotTimerIds.push(
      window.setTimeout(() => {
        logSnapshot(`resume+${delayMs}ms`);
      }, delayMs)
    );
  }
}

function onTracePointer(event) {
  if (!logger || Date.now() > touchTraceUntil) return;
  const point = event.touches?.[0] || event;
  const x = Number(point.clientX);
  const y = Number(point.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const hit = hitTestAt(document, x, y);
  logger.log('ui-freeze-touch', event.type, {
    x: Math.round(x),
    y: Math.round(y),
    hit,
    defaultPrevented: event.defaultPrevented === true,
    cancelable: event.cancelable === true,
  });
}

function bindLongTaskObserver() {
  if (longTaskObserver || typeof PerformanceObserver === 'undefined') return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!logger) return;
      for (const entry of list.getEntries()) {
        if (!shouldLogUiFreezeLongTask(entry.duration)) continue;
        logger.log('ui-freeze-perf', 'long task', {
          durationMs: Math.round(entry.duration),
          startMs: Math.round(entry.startTime),
          name: entry.name || 'longtask',
        });
        requestClientDebugRemoteFlush('ui-freeze-perf');
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    longTaskObserver = null;
  }
}

function stopMainThreadWatchdog() {
  if (mainThreadWatchTimerId == null || typeof window === 'undefined') return;
  window.clearInterval(mainThreadWatchTimerId);
  mainThreadWatchTimerId = null;
}

function startMainThreadWatchdog() {
  if (typeof window === 'undefined') return;
  stopMainThreadWatchdog();
  mainThreadWatchUntil = Date.now() + MAIN_THREAD_WATCH_MS;
  mainThreadWatchLastTick = Date.now();
  mainThreadWatchTimerId = window.setInterval(() => {
    const now = Date.now();
    const driftMs = now - mainThreadWatchLastTick - 1000;
    mainThreadWatchLastTick = now;
    if (driftMs > 350 && logger) {
      logger.log('ui-freeze-perf', 'main thread stall', {
        driftMs: Math.round(driftMs),
        reason: 'timer drift while UI should stay responsive',
      });
      requestClientDebugRemoteFlush('ui-freeze-perf');
    }
    if (now >= mainThreadWatchUntil) stopMainThreadWatchdog();
  }, 1000);
}

function startContinuousMainThreadWatchdog() {
  if (typeof window === 'undefined' || continuousWatchTimerId != null) return;
  continuousWatchLastTick = Date.now();
  continuousWatchTimerId = window.setInterval(() => {
    if (document.hidden) {
      continuousWatchLastTick = Date.now();
      return;
    }
    const now = Date.now();
    const driftMs = now - continuousWatchLastTick - 2000;
    continuousWatchLastTick = now;
    if (driftMs <= 350 || !logger) return;
    logger.log('ui-freeze-perf', 'main thread stall', {
      driftMs: Math.round(driftMs),
      reason: 'continuous watchdog — UI may be frozen',
    });
    requestClientDebugRemoteFlush('ui-freeze-perf');
  }, 2000);
}

/**
 * Starts resume snapshots, touch tracing and long-task logging for freeze diagnosis.
 *
 * @param {{ log?: (tag: string, message: string, payload?: object) => void }} [options]
 */
export function initPwaFreezeDiagnostics(options = {}) {
  if (initialized || typeof document === 'undefined') return;
  if (!isUiFreezeDiagnosticsEnabled()) return;
  initialized = true;
  logger = options.logger || null;
  bindLongTaskObserver();
  document.addEventListener('touchstart', onTracePointer, { capture: true, passive: true });
  document.addEventListener('pointerdown', onTracePointer, { capture: true, passive: true });
  const onResume = () => {
    if (document.hidden) return;
    scheduleResumeSnapshots();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearSnapshotTimers();
      stopMainThreadWatchdog();
      return;
    }
    onResume();
  });
  if (typeof window === 'undefined') return;
  window.addEventListener('pageshow', onResume);
  window.addEventListener('focus', onResume);
  startContinuousMainThreadWatchdog();
}

/**
 * Logs a snapshot immediately (used by page resume cleanup before/after fixes).
 *
 * @param {string} reason
 */
export function logUiBlockerSnapshot(reason) {
  if (!isUiFreezeDiagnosticsEnabled()) return;
  if (!logger) return;
  logSnapshot(reason);
}
