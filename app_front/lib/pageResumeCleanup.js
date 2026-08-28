import { kickServerRestartRecoveryIfStuck } from '../app/serverRestartCoordinator.js';
import { closeAllOpenDropdowns } from './dropdown.js';
import {
  initPwaFreezeDiagnostics,
  isUiFreezeDiagnosticsEnabled,
  logUiBlockerSnapshot,
} from './pwaFreezeDiagnostics.js';
import {
  initUiFreezeTrace,
} from './uiFreezeTrace.js';

const BLOCKING_MODAL_SELECTORS = [
  '#chat-reconnect-modal:not([hidden])',
  '#tasks-reconnect-modal:not([hidden])',
  '#restart-server-loading-modal:not([hidden])',
];

const STRAY_FLOATING_MENU_SELECTORS = [
  '.chat-list-modal:not([hidden])',
  '.files-root-dropdown:not([hidden])',
];

const RESUME_CLEANUP_RETRY_MS = [120, 480];
const RESUME_CLEANUP_COALESCE_MS = 300;

/** @type {Array<() => (boolean | string | void)>} */
const resumeHooks = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let resumeCleanupTimerId = null;
let resumeCleanupPending = false;

/**
 * Registers a hook that runs on page resume. Return a fix id or true when it applied a fix.
 *
 * @param {() => boolean | string | void} hook
 */
export function registerPageResumeCleanupHook(hook) {
  if (typeof hook !== 'function') return;
  resumeHooks.push(hook);
}

/**
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function hasBlockingModalOpen(doc = document) {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  return BLOCKING_MODAL_SELECTORS.some((selector) => doc.querySelector(selector));
}

/**
 * Hides stray mobile sidebar chrome when the drawer is closed.
 *
 * @param {Document} [doc]
 * @returns {boolean} Whether a fix was applied
 */
export function reconcileSidebarBackdrop(doc = document) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  const aside = doc.getElementById('app-sidebar');
  const backdrop = doc.getElementById('app-sidebar-backdrop');
  const asideOpen = aside && aside.hidden !== true;
  if (asideOpen) return false;
  let fixed = false;
  if (backdrop && backdrop.hidden !== true) {
    backdrop.hidden = true;
    fixed = true;
  }
  if (doc.body?.classList.contains('sidebar-open')) {
    doc.body.classList.remove('sidebar-open');
    fixed = true;
  }
  return fixed;
}

/**
 * Force-hides floating menus that survived without a synced dropdown controller.
 *
 * @param {Document} [doc]
 * @returns {boolean} Whether a fix was applied
 */
export function closeStrayFloatingMenus(doc = document) {
  if (!doc?.querySelectorAll) return false;
  let fixed = false;
  for (const selector of STRAY_FLOATING_MENU_SELECTORS) {
    for (const node of doc.querySelectorAll(selector)) {
      if (!node || typeof node !== 'object' || !('hidden' in node)) continue;
      node.hidden = true;
      node.style.left = '';
      node.style.top = '';
      node.style.minWidth = '';
      node.style.maxWidth = '';
      node.style.maxHeight = '';
      fixed = true;
    }
  }
  return fixed;
}

/**
 * @param {Document} doc
 * @returns {boolean}
 */
function isKibRadialLayerVisible(doc) {
  const layer = doc.getElementById('kib-radial-layer');
  return layer?.classList?.contains('kib-radial-layer--visible') === true;
}

/**
 * Drops inline scroll/touch locks left behind by Kib radial or stale PWA resume.
 *
 * @param {Document} [doc]
 * @returns {boolean} Whether a fix was applied
 */
export function releaseStuckPageScrollLock(doc = document) {
  if (!doc?.body || !doc.documentElement) return false;
  if (hasBlockingModalOpen(doc)) return false;
  const html = doc.documentElement;
  const body = doc.body;
  let fixed = false;
  const kibLayerVisible = isKibRadialLayerVisible(doc);
  if (body.classList.contains('kib-radial-active') && !kibLayerVisible) {
    body.classList.remove('kib-radial-active');
    fixed = true;
  }
  if (kibLayerVisible) return fixed;
  if (html.style.overflow === 'hidden' || body.style.overflow === 'hidden') {
    html.style.overflow = '';
    body.style.overflow = '';
    fixed = true;
  }
  if (html.style.overscrollBehavior === 'none' || body.style.overscrollBehavior === 'none') {
    html.style.overscrollBehavior = '';
    body.style.overscrollBehavior = '';
    fixed = true;
  }
  if (body.style.touchAction === 'none') {
    body.style.touchAction = '';
    fixed = true;
  }
  return fixed;
}

/**
 * Hides tasks reconnect modal when the user is on another panel (stale full-screen blocker).
 *
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function dismissInactivePanelReconnectModals(doc = document) {
  if (!doc?.getElementById) return false;
  const chatPanelActive = doc.getElementById('chat-panel')?.classList.contains('active') === true;
  if (!chatPanelActive) return false;
  const tasksModal = doc.getElementById('tasks-reconnect-modal');
  if (!tasksModal || tasksModal.hidden !== false) return false;
  tasksModal.hidden = true;
  return true;
}

/**
 * Best-effort cleanup for invisible full-screen blockers after PWA resume.
 *
 * @param {{ logger?: { log: (tag: string, message: string, payload?: object) => void } }} [options]
 * @returns {string[]} Applied fixes (for tests / debug logging)
 */
export function runPageResumeCleanup(options = {}) {
  if (isUiFreezeDiagnosticsEnabled()) {
    logUiBlockerSnapshot('cleanup-before');
  }
  const fixes = [];
  for (const hook of resumeHooks) {
    try {
      const result = hook();
      if (result === true) fixes.push('hook');
      else if (typeof result === 'string' && result) fixes.push(result);
    } catch {
      // Resume cleanup must never break the app shell.
    }
  }
  kickServerRestartRecoveryIfStuck();
  const closedDropdownCount = closeAllOpenDropdowns();
  if (closedDropdownCount > 0) fixes.push('dropdowns');
  if (closeStrayFloatingMenus()) fixes.push('floating-menus');
  if (dismissInactivePanelReconnectModals()) fixes.push('inactive-reconnect-modal');
  if (reconcileSidebarBackdrop()) fixes.push('sidebar-backdrop');
  if (releaseStuckPageScrollLock()) fixes.push('scroll-lock');
  if (isUiFreezeDiagnosticsEnabled()) {
    logUiBlockerSnapshot('cleanup-after');
  }
  if (fixes.length > 0) {
    options.logger?.log?.('page-resume', 'cleared stuck UI blockers', { fixes });
  }
  return fixes;
}

let initialized = false;
/** @type {number[]} */
let retryTimerIds = [];

function flushResumeCleanup(options) {
  resumeCleanupPending = false;
  runPageResumeCleanup(options);
  if (typeof window === 'undefined') return;
  for (const timerId of retryTimerIds) window.clearTimeout(timerId);
  retryTimerIds = RESUME_CLEANUP_RETRY_MS.map((delayMs) =>
    window.setTimeout(() => runPageResumeCleanup(options), delayMs)
  );
}

/**
 * Runs {@link runPageResumeCleanup} whenever the page becomes visible again.
 *
 * @param {{ logger?: { log: (tag: string, message: string, payload?: object) => void } }} [options]
 */
export function initPageResumeCleanup(options = {}) {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  initPwaFreezeDiagnostics({ logger: options.logger || null });
  initUiFreezeTrace({ logger: options.logger || null });
  const scheduleResumeCleanup = () => {
    if (document.hidden || typeof window === 'undefined') return;
    resumeCleanupPending = true;
    if (resumeCleanupTimerId != null) return;
    resumeCleanupTimerId = window.setTimeout(() => {
      resumeCleanupTimerId = null;
      if (!resumeCleanupPending || document.hidden) {
        resumeCleanupPending = false;
        return;
      }
      flushResumeCleanup(options);
    }, RESUME_CLEANUP_COALESCE_MS);
  };
  const onHide = () => {
    if (!document.hidden) return;
    resumeCleanupPending = false;
    if (resumeCleanupTimerId != null) {
      window.clearTimeout(resumeCleanupTimerId);
      resumeCleanupTimerId = null;
    }
    runPageResumeCleanup(options);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onHide();
    else scheduleResumeCleanup();
  });
  if (typeof window === 'undefined') return;
  window.addEventListener('pageshow', scheduleResumeCleanup);
  window.addEventListener('focus', scheduleResumeCleanup);
  window.addEventListener('pagehide', onHide);
}
