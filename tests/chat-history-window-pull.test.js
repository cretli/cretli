import assert from 'node:assert/strict';

// Minimal browser surface the frontend store touches — must exist before the dynamic import.
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

/** @type {string[]} */
const requestedUrls = [];
/** @type {unknown} */
let nextPayload = null;

globalThis.fetch = async (url) => {
  requestedUrls.push(String(url));
  return { status: 200, json: async () => nextPayload };
};

const {
  getOldestLoadedSeq,
  getLastAckedSeq,
  pullChatHistoryTailFromServer,
  pullChatHistoryOlderFromServer,
  resetLastAckedSeqMemoryForTests,
} = await import('../app_front/lib/sdk-chat-history-store.js');

let failed = 0;

async function runCase(name, fn) {
  requestedUrls.length = 0;
  storage.clear();
  resetLastAckedSeqMemoryForTests();
  try {
    await fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

await runCase('pullChatHistoryTailFromServer: requests a tail, not the whole log', async () => {
  nextPayload = {
    ok: true,
    cursorSessionId: 'sess-1',
    headSeq: 500,
    oldestSeq: 1,
    hasOlder: true,
    events: [
      { seq: 421, rec: { kind: 'localUser', text: 'a', clientSeq: 9 } },
      { seq: 422, rec: { kind: 'localUser', text: 'b' } },
    ],
  };
  const actual = await pullChatHistoryTailFromServer('chat-1', { tail: 80 });
  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /\/api\/chats\/chat-1\/history\?tail=80$/);
  assert.equal(actual?.events.length, 2);
  assert.equal(actual?.oldestLoadedSeq, 421);
  assert.equal(actual?.hasOlder, true);
  assert.equal(getLastAckedSeq('chat-1'), 500);
  assert.equal(getOldestLoadedSeq('chat-1'), 421);
});

await runCase('pullChatHistoryTailFromServer: strips clientSeq from records', async () => {
  nextPayload = {
    ok: true,
    cursorSessionId: 'sess-1',
    headSeq: 3,
    hasOlder: false,
    events: [{ seq: 3, rec: { kind: 'localUser', text: 'a', clientSeq: 7 } }],
  };
  const actual = await pullChatHistoryTailFromServer('chat-2', { tail: 10 });
  assert.deepEqual(actual?.events, [{ kind: 'localUser', text: 'a' }]);
});

await runCase('pullChatHistoryTailFromServer: no older means a zeroed cursor', async () => {
  nextPayload = {
    ok: true,
    cursorSessionId: 'sess-1',
    headSeq: 2,
    oldestSeq: 1,
    hasOlder: false,
    events: [{ seq: 1, rec: { kind: 'localUser', text: 'a' } }],
  };
  await pullChatHistoryTailFromServer('chat-3', { tail: 80 });
  assert.equal(getOldestLoadedSeq('chat-3'), 0);
});

await runCase('pullChatHistoryOlderFromServer: pages back without moving the ack', async () => {
  nextPayload = {
    ok: true,
    cursorSessionId: 'sess-1',
    headSeq: 500,
    oldestSeq: 1,
    hasOlder: true,
    events: [
      { seq: 341, rec: { kind: 'localUser', text: 'older-1' } },
      { seq: 342, rec: { kind: 'localUser', text: 'older-2' } },
    ],
  };
  const actual = await pullChatHistoryOlderFromServer('chat-4', { beforeSeq: 421, limit: 80 });
  assert.match(requestedUrls[0], /\/api\/chats\/chat-4\/history\?tail=80&before=421$/);
  assert.equal(actual?.events.length, 2);
  assert.equal(actual?.oldestLoadedSeq, 341);
  assert.equal(actual?.hasOlder, true);
  assert.equal(getLastAckedSeq('chat-4'), 0, 'paging back must not advance the sync cursor');
  assert.equal(getOldestLoadedSeq('chat-4'), 0, 'paging back must not move the cache window');
});

await runCase('pullChatHistoryOlderFromServer: no cursor means nothing to fetch', async () => {
  const actual = await pullChatHistoryOlderFromServer('chat-5', { beforeSeq: 0 });
  assert.deepEqual(actual, { events: [], oldestLoadedSeq: 0, hasOlder: false });
  assert.equal(requestedUrls.length, 0);
});

if (failed > 0) {
  console.error(`\nChat history window pull tests failed: ${failed}`);
  process.exit(1);
}

console.log('\nAll chat history window pull tests passed.');
