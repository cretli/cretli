/**
 * Kib radial gesture: a long press opens 4 directions under the finger; swiping
 * down reloads the page.
 * Useful in fullscreen, where the browser's own pull-to-refresh is unavailable.
 */
import { sendNavKeyToActiveChat } from './chat.js';
import { getLoadedPanelModule } from './app/appShell/lazyPanelModules.js';
import { sendSequenceToTerminalState } from './inputDispatch.js';
import { registerPageResumeCleanupHook } from './lib/pageResumeCleanup.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { t } from './i18n/index.js';

const TERMINAL_ARROW_SEQUENCES = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

const STORAGE_KEY = 'cretli-kib-radial-enabled';
const LONG_PRESS_MS = 520;
const LOCK_OPEN_HOLD_MS = 650;
const CENTER_CLOSE_HOLD_MS = 560;
const KIB_RESUME_GRACE_MS = 2800;
const MOVE_CANCEL_BEFORE_ARMED_PX = 14;
const MIN_SWIPE_PX = 36;
const OPTION_STEP_PX = 56;
const OPTION_START_PX = 26;
const ARROW_REPEAT_START_MS = 320;
const ARROW_REPEAT_INTERVAL_MS = 240;
const ARROW_REPEAT_HAPTIC_MS = 22;

const KIB_OPTIONS = {
  up: [{ icon: 'mdi-chevron-up', labelKey: '', action: 'arrow-up' }],
  right: [{ icon: 'mdi-chevron-right', labelKey: '', action: 'arrow-right' }],
  down: [
    { icon: 'mdi-chevron-down', labelKey: '', action: 'arrow-down' },
    { icon: 'mdi-refresh', labelKey: 'common.refresh', action: 'refresh' },
  ],
  left: [{ icon: 'mdi-chevron-left', labelKey: '', action: 'arrow-left' }],
};

function isTouchPrimary() {
  if (typeof window === 'undefined' || typeof matchMedia !== 'function') return false;
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

export function getKibRadialEnabled() {
  if (typeof localStorage === 'undefined') return isTouchPrimary();
  const v = readStorageValueWithAlias(localStorage, STORAGE_KEY, '');
  if (v === '0') return false;
  if (v === '1') return true;
  return isTouchPrimary();
}

export function setKibRadialEnabled(on) {
  if (typeof localStorage === 'undefined') return;
  writeStorageValueWithAlias(localStorage, STORAGE_KEY, on ? '1' : '0');
  syncKibXtermTouchClass();
}

function syncKibXtermTouchClass() {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle('kib-radial-xterm-touch', getKibRadialEnabled());
}

/**
 * Which kind of terminal received the long press:
 * - 'chat' - the terminal embedded in a chat (inside #chat-panel)
 * - 'terminal' - the standalone Terminal panel (#terminal-panel)
 * Kib works in both. The native long-press menu is disabled by CSS for every
 * .xterm, so without activating Kib the touch would be swallowed with no effect.
 */
function getTerminalTargetKind(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.closest('.chat-send-bar, .chat-fullscreen-bar, .chat-list-modal, .terminal-send-bar-wrap, .terminal-fullscreen-bar')) return null;
  if (!el.closest('.xterm') && !el.closest('.xterm-helper-textarea')) return null;
  if (el.closest('#chat-panel')) return 'chat';
  if (el.closest('#terminal-panel')) return 'terminal';
  return null;
}

/** Once Kib is armed, drop the selection and the keyboard forced by the xterm long press. */
function suppressXtermLongPressUi() {
  try {
    const sel = window.getSelection?.();
    if (sel && sel.rangeCount) sel.removeAllRanges();
  } catch (_) {}
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('xterm-helper-textarea')) {
    try {
      ae.blur();
    } catch (_) {}
  }
}

function focusXtermFromTarget(target) {
  if (!target || target.nodeType !== 1) return;
  const xterm = target.closest('.xterm');
  if (!xterm) return;
  const helper = xterm.querySelector('.xterm-helper-textarea');
  if (!helper || typeof helper.focus !== 'function') return;
  try {
    helper.focus({ preventScroll: true });
  } catch (_) {
    helper.focus();
  }
}

/** True when the element (or an ancestor) is an interactive zone where the long press is skipped; xterm/canvas are handled on purpose. */
function shouldIgnoreTarget(el) {
  if (!el || el.nodeType !== 1) return true;
  // xterm-helper-textarea is an internal terminal element, not a real form field.
  if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (['input', 'textarea', 'button', 'select', 'a'].includes(tag)) return true;
  if (el.isContentEditable) return true;
  if (el.closest('button, a, input, textarea, select, [role="slider"]')) return true;
  if (el.closest('.kib-radial-layer')) return true;
  return false;
}

let layer = null;
let hub = null;
let longTimer = null;
let armed = false;
let startX = 0;
let startY = 0;
let activeSelection = null;
let pointerId = null;
let lockScrollX = 0;
let lockScrollY = 0;
let prevHtmlOverflow = '';
let prevBodyOverflow = '';
let prevHtmlOverscroll = '';
let prevBodyOverscroll = '';
let lastTouchStartScrollX = 0;
let lastTouchStartScrollY = 0;
let lastTouchTarget = null;
let repeatTimeoutId = null;
let repeatIntervalId = null;
let repeatSelectionKey = '';
let repeatSentCount = 0;
let armedAtMs = 0;
let lockedOpen = false;
let lockHoldTimer = null;
let lockHoldHapticSent = false;
let lockedTapSelection = null;
let lockedTapEligible = false;
let centerCloseTimer = null;
let centerClosePending = false;
let armedTerminalKind = null;
let lifecycleCleanupBound = false;
let resumeGraceUntil = 0;

function markKibResumeGrace() {
  resumeGraceUntil = Date.now() + KIB_RESUME_GRACE_MS;
}

function isKibResumeGraceActive() {
  return Date.now() < resumeGraceUntil;
}

function ensureDom() {
  if (layer) return;
  layer = document.createElement('div');
  layer.className = 'kib-radial-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML =
    '<div class="kib-radial-hub" role="presentation">' +
    '<div class="kib-radial-center">' +
    '<svg class="kib-radial-center-arc" viewBox="0 0 88 88" aria-hidden="true">' +
    '<defs><path id="kib-radial-center-arc-path" d="M 10 52 A 34 34 0 0 1 78 52"></path></defs>' +
    '<text class="kib-radial-center-arc-text"><textPath class="kib-radial-center-arc-textpath" href="#kib-radial-center-arc-path" startOffset="50%" text-anchor="middle"> </textPath></text>' +
    '</svg>' +
    '<span class="kib-radial-center-icon mdi mdi-gesture-tap-hold" aria-hidden="true"></span>' +
    '</div>' +
    '<div class="kib-radial-options" aria-hidden="true"></div>' +
    '</div>';
  document.body.appendChild(layer);
  hub = layer.querySelector('.kib-radial-hub');
  const optionsEl = hub.querySelector('.kib-radial-options');
  if (optionsEl) {
    for (const dir of Object.keys(KIB_OPTIONS)) {
      const list = KIB_OPTIONS[dir] || [];
      list.forEach((opt, idx) => {
        const node = document.createElement('span');
        node.className = 'kib-radial-option kib-radial-option--' + dir;
        node.dataset.dir = dir;
        node.dataset.level = String(idx + 1);
        node.style.setProperty('--kib-level', String(idx + 1));
        node.innerHTML = '<span class="mdi ' + opt.icon + '" aria-hidden="true"></span>';
        optionsEl.appendChild(node);
      });
    }
  }
}

function setOptionHighlight(sel) {
  const centerEl = hub ? hub.querySelector('.kib-radial-center') : null;
  const centerIcon = hub ? hub.querySelector('.kib-radial-center-icon') : null;
  const centerLabel = hub ? hub.querySelector('.kib-radial-center-arc-textpath') : null;
  const prev = activeSelection;
  if (!hub) return;
  hub.querySelectorAll('.kib-radial-option').forEach((node) => {
    const match = !!sel && node.dataset.dir === sel.dir && Number(node.dataset.level || 0) === sel.level;
    node.classList.toggle('kib-radial-option--hot', match);
  });
  activeSelection = sel || null;
  if (centerIcon) {
    const opts = sel ? KIB_OPTIONS[sel.dir] || [] : [];
    const opt = sel ? opts[sel.level - 1] : null;
    centerIcon.className = 'kib-radial-center-icon mdi ' + (opt?.icon || 'mdi-gesture-tap-hold');
    if (centerLabel && centerEl) {
      const label = opt?.labelKey ? t(opt.labelKey) : '';
      centerLabel.textContent = label || ' ';
      centerEl.classList.toggle('kib-radial-center--with-label', !!label);
    }
  }
  const changed =
    !!sel &&
    (!prev || prev.dir !== sel.dir || prev.level !== sel.level);
  if (changed) {
    try {
      if (navigator.vibrate) navigator.vibrate(10);
    } catch (_) {}
  }
  syncArrowRepeat(sel);
}

function directionFromDelta(dx, dy) {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < MIN_SWIPE_PX && ady < MIN_SWIPE_PX) return null;
  if (ady >= adx) return dy > 0 ? 'down' : 'up';
  return dx > 0 ? 'right' : 'left';
}

function selectionFromDelta(dx, dy) {
  const dir = directionFromDelta(dx, dy);
  if (!dir) return null;
  const axisDist = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
  const levels = (KIB_OPTIONS[dir] || []).length;
  if (!levels) return null;
  const level = Math.max(1, Math.min(levels, Math.floor((axisDist - OPTION_START_PX) / OPTION_STEP_PX) + 1));
  return { dir, level };
}

function selectionFromOptionNode(node) {
  if (!node) return null;
  const dir = node.dataset?.dir || '';
  const level = Number(node.dataset?.level || 0);
  if (!dir || !Number.isFinite(level) || level < 1) return null;
  if (!KIB_OPTIONS[dir] || !(KIB_OPTIONS[dir][level - 1])) return null;
  return { dir, level };
}

function placeHub(x, y) {
  if (!hub) return;
  hub.style.left = x + 'px';
  hub.style.top = y + 'px';
}

function showLayer() {
  ensureDom();
  lockScrollX = window.scrollX || 0;
  lockScrollY = window.scrollY || 0;
  const html = document.documentElement;
  const body = document.body;
  prevHtmlOverflow = html.style.overflow || '';
  prevBodyOverflow = body.style.overflow || '';
  prevHtmlOverscroll = html.style.overscrollBehavior || '';
  prevBodyOverscroll = body.style.overscrollBehavior || '';
  html.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  html.style.overscrollBehavior = 'none';
  body.style.overscrollBehavior = 'none';
  window.scrollTo(lockScrollX, lockScrollY);
  layer.classList.add('kib-radial-layer--visible');
  document.body.classList.add('kib-radial-active');
}

function hideLayer() {
  if (layer) layer.classList.remove('kib-radial-layer--visible');
  const html = document.documentElement;
  const body = document.body;
  html.style.overflow = prevHtmlOverflow;
  body.style.overflow = prevBodyOverflow;
  html.style.overscrollBehavior = prevHtmlOverscroll;
  body.style.overscrollBehavior = prevBodyOverscroll;
  document.body.classList.remove('kib-radial-active');
  setOptionHighlight(null);
}

function clearTimer() {
  if (longTimer) {
    clearTimeout(longTimer);
    longTimer = null;
  }
}

function clearLockHoldTimer() {
  if (!lockHoldTimer) return;
  clearTimeout(lockHoldTimer);
  lockHoldTimer = null;
}

function clearCenterCloseTimer() {
  if (!centerCloseTimer) return;
  clearTimeout(centerCloseTimer);
  centerCloseTimer = null;
}

function onRefresh() {
  try {
    window.location.reload();
  } catch (_) {}
}

function runSelectionAction(sel) {
  if (!sel) return;
  const opts = KIB_OPTIONS[sel.dir] || [];
  const opt = opts[sel.level - 1];
  if (!opt || !opt.action) return;
  if (opt.action === 'refresh') {
    onRefresh();
    return;
  }
  if (opt.action.startsWith('arrow-')) {
    const direction = opt.action.slice('arrow-'.length);
    if (armedTerminalKind === 'terminal') {
      const t = getLoadedPanelModule('terminal')?.getActiveTerminal?.() ?? null;
      if (t) sendSequenceToTerminalState(t, TERMINAL_ARROW_SEQUENCES[direction], { focus: false });
      return;
    }
    sendNavKeyToActiveChat(direction);
  }
}

function isArrowSelection(sel) {
  if (!sel) return false;
  const opts = KIB_OPTIONS[sel.dir] || [];
  const opt = opts[sel.level - 1];
  return !!opt && typeof opt.action === 'string' && opt.action.startsWith('arrow-');
}

function stopArrowRepeat() {
  if (repeatTimeoutId) {
    clearTimeout(repeatTimeoutId);
    repeatTimeoutId = null;
  }
  if (repeatIntervalId) {
    clearInterval(repeatIntervalId);
    repeatIntervalId = null;
  }
  repeatSelectionKey = '';
  repeatSentCount = 0;
}

function syncArrowRepeat(sel) {
  const key = sel ? sel.dir + ':' + sel.level : '';
  if (!isArrowSelection(sel)) {
    stopArrowRepeat();
    return;
  }
  if (repeatSelectionKey === key && (repeatTimeoutId || repeatIntervalId)) return;
  stopArrowRepeat();
  repeatSelectionKey = key;
  repeatTimeoutId = setTimeout(() => {
    repeatTimeoutId = null;
    if (!activeSelection || activeSelection.dir + ':' + activeSelection.level !== repeatSelectionKey) return;
    runSelectionAction(activeSelection);
    fireRepeatHaptic();
    repeatSentCount += 1;
    repeatIntervalId = setInterval(() => {
      if (!activeSelection || activeSelection.dir + ':' + activeSelection.level !== repeatSelectionKey) {
        stopArrowRepeat();
        return;
      }
      runSelectionAction(activeSelection);
      fireRepeatHaptic();
      repeatSentCount += 1;
    }, ARROW_REPEAT_INTERVAL_MS);
  }, ARROW_REPEAT_START_MS);
}

function fireRepeatHaptic() {
  try {
    if (typeof navigator === 'undefined') return;
    if (typeof navigator.vibrate !== 'function') {
      console.warn('[kib] navigator.vibrate is not available in this browser');
      return;
    }
    const ok = navigator.vibrate(ARROW_REPEAT_HAPTIC_MS);
    if (ok === false) console.warn('[kib] navigator.vibrate rejected (permissions or silent mode?)');
  } catch (e) {
    console.warn('[kib] vibrate failed:', e);
  }
}

function cleanup() {
  clearTimer();
  clearLockHoldTimer();
  clearCenterCloseTimer();
  stopArrowRepeat();
  armed = false;
  pointerId = null;
  armedAtMs = 0;
  armedTerminalKind = null;
  lockedOpen = false;
  lockHoldHapticSent = false;
  lockedTapSelection = null;
  lockedTapEligible = false;
  centerClosePending = false;
  hideLayer();
}

function isLayerBlockingUi() {
  if (layer?.classList?.contains('kib-radial-layer--visible')) return true;
  if (document.body?.classList?.contains('kib-radial-active')) return true;
  return false;
}

function forceCleanupIfNeeded() {
  const isBusy =
    pointerId != null ||
    armed ||
    lockedOpen ||
    longTimer != null ||
    lockHoldTimer != null ||
    centerCloseTimer != null;
  const hasStaleTouchLock =
    document.body?.classList?.contains('kib-radial-active') &&
    !layer?.classList?.contains('kib-radial-layer--visible');
  if (!isBusy && !isLayerBlockingUi() && !hasStaleTouchLock) return;
  cleanup();
  pointerId = null;
  lastTouchTarget = null;
}

function bindLifecycleCleanup() {
  if (lifecycleCleanupBound) return;
  lifecycleCleanupBound = true;
  const onPageShown = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    markKibResumeGrace();
    forceCleanupIfNeeded();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      forceCleanupIfNeeded();
      return;
    }
    onPageShown();
  }, true);
  window.addEventListener('pagehide', () => {
    forceCleanupIfNeeded();
  }, true);
  window.addEventListener('pageshow', () => {
    onPageShown();
  }, true);
}

/** Clears a stuck Kib radial overlay / body touch lock after PWA resume. */
export function resetKibRadialUiIfStuck() {
  markKibResumeGrace();
  const wasBlocking = isLayerBlockingUi();
  forceCleanupIfNeeded();
  return wasBlocking ? 'kib-radial' : undefined;
}

function onTouchStart(ev) {
  if (!getKibRadialEnabled()) return;
  if (isKibResumeGraceActive()) return;
  if (ev.touches.length !== 1) return;
  lastTouchStartScrollX = window.scrollX || 0;
  lastTouchStartScrollY = window.scrollY || 0;
  lastTouchTarget = ev.target;
  const t = ev.touches[0];
  if (lockedOpen) {
    ev.preventDefault();
    ev.stopPropagation();
    const hit = document.elementFromPoint(t.clientX, t.clientY);
    if (hit && hit.closest && hit.closest('.kib-radial-center')) {
      clearCenterCloseTimer();
      pointerId = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      centerClosePending = true;
      lockedTapSelection = null;
      lockedTapEligible = false;
      armed = true;
      armedAtMs = Date.now();
      centerCloseTimer = setTimeout(() => {
        centerCloseTimer = null;
        if (!lockedOpen || !centerClosePending) return;
        try {
          if (navigator.vibrate) navigator.vibrate(16);
        } catch (_) {}
        cleanup();
      }, CENTER_CLOSE_HOLD_MS);
      return;
    }
    centerClosePending = false;
    clearCenterCloseTimer();
    const optionNode = hit && hit.closest ? hit.closest('.kib-radial-option') : null;
    const sel = selectionFromOptionNode(optionNode);
    if (!sel) {
      cleanup();
      return;
    }
    setOptionHighlight(sel);
    pointerId = t.identifier;
    startX = t.clientX;
    startY = t.clientY;
    lockedTapSelection = sel;
    lockedTapEligible = true;
    armed = true;
    armedAtMs = Date.now();
    return;
  }
  const kind = getTerminalTargetKind(ev.target);
  if (!kind) return;
  if (shouldIgnoreTarget(ev.target)) return;
  armedTerminalKind = kind;
  pointerId = t.identifier;
  startX = t.clientX;
  startY = t.clientY;
  armed = false;
  armedAtMs = 0;
  lockHoldHapticSent = false;
  clearLockHoldTimer();
  clearTimer();
  longTimer = setTimeout(() => {
    longTimer = null;
    armed = true;
    armedAtMs = Date.now();
    suppressXtermLongPressUi();
    showLayer();
    placeHub(startX, startY);
    try {
      if (navigator.vibrate) navigator.vibrate(18);
    } catch (_) {}
    clearLockHoldTimer();
    lockHoldTimer = setTimeout(() => {
      lockHoldTimer = null;
      if (!armed || lockedOpen || lockHoldHapticSent) return;
      lockHoldHapticSent = true;
      try {
        if (navigator.vibrate) navigator.vibrate(24);
      } catch (_) {}
    }, LOCK_OPEN_HOLD_MS);
  }, LONG_PRESS_MS);
}

function onTouchMove(ev) {
  if (pointerId == null) return;
  const t = Array.from(ev.touches).find((x) => x.identifier === pointerId);
  if (!t) return;
  if (lockedOpen) {
    ev.preventDefault();
    ev.stopPropagation();
    if (centerClosePending) {
      const dxCenter = t.clientX - startX;
      const dyCenter = t.clientY - startY;
      if (dxCenter * dxCenter + dyCenter * dyCenter > 14 * 14) {
        centerClosePending = false;
        clearCenterCloseTimer();
      }
      return;
    }
    if (!lockedTapEligible) return;
    const dxTap = t.clientX - startX;
    const dyTap = t.clientY - startY;
    if (dxTap * dxTap + dyTap * dyTap > 14 * 14) {
      lockedTapEligible = false;
    }
    return;
  }
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;
  if (!armed) {
    if (dx * dx + dy * dy > MOVE_CANCEL_BEFORE_ARMED_PX * MOVE_CANCEL_BEFORE_ARMED_PX) {
      clearTimer();
    }
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (window.scrollX !== lockScrollX || window.scrollY !== lockScrollY) {
    window.scrollTo(lockScrollX, lockScrollY);
  }
  const sel = selectionFromDelta(dx, dy);
  setOptionHighlight(sel);
}

function onTouchEnd(ev) {
  if (lockedOpen && pointerId == null) {
    cleanup();
    lastTouchTarget = null;
    return;
  }
  const still = Array.from(ev.touches || []).some((x) => x.identifier === pointerId);
  if (still) return;
  if (!armed) {
    clearTimer();
    pointerId = null;
    if (getKibRadialEnabled() && getTerminalTargetKind(lastTouchTarget)) {
      focusXtermFromTarget(lastTouchTarget);
    }
    lastTouchTarget = null;
    return;
  }
  const sel = activeSelection;
  const sentByRepeat = repeatSentCount > 0;
  const heldOpenMs = armedAtMs > 0 ? Date.now() - armedAtMs : 0;
  const shouldLockOpen = !lockedOpen && heldOpenMs >= LOCK_OPEN_HOLD_MS;
  if (shouldLockOpen) {
    clearLockHoldTimer();
    lockedOpen = true;
    pointerId = null;
    armed = false;
    armedAtMs = 0;
    stopArrowRepeat();
    lastTouchTarget = null;
    if (!lockHoldHapticSent) {
      lockHoldHapticSent = true;
      try {
        if (navigator.vibrate) navigator.vibrate(24);
      } catch (_) {}
    }
    if (!sentByRepeat) runSelectionAction(sel);
    return;
  }
  if (lockedOpen) {
    clearLockHoldTimer();
    if (centerClosePending) {
      const closeByTap = !!centerClosePending;
      centerClosePending = false;
      clearCenterCloseTimer();
      pointerId = null;
      armed = false;
      armedAtMs = 0;
      stopArrowRepeat();
      lockedTapEligible = false;
      lockedTapSelection = null;
      lastTouchTarget = null;
      if (closeByTap) cleanup();
      return;
    }
    const tapSel = lockedTapEligible ? lockedTapSelection : null;
    pointerId = null;
    armed = false;
    armedAtMs = 0;
    stopArrowRepeat();
    lockedTapEligible = false;
    lockedTapSelection = null;
    lastTouchTarget = null;
    if (!sentByRepeat) runSelectionAction(tapSel);
    return;
  }
  cleanup();
  pointerId = null;
  lastTouchTarget = null;
  if (!sentByRepeat) runSelectionAction(sel);
}

function onTouchCancel() {
  cleanup();
  pointerId = null;
  lastTouchTarget = null;
}

function onContextMenu(ev) {
  if (!getKibRadialEnabled()) return;
  if (!getTerminalTargetKind(ev.target)) return;
  ev.preventDefault();
  ev.stopPropagation();
}

function onSelectStart(ev) {
  if (!getKibRadialEnabled()) return;
  if (!getTerminalTargetKind(ev.target)) return;
  ev.preventDefault();
}

/**
 * Works around the viewport jumping when the xterm helper textarea gains focus
 * (mobile).
 */
function onXtermHelperFocusIn(ev) {
  if (!getKibRadialEnabled()) return;
  const el = ev.target;
  if (!el || !el.classList || !el.classList.contains('xterm-helper-textarea')) return;
  const x = lastTouchStartScrollX;
  const y = lastTouchStartScrollY;
  requestAnimationFrame(() => window.scrollTo(x, y));
  setTimeout(() => window.scrollTo(x, y), 0);
}

export function initKibRadial() {
  if (typeof document === 'undefined') return;
  syncKibXtermTouchClass();
  registerPageResumeCleanupHook(resetKibRadialUiIfStuck);
  bindLifecycleCleanup();
  document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('selectstart', onSelectStart, true);
  document.addEventListener('focusin', onXtermHelperFocusIn, true);
}

export function initKibRadialSetting() {
  const cb = document.getElementById('kib-radial-checkbox');
  if (!cb) return;
  cb.checked = getKibRadialEnabled();
  syncKibXtermTouchClass();
  cb.addEventListener('change', () => setKibRadialEnabled(cb.checked));
}
