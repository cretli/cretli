/** Drawer chrome: open/pin state, dock layout, width persistence, menu and resizer wiring. */

import { t } from '../../../i18n/index.js';
import { isSidebarDocked } from '../sidebarDock.js';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_RESIZE_STEP, clampSidebarWidth } from '../sidebarWidth.js';
import { writeOpenFlag, writePinFlag, readSidebarWidth, writeSidebarWidth as persistSidebarWidth } from '../state/sidebarPersistence.js';

function getViewportWidth() {
  return typeof window !== 'undefined' ? window.innerWidth : 0;
}

function clampToViewport(value) {
  return clampSidebarWidth(value, getViewportWidth());
}

function writeSidebarWidth(value) {
  persistSidebarWidth(value, clampToViewport);
}

function applySidebarWidth() {
  const aside = document.getElementById('app-sidebar');
  if (!aside) return;
  const saved = readSidebarWidth();
  if (saved > 0) {
    aside.style.setProperty('--sidebar-width', `${clampToViewport(saved)}px`);
  } else {
    aside.style.removeProperty('--sidebar-width');
  }
  const resizer = document.getElementById('sidebar-resizer');
  if (!resizer) return;
  const vw = getViewportWidth();
  const rendered = Math.round(aside.getBoundingClientRect().width) || clampToViewport(saved);
  resizer.setAttribute('aria-valuemin', String(clampSidebarWidth(0, vw)));
  resizer.setAttribute('aria-valuemax', String(clampSidebarWidth(Number.MAX_SAFE_INTEGER, vw)));
  resizer.setAttribute('aria-valuenow', String(rendered));
}

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarChrome(ctx) {
  const { refreshStates, isMobileViewport, state } = ctx;
  const patchTransientVisualStates = (...args) => ctx.patchTransientVisualStates(...args);
  const forceRerender = (...args) => ctx.forceRerender(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const isSearchFocused = (...args) => ctx.isSearchFocused(...args);
  const setSearchQuery = (...args) => ctx.setSearchQuery(...args);

  function getContainer() {
    return document.getElementById('app-sidebar');
  }

  function getBackdrop() {
    return document.getElementById('app-sidebar-backdrop');
  }

  function applyPinButton() {
    const btn = document.getElementById('sidebar-pin-btn');
    if (!btn) return;
    const label = state.pinned ? t('sidebar.unpin') : t('sidebar.pin');
    btn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('is-active', state.pinned);
    const icon = btn.querySelector('.mdi');
    if (!icon) return;
    icon.classList.toggle('mdi-pin', state.pinned);
    icon.classList.toggle('mdi-pin-outline', !state.pinned);
  }

  function applyDockLayout() {
    const docked = isSidebarDocked({
      pinned: state.pinned,
      open: state.open,
      isMobile: isMobileViewport(),
    });
    document.body?.classList.toggle('sidebar-docked', docked);
    const root = document.documentElement;
    if (!root) return;
    if (!docked) {
      root.style.setProperty('--sidebar-dock-width', '0px');
      return;
    }
    const aside = getContainer();
    const measured = aside ? Math.round(aside.getBoundingClientRect().width) : 0;
    const width = measured > 0 ? measured : clampToViewport(readSidebarWidth());
    root.style.setProperty('--sidebar-dock-width', `${width}px`);
  }

  function applyVisibility() {
    if (state.swipe.isSwiping()) return;
    const aside = getContainer();
    const backdrop = getBackdrop();
    if (aside) aside.hidden = !state.open;
    if (backdrop) backdrop.hidden = !state.open || !isMobileViewport();
    document.body?.classList.toggle('sidebar-open', state.open);
    const menuBtn = document.getElementById('header-menu-btn');
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      menuBtn.classList.toggle('is-active', state.open);
    }
    applyPinButton();
    applyEdgeOpenHandle();
    if (state.open) applySidebarWidth();
    applyDockLayout();
  }

  function applyEdgeOpenHandle() {
    const edge = document.getElementById('sidebar-edge-open');
    if (!edge) return;
    edge.hidden = state.open || !isMobileViewport();
  }

  function revealDrawerPreview() {
    const aside = getContainer();
    const backdrop = getBackdrop();
    if (aside) aside.hidden = false;
    if (backdrop) backdrop.hidden = false;
    applySidebarWidth();
  }

  function hideDrawerPreview() {
    if (state.open) return;
    applyVisibility();
  }

  function togglePin() {
    state.pinned = !state.pinned;
    writePinFlag(state.pinned);
    if (state.pinned && !state.open) {
      state.open = true;
      writeOpenFlag(true);
    }
    applyVisibility();
  }

  function openSidebar() {
    state.open = true;
    writeOpenFlag(true);
    applyVisibility();
    // The drawer may have been hidden while the active chat changed. The queued
    // render then skipped the transient patch (the aside was hidden), so repaint
    // the active row / group summaries now that the aside is visible again.
    patchTransientVisualStates();
    refreshStates();
  }

  function closeSidebar() {
    state.swipe.abort();
    state.open = false;
    writeOpenFlag(false);
    applyVisibility();
  }

  function toggleSidebar() {
    if (state.open) closeSidebar();
    else openSidebar();
  }

  function initMenuButton() {
    const menuBtn = document.getElementById('header-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', toggleSidebar);
      menuBtn.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleSidebar();
      });
    }
    const pinBtn = document.getElementById('sidebar-pin-btn');
    if (pinBtn) pinBtn.addEventListener('click', togglePin);
    const closeBtn = document.getElementById('sidebar-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    const backdrop = getBackdrop();
    if (backdrop) backdrop.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !state.open) return;
      const blockingModal = document.querySelector('.chat-settings-modal:not([hidden])');
      if (blockingModal) return;
      if (isSearchFocused() && isSearchActive()) {
        e.preventDefault();
        setSearchQuery('');
        forceRerender();
        return;
      }
      closeSidebar();
    });
  }

  function initResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const aside = getContainer();
    if (!resizer || !aside || typeof PointerEvent === 'undefined') return;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const applyWidth = (width) => {
      const clamped = clampToViewport(width);
      aside.style.setProperty('--sidebar-width', `${clamped}px`);
      return clamped;
    };

    const syncAria = (width) => {
      const vw = getViewportWidth();
      resizer.setAttribute('aria-valuemin', String(clampSidebarWidth(0, vw)));
      resizer.setAttribute('aria-valuemax', String(clampSidebarWidth(Number.MAX_SAFE_INTEGER, vw)));
      resizer.setAttribute('aria-valuenow', String(clampToViewport(width)));
    };

    const onPointerDown = (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      dragging = true;
      startX = ev.clientX;
      startWidth = aside.getBoundingClientRect().width;
      document.body.classList.add('sidebar-resizing');
      resizer.classList.add('is-active');
      resizer.setPointerCapture?.(ev.pointerId);
    };

    const onPointerMove = (ev) => {
      if (!dragging) return;
      // Right-edge handle: dragging right grows the left-anchored drawer.
      const next = applyWidth(startWidth + (ev.clientX - startX));
      syncAria(next);
      applyDockLayout();
    };

    const onPointerEnd = (ev) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('sidebar-resizing');
      resizer.classList.remove('is-active');
      if (resizer.hasPointerCapture?.(ev.pointerId)) {
        resizer.releasePointerCapture(ev.pointerId);
      }
      const finalWidth = parseFloat(aside.style.getPropertyValue('--sidebar-width'));
      if (!Number.isFinite(finalWidth) || finalWidth <= 0) return;
      syncAria(finalWidth);
      writeSidebarWidth(finalWidth);
      applyDockLayout();
    };

    const onKeyDown = (ev) => {
      const base = aside.getBoundingClientRect().width || SIDEBAR_MIN_WIDTH;
      let next;
      if (ev.key === 'ArrowRight') next = base + SIDEBAR_RESIZE_STEP;
      else if (ev.key === 'ArrowLeft') next = base - SIDEBAR_RESIZE_STEP;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = Number.MAX_SAFE_INTEGER;
      else return;
      ev.preventDefault();
      const applied = applyWidth(next);
      syncAria(applied);
      writeSidebarWidth(applied);
      applyDockLayout();
    };

    resizer.addEventListener('pointerdown', onPointerDown);
    resizer.addEventListener('pointermove', onPointerMove);
    resizer.addEventListener('pointerup', onPointerEnd);
    resizer.addEventListener('pointercancel', onPointerEnd);
    resizer.addEventListener('keydown', onKeyDown);
    syncAria(aside.getBoundingClientRect().width);
  }

  return { getContainer, getBackdrop, applyPinButton, applyDockLayout, applyVisibility, applyEdgeOpenHandle, revealDrawerPreview, hideDrawerPreview, togglePin, openSidebar, closeSidebar, toggleSidebar, initMenuButton, initResizer, getViewportWidth, clampToViewport, writeSidebarWidth, applySidebarWidth };
}
