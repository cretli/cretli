import assert from 'node:assert/strict';
import { shouldSkipChatDeleteConfirm } from '../app_front/features/chat/chatDeleteConfirm.js';
import { hasActiveAgentRun } from '../app_front/features/chat/chatStatusMeta.js';

const inputSkipPreferenceIdle = {
  skipPreference: true,
  isAgentWorking: false,
};
const actualSkipPreferenceIdle = shouldSkipChatDeleteConfirm(inputSkipPreferenceIdle);
assert.equal(actualSkipPreferenceIdle, true);

const inputSkipPreferenceBusy = {
  skipPreference: true,
  isAgentWorking: true,
};
const actualSkipPreferenceBusy = shouldSkipChatDeleteConfirm(inputSkipPreferenceBusy);
assert.equal(actualSkipPreferenceBusy, false);

const inputExplicitSkipBusy = {
  skipConfirm: true,
  isAgentWorking: true,
};
const actualExplicitSkipBusy = shouldSkipChatDeleteConfirm(inputExplicitSkipBusy);
assert.equal(actualExplicitSkipBusy, true);

const inputForceConfirm = {
  skipPreference: true,
  forceConfirm: true,
  isAgentWorking: false,
};
const actualForceConfirm = shouldSkipChatDeleteConfirm(inputForceConfirm);
assert.equal(actualForceConfirm, false);

assert.equal(hasActiveAgentRun(null), false);
assert.equal(hasActiveAgentRun({ _agentState: 'idle' }), false);
assert.equal(hasActiveAgentRun({ _agentState: 'active' }), true);
assert.equal(hasActiveAgentRun({ _sdkServerBusy: true }), true);
assert.equal(hasActiveAgentRun({ _sdkServerQueuedCount: 1 }), true);
assert.equal(hasActiveAgentRun({ _sdkRichView: { queuedCount: 2 } }), true);
assert.equal(hasActiveAgentRun({ _opencodePendingQuestion: { id: 'q1' } }), false);

console.log('All chat delete confirm tests passed.');
