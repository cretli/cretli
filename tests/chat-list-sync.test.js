import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createChatCatalog } from '../lib/chat-catalog.js';
import { CHAT_LIST_DTO_FIELDS, toChatListDto } from '../lib/chat-list-dto.js';
import {
  __resetChatListSyncStateForTest,
  buildChatListSyncResponse,
  createChatListSyncState,
  formatSyncToken,
  parseSyncToken,
} from '../lib/chat-list-sync.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.ts';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';

const folder = path.join(ISOLATED_DATA_DIR, 'ws');
const row = (i, extra = {}) => ({
  id: `c${i}`, title: `T${i}`, workspaceFolder: folder, createdAt: '2026-01-01T00:00:00Z', ...extra,
});
const rows = (n) => Array.from({ length: n }, (_, i) => row(i));
const cat = (list, revision) => createChatCatalog(list, { revision });
const tok = (r) => `${r.epoch}.${r.seq}`;

test.after(() => removeIsolatedDataDir());

test('DTO is an allowlist: no history, summaries, provider session ids or execution paths', () => {
  const dto = toChatListDto({
    ...row(1), summaries: [{ x: 1 }], cursorSessionId: 's', claudeSessionId: 'cl', executionFolder: '/tmp/x',
    history: [1, 2], nested: { a: 1 }, archivedAt: '2026-02-01T00:00:00Z',
  }, { onWorktree: true });
  assert.equal(dto.onWorktree, true);
  assert.equal(dto.archivedAt, '2026-02-01T00:00:00Z');
  for (const key of ['summaries', 'cursorSessionId', 'claudeSessionId', 'executionFolder', 'history', 'nested']) {
    assert.equal(key in dto, false, key);
  }
  assert.ok(Object.keys(dto).every((k) => CHAT_LIST_DTO_FIELDS.includes(k) || k === 'onWorktree'));
  assert.equal(toChatListDto({ title: 'no id' }), null);
});

test('token parse/format round-trip; malformed tokens are rejected', () => {
  assert.deepEqual(parseSyncToken('abc-1.42'), { epoch: 'abc-1', seq: 42 });
  assert.equal(formatSyncToken({ epoch: 'e', seq: 3 }), 'e.3');
  for (const bad of ['', 'x', 'e.', '.1', 'e.-1', 'e.1.2', 'a b.1']) assert.equal(parseSyncToken(bad), null, bad);
  const state = createChatListSyncState({ epoch: 'e' });
  assert.throws(() => buildChatListSyncResponse(state, cat(rows(2), 'r1'), { since: 'bad' }), (e) => e.code === 'INVALID_ARGUMENT');
});

test('observe is memoized per revision: concurrent requests share one pass', () => {
  const state = createChatListSyncState({ epoch: 'e' });
  let listCalls = 0;
  const base = cat(rows(5), 'r1');
  const counting = { revision: 'r1', list: (...a) => { listCalls += 1; return base.list(...a); } };
  const a = state.observe(counting);
  for (let i = 0; i < 50; i += 1) state.observe(counting);
  assert.equal(listCalls, 1);
  assert.equal(a.seq, 1);
  assert.equal(state.observe(counting).seq, 1);
});

test('no since -> resync; same seq -> noop; delta carries only changed rows; removal is reported', () => {
  const state = createChatListSyncState({ epoch: 'e' });
  const r1 = buildChatListSyncResponse(state, cat(rows(5), 'r1'), {});
  assert.deepEqual([r1.mode, r1.reason], ['resync', 'no-since']);
  const noop = buildChatListSyncResponse(state, cat(rows(5), 'r1'), { since: tok(r1) });
  assert.equal(noop.mode, 'noop');
  const next = rows(5);
  next[2] = { ...next[2], title: 'renamed' };
  next.splice(4, 1);
  const delta = buildChatListSyncResponse(state, cat(next, 'r2'), { since: tok(r1) });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.upserts.map((d) => [d.id, d.title]), [['c2', 'renamed']]);
  assert.deepEqual(delta.removed, ['c4']);
  assert.equal(delta.seq, r1.seq + 1);
  // duplicate delivery: asking again with the same old token yields the same delta (idempotent)
  const again = buildChatListSyncResponse(state, cat(next, 'r2'), { since: tok(r1) });
  assert.deepEqual(again, delta);
});

test('A->B->A inside the window still reports the row (client upsert is idempotent), merged to one entry', () => {
  const state = createChatListSyncState({ epoch: 'e' });
  const r1 = buildChatListSyncResponse(state, cat(rows(3), 'r1'), {});
  const b = rows(3); b[1] = { ...b[1], title: 'B' };
  buildChatListSyncResponse(state, cat(b, 'r2'), {});
  const delta = buildChatListSyncResponse(state, cat(rows(3), 'r3'), { since: tok(r1) });
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.upserts.length, 1);
  assert.equal(delta.upserts[0].title, 'T1');
});

test('restart (epoch change), ahead, gap (ring overflow) and too-large force an explicit resync', () => {
  const state = createChatListSyncState({ epoch: 'e', ringSize: 3, maxRows: 5 });
  const r1 = buildChatListSyncResponse(state, cat(rows(3), 'r1'), {});
  assert.equal(buildChatListSyncResponse(state, cat(rows(3), 'r1'), { since: 'other.1' }).reason, 'epoch');
  assert.equal(buildChatListSyncResponse(state, cat(rows(3), 'r1'), { since: 'e.99' }).reason, 'ahead');
  let list = rows(3);
  for (let i = 0; i < 5; i += 1) {
    list = list.map((c, idx) => (idx === 0 ? { ...c, title: `v${i}` } : c));
    buildChatListSyncResponse(state, cat(list, `r${i + 2}`), {});
  }
  assert.equal(buildChatListSyncResponse(state, cat(list, 'r6'), { since: tok(r1) }).reason, 'gap');
  const big = rows(30);
  const before = buildChatListSyncResponse(state, cat(big, 'big0'), {});
  const changed = big.map((c) => ({ ...c, title: 'x' }));
  const resp = buildChatListSyncResponse(state, cat(changed, 'big1'), { since: tok(before) });
  assert.deepEqual([resp.mode, resp.reason], ['resync', 'too-large']);
});

test('archived ancestors travel with an un-archived child (no orphan)', () => {
  const state = createChatListSyncState({ epoch: 'e' });
  const base = [row(0, { archivedAt: '2026-02-01T00:00:00Z' }), row(1, { forkParentChatId: 'c0', archivedAt: '2026-02-01T00:00:00Z' })];
  const r1 = buildChatListSyncResponse(state, cat(base, 'r1'), {});
  const next = [base[0], { ...base[1], archivedAt: undefined }];
  const delta = buildChatListSyncResponse(state, cat(next, 'r2'), { since: tok(r1) });
  assert.deepEqual(delta.upserts.map((d) => d.id).sort(), ['c0', 'c1']);
});

test('widget scope: foreign chats never appear as upserts or removals; scope exit becomes removal', () => {
  const state = createChatListSyncState({ epoch: 'e' });
  const widget = { installationId: 'w1', pageSessionId: 'p1' };
  const matcher = (chat) => widgetChatListScope(chat, widget);
  const scope = { widgetInstallationId: 'w1' };
  const mine = (i, extra = {}) => row(i, { widgetInstallationId: 'w1', widgetPageSessionId: 'p1', ...extra });
  const theirs = (i) => row(i, { widgetInstallationId: 'w2', widgetPageSessionId: 'p9' });
  const base = [mine(0), mine(1), theirs(2), theirs(3)];
  const r1 = buildChatListSyncResponse(state, cat(base, 'r1'), { scope, matcher });
  const next = [mine(0, { title: 'mine-renamed' }), mine(1, { widgetPageSessionId: 'other-page' }), { ...theirs(2), title: 'secret' }];
  const delta = buildChatListSyncResponse(state, cat(next, 'r2'), { since: tok(r1), scope, matcher });
  assert.deepEqual(delta.upserts.map((d) => d.id), ['c0']);
  assert.deepEqual(delta.removed, ['c1'], 'c3 deletion (foreign) is not disclosed; c1 left the page scope');
  const text = JSON.stringify(delta);
  assert.equal(text.includes('c2'), false);
  assert.equal(text.includes('c3'), false);
  assert.equal(text.includes('secret'), false);
});

test('controlled burst: 200 updates of one entity are single-row deltas, never a resync', () => {
  const state = createChatListSyncState({ epoch: 'e' });
  let list = rows(2000);
  let position = buildChatListSyncResponse(state, cat(list, 'r0'), {});
  for (let i = 1; i <= 200; i += 1) {
    list = list.map((c, idx) => (idx === 7 ? { ...c, title: `burst-${i}` } : c));
    const delta = buildChatListSyncResponse(state, cat(list, `r${i}`), { since: tok(position) });
    assert.equal(delta.mode, 'delta');
    assert.deepEqual(delta.upserts.map((d) => d.id), ['c7']);
    assert.ok(JSON.stringify(delta).length < 2048, 'delta stays tiny regardless of list size');
    position = delta;
  }
  // a client that skipped all of them still gets ONE delta of ONE row (within the ring)
  const small = createChatListSyncState({ epoch: 'e2' });
  const first = buildChatListSyncResponse(small, cat(rows(50), 'a0'), {});
  let l2 = rows(50);
  for (let i = 1; i <= 20; i += 1) {
    l2 = l2.map((c, idx) => (idx === 3 ? { ...c, title: `b${i}` } : c));
    buildChatListSyncResponse(small, cat(l2, `a${i}`), {});
  }
  const merged = buildChatListSyncResponse(small, cat(l2, 'a20'), { since: tok(first) });
  assert.equal(merged.mode, 'delta');
  assert.equal(merged.upserts.length, 1);
});

function makeApp() {
  const routes = new Map();
  registerChatsRoutes({ get: (r, h) => routes.set(`GET ${r}`, h), post() {}, patch() {}, put() {}, delete() {} }, {
    widgetChatListScope,
  });
  return (route, query, extra = {}) => new Promise((resolve) => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(body) { resolve({ status, body }); return this; },
    };
    routes.get(`GET ${route}`)({ query, params: {}, body: {}, ...extra }, res);
  });
}
const writeStore = (list) => fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'chats.json'), JSON.stringify({ chats: list }));

test('routes: page(view=list) -> sync token -> delta; tree mode keeps archived parents; stale cursor is 409', async () => {
  __resetChatListSyncStateForTest();
  const list = [
    row(0, { archivedAt: '2026-02-01T00:00:00Z' }),
    row(1, { forkParentChatId: 'c0' }),
    row(2, { archivedAt: '2026-02-01T00:00:00Z' }),
    row(3, { summaries: [{ big: 'x'.repeat(100) }], cursorSessionId: 'secret-session' }),
  ];
  writeStore(list);
  const call = makeApp();
  const strict = await call('/api/chats/page', { archived: 'exclude', view: 'list' });
  assert.deepEqual(strict.body.chats.map((c) => c.id), ['c1', 'c3'], 'strict exclude orphans c1 (documented difference)');
  const tree = await call('/api/chats/page', { archived: 'tree', view: 'list', limit: '2' });
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.body.chats.map((c) => c.id), ['c0', 'c1']);
  assert.equal(tree.body.dtoVersion, 1);
  assert.match(tree.body.sync, /^[A-Za-z0-9-]+\.\d+$/);
  assert.equal(JSON.stringify(tree.body).includes('secret-session'), false);
  assert.equal(JSON.stringify(tree.body).includes('summaries'), false);
  // stale cursor after the store changes -> 409
  writeStore([...list, row(4)]);
  const stale = await call('/api/chats/page', { archived: 'tree', view: 'list', limit: '2', cursor: tree.body.nextCursor });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_CURSOR');
  // delta from the page token sees only the added row
  const delta = await call('/api/chats/sync', { since: tree.body.sync });
  assert.equal(delta.body.mode, 'delta');
  assert.deepEqual(delta.body.upserts.map((d) => d.id), ['c4']);
  assert.ok(delta.body.archivedCounts);
  assert.equal((await call('/api/chats/sync', { since: 'bad' })).status, 400);
  assert.equal((await call('/api/chats/sync', {})).body.mode, 'resync');
});

test('routes: widget access is enforced on page and sync identically (no foreign ids or rows)', async () => {
  __resetChatListSyncStateForTest();
  const mine = (i, extra = {}) => row(i, { widgetInstallationId: 'w1', widgetPageSessionId: 'p1', ...extra });
  const other = (i) => row(i, { widgetInstallationId: 'w2', widgetPageSessionId: 'p2', title: 'foreign' });
  writeStore([mine(0), other(1), mine(2, { widgetPageSessionId: 'p-other' })]);
  const call = makeApp();
  const widgetReq = { widgetAccess: { installationId: 'w1', pageSessionId: 'p1' } };
  const page = await call('/api/chats/page', { view: 'list', archived: 'include' }, widgetReq);
  assert.deepEqual(page.body.chats.map((c) => c.id), ['c0']);
  writeStore([mine(0, { title: 'new' }), { ...other(1), title: 'foreign-changed' }, mine(2, { widgetPageSessionId: 'p-other' }), other(3)]);
  const delta = await call('/api/chats/sync', { since: page.body.sync }, widgetReq);
  assert.deepEqual(delta.body.upserts.map((d) => d.id), ['c0']);
  assert.deepEqual(delta.body.removed, []);
  // Match the quoted id, not a bare substring: the response carries a random UUID epoch that can contain "c3".
  const text = JSON.stringify(delta.body);
  assert.equal(text.includes('foreign'), false);
  assert.equal(text.includes('"c3"'), false);
  // no widget access (session) sees everything
  const session = await call('/api/chats/sync', { since: page.body.sync });
  assert.deepEqual(session.body.upserts.map((d) => d.id).sort(), ['c0', 'c1', 'c3']);
});
