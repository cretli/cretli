import assert from 'node:assert/strict';
import {
  MAX_CHAT_HISTORY_BATCH,
  MAX_CHAT_IDS_QUERY_LENGTH,
  MAX_CHAT_REVISIONS_BATCH,
  buildChatHistoryBatchBody,
  buildChatHistoryRevisionsBatchBody,
  buildChatIdsQuery,
  chunkExplicitChatIds,
  fitsChatIdsQuery,
} from '../app_front/lib/chatIdsQuery.js';

assert.equal(buildChatIdsQuery(), '');
assert.equal(buildChatIdsQuery([]), '');
assert.equal(buildChatIdsQuery(['', '  ']), '');
assert.equal(buildChatIdsQuery(['a', 'b']), 'ids=a%2Cb');

const small = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
assert.match(buildChatIdsQuery(small), /^ids=/);

const tooMany = Array.from({ length: 80 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
const joined = tooMany.join(',');
assert.ok(joined.length > MAX_CHAT_IDS_QUERY_LENGTH);
assert.equal(buildChatIdsQuery(tooMany), null);
assert.equal(fitsChatIdsQuery(tooMany), false);
assert.equal(fitsChatIdsQuery(small), true);

const chunks = chunkExplicitChatIds(tooMany);
assert.ok(chunks.length >= 3);
assert.equal(chunks.flat().length, tooMany.length);
assert.ok(chunks.every((part) => part.length <= MAX_CHAT_REVISIONS_BATCH));

assert.equal(buildChatHistoryRevisionsBatchBody([]), null);
assert.deepEqual(buildChatHistoryRevisionsBatchBody(['a', 'b']), { ids: ['a', 'b'] });
const overflowRevisions = Array.from({ length: MAX_CHAT_REVISIONS_BATCH + 3 }, (_, i) => `id-${i}`);
assert.equal(buildChatHistoryRevisionsBatchBody(overflowRevisions)?.ids.length, MAX_CHAT_REVISIONS_BATCH);

assert.equal(buildChatHistoryBatchBody(), null);
assert.equal(buildChatHistoryBatchBody([]), null);
assert.equal(buildChatHistoryBatchBody([{ id: '' }]), null);
assert.deepEqual(buildChatHistoryBatchBody([{ id: 'a', since: 3 }]), {
  chats: [{ id: 'a', since: 3 }],
});
const overflowBatch = Array.from({ length: MAX_CHAT_HISTORY_BATCH + 5 }, (_, i) => ({
  id: `chat-${i}`,
  since: 0,
}));
assert.equal(buildChatHistoryBatchBody(overflowBatch)?.chats.length, MAX_CHAT_HISTORY_BATCH);

console.log('All chatIdsQuery tests passed.');
