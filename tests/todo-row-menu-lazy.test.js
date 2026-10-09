/**
 * Todo row menu contract: the per-row dropdown is lazy.
 *
 * Regression guard for "one delegated listener instead of a click + keydown
 * document listener per row". The suite has no DOM, so the wiring is asserted
 * from source, mirroring the other source-contract tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDropdown } from '../app_front/lib/dropdown.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app_front/todoPanel.js'), 'utf8');

/**
 * Extracts one top-level function body: match the parameter list first (it may
 * contain a default object such as `options = {}`), then walk the body braces.
 * Template-literal `${...}` expressions are balanced, so the walk works for
 * the handlers this test inspects.
 *
 * @param {string} name
 * @returns {string}
 */
function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in todoPanel.js`);
  const paramsOpen = source.indexOf('(', start);
  let paramsDepth = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < source.length; i += 1) {
    if (source[i] === '(') paramsDepth += 1;
    else if (source[i] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  const open = source.indexOf('{', paramsClose);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces while reading ${name}`);
}

test('idle rows do not create a dropdown or document listeners', () => {
  const createRow = functionBody('createTodoRow');
  assert.doesNotMatch(createRow, /ensureRowMenu/);
  assert.doesNotMatch(createRow, /initDropdown/);
});

test('the row menu is created lazily on click and on ArrowDown', () => {
  assert.match(functionBody('onRowMenuClick'), /ensureRowMenu\(row\)/);
  const arrow = functionBody('onRowMenuTriggerKeydown');
  assert.match(arrow, /ensureRowMenu\(row\)/);
  assert.match(arrow, /api\.open\(\)/);
});

test('the lazy instance is destroyed when the menu closes', () => {
  const ensure = functionBody('ensureRowMenu');
  assert.match(ensure, /onClose:/);
  // onClose must hand the instance back for disposal, guarded against re-entry.
  assert.match(ensure, /if \(!entry\.destroying\) disposeRowMenu\(row\)/);
  assert.match(functionBody('disposeRowMenu'), /entry\.destroying = true/);
});

test('a single delegated ArrowDown listener covers all rows', () => {
  const init = functionBody('initTodoPanel');
  assert.match(init, /listEl\?\.addEventListener\('keydown', onRowMenuTriggerKeydown\)/);
  const registered = init.match(/onRowMenuTriggerKeydown/g) || [];
  assert.equal(registered.length, 1, 'one delegated listener, not one per row');
  // The trigger keeps its menu semantics.
  assert.match(functionBody('createTodoRow'), /aria-haspopup="menu"/);
});

/** Minimal element stub: `initDropdown` only wires listeners at creation. */
function makeElementStub() {
  return {
    hidden: false,
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
  };
}

test('destroy() removes the two document listeners a dropdown added', () => {
  const originalDocument = globalThis.document;
  const documentListeners = { click: 0, keydown: 0 };
  globalThis.document = {
    addEventListener(type) {
      if (type in documentListeners) documentListeners[type] += 1;
    },
    removeEventListener(type) {
      if (type in documentListeners) documentListeners[type] -= 1;
    },
  };
  try {
    // Before the fix every idle row held one instance (2 document listeners).
    // Lazily-created instances are destroyed on close, so this is the contract
    // `disposeRowMenu` relies on: create 50, then drop all of them.
    const apis = Array.from({ length: 50 }, () =>
      initDropdown({ triggerEl: makeElementStub(), floatingEl: makeElementStub() }),
    );
    assert.equal(documentListeners.click, 50);
    assert.equal(documentListeners.keydown, 50);
    apis.forEach((api) => api.destroy());
    assert.equal(documentListeners.click, 0);
    assert.equal(documentListeners.keydown, 0);
  } finally {
    globalThis.document = originalDocument;
  }
});

