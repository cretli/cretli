import assert from 'node:assert/strict';
import { archiveChat, deleteChat, getChats } from '../app_front/api.js';

const previousFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return {
    status: 200,
    async json() {
      return { ok: true, chats: [] };
    },
  };
};

try {
  await getChats({
    pinnedTo: 'https://docs.example.com/page',
    includeArchived: true,
  });
  assert.equal(
    calls[0].url,
    '/api/chats?pinnedTo=https%3A%2F%2Fdocs.example.com%2Fpage&includeArchived=1'
  );
  await archiveChat('chat-1', true);
  assert.equal(calls[1].url, '/api/chats/chat-1');
  assert.equal(calls[1].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body || '{}')), { archived: true });
  await deleteChat('chat-2');
  assert.equal(calls[2].url, '/api/chats/chat-2');
  assert.equal(calls[2].init?.method, 'DELETE');
  console.log('chat-api-archive.test.js OK');
} finally {
  globalThis.fetch = previousFetch;
}
