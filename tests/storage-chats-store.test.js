import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { createChatsStore, CHATS_MAX_PAYLOAD_BYTES, CHATS_BATCH_MAX_ITEMS, CHATS_MAX_SUBTREE_ROWS, offlineHandlers } from '../lib/storage/chats-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { createGuardedConnection } from '../lib/storage/handler-sql-guard.js';
import { createChatCatalog } from '../lib/chat-catalog.js';
import { boundHandlers, inTransaction, openChatsDb, seedChats, syntheticChats, tempDir } from './fixtures/storage-chats-helpers.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-chats-handlers.js', import.meta.url));

/** @param {() => unknown} fn */
function refusal(fn) {
  try { fn(); } catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a refusal');
}

/** The counter table must equal a reference GROUP BY over `chats` after every mutation class. */
function assertCountersMatch(h, db) {
  const verdict = h.verifyCounts();
  assert.deepEqual({ ok: verdict.ok, mismatches: verdict.mismatches }, { ok: true, mismatches: 0 }, JSON.stringify(verdict));
  const reference = db.prepare("SELECT workspace_file AS f, workspace_folder AS d, (archived_at <> '') AS a, count(*) AS n, sum(parent_id = '') AS r FROM chats GROUP BY 1, 2, 3 ORDER BY 1, 2, 3").all();
  const stored = db.prepare('SELECT workspace_file AS f, workspace_folder AS d, archived AS a, count AS n, root_count AS r FROM chat_scope_counts ORDER BY 1, 2, 3').all();
  assert.deepEqual(stored.map((r) => ({ ...r })), reference.map((r) => ({ ...r })));
}

/** All stored records in position order, as the legacy collection. */
function allRecords(h) {
  const out = [];
  let cursor = null;
  do {
    const page = h.page({ archived: 'all', limit: 500, cursor });
    for (const item of page.items) out.push(h.get({ id: item.id }));
    cursor = page.nextCursor;
  } while (cursor);
  return out.sort((a, b) => a.position - b.position).map((r) => r.chat);
}

describe('record round-trip', () => {
  it('reproduces unknown fields, key order, odd types and raw strings', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    const chat = {
      zzz: { nested: [1, { two: 2 }] },
      id: 'a',
      title: 'T',
      workspaceFolder: '/w/x/',
      forkParentChatId: ' parent ',
      archivedAt: '  ',
      agentTransport: 7,
      model: 'm',
      summaries: ['x'.repeat(2000)],
      createdAt: '2026-01-01',
      watcherPinned: true,
      futureField: null,
    };
    h.add({ chat });
    const stored = h.get({ id: 'a' });
    assert.deepEqual(stored.chat, chat);
    assert.deepEqual(Object.keys(stored.chat), Object.keys(chat));
    // The oversized light candidate and the unknown fields live in the details, not in light_json.
    const row = db.prepare('SELECT light_json FROM chats WHERE id = ?').get('a');
    assert.deepEqual(Object.keys(JSON.parse(row.light_json)).sort(), ['model', 'watcherPinned']);
    assert.equal(db.prepare('SELECT parent_id, archived_at FROM chats WHERE id = ?').get('a').parent_id, 'parent');
    assert.equal(db.prepare('SELECT archived_at FROM chats WHERE id = ?').get('a').archived_at, '');
    assertCountersMatch(h, db);
  });

  it('keeps key order across update set/unset and writes details only when they change', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.add({ chat: { id: 'a', title: 'T', extra1: 1, lastSeenAt: 'S1', createdAt: '2026-01-01' } });
    const before = db.prepare('SELECT * FROM chat_details WHERE chat_id = ?').get('a');
    const res = h.update({ id: 'a', set: { title: 'T2' } });
    assert.equal(res.changed, true);
    assert.deepEqual(db.prepare('SELECT * FROM chat_details WHERE chat_id = ?').get('a'), before, 'a title change must not rewrite the details');
    h.markRead({ id: 'a', marks: { lastSeenAt: 'S2' } });
    assert.deepEqual(db.prepare('SELECT * FROM chat_details WHERE chat_id = ?').get('a'), before, 'a read mark of an existing key must not rewrite the details');
    h.update({ id: 'a', set: { extra2: 2 }, unset: ['extra1'] });
    assert.deepEqual(Object.keys(h.get({ id: 'a' }).chat), ['id', 'title', 'lastSeenAt', 'createdAt', 'extra2']);
    assert.equal(h.get({ id: 'a' }).chat.lastSeenAt, 'S2');
    h.markRead({ id: 'a', marks: { autoArchivePostponedAt: 'P1' } });
    assert.equal(h.get({ id: 'a' }).chat.autoArchivePostponedAt, 'P1', 'postponing auto-archive is a read mark');
    assert.equal(h.update({ id: 'a', set: { title: 'T2' } }).changed, false, 'an identical patch is a no-op');
  });

  it('refuses records the store cannot represent', () => {
    const h = boundHandlers(openChatsDb());
    for (const chat of [null, [], { title: 'no id' }, { id: '  ' }, { id: 'x'.repeat(513) }, JSON.parse('{"id":"a","__proto__":{}}')]) {
      assert.equal(refusal(() => h.add({ chat })).details.conflictKind, 'chat_invalid_record', JSON.stringify(chat)?.slice(0, 40));
    }
  });
});

describe('handlers', () => {
  it('add / get / getMany / byCursorSession / children / subtree', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.add({ chat: { id: 'p', cursorSessionId: 'cs-p', todoId: 't1', createdAt: '2026-01-01' } });
    h.add({ chat: { id: 'k2', forkParentChatId: 'p', createdAt: '2026-01-02' } });
    h.add({ chat: { id: 'k1', forkParentChatId: 'p', todoId: 't2', createdAt: '2026-01-03' } });
    h.add({ chat: { id: 'g', forkParentChatId: 'k1', createdAt: '2026-01-04' } });
    assert.equal(h.get({ id: 'missing' }), null);
    assert.equal(h.get({ id: 'p' }).revision, 1);
    assert.deepEqual(h.getMany({ ids: ['p', 'g', 'missing'] }).chats.map((c) => c.chat.id).sort(), ['g', 'p']);
    assert.equal(h.byCursorSession({ cursorSessionId: 'cs-p' }).chat.id, 'p');
    assert.equal(h.byCursorSession({ cursorSessionId: 'nope' }), null);
    assert.deepEqual(h.children({ parentId: 'p' }).items.map((c) => c.id), ['k1', 'k2']);
    const sub = h.subtree({ id: 'p' });
    assert.deepEqual(sub.items, [{ id: 'g', todoId: '' }, { id: 'k1', todoId: 't2' }, { id: 'k2', todoId: '' }, { id: 'p', todoId: 't1' }]);
    assert.equal(sub.nextAfterId, null);
    const first = h.subtree({ id: 'p', limit: 3 });
    assert.equal(first.items.length, 3);
    assert.deepEqual(h.subtree({ id: 'p', limit: 3, afterId: first.nextAfterId }).items.map((c) => c.id), ['p']);
    assert.equal(refusal(() => h.add({ chat: { id: 'p' } })).details.conflictKind, 'chat_exists');
    assert.equal(refusal(() => h.getMany({ ids: Array.from({ length: CHATS_BATCH_MAX_ITEMS + 1 }, (_, i) => `x${i}`) })).details.conflictKind, 'batch_too_large');
    assertCountersMatch(h, db);
  });

  it('update: CAS, missing row, immutable id, patch validation', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.add({ chat: { id: 'a', title: 'T' } });
    assert.equal(refusal(() => h.update({ id: 'a', expectedRevision: 5, set: { title: 'x' } })).details.conflictKind, 'chat_cas');
    assert.equal(h.get({ id: 'a' }).chat.title, 'T');
    assert.equal(h.update({ id: 'a', expectedRevision: 1, set: { title: 'x' } }).revision, 2);
    assert.equal(refusal(() => h.update({ id: 'zz', set: { title: 'x' } })).details.conflictKind, 'chat_not_found');
    assert.equal(refusal(() => h.update({ id: 'a', set: { id: 'b' } })).details.conflictKind, 'chat_invalid_record');
    assert.equal(refusal(() => h.update({ id: 'a', unset: ['id'] })).details.conflictKind, 'chat_invalid_record');
    assert.equal(refusal(() => h.markRead({ id: 'a', marks: { title: 'x' } })).details.conflictKind, 'chat_invalid_record');
    assertCountersMatch(h, db);
  });

  it('updateMany is atomic: a stale or missing row refuses the call and no row changes', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.importBatch({ chats: [{ id: 'a', title: 'A', workspaceFolder: '/w/a' }, { id: 'b', title: 'B', workspaceFolder: '/w/a' }] });
    const ok = h.updateMany({ updates: [
      { id: 'a', expectedRevision: 1, set: { title: 'A2', archivedAt: 'T' } }, { id: 'b', expectedRevision: 1, set: { title: 'B2' } },
    ] });
    assert.deepEqual(ok.rows.map((r) => [r.id, r.revision, r.changed]), [['a', 2, true], ['b', 2, true]]);
    assertCountersMatch(h, db);
    // Later row stale: the first row must not move.
    assert.equal(refusal(() => h.updateMany({ updates: [
      { id: 'a', expectedRevision: 2, set: { title: 'A3' } }, { id: 'b', expectedRevision: 1, set: { title: 'B3' } },
    ] })).details.conflictKind, 'chat_cas');
    // Later row missing.
    assert.equal(refusal(() => h.updateMany({ updates: [
      { id: 'a', expectedRevision: 2, set: { title: 'A3' } }, { id: 'zz', set: { title: 'x' } },
    ] })).details.conflictKind, 'chat_not_found');
    // Duplicate ids and empty batches are refused.
    assert.equal(refusal(() => h.updateMany({ updates: [{ id: 'a', set: {} }, { id: 'a', set: {} }] })).details.conflictKind, 'chat_invalid_record');
    assert.equal(refusal(() => h.updateMany({ updates: [] })).details.conflictKind, 'batch_too_large');
    const a = h.get({ id: 'a' });
    assert.equal(a.chat.title, 'A2');
    assert.equal(a.revision, 2);
    assert.equal(h.get({ id: 'b' }).chat.title, 'B2');
    assertCountersMatch(h, db);
  });

  it('remove cascades over the subtree and keeps counters and row_count exact', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.importBatch({ chats: [
      { id: 'r', workspaceFolder: '/w/a' }, { id: 'c1', forkParentChatId: 'r', workspaceFolder: '/w/a' },
      { id: 'c2', forkParentChatId: 'c1', workspaceFolder: '/w/b', archivedAt: 'T' }, { id: 'other', workspaceFolder: '/w/a' },
    ] });
    assert.equal(refusal(() => h.remove({ id: 'r', expectedRevision: 9 })).details.conflictKind, 'chat_cas');
    const res = h.remove({ id: 'r', expectedRevision: 1 });
    assert.equal(res.affectedCount, 3);
    assert.match(res.affectedDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(allRecords(h).map((c) => c.id), ['other']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM chat_details').get().n, 1);
    assert.equal(db.prepare('SELECT row_count FROM chat_store_meta').get().row_count, 1);
    assert.equal(refusal(() => h.remove({ id: 'r' })).details.conflictKind, 'chat_not_found');
    assertCountersMatch(h, db);
  });

  it('archive: whole subtrees, existing stamps kept, unarchive through update, bounded batches', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.importBatch({ chats: [
      { id: 'r', workspaceFolder: '/w/a' }, { id: 'c1', forkParentChatId: 'r', workspaceFolder: '/w/a', archivedAt: 'OLD' },
      { id: 'c2', forkParentChatId: 'r', workspaceFolder: '/w/b' }, { id: 'live', workspaceFolder: '/w/a' },
    ] });
    const res = h.archive({ ids: ['r'], archivedAt: 'NEW' });
    assert.equal(res.affectedCount, 2);
    assert.equal(h.get({ id: 'c1' }).chat.archivedAt, 'OLD');
    assert.equal(h.get({ id: 'c2' }).chat.archivedAt, 'NEW');
    assert.equal(h.get({ id: 'live' }).chat.archivedAt, undefined);
    assertCountersMatch(h, db);
    assert.equal(h.archive({ ids: ['r'], archivedAt: 'NEWER' }).affectedCount, 0, 're-archiving changes nothing');
    assert.equal(h.update({ id: 'c2', unset: ['archivedAt'] }).changed, true);
    assertCountersMatch(h, db);
    assert.equal(refusal(() => h.archive({ ids: Array.from({ length: CHATS_BATCH_MAX_ITEMS + 1 }, (_, i) => `x${i}`), archivedAt: 'T' })).details.conflictKind, 'batch_too_large');
    assert.equal(refusal(() => h.archive({ ids: ['r'], archivedAt: ' ' })).details.conflictKind, 'chat_invalid_record');
  });

  it('refuses a subtree above the row limit without changing anything', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    const chats = [{ id: 'root', workspaceFolder: '/w/a' }];
    for (let i = 0; i < CHATS_MAX_SUBTREE_ROWS; i += 1) chats.push({ id: `k${String(i).padStart(5, '0')}`, forkParentChatId: 'root', workspaceFolder: '/w/a' });
    seedChats(db, chats);
    const before = db.prepare('SELECT count(*) AS n FROM chats').get().n;
    assert.equal(refusal(() => h.remove({ id: 'root' })).details.conflictKind, 'batch_too_large');
    assert.equal(refusal(() => h.archive({ ids: ['root'], archivedAt: 'T' })).details.conflictKind, 'batch_too_large');
    assert.equal(db.prepare('SELECT count(*) AS n FROM chats').get().n, before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM chats WHERE archived_at <> ''").get().n, 0);
    assertCountersMatch(h, db);
  });

  it('enforces the 240 KiB payload budget and the import batch size', () => {
    const h = boundHandlers(openChatsDb());
    const fit = (pad) => ({ id: 'big', summaries: ['x'.repeat(pad)] });
    const overhead = Buffer.byteLength(JSON.stringify({ chat: fit(0) }));
    assert.equal(h.add({ chat: fit(CHATS_MAX_PAYLOAD_BYTES - overhead) }).id, 'big');
    assert.equal(refusal(() => h.add({ chat: { ...fit(CHATS_MAX_PAYLOAD_BYTES - overhead + 1), id: 'big2' } })).details.conflictKind, 'batch_too_large');
    assert.equal(refusal(() => h.importBatch({ chats: Array.from({ length: CHATS_BATCH_MAX_ITEMS + 1 }, (_, i) => ({ id: `i${i}` })) })).details.conflictKind, 'batch_too_large');
    assert.equal(h.importBatch({ chats: Array.from({ length: CHATS_BATCH_MAX_ITEMS }, (_, i) => ({ id: `i${i}` })) }).affectedCount, CHATS_BATCH_MAX_ITEMS);
    assert.equal(refusal(() => h.importBatch({ chats: [{ id: 'dup' }, { id: 'dup' }] })).details.conflictKind, 'chat_exists');
  });
});

describe('counters', () => {
  it('match the reference COUNT after every mutation class, including rollbacks', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    seedChats(db, syntheticChats(300));
    assertCountersMatch(h, db);
    h.add({ chat: { id: 'new1', workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-1/f.js', createdAt: '2026-05-01' } });
    assertCountersMatch(h, db);
    // Moving between scopes: folder, file, raw spelling variants.
    h.update({ id: 'new1', set: { workspaceFolder: '/work/ws-2/' } });
    assertCountersMatch(h, db);
    h.update({ id: 'new1', set: { workspaceFolder: '/work/ws-2', workspaceFile: '' } });
    assertCountersMatch(h, db);
    h.update({ id: 'new1', unset: ['workspaceFolder', 'workspaceFile'] });
    assertCountersMatch(h, db);
    // Parent change toggles the root count.
    h.update({ id: 'new1', set: { forkParentChatId: 'c000001' } });
    assertCountersMatch(h, db);
    h.update({ id: 'new1', set: { forkParentChatId: '' } });
    assertCountersMatch(h, db);
    // Changes that must not touch any bucket.
    const touch = h.update({ id: 'new1', set: { title: 'again', updatedAt: '2026-06-01' } });
    assert.equal(touch.changed, true);
    h.markRead({ id: 'new1', marks: { lastSeenAt: 'X' } });
    assertCountersMatch(h, db);
    h.archive({ ids: ['c000001', 'c000002', 'new1'], archivedAt: '2026-07-01T00:00:00.000Z' });
    assertCountersMatch(h, db);
    h.update({ id: 'new1', unset: ['archivedAt'] });
    h.update({ id: 'c000002', set: { archivedAt: '' } });
    assertCountersMatch(h, db);
    h.remove({ id: 'c000001' });
    assertCountersMatch(h, db);
    h.remove({ id: 'new1' });
    assertCountersMatch(h, db);
    // Failed operations leave counters, rows and revision untouched.
    const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM chat_scope_counts ORDER BY 1,2,3').all(), db.prepare('SELECT * FROM chat_store_meta').get()]);
    const before = snapshot();
    refusal(() => h.update({ id: 'c000003', expectedRevision: 99, set: { workspaceFolder: '/elsewhere' } }));
    refusal(() => h.importBatch({ chats: [{ id: 'fresh', workspaceFolder: '/q' }, { id: 'c000003' }] }));
    refusal(() => h.remove({ id: 'c000003', expectedRevision: 99 }));
    refusal(() => h.archive({ ids: ['c000003'], archivedAt: ' ' }));
    assert.equal(snapshot(), before);
    assertCountersMatch(h, db);
  });

  it('a counter underflow rolls the whole operation back', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.importBatch({ chats: [{ id: 'a', workspaceFolder: '/w/a' }, { id: 'b', workspaceFolder: '/w/a' }] });
    // Corrupt the counters on purpose: removing the chat must fail rather than store a negative count.
    db.exec("DELETE FROM chat_scope_counts WHERE workspace_folder = '/w/a'");
    const before = JSON.stringify(db.prepare('SELECT id, revision FROM chats ORDER BY id').all());
    const err = refusal(() => h.update({ id: 'a', set: { workspaceFolder: '/w/z' } }));
    assert.ok(err);
    assert.equal(JSON.stringify(db.prepare('SELECT id, revision FROM chats ORDER BY id').all()), before);
    assert.equal(db.prepare('SELECT workspace_folder FROM chats WHERE id = ?').get('a').workspace_folder, '/w/a');
  });

  it('counts and archivedCountsByWorkspace equal the catalog for every scope shape', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    const chats = syntheticChats(400);
    // Raw variants of one path and a legacy-key collision: the file contains a newline.
    chats.push({ id: 'v1', workspaceFolder: '/work/ws-1/', archivedAt: 'T' }, { id: 'v2', workspaceFolder: ' /work/ws-1 ', archivedAt: 'T' },
      { id: 'v3', workspaceFile: 'a\nb', workspaceFolder: 'c', archivedAt: 'T' }, { id: 'v4', workspaceFile: 'a', workspaceFolder: 'b\nc', archivedAt: 'T' },
      { id: 'v5' }, { id: 'v6', archivedAt: 'T' });
    seedChats(db, chats);
    const catalog = createChatCatalog(allRecords(h));
    const scopes = [undefined, { workspaceFolder: '/work/ws-1' }, { workspaceFolder: '/work/ws-1/' }, { workspaceFile: '/work/ws-4/file-0.js' },
      { workspaceFolder: '/work/ws-2', workspaceFile: '/work/ws-3/file-3.js' }, { workspaceFolder: '/nowhere' }, { workspaceFile: '/nowhere.js' }];
    for (const scope of scopes) {
      const got = h.counts({ scope });
      assert.deepEqual({ total: got.total, archived: got.archived, live: got.live, roots: got.roots }, catalog.counts({ scope }), JSON.stringify(scope));
      assert.deepEqual(h.archivedCountsByWorkspace({ scope }).counts, { ...catalog.archivedCountsByWorkspace({ scope }) }, JSON.stringify(scope));
    }
    // Colliding legacy keys are summed over buckets, never over chats.
    assert.equal(h.archivedCountsByWorkspace({}).counts['a\nb\nc'], 2);
  });
});

describe('scope parity with the catalog', () => {
  it('walks every scope x archive filter page by page and matches isChatInScope / createChatCatalog', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    const chats = syntheticChats(600);
    // Ties in last_activity_at must page without duplicates; a trailing slash and a folder-less file chat.
    seedChats(db, chats);
    const records = allRecords(h);
    const catalog = createChatCatalog(records);
    const byId = new Map(records.map((c) => [c.id, c]));
    const lastActivity = (c) => (String(c.updatedAt || '').trim() || String(c.createdAt || '').trim());
    const order = (a, b) => (lastActivity(a) === lastActivity(b) ? (a.id < b.id ? 1 : -1) : (lastActivity(a) < lastActivity(b) ? 1 : -1));
    const scopes = [undefined, { workspaceFolder: '/work/ws-3' }, { workspaceFolder: '/work/ws-3/' }, { workspaceFile: '/work/ws-4/file-4.js' },
      { workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-4/file-0.js' }, { workspaceFolder: '/work/ws-9' }];
    for (const scope of scopes) {
      for (const archived of ['include', 'exclude', 'only']) {
        const expected = [...catalog.list({ scope, archived })].sort(order).map((c) => c.id);
        const walked = [];
        let cursor = null;
        let pages = 0;
        do {
          const page = h.page({ scope, archived, limit: 17, cursor });
          walked.push(...page.items.map((i) => i.id));
          cursor = page.nextCursor;
          pages += 1;
          assert.ok(page.items.length === 17 || cursor === null, 'a page is full unless it is the last');
        } while (cursor && pages < 1000);
        assert.deepEqual(walked, expected, `${JSON.stringify(scope)} ${archived}`);
        assert.equal(new Set(walked).size, walked.length);
      }
      // archived=tree: live rows plus archived ancestors of in-scope live rows.
      const treeIds = new Set(catalog.list({ scope, archived: 'tree' }).map((c) => c.id));
      const seen = new Set();
      let cursor = null;
      do {
        const page = h.page({ scope, archived: 'tree', limit: 23, cursor });
        for (const item of [...page.items, ...page.ancestors]) seen.add(item.id);
        assert.ok(page.ancestors.every((a) => a.ancestor === true && byId.get(a.id).archivedAt));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual([...seen].sort(), [...treeIds].sort(), `tree ${JSON.stringify(scope)}`);
    }
  });

  it('widget scope follows widgetChatListScope branch by branch', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    h.importBatch({ chats: [
      { id: 'w1', widgetInstallationId: 'i', widgetPageSessionId: 's', workspaceFile: '/f.js', workspaceFolder: '/d', updatedAt: '2026-01-05' },
      { id: 'w2', widgetInstallationId: 'i', widgetPageSessionId: 's', workspaceFile: '/f.js', updatedAt: '2026-01-04' },
      { id: 'w3', widgetInstallationId: 'i', widgetPageSessionId: 's', workspaceFolder: '/d', updatedAt: '2026-01-03' },
      { id: 'w4', widgetInstallationId: 'i', widgetPageSessionId: 's', updatedAt: '2026-01-02' },
      { id: 'w5', widgetInstallationId: 'i', widgetPageSessionId: 'other', updatedAt: '2026-01-06' },
      { id: 'w6', widgetInstallationId: 'j', widgetPageSessionId: 's', updatedAt: '2026-01-07' },
      { id: 'w7', widgetInstallationId: 'i', widgetPageSessionId: 's', workspaceFile: '/f.js/', workspaceFolder: '/d', archivedAt: 'T', updatedAt: '2026-01-01' },
      { id: 'plain', updatedAt: '2026-01-08' },
    ] });
    const ids = (widget, archived = 'all') => h.page({ scope: { widget }, archived }).items.map((i) => i.id);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 's' }), ['w1', 'w2', 'w3', 'w4', 'w7']);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 's', workspaceFile: '/f.js' }), ['w1', 'w2']);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 's', workspaceFolder: '/d' }), ['w1', 'w3', 'w7']);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 's', workspaceFile: '/f.js', workspaceFolder: '/d' }), ['w1']);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 's' }, 'archived'), ['w7']);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 's' }, 'live'), ['w1', 'w2', 'w3', 'w4']);
    assert.deepEqual(ids({ installationId: 'i', pageSessionId: 'zzz' }), []);
    assert.deepEqual(h.counts({ scope: { widget: { installationId: 'i', pageSessionId: 's' } } }), { total: 5, archived: 1, live: 4, roots: 5, storeRevision: 1 });
    assert.equal(refusal(() => h.page({ scope: { widget: { installationId: '', pageSessionId: 's' } } })).details.conflictKind, 'chat_scope_invalid');
    assert.equal(refusal(() => h.page({ scope: { widgetInstallationId: 'i' } })).details.conflictKind, 'chat_scope_unsupported');
  });

  it('reports scope_scan_limit instead of a short widget page', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    const chats = [];
    for (let i = 0; i < 5200; i += 1) {
      chats.push({ id: `w${String(i).padStart(5, '0')}`, widgetInstallationId: 'i', widgetPageSessionId: 's', workspaceFile: i === 0 ? '/needle.js' : '/hay.js', updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(4, '0')}Z` });
    }
    seedChats(db, chats);
    const err = refusal(() => h.page({ scope: { widget: { installationId: 'i', pageSessionId: 's', workspaceFile: '/needle.js' } }, limit: 5 }));
    assert.equal(err.details.conflictKind, 'scope_scan_limit');
    assert.equal(h.page({ scope: { widget: { installationId: 'i', pageSessionId: 's', workspaceFile: '/hay.js' } }, limit: 5 }).items.length, 5);
  });

  it('archived=tree is bounded: a chain above the depth limit is an error, never a partial result', () => {
    const db = openChatsDb();
    const h = boundHandlers(db);
    const chats = [];
    for (let i = 0; i < 70; i += 1) chats.push({ id: `a${String(i).padStart(3, '0')}`, archivedAt: 'T', updatedAt: '2026-01-01', ...(i > 0 ? { forkParentChatId: `a${String(i - 1).padStart(3, '0')}` } : {}) });
    chats.push({ id: 'leaf', forkParentChatId: 'a069', updatedAt: '2026-02-01' });
    seedChats(db, chats);
    assert.equal(refusal(() => h.page({ archived: 'tree' })).details.conflictKind, 'tree_too_deep');
  });
});

describe('guard, registry and wiring', () => {
  it('every chats statement passes the transaction guard; transaction control and multi-statement SQL are refused', () => {
    const db = openChatsDb();
    const prepareRaw = (sql) => db.prepare(sql);
    const guarded = createGuardedConnection(db, prepareRaw);
    const h = Object.fromEntries(Object.entries(offlineHandlers).map(([name, fn]) => [name, (p) => fn(guarded, p)]));
    inTransaction(db, () => {
      h.importBatch({ chats: [{ id: 'a', forkParentChatId: '' }, { id: 'b', forkParentChatId: 'a', widgetInstallationId: 'i', widgetPageSessionId: 's' }] });
      h.update({ id: 'a', set: { title: 'x' } });
      h.archive({ ids: ['a'], archivedAt: 'T' });
      h.remove({ id: 'a' });
    });
    for (const sql of ['COMMIT', 'ROLLBACK', 'BEGIN', 'SAVEPOINT x', 'SELECT 1; SELECT 2']) {
      db.exec('BEGIN IMMEDIATE');
      try {
        assert.throws(() => guarded.prepare(sql).run(), undefined, sql);
      } finally { db.exec('ROLLBACK'); }
    }
    assert.throws(() => guarded.prepare('SELECT 1').get(), /transaction/i, 'no statement runs outside the request transaction');
  });

  it('the production tree does not open the chats store yet', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'data', 'public', '.git', 'tests', 'docs', 'scripts'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|ts|mjs|cjs)$/.test(entry.name) && fs.readFileSync(full, 'utf8').match(/chats-store(\.js)?['"]|chats\.sqlite/)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    for (const dir of ['lib', 'app_front']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
    if (fs.existsSync(path.join(root, 'server.js')) && /chats-store|chats\.sqlite/.test(fs.readFileSync(path.join(root, 'server.js'), 'utf8'))) offenders.push('server.js');
    // B1 adds the facade adapters and the marker-driven runtime; they open the store only through a runtime that is
    // gated off in production (CHATS_SQLITE_RUNTIME_ENABLED), and no other production file may reference it.
    const allowed = new Set([
      'lib/storage/chats-store.js', 'lib/storage/schema/0009-chats.js',
      'lib/persist/chats-runtime.js', 'lib/persist/chats-backend-sqlite.js', 'lib/persist/chats-backend-marker.js',
      // B5: these import only the pure ordering helpers (`lastActivityOf`, `workspaceKeyOf`) so legacy pages and the
      // catalog sort exactly like the store; neither opens it.
      'lib/chat-catalog.js', 'lib/persist/chats-backend-legacy.js',
    ]);
    assert.deepEqual(offenders.filter((f) => !allowed.has(f)), []);
  });
});

describe('worker host: receipts, replay, registry, group commit', () => {
  /** @type {string} */ let root;
  /** @type {any[]} */ let hosts;
  beforeEach(() => { root = tempDir('cretli-chats-host-'); hosts = []; });
  afterEach(async () => {
    for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function start() {
    const host = createStorageWorkerHost({
      dbDir: root, filename: 'chats.sqlite', handlersPath: HANDLERS_PATH, faultInjection: true,
      writeGate: WRITE_GATE_TEST_EXEMPTION, restartBackoffMs: { initial: 5, max: 20 },
    });
    hosts.push(host);
    await host.start();
    return { host, store: createChatsStore({ host, datasetGeneration: 'gen-1' }) };
  }

  it('opens chats.sqlite through the filename option and serves the whole lifecycle', async () => {
    const { host, store } = await start();
    assert.ok(fs.existsSync(path.join(root, 'chats.sqlite')));
    const added = await store.add({ commandId: 'c1', chat: { id: 'a', title: 'T', workspaceFolder: '/w/a', createdAt: '2026-01-01' } });
    assert.equal(added.replayed, false);
    assert.equal(added.result.revision, 1);
    const updated = await store.update({ commandId: 'c2', id: 'a', expectedRevision: 1, set: { title: 'T2' } });
    assert.equal(updated.result.revision, 2);
    assert.equal((await store.get({ id: 'a' })).chat.title, 'T2');
    await store.markRead({ commandId: 'c3', id: 'a', marks: { lastSeenAt: 'S' } });
    await store.importBatch({ commandId: 'c4', chats: [{ id: 'b', forkParentChatId: 'a' }] });
    const archived = await store.archive({ commandId: 'c5', ids: ['a'], archivedAt: '2026-02-01' });
    assert.equal(archived.result.affectedCount, 2);
    assert.deepEqual((await store.counts({})).archived, 2);
    assert.equal((await store.verifyCounts({})).ok, true);
    const removed = await store.remove({ commandId: 'c6', id: 'a' });
    assert.equal(removed.result.affectedCount, 2);
    assert.equal((await store.page({ archived: 'all' })).items.length, 0);
    await host.close({ timeoutMs: 1000 });
  });

  it('a replayed command returns the stored result and changes no counter or revision', async () => {
    const { store } = await start();
    await store.importBatch({ commandId: 'seed', chats: [{ id: 'a', workspaceFolder: '/w/a' }, { id: 'b', workspaceFolder: '/w/a' }] });
    const first = await store.archive({ commandId: 'arch', ids: ['a'], archivedAt: 'T' });
    const meta = async () => ({ counts: await store.counts({}), revision: (await store.page({})).storeRevision });
    const after = await meta();
    const replay = await store.archive({ commandId: 'arch', ids: ['a'], archivedAt: 'T' });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(await meta(), after);
    // The same commandId with another payload is a digest mismatch, not a second application.
    const err = await store.archive({ commandId: 'arch', ids: ['b'], archivedAt: 'T' }).catch((e) => e);
    assert.equal(err.details.conflictKind, 'receipt_digest_mismatch');
    assert.equal((await store.verifyCounts({})).ok, true);
  });

  it('a refused command leaves no receipt, so its commandId stays usable', async () => {
    const { store } = await start();
    await store.add({ commandId: 'x1', chat: { id: 'a' } });
    const err = await store.update({ commandId: 'x2', id: 'a', expectedRevision: 9, set: { title: 'n' } }).catch((e) => e);
    assert.equal(err.details.conflictKind, 'chat_cas');
    const ok = await store.update({ commandId: 'x2', id: 'a', expectedRevision: 1, set: { title: 'n' } });
    assert.equal(ok.replayed, false);
  });

  it('resolves an unknown commit from the receipt', async () => {
    const { store } = await start();
    await store.add({ commandId: 'u1', chat: { id: 'a' } });
    const known = await store.resolveUnknown({ commandId: 'u1', operation: 'add', chat: { id: 'a' } });
    assert.equal(known.outcome, 'committed');
    assert.equal(known.result.id, 'a');
    const never = await store.resolveUnknown({ commandId: 'never', operation: 'add', chat: { id: 'zz' } });
    assert.equal(never.outcome, 'not_committed');
    // A digest that differs from the stored command fails closed.
    const err = await store.resolveUnknown({ commandId: 'u1', operation: 'add', chat: { id: 'other' } }).catch((e) => e);
    assert.equal(err.details.conflictKind, 'receipt_digest_mismatch');
  });

  it('refuses a handler that is not in the chats registry', async () => {
    const { host } = await start();
    const err = await host.query('chats.nope', {}).catch((e) => e);
    assert.equal(err.details.operation, 'unknown_handler');
    const cmd = await host.command('chats.nope', {}, { commandId: 'n1' }).catch((e) => e);
    assert.ok(cmd instanceof Error);
  });

  it('group commit accepts a payload at the 240 KiB budget and the handler refuses one byte more', async () => {
    const { host, store } = await start();
    void store;
    const committer = createGroupCommitter({ host });
    const gstore = createChatsStore({ host, datasetGeneration: 'gen-1', groupCommitter: committer });
    const fit = (pad, id) => ({ id, summaries: ['x'.repeat(pad)] });
    const overhead = Buffer.byteLength(JSON.stringify({ chat: fit(0, 'big') }));
    const ok = await gstore.add({ commandId: 'g1', chat: fit(CHATS_MAX_PAYLOAD_BYTES - overhead, 'big') });
    assert.equal(ok.result.id, 'big');
    const over = await gstore.add({ commandId: 'g2', chat: fit(CHATS_MAX_PAYLOAD_BYTES - overhead + 1, 'big2') }).catch((e) => e);
    assert.equal(over.details?.conflictKind, 'batch_too_large');
    await committer.close?.();
  });
});

describe('profile-driven field handling', () => {
  it('exports the pure title-source normalisation without side effects', async () => {
    const mod = await import('../lib/persist/chats-persist.js');
    assert.equal(typeof mod.withTitleSource, 'function');
    assert.deepEqual(mod.withTitleSource({ id: 'a', title: 'Chat 3' }), { id: 'a', title: 'Chat 3', titleSource: 'default' });
  });
});
