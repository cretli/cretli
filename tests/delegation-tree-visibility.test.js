import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  listDelegationsForRootChat,
  listDelegationsForTreeRoot,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { buildDelegationTreeSnapshot, selectVisibleTreeRows } from '../lib/delegation-tree-view.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

const folder = mkdtempSync(path.join(os.tmpdir(), 'cr-tree-vis-'));
let seq = 0;

function chat(extras = {}) {
  seq += 1;
  return addChat(`sess-vis-${seq}`, `vis-${seq}`, null, folder, 'm', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...extras,
  });
}

/** Delegation row plus its executor child chat, wired like the real service. */
function job(parent, { root, rootChatId, depth, grant = true, status = 'completed' }) {
  const child = chat({
    delegationParentChatId: parent.id,
    delegationDepth: depth,
    delegationRootChatId: rootChatId,
    delegationGrant: grant,
  });
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    rootChatId,
    rootDelegationId: root || undefined,
    depth,
    workspaceFolder: folder,
    executionFolder: '/private/exec/folder',
    planMarkdown: 'PLAN-SECRET',
    sourceText: 'SOURCE-SECRET',
    executor: { transport: 'testfake', model: 'testfake/test' },
    status,
    allowChildDelegations: grant,
    assignment: 'implement',
  });
  updateDelegationRecord(row.id, { report: 'REPORT-SECRET', error: '' });
  return { row, child };
}

// Tree 1 (root chat R): A -> {A1 -> A11, A2}; independent sibling tree B.
const R = chat();
const A = job(R, { rootChatId: R.id, depth: 1 });
const A1 = job(A.child, { root: A.row.id, rootChatId: R.id, depth: 2 });
const A2 = job(A.child, { root: A.row.id, rootChatId: R.id, depth: 2, status: 'running' });
const A11 = job(A1.child, { root: A.row.id, rootChatId: R.id, depth: 3 });
const B = job(R, { rootChatId: R.id, depth: 1 });
// Foreign tree (root chat R2), same workspace on purpose.
const R2 = chat();
const F = job(R2, { rootChatId: R2.id, depth: 1 });
const F1 = job(F.child, { root: F.row.id, rootChatId: R2.id, depth: 2 });

function ids(snapshot) {
  return snapshot.nodes.map((node) => node.id).sort();
}

function relation(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id)?.relation;
}

test('persist queries group by root chat and root delegation', () => {
  assert.deepEqual(
    listDelegationsForRootChat(R.id).map((r) => r.id).sort(),
    [A.row.id, A1.row.id, A2.row.id, A11.row.id, B.row.id].sort(),
  );
  assert.deepEqual(
    listDelegationsForTreeRoot(A.row.id).map((r) => r.id).sort(),
    [A.row.id, A1.row.id, A2.row.id, A11.row.id].sort(),
  );
  assert.deepEqual(listDelegationsForRootChat('nope'), []);
});

test('root chat sees every descendant and never a foreign tree', () => {
  const snapshot = buildDelegationTreeSnapshot({ chatId: R.id, chat: R });
  assert.equal(snapshot.viewer, 'root');
  assert.deepEqual(ids(snapshot), [A.row.id, A1.row.id, A2.row.id, A11.row.id, B.row.id].sort());
  assert.ok(!ids(snapshot).includes(F.row.id));
  assert.ok(!ids(snapshot).includes(F1.row.id));
  const a11 = snapshot.nodes.find((n) => n.id === A11.row.id);
  assert.equal(a11.parent_delegation_id, A1.row.id);
  assert.equal(a11.depth, 3);
});

test('child sees own subtree and ancestors, not siblings or other branches', () => {
  const snap = buildDelegationTreeSnapshot({ chatId: A1.child.id, chat: A1.child });
  assert.equal(snap.viewer, 'child');
  assert.deepEqual(ids(snap), [A.row.id, A1.row.id, A11.row.id].sort());
  assert.equal(relation(snap, A1.row.id), 'self');
  assert.equal(relation(snap, A.row.id), 'ancestor');
  assert.equal(relation(snap, A11.row.id), 'descendant');
  assert.ok(!ids(snap).includes(A2.row.id), 'sibling A2 is out of scope');
  assert.ok(!ids(snap).includes(B.row.id), 'other tree under the same root chat is out of scope');
});

test('leaf child sees only its ancestor chain', () => {
  const snap = buildDelegationTreeSnapshot({ chatId: A11.child.id, chat: A11.child });
  assert.deepEqual(ids(snap), [A.row.id, A1.row.id, A11.row.id].sort());
  const sibling = buildDelegationTreeSnapshot({ chatId: A2.child.id, chat: A2.child });
  assert.deepEqual(ids(sibling), [A.row.id, A2.row.id].sort());
});

test('a foreign tree child cannot reach this tree', () => {
  const snap = buildDelegationTreeSnapshot({ chatId: F.child.id, chat: F.child });
  assert.deepEqual(ids(snap), [F.row.id, F1.row.id].sort());
  const rootOnly = buildDelegationTreeSnapshot({ chatId: R2.id, chat: R2 });
  assert.deepEqual(ids(rootOnly), [F.row.id, F1.row.id].sort());
});

test('unknown chat and orphaned child chat see nothing', () => {
  assert.deepEqual(buildDelegationTreeSnapshot({ chatId: 'missing' }).nodes, []);
  const orphan = chat({ delegationParentChatId: R.id, delegationDepth: 1, delegationRootChatId: R.id });
  const snap = buildDelegationTreeSnapshot({ chatId: orphan.id, chat: orphan });
  assert.deepEqual(snap.nodes, []);
});

test('selectVisibleTreeRows is pure and cycle safe', () => {
  const a = { id: 'a', parentChatId: 'c-b', childChatId: 'c-a', rootDelegationId: 'a' };
  const b = { id: 'b', parentChatId: 'c-a', childChatId: 'c-b', rootDelegationId: 'a' };
  const out = selectVisibleTreeRows({ rows: [a, b], viewerChatId: 'c-a', viewerRow: a });
  assert.deepEqual(out.rows.map((item) => item.row.id).sort(), ['a', 'b']);
});

test('pagination covers the whole tree without duplicates', () => {
  const first = buildDelegationTreeSnapshot({ chatId: R.id, chat: R, limit: 2 });
  assert.equal(first.nodes.length, 2);
  assert.equal(first.total, 5);
  assert.ok(first.next_cursor);
  const seen = new Set(ids(first));
  let cursor = first.next_cursor;
  while (cursor) {
    const page = buildDelegationTreeSnapshot({ chatId: R.id, chat: R, limit: 2, cursor });
    for (const id of ids(page)) {
      assert.ok(!seen.has(id), 'no duplicates across pages');
      seen.add(id);
    }
    cursor = page.next_cursor;
  }
  assert.equal(seen.size, 5);
});

test('rootDelegationId and status filters narrow within scope only', () => {
  const only = buildDelegationTreeSnapshot({ chatId: R.id, chat: R, rootDelegationId: B.row.id });
  assert.deepEqual(ids(only), [B.row.id]);
  const foreign = buildDelegationTreeSnapshot({ chatId: R.id, chat: R, rootDelegationId: F.row.id });
  assert.deepEqual(foreign.nodes, []);
  const running = buildDelegationTreeSnapshot({ chatId: R.id, chat: R, status: 'running' });
  assert.deepEqual(ids(running), [A2.row.id]);
});

test('counters are labelled and carry no ids or report bodies', () => {
  const snap = buildDelegationTreeSnapshot({ chatId: A1.child.id, chat: A1.child });
  assert.equal(snap.counters.slots.scope, 'root_delegation_id');
  assert.equal(snap.counters.budget.scope, 'root_chat_id');
  assert.equal(snap.counters.budget.root_chat_id, R.id);
  assert.equal(typeof snap.counters.slots.occupied_total, 'number');
  assert.equal(snap.counters.budget.measured, false);
  const text = JSON.stringify(snap);
  for (const secret of ['REPORT-SECRET', 'PLAN-SECRET', 'SOURCE-SECRET', '/private/exec/folder']) {
    assert.ok(!text.includes(secret), `${secret} must not leak`);
  }
});

function tool(name) {
  return DELEGATION_MCP_TOOLS.find((item) => item.name === name);
}

function toolCtx(chatId) {
  const session = { chatId, workspaceFolder: folder };
  return { client: createInProcessMcpClient({ chatId, workspaceFolder: folder }), session };
}

test('delegation_tree tool is read-only and bridge-name safe', () => {
  const def = tool('delegation_tree');
  assert.ok(def);
  assert.equal(def.readOnly, true);
  assert.ok(def.name.length <= 40);
});

test('delegation_tree uses the session chat; a foreign chat_id is rejected', async () => {
  const def = tool('delegation_tree');
  const ctx = toolCtx(A1.child.id);
  const own = await def.handler({}, ctx);
  assert.deepEqual(
    own.structuredContent.nodes.map((n) => n.id).sort(),
    [A.row.id, A1.row.id, A11.row.id].sort(),
  );
  await assert.rejects(
    () => def.handler({ chat_id: R.id }, ctx),
    (err) => err.code === 'CONFLICT' || /calling chat/.test(String(err.message)),
  );
  await assert.rejects(
    () => def.handler({ chat_id: F.child.id }, ctx),
    (err) => /calling chat/.test(String(err.message)),
  );
});

test('delegation_list scope=tree is session-scoped and paginated', async () => {
  const def = tool('delegation_list');
  const root = await def.handler({ scope: 'tree', limit: 2 }, toolCtx(R.id));
  assert.equal(root.structuredContent.items.length, 2);
  assert.ok(root.structuredContent.next_cursor);
  assert.ok(root.structuredContent.counters.slots);
  await assert.rejects(
    () => def.handler({ scope: 'tree', chat_id: R2.id }, toolCtx(R.id)),
    (err) => /calling chat/.test(String(err.message)),
  );
});
