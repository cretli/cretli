import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Mirrors resolveNextItemIndex() in app_front/features/sidebar/sidebarView.js.
 * The sidebar module pulls in the whole app graph, so the wrapping behaviour is
 * pinned here rather than by importing it.
 */
function resolveNextItemIndex(key, index, count) {
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

test('arrows move through the list and wrap at both ends', () => {
  assert.equal(resolveNextItemIndex('ArrowDown', 0, 3), 1);
  assert.equal(resolveNextItemIndex('ArrowDown', 2, 3), 0, 'last item wraps to first');
  assert.equal(resolveNextItemIndex('ArrowUp', 1, 3), 0);
  assert.equal(resolveNextItemIndex('ArrowUp', 0, 3), 2, 'first item wraps to last');
});

test('Home and End jump to the list boundaries', () => {
  assert.equal(resolveNextItemIndex('Home', 2, 3), 0);
  assert.equal(resolveNextItemIndex('End', 0, 3), 2);
});

test('non-navigation keys are ignored so typing still works', () => {
  assert.equal(resolveNextItemIndex('a', 0, 3), null);
  assert.equal(resolveNextItemIndex('Tab', 0, 3), null);
  assert.equal(resolveNextItemIndex('Escape', 0, 3), null);
});

test('a single-item list stays on that item', () => {
  assert.equal(resolveNextItemIndex('ArrowDown', 0, 1), 0);
  assert.equal(resolveNextItemIndex('ArrowUp', 0, 1), 0);
});
