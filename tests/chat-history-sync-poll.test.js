import assert from 'node:assert/strict';
import {
  applyAgentStatesToChats,
  canClearPendingRemoteHistoryAfterStoreAck,
  isChatHistoryRevisionPollInFlight,
  leaveChatHistoryRevisionPoll,
  tryEnterChatHistoryRevisionPoll,
} from '../app_front/features/chat/chatHistorySyncPoll.js';
import { shouldSkipBackgroundHistoryHttp } from '../app_front/features/chat/chatBackgroundPolicy.js';

const chats = [
  { id: 'busy-chat', _serverRunState: { state: 'busy', delegationId: 'd1', attention: false } },
  { id: 'idle-chat', _serverRunState: { state: 'busy', delegationId: 'd2', attention: false } },
];

const changed = applyAgentStatesToChats(chats, {
  'busy-chat': { state: 'busy', delegationId: 'd1', attention: false },
});
assert.equal(changed, true);
assert.equal(chats[0]._serverRunState.state, 'busy');
assert.equal(chats[1]._serverRunState, null);

assert.equal(tryEnterChatHistoryRevisionPoll(), true);
assert.equal(isChatHistoryRevisionPollInFlight(), true);
assert.equal(tryEnterChatHistoryRevisionPoll(), false);
assert.equal(leaveChatHistoryRevisionPoll(), true);
assert.equal(isChatHistoryRevisionPollInFlight(), false);

assert.equal(
  canClearPendingRemoteHistoryAfterStoreAck({ headSeq: 12, viewAppliedSeq: 10 }),
  false,
  'Store ACK must not clear pending while the view still lags'
);
assert.equal(
  canClearPendingRemoteHistoryAfterStoreAck({ headSeq: 12, viewAppliedSeq: 12 }),
  true
);
assert.equal(
  canClearPendingRemoteHistoryAfterStoreAck({ headSeq: 12, viewAppliedSeq: 12, incomplete: true }),
  false
);

assert.equal(
  shouldSkipBackgroundHistoryHttp({ monitorMode: 'ws', hasPendingDelegation: false }),
  true
);
assert.equal(
  shouldSkipBackgroundHistoryHttp({ monitorMode: 'ws', hasPendingDelegation: true }),
  false,
  'Pending delegation still uses HTTP while WS is open'
);
assert.equal(
  shouldSkipBackgroundHistoryHttp({ monitorMode: 'poll', hasPendingDelegation: false }),
  false
);

const waitingChats = [
  { id: 'w1', _serverRunState: { state: 'waiting', waitingAgentCount: 1, activityKey: '' } },
];
assert.equal(
  applyAgentStatesToChats(waitingChats, {
    w1: { state: 'waiting', waitingAgentCount: 2, activityKey: 'read' },
  }),
  true,
  'waitingAgentCount and activityKey must bust the HTTP dedupe key'
);
assert.equal(waitingChats[0]._serverRunState.waitingAgentCount, 2);
assert.equal(waitingChats[0]._serverRunState.activityKey, 'read');

console.log('chat-history-sync-poll.test.js OK');
