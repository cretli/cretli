import './helpers/isolated-data-dir.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJsonTodoRepository, INDEX_CACHE_WORKSPACES, MAX_PAGE_LIMIT, PREVIEW_CHARS } from '../lib/persist/todo-repository.js';
import { listTodos } from '../lib/persist/todos-store.js';
import { buildItems, fixtureId, writeFixtureDocument } from './helpers/todo-repository-fixture.js';

const HEAVY = ['body', 'plan', 'changelog', 'review', 'integration', 'activity', 'leafMaterial', 'linkedChatIds'];

describe('todo repository (JSON backend)', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-repo-'));
  const dataDir = path.join(cwd, 'data');
  const items = buildItems(5000);
  const repo = createJsonTodoRepository({ dataDir });

  before(() => writeFixtureDocument(dataDir, cwd, items));

  /** @param {Record<string, any>} opts */
  async function walk(opts) {
    const rows = [];
    let cursor;
    let pages = 0;
    do {
      const page = await repo.listPage(cwd, { ...opts, cursor, limit: opts.limit ?? 200 });
      assert.ok(page.rows.length <= MAX_PAGE_LIMIT);
      rows.push(...page.rows);
      cursor = page.nextCursor || undefined;
      pages += 1;
    } while (cursor && pages < 1000);
    return rows;
  }

  it('pages 5,000 items by recency without duplicates or skips', async () => {
    const rows = await walk({ sort: 'updated' });
    assert.equal(rows.length, 5000);
    assert.equal(new Set(rows.map((r) => r.id)).size, 5000);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      assert.ok(a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id), 'strict (updatedAt,id) desc order');
    }
  });

  it('pages in tree order: parents before children, siblings by siblingIndex', async () => {
    const rows = await walk({ sort: 'tree', limit: 137 });
    assert.equal(rows.length, 5000);
    assert.equal(new Set(rows.map((r) => r.id)).size, 5000);
    const pos = new Map(rows.map((r, i) => [r.id, i]));
    for (const r of rows) if (r.parentId) assert.ok(pos.get(r.parentId) < pos.get(r.id));
    const rootMid = items.find((i) => i.siblingIndex === 0 && !i.parentId);
    const mids = (await walk({ sort: 'tree', parentId: rootMid.id })).map((r) => r.siblingIndex);
    assert.deepEqual(mids, [0, 1, 2, 3, 4]);
  });

  it('caps the limit at 200 and defaults sensibly', async () => {
    assert.equal((await repo.listPage(cwd, { limit: 100000 })).rows.length, 200);
    assert.equal((await repo.listPage(cwd, { limit: 0 })).rows.length, 50);
    assert.equal((await repo.listPage(cwd, { limit: 3 })).rows.length, 3);
  });

  it('returns light rows only', async () => {
    const page = await repo.listPage(cwd, { limit: 200 });
    for (const row of page.rows) {
      for (const key of HEAVY) assert.equal(key in row, false, `${key} leaked`);
      assert.ok(row.preview.length <= PREVIEW_CHARS);
    }
    assert.equal(page.rows[0].preview.length, PREVIEW_CHARS);
    assert.ok(page.revision);
  });

  it('filters by status, review and text; walks are exact', async () => {
    // The loader derives parent statuses, so the loaded document is the oracle.
    const items = (await listTodos(dataDir, cwd)).items;
    const done = await walk({ status: 'done' });
    assert.equal(done.length, items.filter((i) => i.status === 'done').length);
    const two = await walk({ status: 'done,ready' });
    assert.equal(two.length, items.filter((i) => i.status === 'done' || i.status === 'ready').length);
    const passed = await walk({ review: 'passed' });
    assert.equal(passed.length, items.filter((i) => i.review?.code?.state === 'passed').length);
    const planPending = await walk({ review: 'plan:pending' });
    assert.equal(planPending.length, items.filter((i) => i.review?.plan?.state === 'pending').length);
    const needle = await walk({ q: 'NEEDLE' });
    assert.equal(needle.length, items.filter((i) => i.title.includes('needle')).length);
    const roots = await walk({ parentId: 'root' });
    assert.equal(roots.length, items.filter((i) => !i.parentId).length);
  });

  it('binds cursors to workspace, filter and sort', async () => {
    const page = await repo.listPage(cwd, { status: 'done', limit: 5 });
    assert.ok(page.nextCursor);
    await assert.rejects(repo.listPage(cwd, { status: 'ready', cursor: page.nextCursor }), { code: 'VALIDATION' });
    await assert.rejects(repo.listPage(cwd, { status: 'done', sort: 'tree', cursor: page.nextCursor }), { code: 'VALIDATION' });
    await assert.rejects(repo.listPage(cwd, { cursor: 'not-a-cursor' }), { code: 'VALIDATION' });
    await assert.rejects(repo.listPage(cwd, { sort: 'bogus' }), { code: 'VALIDATION' });
  });

  it('pages children of a node', async () => {
    const mid = items.find((i) => i.parentId && items.some((c) => c.parentId === i.id));
    const kids = items.filter((i) => i.parentId === mid.id);
    const all = [];
    let cursor;
    let pages = 0;
    do {
      const page = await repo.listChildren(cwd, mid.id, { cursor, limit: 7 });
      all.push(...page.rows);
      cursor = page.nextCursor || undefined;
      pages += 1;
    } while (cursor);
    assert.equal(pages, Math.ceil(kids.length / 7));
    assert.deepEqual(all.map((r) => r.id), [...kids].sort((a, b) => a.siblingIndex - b.siblingIndex).map((r) => r.id));
    await assert.rejects(repo.listChildren(cwd, 'missing-parent'), { code: 'NOT_FOUND' });
  });

  it('counts equal a recount of the document', async () => {
    const doc = await listTodos(dataDir, cwd);
    const byStatus = {};
    const byReviewCode = {};
    for (const it of doc.items) {
      byStatus[it.status] = (byStatus[it.status] || 0) + 1;
      const s = it.review?.code?.state || 'none';
      byReviewCode[s] = (byReviewCode[s] || 0) + 1;
    }
    const counts = await repo.counts(cwd);
    assert.deepEqual(counts.byStatus, byStatus);
    assert.deepEqual(counts.byReviewCode, byReviewCode);
    assert.equal(counts.total, doc.items.length);
    assert.equal(counts.revision, await repo.revision(cwd));
    const filtered = await repo.counts(cwd, { filter: { status: 'done' } });
    assert.equal(filtered.total, byStatus.done);
    assert.deepEqual(filtered.byStatus, { done: byStatus.done });
  });

  it('resolves ids by exact id or unique >=8-char prefix', async () => {
    const id = fixtureId(123);
    assert.equal((await repo.getRow(cwd, id)).id, id);
    assert.equal((await repo.getRow(cwd, id.slice(0, 8)))?.id, id);
    assert.equal(await repo.getRow(cwd, id.slice(0, 7)), null);
    assert.equal(await repo.getRow(cwd, 'ffffffff-nope'), null);
    assert.equal(await repo.getDetail(cwd, 'ffffffff-nope'), null);
  });

  it('reports an ambiguous prefix clearly', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-repo-amb-'));
    const base = { title: 't', body: '', status: 'idea', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    writeFixtureDocument(path.join(dir, 'data'), dir, [{ ...base, id: 'abcdef12-0001' }, { ...base, id: 'abcdef12-0002' }]);
    const r = createJsonTodoRepository({ dataDir: path.join(dir, 'data') });
    await assert.rejects(r.getRow(dir, 'abcdef12'), (e) => e.code === 'AMBIGUOUS' && /Ambiguous/.test(e.message));
    assert.equal((await r.getRow(dir, 'abcdef12-0001')).id, 'abcdef12-0001');
    await assert.rejects(r.getRow(dir, 'abcdef12-000'), { code: 'AMBIGUOUS' });
  });

  it('picks up a changed document (revision-keyed index)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-repo-rev-'));
    const dd = path.join(dir, 'data');
    const base = { title: 't', body: '', status: 'idea', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    writeFixtureDocument(dd, dir, [{ ...base, id: 'aaaaaaaa-1' }]);
    const r = createJsonTodoRepository({ dataDir: dd });
    const first = await r.counts(dir);
    assert.equal(first.total, 1);
    writeFixtureDocument(dd, dir, [{ ...base, id: 'aaaaaaaa-1' }, { ...base, id: 'bbbbbbbb-2', status: 'done' }]);
    const second = await r.counts(dir);
    assert.equal(second.total, 2);
    assert.notEqual(second.revision, first.revision);
  });

  it('answers pages and point reads fast after the first load', async () => {
    await repo.listPage(cwd, { limit: 200 });
    let t = performance.now();
    const page = await repo.listPage(cwd, { limit: 200, status: 'done' });
    const pageMs = performance.now() - t;
    t = performance.now();
    await repo.getRow(cwd, fixtureId(4321).slice(0, 10));
    const rowMs = performance.now() - t;
    t = performance.now();
    await repo.getDetail(cwd, fixtureId(4321), { enrich: (rows) => rows });
    const detailMs = performance.now() - t;
    assert.ok(page.rows.length > 0);
    assert.ok(pageMs < 50, `page ${pageMs}ms`);
    assert.ok(rowMs < 50, `row ${rowMs}ms`);
    assert.ok(detailMs < 50, `detail ${detailMs}ms`);
  });

  it('getDetail loads only the item, its ancestors and subtree', async () => {
    const mid = items.find((i) => i.parentId && items.some((c) => c.parentId === i.id));
    let seen = [];
    const detail = await repo.getDetail(cwd, mid.id, { enrich: (rows) => { seen = rows.map((r) => r.id); return rows; } });
    assert.equal(detail.id, mid.id);
    assert.equal(detail.body, mid.body, 'heavy fields present');
    const kids = items.filter((i) => i.parentId === mid.id).map((i) => i.id);
    assert.deepEqual([...seen].sort(), [mid.id, mid.parentId, ...kids].sort());
  });

  const small = (n, extra = {}) => ({
    id: `s${String(n).padStart(7, '0')}-id`, title: `T${n}`, body: '', status: 'idea',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, ...extra,
  });
  const smallWs = (tag, count) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `cr-todo-repo-${tag}-`));
    writeFixtureDocument(dataDir, dir, Array.from({ length: count }, (_, i) => small(i)));
    return dir;
  };

  it('rejects a cursor issued for another workspace', async () => {
    const other = smallWs('other', 30);
    const page = await repo.listPage(cwd, { limit: 5 });
    await assert.rejects(repo.listPage(other, { cursor: page.nextCursor, limit: 5 }), { code: 'VALIDATION' });
    const otherPage = await repo.listPage(other, { limit: 5 });
    assert.ok(otherPage.rows.every((r) => r.id.startsWith('s')), 'only rows of the other workspace');
  });

  it('flags stale:true when the revision changes between cursor pages', async () => {
    const dir = smallWs('stale', 30);
    const first = await repo.listPage(dir, { limit: 10 });
    assert.equal(first.stale, undefined);
    writeFixtureDocument(dataDir, dir, Array.from({ length: 31 }, (_, i) => small(i)));
    const second = await repo.listPage(dir, { limit: 10, cursor: first.nextCursor });
    assert.equal(second.stale, true);
    assert.notEqual(second.revision, first.revision);
    assert.equal(second.rows.length, 10);
  });

  it('stays correct across LRU eviction of more workspaces than the cache holds', async () => {
    const r = createJsonTodoRepository({ dataDir });
    const dirs = Array.from({ length: INDEX_CACHE_WORKSPACES + 2 }, (_, i) => smallWs(`lru${i}`, 10 + i));
    for (const d of dirs) await r.counts(d);
    assert.equal(r.stats.builds, dirs.length);
    for (let i = 0; i < dirs.length; i++) {
      assert.equal((await r.counts(dirs[i])).total, 10 + i);
      assert.equal((await r.listPage(dirs[i], { limit: 200 })).rows.length, 10 + i);
    }
    // The oldest workspace was evicted, so it was rebuilt; the newest stayed cached.
    assert.ok(r.stats.builds > dirs.length);
    const before = r.stats.builds;
    await r.counts(dirs[dirs.length - 1]);
    assert.equal(r.stats.builds, before);
  });

  it('dedupes concurrent index builds for one workspace', async () => {
    const dir = smallWs('flight', 20);
    const r = createJsonTodoRepository({ dataDir });
    const results = await Promise.all([
      r.counts(dir), r.listPage(dir, {}), r.getRow(dir, small(1).id), r.counts(dir), r.listPage(dir, { sort: 'tree' }),
    ]);
    assert.equal(r.stats.builds, 1);
    assert.equal(results[0].total, 20);
  });
});
