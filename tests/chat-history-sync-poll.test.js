import assert from 'node:assert/strict';
import {
  MAX_POLL_REVISIONS_BATCH,
  applyAgentStatesToChats,
  fetchPollRevisions,
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

const result = applyAgentStatesToChats(chats, {
  'busy-chat': { state: 'busy', delegationId: 'd1', attention: false },
});
assert.equal(result.changed, true);
assert.deepEqual(result.dirtyIds, ['idle-chat'], 'only the row that actually changed is dirty');
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
const waitingResult = applyAgentStatesToChats(waitingChats, {
  w1: { state: 'waiting', waitingAgentCount: 2, activityKey: 'read' },
});
assert.equal(
  waitingResult.changed,
  true,
  'waitingAgentCount and activityKey must bust the HTTP dedupe key'
);
assert.deepEqual(waitingResult.dirtyIds, ['w1']);
assert.equal(waitingChats[0]._serverRunState.waitingAgentCount, 2);
assert.equal(waitingChats[0]._serverRunState.activityKey, 'read');

console.log('chat-history-sync-poll.test.js OK');

{
  const calls = [];
  const post = async (ids) => {
    calls.push(ids.length);
    return { ok: true, revisions: Object.fromEntries(ids.map((id) => [id, { headSeq: 1 }])) };
  };
  const ids = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
  let merged = await fetchPollRevisions(ids(MAX_POLL_REVISIONS_BATCH), post);
  assert.deepEqual(calls, [MAX_POLL_REVISIONS_BATCH], 'up to the cap is exactly one request');
  assert.equal(Object.keys(merged.revisions).length, MAX_POLL_REVISIONS_BATCH);
  calls.length = 0;
  merged = await fetchPollRevisions(ids(MAX_POLL_REVISIONS_BATCH * 2 + 1), post);
  assert.deepEqual(calls, [MAX_POLL_REVISIONS_BATCH, MAX_POLL_REVISIONS_BATCH, 1]);
  assert.equal(merged.ok, true);
  assert.equal(Object.keys(merged.revisions).length, MAX_POLL_REVISIONS_BATCH * 2 + 1, 'parts are merged');
  const flaky = await fetchPollRevisions(ids(MAX_POLL_REVISIONS_BATCH + 1), async (part) => (
    part.length === 1 ? { ok: false } : post(part)
  ));
  assert.equal(flaky.ok, false);
  assert.equal(Object.keys(flaky.revisions).length, MAX_POLL_REVISIONS_BATCH);
}
