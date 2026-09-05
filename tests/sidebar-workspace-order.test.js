import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectWorkspaceKeysFromList,
  computeDropIndex,
  readWorkspaceOrder,
  workspaceOrderIndex,
  writeWorkspaceOrder,
} from '../app_front/features/sidebar/sidebarWorkspaceOrder.js';

/** Minimal localStorage stub so the module has something to talk to in Node. */
function installLocalStorageStub() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

test('readWorkspaceOrder returns an empty list when nothing is saved', () => {
  delete globalThis.localStorage;
  assert.deepEqual(readWorkspaceOrder(), []);
});

test('writeWorkspaceOrder then readWorkspaceOrder round-trips keys', () => {
  const map = installLocalStorageStub();
  writeWorkspaceOrder(['/ws/b', '/ws/a']);
  assert.deepEqual(readWorkspaceOrder(), ['/ws/b', '/ws/a']);
  assert.match(map.get('cretli-sidebar-workspace-order'), /^\[/);
});

test('writeWorkspaceOrder normalizes, dedupes and drops empty keys', () => {
  installLocalStorageStub();
  writeWorkspaceOrder(['/ws/a/', '', '\\ws\\b', '/ws/a', '   ']);
  assert.deepEqual(readWorkspaceOrder(), ['/ws/a', '/ws/b']);
});

test('workspaceOrderIndex returns found index and a large number for missing keys', () => {
  const order = ['/ws/b', '/ws/a'];
  assert.equal(workspaceOrderIndex({ sidebarKey: '/ws/b' }, order), 0);
  assert.equal(workspaceOrderIndex({ workspaceFile: '/ws/a' }, order), 1);
  assert.equal(workspaceOrderIndex({ sidebarKey: '/ws/unknown' }, order), Number.MAX_SAFE_INTEGER);
  assert.equal(workspaceOrderIndex(null, order), Number.MAX_SAFE_INTEGER);
  assert.equal(workspaceOrderIndex({ sidebarKey: '/ws/b' }, null), Number.MAX_SAFE_INTEGER);
});

test('computeDropIndex returns 0 for an empty list', () => {
  assert.equal(computeDropIndex([], 500), 0);
});

test('computeDropIndex places before first, between and after last items', () => {
  const centers = [100, 200, 300];
  assert.equal(computeDropIndex(centers, 50), 0);
  assert.equal(computeDropIndex(centers, 100), 0);
  assert.equal(computeDropIndex(centers, 150), 1);
  assert.equal(computeDropIndex(centers, 250), 2);
  assert.equal(computeDropIndex(centers, 300), 2);
  assert.equal(computeDropIndex(centers, 999), 3);
});

test('collectWorkspaceKeysFromList reads data-sidebar-key from direct children', () => {
  const list = {
    querySelectorAll: () => [
      { dataset: { sidebarKey: '/ws/b' } },
      { dataset: { sidebarKey: '/ws/a' } },
      { dataset: {} },
    ],
  };
  assert.deepEqual(collectWorkspaceKeysFromList(list), ['/ws/b', '/ws/a']);
});

test('collectWorkspaceKeysFromList returns [] for a missing list', () => {
  assert.deepEqual(collectWorkspaceKeysFromList(null), []);
});

test('computeDropIndex clamps to valid range for unsorted input', () => {
  const centers = [300, 100, 200];
  const index = computeDropIndex(centers, 150);
  assert.ok(index >= 0 && index <= centers.length);
});
