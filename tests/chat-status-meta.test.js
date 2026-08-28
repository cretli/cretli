import assert from 'node:assert/strict';
import {
  hasLiveHarnessWork,
  readHarnessPendingFlags,
  resolveChatListDotState,
  resolveHarnessChatStateMeta,
} from '../app_front/features/chat/chatStatusMeta.js';

// Expected labels below are the English i18n fallbacks from chatStatusMeta.js.

const inputIdle = {
  connection: 'connected',
  agent: 'idle',
  hasPendingQuestion: false,
  hasPendingPermission: false,
};
const actualIdle = resolveHarnessChatStateMeta(inputIdle);
assert.equal(actualIdle.tone, 'idle');
assert.equal(actualIdle.label, 'Ready');

const inputAwaitingFromBufferHeuristic = {
  connection: 'connected',
  agent: 'idle',
  hasPendingQuestion: false,
  hasPendingPermission: false,
};
const actualAfterMarkdownQuestion = resolveHarnessChatStateMeta(inputAwaitingFromBufferHeuristic);
assert.equal(actualAfterMarkdownQuestion.tone, 'idle');
assert.equal(actualAfterMarkdownQuestion.label, 'Ready');

const inputDisconnectedActive = { connection: 'disconnected', agent: 'active' };
const actualDisconnectedActive = resolveHarnessChatStateMeta(inputDisconnectedActive);
assert.equal(actualDisconnectedActive.tone, 'active');
assert.equal(actualDisconnectedActive.label, 'Agent working');

const inputDisconnectedPending = {
  connection: 'disconnected',
  agent: 'idle',
  hasPendingQuestion: true,
};
const actualDisconnectedPending = resolveHarnessChatStateMeta(inputDisconnectedPending);
assert.equal(actualDisconnectedPending.tone, 'awaiting');
assert.equal(actualDisconnectedPending.label, 'Needs action');

const inputDisconnectedIdle = { connection: 'disconnected', agent: 'idle' };
const actualDisconnectedIdle = resolveHarnessChatStateMeta(inputDisconnectedIdle);
assert.equal(actualDisconnectedIdle.tone, 'disconnected');
assert.equal(actualDisconnectedIdle.label, 'Disconnected');

const inputConnecting = { connection: 'connecting', agent: 'idle' };
const actualConnecting = resolveHarnessChatStateMeta(inputConnecting);
assert.equal(actualConnecting.tone, 'connecting');
assert.equal(actualConnecting.label, 'Connecting…');

const inputActive = { connection: 'connected', agent: 'active' };
const actualActive = resolveHarnessChatStateMeta(inputActive);
assert.equal(actualActive.tone, 'active');
assert.equal(actualActive.label, 'Agent working');

const inputQueued = { connection: 'connected', agent: 'active', queuedCount: 2 };
const actualQueued = resolveHarnessChatStateMeta(inputQueued);
assert.equal(actualQueued.tone, 'active');
assert.equal(actualQueued.label, 'Agent working · queue: 2');

const inputOpenCodeQuestion = {
  connection: 'connected',
  agent: 'idle',
  hasPendingQuestion: true,
};
const actualOpenCodeQuestion = resolveHarnessChatStateMeta(inputOpenCodeQuestion);
assert.equal(actualOpenCodeQuestion.tone, 'awaiting');
assert.equal(actualOpenCodeQuestion.label, 'Needs action');

const inputOpenCodePermission = {
  connection: 'connected',
  agent: 'idle',
  hasPendingPermission: true,
};
const actualOpenCodePermission = resolveHarnessChatStateMeta(inputOpenCodePermission);
assert.equal(actualOpenCodePermission.tone, 'awaiting');
assert.equal(actualOpenCodePermission.label, 'Needs action');

const inputChatNoPending = {
  _awaitingInput: true,
  _opencodePendingQuestion: null,
  _sdkServerPendingQuestionCount: 0,
  _sdkServerPendingPermissionCount: 0,
};
const actualFlagsIgnoreBuffer = readHarnessPendingFlags(inputChatNoPending);
assert.equal(actualFlagsIgnoreBuffer.hasPendingQuestion, false);
assert.equal(actualFlagsIgnoreBuffer.hasPendingPermission, false);

const inputChatOpenCode = {
  _opencodePendingQuestion: { id: 'q1' },
  _sdkServerPendingPermissionCount: 1,
};
const actualFlagsOpenCode = readHarnessPendingFlags(inputChatOpenCode);
assert.equal(actualFlagsOpenCode.hasPendingQuestion, true);
assert.equal(actualFlagsOpenCode.hasPendingPermission, true);

assert.equal(resolveChatListDotState('idle'), 'idle');
assert.equal(resolveChatListDotState('awaiting'), 'awaiting');
assert.equal(resolveChatListDotState('question'), 'awaiting');
assert.equal(resolveChatListDotState('active'), 'active');
assert.equal(resolveChatListDotState('disconnected'), 'disconnected');
assert.equal(resolveChatListDotState('connecting'), 'active');

const inputTranslated = resolveHarnessChatStateMeta({
  connection: 'connected',
  agent: 'idle',
  translate: (key) => `T:${key}`,
});
assert.equal(inputTranslated.label, 'T:status.ready');

assert.equal(hasLiveHarnessWork(null), false);
assert.equal(hasLiveHarnessWork({ _agentState: 'active' }), false);
assert.equal(hasLiveHarnessWork({ _sdkServerBusy: true }), true);
assert.equal(hasLiveHarnessWork({ _sdkServerQueuedCount: 2 }), true);
assert.equal(hasLiveHarnessWork({ _sdkRichView: { queuedCount: 1 } }), true);
assert.equal(hasLiveHarnessWork({ _opencodePendingQuestion: { id: 'q1' } }), true);
assert.equal(hasLiveHarnessWork({ _sdkServerPendingPermissionCount: 1 }), true);
assert.equal(hasLiveHarnessWork({ _agentState: 'idle', _sdkServerBusy: false }), false);

console.log('All chat status meta tests passed.');
