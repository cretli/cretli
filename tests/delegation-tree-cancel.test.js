import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
} from '../lib/persist/delegations-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { collectDelegationSubtreePostOrder, canChatCancelDelegationTree } from '../lib/delegation-tree-cancel.js';

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

/** Per-chat fake run state; `stuck` chats stay busy after cancel, `broken` ones throw. */
const runs = new Map();
const cancelOrder = [];
registerChatRunAdapter({
  transport: 'testfake',
  getState: ({ chat }) => runs.get(chat.id) || { runId: '', busy: false, waitingForInput: false },
  cancel: async ({ chat }) => {
    cancelOrder.push(chat.id);
    const state = runs.get(chat.id);
    if (!state) return;
    if (state.broken) throw new Error('adapter down');
    if (!state.stuck) state.busy = false;
  },
  start: async () => ({ accepted: true, runId: 'r' }),
});

let seq = 0;
function chat(extras = {}) {
  seq += 1;
  return addChat(`sess-tc-${seq}`, `tc-${seq}`, null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...extras,
  });
}

function job(parent, { root, rootChatId, depth, status = 'running', flags = {} }) {
  const child = chat({ delegationParentChatId: parent.id, delegationDepth: depth, delegationRootChatId: rootChatId });
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    rootChatId,
    rootDelegationId: root || undefined,
    depth,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status,
    attemptId: `a-${child.id}`,
    runId: `r-${child.id}`,
    allowChildDelegations: true,
  });
  if (status === 'running') runs.set(child.id, { runId: `r-${child.id}`, busy: true, waitingForInput: false, ...flags });
  return { row, child };
}

// Root chat R -> A (d1) -> {A1 (d2) -> A11 (d3) -> A111 (d4), A2 (d2, completed)}; sibling tree B.
function buildTree() {
  const R = chat();
  const A = job(R, { rootChatId: R.id, depth: 1 });
  const A1 = job(A.child, { root: A.row.id, rootChatId: R.id, depth: 2 });
  const A2 = job(A.child, { root: A.row.id, rootChatId: R.id, depth: 2, status: 'completed' });
  const A11 = job(A1.child, { root: A.row.id, rootChatId: R.id, depth: 3 });
  const A111 = job(A11.child, { root: A.row.id, rootChatId: R.id, depth: 4 });
  const B = job(R, { rootChatId: R.id, depth: 1 });
  return { R, A, A1, A2, A11, A111, B };
}

const status = (j) => getDelegationById(j.row.id).status;

test('post-order collection puts descendants before ancestors', () => {
  const t = buildTree();
  const rows = [t.A, t.A1, t.A2, t.A11, t.A111, t.B].map((j) => getDelegationById(j.row.id));
  const order = collectDelegationSubtreePostOrder({ start: getDelegationById(t.A.row.id), rows }).map((r) => r.id);
  assert.equal(order.length, 5);
  assert.ok(!order.includes(t.B.row.id));
  assert.ok(order.indexOf(t.A111.row.id) < order.indexOf(t.A11.row.id));
  assert.ok(order.indexOf(t.A11.row.id) < order.indexOf(t.A1.row.id));
  assert.equal(order[order.length - 1], t.A.row.id);
});

test('cancelTree stops a 4-level tree leaves-first and is idempotent', async () => {
  const t = buildTree();
  cancelOrder.length = 0;
  const first = await service.cancelTree(t.A.row.id);
  assert.equal(first.ok, true);
  assert.equal(first.cancelled, 4);
  assert.equal(first.already_terminal, 1);
  assert.equal(first.pending, 0);
  assert.deepEqual(first.failed, []);
  for (const j of [t.A, t.A1, t.A11, t.A111]) assert.equal(status(j), 'cancelled');
  assert.equal(status(t.A2), 'completed');
  assert.equal(status(t.B), 'running', 'sibling tree untouched');
  const chatOrder = cancelOrder.filter((id) => [t.A.child.id, t.A1.child.id, t.A11.child.id, t.A111.child.id].includes(id));
  assert.deepEqual(chatOrder, [t.A111.child.id, t.A11.child.id, t.A1.child.id, t.A.child.id]);
  const calls = cancelOrder.length;
  const second = await service.cancelTree(t.A.row.id);
  assert.equal(second.ok, true);
  assert.equal(second.cancelled, 0);
  assert.equal(second.already_terminal, 5);
  assert.equal(second.total, first.total);
  assert.equal(cancelOrder.length, calls, 'repeat issues no adapter cancel');
});

test('subtree cancel leaves ancestors and siblings alone', async () => {
  const t = buildTree();
  const summary = await service.cancelTree(t.A1.row.id);
  assert.equal(summary.cancelled, 3);
  assert.equal(status(t.A1), 'cancelled');
  assert.equal(status(t.A11), 'cancelled');
  assert.equal(status(t.A111), 'cancelled');
  assert.equal(status(t.A), 'running');
});

test('partial failure and pending nodes are reported without aborting the rest', async () => {
  const t = buildTree();
  runs.get(t.A111.child.id).stuck = true;
  runs.get(t.A11.child.id).broken = true;
  const first = await service.cancelTree(t.A.row.id);
  assert.equal(first.ok, true, 'pending/adapter failure does not fail the command');
  assert.equal(status(t.A1), 'cancelled', 'ancestors above a stuck node are still cancelled');
  assert.equal(status(t.A), 'cancelled');
  assert.ok(first.pending + first.cancelling >= 1);
  assert.equal(first.cancelled + first.pending + first.cancelling + first.already_terminal + first.failed.length, first.total);
  // Repeat does not double-cancel a node already in cancelling.
  assert.equal(status(t.A111), 'cancelling');
  cancelOrder.length = 0;
  const again = await service.cancelTree(t.A.row.id);
  assert.ok(!cancelOrder.includes(t.A111.child.id), 'a cancelling node is not cancelled twice');
  assert.equal(again.nodes.find((n) => n.id === t.A111.row.id).outcome, 'cancelling');
  assert.equal(again.total, first.total);
});

test('unknown delegation is a 404 summary', async () => {
  const out = await service.cancelTree('missing');
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
});

test('canChatCancelDelegationTree: parent or root chat only', () => {
  const t = buildTree();
  const a1 = getDelegationById(t.A1.row.id);
  assert.equal(canChatCancelDelegationTree(a1, t.A.child.id), true, 'parent chat');
  assert.equal(canChatCancelDelegationTree(a1, t.R.id), true, 'root chat');
  assert.equal(canChatCancelDelegationTree(a1, t.A1.child.id), false, 'own row');
  assert.equal(canChatCancelDelegationTree(a1, t.A2.child.id), false, 'sibling');
  assert.equal(canChatCancelDelegationTree(a1, t.A11.child.id), false, 'descendant');
  assert.equal(canChatCancelDelegationTree(a1, ''), false);
});

test('delegation_cancel tree=true enforces session chat scope', async () => {
  const t = buildTree();
  const tool = DELEGATION_MCP_TOOLS.find((item) => item.name === 'delegation_cancel');
  const callAs = async (chatId, args) => {
    const client = createInProcessMcpClient({ chatId, workspaceFolder: ISOLATED_DATA_DIR });
    return tool.handler(args, { client, session: { chatId, workspaceFolder: ISOLATED_DATA_DIR } });
  };
  // Child A1 cannot cancel its ancestor A, its own row, or a sibling branch.
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A.row.id, tree: true }));
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A1.row.id, tree: true }));
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A2.row.id, tree: true }));
  // Spoofed chat id is refused.
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A11.row.id, tree: true, chat_id: t.R.id }));
  assert.equal(status(t.A), 'running');
  assert.equal(status(t.A11), 'running');
  // A child may cancel its own subtree.
  const own = await callAs(t.A1.child.id, { delegation_id: t.A11.row.id, tree: true });
  assert.equal(own.structuredContent.cancelled, 2);
  assert.equal(status(t.A11), 'cancelled');
  assert.equal(status(t.A1), 'running');
  // The root chat cancels the whole tree.
  const whole = await callAs(t.R.id, { delegation_id: t.A.row.id, tree: true });
  assert.equal(whole.structuredContent.cancelled, 2);
  assert.equal(status(t.A), 'cancelled');
  assert.equal(status(t.B), 'running');
});

test('a parent under a cancelling or cancelled job cannot start a child (parent_cancelling)', async () => {
  const t = buildTree();
  runs.get(t.A11.child.id).stuck = true;
  const start = (parentChatId) => service.createAndStart({
    parentChatId,
    assignment: 'implement',
    executor: { transport: 'testfake', model: 'testfake/test' },
    sourceKind: 'text',
    taskText: 'child work',
    idempotencyKey: `pc-${parentChatId}-${Math.random()}`,
  });
  await service.cancelTree(t.A1.row.id);
  assert.equal(status(t.A11), 'cancelling', 'stuck run stays cancelling');
  // The stuck node's own chat and its descendant chat are refused.
  const direct = await start(t.A11.child.id);
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'parent_cancelling');
  const viaAncestor = await start(t.A111.child.id);
  assert.equal(viaAncestor.ok, false);
  assert.equal(viaAncestor.code, 'parent_cancelling', 'cancelled ancestor blocks too');
  // A chat outside the cancelled branch is not affected by the cancel gate.
  const normal = await start(t.B.child.id);
  assert.notEqual(normal.code, 'parent_cancelling');
});

test('single delegation_cancel enforces session chat ownership', async () => {
  const t = buildTree();
  const tool = DELEGATION_MCP_TOOLS.find((item) => item.name === 'delegation_cancel');
  const callAs = async (chatId, args) => {
    const client = createInProcessMcpClient({ chatId, workspaceFolder: ISOLATED_DATA_DIR });
    return tool.handler(args, { client, session: { chatId, workspaceFolder: ISOLATED_DATA_DIR } });
  };
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A.row.id }));
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A2.row.id }));
  await assert.rejects(callAs(t.A1.child.id, { delegation_id: t.A11.row.id, chat_id: t.R.id }));
  assert.equal(status(t.A), 'running');
  const own = await callAs(t.A1.child.id, { delegation_id: t.A11.row.id });
  assert.equal(own.structuredContent.status, 'cancelled');
});

test('cancelTree finishes a cancelling node whose run already stopped', async () => {
  const t = buildTree();
  runs.get(t.A11.child.id).stuck = true;
  await service.cancelTree(t.A11.row.id);
  assert.equal(status(t.A11), 'cancelling');
  runs.get(t.A11.child.id).busy = false;
  const out = await service.cancelTree(t.A11.row.id);
  assert.equal(status(t.A11), 'cancelled');
  assert.equal(out.nodes.find((n) => n.id === t.A11.row.id).outcome, 'cancelled');
});
