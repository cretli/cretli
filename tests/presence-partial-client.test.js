import assert from 'node:assert/strict';
import {
  ingestAgentPresenceMessage,
  __getAgentPresenceSyncStateForTest,
} from '../app_front/features/chat/chatHistorySyncPoll.js';

const row = (id) => ({ state: 'busy', delegationId: id });
const chats = [{ id: 'a', _serverRunState: row('old') }, { id: 'b', _serverRunState: row('b') }, { id: 'c' }];

// A partial snapshot must not idle-out chats it does not name (b), and must keep the HTTP fill-in pending.
const result = ingestAgentPresenceMessage(chats, {
  type: 'agentPresence', epoch: 'e', seq: 5, snapshot: true, partial: true, total: 300, version: 2,
  states: { a: row('new'), c: row('c') }, cleared: [],
});
assert.equal(chats[0]._serverRunState.delegationId, 'new');
assert.equal(chats[1]._serverRunState.delegationId, 'b', 'chat outside the window keeps its state');
assert.equal(chats[2]._serverRunState.delegationId, 'c');
assert.equal(result.seqGap, true, 'caller fetches the rest on demand');
assert.equal(__getAgentPresenceSyncStateForTest().presenceFallbackRequired, true);

// A full snapshot still idles unnamed chats (old behaviour).
ingestAgentPresenceMessage(chats, { type: 'agentPresence', epoch: 'e', seq: 6, snapshot: true, states: { a: row('x') }, cleared: [] });
assert.equal(chats[1]._serverRunState, null);
console.log('presence-partial-client ok');
