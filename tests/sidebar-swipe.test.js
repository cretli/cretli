import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SWIPE_CLOSE_RATIO,
  SWIPE_CLOSE_VELOCITY_PX_MS,
  canStartEdgeOpen,
  canStartSwipe,
  shouldCloseSwipe,
  shouldOpenSwipe,
} from '../app_front/features/sidebar/sidebarSwipe.js';

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
