import assert from 'node:assert/strict';
import {
  isPlanModeMutatingSdkEvent,
  isPlanModeMutatingToolName,
  getSdkToolCallName,
  PLAN_GUARD_USER_MESSAGE,
} from '../lib/sdk/sdk-plan-guard.js';
import { resolveHarnessPlanPolicy } from '../lib/agent-harness/harness-plan-policy.js';

assert.equal(getSdkToolCallName({ type: 'tool_call', name: 'Edit' }), 'edit');
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'edit', status: 'running' }), true);
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'read', status: 'running' }), false);
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'task', status: 'running' }), false);
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'subagent', status: 'started' }), false);
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'shell.exec', status: 'started' }), true);
assert.equal(isPlanModeMutatingSdkEvent({ type: 'assistant', name: 'edit' }), false);
assert.equal(isPlanModeMutatingSdkEvent({ type: 'tool_call', name: 'edit', status: 'completed' }), false);
assert.ok(PLAN_GUARD_USER_MESSAGE.includes('Plan mode'));
assert.equal(isPlanModeMutatingToolName('task'), false);
assert.equal(isPlanModeMutatingToolName('edit'), true);
assert.equal(resolveHarnessPlanPolicy('opencode').abortOnMutation, false);

console.log('opencode-plan-mode.test.js OK');
