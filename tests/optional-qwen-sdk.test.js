import assert from 'node:assert/strict';
import {
  createQwenSdkUnavailableError,
  isQwenSdkAvailable,
  isQwenSdkUnavailableError,
  loadQwenSdk,
} from '../lib/qwen/qwen-sdk.js';

const unavailable = createQwenSdkUnavailableError(new Error('not found'));
assert.equal(isQwenSdkUnavailableError(unavailable), true);
assert.match(unavailable.message, /OpenCode, OpenRouter, or Cursor SDK/);

const available = await isQwenSdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadQwenSdk();
  assert.ok(sdk);
} else {
  await assert.rejects(() => loadQwenSdk(), (err) => isQwenSdkUnavailableError(err));
}

console.log('optional-qwen-sdk.test.js OK');
