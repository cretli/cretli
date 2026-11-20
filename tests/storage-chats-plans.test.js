import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { offlineHandlers } from '../lib/storage/chats-store.js';
import { countingCtx, inTransaction, openChatsDb, seedChats, syntheticChats } from './fixtures/storage-chats-helpers.js';

const SIZES = [1000, 50000];
const WIDGET = { installationId: 'inst-0', pageSessionId: 'page-0' };

/** Scope variants of the list: name -> [scope, archived filter, indexes the plan must use (any statement of the page)]. */
const VARIANTS = {
  'global live': [undefined, 'live', ['chats_global_live']],
  'global archived': [undefined, 'archived', ['chats_global_archived']],
  'global all': [undefined, 'all', ['chats_global_live', 'chats_global_archived']],
  'folder live': [{ workspaceFolder: '/work/ws-1' }, 'live', ['chats_folder_live']],
  'folder archived': [{ workspaceFolder: '/work/ws-1' }, 'archived', ['chats_folder_archived']],
  'folder all': [{ workspaceFolder: '/work/ws-1' }, 'all', ['chats_folder_live', 'chats_folder_archived']],
  'file live': [{ workspaceFile: '/work/ws-4/file-4.js' }, 'live', ['chats_file_live']],
  'file archived': [{ workspaceFile: '/work/ws-4/file-4.js' }, 'archived', ['chats_file_archived']],
  'file all': [{ workspaceFile: '/work/ws-4/file-4.js' }, 'all', ['chats_file_live', 'chats_file_archived']],
  'folder+file live': [{ workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-4/file-4.js' }, 'live', ['chats_folder_live', 'chats_file_live']],
  'folder+file archived': [{ workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-4/file-4.js' }, 'archived', ['chats_folder_archived', 'chats_file_archived']],
  'folder+file all': [{ workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-4/file-4.js' }, 'all',
    ['chats_folder_live', 'chats_folder_archived', 'chats_file_live', 'chats_file_archived']],
  'widget live': [{ widget: WIDGET }, 'live', ['chats_widget_live']],
  'widget archived': [{ widget: WIDGET }, 'archived', ['chats_widget_archived']],
  'widget all': [{ widget: WIDGET }, 'all', ['chats_widget_live', 'chats_widget_archived']],
  'tree': [undefined, 'tree', ['chats_global_live']],
};
const ALL_INDEX_NAMES = [...new Set(Object.values(VARIANTS).flatMap((v) => v[2]))];

/** @type {Map<number, any>} */
const dbs = new Map();
function dbOfSize(n) {
  if (!dbs.has(n)) {
    const db = openChatsDb();
    seedChats(db, syntheticChats(n));
    dbs.set(n, db);
  }
  return dbs.get(n);
}

const plan = (db, sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => String(r.detail));

describe('query plans', () => {
  for (const [name, [scope, archived, expected]] of Object.entries(VARIANTS)) {
    it(`${name}: uses exactly the expected list indexes without temp b-trees or table scans`, () => {
      const db = dbOfSize(1000);
      const { ctx, stats } = countingCtx(db);
      offlineHandlers.page(ctx, { scope, archived, limit: 20 });
      const used = new Set();
      for (const sql of new Set(stats.sql)) {
        if (!/FROM chats|JOIN chats/.test(sql) || /FROM chat_store_meta/.test(sql)) continue;
        for (const line of plan(db, sql)) {
          assert.ok(!/USE TEMP B-TREE/.test(line), `${name}: ${line}`);
          const hit = /(?:SCAN|SEARCH) (?:chats|x|c|p)\b(?: AS \w+)?(.*)/.exec(line);
          if (hit) {
            assert.match(hit[1], /USING (?:COVERING )?INDEX|USING INTEGER PRIMARY KEY|USING PRIMARY KEY/, `${name}: ${line}`);
            const index = /INDEX (\w+)/.exec(hit[1]);
            if (index) used.add(index[1]);
          }
        }
      }
      for (const index of used) assert.ok(ALL_INDEX_NAMES.includes(index) || index.startsWith('sqlite_autoindex'), `${name} used ${index}`);
      assert.deepEqual(expected.filter((i) => !used.has(i)), [], `${name} uses ${[...used]}`);
      const foreign = [...used].filter((i) => ALL_INDEX_NAMES.includes(i) && !expected.includes(i));
      assert.deepEqual(foreign, [], `${name} touched an unexpected list index`);
    });
  }

  it('counts and archivedCountsByWorkspace read chat_scope_counts only', () => {
    const db = dbOfSize(1000);
    for (const handler of ['counts', 'archivedCountsByWorkspace']) {
      for (const scope of [undefined, { workspaceFolder: '/work/ws-1' }, { workspaceFile: '/x.js' }, { workspaceFolder: '/work/ws-1', workspaceFile: '/x.js' }]) {
        const { ctx, stats } = countingCtx(db);
        offlineHandlers[handler](ctx, { scope });
        const reads = stats.sql.filter((s) => !/chat_store_meta/.test(s));
        assert.equal(reads.length, 1, `${handler} is one counter statement`);
        const lines = plan(db, reads[0]);
        assert.ok(lines.every((l) => !/\bchats\b|chat_details/.test(l)), lines.join(' | '));
        assert.ok(lines.some((l) => /chat_scope_counts/.test(l)), lines.join(' | '));
      }
    }
  });

  it('relation lookups use their indexes', () => {
    const db = dbOfSize(1000);
    const cases = [
      ["SELECT id FROM chats INDEXED BY chats_by_parent WHERE parent_id = 'x' AND id > '' ORDER BY id LIMIT 5", /chats_by_parent/],
      ["SELECT id FROM chats INDEXED BY chats_by_cursor_session WHERE cursor_session_id = 'x' AND cursor_session_id <> '' LIMIT 1", /chats_by_cursor_session/],
      ["SELECT id FROM chats INDEXED BY chats_by_todo WHERE todo_id = 'x' AND todo_id <> ''", /chats_by_todo/],
    ];
    for (const [sql, re] of cases) assert.match(plan(db, sql).join(' | '), re);
    const { ctx, stats } = countingCtx(db);
    offlineHandlers.subtree(ctx, { id: 'c000000' });
    offlineHandlers.children(ctx, { parentId: 'c000000' });
    offlineHandlers.byCursorSession(ctx, { cursorSessionId: 'cs-c0' });
    for (const sql of new Set(stats.sql)) {
      for (const line of plan(db, sql)) assert.ok(!/SCAN chats(?! USING)/.test(line) || /USING/.test(line), `${sql.slice(0, 50)}: ${line}`);
    }
  });
});

/** Executed statements + distinct prepared texts of one call. */
function measure(db, fn) {
  const { ctx, stats } = countingCtx(db);
  fn(ctx);
  return { executed: stats.executed, prepared: stats.prepared.size, sql: stats.sql.join('\n') };
}

describe('statement counts are independent of N and of the number of changed rows', () => {
  const run = (db, name, payload, write = true) => measure(db, (ctx) => (write ? inTransaction(db, () => offlineHandlers[name](ctx, payload)) : offlineHandlers[name](ctx, payload)));

  it('reads: page (every variant), counts, archived counts, get, subtree, children', () => {
    const results = SIZES.map((n) => {
      const db = dbOfSize(n);
      const out = {};
      for (const [name, [scope, archived]] of Object.entries(VARIANTS)) out[`page ${name}`] = run(db, 'page', { scope, archived, limit: 50 }, false);
      out.counts = run(db, 'counts', { scope: { workspaceFolder: '/work/ws-1' } }, false);
      out.archivedCounts = run(db, 'archivedCountsByWorkspace', {}, false);
      out.get = run(db, 'get', { id: 'c000001' }, false);
      out.subtree = run(db, 'subtree', { id: 'c000000' }, false);
      out.children = run(db, 'children', { parentId: 'c000000' }, false);
      out.byCursor = run(db, 'byCursorSession', { cursorSessionId: 'cs-c5' }, false);
      return out;
    });
    for (const key of Object.keys(results[0])) {
      assert.deepEqual(results[0][key], results[1][key], `${key}: statements differ between N=${SIZES[0]} and N=${SIZES[1]}`);
    }
    // A page is at most 4 index reads + store revision (+ widget scan guard, tree ancestors).
    for (const key of Object.keys(results[1]).filter((k) => k.startsWith('page '))) assert.ok(results[1][key].executed <= 6, `${key}: ${results[1][key].executed}`);
  });

  it('writes: a single change is a handful of statements, equal at 1 000 and 50 000 chats', () => {
    const measureAll = (n) => {
      const db = openChatsDb();
      seedChats(db, syntheticChats(n));
      const out = {};
      out.updateActivity = run(db, 'update', { id: 'c000001', set: { updatedAt: '2026-09-01T00:00:00.000Z' } });
      out.updateTitle = run(db, 'update', { id: 'c000001', set: { title: 'renamed' } });
      out.updateDetails = run(db, 'update', { id: 'c000001', set: { futureField: 1 } });
      out.markReadNewKey = run(db, 'markRead', { id: 'c000001', marks: { lastSeenAt: 'S' } });
      out.markRead = run(db, 'markRead', { id: 'c000001', marks: { lastSeenAt: 'S2' } });
      out.updateMoveBucket = run(db, 'update', { id: 'c000001', set: { workspaceFolder: '/work/moved' } });
      out.updateNoop = run(db, 'update', { id: 'c000001', set: { title: 'renamed' } });
      out.add = run(db, 'add', { chat: { id: 'zz-new', workspaceFolder: '/work/ws-1', createdAt: '2026-09-02' } });
      out.archiveOne = run(db, 'archive', { ids: ['c000002'], archivedAt: 'T' });
      out.archiveMany = run(db, 'archive', { ids: syntheticChats(200).slice(20, 190).map((c) => c.id).filter((id) => id !== 'c000002'), archivedAt: 'T' });
      out.removeLeaf = run(db, 'remove', { id: 'zz-new' });
      out.removeSubtree = run(db, 'remove', { id: 'c000012' });
      out.importOne = run(db, 'importBatch', { chats: [{ id: 'imp-0', workspaceFolder: '/work/ws-2' }] });
      out.importMany = run(db, 'importBatch', { chats: Array.from({ length: 200 }, (_, i) => ({ id: `imp-m${i}`, workspaceFolder: `/work/ws-${i % 9}`, archivedAt: i % 2 ? 'T' : '' })) });
      return out;
    };
    const [small, large] = SIZES.map(measureAll);
    for (const key of Object.keys(small)) assert.deepEqual(small[key], large[key], `${key}: statements differ between N=${SIZES[0]} and N=${SIZES[1]}`);
    // Constant budgets: SELECT (joined with details), UPDATE chats, optional details, meta. The receipt wrapper adds its own lookup + insert.
    assert.equal(large.updateActivity.executed, 3);
    assert.equal(large.updateTitle.executed, 3);
    assert.equal(large.markRead.executed, 3);
    assert.equal(large.markReadNewKey.executed, 4, 'a first read mark adds a key, so the details are rewritten once');
    assert.equal(large.updateDetails.executed, 4);
    assert.equal(large.updateNoop.executed, 2);
    // Bucket-moving changes add the three set-based counter statements; never one statement per chat.
    assert.equal(large.updateMoveBucket.executed, 3 + 3);
    // The batch size must not change the statement budget (archive 1 root vs 169, import 1 vs 200).
    assert.equal(large.archiveOne.executed, large.archiveMany.executed);
    assert.equal(large.importOne.executed, large.importMany.executed);
    assert.equal(large.removeLeaf.executed, large.removeSubtree.executed);
    assert.equal(large.add.executed, large.importOne.executed);
    assert.ok(large.importMany.executed <= 9 && large.removeSubtree.executed <= 10, JSON.stringify([large.importMany.executed, large.removeSubtree.executed]));
  });

  it('counter statements are set-based: the same text and count for 1 and 200 changed roots', () => {
    const db = openChatsDb();
    seedChats(db, syntheticChats(2000));
    const ids = (from, to) => syntheticChats(2000).slice(from, to).map((c) => c.id);
    const one = run(db, 'archive', { ids: ['c000100'], archivedAt: 'T' });
    const many = run(db, 'archive', { ids: ids(200, 400), archivedAt: 'T' });
    assert.equal(one.executed, many.executed);
    assert.equal(one.sql, many.sql);
    assert.equal(offlineHandlers.verifyCounts({ prepare: (sql) => db.prepare(sql) }).ok, true);
  });
});

describe('index lookups visit a bounded number of rows', () => {
  it('a folder stream with a large opposite partition does not filter linearly', () => {
    const db = openChatsDb();
    const chats = syntheticChats(3000).map((c) => ({ ...c, workspaceFolder: '/big', workspaceFile: undefined }));
    chats.push(...syntheticChats(10, { idPrefix: 'tiny' }).map((c) => ({ ...c, workspaceFolder: '/small', workspaceFile: undefined, archivedAt: undefined })));
    seedChats(db, chats);
    const sql = "SELECT id FROM chats INDEXED BY chats_folder_live WHERE archived_at = '' AND workspace_folder_key <> '' AND workspace_folder_key = ? ORDER BY last_activity_at DESC, id DESC LIMIT 11";
    const steps = [];
    db.prepare(sql).all('/small');
    // Count rows touched through sqlite3_stmt scan status: the plan must be a SEARCH, i.e. bounded by the partition, not by N.
    steps.push(...plan(db, sql));
    assert.ok(steps.every((l) => /SEARCH chats USING (?:COVERING )?INDEX chats_folder_live \(workspace_folder_key=\?\)/.test(l)), steps.join(' | '));
    // File stream with a populated opposite folder_empty partition.
    const fileSql = "SELECT id FROM chats INDEXED BY chats_file_live WHERE archived_at = '' AND workspace_file_key <> '' AND workspace_file_key = ? AND (workspace_folder_key = '') = ? ORDER BY last_activity_at DESC, id DESC LIMIT 11";
    assert.ok(plan(db, fileSql).every((l) => /SEARCH chats USING INDEX chats_file_live \(workspace_file_key=\? AND <expr>=\?\)/.test(l)), plan(db, fileSql).join(' | '));
  });
});
