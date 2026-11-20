import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampDockPosition,
  computePanelAnchor,
  dockedToPosition,
  snapDockPosition,
} from '../app_front/embed/widgetLauncherDrag.js';

const phone = { width: 400, height: 800 };
const desktop = { width: 1600, height: 900 };

test('clampDockPosition keeps the dock inside the viewport', () => {
  const size = { width: 140, height: 40 };
  assert.deepEqual(clampDockPosition({ left: -50, top: -10 }, size, phone), { left: 8, top: 8 });
  assert.deepEqual(clampDockPosition({ left: 900, top: 2000 }, size, phone), { left: 252, top: 752 });
  assert.deepEqual(clampDockPosition({ left: 100.4, top: 300.6 }, size, phone), { left: 100, top: 301 });
});

test('computePanelAnchor opens below a dock near the top, aligned right', () => {
  const anchor = computePanelAnchor({ left: 250, top: 100, width: 140, height: 40 }, phone);
  assert.equal(anchor.top, 148);
  assert.equal(anchor.width, 376);
  // Right edge of the panel lines up with the right edge of the dock.
  assert.equal(anchor.left + anchor.width, 390);
  assert.ok(anchor.top + anchor.height <= phone.height - 8);
});

test('computePanelAnchor opens above a dock near the bottom, aligned left', () => {
  const dock = { left: 20, top: 840, width: 140, height: 40 };
  const anchor = computePanelAnchor(dock, desktop);
  assert.equal(anchor.left, 20);
  assert.equal(anchor.width, 420);
  assert.equal(anchor.height, 640);
  assert.equal(anchor.top + anchor.height, dock.top - 8);
});

test('snapDockPosition docks to the nearer side and keeps the height', () => {
  const size = { width: 140, height: 40 };
  assert.deepEqual(snapDockPosition({ left: 30, top: 300 }, size, phone), { side: 'left', top: 300 });
  assert.deepEqual(snapDockPosition({ left: 200, top: 300 }, size, phone), { side: 'right', top: 300 });
  assert.deepEqual(snapDockPosition({ left: 200, top: 5000 }, size, phone), { side: 'right', top: 752 });
});

test('dockedToPosition pins the dock to its edge for the current viewport', () => {
  const size = { width: 140, height: 40 };
  assert.deepEqual(dockedToPosition({ side: 'left', top: 300 }, size, phone), { left: 8, top: 300 });
  assert.deepEqual(dockedToPosition({ side: 'right', top: 300 }, size, phone), { left: 252, top: 300 });
  // Rotating to landscape keeps the right side docked and clamps the height.
  assert.deepEqual(dockedToPosition({ side: 'right', top: 700 }, size, { width: 800, height: 400 }), { left: 652, top: 352 });
});

test('zoomed/panned viewport: the dock can reach the bottom of the visible area', () => {
  const size = { width: 140, height: 40 };
  // Visible area starts 300px down and 100px right in fixed coordinates.
  const vp = { left: 100, top: 300, width: 400, height: 800 };
  assert.deepEqual(clampDockPosition({ left: 0, top: 5000 }, size, vp), { left: 108, top: 1052 });
  const snapped = snapDockPosition({ left: 400, top: 900 }, size, vp);
  assert.deepEqual(snapped, { side: 'right', top: 600 });
  assert.deepEqual(dockedToPosition(snapped, size, vp), { left: 352, top: 900 });
});
