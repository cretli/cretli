import assert from 'node:assert/strict';
import { getOpenRouterFinishReasonError } from '../lib/agent-harness/openrouter-agent-loop.js';

assert.equal(getOpenRouterFinishReasonError('network_error'), 'Provider finish_reason: network_error');
assert.equal(getOpenRouterFinishReasonError(' NETWORK_ERROR '), 'Provider finish_reason: network_error');
assert.equal(getOpenRouterFinishReasonError('stop'), '');
assert.equal(getOpenRouterFinishReasonError('length'), '');
assert.equal(getOpenRouterFinishReasonError(''), '');

console.log('openrouter-agent-loop.test.js OK');
