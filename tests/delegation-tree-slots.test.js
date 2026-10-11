import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  readDelegationTreeSlotLimit,
  resolveDelegationTreeSlots,
} from '../lib/delegation-width.js';
import { resolveDelegationWorkspaceWriteConflict } from '../lib/delegation-workspace-guard.js';
import { resolveIncomingTreeRootId, isRowInDelegationTree } from '../lib/delegation-tree-lock.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
const folderA = mkdtempSync(path.join(os.tmpdir(), 'cr-tree-slots-a-'));
const folderB = mkdtempSync(path.join(os.tmpdir(), 'cr-tree-slots-b-'));
const folderByChat = new Map();
const service = createDelegationService({
  workspaceDirForAgent: (chat) => folderByChat.get(chat.id) || folderA,
  isModelAvailable: () => true,
});
let seq = 0;

function chat(folder, extras = {}) {
  seq += 1;
  const c = addChat(`sess-slots-${seq}`, `slots-${seq}`, null, folder, 'm', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
    ...extras,
  });
  folderByChat.set(c.id, folder);
  writeChatPlanFile({ cwd: folder, chatId: c.id, title: 't', markdown: '# t\n\n- s', sourceTurnId: 'x' });
  return c;
}

function start(parent, assignment, key) {
  const planDoc = readChatPlanDocument({ cwd: folderByChat.get(parent.id), chatId: parent.id });
  return service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    planRevision: planDoc.revision,
    assignment,
    idempotencyKey: key,
  });
}

function childOf(parent, rootDelegationId, folder) {
  return chat(folder, {
    delegationParentChatId: parent.id,
    delegationDepth: 1,
    delegationRootChatId: parent.id,
    delegationRootDelegationId: rootDelegationId,
    delegationGrant: true,
  });
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function releaseAll(...results) {
  for (const r of results) {
    if (r?.delegation?.id) updateDelegationRecord(r.delegation.id, { status: 'cancelled' });
  }
}

test('tree slot limit env parses; default 0 = off', async () => {
  await withEnv('CRETLI_DELEGATION_TREE_SLOT_LIMIT', undefined, () => assert.equal(readDelegationTreeSlotLimit(), 0));
  await withEnv('CRETLI_DELEGATION_TREE_SLOT_LIMIT', 'abc', () => assert.equal(readDelegationTreeSlotLimit(), 0));
  await withEnv('CRETLI_DELEGATION_TREE_SLOT_LIMIT', '-3', () => assert.equal(readDelegationTreeSlotLimit(), 0));
  await withEnv('CRETLI_DELEGATION_TREE_SLOT_LIMIT', '3', () => assert.equal(readDelegationTreeSlotLimit(), 3));
});

test('resolveDelegationTreeSlots counts only occupied rows of one tree', () => {
  const running = (id, root, extra = {}) => ({ id, rootDelegationId: root, status: 'running', ...extra });
  const active = [
    running('a', 'T1'),
    running('b', 'T1', { assignment: 'review' }),
    running('c', 'T2'),
    { id: 'q', rootDelegationId: 'T1', status: 'queued' },
  ];
  assert.equal(resolveDelegationTreeSlots({ active, rootDelegationId: 'T1', limit: 0 }).ok, true);
  assert.equal(resolveDelegationTreeSlots({ active, rootDelegationId: 'T1', limit: 3 }).ok, true);
  const full = resolveDelegationTreeSlots({ active, rootDelegationId: 'T1', limit: 2 });
  assert.equal(full.ok, false);
  assert.equal(full.code, 'tree_slot_limit');
  assert.equal(resolveDelegationTreeSlots({ active, rootDelegationId: 'T1', limit: 2, resumeDelegationId: 'a' }).ok, true);
  assert.equal(resolveDelegationTreeSlots({ active, rootDelegationId: 'T2', limit: 2 }).ok, true);
  assert.equal(resolveDelegationTreeSlots({ active, rootDelegationId: '', limit: 1 }).ok, true);
});

test('write lock: same-tree other parent is workspace_busy, other tree/folder is not', () => {
  const rows = [{
    id: 'm1', status: 'running', assignment: 'implement', parentChatId: 'p1',
    rootDelegationId: 'T1', executionFolder: folderA, workspaceFolder: folderA,
  }];
  const base = { active: rows, executionFolder: folderA, workspaceFolder: folderA, incomingAssignment: 'implement' };
  const sameTree = resolveDelegationWorkspaceWriteConflict({ ...base, parentChatId: 'p2', rootDelegationId: 'T1' });
  assert.equal(sameTree.code, 'workspace_busy');
  assert.match(sameTree.error, /delegation tree/);
  const foreign = resolveDelegationWorkspaceWriteConflict({ ...base, parentChatId: 'p3', rootDelegationId: 'T9' });
  assert.equal(foreign.code, 'workspace_busy');
  assert.doesNotMatch(foreign.error, /delegation tree/);
  const otherFolder = resolveDelegationWorkspaceWriteConflict({
    ...base, executionFolder: folderB, workspaceFolder: folderB, parentChatId: 'p2', rootDelegationId: 'T1',
  });
  assert.equal(otherFolder.ok, true);
  const review = resolveDelegationWorkspaceWriteConflict({
    ...base, parentChatId: 'p2', rootDelegationId: 'T1', incomingAssignment: 'review',
  });
  assert.equal(review.ok, true);
});

test('tree root resolution: root chat opens a new tree, child joins its own', () => {
  assert.equal(resolveIncomingTreeRootId({ parent: { id: 'r' } }), '');
  assert.equal(
    resolveIncomingTreeRootId({ parent: { id: 'c', delegationParentChatId: 'r', delegationRootDelegationId: 'D1' } }),
    'D1',
  );
  assert.equal(resolveIncomingTreeRootId({ existing: { id: 'x', rootDelegationId: 'D7' } }), 'D7');
  assert.equal(resolveIncomingTreeRootId({ existing: { id: 'legacy', parentChatId: 'p' } }), 'legacy');
  assert.equal(isRowInDelegationTree({ id: 'z', rootDelegationId: 'D1' }, 'D1'), true);
  assert.equal(isRowInDelegationTree({ id: 'z', rootDelegationId: 'D1' }, ''), false);
});

test('service: two descendants of one tree do not mutate one folder in parallel', async () => {
  const root = chat(folderA);
  const treeRoot = await start(root, 'implement', 'tree-slots-root');
  assert.equal(treeRoot.ok, true);
  const rootDelegationId = treeRoot.delegation.id;
  const childA = childOf(root, rootDelegationId, folderA);
  const childB = childOf(root, rootDelegationId, folderA);
  const first = await withEnv('CRETLI_DELEGATION_MAX_DEPTH', '3', () => start(childA, 'implement', 'tree-slots-a'));
  // The tree root itself is a mutating job in folderA, so even the first
  // descendant is serialized behind it.
  assert.equal(first.ok, false);
  assert.equal(first.code, 'workspace_busy');
  const second = await withEnv('CRETLI_DELEGATION_MAX_DEPTH', '3', () => start(childB, 'implement', 'tree-slots-b'));
  assert.equal(second.ok, false);
  assert.equal(second.code, 'workspace_busy');
  releaseAll(treeRoot);
  const afterRelease = await withEnv('CRETLI_DELEGATION_MAX_DEPTH', '3', () => start(childA, 'implement', 'tree-slots-a2'));
  assert.equal(afterRelease.ok, true);
  const parallel = await withEnv('CRETLI_DELEGATION_MAX_DEPTH', '3', () => start(childB, 'implement', 'tree-slots-b2'));
  assert.equal(parallel.ok, false);
  assert.equal(parallel.code, 'workspace_busy');
  assert.match(parallel.error, /delegation tree/);
  releaseAll(afterRelease);
});

test('service: different trees/folders stay parallel and tree cap applies', async () => {
  const rootA = chat(folderA);
  const rootB = chat(folderB);
  const jobA = await start(rootA, 'implement', 'tree-par-a');
  const jobB = await start(rootB, 'implement', 'tree-par-b');
  assert.equal(jobA.ok, true);
  assert.equal(jobB.ok, true);
  releaseAll(jobA, jobB);

  const root = chat(folderA);
  const reviewRoot = await start(root, 'review', 'tree-cap-root');
  assert.equal(reviewRoot.ok, true);
  const treeId = reviewRoot.delegation.id;
  const c1 = childOf(root, treeId, folderA);
  const c2 = childOf(root, treeId, folderA);
  await withEnv('CRETLI_DELEGATION_MAX_DEPTH', '3', () => withEnv('CRETLI_DELEGATION_TREE_SLOT_LIMIT', '2', async () => {
    const r1 = await start(c1, 'review', 'tree-cap-1');
    assert.equal(r1.ok, true);
    // root review + r1 = 2 occupied slots of the tree: the third is refused.
    const r2 = await start(c2, 'review', 'tree-cap-2');
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'tree_slot_limit');
    releaseAll(r1);
  }));
  await withEnv('CRETLI_DELEGATION_MAX_DEPTH', '3', async () => {
    const free = await start(c2, 'review', 'tree-cap-off');
    assert.equal(free.ok, true);
    releaseAll(free);
  });
  releaseAll(reviewRoot);
});
