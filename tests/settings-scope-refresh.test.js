import test from 'node:test';
import assert from 'node:assert/strict';
import { setSharedViewContextStore } from '../app_front/app/appShell/viewContextBridge.js';

globalThis.customElements ||= { get() {}, define() {} };
const { initSettingsScopeBadges } = await import('../app_front/features/settings/settingsScopeBadges.js');

test('workspace switches and language changes refresh mounted badges without a reload', () => {
  const original = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver };
  const listeners = {};
  let runtime = { workspaceFile: 'cretli:ws:alpha', workspaceFolder: '/projects/alpha' };
  const elements = ['workspace', 'folder', 'global', 'server', 'per-item'].map((scope) => ({
    children: [],
    getAttribute: (name) => (name === 'data-settings-scope' ? scope : null),
    prepend(badge) { this.children.unshift(badge); },
  }));
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => elements,
    querySelector: () => null,
    createElement: () => ({ tagName: 'CR-SCOPE-BADGE' }),
  };
  globalThis.window = { addEventListener: (name, listener) => { listeners[name] = listener; } };
  globalThis.MutationObserver = class { observe() {} };
  setSharedViewContextStore({ getState: () => ({ runtime }) });
  try {
    initSettingsScopeBadges({ getWorkspaces: () => [
      { id: 'cretli:ws:alpha', name: 'Alpha' }, { id: 'cretli:ws:beta', name: 'Beta' },
    ] });
    assert.equal(elements[0].children[0].name, 'Alpha');
    assert.equal(elements[1].children[0].name, '/projects/alpha');
    runtime = { workspaceFile: 'cretli:ws:beta', workspaceFolder: '/projects/beta' };
    listeners['cretli-view-context-changed']();
    assert.equal(elements[0].children[0].name, 'Beta');
    assert.equal(elements[1].children[0].name, '/projects/beta');
    assert.ok(elements.every((element) => element.children.length === 1));
    listeners['cr-lang-changed']();
    assert.equal(elements[2].children[0].label, 'Global');
    runtime = { workspaceFile: '', workspaceFolder: '' };
    listeners['cretli-view-context-changed']();
    assert.equal(elements[0].children[0].name, '');
    assert.equal(elements[0].children[0].emptyLabel, 'No workspace selected');
  } finally {
    setSharedViewContextStore(null);
    Object.assign(globalThis, original);
  }
});

/** Minimal section element with its own attribute store, as the DOM would give it. */
function fakeSection(scope) {
  const attrs = { 'data-settings-scope': scope };
  return {
    children: [],
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: (name) => { delete attrs[name]; },
    closest() { return this; },
    prepend(badge) { this.children.unshift(badge); },
  };
}

test('panels with their own picker override the header name; folder-only Browser names the folder', async () => {
  const original = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver };
  const { setSettingsScopeName, refreshSettingsScopeBadges } = await import('../app_front/features/settings/settingsScopeBadges.js');
  const browser = fakeSection('workspace');
  const mcp = fakeSection('workspace');
  const operator = fakeSection('folder');
  const elements = [browser, mcp, operator];
  globalThis.document = {
    getElementById: () => null, querySelectorAll: () => elements, querySelector: () => null,
    createElement: () => ({ tagName: 'CR-SCOPE-BADGE' }),
  };
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class { observe() {} };
  // Header context: no registry workspace, only a folder.
  setSharedViewContextStore({ getState: () => ({ runtime: { workspaceFile: '', workspaceFolder: '/projects/solo' } }) });
  try {
    refreshSettingsScopeBadges();
    assert.equal(browser.children[0].name, '/projects/solo', 'Browser with a folder-only context shows the folder');
    assert.equal(mcp.children[0].name, '/projects/solo');
    setSettingsScopeName(mcp, 'Beta');
    setSettingsScopeName(operator, '/projects/other');
    assert.equal(mcp.children[0].name, 'Beta', 'MCP shows the scope picked in its own form');
    assert.equal(operator.children[0].name, '/projects/other', 'MCP Operator shows its own folder');
    assert.equal(browser.children[0].name, '/projects/solo', 'other panels keep the header context');
    setSettingsScopeName(mcp, '');
    assert.equal(mcp.children[0].name, '/projects/solo', 'clearing the override restores the header context');
  } finally {
    setSharedViewContextStore(null);
    Object.assign(globalThis, original);
  }
});

test('MCP form Edit and Cancel keep the scope badge in step with the picker', async () => {
  const original = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver };
  const { startEdit, resetServerForm } = await import('../app_front/features/settings/mcpSettings.js');
  const section = fakeSection('workspace');
  const picker = {
    options: [{ value: 'all', label: 'All workspaces' }, { value: 'cretli:ws:beta', label: 'Beta' }],
    value: 'all',
  };
  const root = Object.assign(section, {
    dataset: {},
    querySelector: (sel) => (sel === '#mcp-form-scope' ? picker : null),
    querySelectorAll: () => [],
  });
  globalThis.document = {
    getElementById: () => null, querySelectorAll: () => [root], querySelector: () => null,
    createElement: () => ({ tagName: 'CR-SCOPE-BADGE' }),
  };
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class { observe() {} };
  setSharedViewContextStore({ getState: () => ({ runtime: { workspaceFile: '', workspaceFolder: '' } }) });
  try {
    startEdit(root, { id: 's1', name: 'beta-only', scope: ['cretli:ws:beta'] });
    assert.equal(picker.value, 'cretli:ws:beta');
    assert.equal(root.children[0].name, 'Beta', 'Edit publishes the restricted scope');
    resetServerForm(root);
    assert.equal(picker.value, 'all');
    assert.equal(root.children[0].name, 'All workspaces', 'Cancel/reset publishes the default scope');
  } finally {
    Object.assign(globalThis, original);
  }
});
