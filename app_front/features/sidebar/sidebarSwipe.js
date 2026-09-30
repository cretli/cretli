/**
 * Mobile overlay sidebar: swipe left to close, swipe in from the left edge to
 * open. Desktop (including an unpinned overlay) never starts these gestures.
 *
 * Pointer capture is not used: moving the aside under the finger would lose
 * capture and snap the drawer. On pointerdown we pin the current translateX
 * before cutting the CSS transition so `translateX(-100%)` cannot flash.
 * Safari's back-swipe may still win at the screen edge.
 */

export const SWIPE_COMMIT_PX = 8;
export const SWIPE_CLOSE_RATIO = 0.4;
export const SWIPE_CLOSE_VELOCITY_PX_MS = 0.5;
export const SWIPE_SETTLE_MS = 220;
export const SWIPE_EDGE_OPEN_PX = 20;

const SWIPING_CLASS = 'sidebar-swiping';
const SETTLING_CLASS = 'sidebar-swipe-settling';

/**
 * @param {{
 *   isMobile?: boolean,
 *   isResizing?: boolean,
 *   isChatDragging?: boolean,
 *   isWorkspaceDragging?: boolean,
 *   target?: { closest?: (selector: string) => unknown } | EventTarget | null,
 * }} [options]
 * @returns {boolean}
 */
export function canStartSwipe(options = {}) {
  if (options.isMobile !== true) return false;
  if (options.isResizing === true) return false;
  if (options.isChatDragging === true) return false;
  if (options.isWorkspaceDragging === true) return false;
  if (isResizerTarget(options.target)) return false;
  if (isHiddenRowTarget(options.target)) return false;
  return true;
}

/**
 * @param {{ isMobile?: boolean, isOpen?: boolean, isResizing?: boolean }} [options]
 * @returns {boolean}
 */
export function canStartEdgeOpen(options = {}) {
  if (options.isMobile !== true) return false;
  if (options.isOpen === true) return false;
  if (options.isResizing === true) return false;
  return true;
}

/**
 * Close only on a leftward swipe past the distance or flick threshold.
 *
 * @param {{ deltaX?: number, width?: number, velocityX?: number }} [options]
 * @returns {boolean}
 */
export function shouldCloseSwipe(options = {}) {
  return shouldSettleSwipe({ ...options, direction: 'close' });
}

/**
 * Open only on a rightward swipe past the distance or flick threshold.
 *
 * @param {{ deltaX?: number, width?: number, velocityX?: number }} [options]
 * @returns {boolean}
 */
export function shouldOpenSwipe(options = {}) {
  return shouldSettleSwipe({ ...options, direction: 'open' });
}

/**
 * @param {{
 *   getSidebar?: () => HTMLElement | null,
 *   getBackdrop?: () => HTMLElement | null,
 *   getEdgeOpen?: () => HTMLElement | null,
 *   isOpen?: () => boolean,
 *   isMobile?: () => boolean,
 *   isResizing?: () => boolean,
 *   isChatDragging?: () => boolean,
 *   isWorkspaceDragging?: () => boolean,
 *   onClose?: () => void,
 *   onOpen?: () => void,
 *   onPreviewReveal?: () => void,
 *   onPreviewHide?: () => void,
 * }} [options]
 * @returns {{ isSwiping: () => boolean, abort: () => void }}
 */
export function initSidebarSwipe(options = {}) {
  if (typeof window === 'undefined' || typeof PointerEvent === 'undefined') {
    return { isSwiping: () => false, abort() {} };
  }
  const getSidebar = typeof options.getSidebar === 'function' ? options.getSidebar : () => null;
  const getBackdrop = typeof options.getBackdrop === 'function' ? options.getBackdrop : () => null;
  const getEdgeOpen = typeof options.getEdgeOpen === 'function' ? options.getEdgeOpen : () => null;
  const isOpen = typeof options.isOpen === 'function' ? options.isOpen : () => false;
  const isMobile = typeof options.isMobile === 'function' ? options.isMobile : () => false;
  const isResizing = typeof options.isResizing === 'function' ? options.isResizing : () => false;
  const isChatDragging = typeof options.isChatDragging === 'function' ? options.isChatDragging : () => false;
  const isWorkspaceDragging =
    typeof options.isWorkspaceDragging === 'function' ? options.isWorkspaceDragging : () => false;
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};
  const onPreviewReveal = typeof options.onPreviewReveal === 'function' ? options.onPreviewReveal : () => {};
  const onPreviewHide = typeof options.onPreviewHide === 'function' ? options.onPreviewHide : () => {};
  const sidebar = getSidebar();
  const backdrop = getBackdrop();
  const edgeOpen = getEdgeOpen();
  if (!sidebar) return { isSwiping: () => false, abort() {} };

  /** @type {Gesture | null} */
  let gesture = null;
  let suppressClick = false;
  let settleTimer = 0;
  /** @type {((ev: TransitionEvent) => void) | null} */
  let settleListener = null;

  function readCanStartClose(target) {
    return canStartSwipe({
      isMobile: isMobile() === true,
      isResizing: isResizing() === true,
      isChatDragging: isChatDragging() === true,
      isWorkspaceDragging: isWorkspaceDragging() === true,
      target,
    });
  }

  function readCanStartOpen() {
    return canStartEdgeOpen({
      isMobile: isMobile() === true,
      isOpen: isOpen() === true,
      isResizing: isResizing() === true,
    });
  }

  function isActive() {
    return gesture !== null;
  }

  function onClosePointerDown(ev) {
    if (gesture) return;
    if (!isOpen()) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (!readCanStartClose(ev.target)) return;
    const width = measureSidebarWidth(sidebar);
    if (!(width > 0)) return;
    gesture = createGesture('close', ev, width);
    lockDrawerAtOpen(sidebar, backdrop);
  }

  function onOpenPointerDown(ev) {
    if (gesture) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (!readCanStartOpen()) return;
    onPreviewReveal();
    const width = measureSidebarWidth(sidebar);
    if (!(width > 0)) {
      onPreviewHide();
      return;
    }
    gesture = createGesture('open', ev, width);
    lockDrawerAtClosed(sidebar, backdrop, width);
  }

  function onPointerMove(ev) {
    if (!gesture || ev.pointerId !== gesture.pointerId) return;
    updateVelocity(gesture, ev.clientX, ev.timeStamp || Date.now());
    if (gesture.phase === 'pending') {
      tryCommit(ev);
      return;
    }
    if (gesture.phase !== 'tracking') return;
    applyFollow(sidebar, backdrop, ev.clientX - gesture.startX, gesture.width, gesture.kind);
  }

  function tryCommit(ev) {
    if (!gesture || gesture.phase !== 'pending') return;
    const deltaX = ev.clientX - gesture.startX;
    const deltaY = ev.clientY - gesture.startY;
    if (gesture.kind === 'open') {
      if (!isOpenCommit(deltaX, deltaY)) return;
    } else {
      if (!readCanStartClose(ev.target)) {
        clearPending();
        return;
      }
      if (!isHorizontalCommit(deltaX, deltaY)) return;
    }
    gesture.phase = 'tracking';
    sidebar.style.touchAction = 'none';
    applyFollow(sidebar, backdrop, deltaX, gesture.width, gesture.kind);
    document.body?.classList.add(SWIPING_CLASS);
  }

  function finishTracking(clientX, timeStamp) {
    if (!gesture || gesture.phase !== 'tracking') return;
    updateVelocity(gesture, clientX, timeStamp);
    const deltaX = clientX - gesture.startX;
    const args = { deltaX, width: gesture.width, velocityX: gesture.velocityX };
    if (gesture.kind === 'open') {
      if (shouldOpenSwipe(args)) settleOpen();
      else settleOpenCancel();
      return;
    }
    if (shouldCloseSwipe(args)) settleClose();
    else settleSnapBack();
  }

  function onPointerUp(ev) {
    if (!gesture || ev.pointerId !== gesture.pointerId) return;
    if (gesture.phase === 'pending') {
      clearPending();
      return;
    }
    finishTracking(ev.clientX, ev.timeStamp || Date.now());
  }

  function onPointerCancel(ev) {
    if (!gesture || ev.pointerId !== gesture.pointerId) return;
    if (gesture.phase === 'pending') {
      clearPending();
      return;
    }
    finishTracking(gesture.lastX, ev.timeStamp || Date.now());
  }

  function onTouchMove(ev) {
    if (!gesture || gesture.phase !== 'tracking') return;
    ev.preventDefault();
  }

  function onSuppressedClick(ev) {
    if (!isActive() && !suppressClick) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    suppressClick = false;
  }

  function settleClose() {
    if (!gesture) return;
    beginSettle(-gesture.width, 0);
    waitForSettle(() => {
      teardownGesture();
      suppressClick = true;
      onClose();
      clearInlineStyles(sidebar, backdrop);
    });
  }

  function settleSnapBack() {
    if (!gesture) return;
    beginSettle(0, 1);
    waitForSettle(() => {
      teardownGesture();
      suppressClick = true;
      clearInlineStyles(sidebar, backdrop);
    });
  }

  function settleOpen() {
    if (!gesture) return;
    beginSettle(0, 1);
    waitForSettle(() => {
      teardownGesture();
      suppressClick = true;
      onOpen();
      clearInlineStyles(sidebar, backdrop);
    });
  }

  function settleOpenCancel() {
    if (!gesture) return;
    const width = gesture.width;
    beginSettle(-width, 0);
    waitForSettle(() => {
      teardownGesture();
      onPreviewHide();
      clearInlineStyles(sidebar, backdrop);
    });
  }

  /**
   * @param {number} translateX
   * @param {number} opacity
   */
  function beginSettle(translateX, opacity) {
    if (!gesture) return;
    gesture.phase = 'settling';
    document.body?.classList.remove(SWIPING_CLASS);
    document.body?.classList.add(SETTLING_CLASS);
    enableDrawerSettleTransition(sidebar, backdrop);
    void sidebar.offsetWidth;
    sidebar.style.transform = `translateX(${translateX}px)`;
    if (backdrop) backdrop.style.opacity = String(opacity);
  }

  /**
   * @param {() => void} done
   */
  function waitForSettle(done) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      detachSettleWait();
      done();
    };
    settleListener = (ev) => {
      if (ev.target !== sidebar) return;
      if (ev.propertyName && ev.propertyName !== 'transform') return;
      finish();
    };
    sidebar.addEventListener('transitionend', settleListener);
    settleTimer = window.setTimeout(finish, SWIPE_SETTLE_MS);
  }

  function detachSettleWait() {
    if (settleListener) {
      sidebar.removeEventListener('transitionend', settleListener);
      settleListener = null;
    }
    if (settleTimer) {
      window.clearTimeout(settleTimer);
      settleTimer = 0;
    }
  }

  function clearPending() {
    if (!gesture || gesture.phase !== 'pending') return;
    const kind = gesture.kind;
    gesture = null;
    clearInlineStyles(sidebar, backdrop);
    if (kind === 'open') onPreviewHide();
  }

  function teardownGesture() {
    detachSettleWait();
    gesture = null;
    document.body?.classList.remove(SWIPING_CLASS, SETTLING_CLASS);
  }

  function abort() {
    if (!gesture) return;
    const kind = gesture.kind;
    teardownGesture();
    clearInlineStyles(sidebar, backdrop);
    if (kind === 'open') onPreviewHide();
  }

  sidebar.addEventListener('pointerdown', onClosePointerDown);
  edgeOpen?.addEventListener('pointerdown', onOpenPointerDown);
  window.addEventListener('pointermove', onPointerMove, { capture: true });
  window.addEventListener('pointerup', onPointerUp, { capture: true });
  window.addEventListener('pointercancel', onPointerCancel, { capture: true });
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  sidebar.addEventListener('click', onSuppressedClick, true);
  backdrop?.addEventListener('click', onSuppressedClick, true);

  return {
    isSwiping: isActive,
    abort,
  };
}

/**
 * @param {'close' | 'open'} kind
 * @param {PointerEvent} ev
 * @param {number} width
 * @returns {Gesture}
 */
function createGesture(kind, ev, width) {
  return {
    kind,
    phase: 'pending',
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    lastX: ev.clientX,
    lastT: ev.timeStamp || Date.now(),
    velocityX: 0,
    width,
  };
}

/**
 * @param {unknown} target
 * @returns {boolean}
 */
function isResizerTarget(target) {
  if (!target || typeof target !== 'object' || typeof target.closest !== 'function') return false;
  return !!target.closest('#sidebar-resizer');
}

/**
 * A pointer on a row hidden by a collapsed subchat group must not start a
 * sidebar swipe gesture.
 *
 * @param {unknown} target
 * @returns {boolean}
 */
function isHiddenRowTarget(target) {
  if (!target || typeof target !== 'object' || typeof target.closest !== 'function') return false;
  return !!target.closest('[hidden], .is-subchat-hidden');
}

/**
 * @param {number} deltaX
 * @param {number} deltaY
 * @returns {boolean}
 */
function isHorizontalCommit(deltaX, deltaY) {
  return Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_COMMIT_PX;
}

/**
 * @param {number} deltaX
 * @param {number} deltaY
 * @returns {boolean}
 */
function isOpenCommit(deltaX, deltaY) {
  return deltaX > SWIPE_COMMIT_PX && deltaX > Math.abs(deltaY);
}

/**
 * @param {{ deltaX?: number, width?: number, velocityX?: number, direction: 'close' | 'open' }} options
 * @returns {boolean}
 */
function shouldSettleSwipe(options) {
  const deltaX = Number(options.deltaX);
  const width = Number(options.width);
  const velocityX = Number(options.velocityX);
  const towardClose = options.direction === 'close';
  if (!Number.isFinite(deltaX)) return false;
  if (towardClose ? !(deltaX < 0) : !(deltaX > 0)) return false;
  if (Number.isFinite(width) && width > 0 && Math.abs(deltaX) > SWIPE_CLOSE_RATIO * width) {
    return true;
  }
  if (!Number.isFinite(velocityX)) return false;
  return towardClose
    ? velocityX < -SWIPE_CLOSE_VELOCITY_PX_MS
    : velocityX > SWIPE_CLOSE_VELOCITY_PX_MS;
}

/**
 * @typedef {{
 *   kind: 'close' | 'open',
 *   phase: 'pending' | 'tracking' | 'settling',
 *   pointerId: number,
 *   startX: number,
 *   startY: number,
 *   lastX: number,
 *   lastT: number,
 *   velocityX: number,
 *   width: number,
 * }} Gesture
 */

/**
 * @param {Gesture} gesture
 * @param {number} clientX
 * @param {number} timeStamp
 */
function updateVelocity(gesture, clientX, timeStamp) {
  const dt = timeStamp - gesture.lastT;
  if (dt > 0 && dt < 80) {
    gesture.velocityX = (clientX - gesture.lastX) / dt;
  } else if (dt >= 80) {
    gesture.velocityX = 0;
  }
  gesture.lastX = clientX;
  gesture.lastT = timeStamp;
}

/**
 * @param {HTMLElement} sidebar
 * @returns {number}
 */
function measureSidebarWidth(sidebar) {
  const measured = Math.round(sidebar.getBoundingClientRect().width);
  return measured > 0 ? measured : 0;
}

/**
 * @param {HTMLElement} sidebar
 * @param {HTMLElement | null} backdrop
 */
function lockDrawerAtOpen(sidebar, backdrop) {
  sidebar.style.transform = 'translateX(0px)';
  sidebar.style.willChange = 'transform';
  if (backdrop) backdrop.style.opacity = '1';
  void sidebar.offsetWidth;
  sidebar.style.transition = 'none';
  if (backdrop) backdrop.style.transition = 'none';
}

/**
 * @param {HTMLElement} sidebar
 * @param {HTMLElement | null} backdrop
 * @param {number} width
 */
function lockDrawerAtClosed(sidebar, backdrop, width) {
  sidebar.style.transform = `translateX(${-width}px)`;
  sidebar.style.willChange = 'transform';
  if (backdrop) backdrop.style.opacity = '0';
  void sidebar.offsetWidth;
  sidebar.style.transition = 'none';
  if (backdrop) backdrop.style.transition = 'none';
}

/**
 * @param {HTMLElement} sidebar
 * @param {HTMLElement | null} backdrop
 */
function enableDrawerSettleTransition(sidebar, backdrop) {
  sidebar.style.transition = 'transform 0.2s ease';
  if (backdrop) backdrop.style.transition = 'opacity 0.2s ease';
}

/**
 * @param {HTMLElement} sidebar
 * @param {HTMLElement | null} backdrop
 * @param {number} deltaX
 * @param {number} width
 * @param {'close' | 'open'} kind
 */
function applyFollow(sidebar, backdrop, deltaX, width, kind) {
  const raw = kind === 'open' ? -width + deltaX : deltaX;
  const clamped = Math.max(-width, Math.min(0, raw));
  sidebar.style.transform = `translateX(${clamped}px)`;
  if (!backdrop || !(width > 0)) return;
  backdrop.style.opacity = String(1 + clamped / width);
}

/**
 * @param {HTMLElement | null} sidebar
 * @param {HTMLElement | null} backdrop
 */
function clearInlineStyles(sidebar, backdrop) {
  sidebar?.style.removeProperty('transform');
  sidebar?.style.removeProperty('transition');
  sidebar?.style.removeProperty('will-change');
  sidebar?.style.removeProperty('touch-action');
  backdrop?.style.removeProperty('opacity');
  backdrop?.style.removeProperty('transition');
}
