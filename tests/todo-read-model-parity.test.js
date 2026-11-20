import './helpers/isolated-data-dir.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import {
  TODO_MCP_TOOLS,
  readTodoListLegacy,
  todoToolsTestHooks,
  readTodoShowLegacy,
} from '../lib/mcp/builtin/todo-tools.js';
import { listReadyTodoLeaves } from '../lib/todo-tree.js';
import { assessParallelRunModeForSiblings } from '../lib/todo-parallel-scope.js';
import { fingerprintTodoMaterial } from '../lib/todo-integration-proof.js';
import { FEEDBACK_ROOT_MARKER } from '../lib/feedback-marker.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { getTodoRepository } from '../lib/persist/todo-repository.js';
import { buildItems, writeFixtureDocument } from './helpers/todo-repository-fixture.js';

/**
 * Contract parity of the bounded MCP todo reads (todo_list, todo_show,
 * todo_next_ready) against the legacy whole-list implementation kept in
 * todo-tools.js: both paths run over the same persisted document and the
 * serialized tool results must be byte-identical, page by page.
 */
const dataDir = process.env.CRETLI_DATA_DIR;
setBuiltinMcpRuntimeDeps({ dataDir, workspaceDirForAgent: () => '', taskRuns: new Map() });

const tool = (name) => TODO_MCP_TOOLS.find((t) => t.name === name);
const stamp = (k) => new Date(Date.UTC(2026, 2, 1) + k * 60000).toISOString();
const uid = (n) => `fx${String(n).padStart(6, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 20 roots x (1 + 3 mids x (1 + 4 leaves)) = 320 rows plus special structures, ~350 in total. */
function buildMixedFixture() {
  /** @type {Record<string, any>[]} */
  const items = [];
  let n = 0;
  const statuses = ['idea', 'ready', 'doing', 'done', 'deferred', 'ready', 'ready'];
  const make = (parentId, siblingIndex, extra = {}) => {
    const i = n++;
    const item = {
      id: uid(i),
      title: `Todo ${i} ${i % 9 === 0 ? 'needle' : 'hay'} ${'t'.repeat(i % 5 === 0 ? 120 : 4)}`,
      body: `Body ${i} ${i % 11 === 0 ? 'zebra' : 'plain'} ${'x'.repeat(i % 13 === 0 ? 5000 : 60)}`,
      status: statuses[i % statuses.length],
      createdAt: stamp(i),
      updatedAt: stamp(i * 3),
      siblingIndex,
      ...extra,
    };
    if (parentId) item.parentId = parentId;
    if (i % 4 === 0) item.review = { code: { state: ['passed', 'failed', 'pending'][i % 3], reviewers: [] }, plan: { state: 'pending', reviewers: [] } };
    items.push(item);
    return item;
  };
  for (let r = 0; r < 20; r++) {
    const root = make('', r, {
      runMode: r % 4 === 1 ? 'parallel' : 'sequential',
      ...(r % 3 === 0 ? { plan: { markdown: `# Plan ${r}`, ...(r % 6 === 0 ? { approvedAt: stamp(r) } : {}) } } : {}),
    });
    for (let m = 0; m < 3; m++) {
      const mid = make(root.id, m, {
        runMode: m === 1 ? 'parallel' : 'sequential',
        ...(m === 2 && r % 2 ? { plan: { markdown: '# Mid plan' } } : {}),
      });
      for (let l = 0; l < 4; l++) {
        const scope = `## Leaf scope\n- src/area-${m}-${l % 2}/\n`;
        const leaf = make(mid.id, 3 - l, {
          body: `Leaf ${n} ${scope}${n % 11 === 0 ? 'zebra' : ''}`,
          ...(l === 0 && r % 5 === 0 ? { blockedReason: 'waiting on infra' } : {}),
          ...(l === 1 && r % 7 === 0 ? { nonBlocking: true, status: 'idea' } : {}),
        });
        const k = leaf.id;
        if (n % 17 === 0) leaf.integration = { state: 'ready' };
        else if (n % 19 === 0) leaf.integration = { state: 'rejected', reason: 'rejected by human' };
        else if (n % 23 === 0) leaf.integration = { state: 'ready', reason: 'integration_conflict: file' };
        else if (n % 29 === 0) leaf.integration = { state: 'integrated' };
        else if (n % 31 === 0) {
          const fields = Object.fromEntries(['targetBranch', 'targetCommit', 'sourceCommit', 'materialRevision', 'source', 'confirmedAt', 'changeRef'].map((f) => [f, `${f}-v`]));
          leaf.integration = { state: 'integrated', evidence: { ...fields, branchVerified: true, changeAttested: true, todoMaterialFingerprint: '' } };
          leaf.integration.evidence.todoMaterialFingerprint = fingerprintTodoMaterial(leaf);
        }
        void k;
      }
    }
  }
  // Follow-ups, a feedback tree, two ids sharing an 8-char prefix, one parent with 45 children.
  make('', 20, { sourceTodoId: items[1].id, title: 'Follow-up of 1' });
  make('', 21, { sourceTodoId: items[1].id, title: 'Second follow-up of 1' });
  const feedbackRoot = make('', 22, { body: `${FEEDBACK_ROOT_MARKER}\nfeedback`, status: 'ready' });
  make(feedbackRoot.id, 0, { status: 'ready', title: 'Feedback report' });
  items.push({ id: 'abcdef12-aaaa-4000-8000-000000000001', title: 'Prefix twin A', status: 'idea', updatedAt: stamp(900), siblingIndex: 30 });
  items.push({ id: 'abcdef12-bbbb-4000-8000-000000000002', title: 'Prefix twin B', status: 'idea', updatedAt: stamp(901), siblingIndex: 31 });
  const wide = make('', 40, { title: 'Wide parent', runMode: 'parallel' });
  for (let c = 0; c < 45; c++) make(wide.id, c, { status: c % 3 ? 'ready' : 'idea' });
  return items;
}

function sessionFor(workspaceFolder) {
  return { workspaceFolder, chatId: '', harness: 'testfake', mode: 'agent' };
}

/** Result (or error) of a tool call as one comparable string. */
async function run(t, client, workspaceFolder, args) {
  try {
    // `computedAt` is the review read model's wall clock; everything else must match exactly.
    return JSON.stringify(await t.handler(args, { client, session: sessionFor(workspaceFolder) })).replace(/"computedAt":"[^"]*"/g, '"computedAt":"-"');
  } catch (err) {
    return `ERROR ${err?.code || ''} ${err?.message}`;
  }
}

describe('MCP todo reads: bounded path equals legacy path', () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-parity-'));
  const fixture = buildMixedFixture();
  const bounded = createInProcessMcpClient({ harness: 'testfake', chatId: '', workspaceFolder: ws });
  // Same client minus the bounded reads: tools fall back to the whole-list implementation.
  const legacy = { ...bounded, readTodoList: undefined, readTodoShow: undefined, readTodoNextReady: undefined, resolveTodo: undefined };

  before(() => {
    writeFixtureDocument(dataDir, ws, fixture);
  });

  /** @param {string} name @param {Record<string, any>} args */
  async function same(name, args) {
    const [a, b] = await Promise.all([run(tool(name), legacy, ws, args), run(tool(name), bounded, ws, args)]);
    assert.equal(b, a, `${name} ${JSON.stringify(args)}`);
    return JSON.parse(b.startsWith('ERROR') ? '{}' : b);
  }

  async function walkList(args) {
    let cursor = '';
    let pages = 0;
    let rows = 0;
    do {
      const out = await same('todo_list', { ...args, cursor });
      rows += out.structuredContent?.items?.length ?? 0;
      cursor = out.structuredContent?.next_cursor || '';
      pages += 1;
    } while (cursor && pages < 100);
    return { pages, rows };
  }

  it('fixture is mixed and large enough', () => {
    assert.ok(fixture.length >= 300);
    assert.ok(new Set(fixture.map((i) => i.status)).size >= 5);
  });

  it('todo_list: full pagination, every status, review, integration and query filter', async () => {
    const all = await walkList({ limit: 20 });
    assert.ok(all.pages > 10 && all.rows === fixture.length);
    await walkList({ limit: 100 });
    for (const status of ['idea', 'ready', 'doing', 'done', 'deferred']) await walkList({ status, limit: 17 });
    for (const review of ['passed', 'failed', 'pending', 'none', 'plan:pending', 'plan:none', 'other:none', 'unknown']) await walkList({ review, limit: 25 });
    let matched = 0;
    for (const integration of ['unconfirmed', 'awaiting', 'integrated', 'partial', 'rejected', 'conflict', 'no_code_changes']) {
      matched += (await walkList({ integration, limit: 30 })).rows;
    }
    assert.ok(matched > 0);
    assert.ok((await walkList({ query: 'needle', limit: 10 })).rows > 0);
    assert.ok((await walkList({ query: 'ZEBRA', limit: 10 })).rows > 0);
    await walkList({ query: 'leaf scope', status: 'ready', review: 'failed', limit: 7 });
    await walkList({ status: 'ready', integration: 'awaiting', limit: 5 });
  });

  it('todo_list: compact, fields and max_chars projections', async () => {
    await walkList({ compact: true, limit: 50 });
    await walkList({ fields: ['id', 'title', 'parent_id', 'execution_state'], limit: 33 });
    await walkList({ fields: 'status,review_state,integration_state', limit: 100 });
    const capped = await same('todo_list', { limit: 100, max_chars: 2000 });
    assert.equal(capped.structuredContent.truncated_by_size, true);
    await walkList({ limit: 100, max_chars: 2000 });
    await same('todo_list', { limit: 100, max_chars: 1 });
  });

  it('todo_list: validation errors and an empty result are identical', async () => {
    for (const args of [{ status: 'bogus' }, { review: 'nope:passed' }, { review: 'weird' }, { integration: 'x' }, { query: 'no-such-text-anywhere' }, { cursor: '99999' }]) {
      await same('todo_list', args);
    }
  });

  it('todo_show: roots, containers, leaves, prefix, ambiguity, follow-ups, fields and pages', async () => {
    const ids = [fixture[0].id, fixture[1].id, fixture[2].id, fixture[3].id, fixture[9].id, fixture[20].id, fixture[21].id, fixture.find((i) => i.title === 'Wide parent').id, fixture.find((i) => i.title === 'Feedback report').id];
    for (const id of ids) {
      await same('todo_show', { todo_id: id });
      await same('todo_show', { todo_id: id, field: 'plan' });
    }
    for (const row of fixture.filter((i) => i.status === 'ready').slice(0, 40)) await same('todo_show', { todo_id: row.id.slice(0, 12).toUpperCase() });
    const wide = fixture.find((i) => i.title === 'Wide parent').id;
    let cursor = '';
    let pages = 0;
    do {
      const out = await same('todo_show', { todo_id: wide, children_cursor: cursor });
      cursor = out.structuredContent?.next_children_cursor || '';
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    const longBody = fixture.find((i) => i.body.length > 4000).id;
    const first = await same('todo_show', { todo_id: longBody });
    assert.ok(first.structuredContent.next_cursor);
    await same('todo_show', { todo_id: longBody, cursor: first.structuredContent.next_cursor });
    await same('todo_show', { todo_id: 'abcdef12' });
    await same('todo_show', { todo_id: 'abcdef12-aaaa' });
    await same('todo_show', { todo_id: 'missing-id-zzzz' });
    await same('todo_show', { todo_id: 'fx' });
    await same('todo_show', { todo_id: ids[0], field: 'bogus' });
  });

  it('todo_next_ready: whole workspace, pages, subtree roots and unknown root', async () => {
    const first = await same('todo_next_ready', {});
    assert.ok(first.structuredContent.items.length > 0);
    assert.ok(Object.keys(first.structuredContent.parallel_scope || {}).length > 0);
    let cursor = '';
    let pages = 0;
    do {
      const out = await same('todo_next_ready', { limit: 7, cursor });
      cursor = out.structuredContent?.next_cursor || '';
      pages += 1;
    } while (cursor && pages < 100);
    assert.ok(pages > 2);
    for (const id of [fixture[0].id, fixture[1].id, fixture[2].id, fixture[5].id, fixture.find((i) => i.title === 'Wide parent').id, fixture.find((i) => i.body.startsWith(FEEDBACK_ROOT_MARKER)).id]) {
      await same('todo_next_ready', { root_id: id, limit: 100 });
    }
    await same('todo_next_ready', { root_id: 'does-not-exist' });
  });

  it('parity also holds with a watcher policy (waiting_plan) and after a document edit', async () => {
    upsertWorkspaceWatcher(ws, { mode: 'observe' }, { dataDir });
    await walkList({ limit: 50 });
    await walkList({ status: 'ready', limit: 40 });
    const ready = await same('todo_next_ready', { limit: 100 });
    const states = new Set(ready.structuredContent.items.map((row) => row.execution_state));
    assert.ok(states.has('waiting_plan') || states.has('ready'), [...states].join());
    const listed = await same('todo_list', { status: 'ready', limit: 100 });
    assert.ok(listed.structuredContent.items.some((row) => row.execution_state === 'waiting_plan'), 'fixture must exercise waiting_plan');
    for (const row of fixture.filter((i) => i.status === 'ready').slice(0, 25)) await same('todo_show', { todo_id: row.id });
    const edited = fixture.map((i, k) => (k % 10 === 0 ? { ...i, status: 'done', updatedAt: stamp(5000 + k) } : i));
    writeFixtureDocument(dataDir, ws, edited);
    await walkList({ limit: 60 });
    await same('todo_next_ready', { limit: 100 });
  });

  it('todo_next_ready is document-based: it never calls a bounded method and equals the legacy reader', async () => {
    const trap = () => { throw new Error('bounded next-ready method must not be used'); };
    const spy = { ...bounded, readTodoNextReady: trap, readyCandidates: trap };
    const [viaTool, viaBounded] = await Promise.all([run(tool('todo_next_ready'), legacy, ws, { limit: 100 }), run(tool('todo_next_ready'), spy, ws, { limit: 100 })]);
    assert.equal(viaBounded, viaTool);
    assert.equal(viaTool.includes('capped'), false);
    // Independent expectation: the original handler's logic over the persisted fixture.
    const items = await legacy.listTodos({ workspaceFolder: ws });
    const ready = listReadyTodoLeaves(items);
    const out = JSON.parse(await run(tool('todo_next_ready'), spy, ws, { limit: 100 }));
    assert.deepEqual(out.structuredContent.items.map((r) => r.id), ready.slice(0, 100).map((r) => r.id));
    const parents = [...new Set(ready.map((r) => String(r.parentId || '').trim()).filter(Boolean))];
    assert.deepEqual(Object.keys(out.structuredContent.parallel_scope || {}), parents);
    for (const parent of parents) {
      const a = assessParallelRunModeForSiblings(items, parent);
      assert.equal(out.structuredContent.parallel_scope[parent].parallel_safe, a.ok);
    }
  });

  it('the exported legacy readers keep the documented shapes', async () => {
    const ctx = { workspaceFolder: ws };
    const list = await readTodoListLegacy(legacy, ctx, { status: '', reviewFilter: { ok: true, subject: 'code', state: '' }, needle: '', integrationFilter: '', offset: 0, limit: 5, policy: null });
    assert.equal(list.entries.length, 5);
    assert.ok(list.total >= 300);
    assert.equal((await readTodoShowLegacy(legacy, ctx, 'nope-nope-nope', { offset: 0, limit: 20, policy: null })).ok, false);
    assert.match(await run(tool('todo_next_ready'), legacy, ws, { root_id: 'nope' }), /^ERROR .*Todo not found: nope/);
  });
});

describe('MCP todo reads: perf on 5,000 items', () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-parity-big-'));
  const client = createInProcessMcpClient({ harness: 'testfake', chatId: '', workspaceFolder: ws });
  const items = buildItems(5000);

  before(() => writeFixtureDocument(dataDir, ws, items));

  it('todo_list page and todo_show stay under 100 ms after warm-up', async () => {
    await run(tool('todo_list'), client, ws, { limit: 20 });
    const id = items[100].id;
    await run(tool('todo_show'), client, ws, { todo_id: id });
    const t0 = performance.now();
    const list = await run(tool('todo_list'), client, ws, { limit: 20, status: 'ready' });
    const listMs = performance.now() - t0;
    const t1 = performance.now();
    const show = await run(tool('todo_show'), client, ws, { todo_id: id });
    const showMs = performance.now() - t1;
    assert.ok(!list.startsWith('ERROR') && !show.startsWith('ERROR'));
    assert.ok(listMs < 100, `todo_list took ${listMs.toFixed(1)} ms`);
    assert.ok(showMs < 100, `todo_show took ${showMs.toFixed(1)} ms`);
  });

  it('listWindow does not rebuild the index per call', async () => {
    const repo = getTodoRepository(dataDir);
    await repo.listWindow(ws, {}, { offset: 0, limit: 5 });
    const before = repo.stats.builds;
    for (let i = 0; i < 20; i++) await repo.listWindow(ws, { status: 'ready', text: 'needle' }, { offset: i, limit: 5 });
    assert.equal(repo.stats.builds, before);
  });
});

describe('todo_next_ready evaluates execution state for the returned page only', () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-ready-roots-'));
  const client = createInProcessMcpClient({ harness: 'testfake', chatId: '', workspaceFolder: ws });
  const roots = Array.from({ length: 200 }, (_, i) => ({
    id: uid(10000 + i), title: `Ready root ${i}`, body: 'b', status: 'ready', createdAt: stamp(i), updatedAt: stamp(i), siblingIndex: i,
  }));

  before(() => {
    writeFixtureDocument(dataDir, ws, roots);
    upsertWorkspaceWatcher(ws, { mode: 'observe' }, { dataDir });
  });

  it('counts one evaluation per returned row and matches the expected page', async () => {
    const seen = [];
    todoToolsTestHooks.onExecutionState = (item) => seen.push(item.id);
    try {
      for (const limit of [1, 20]) {
        seen.length = 0;
        const out = JSON.parse(await run(tool('todo_next_ready'), client, ws, { limit }));
        assert.equal(seen.length, limit, `limit ${limit}`);
        assert.deepEqual(out.structuredContent.items.map((r) => r.id), roots.slice(0, limit).map((r) => r.id));
        assert.equal(out.structuredContent.next_cursor, String(limit));
      }
    } finally {
      todoToolsTestHooks.onExecutionState = null;
    }
  });
});
