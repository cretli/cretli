import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { saveSettings } from '../lib/persist/settings.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { buildItems, fixtureId, writeFixtureDocument } from './helpers/todo-repository-fixture.js';

/** Fixed workspace path so the serialized legacy list is reproducible. */
const cwd = path.join(os.tmpdir(), 'cretli-todo-repo-routes-ws');
mkdirSync(cwd, { recursive: true });
const dataDir = path.join(cwd, 'data');
const workspaceFile = path.join(cwd, 'proj.code-workspace');
const HEAVY = ['body', 'plan', 'changelog', 'review', 'integration', 'activity', 'leafMaterial'];


const GOLDEN_LEAN_SHA1 = '115e4fa6a50eaa2ce43fe48e540b3bfea2ddd79e';

describe('todo repository routes', () => {
  let server;
  let base;
  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, text: await res.text() };
  };
  const getJson = async (p) => {
    const r = await get(p);
    return { status: r.status, body: JSON.parse(r.text) };
  };

  before(async () => {
    saveSettings({
      workspaces: [{ id: workspaceFile, kind: 'file', workspaceFile }],
      workspaceSidebarConfig: { [workspaceFile]: { folders: { [cwd]: { enabled: true } } } },
    });
    writeFixtureDocument(dataDir, cwd, buildItems(5000));
    const app = express();
    registerTodosRoutes(app, {
      dataDir, getCurrentCwd: () => cwd, getCurrentWorkspaceFile: () => workspaceFile,
      agentModel: 'auto', getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999', useHttps: false,
    });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  it('/page and /counts are not captured by /:id', async () => {
    const page = await getJson('/api/todos/page?limit=5');
    assert.equal(page.status, 200);
    assert.equal(page.body.ok, true);
    assert.equal(page.body.rows.length, 5);
    assert.ok(page.body.nextCursor);
    const counts = await getJson('/api/todos/counts');
    assert.equal(counts.status, 200);
    assert.equal(counts.body.total, 5000);
    assert.equal(Object.values(counts.body.byStatus).reduce((a, b) => a + b, 0), 5000);
  });

  it('page responses carry no heavy fields and page through with the cursor', async () => {
    const seen = new Set();
    let cursor = '';
    let pages = 0;
    do {
      const { body } = await getJson(`/api/todos/page?sort=tree&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      for (const row of body.rows) {
        for (const key of HEAVY) assert.equal(key in row, false);
        assert.equal(seen.has(row.id), false);
        seen.add(row.id);
      }
      cursor = body.nextCursor || '';
      pages += 1;
    } while (cursor);
    assert.equal(seen.size, 5000);
    assert.equal(pages, 25);
    assert.equal((await getJson('/api/todos/page?cursor=garbage')).status, 400);
    assert.equal((await getJson('/api/todos/page?limit=99999')).body.rows.length, 200);
  });

  it('/:id/children pages direct children', async () => {
    const first = (await getJson('/api/todos/page?parentId=root&limit=1&sort=tree')).body.rows[0];
    const kids = await getJson(`/api/todos/${first.id}/children?limit=3`);
    assert.equal(kids.status, 200);
    assert.equal(kids.body.rows.length, 3);
    assert.ok(kids.body.rows.every((r) => r.parentId === first.id));
    assert.equal((await getJson('/api/todos/nonexistent-id/children')).status, 404);
  });

  it('point read matches the same row of the legacy list (several statuses, prefix ok)', async () => {
    const legacy = (await getJson('/api/todos')).body;
    assert.equal(legacy.items.length, 5000);
    // computedAt is stamped on every read of a review aggregate.
    const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'computedAt' ? undefined : x)));
    const seenStatus = new Set();
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 10, 25, 120, 4999]) {
      const row = legacy.items.find((i) => i.id === fixtureId(n));
      seenStatus.add(row.status);
      const one = await getJson(`/api/todos/${row.id}`);
      assert.equal(one.status, 200);
      assert.deepEqual(norm(one.body.item), norm(row), `item ${n} (${row.status})`);
    }
    assert.ok(seenStatus.size >= 3);
    const viaPrefix = await getJson(`/api/todos/${fixtureId(10).slice(0, 8)}`);
    assert.equal(viaPrefix.body.item.id, fixtureId(10));
    assert.equal((await getJson('/api/todos/ffffffff-0000')).status, 404);
  });

  it('legacy GET /api/todos stays complete and its lean body is unchanged', async () => {
    const full = (await getJson('/api/todos')).body;
    assert.equal(full.items.length, 5000);
    assert.ok(full.items.every((i) => 'body' in i && 'plan' in i));
    const lean = JSON.parse((await get('/api/todos?slim=1')).text);
    // The loader stamps plan.updatedAt with the load time and `rev` hashes it; everything else is stable.
    delete lean.rev;
    for (const item of lean.items) if (item.plan) delete item.plan.updatedAt;
    const hash = createHash('sha1').update(JSON.stringify(lean)).digest('hex');
    assert.equal(hash, GOLDEN_LEAN_SHA1, 'legacy lean list serialization changed');
  });
});
