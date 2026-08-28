import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDropdownNextIndex } from '../app_front/lib/dropdown.js';

test('arrows move through options and wrap around', () => {
  assert.equal(resolveDropdownNextIndex('ArrowDown', 0, 3), 1);
  assert.equal(resolveDropdownNextIndex('ArrowDown', 2, 3), 0);
  assert.equal(resolveDropdownNextIndex('ArrowUp', 1, 3), 0);
  assert.equal(resolveDropdownNextIndex('ArrowUp', 0, 3), 2);
});

test('from a search field (index -1) the arrows enter the list at either end', () => {
  assert.equal(resolveDropdownNextIndex('ArrowDown', -1, 3), 0, 'first option');
  assert.equal(resolveDropdownNextIndex('ArrowUp', -1, 3), 2, 'last option');
});

test('Home and End jump to the boundaries', () => {
  assert.equal(resolveDropdownNextIndex('Home', 2, 3), 0);
  assert.equal(resolveDropdownNextIndex('End', 0, 3), 2);
});

test('other keys are ignored so typing and Escape keep working', () => {
  for (const key of ['Enter', ' ', 'Escape', 'Tab', 'a', 'ArrowLeft']) {
    assert.equal(resolveDropdownNextIndex(key, 0, 3), null, `key ${key}`);
  }
});

test('an empty list never returns an index', () => {
  assert.equal(resolveDropdownNextIndex('ArrowDown', -1, 0), null);
  assert.equal(resolveDropdownNextIndex('Home', -1, 0), null);
});
