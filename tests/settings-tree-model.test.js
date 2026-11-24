import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SETTINGS_CATEGORIES, SETTINGS_SUBCATEGORIES } from '../app_front/features/settings/settingsCategories.js';
import { buildSettingsTree, foldHarnessProviders, harnessIdForSettingsTab, resolveSettingsTreeActive, settingsTreeExpansion, settingsSidebarTransition } from '../app_front/features/settings/settingsTreeModel.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
const tree = buildSettingsTree(SETTINGS_CATEGORIES, SETTINGS_SUBCATEGORIES);

test('manifest tree covers every existing subtab, with translated labels and valid parents', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const section = html.split('id="settings-harness-tabs"')[1].split('<div class="settings-sections')[0];
  const tabs = [...section.matchAll(/data-settings-tab="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(new Set(SETTINGS_SUBCATEGORIES.map(node => node.tab)), new Set(tabs));
  assert.equal(tree.length, SETTINGS_CATEGORIES.length);
  const ids = new Set([...SETTINGS_CATEGORIES, ...SETTINGS_SUBCATEGORIES].map(node => node.id));
  assert.equal(ids.size, SETTINGS_CATEGORIES.length + SETTINGS_SUBCATEGORIES.length);
  for (const node of SETTINGS_SUBCATEGORIES) {
    assert.ok(ids.has(node.parent), node.parent);
    assert.match(html, new RegExp(`data-settings-tab="${node.tab}"`));
    for (const dict of [en, pl]) assert.ok(node.labelKey.split('.').reduce((value, key) => value?.[key], dict), node.labelKey);
  }
});
test('active node prefers the deepest existing panel and reveals its ancestor chain', () => {
  assert.deepEqual(resolveSettingsTreeActive(tree, 'harness-codex-models'), { id: 'harness-codex-models', ancestors: ['harness', 'harness-codex'] });
  assert.equal(resolveSettingsTreeActive(tree, 'harness-codex').id, 'harness-codex-keys');
  assert.equal(resolveSettingsTreeActive(tree, 'interface').id, 'interface-general');
  assert.equal(resolveSettingsTreeActive(tree, 'harness').id, 'harness-overview-general');
  assert.equal(resolveSettingsTreeActive(tree, 'unknown'), null);
});
test('expansion is immutable, retains unrelated branches, and supports collapse/reveal', () => {
  const initial = ['interface'];
  const revealed = settingsTreeExpansion(initial, { type: 'reveal', ancestors: ['harness', 'harness-codex'] });
  assert.deepEqual(initial, ['interface']);
  assert.deepEqual(revealed, ['interface', 'harness', 'harness-codex']);
  assert.deepEqual(settingsTreeExpansion(revealed, { type: 'toggle', id: 'harness' }), ['interface', 'harness-codex']);
  assert.deepEqual(settingsTreeExpansion(initial, { type: 'toggle', id: 'chat' }), ['interface', 'chat']);
});
test('route controls mode without overwriting chat view-mode state', () => {
  assert.deepEqual(settingsSidebarTransition('chats', 'settings'), { mode: 'settings', entered: true, openTree: true });
  assert.deepEqual(settingsSidebarTransition('settings', 'settings', 'chat-archive'), { mode: 'settings', entered: false, openTree: false });
  assert.deepEqual(settingsSidebarTransition('chats', 'settings', 'harness-codex-models'), { mode: 'settings', entered: true, openTree: false });
  assert.deepEqual(settingsSidebarTransition('settings', 'settings', ''), { mode: 'settings', entered: false, openTree: true });
  for (const panel of ['chat', 'git', 'todo']) assert.equal(settingsSidebarTransition('settings', panel).mode, 'chats');
});

test('harness provider pages fold into one set of leaves that follow the chosen harness', () => {
  assert.equal(harnessIdForSettingsTab(tree, 'harness-codex-models'), 'codex');
  assert.equal(harnessIdForSettingsTab(tree, 'harness-claude'), 'claude');
  assert.equal(harnessIdForSettingsTab(tree, 'harness-overview-plugins'), '');
  assert.equal(harnessIdForSettingsTab(tree, 'interface'), '');
  const folded = foldHarnessProviders(tree, 'codex');
  const harness = folded.find(node => node.id === 'harness');
  const ids = harness.children.map(node => node.id);
  assert.equal(ids[0], 'harness-overview');
  assert.ok(!ids.includes('harness-codex'));
  const models = harness.children.find(node => node.id === 'harness-provider-models');
  assert.equal(models.tab, 'harness-codex-models');
  assert.deepEqual(resolveSettingsTreeActive(folded, 'harness-codex-models'), { id: 'harness-provider-models', ancestors: ['harness'] });
  // An unknown harness falls back to the first provider instead of dropping the pages.
  assert.equal(foldHarnessProviders(tree, '').find(node => node.id === 'harness').children.length, ids.length);
  // Other subtrees are untouched.
  assert.equal(folded.find(node => node.id === 'interface'), tree.find(node => node.id === 'interface'));
});
