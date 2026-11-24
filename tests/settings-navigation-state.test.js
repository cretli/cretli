import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsNavigationView } from '../app_front/features/settings/settingsNavigationState.js';
test('gear and back open list; categories and subtab deep links open content', () => {
  assert.equal(settingsNavigationView(), 'list');
  assert.equal(settingsNavigationView('workspace'), 'content');
  assert.equal(settingsNavigationView('harness-codex-models'), 'content');
  assert.equal(settingsNavigationView(''), 'list');
});

test('returning to the mobile list keeps the active category and form state', async (context) => {
  const { syncSettingsNavigationView, returnToSettingsList } = await import('../app_front/features/settings/settingsNavigationState.js');
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  context.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; });
  const panel = { dataset: { activeSettingsTab: 'harness-codex-keys' }, draft: 'unsaved' };
  globalThis.document = { getElementById: () => panel };
  let mobile = true;
  globalThis.window = { matchMedia: () => ({ matches: mobile }) };
  syncSettingsNavigationView('harness-codex-keys');
  assert.equal(returnToSettingsList(), true);
  syncSettingsNavigationView('');
  assert.equal(returnToSettingsList(), false);
  assert.equal(panel.dataset.activeSettingsTab, 'harness-codex-keys');
  assert.equal(panel.draft, 'unsaved');
  syncSettingsNavigationView('chat');
  mobile = false;
  assert.equal(returnToSettingsList(), true);
});
