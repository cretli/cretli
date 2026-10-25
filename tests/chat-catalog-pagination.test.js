import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CHAT_CATALOG_ERROR_CODES,
  CHAT_CATALOG_PAGE_MAX_LIMIT,
  createChatCatalog,
} from '../lib/chat-catalog.js';
import { countArchivedChatsByWorkspace } from '../lib/chat-list-payload.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';

const folders = [0, 1, 2].map((i) => path.join(ISOLATED_DATA_DIR, `ws-${i}`));
const fixture = (count = 237) => Array.from({ length: count }, (_, i) => ({
  id: `c${i}`,
  workspaceFolder: folders[i % 3],
  workspaceFile: i % 5 === 0 ? `${folders[i % 3]}.code-workspace` : undefined,
  widgetInstallationId: i % 4 === 0 ? 'w1' : i % 4 === 1 ? 'w2' : undefined,
  forkParentChatId: i > 10 && i % 7 === 0 ? `c${i - 10}` : undefined,
  archivedAt: i % 6 === 0 ? '2026-01-01T00:00:00Z' : undefined,
}));

/** Walk every page and return the concatenated ids. */
function walk(catalog, query) {
  const ids = [];
  const sizes = [];
  let cursor = '';
  for (let guard = 0; guard < 1000; guard += 1) {
    const result = catalog.page({ ...query, cursor });
    sizes.push(result.items.length);
    ids.push(...result.items.map((c) => c.id));
    if (!result.nextCursor) return { ids, sizes };
    cursor = result.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

test.after(() => removeIsolatedDataDir());

test('paged walk equals full scan (set and order) for scope, widget and archive cases', () => {
  const catalog = createChatCatalog(fixture(), { revision: 'r1' });
  const cases = [
    {},
    { archived: 'exclude' },
    { archived: 'only' },
    { scope: { workspaceFolder: folders[1] } },
    { scope: { workspaceFolder: folders[1] }, archived: 'exclude' },
    { scope: { workspaceFile: `${folders[0]}.code-workspace` } },
    { scope: { widgetInstallationId: 'w1' } },
    { scope: { widgetInstallationId: 'w2', workspaceFolder: folders[1] }, archived: 'only' },
  ];
  for (const query of cases) {
    for (const limit of [1, 7, 50, 1000]) {
      const full = catalog.list(query).map((c) => c.id);
      const paged = walk(catalog, { ...query, limit });
      assert.deepEqual(paged.ids, full, JSON.stringify({ query, limit }));
      const cap = Math.min(limit, CHAT_CATALOG_PAGE_MAX_LIMIT);
      assert.ok(paged.sizes.every((size) => size <= cap), 'page size never exceeds the limit');
    }
  }
});

test('widget controller fallback matcher is applied before limiting', () => {
  const rows = fixture();
  const matchesWorkspace = (chat) => Number(chat.id.slice(1)) % 3 === 0;
  const catalog = createChatCatalog(rows, { revision: 'r1', matchesWorkspace });
  const scope = { widgetInstallationId: 'w1', workspaceFolder: folders[0] };
  const full = catalog.list({ scope }).map((c) => c.id);
  assert.ok(full.length > 0);
  const first = catalog.page({ scope, limit: 3 });
  assert.equal(first.items.length, Math.min(3, full.length), 'page is full, not short after filtering');
  assert.deepEqual(walk(catalog, { scope, limit: 3 }).ids, full);
});

test('first page materializes a constant number of records regardless of domain size', () => {
  for (const size of [200, 5000, 20000]) {
    const catalog = createChatCatalog(fixture(size), { revision: 'r' });
    const first = catalog.page({ limit: 100 });
    assert.equal(first.items.length, 100);
    assert.ok(first.nextCursor);
  }
  assert.equal(createChatCatalog(fixture(5000)).page({ limit: 1e9 }).items.length, CHAT_CATALOG_PAGE_MAX_LIMIT);
});

test('cursor errors are typed: malformed -> INVALID_ARGUMENT, other revision -> STALE_CURSOR', () => {
  const catalog = createChatCatalog(fixture(), { revision: 'r1' });
  const { nextCursor } = catalog.page({ limit: 5 });
  assert.throws(() => catalog.page({ cursor: 'garbage' }), (e) => e.code === CHAT_CATALOG_ERROR_CODES.INVALID_ARGUMENT);
  const other = createChatCatalog(fixture(), { revision: 'r2' });
  assert.throws(() => other.page({ cursor: nextCursor }), (e) => e.code === CHAT_CATALOG_ERROR_CODES.STALE_CURSOR);
});

test('archivedCountsByWorkspace equals countArchivedChatsByWorkspace on the same rows', () => {
  const rows = fixture();
  const catalog = createChatCatalog(rows);
  assert.deepEqual({ ...catalog.archivedCountsByWorkspace() }, { ...countArchivedChatsByWorkspace(rows) });
});

test('GET /api/chats/page route walks the persisted list and matches the catalog order', async () => {
  const rows = fixture(60);
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: rows }));
  const routes = new Map();
  registerChatsRoutes({ get: (r, h) => routes.set(`GET ${r}`, h), post() {}, patch() {}, put() {}, delete() {} }, {});
  const call = (query) => {
    let status = 200;
    let body;
    routes.get('GET /api/chats/page')({ query, params: {}, body: {} }, {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
    });
    return { status, body };
  };
  const ids = [];
  let cursor = '';
  do {
    const { status, body } = call({ limit: '8', archived: 'include', cursor });
    assert.equal(status, 200);
    assert.ok(body.chats.length <= 8);
    ids.push(...body.chats.map((c) => c.id));
    cursor = body.nextCursor || '';
  } while (cursor);
  assert.deepEqual(ids, rows.map((c) => c.id));
  assert.equal(call({ cursor: 'x' }).status, 400);
});

/** Route harness that tolerates the async (harnessState) response path. */
function makeRouteCaller(ctx = {}) {
  const routes = new Map();
  registerChatsRoutes({ get: (r, h) => routes.set(`GET ${r}`, h), post() {}, patch() {}, put() {}, delete() {} }, ctx);
  return (query, extra = {}) => new Promise((resolve) => {
    let status = 200;
    routes.get('GET /api/chats/page')({ query, params: {}, body: {}, ...extra }, {
      status(code) { status = code; return this; },
      json(body) { resolve({ status, body }); return this; },
    });
  });
}

test('GET /api/chats/page: default archived mode keeps archived parents of live chats; exclude is strict', async () => {
  const rows = [
    { id: 'parent', archivedAt: '2026-01-01T00:00:00Z' },
    { id: 'child', forkParentChatId: 'parent' },
    { id: 'lonely', archivedAt: '2026-01-01T00:00:00Z' },
    { id: 'live' },
  ];
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: rows }));
  const call = makeRouteCaller();
  assert.deepEqual((await call({})).body.chats.map((c) => c.id), ['parent', 'child', 'live']);
  assert.deepEqual((await call({ archived: 'exclude' })).body.chats.map((c) => c.id), ['child', 'live']);
  assert.deepEqual((await call({ archived: 'only' })).body.chats.map((c) => c.id), ['parent', 'lonely']);
});

test('GET /api/chats/page: workspaceFolder and workspaceFile params scope the page and archivedCounts', async () => {
  const rows = fixture(30);
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: rows }));
  const call = makeRouteCaller();
  const byFolder = await call({ workspaceFolder: folders[1], archived: 'include' });
  assert.deepEqual(byFolder.body.chats.map((c) => c.id), rows.filter((c) => c.workspaceFolder === folders[1]).map((c) => c.id));
  const expectedCounts = { ...countArchivedChatsByWorkspace(rows.filter((c) => c.workspaceFolder === folders[1])) };
  assert.deepEqual({ ...byFolder.body.archivedCounts }, expectedCounts);
  const file = `${folders[0]}.code-workspace`;
  const byFile = await call({ workspaceFile: file, archived: 'include' });
  assert.deepEqual(byFile.body.chats.map((c) => c.id), rows.filter((c) => c.workspaceFile === file).map((c) => c.id));
});

test('GET /api/chats/page: widget access limits rows by installation and controller scope, and resolves pinnedTo', async () => {
  const rows = [
    { id: 'a', widgetInstallationId: 'w1' },
    { id: 'b', widgetInstallationId: 'w1' },
    { id: 'c', widgetInstallationId: 'w2' },
    { id: 'd' },
  ];
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: rows }));
  const call = makeRouteCaller({ widgetChatListScope: (chat) => chat.id !== 'b' });
  const widgetAccess = { installationId: 'w1', pageSessionId: 'p1' };
  const res = await call({}, { widgetAccess });
  assert.deepEqual(res.body.chats.map((c) => c.id), ['a']);
  assert.equal('linkedChat' in res.body, false);
  const pinned = await call({ pinnedTo: 'https://example.com/none' }, { widgetAccess });
  assert.equal(pinned.body.linkedChat, null);
  // Without widget access, pinnedTo is ignored.
  assert.equal('linkedChat' in (await call({ pinnedTo: 'x' })).body, false);
});

test('GET /api/chats/page: 409 STALE_CURSOR after the store changes, 400 on bad archived or cursor', async () => {
  const rows = fixture(20);
  const store = path.join(ISOLATED_DATA_DIR, 'chats.json');
  fs.writeFileSync(store, JSON.stringify({ chats: rows }));
  const call = makeRouteCaller();
  const first = await call({ limit: '5', archived: 'include' });
  assert.ok(first.body.nextCursor);
  fs.writeFileSync(store, JSON.stringify({ chats: [...rows, { id: 'extra-chat-with-longer-record', title: 'x'.repeat(50) }] }));
  const stale = await call({ limit: '5', archived: 'include', cursor: first.body.nextCursor });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, CHAT_CATALOG_ERROR_CODES.STALE_CURSOR);
  const bad = await call({ archived: 'bogus' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, CHAT_CATALOG_ERROR_CODES.INVALID_ARGUMENT);
});

test('GET /api/chats/page: pinnedTo returns linkedChat for a matching pinned chat, even when archived (absent from chats)', async () => {
  const pageUrl = 'https://example.com/app/page';
  const rows = [
    { id: 'a', widgetInstallationId: 'w1' },
    { id: 'pinned-hidden', widgetInstallationId: 'w1', widgetPinnedUrl: pageUrl, archivedAt: '2026-01-01T00:00:00Z' },
    { id: 'foreign', widgetInstallationId: 'w2', widgetPinnedUrl: pageUrl },
    { id: 'out-of-scope', widgetInstallationId: 'w1', widgetPinnedUrl: `${pageUrl}?x=1` },
  ];
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: rows }));
  // The archived pinned chat is dropped from `chats` (tree mode), but linkedChat is still resolved.
  const call = makeRouteCaller({ widgetChatListScope: (chat) => chat.id === 'a' || chat.id === 'pinned-hidden' });
  const widgetAccess = { installationId: 'w1', pageSessionId: 'p1' };
  const res = await call({ pinnedTo: pageUrl }, { widgetAccess });
  assert.deepEqual(res.body.chats.map((c) => c.id), ['a']);
  assert.equal(res.body.linkedChat.id, 'pinned-hidden');
  // view=list omits linkedChat entirely.
  assert.equal('linkedChat' in (await call({ pinnedTo: pageUrl, view: 'list' }, { widgetAccess })).body, false);
});

test('tree mode: independent full walk across page boundaries yields literal ids', () => {
  const archivedAt = '2026-01-01T00:00:00Z';
  const rows = [
    { id: 'p1', archivedAt },
    { id: 'x1' },
    { id: 'c1', forkParentChatId: 'p1' },
    { id: 'x2' },
    { id: 'lonely', archivedAt },
    { id: 'x3' },
    { id: 'p2', archivedAt },
    { id: 'c2', forkParentChatId: 'p2' },
    { id: 'x4' },
  ];
  const catalog = createChatCatalog(rows);
  const walked = walk(catalog, { archived: 'tree', limit: 3 });
  assert.deepEqual(walked.ids, ['p1', 'x1', 'c1', 'x2', 'x3', 'p2', 'c2', 'x4']);
  assert.deepEqual(walked.sizes, [3, 3, 2]);
  assert.deepEqual(walk(catalog, { archived: 'exclude', limit: 3 }).ids, ['x1', 'c1', 'x2', 'x3', 'c2', 'x4']);
});
