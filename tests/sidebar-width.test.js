import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '../app_front/features/sidebar/sidebarWidth.js';

test('clamps below the minimum up to 220px on a typical phone', () => {
  const actual = clampSidebarWidth(100, 390);
  assert.equal(actual, SIDEBAR_MIN_WIDTH);
});

test('caps near the viewport so a close sliver remains on a phone', () => {
  const actual = clampSidebarWidth(9999, 390);
  assert.equal(actual, 358);
});

test('keeps a mid-range width unchanged on desktop', () => {
  const actual = clampSidebarWidth(400, 1200);
  assert.equal(actual, 400);
});

test('caps a huge width to 96vw on desktop', () => {
  const actual = clampSidebarWidth(9999, 1200);
  assert.equal(actual, 1152);
});

test('lowers the minimum when the viewport is narrower than 220px plus the gap', () => {
  assert.equal(clampSidebarWidth(100, 200), 168);
  assert.equal(clampSidebarWidth(999, 200), 168);
});

test('non-finite values fall back to the minimum', () => {
  assert.equal(clampSidebarWidth(Number.NaN, 390), SIDEBAR_MIN_WIDTH);
});
