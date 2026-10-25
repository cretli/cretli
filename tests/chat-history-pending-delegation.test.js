import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  appendChatHistoryEvents,
  getChatHistorySince,
} from '../lib/persist/chat-history-persist.js';
import {
  clearChatHasPendingDelegation,
  getChatHistoryRevisions,
  markChatHasPendingDelegation,
} from '../lib/persist/chat-history-revisions.js';

const chat = addChat('sess-pending-del', 'Parent', null, '/tmp/ws-pending-del', 'model-a', {
  agentTransport: 'sdk',
});
appendChatHistoryEvents(chat.id, 'sess-pending-del', [
  { rec: { kind: 'localUser', text: 'please run' } },
]);
markChatHasPendingDelegation(chat.id);
assert.equal(getChatHistoryRevisions([chat.id])[chat.id].hasPendingDelegation, true);

getChatHistorySince(chat.id, 0, 10);
assert.equal(
  getChatHistoryRevisions([chat.id])[chat.id].hasPendingDelegation,
  true,
  'History reads from another client must not clear the pending-delegation hint'
);

clearChatHasPendingDelegation(chat.id);
assert.equal(getChatHistoryRevisions([chat.id])[chat.id].hasPendingDelegation, false);

console.log('All chat-history-pending-delegation tests passed.');
