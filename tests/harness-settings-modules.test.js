import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { listBuiltinHarnessBackends } from '../lib/agent-harness/builtin-harness-backends.ts';
import * as openrouterSettings from '../lib/providers/openrouter/openrouter-settings.ts';
import * as openrouterChatSettings from '../harnesses/openrouter/openrouter-settings.js';
import { CORE_SETTINGS_MODULES } from '../lib/agent-harness/core-settings-modules.ts';
import * as opencodeSettings from '../harnesses/opencode/opencode-settings.js';
import * as zaiSettings from '../harnesses/zai/zai-settings.js';
import * as mimoSettings from '../harnesses/mimo/mimo-settings.js';
import * as qwenSettings from '../harnesses/qwen/qwen-settings.js';

const OPENROUTER_KEY = `sk-or-v1-${'a'.repeat(64)}`;

test('every non-core backend owns a settings module; core ones stay in settings-routes', () => {
  const owners = listBuiltinHarnessBackends().filter((backend) => backend.settings).map((backend) => backend.id);
  assert.deepEqual(owners.sort(), ['codebuddy', 'deepseek', 'mimo', 'mistral', 'opencode', 'openrouter', 'qwen', 'zai']);
});

test('openrouter patches before opencode, so a misfiled Zen key is cleared in one PATCH', () => {
  // The key module is core and applies before every backend module; the chat plugin keeps its slot too.
  assert.equal(CORE_SETTINGS_MODULES[0], openrouterSettings);
  const ids = listBuiltinHarnessBackends().map((backend) => backend.id);
  assert.ok(ids.indexOf('openrouter') < ids.indexOf('opencode'));

  const settings = { openrouterApiKey: 'sk-zen-key-pasted-in-the-wrong-field' };
  const result = opencodeSettings.applySettingsPatch({ opencodeApiKey: 'sk-zen-key-pasted-in-the-wrong-field' }, settings);
  assert.deepEqual(result, { changed: true });
  assert.equal(settings.opencodeApiKey, 'sk-zen-key-pasted-in-the-wrong-field');
  assert.equal('openrouterApiKey' in settings, false);
});

test('validation errors keep their 400 messages', () => {
  assert.deepEqual(openrouterSettings.applySettingsPatch({ openrouterApiKey: 'sk-wrong' }, {}), {
    changed: false,
    error: { status: 400, message: 'Invalid OpenRouter API key — it must start with sk-or-v1- (create one at openrouter.ai/keys).' },
  });
  assert.equal(zaiSettings.applySettingsPatch({ zaiApiKey: 'sk-short' }, {}).error?.message, 'Invalid Z.AI SDK API key format.');
  assert.equal(
    mimoSettings.applySettingsPatch({ mimoBaseUrl: 'http://insecure.example' }, {}).error?.message,
    'Invalid MiMo base URL (must be an HTTPS URL ending with /v1).',
  );
});

test('a valid key, an untouched body and blank strings behave as before', () => {
  const settings = {};
  assert.deepEqual(openrouterSettings.applySettingsPatch({ openrouterApiKey: OPENROUTER_KEY }, settings), { changed: true });
  assert.equal(settings.openrouterApiKey, OPENROUTER_KEY);
  // The OpenRouter clear flag only reports a change when a key existed.
  assert.deepEqual(openrouterSettings.applySettingsPatch({ clearOpenrouterApiKey: true }, {}), { changed: false });
  assert.deepEqual(qwenSettings.applySettingsPatch({}, settings), { changed: false });
  const qwen = { qwenBin: '/old/qwen' };
  assert.deepEqual(qwenSettings.applySettingsPatch({ qwenBin: '   ', qwenChatEnabledModels: [] }, qwen), { changed: true });
  assert.deepEqual(qwen, {});
});

test('opencode runtime reset follows the keys that used to trigger it', () => {
  assert.equal(opencodeSettings.requiresRuntimeReset({ opencodeZaiProvider: 'zai' }), true);
  assert.equal(opencodeSettings.requiresRuntimeReset({ clearOpenCodeMimoApiKey: true }), true);
  assert.equal(opencodeSettings.requiresRuntimeReset({ opencodeBin: '/usr/bin/opencode' }), false);
  assert.equal(opencodeSettings.requiresRuntimeReset(null), false);
});

test('openrouter chat plugin settings carry only the favorite models', () => {
  assert.deepEqual(Object.keys(openrouterChatSettings.readClientSettings({})), ['openrouterChatEnabledModels']);
  const doc = {};
  assert.deepEqual(openrouterChatSettings.applySettingsPatch({ openrouterApiKey: OPENROUTER_KEY }, doc), { changed: false });
  assert.equal('openrouterApiKey' in doc, false);
});
