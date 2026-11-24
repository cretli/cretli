import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettingsNodeIcon } from '../app_front/features/settings/settingsTreeIcons.js';
import { SETTINGS_SUBCATEGORIES } from '../app_front/features/settings/settingsCategories.js';

test('harness providers get their logo', () => {
  assert.deepEqual(resolveSettingsNodeIcon({ id: 'harness-claude' }), { kind: 'img', src: '/harness-icons/claude.svg' });
  assert.deepEqual(resolveSettingsNodeIcon({ id: 'harness-sdk' }), { kind: 'img', src: '/harness-icons/cursor.svg' });
});

test('sub-panels resolve an icon by their last id segment', () => {
  assert.equal(resolveSettingsNodeIcon({ id: 'harness-claude-keys' }).cls, 'mdi-key-outline');
  assert.equal(resolveSettingsNodeIcon({ id: 'interface-voice' }).cls, 'mdi-microphone-outline');
  assert.equal(resolveSettingsNodeIcon({ id: 'unknown-thing' }).cls, 'mdi-circle-small');
});

test('every sub-category resolves an icon', () => {
  for (const node of SETTINGS_SUBCATEGORIES) assert.ok(resolveSettingsNodeIcon(node), node.id);
});
