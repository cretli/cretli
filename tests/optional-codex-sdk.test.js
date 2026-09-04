import assert from 'node:assert/strict';
import {
  createCodexSdkUnavailableError,
  isCodexSdkUnavailableError,
  isCodexSdkAvailable,
  loadCodexSdk,
} from '../lib/codex/codex-sdk.js';

const unavailable = createCodexSdkUnavailableError(new Error('not found'));
assert.equal(isCodexSdkUnavailableError(unavailable), true);
assert.match(unavailable.message, /OpenCode, OpenRouter, CodeBuddy, DeepSeek, or Cursor SDK/);

const available = await isCodexSdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadCodexSdk();
  assert.ok(sdk);
  assert.equal(typeof sdk.Codex, 'function');
} else {
  await assert.rejects(() => loadCodexSdk(), (err) => isCodexSdkUnavailableError(err));
}

console.log('optional-codex-sdk.test.js OK');
