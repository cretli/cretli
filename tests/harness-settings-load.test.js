import assert from 'node:assert/strict';
import {
  resolveHarnessSelectValue,
  shouldLoadHarnessModelCatalogs,
} from '../app_front/features/chat/harnessSettingsLoad.js';

assert.equal(shouldLoadHarnessModelCatalogs('boot'), false);
assert.equal(shouldLoadHarnessModelCatalogs('new-chat'), false);
assert.equal(shouldLoadHarnessModelCatalogs('lang'), false);
assert.equal(shouldLoadHarnessModelCatalogs('settings'), true);
assert.equal(shouldLoadHarnessModelCatalogs('models-changed'), true);

// A usage/cache refresh must preserve the current selection while it is still available.
assert.equal(
  resolveHarnessSelectValue({ current: 'opencode', options: ['sdk', 'opencode'], fallback: 'sdk' }),
  'opencode',
);
// Fall back to the default only when the current value disappeared.
assert.equal(
  resolveHarnessSelectValue({ current: 'opencode', options: ['sdk', 'qwen'], fallback: 'sdk' }),
  'sdk',
);
// Otherwise use the first available option.
assert.equal(
  resolveHarnessSelectValue({ current: '', options: ['qwen', 'sdk'], fallback: 'codex' }),
  'qwen',
);
assert.equal(resolveHarnessSelectValue({ options: [] }), '');

console.log('harness-settings-load.test.js OK');
