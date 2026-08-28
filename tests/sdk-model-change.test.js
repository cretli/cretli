import assert from 'node:assert/strict';
import { shouldSkipSdkAgentResumeForModelChange } from '../lib/sdk/cursor-agent-sdk-ws.js';

assert.equal(shouldSkipSdkAgentResumeForModelChange(null, 'auto'), false);
assert.equal(shouldSkipSdkAgentResumeForModelChange({}, 'auto'), false);
assert.equal(
  shouldSkipSdkAgentResumeForModelChange({ _agentModelId: 'composer-2' }, 'composer-2'),
  false
);
assert.equal(
  shouldSkipSdkAgentResumeForModelChange({ _agentModelId: 'composer-2' }, 'composer-2.5'),
  true
);
assert.equal(
  shouldSkipSdkAgentResumeForModelChange(
    { _agentModelId: 'composer-2.5' },
    'composer-2.5::fast=true'
  ),
  true
);

console.log('All sdk-model-change tests passed.');
