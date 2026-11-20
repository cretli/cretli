import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { importChatsBatchAsync, pageChatsAsync, chatCountsAsync } from '../lib/persist/chats-persist.js';
import { readChatCatalog } from '../lib/chat-catalog.js';
import { toChatListDto } from '../lib/chat-list-dto.js';
import { readChatTreeAsync, collectArchivedAncestorIdsAsync } from '../lib/chat-tree-async.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { runOnChatsBackends } from './helpers/chats-backends.js';

const folders = [0, 1, 2].map((i) => path.join(ISOLATED_DATA_DIR, `ws-${i}`));
const ARCHIVED = '2026-01-01T00:00:00.000Z';

/** Same fixture for both backends: ties on activity, archived chains, root/child mix, folder/file scopes. */
function fixture() {
  return Array.from({ length: 60 }, (_, i) => {
    const chat = {
      id: `c${String(i).padStart(2, '0')}`,
      title: `Chat ${i}`,
      titleSource: 'manual',
      workspaceFolder: i % 9 === 8 ? undefined : folders[i % 3],
      workspaceFile: i % 9 === 8 ? `${folders[i % 3]}.code-workspace` : undefined,
      createdAt: `2026-02-01T00:${String(i % 20).padStart(2, '0')}:00.000Z`,
    };
    // Fields that SQLite keeps in extra_json (not in index columns or light_json).
    if (i % 5 !== 1) {
      chat.delegationParentChatId = `parent-${i}`; chat.delegationId = `del-${i}`; chat.delegationDepth = i % 3;
      chat.delegationRootChatId = `root-${i % 4}`; chat.delegationAssignment = 'implement'; chat.pickPurpose = `purpose-${i}`;
      chat.customExtra = { nested: [i] };
    }
    if (i % 4 === 0) chat.updatedAt = `2026-03-01T00:${String(i % 10).padStart(2, '0')}:00.000Z`;
    if (i % 6 === 0 || i === 13 || i === 26) chat.archivedAt = ARCHIVED;
    if (i > 12) chat.forkParentChatId = `c${String(i - (i % 3 === 0 ? 13 : 12)).padStart(2, '0')}`;
    return chat;
  }).filter((chat) => chat.id !== 'c07');
}

const scopes = [
  undefined,
  { workspaceFolder: folders[1] },
  { workspaceFile: `${folders[2]}.code-workspace` },
  { workspaceFolder: folders[0], workspaceFile: `${folders[2]}.code-workspace` },
];
const modes = ['all', 'live', 'archived', 'tree'];

async function walk(scope, archived, limit) {
  const ids = [];
  const ancestors = new Set();
  let cursor = '';
  for (let guard = 0; guard < 100; guard += 1) {
    const result = await pageChatsAsync({ scope, archived, limit, cursor });
    assert.ok(result.items.length <= limit);
    ids.push(...result.items.map((c) => c.id));
    for (const a of result.ancestors || []) ancestors.add(a.id);
    if (!result.nextCursor) return { ids, ancestors: [...ancestors].sort() };
    cursor = result.nextCursor;
  }
  throw new Error('walk did not terminate');
}

/** Drops store-internal bookkeeping so records compare by content. */
function normalize(chat) {
  const { lastActivityAt: _a, revision: _r, position: _p, ancestor: _anc, ...rest } = chat;
  return JSON.parse(JSON.stringify(rest));
}

async function snapshotBackend() {
  await importChatsBatchAsync(fixture());
  const out = { pages: {}, counts: {}, catalog: {}, tree: {} };
  for (const [si, scope] of scopes.entries()) {
    out.counts[si] = await chatCountsAsync({ scope });
    delete out.counts[si].revision; delete out.counts[si].storeRevision;
    for (const mode of modes) {
      for (const limit of [1, 7, 500]) out.pages[`${si}/${mode}/${limit}`] = await walk(scope, mode, limit);
    }
    const tree = await readChatTreeAsync({ scope, pageSize: 5 });
    out.tree[si] = { ids: tree.chats.map((c) => c.id), ancestors: tree.ancestors.map((c) => c.id).sort() };
    assert.deepEqual([...await collectArchivedAncestorIdsAsync({ scope })].sort(), out.tree[si].ancestors);
  }
  const catalog = await readChatCatalog();
  out.catalog = {
    size: catalog.size,
    live: catalog.list({ archived: 'exclude' }).map((c) => c.id).sort(),
    archived: catalog.list({ archived: 'only' }).map((c) => c.id).sort(),
    tree: catalog.list({ archived: 'tree', scope: { workspaceFolder: folders[1] } }).map((c) => c.id).sort(),
    scope: catalog.list({ scope: { workspaceFolder: folders[2] } }).map((c) => c.id).sort(),
    counts: catalog.counts({ scope: { workspaceFolder: folders[0] } }),
    records: Object.fromEntries(catalog.list().map((c) => [c.id, normalize(catalog.get(c.id))])),
    dtos: Object.fromEntries(catalog.list().map((c) => [c.id, toChatListDto(catalog.get(c.id))])),
    pageIds: catalog.page({ archived: 'tree', limit: 9 }).items.map((c) => c.id),
  };
  return out;
}

test.after(() => removeIsolatedDataDir());

test('legacy and SQLite facades give identical pages, counts, tree and catalog for one fixture', async () => {
  const results = {};
  await runOnChatsBackends(async (kind) => { results[kind] = await snapshotBackend(); });
  assert.deepEqual(Object.keys(results).sort(), ['legacy', 'sqlite']);
  // The fixture is non-trivial: pages walk several times and tree mode finds archived ancestors.
  assert.ok(results.legacy.pages['0/all/7'].ids.length > 50);
  assert.ok(results.legacy.tree[0].ancestors.length > 0);
  assert.ok(results.legacy.counts[0].archived > 0);
  assert.deepEqual(results.sqlite.counts, results.legacy.counts, 'counts');
  assert.deepEqual(results.sqlite.pages, results.legacy.pages, 'live/archived/tree/all page walks per scope');
  assert.deepEqual(results.sqlite.tree, results.legacy.tree, 'async tree read');
  assert.deepEqual(results.sqlite.catalog, results.legacy.catalog, 'catalog snapshot, get(id) records and list DTOs');
  const sample = results.sqlite.catalog.records.c14;
  assert.equal(sample.delegationId, 'del-14', 'delegation fields survive the SQLite catalog');
  assert.equal(results.sqlite.catalog.dtos.c14.pickPurpose, 'purpose-14');
  assert.deepEqual(sample.customExtra, { nested: [14] });
});

test('page limit is respected by both adapters without walking the full snapshot into one page', async () => {
  await runOnChatsBackends(async () => {
    await importChatsBatchAsync(fixture());
    const first = await pageChatsAsync({ archived: 'all', limit: 5 });
    assert.equal(first.items.length, 5);
    assert.ok(first.nextCursor);
    await assert.rejects(() => pageChatsAsync({ archived: 'nope' }));
  });
});

function makeRouteCaller() {
  const routes = new Map();
  registerChatsRoutes({ get: (r, h) => routes.set(`GET ${r}`, h), post() {}, patch() {}, put() {}, delete() {} }, {});
  return (query) => new Promise((resolve) => {
    let status = 200;
    routes.get('GET /api/chats/page')({ query, params: {}, body: {} }, {
      status(code) { status = code; return this; },
      json(body) { resolve({ status, body }); return this; },
    });
  });
}

async function routeSnapshot() {
  await importChatsBatchAsync(fixture());
  const call = makeRouteCaller();
  const out = { walks: {}, counts: {} };
  for (const archived of ['include', 'exclude', 'only', 'tree']) {
    const ids = [];
    let cursor = '';
    for (let guard = 0; guard < 100; guard += 1) {
      const { status, body } = await call({ limit: '8', archived, cursor });
      assert.equal(status, 200);
      assert.ok(body.chats.length <= 8 + 8, 'tree pages may add archived ancestors');
      ids.push(...body.chats.map((c) => c.id));
      out.counts[archived] = { ...body.archivedCounts };
      cursor = body.nextCursor || '';
      if (!cursor) break;
    }
    out.walks[archived] = ids;
  }
  const dflt = await call({ archived: 'include' });
  const huge = await call({ archived: 'include', limit: '100000' });
  out.defaultLen = dflt.body.chats.length;
  out.hugeLen = huge.body.chats.length;
  out.bad = (await call({ cursor: 'not-a-cursor' })).status;
  return out;
}

test('GET /api/chats/page gives identical pages, default limit and bad-cursor error on both adapters', async () => {
  const results = {};
  await runOnChatsBackends(async (kind) => { results[kind] = await routeSnapshot(); });
  assert.deepEqual(results.sqlite, results.legacy);
  assert.equal(results.legacy.defaultLen, 50);
  assert.equal(results.legacy.bad, 400);
  assert.ok(results.legacy.hugeLen > 50 && results.legacy.hugeLen <= 500);
  assert.ok(results.legacy.walks.tree.length > results.legacy.walks.exclude.length, 'tree adds archived ancestors');
  assert.equal(new Set(results.legacy.walks.tree).size, results.legacy.walks.tree.length, 'each row once');
});
