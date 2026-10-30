import test from 'node:test';
import assert from 'node:assert/strict';
import { writeIfChanged } from '../app_front/lib/domWriteIfChanged.js';
import { patchSidebarChatRowVisualState } from '../app_front/features/sidebar/sidebarChatRowVisualPatch.js';
import { applySidebarChatStatusEl } from '../app_front/features/sidebar/sidebarChatStatus.js';
import { shouldReplaceChildren, syncChildren } from '../app_front/lib/childrenSync.js';
import { evaluateStickFromScroll } from '../app_front/lib/scrollStickGeometry.js';
import { measureSendBarReserve } from '../app_front/features/chat/chatSendBarLayout.js';

/** Element double that logs every write (attribute, className, textContent, hidden). */
function makeWriteSpyEl(initial = {}) {
  const writes = [];
  const attrs = new Map();
  const props = { className: '', textContent: '', hidden: false, innerHTML: '', ...initial };
  const el = {
    writes,
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute(n, v) { writes.push(['attr', n, v]); attrs.set(n, v); },
  };
  for (const k of Object.keys(props)) {
    Object.defineProperty(el, k, {
      get: () => props[k],
      set(v) { writes.push(['prop', k, v]); props[k] = v; },
    });
  }
  return el;
}

test('writeIfChanged skips identical property and attribute values', () => {
  const el = makeWriteSpyEl();
  assert.equal(writeIfChanged(el, 'className', 'a'), true);
  assert.equal(writeIfChanged(el, 'className', 'a'), false);
  assert.equal(writeIfChanged(el, 'title', 'x', true), true);
  assert.equal(writeIfChanged(el, 'title', 'x', true), false);
  assert.equal(writeIfChanged(el, 'textContent', 'hi'), true);
  assert.equal(writeIfChanged(el, 'textContent', 'hi'), false);
  assert.equal(el.writes.length, 3);
});

test('patchSidebarChatRowVisualState and status chip: same state writes nothing', () => {
  const indicator = makeWriteSpyEl();
  const awaiting = makeWriteSpyEl();
  const li = {
    dataset: {},
    classList: { toggle() {} },
    querySelector(sel) {
      if (sel === '.sidebar-chat-item-state') return indicator;
      if (sel === '.sidebar-chat-item-awaiting') return awaiting;
      return null;
    },
  };
  const ctx = {
    t: (k) => k,
    getSidebarChatStateMeta: () => ({ tone: 'active', label: 'run', activityKey: 'k' }),
  };
  patchSidebarChatRowVisualState(li, { id: 'c1' }, ctx);
  assert.ok(indicator.writes.length > 0);
  // The visualKey guard short-circuits; also clear it to prove the element
  // writes themselves are idempotent.
  indicator.writes.length = 0;
  awaiting.writes.length = 0;
  delete li.dataset.visualKey;
  patchSidebarChatRowVisualState(li, { id: 'c1' }, ctx);
  assert.deepEqual(indicator.writes, []);
  assert.deepEqual(awaiting.writes, []);
  // A changed state writes.
  const ctx2 = { ...ctx, getSidebarChatStateMeta: () => ({ tone: 'idle', label: 'idle' }) };
  patchSidebarChatRowVisualState(li, { id: 'c1' }, ctx2);
  assert.ok(indicator.writes.length > 0);
});

test('applySidebarChatStatusEl re-applying the same meta performs no writes', () => {
  const el = makeWriteSpyEl();
  const meta = { tone: 'waiting', label: 'w' };
  applySidebarChatStatusEl(el, meta, { title: 't' });
  el.writes.length = 0;
  assert.equal(applySidebarChatStatusEl(el, meta, { title: 't' }), false);
  assert.deepEqual(el.writes, []);
  applySidebarChatStatusEl(el, { tone: 'finished', label: 'f' }, { title: 't' });
  assert.ok(el.writes.length > 0);
});

test('syncChildren: same content does no DOM ops, changed content one replacement', () => {
  const ops = [];
  const host = {
    replaceChildren: (...n) => ops.push(['replace', n.length]),
    appendChild: () => ops.push(['append']),
    removeChild: () => ops.push(['remove']),
  };
  assert.equal(shouldReplaceChildren('a', 'a'), false);
  assert.equal(shouldReplaceChildren(undefined, 'a'), true);
  let built = 0;
  const build = () => { built += 1; return [{}, {}]; };
  assert.equal(syncChildren(host, 'k1', build), true);
  assert.equal(syncChildren(host, 'k1', build), false);
  assert.equal(built, 1);
  assert.deepEqual(ops, [['replace', 2]]);
  assert.equal(syncChildren(host, 'k2', build), true);
  assert.deepEqual(ops, [['replace', 2], ['replace', 2]]);
});

test('evaluateStickFromScroll performs every read before any write', () => {
  const log = [];
  const mount = {
    get scrollHeight() { log.push('R'); return 1000; },
    get clientHeight() { log.push('R'); return 400; },
    get scrollTop() { log.push('R'); return 100; },
  };
  const button = {
    _h: false,
    get hidden() { return this._h; },
    set hidden(v) { log.push('W'); this._h = v; },
  };
  const state = {
    _s: true,
    get stickToBottom() { return this._s; },
    set stickToBottom(v) { log.push('W'); this._s = v; },
  };
  const stick = evaluateStickFromScroll(mount, button, state, 8);
  assert.equal(stick, false);
  assert.equal(button.hidden, false);
  assert.ok(!log.join('').includes('WR'), log.join(''));
});

test('measureSendBarReserve does no writes and returns the distance', () => {
  const prev = globalThis.HTMLElement;
  class FakeEl {}
  globalThis.HTMLElement = FakeEl;
  try {
    const log = [];
    const mk = (top, bottom, extra = {}) => Object.assign(new FakeEl(), {
      getBoundingClientRect() { log.push('R'); return { top, bottom }; },
    }, extra);
    const stack = mk(80, 90, { hidden: false });
    const bar = mk(100, 150, { querySelector: () => stack });
    const pane = mk(0, 160);
    assert.equal(measureSendBarReserve(pane, bar), 80);
    assert.equal(measureSendBarReserve(pane, bar, true), 20);
    assert.ok(log.every((x) => x === 'R'));
  } finally {
    globalThis.HTMLElement = prev;
  }
});

import { planSlotIconOps, reconcileSlotIcons } from '../app_front/lib/slotIconReconcile.js';

/** Host double recording the child-mutation calls that trigger slotchange. */
function makeIconHost() {
  const ops = [];
  const mkChild = (slot, className) => {
    const attrs = new Map([['data-cr-icon', ''], ['slot', slot]]);
    const el = {
      className,
      hasAttribute: (n) => attrs.has(n),
      getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
      setAttribute: (n, v) => attrs.set(n, v),
      remove() { ops.push('removeChild'); host.children = host.children.filter((c) => c !== el); },
    };
    return el;
  };
  const host = {
    children: [],
    ops,
    appendChild(el) { ops.push('appendChild'); host.children.push(el); },
    replaceChildren() { ops.push('replaceChildren'); },
  };
  return { host, mkChild };
}

test('reconcileSlotIcons: identical second pass does no child operations; change does one', () => {
  const { host, mkChild } = makeIconHost();
  const wanted = new Map([['a', 'mdi-check']]);
  reconcileSlotIcons(host, wanted, () => mkChild('', ''));
  assert.deepEqual(host.ops, ['appendChild']);
  host.ops.length = 0;
  reconcileSlotIcons(host, new Map([['a', 'mdi-check']]), () => mkChild('', ''));
  assert.deepEqual(host.ops, []);
  // Changed icon of the same slot: class update only, no node churn.
  reconcileSlotIcons(host, new Map([['a', 'mdi-alert']]), () => mkChild('', ''));
  assert.deepEqual(host.ops, []);
  assert.equal(host.children[0].className, 'mdi mdi-alert');
  // Dropped slot: exactly one removal.
  reconcileSlotIcons(host, new Map(), () => mkChild('', ''));
  assert.deepEqual(host.ops, ['removeChild']);
});

test('planSlotIconOps is empty when nothing changed', () => {
  assert.deepEqual(planSlotIconOps([{ slot: 'a', className: 'mdi mdi-x' }], new Map([['a', 'mdi-x']])), []);
});
