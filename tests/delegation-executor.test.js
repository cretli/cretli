import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { isDelegationModelAvailable } from '../lib/delegation-executor.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

assert.equal(isDelegationModelAvailable({ transport: 'opencode', model: '', settings: {} }), false);
assert.equal(isDelegationModelAvailable({ transport: 'opencode', model: 'opencode/test', settings: {} }), true);
assert.equal(isDelegationModelAvailable({
  transport: 'opencode',
  model: 'opencode/test',
  settings: { opencodeChatEnabledModels: ['other-model'] },
}), false);
assert.equal(isDelegationModelAvailable({
  transport: 'opencode',
  model: 'opencode/test',
  settings: { opencodeChatEnabledModels: ['opencode/test'] },
}), true);
assert.equal(isDelegationModelAvailable({
  transport: 'opencode',
  model: 'opencode/test',
  settings: { enabledHarnesses: ['sdk'] },
}), false);
assert.equal(isDelegationModelAvailable({
  transport: 'sdk',
  model: 'auto',
  settings: {},
}), false);

console.log('delegation-executor.test.js OK');
