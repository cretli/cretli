import assert from 'node:assert/strict';
import test from 'node:test';
import * as sidebarSwipe from '../app_front/features/sidebar/sidebarSwipe.js';
import {
  SWIPE_CLOSE_RATIO,
  SWIPE_CLOSE_VELOCITY_PX_MS,
  canStartEdgeOpen,
  canStartSwipe,
  shouldCloseSwipe,
  shouldOpenSwipe,
} from '../app_front/features/sidebar/sidebarSwipe.js';

// Namespace access so a symbol the module does not export yet resolves to
// `undefined` at call time (a per-case failure) instead of a link-time
// SyntaxError that would take the whole suite down pre-fix.
const { initSidebarSwipe } = sidebarSwipe;
const SUPPRESS_CLICK_MS = sidebarSwipe.SUPPRESS_CLICK_MS ?? 350;

const inputMobile = {
  isMobile: true,
  isResizing: false,
  isChatDragging: false,
  isWorkspaceDragging: false,
  target: null,
};

test('canStartSwipe rejects a desktop viewport', () => {
  const actual = canStartSwipe({ ...inputMobile, isMobile: false });
  assert.equal(actual, false);
});

test('canStartSwipe rejects sidebar-resizing', () => {
  const actual = canStartSwipe({ ...inputMobile, isResizing: true });
  assert.equal(actual, false);
});

test('canStartSwipe rejects a pointer on #sidebar-resizer', () => {
  const inputTarget = {
    closest: (selector) => (selector === '#sidebar-resizer' ? {} : null),
  };
  const actual = canStartSwipe({ ...inputMobile, target: inputTarget });
  assert.equal(actual, false);
});

test('canStartSwipe rejects an active chat drag', () => {
  const actual = canStartSwipe({ ...inputMobile, isChatDragging: true });
  assert.equal(actual, false);
});

test('canStartSwipe rejects an active workspace drag', () => {
  const actual = canStartSwipe({ ...inputMobile, isWorkspaceDragging: true });
  assert.equal(actual, false);
});

test('canStartSwipe allows a mobile overlay away from the resizer', () => {
  const inputTarget = { closest: () => null };
  const actual = canStartSwipe({ ...inputMobile, target: inputTarget });
  assert.equal(actual, true);
});

test('shouldCloseSwipe rejects a rightward swipe', () => {
  const actual = shouldCloseSwipe({
    deltaX: 200,
    width: 320,
    velocityX: SWIPE_CLOSE_VELOCITY_PX_MS + 0.2,
  });
  assert.equal(actual, false);
});

test('shouldCloseSwipe rejects a short left swipe without a flick', () => {
  const actual = shouldCloseSwipe({
    deltaX: -(SWIPE_CLOSE_RATIO * 320 - 8),
    width: 320,
    velocityX: 0,
  });
  assert.equal(actual, false);
});

test('shouldCloseSwipe accepts a left swipe past the distance threshold', () => {
  const actual = shouldCloseSwipe({
    deltaX: -(SWIPE_CLOSE_RATIO * 320 + 1),
    width: 320,
    velocityX: 0,
  });
  assert.equal(actual, true);
});

test('shouldCloseSwipe accepts a left flick below the distance threshold', () => {
  const actual = shouldCloseSwipe({
    deltaX: -12,
    width: 320,
    velocityX: -(SWIPE_CLOSE_VELOCITY_PX_MS + 0.1),
  });
  assert.equal(actual, true);
});

test('shouldCloseSwipe ignores a rightward velocity on a short left drag', () => {
  const actual = shouldCloseSwipe({
    deltaX: -12,
    width: 320,
    velocityX: SWIPE_CLOSE_VELOCITY_PX_MS + 0.1,
  });
  assert.equal(actual, false);
});

test('canStartEdgeOpen rejects desktop, an open drawer, and resize', () => {
  const inputOpen = { isMobile: true, isOpen: false, isResizing: false };
  assert.equal(canStartEdgeOpen(inputOpen), true);
  assert.equal(canStartEdgeOpen({ ...inputOpen, isMobile: false }), false);
  assert.equal(canStartEdgeOpen({ ...inputOpen, isOpen: true }), false);
  assert.equal(canStartEdgeOpen({ ...inputOpen, isResizing: true }), false);
});

test('shouldOpenSwipe rejects a leftward swipe', () => {
  const actual = shouldOpenSwipe({
    deltaX: -200,
    width: 320,
    velocityX: -(SWIPE_CLOSE_VELOCITY_PX_MS + 0.2),
  });
  assert.equal(actual, false);
});

test('shouldOpenSwipe accepts a right swipe past the distance threshold', () => {
  const actual = shouldOpenSwipe({
    deltaX: SWIPE_CLOSE_RATIO * 320 + 1,
    width: 320,
    velocityX: 0,
  });
  assert.equal(actual, true);
});

test('shouldOpenSwipe accepts a right flick below the distance threshold', () => {
  const actual = shouldOpenSwipe({
    deltaX: 12,
    width: 320,
    velocityX: SWIPE_CLOSE_VELOCITY_PX_MS + 0.1,
  });
  assert.equal(actual, true);
});

/**
 * A hand-rolled DOM/pointer harness (no jsdom in this suite) that installs the
 * globals `initSidebarSwipe` probes for, wires a fixed clock, and lets a test
 * drive the exact event sequence a finger produces on a phone.
 */
function mockElement() {
  const handlers = {};
  const el = {
    addEventListener(type, fn) {
      (handlers[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = handlers[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, ev) {
      (handlers[type] || []).slice().forEach((fn) => fn(ev));
    },
    style: {
      removeProperty() {},
      setProperty() {},
    },
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle() {},
      contains(c) { return this._set.has(c); },
    },
    offsetWidth: 320,
    getBoundingClientRect: () => ({ width: 320 }),
    closest: () => null,
  };
  return el;
}

function pointerEvent(extra) {
  return Object.assign(
    {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 0,
      clientY: 0,
      timeStamp: 0,
      target: null,
      defaultPrevented: false,
      stoppedImmediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stoppedImmediate = true; },
      stopPropagation() {},
    },
    extra
  );
}

function createSwipeHarness({ clockRef, deferTimers = false, onClose } = {}) {
  const sidebar = mockElement();
  const backdrop = mockElement();
  const edge = mockElement();
  const winHandlers = {};
  const docHandlers = {};
  const timers = [];
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    PointerEvent: globalThis.PointerEvent,
  };
  globalThis.window = {
    addEventListener(type, fn) { (winHandlers[type] ||= []).push(fn); },
    removeEventListener() {},
    // The settle uses window.setTimeout(finish, SWIPE_SETTLE_MS). By default it
    // runs synchronously so gesture completion is deterministic; `deferTimers`
    // keeps it pending so a test can observe the in-flight `settling` phase.
    setTimeout(cb) {
      if (deferTimers) {
        timers.push(cb);
        return timers.length;
      }
      cb();
      return 0;
    },
    clearTimeout() {},
  };
  globalThis.document = {
    body: mockElement(),
    hidden: false,
    addEventListener(type, fn) { (docHandlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const arr = docHandlers[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  globalThis.PointerEvent = function PointerEvent() {};
  const api = initSidebarSwipe({
    getSidebar: () => sidebar,
    getBackdrop: () => backdrop,
    getEdgeOpen: () => edge,
    isOpen: () => true,
    isMobile: () => true,
    isResizing: () => false,
    isChatDragging: () => false,
    isWorkspaceDragging: () => false,
    onClose: typeof onClose === 'function' ? onClose : () => {},
    now: () => clockRef.value,
  });
  return {
    api,
    sidebar,
    backdrop,
    flushTimers() {
      const pending = timers.splice(0);
      pending.forEach((cb) => cb());
    },
    winDispatch(type, ev) {
      (winHandlers[type] || []).slice().forEach((fn) => fn(ev));
    },
    docDispatch(type, ev) {
      (docHandlers[type] || []).slice().forEach((fn) => fn(ev));
    },
    setDocumentHidden(value) {
      globalThis.document.hidden = value;
    },
    restore() {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.PointerEvent = saved.PointerEvent;
    },
  };
}

/**
 * Drive a left swipe that releases short of the commit threshold, so it settles
 * back open (snap-back). Returns the harness for follow-up assertions.
 */
function runSnapBack(clockRef) {
  const h = createSwipeHarness({ clockRef });
  h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
  h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 262, clientY: 12, timeStamp: 20 }));
  h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 252, clientY: 12, timeStamp: 30 }));
  h.winDispatch('pointerup', pointerEvent({ clientX: 252, clientY: 12, timeStamp: 200 }));
  return h;
}

test('a bare pointerdown (pending) does not report as swiping', () => {
  const clockRef = { value: 1000 };
  const h = createSwipeHarness({ clockRef });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    assert.equal(h.api.isSwiping(), false, 'pending must not block applyVisibility()/render()');
  } finally {
    h.restore();
  }
});

test('a committed swipe (tracking) does report as swiping', () => {
  const clockRef = { value: 1000 };
  const h = createSwipeHarness({ clockRef });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 262, clientY: 12, timeStamp: 20 }));
    assert.equal(h.api.isSwiping(), true);
  } finally {
    h.restore();
  }
});

test('a click within the suppress window right after a gesture is swallowed', () => {
  const clockRef = { value: 1000 };
  const h = runSnapBack(clockRef);
  try {
    const click = pointerEvent({ target: h.backdrop });
    h.backdrop.dispatch('click', click);
    assert.equal(click.defaultPrevented, true, 'the synthetic click that belongs to the gesture is eaten');
  } finally {
    h.restore();
  }
});

test('a click after the suppress window expires is NOT swallowed', () => {
  const clockRef = { value: 1000 };
  const h = runSnapBack(clockRef);
  try {
    // Advance the clock past the ~350 ms window measured from the gesture end.
    clockRef.value = 1000 + SUPPRESS_CLICK_MS + 50;
    const click = pointerEvent({ target: h.backdrop });
    h.backdrop.dispatch('click', click);
    assert.equal(click.defaultPrevented, false, 'the first real tap after a swipe must reach the handler');
  } finally {
    h.restore();
  }
});

test('a fresh pointerdown clears the pending suppress window', () => {
  const clockRef = { value: 1000 };
  const h = runSnapBack(clockRef);
  try {
    // Still inside the window, but the user presses down again to tap.
    clockRef.value = 1000 + 50;
    h.winDispatch('pointerdown', pointerEvent({ target: h.backdrop, clientX: 5, clientY: 5 }));
    const click = pointerEvent({ target: h.backdrop });
    h.backdrop.dispatch('click', click);
    assert.equal(click.defaultPrevented, false, 'a new interaction owns its own click');
  } finally {
    h.restore();
  }
});

test('window blur aborts a stuck tracking gesture', () => {
  const clockRef = { value: 1000 };
  const h = createSwipeHarness({ clockRef });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 262, clientY: 12, timeStamp: 20 }));
    assert.equal(h.api.isSwiping(), true);
    // A dropped pointerup would otherwise leave `gesture` set forever.
    h.winDispatch('blur', pointerEvent({}));
    assert.equal(h.api.isSwiping(), false, 'lost focus must clear the gesture');
  } finally {
    h.restore();
  }
});

test('lostpointercapture aborts a stuck tracking gesture', () => {
  const clockRef = { value: 1000 };
  const h = createSwipeHarness({ clockRef });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 262, clientY: 12, timeStamp: 20 }));
    h.winDispatch('lostpointercapture', pointerEvent({}));
    assert.equal(h.api.isSwiping(), false, 'a lost pointer capture must not leave the drawer swiping');
  } finally {
    h.restore();
  }
});

test('an implicit lostpointercapture after pointerup does not cancel the committed close', () => {
  const clockRef = { value: 1000 };
  let closes = 0;
  const h = createSwipeHarness({ clockRef, deferTimers: true, onClose: () => { closes += 1; } });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    // Past the 40% commit threshold on a 320px drawer.
    h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 150, clientY: 12, timeStamp: 20 }));
    h.winDispatch('pointerup', pointerEvent({ clientX: 150, clientY: 12, timeStamp: 200 }));
    // Touch/pen release implicit pointer capture right after pointerup, i.e.
    // while the drawer is settling. That must not be treated as a lost pointer.
    h.winDispatch('lostpointercapture', pointerEvent({ pointerId: 1 }));
    assert.equal(h.api.isSwiping(), true, 'the settle must survive the implicit capture release');
    h.flushTimers();
    assert.equal(closes, 1, 'the close the user released must stick instead of snapping back');
    assert.equal(h.api.isSwiping(), false);
  } finally {
    h.restore();
  }
});

test('a hidden document aborts a stuck tracking gesture', () => {
  const clockRef = { value: 1000 };
  const h = createSwipeHarness({ clockRef });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    h.winDispatch('pointermove', pointerEvent({ target: h.sidebar, clientX: 262, clientY: 12, timeStamp: 20 }));
    h.setDocumentHidden(true);
    h.docDispatch('visibilitychange', pointerEvent({}));
    assert.equal(h.api.isSwiping(), false, 'tab switch must not leave the drawer swiping');
  } finally {
    h.restore();
  }
});

test('a bare tap (pointerdown + pointerup, no move) does not eat the next click', () => {
  const clockRef = { value: 1000 };
  const h = createSwipeHarness({ clockRef });
  try {
    h.sidebar.dispatch('pointerdown', pointerEvent({ target: h.sidebar, clientX: 300, clientY: 12, timeStamp: 0 }));
    // No pointermove: this is the tap that most often hits the close button.
    h.winDispatch('pointerup', pointerEvent({ clientX: 300, clientY: 12, timeStamp: 30 }));
    assert.equal(h.api.isSwiping(), false, 'a pending tap never counts as swiping');
    const click = pointerEvent({ target: h.sidebar });
    h.sidebar.dispatch('click', click);
    assert.equal(click.defaultPrevented, false, 'the tap click must reach the close button');
  } finally {
    h.restore();
  }
});
