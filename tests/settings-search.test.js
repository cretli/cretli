import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsSearchIndex, filterSettingsSearch, SETTINGS_CATEGORIES } from '../app_front/features/settings/settingsSearch.js';
const index = buildSettingsSearchIndex(SETTINGS_CATEGORIES, [
  { tab: 'interface-notifications', label: 'Powiadomienia dźwiękowe', target: 'label-only' },
  { tab: 'harness-codex-keys', label: 'API key' },
  { tab: 'unknown', label: 'Ignored' },
], key => key);
test('search uses translated static labels, accent folding and all query terms', () => {
  const results = filterSettingsSearch(index, 'dzwiekowe powiadomienia');
  assert.equal(results.length, 1);
  assert.equal(results[0].tab, 'interface-notifications');
  assert.equal(results[0].target, 'label-only');
  assert.equal(filterSettingsSearch(index, 'dzwiekowe absent').length, 0);
});
test('keywords cover dynamic panels without storing field values', () => {
  assert.ok(filterSettingsSearch(index, 'automation').some(r => r.category === 'watcher'));
  assert.equal(filterSettingsSearch(index, 'secret-token-value').length, 0);
  assert.equal(filterSettingsSearch(index, 'Ignored').length, 0);
  assert.deepEqual(filterSettingsSearch(index, '  '), []);
});
