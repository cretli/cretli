import assert from 'node:assert/strict';
import { getChatHistoryRevisions } from '../app_front/api.js';
import {
  MAX_CHAT_REVISIONS_BATCH,
  MAX_CHAT_IDS_QUERY_LENGTH,
} from '../app_front/lib/chatIdsQuery.js';

const previousFetch = globalThis.fetch;
/** @type {Array<{ url: string, body: unknown }>} */
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  let body = null;
  if (init.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = init.body;
    }
  }
  calls.push({ url: path, body, method: init.method || 'GET' });
  const idsParam = path.includes('ids=') ? decodeURIComponent(path.split('ids=')[1] || '') : '';
  const postIds = Array.isArray(body?.ids) ? body.ids : [];
  const requested = idsParam
    ? idsParam.split(',').filter(Boolean)
    : postIds;
  /** @type {Record<string, { headSeq: number }>} */
  const revisions = {};
  for (const id of requested) {
    revisions[id] = { headSeq: 1, hasPendingDelegation: false };
  }
  if (requested.length === 0 && !path.includes('history-revisions-batch')) {
    revisions['global-only'] = { headSeq: 99, hasPendingDelegation: false };
  }
  return {
    status: 200,
    async json() {
      return { ok: true, revisions };
    },
  };
};

try {
  calls.length = 0;
  const emptyScope = await getChatHistoryRevisions();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/chats\/history-revisions$/);
  assert.ok(emptyScope.revisions?.['global-only']);

  calls.length = 0;
  const shortIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
  const shortResult = await getChatHistoryRevisions(shortIds);
  assert.equal(shortResult.ok, true);
  assert.equal(Object.keys(shortResult.revisions || {}).length, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /history-revisions\?ids=/);

  calls.length = 0;
  const manyIds = Array.from({ length: 80 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const joined = manyIds.join(',');
  assert.ok(joined.length > MAX_CHAT_IDS_QUERY_LENGTH);
  const manyResult = await getChatHistoryRevisions(manyIds);
  assert.equal(manyResult.ok, true);
  assert.equal(Object.keys(manyResult.revisions || {}).length, manyIds.length);
  const expectedParts = Math.ceil(manyIds.length / MAX_CHAT_REVISIONS_BATCH);
  assert.equal(calls.length, expectedParts);
  for (const call of calls) {
    if (call.method === 'POST') {
      assert.match(call.url, /history-revisions-batch$/);
      assert.ok(Array.isArray(call.body?.ids));
      assert.ok(call.body.ids.length <= MAX_CHAT_REVISIONS_BATCH);
      continue;
    }
    assert.match(call.url, /history-revisions\?ids=/);
  }
  const fetchedIds = new Set();
  for (const call of calls) {
    if (call.method === 'POST') {
      for (const id of call.body.ids) fetchedIds.add(id);
      continue;
    }
    const qs = call.url.split('ids=')[1] || '';
    for (const id of decodeURIComponent(qs).split(',').filter(Boolean)) fetchedIds.add(id);
  }
  assert.deepEqual([...fetchedIds].sort(), [...manyIds].sort());

  console.log('chat-history-revisions-explicit-fetch.test.js OK');
} finally {
  globalThis.fetch = previousFetch;
}
