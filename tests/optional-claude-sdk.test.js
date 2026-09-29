import assert from 'node:assert/strict';
import {
  createClaudeSdkUnavailableError,
  isClaudeSdkAvailable,
  isClaudeSdkUnavailableError,
  loadClaudeSdk,
} from '../lib/claude/claude-sdk.js';

const unavailable = createClaudeSdkUnavailableError(new Error('not found'));
assert.equal(isClaudeSdkUnavailableError(unavailable), true);
assert.match(unavailable.message, /OpenCode, OpenRouter, or Cursor SDK/);

const available = await isClaudeSdkAvailable();
assert.equal(typeof available, 'boolean');
if (available) {
  const sdk = await loadClaudeSdk();
  assert.equal(typeof sdk.query, 'function');
} else {
  await assert.rejects(() => loadClaudeSdk(), (err) => isClaudeSdkUnavailableError(err));
}

console.log('optional-claude-sdk.test.js OK');
