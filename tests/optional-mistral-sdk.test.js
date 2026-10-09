import assert from 'node:assert/strict';
import {
  createMistralSdkUnavailableError,
  isMistralSdkAvailable,
  isMistralSdkUnavailableError,
  loadMistralSdk,
} from '../lib/mistral/mistral-sdk.js';

const unavailable = createMistralSdkUnavailableError(new Error('not found'));
assert.equal(isMistralSdkUnavailableError(unavailable), true);
assert.equal(unavailable.code, 'MISTRAL_SDK_UNAVAILABLE');
assert.match(unavailable.message, /OpenRouter, OpenCode, CodeBuddy, or Cursor SDK/);
assert.equal(isMistralSdkUnavailableError(new Error('other')), false);

// Importing the harness modules must not require the optional package.
await import('../lib/mistral/mistral-client.js');
await import('../lib/mistral/mistral-models.js');

const available = await isMistralSdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadMistralSdk();
  assert.equal(typeof sdk.Mistral, 'function');
} else {
  assert.equal(available, false);
  await assert.rejects(() => loadMistralSdk(), (err) => isMistralSdkUnavailableError(err));
}

console.log('optional-mistral-sdk.test.js OK');
