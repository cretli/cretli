const DOCK_POSITION_PREFIX = 'cr-widget-dock-position:v1:';
/** Pointer travel (px) before a press on the launcher turns into a drag. */
export const DRAG_THRESHOLD_PX = 6;
const EDGE_MARGIN_PX = 8;
const PANEL_GAP_PX = 8;
const PANEL_MAX_WIDTH_PX = 420;
const PANEL_MAX_HEIGHT_PX = 640;

function dockStorageKey(installationId, origin) {
  return `${DOCK_POSITION_PREFIX}${installationId || 'default'}:${origin || ''}`;
}

/**
 * Viewport box in the coordinate space of `position: fixed` elements. `left`
 * and `top` are non-zero when the page is pinch-zoomed or panned on mobile.
 * @typedef {{ width: number, height: number, left?: number, top?: number }} Viewport
 */

/**
 * Keep the dock fully inside the viewport.
 * @param {{ left: number, top: number }} pos
 * @param {{ width: number, height: number }} dockSize
 * @param {Viewport} viewport
 */
export function clampDockPosition(pos, dockSize, viewport) {
  const ox = viewport.left || 0;
  const oy = viewport.top || 0;
  const minLeft = ox + EDGE_MARGIN_PX;
  const minTop = oy + EDGE_MARGIN_PX;
  const maxLeft = Math.max(minLeft, ox + viewport.width - dockSize.width - EDGE_MARGIN_PX);
  const maxTop = Math.max(minTop, oy + viewport.height - dockSize.height - EDGE_MARGIN_PX);
  return {
    left: Math.round(Math.min(Math.max(pos.left, minLeft), maxLeft)),
    top: Math.round(Math.min(Math.max(pos.top, minTop), maxTop)),
  };
}

/**
 * Place the (non-modal) panel next to the dock: on the side with more room
 * vertically and aligned to the nearer horizontal edge.
 * @param {{ left: number, top: number, width: number, height: number }} dockRect
 * @param {Viewport} viewport
 */
export function computePanelAnchor(dockRect, viewport) {
  const ox = viewport.left || 0;
  const oy = viewport.top || 0;
  const width = Math.min(PANEL_MAX_WIDTH_PX, viewport.width - 24);
  const spaceAbove = dockRect.top - oy - PANEL_GAP_PX - EDGE_MARGIN_PX;
  const spaceBelow = oy + viewport.height - (dockRect.top + dockRect.height) - PANEL_GAP_PX - EDGE_MARGIN_PX;
  const above = spaceAbove >= spaceBelow;
  const height = Math.max(160, Math.min(PANEL_MAX_HEIGHT_PX, above ? spaceAbove : spaceBelow));
  const dockCenterX = dockRect.left + dockRect.width / 2;
  const alignRight = dockCenterX >= ox + viewport.width / 2;
  let left = alignRight ? dockRect.left + dockRect.width - width : dockRect.left;
  left = Math.min(
    Math.max(left, ox + EDGE_MARGIN_PX),
    Math.max(ox + EDGE_MARGIN_PX, ox + viewport.width - width - EDGE_MARGIN_PX),
  );
  const top = above
    ? Math.max(oy + EDGE_MARGIN_PX, dockRect.top - PANEL_GAP_PX - height)
    : dockRect.top + dockRect.height + PANEL_GAP_PX;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/**
 * Snap a freely dropped dock to the nearer side edge (like Android chat
 * heads); the vertical position is kept, relative to the viewport top.
 * @param {{ left: number, top: number }} pos
 * @param {{ width: number, height: number }} dockSize
 * @param {Viewport} viewport
 * @returns {{ side: 'left' | 'right', top: number }}
 */
export function snapDockPosition(pos, dockSize, viewport) {
  const ox = viewport.left || 0;
  const side = pos.left + dockSize.width / 2 < ox + viewport.width / 2 ? 'left' : 'right';
  return { side, top: clampDockPosition(pos, dockSize, viewport).top - (viewport.top || 0) };
}

/**
 * Pixel position of a docked launcher for the current viewport.
 * @param {{ side: 'left' | 'right', top: number }} docked
 * @param {{ width: number, height: number }} dockSize
 * @param {Viewport} viewport
 */
export function dockedToPosition(docked, dockSize, viewport) {
  const ox = viewport.left || 0;
  const left = docked.side === 'left' ? ox : ox + viewport.width;
  return clampDockPosition({ left, top: (viewport.top || 0) + docked.top }, dockSize, viewport);
}

/**
 * Visible part of the fixed-position containing block: the layout viewport
 * intersected with the visual viewport (pinch zoom / pan on mobile).
 * @returns {Required<Viewport>}
 */
export function readVisibleViewport() {
  const docEl = document.documentElement;
  const standards = document.compatMode === 'CSS1Compat';
  // innerWidth/innerHeight is the layout viewport that fixed elements use. On a
  // zoomed-out mobile page it is much larger than documentElement.clientWidth/
  // clientHeight (the initial containing block), so only use clientWidth/Height
  // to drop a desktop scrollbar, never to shrink the area.
  const withoutScrollbar = (inner, client) => (
    standards && client > 0 && inner - client >= 0 && inner - client <= 30 ? client : inner
  );
  const layoutWidth = withoutScrollbar(window.innerWidth, docEl?.clientWidth);
  const layoutHeight = withoutScrollbar(window.innerHeight, docEl?.clientHeight);
  let left = 0;
  let top = 0;
  let right = layoutWidth;
  let bottom = layoutHeight;
  const vv = window.visualViewport;
  if (vv && vv.width > 0 && vv.height > 0) {
    const vLeft = Math.max(left, vv.offsetLeft || 0);
    const vTop = Math.max(top, vv.offsetTop || 0);
    const vRight = Math.min(right, (vv.offsetLeft || 0) + vv.width);
    const vBottom = Math.min(bottom, (vv.offsetTop || 0) + vv.height);
    // Ignore a degenerate intersection rather than trapping the dock.
    if (vRight - vLeft > 40 && vBottom - vTop > 40) {
      left = vLeft;
      top = vTop;
      right = vRight;
      bottom = vBottom;
    }
  }
  return { left, top, width: right - left, height: bottom - top };
}

/** @returns {{ side: 'left' | 'right', top: number } | null} */
export function loadDockPosition(installationId, origin) {
  try {
    const raw = localStorage.getItem(dockStorageKey(installationId, origin));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Number.isFinite(data?.top)) return null;
    /** @type {'left' | 'right'} */
    const side = data.side === 'left' ? 'left' : 'right';
    return { side, top: Number(data.top) };
  } catch {
    return null;
  }
}

export function saveDockPosition(installationId, origin, docked) {
  try {
    const key = dockStorageKey(installationId, origin);
    if (!docked) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ side: docked.side, top: docked.top }));
  } catch {
    // localStorage may be unavailable in private mode.
  }
}

/**
 * Make the launcher dock draggable (mouse and touch) anywhere on screen; on
 * release it snaps to the nearer left/right edge. A press that moves less
 * than DRAG_THRESHOLD_PX stays a normal click; after a real drag the next
 * click is swallowed so the buttons do not fire. The docked side and height
 * are kept per installation and host origin.
 * @param {{ dock: HTMLElement, installationId?: string, origin?: string, onMove?: () => void }} opts
 */
export function attachLauncherDrag({ dock, installationId, origin, onMove }) {
  /** @type {{ side: 'left' | 'right', top: number } | null} */
  let docked = loadDockPosition(installationId, origin);
  /** Free position while the pointer is dragging. */
  let free = null;
  let drag = null;
  let suppressClick = false;
  let snapTimer = 0;

  const viewport = readVisibleViewport;
  // Layout box size (ignores a host-page `transform: scale()` on the dock), so
  // it matches the left/top we write.
  const dockSize = () => {
    const rect = dock.getBoundingClientRect();
    return { width: dock.offsetWidth || rect.width, height: dock.offsetHeight || rect.height };
  };

  function apply() {
    const size = dockSize();
    const pos = free
      ? clampDockPosition(free, size, viewport())
      : (docked ? dockedToPosition(docked, size, viewport()) : null);
    // Keep the "+" button on the inner side (towards the screen centre).
    const side = free
      ? snapDockPosition(free, size, viewport()).side
      : (docked?.side || 'right');
    if (dock.dataset.side !== side) dock.dataset.side = side;
    if (pos) {
      // `important`: host pages may pin the launcher with their own
      // `!important` rules (e.g. a mobile media query); a user drag must win.
      dock.style.setProperty('left', `${pos.left}px`, 'important');
      dock.style.setProperty('top', `${pos.top}px`, 'important');
      dock.style.setProperty('right', 'auto', 'important');
      dock.style.setProperty('bottom', 'auto', 'important');
    } else {
      for (const prop of ['left', 'top', 'right', 'bottom']) dock.style.removeProperty(prop);
    }
    onMove?.();
  }

  // Host page CSS can override the stylesheet, so pin touch-action inline.
  dock.style.touchAction = 'none';
  // Some mobile browsers still start a vertical page scroll (and fire
  // pointercancel) despite touch-action; block it while a finger is on the dock.
  // Only touchmove is cancelled, so taps still produce clicks.
  dock.addEventListener('touchmove', (event) => {
    if (drag && event.cancelable) event.preventDefault();
  }, { passive: false });

  dock.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Start from the resolved left/top of the layout box rather than the
    // (possibly transformed) visual rect, so the dock does not jump.
    const computed = getComputedStyle(dock);
    const rect = dock.getBoundingClientRect();
    const computedLeft = parseFloat(computed.left);
    const computedTop = parseFloat(computed.top);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: Number.isFinite(computedLeft) ? computedLeft : rect.left,
      originTop: Number.isFinite(computedTop) ? computedTop : rect.top,
      active: false,
    };
  });

  dock.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      clearTimeout(snapTimer);
      dock.classList.remove('is-snapping');
      dock.classList.add('is-dragging');
      try { dock.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
    }
    event.preventDefault();
    free = { left: drag.originLeft + dx, top: drag.originTop + dy };
    apply();
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasActive = drag.active;
    drag = null;
    dock.classList.remove('is-dragging');
    if (!wasActive || !free) return;
    suppressClick = true;
    // Clear the flag if no click follows (e.g. pointercancel on touch).
    setTimeout(() => { suppressClick = false; }, 0);
    docked = snapDockPosition(free, dockSize(), viewport());
    free = null;
    dock.classList.add('is-snapping');
    apply();
    // Re-anchor the panel once the snap transition has settled.
    snapTimer = setTimeout(() => {
      dock.classList.remove('is-snapping');
      onMove?.();
    }, 220);
    saveDockPosition(installationId, origin, docked);
  }
  dock.addEventListener('pointerup', endDrag);
  dock.addEventListener('pointercancel', endDrag);

  // Capture phase: runs before the button click handlers.
  dock.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('resize', apply);
  // Panning a zoomed page moves the visible area; keep the dock inside it.
  window.visualViewport?.addEventListener('scroll', () => { if (!drag?.active) apply(); });
  // The launcher label can change width (linked chat title); stay on the edge.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (!drag?.active) apply(); }).observe(dock);
  }
  apply();

  return {
    /** True once the user placed the dock somewhere other than the default corner. */
    isCustom: () => docked !== null || free !== null,
    /** Visible viewport used for clamping; the panel anchor should use it too. */
    viewport,
  };
}
