import assert from 'node:assert/strict';
import { shouldLoadHarnessModelCatalogs } from '../app_front/features/chat/harnessSettingsLoad.js';

assert.equal(shouldLoadHarnessModelCatalogs('boot'), false);
assert.equal(shouldLoadHarnessModelCatalogs('new-chat'), false);
assert.equal(shouldLoadHarnessModelCatalogs('lang'), false);
assert.equal(shouldLoadHarnessModelCatalogs('settings'), true);
assert.equal(shouldLoadHarnessModelCatalogs('models-changed'), true);

console.log('harness-settings-load.test.js OK');
