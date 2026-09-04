import assert from 'node:assert/strict';
import {
  createCodeBuddySdkUnavailableError,
  isCodeBuddySdkUnavailableError,
  isCodeBuddySdkAvailable,
  loadCodeBuddySdk,
} from '../lib/codebuddy/codebuddy-sdk.js';

const unavailable = createCodeBuddySdkUnavailableError(new Error('not found'));
assert.equal(isCodeBuddySdkUnavailableError(unavailable), true);
assert.match(unavailable.message, /OpenCode, OpenRouter, or Cursor SDK/);

const available = await isCodeBuddySdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadCodeBuddySdk();
  assert.ok(sdk);
} else {
  await assert.rejects(() => loadCodeBuddySdk(), (err) => isCodeBuddySdkUnavailableError(err));
}

console.log('optional-codebuddy-sdk.test.js OK');
