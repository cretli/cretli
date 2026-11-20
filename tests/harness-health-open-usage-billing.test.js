import test from 'node:test';
import assert from 'node:assert/strict';
import { openUsageBilling } from '../app_front/features/harness-health/openUsageBilling.js';

function mockDoc() {
  const calls = { tabClicks: 0, scroll: [] };
  const billing = { scrollIntoView: (opts) => calls.scroll.push(opts) };
  const tab = { click: () => { calls.tabClicks += 1; } };
  const doc = {
    querySelector: (sel) => (sel.includes('data-settings-tab="usage"') ? tab : null),
    getElementById: (id) => (id === 'usage-billing' ? billing : null),
  };
  return { doc, calls };
}

test('opens the Usage tab, then scrolls #usage-billing to the start', () => {
  const { doc, calls } = mockDoc();
  const order = [];
  openUsageBilling({
    doc,
    matchMedia: () => ({ matches: false }),
    defer: (fn) => { order.push(`defer:${calls.tabClicks}`); fn(); },
  });
  assert.equal(calls.tabClicks, 1);
  assert.deepEqual(order, ['defer:1']);
  assert.deepEqual(calls.scroll, [{ block: 'start', behavior: 'smooth' }]);
});

test('prefers-reduced-motion uses behavior auto', () => {
  const { doc, calls } = mockDoc();
  openUsageBilling({ doc, matchMedia: () => ({ matches: true }), defer: (fn) => fn() });
  assert.deepEqual(calls.scroll, [{ block: 'start', behavior: 'auto' }]);
});

test('missing billing element does not throw', () => {
  const { doc } = mockDoc();
  doc.getElementById = () => null;
  assert.doesNotThrow(() => openUsageBilling({ doc, defer: (fn) => fn() }));
});

test('waits until the panel is laid out before scrolling', () => {
  const { doc, calls } = mockDoc();
  const billing = doc.getElementById('usage-billing');
  let frame = 0;
  billing.getClientRects = () => (frame >= 4 ? [{}] : []);
  const queue = [];
  openUsageBilling({ doc, matchMedia: () => ({ matches: false }), defer: (fn) => queue.push(fn) });
  while (queue.length) {
    assert.equal(calls.scroll.length, 0, 'no scroll before the panel is visible');
    frame += 1;
    queue.shift()();
    if (frame < 4) assert.equal(calls.scroll.length, 0);
  }
  assert.deepEqual(calls.scroll, [{ block: 'start', behavior: 'smooth' }]);
});

test('gives up silently after a bounded number of frames without scrolling', () => {
  const { doc, calls } = mockDoc();
  doc.getElementById('usage-billing').getClientRects = () => [];
  let frames = 0;
  const queue = [];
  openUsageBilling({ doc, defer: (fn) => queue.push(fn) });
  while (queue.length && frames < 1000) { frames += 1; queue.shift()(); }
  assert.ok(frames < 1000);
  assert.equal(calls.scroll.length, 0);
});

test('selects the Billing sub-view before opening the Usage tab', () => {
  const order = [];
  const doc = {
    querySelector: (sel) => {
      if (sel === '[data-usage-view-tab="billing"]') return { click: () => order.push('view') };
      if (sel.includes('data-settings-tab="usage"')) return { click: () => order.push('tab') };
      return null;
    },
    getElementById: () => null,
  };
  openUsageBilling({ doc, defer: () => {} });
  assert.deepEqual(order, ['view', 'tab']);
});
