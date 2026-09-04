import assert from 'node:assert/strict';
import {
  createDeepSeekSdkUnavailableError,
  isDeepSeekSdkUnavailableError,
  isDeepSeekSdkAvailable,
  loadDeepSeekSdk,
} from '../lib/deepseek/deepseek-sdk.js';

const unavailable = createDeepSeekSdkUnavailableError(new Error('not found'));
assert.equal(isDeepSeekSdkUnavailableError(unavailable), true);
assert.match(unavailable.message, /OpenCode, OpenRouter, CodeBuddy, or Cursor SDK/);

const available = await isDeepSeekSdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadDeepSeekSdk();
  assert.ok(sdk);
  assert.equal(typeof sdk.DeepSeekHarness, 'function');
} else {
  await assert.rejects(() => loadDeepSeekSdk(), (err) => isDeepSeekSdkUnavailableError(err));
}

console.log('optional-deepseek-sdk.test.js OK');
