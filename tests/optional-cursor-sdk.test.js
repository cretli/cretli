import assert from 'node:assert/strict';
import {
  createCursorSdkUnavailableError,
  isCursorSdkUnavailableError,
  isCursorSdkAvailable,
  loadCursorSdk,
} from '../lib/sdk/cursor-sdk.js';

const unavailable = createCursorSdkUnavailableError(new Error('not found'));
assert.equal(isCursorSdkUnavailableError(unavailable), true);
assert.match(unavailable.message, /OpenCode or OpenRouter/);

const available = await isCursorSdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadCursorSdk();
  assert.ok(sdk);
} else {
  await assert.rejects(() => loadCursorSdk(), (err) => isCursorSdkUnavailableError(err));
}

console.log('optional-cursor-sdk.test.js OK');
