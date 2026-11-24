import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SETTINGS_CATEGORIES, settingsCategoryForTab } from '../app_front/features/settings/settingsCategories.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
test('manifest covers every main category, panel and translation', () => {
  const bar = html.split('id="settings-tabs"')[1].split('id="settings-harness-tabs"')[0];
  const ids = [...bar.matchAll(/data-settings-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(new Set(ids), new Set(SETTINGS_CATEGORIES.map(c => c.id)));
  for (const c of SETTINGS_CATEGORIES) {
    assert.match(html, new RegExp(`<section[^>]*data-settings-tab="${c.id}"`));
    assert.ok(en.settings.category[c.id]);
    assert.ok(pl.settings.category[c.id]);
    assert.ok(c.scopes.length && c.icon.startsWith('mdi-') && c.keywords);
    const scopes = [...html.matchAll(new RegExp(`<section[^>]*data-settings-tab="${c.id}"[^>]*data-settings-scope="([^"]+)"`, 'g'))].map(match => match[1]);
    assert.deepEqual(new Set(c.scopes), new Set(scopes));
  }
  assert.equal(settingsCategoryForTab('harness-codex-models').id, 'harness');
});
