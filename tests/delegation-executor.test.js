import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import {
  isDelegationModelAvailable,
  resolveDelegationModel,
} from '../lib/delegation-executor.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
registerMockChatRunAdapter('sdk');

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
}), true);

const grokSettings = {
  chatEnabledModels: [
    'grok-4.6::effort=high,fast=false',
    'grok-4.6::effort=high,fast=true',
    'grok-4.6::effort=medium,fast=false',
    'grok-4.6::effort=medium,fast=true',
  ],
};

assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.6', settings: grokSettings }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.6 medium', settings: grokSettings }),
  'grok-4.6::effort=medium,fast=false',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.6 High', settings: grokSettings }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({
    transport: 'sdk',
    model: 'grok-4.6::effort=high',
    settings: grokSettings,
  }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({
    transport: 'sdk',
    model: 'grok-4.6::effort=high,fast=false',
    settings: grokSettings,
  }),
  'grok-4.6::effort=high,fast=false',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'grok-4.5', settings: grokSettings }),
  '',
);
assert.equal(
  resolveDelegationModel({ transport: 'sdk', model: 'composer-2', settings: grokSettings }),
  '',
);
assert.equal(
  isDelegationModelAvailable({ transport: 'sdk', model: 'grok-4.6', settings: grokSettings }),
  true,
);
assert.equal(
  isDelegationModelAvailable({ transport: 'sdk', model: 'grok-4.5', settings: grokSettings }),
  false,
);

console.log('delegation-executor.test.js OK');
