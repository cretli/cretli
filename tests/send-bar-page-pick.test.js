import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPagePickMenuVisibility } from '../app_front/features/sendBar/sendBarPagePickMenu.js';

function createMenuItem() {
  const classSet = new Set(['chat-list-item', 'send-keys-screenshot-menu-item']);
  const attrs = {};
  const label = { textContent: 'Pick page element (widget only)' };
  const item = {
    hidden: false,
    classList: {
      contains: (name) => classSet.has(name),
      toggle: (name, force) => {
        if (force) classSet.add(name);
        else classSet.delete(name);
      },
    },
    setAttribute: (name, value) => {
      attrs[name] = String(value);
    },
    getAttribute: (name) => attrs[name],
    querySelector: () => label,
  };
  return { item, label, classSet };
}

test('page-pick row stays hidden outside the widget', () => {
  const { item, label, classSet } = createMenuItem();
  applyPagePickMenuVisibility({
    item,
    label,
    enabled: false,
    enabledLabel: 'Pick page element',
  });
  assert.equal(item.hidden, true);
  assert.equal(classSet.has('is-hidden'), true);
  assert.equal(item.getAttribute('aria-disabled'), 'true');
  assert.equal(label.textContent, 'Pick page element');
});

test('page-pick row is shown when the host picker is available', () => {
  const { item, label, classSet } = createMenuItem();
  applyPagePickMenuVisibility({
    item,
    label,
    enabled: true,
    enabledLabel: 'Pick page element',
  });
  assert.equal(item.hidden, false);
  assert.equal(classSet.has('is-hidden'), false);
  assert.equal(item.getAttribute('aria-disabled'), 'false');
  assert.equal(label.textContent, 'Pick page element');
});
