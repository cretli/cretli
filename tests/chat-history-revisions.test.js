import assert from 'node:assert/strict';
import {
  bumpChatHistoryRevision,
  clearChatHistoryRevision,
  getChatHistoryRevision,
  getChatHistoryRevisions,
  markChatHasPendingDelegation,
  clearChatHasPendingDelegation,
  seedChatHistoryRevision,
  seedChatHistoryRevisionsFromIndex,
} from '../lib/persist/chat-history-revisions.js';

const chatId = 'chat-rev-test-1';

clearChatHistoryRevision(chatId);
assert.equal(getChatHistoryRevision(chatId), null);

const seededCount = seedChatHistoryRevisionsFromIndex({
  [chatId]: { headSeq: 11, updatedAt: '2026-07-19T00:00:00.000Z' },
  'chat-rev-test-2': { headSeq: 4, updatedAt: '2026-07-19T00:01:00.000Z' },
});
assert.equal(seededCount, 2);
assert.equal(getChatHistoryRevision(chatId)?.headSeq, 11);

const bumped = bumpChatHistoryRevision(chatId, 15);
assert.equal(bumped.headSeq, 15);
assert.equal(bumped.revision, 2);

const reseed = seedChatHistoryRevision(chatId, 10, '2026-07-19T00:02:00.000Z');
assert.equal(reseed.headSeq, 15);

const first = bumpChatHistoryRevision('chat-rev-test-3', 3);
assert.equal(first.headSeq, 3);
assert.equal(first.revision, 1);
assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

const second = bumpChatHistoryRevision('chat-rev-test-3', 7);
assert.equal(second.headSeq, 7);
assert.equal(second.revision, 2);

const filtered = getChatHistoryRevisions(['chat-rev-test-3', 'missing-chat']);
assert.equal(filtered['chat-rev-test-3'].headSeq, second.headSeq);
assert.equal(filtered['chat-rev-test-3'].revision, second.revision);
assert.equal(filtered['chat-rev-test-3'].hasPendingDelegation, false);
assert.equal(filtered['missing-chat'], undefined);

markChatHasPendingDelegation('chat-rev-test-3');
assert.equal(getChatHistoryRevisions(['chat-rev-test-3'])['chat-rev-test-3'].hasPendingDelegation, true);
clearChatHasPendingDelegation('chat-rev-test-3');

clearChatHistoryRevision(chatId);
clearChatHistoryRevision('chat-rev-test-2');
clearChatHistoryRevision('chat-rev-test-3');
assert.equal(getChatHistoryRevision(chatId), null);

console.log('All chat-history-revisions tests passed.');
