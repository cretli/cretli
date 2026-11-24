import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_PAGE_MAX_LIMIT, CHAT_PAGE_MAX_BYTES, boundChatPage } from '../lib/chat-page-limits.js';
import { CHAT_CATALOG_PAGE_MAX_LIMIT, createChatCatalog, readChatCatalog } from '../lib/chat-catalog.js';
import { CHATS_PAGE_MAX_LIMIT } from '../lib/storage/chats-store.js';
import { importChatsBatchAsync, pageChatsAsync } from '../lib/persist/chats-persist.js';
import { runOnChatsBackends } from './helpers/chats-backends.js';

test.after(removeIsolatedDataDir);

test('catalog and both persistence backends enforce the shared cap and traverse 273 chats', async () => {
  assert.equal(CHAT_PAGE_MAX_LIMIT, 100);
  assert.equal(CHAT_CATALOG_PAGE_MAX_LIMIT, CHAT_PAGE_MAX_LIMIT);
  assert.equal(CHATS_PAGE_MAX_LIMIT, CHAT_PAGE_MAX_LIMIT);
  const rows = Array.from({ length: 273 }, (_, i) => ({ id: `chat-${String(i).padStart(3, '0')}`, title: `Title ${i}` }));
  const catalog = createChatCatalog(rows);
  const expected = catalog.page({ limit: 100 }).items.map((r) => r.id);
  for (const limit of [500, 5000, NaN, Infinity, 0, -1]) {
    const page = catalog.page({ limit });
    assert.ok(page.items.length <= 100 && page.items.length > 0);
    if (Number.isFinite(limit) && limit >= 100) assert.deepEqual(page.items.map((r) => r.id), expected);
  }
  await runOnChatsBackends(async (kind) => {
    await importChatsBatchAsync(rows);
    for (const limit of [500, 5000, NaN, Infinity, 0, -1]) {
      let cursor = '';
      const ids = [];
      do {
        const page = await pageChatsAsync({ archived: 'all', limit, cursor });
        assert.ok(page.items.length > 0 && page.items.length <= CHAT_PAGE_MAX_LIMIT, kind);
        if (Number.isFinite(limit) && limit >= 100) assert.equal(page.items.length, Math.min(100, 273 - ids.length), kind);
        ids.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(new Set(ids).size, 273, kind);
      assert.equal(ids.length, 273, kind);
    }
    const all = await readChatCatalog();
    assert.equal(all.size, 273, kind);
    assert.deepEqual(all.list().map((r) => r.id).sort(), rows.map((r) => r.id).sort(), kind);
  });
});

test('normal body is returned byte-identically; malformed identity and metadata fail closed', () => {
  const body = { ok: true, revision: 'r', nextCursor: null, chats: [{ id: 'a', title: 'T' }] };
  const before = JSON.stringify(body);
  assert.equal(boundChatPage(body, () => null), body);
  assert.equal(JSON.stringify(body), before);
  assert.ok(!('truncated' in body.chats[0]));
  for (const huge of [
    { ...body, chats: [{ id: 'i'.repeat(CHAT_PAGE_MAX_BYTES * 2) }] },
    { ...body, archivedCounts: { ['x'.repeat(CHAT_PAGE_MAX_BYTES * 2)]: 1 } },
    { ...body, chats: [], sync: 'x'.repeat(CHAT_PAGE_MAX_BYTES * 2) },
  ]) assert.throws(() => boundChatPage(huge, () => null), { code: 'CHAT_PAGE_TOO_LARGE' });
});
