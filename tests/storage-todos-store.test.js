import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createTodosStore, TODOS_BODY_PREVIEW_MAX } from '../lib/storage/todos-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { CORE_MIGRATIONS } from '../lib/storage/migrations.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-todos-handlers.js', import.meta.url));
const WS = 'ws-a';
const WS2 = 'ws-b';

/** @type {string} */
let root;
/** @type {any[]} */
let hosts;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-todos-store-'));
  hosts = [];
});

afterEach(async () => {
  for (const host of hosts) await host.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

async function start() {
  const host = createStorageWorkerHost({
    dbDir: root, handlersPath: HANDLERS_PATH, faultInjection: true,
    writeGate: WRITE_GATE_TEST_EXEMPTION, restartBackoffMs: { initial: 5, max: 20 },
  });
  hosts.push(host);
  await host.start();
  return { host, store: createTodosStore({ host, datasetGeneration: 'gen-1' }) };
}

/** @param {Promise<unknown>} p */
async function rejection(p) {
  try { await p; } catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a rejection');
}

const item = (id, extra = {}) => ({ id, title: `t-${id}`, status: 'idea', updatedAt: '2026-01-01T00:00:00.000Z', ...extra });

describe('todos schema', () => {
  it('is part of the core migration lineage with the indexes from the ADR', async () => {
    assert.equal(CORE_MIGRATIONS.find((m) => m.version === 7).name, 'todos');
    const { host } = await start();
    const { DatabaseSync } = await import('node:sqlite');
    await host.close({ timeoutMs: 1000 });
    const db = new DatabaseSync(path.join(root, fs.readdirSync(root).find((f) => f.endsWith('.sqlite'))), { readOnly: true });
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'todos'").all().map((r) => r.name);
    db.close();
    for (const n of ['todos_by_parent', 'todos_by_status', 'todos_by_updated']) assert.ok(names.includes(n), n);
  });
});

describe('CAS', () => {
  it('rejects a stale expectedUpdatedAt without changing the row', async () => {
    const { store } = await start();
    await store.addTodo({ commandId: 'c1', workspaceKey: WS, item: item('a', { body: 'hello' }) });
    const err = await rejection(store.updateTodo({
      commandId: 'c2', workspaceKey: WS, id: 'a', expectedUpdatedAt: 'stale', set: { title: 'new', updatedAt: 'T2' },
    }));
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.conflictKind, 'todo_cas');
    const { item: stored } = await store.getTodo({ workspaceKey: WS, id: 'a' });
    assert.deepEqual(stored, item('a', { body: 'hello' }));
    // The rejected command left no receipt: the same id is free to apply with a valid CAS.
    const ok = await store.updateTodo({
      commandId: 'c2', workspaceKey: WS, id: 'a', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', set: { title: 'new', updatedAt: 'T2' },
    });
    assert.equal(ok.replayed, false);
    assert.equal((await store.getTodo({ workspaceKey: WS, id: 'a' })).item.title, 'new');
  });
});

describe('receipts and worker loss', () => {
  it('crash after COMMIT: unknown_commit, resolveUnknown committed, replay without a second apply, other payload mismatches', async () => {
    const { host, store } = await start();
    await host.command('test.arm', { commandId: 'add-1', mode: 'afterCommitExit' });
    const args = { commandId: 'add-1', workspaceKey: WS, item: item('a') };
    const err = await rejection(store.addTodo(args));
    assert.equal(err.code, 'unknown_commit');
    const resolved = await store.resolveUnknown({ ...args, operation: 'add' });
    assert.equal(resolved.outcome, 'committed');
    const replay = await store.addTodo(args);
    assert.equal(replay.replayed, true);
    assert.equal((await store.listTodos({ workspaceKey: WS })).items.length, 1, 'applied exactly once');
    const mismatch = await rejection(store.addTodo({ ...args, item: item('a', { title: 'other' }) }));
    assert.equal(mismatch.details.conflictKind, 'receipt_digest_mismatch');
    assert.equal((await store.getTodo({ workspaceKey: WS, id: 'a' })).item.title, 't-a');
  });

  it('a retry of a delivered add is replayed, not applied twice', async () => {
    const { store } = await start();
    const args = { commandId: 'add-2', workspaceKey: WS, item: item('a') };
    assert.equal((await store.addTodo(args)).replayed, false);
    assert.equal((await store.addTodo(args)).replayed, true);
    assert.equal((await store.listTodos({ workspaceKey: WS })).items.length, 1);
  });
});

describe('move and batch atomicity', () => {
  it('moveTodo moves the subtree between workspaces in one transaction', async () => {
    const { store } = await start();
    await store.batch({ commandId: 'seed', ops: [
      { op: 'add', workspaceKey: WS, item: item('p') },
      { op: 'add', workspaceKey: WS, item: item('c', { parentId: 'p', siblingIndex: 0 }) },
      { op: 'add', workspaceKey: WS, item: item('other') },
    ] });
    const res = await store.moveTodo({ commandId: 'mv', sourceWorkspaceKey: WS, targetWorkspaceKey: WS2, id: 'p', set: { updatedAt: 'T9' } });
    assert.deepEqual(res.result.moved, ['p', 'c']);
    assert.deepEqual((await store.listTodos({ workspaceKey: WS })).items.map((i) => i.id), ['other']);
    assert.deepEqual((await store.listTodos({ workspaceKey: WS2 })).items.map((i) => i.id), ['p', 'c']);
    assert.deepEqual(await store.verify({ workspaceKey: WS2 }), { count: 2, dangling: [], cyclic: [] });
  });

  it('moveTodo rejects an identity change without mutation or receipt', async () => {
    const { store } = await start();
    await store.batch({ commandId: 'seed', ops: [
      { op: 'add', workspaceKey: WS, item: item('p') },
      { op: 'add', workspaceKey: WS, item: item('c', { parentId: 'p' }) },
    ] });
    const before = await store.exportDocument({ workspaceKey: WS });
    const args = { commandId: 'mv-id', sourceWorkspaceKey: WS, targetWorkspaceKey: WS2, id: 'p', set: { id: 'renamed' } };
    const err = await rejection(store.moveTodo(args));
    assert.equal(err.details.conflictKind, 'todo_invalid_move');
    assert.deepEqual(await store.exportDocument({ workspaceKey: WS }), before);
    assert.equal(await store.exportDocument({ workspaceKey: WS2 }), null);
    // No receipt was written: the same commandId with a valid payload applies.
    const ok = await store.moveTodo({ ...args, set: { updatedAt: 'T3' } });
    assert.equal(ok.replayed, false);
    assert.deepEqual(await store.verify({ workspaceKey: WS2 }), { count: 2, dangling: [], cyclic: [] });
  });

  it('an injected failure in the middle of moveTodo changes no workspace', async () => {
    const { host, store } = await start();
    await store.batch({ commandId: 'seed', ops: [
      { op: 'add', workspaceKey: WS, item: item('p') },
      { op: 'add', workspaceKey: WS, item: item('c', { parentId: 'p' }) },
    ] });
    const before = await store.exportDocument({ workspaceKey: WS });
    await host.command('test.arm', { commandId: 'mv-fail', mode: 'midMoveThrow' });
    const err = await rejection(store.moveTodo({ commandId: 'mv-fail', sourceWorkspaceKey: WS, targetWorkspaceKey: WS2, id: 'p' }));
    assert.equal(err.details.commitState, 'not_committed');
    assert.deepEqual(await store.exportDocument({ workspaceKey: WS }), before);
    assert.equal(await store.exportDocument({ workspaceKey: WS2 }), null);
    // No receipt either: the retry with the same id now applies.
    assert.equal((await store.moveTodo({ commandId: 'mv-fail', sourceWorkspaceKey: WS, targetWorkspaceKey: WS2, id: 'p' })).replayed, false);
  });

  it('a CAS conflict inside a batch rolls back the earlier members', async () => {
    const { store } = await start();
    await store.addTodo({ commandId: 's', workspaceKey: WS, item: item('a') });
    const err = await rejection(store.batch({ commandId: 'b', ops: [
      { op: 'add', workspaceKey: WS, item: item('new') },
      { op: 'update', workspaceKey: WS, id: 'a', expectedUpdatedAt: 'stale', set: { title: 'x' } },
    ] }));
    assert.equal(err.details.conflictKind, 'todo_cas');
    assert.deepEqual((await store.listTodos({ workspaceKey: WS })).items.map((i) => i.id), ['a']);
  });
});

describe('logical export', () => {
  it('round-trips order, unknown fields, key order and tree invariants', async () => {
    const { store } = await start();
    const doc = {
      version: 3, updatedAt: 'D1', futureDocField: { x: [1, 2] },
      items: [
        { title: 'z', id: 'z', status: 'ready', updatedAt: 'U', siblingIndex: 1, mystery: { deep: [1, null] }, body: 'long', plan: { markdown: 'm' }, changelog: [{ kind: 'note' }], review: { state: 'none' } },
        item('b', { parentId: 'z', siblingIndex: 0, weirdSibling: 'x' }),
        { id: 'a', siblingIndex: 'not-a-number', status: 7 },
      ],
      idempotency: { k: { hash: 'h', todoId: 'z' } },
    };
    await store.importDocument({ commandId: 'imp', workspaceKey: WS, doc });
    assert.deepEqual(await store.exportDocument({ workspaceKey: WS }), doc);
    assert.deepEqual(Object.keys(await store.exportDocument({ workspaceKey: WS })), Object.keys(doc));
    assert.deepEqual(Object.keys((await store.getTodo({ workspaceKey: WS, id: 'z' })).item), Object.keys(doc.items[0]));
    assert.deepEqual(await store.verify({ workspaceKey: WS }), { count: 3, dangling: [], cyclic: [] });
    // Updates keep order and unknown fields.
    await store.updateTodo({ commandId: 'u', workspaceKey: WS, id: 'b', set: { status: 'done' }, unset: ['weirdSibling'] });
    const after = await store.exportDocument({ workspaceKey: WS });
    assert.deepEqual(after.items.map((i) => i.id), ['z', 'b', 'a']);
    assert.equal(after.items[1].status, 'done');
    assert.equal('weirdSibling' in after.items[1], false);
  });
});

describe('lazy list payload', () => {
  it('listTodos sends no heavy fields on the wire', async () => {
    const { host, store } = await start();
    const longBody = 'B'.repeat(50_000);
    await store.addTodo({ commandId: 'h', workspaceKey: WS, item: item('a', {
      body: longBody, plan: { markdown: 'PLANMARK'.repeat(1000) }, changelog: [{ text: 'LOGMARK'.repeat(1000) }], review: { x: 'REVMARK'.repeat(1000) },
    }) });
    // The raw wire payload of the query, not the facade: assert on the serialized result.
    const wire = JSON.stringify(await host.query('todos.list', { workspaceKey: WS }));
    for (const marker of ['PLANMARK', 'LOGMARK', 'REVMARK']) assert.ok(!wire.includes(marker), marker);
    assert.ok(wire.length < 2000, `list payload is ${wire.length} bytes`);
    const [row] = (await store.listTodos({ workspaceKey: WS })).items;
    assert.equal(row.bodyPreview.length, TODOS_BODY_PREVIEW_MAX);
    for (const key of ['body', 'plan', 'changelog', 'review']) assert.equal(key in row, false, key);
    assert.equal((await store.getTodo({ workspaceKey: WS, id: 'a' })).item.body, longBody);
  });
});
