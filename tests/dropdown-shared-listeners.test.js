import test from 'node:test';
import assert from 'node:assert/strict';

function makeTarget() {
  const map = new Map();
  return {
    map,
    addEventListener(t, fn) { (map.get(t) || map.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { map.get(t)?.delete(fn); },
    count: (t) => map.get(t)?.size || 0,
    fire(t, ev) { for (const fn of [...(map.get(t) || [])]) fn(ev); },
  };
}

test('N dropdowns share one document keydown/click listener; Escape and outside click close', async () => {
  const doc = makeTarget();
  globalThis.document = doc;
  globalThis.Node = class {};
  globalThis.window = { innerWidth: 1000 };
  globalThis.Element = class {};
  globalThis.window = {
    innerWidth: 1000,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({}),
    Element: globalThis.Element,
    HTMLElement: class {},
    Node: globalThis.Node,
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.requestAnimationFrame = (f) => f();
  const { initDropdown } = await import('../app_front/lib/dropdown.js');
  const mkEl = () => Object.assign(makeTarget(), {
    hidden: true,
    style: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    contains: () => false,
    querySelectorAll: () => [],
  });
  const apis = [];
  for (let i = 0; i < 5; i += 1) apis.push(initDropdown({ triggerEl: mkEl(), floatingEl: mkEl() }));
  assert.equal(doc.count('keydown'), 1);
  assert.equal(doc.count('click'), 1);

  apis[1].open();
  apis[1].isOpen();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(apis[1].isOpen(), false);

  apis[2].open();
  const outside = new globalThis.Node();
  doc.fire('click', { target: outside });
  assert.equal(apis[2].isOpen(), false);

  for (const a of apis) a.destroy();
  assert.equal(doc.count('keydown'), 0);
  assert.equal(doc.count('click'), 0);
});
