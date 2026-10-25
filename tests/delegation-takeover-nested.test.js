/**
 * Nested orchestration takeover: tree slot/budget accounting and the
 * depth/grant state of the moved branches (follow-up from todo 0ce3a3cb).
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addTodo } from '../lib/persist/todos-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  getDelegationWorkflow,
  upsertDelegationWorkflow,
} from '../lib/persist/delegation-workflows-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  inspectDelegationTreeBudget,
  inspectDelegationWorkflowStart,
  resolveDelegationTreeRootChatId,
} from '../lib/delegation-workflow.js';
import { isRowInDelegationTree } from '../lib/delegation-tree-lock.js';
import { listOccupiedTreeSlots, resolveDelegationTreeSlots } from '../lib/delegation-width.js';
import { hasNestedDelegationGrant, readChatDelegationDepth } from '../lib/delegation-tree.js';
import { delegationController } from '../lib/delegation-control.js';
import { summarizeDelegationTreeUsage } from '../lib/delegation-workflow-budget.js';
import { recordUsage } from '../lib/usage/usage-ledger.ts';
import { readChatPlanDocument, writeChatPlanFile } from '../lib/chat-plan-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  isModelAvailable: () => true,
  dataDir: workspace,
});
let seq = 0;

function chat(extras = {}) {
  seq += 1;
  const row = addChat(`sess-nested-takeover-${seq}`, `nested-takeover-${seq}`, null, workspace, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...extras,
  });
  writeChatPlanFile({
    cwd: workspace,
    chatId: row.id,
    title: 't',
    markdown: '# t\n\n- nested takeover',
    sourceTurnId: `turn-${seq}`,
  });
  return row;
}

/**
 * from (root) -> topJob -> child (depth 1) -> nestedJob -> grandchild (depth 2).
 * The grandchild is the depth>1 branch used by the follow-up scenarios.
 */
function baseNestedTree() {
  const from = chat();
  const to = chat();
  const todo = addTodo(workspace, workspace, { title: 'Nested takeover root', orchestratorChatId: from.id }).item;
  // Pre-allocate the tree handle so every child chat can record it.
  const rootDelegationId = randomUUID();
  const child = chat({
    delegationParentChatId: from.id,
    delegationDepth: 1,
    delegationRootChatId: from.id,
    delegationRootDelegationId: rootDelegationId,
    delegationGrant: true,
  });
  const grandchild = chat({
    delegationParentChatId: child.id,
    delegationDepth: 2,
    delegationRootChatId: from.id,
    delegationRootDelegationId: rootDelegationId,
    delegationGrant: true,
  });
  const topJob = createDelegationRecord({
    id: rootDelegationId,
    parentChatId: from.id,
    childChatId: child.id,
    workspaceFolder: workspace,
    leafId: todo.id,
    depth: 1,
    rootChatId: from.id,
    rootDelegationId,
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
  });
  const nestedJob = createDelegationRecord({
    parentChatId: child.id,
    childChatId: grandchild.id,
    workspaceFolder: workspace,
    leafId: todo.id,
    depth: 2,
    rootChatId: from.id,
    rootDelegationId,
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
  });
  return { from, to, todo, rootDelegationId, child, grandchild, topJob, nestedJob };
}

function takeoverInput(tree, extra = {}) {
  return {
    chatId: tree.to.id,
    workspaceFolder: workspace,
    todoId: tree.todo.id,
    idempotencyKey: randomUUID(),
    ...extra,
  };
}

function startReview(parent, key) {
  const planDoc = readChatPlanDocument({ cwd: workspace, chatId: parent.id });
  return service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'testfake', model: 'testfake/test' },
    planRevision: planDoc.revision,
    assignment: 'review',
    idempotencyKey: key,
  });
}

async function withEnv(values, fn) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function releaseRows(...results) {
  for (const result of results) {
    if (result?.delegation?.id) updateDelegationRecord(result.delegation.id, { status: 'cancelled' });
  }
}

test('F2: depth>1 start after nested takeover counts toward the destination tree slot limit', async () => {
  const tree = baseNestedTree();
  updateDelegationRecord(tree.topJob.id, { status: 'running', slotHeldBy: 'running' });
  updateDelegationRecord(tree.nestedJob.id, { status: 'running', slotHeldBy: 'running' });

  const takeover = await service.orchestrationTakeover(takeoverInput(tree));
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  assert.equal(takeover.moved.delegations, 2);

  // Arrange/act context: after takeover the moved branch resolves its tree root
  // through the destination chat, not the historical source chat.
  assert.equal(resolveDelegationTreeRootChatId(tree.grandchild.id), tree.to.id);
  assert.equal(resolveDelegationTreeRootChatId(tree.child.id), tree.to.id);
  assert.equal(resolveDelegationTreeRootChatId(tree.to.id), tree.to.id);
  assert.equal(resolveDelegationTreeRootChatId(tree.from.id), tree.from.id);

  const occupiedTreeRows = loadDelegations().filter((row) => (
    [tree.topJob.id, tree.nestedJob.id].includes(row.id)
  ));
  assert.equal(occupiedTreeRows.length, 2);
  for (const row of occupiedTreeRows) {
    assert.equal(row.rootChatId, tree.to.id);
    assert.equal(isRowInDelegationTree(row, tree.rootDelegationId), true);
  }
  assert.equal(loadDelegations().filter((row) => row.rootChatId === tree.from.id).length, 0);

  // The pure tree-slot gate immediately blocks a full destination tree.
  const incomingRootDelegationId = loadChats().find((row) => row.id === tree.grandchild.id).delegationRootDelegationId;
  assert.equal(incomingRootDelegationId, tree.rootDelegationId);
  const slotGate = resolveDelegationTreeSlots({
    active: loadDelegations(),
    rootDelegationId: incomingRootDelegationId,
    limit: 2,
  });
  assert.equal(slotGate.ok, false);
  assert.equal(slotGate.code, 'tree_slot_limit');
  assert.equal(slotGate.blocker.rootChatId, tree.to.id);
  assert.equal(isRowInDelegationTree(slotGate.blocker, tree.rootDelegationId), true);

  // The real start in the depth>1 branch is refused by the same tree cap.
  const blocked = await withEnv({
    CRETLI_DELEGATION_MAX_DEPTH: '3',
    CRETLI_DELEGATION_TREE_SLOT_LIMIT: '2',
  }, () => startReview(tree.grandchild, 'nested-takeover-slot-full'));
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.code, 'tree_slot_limit');
  assert.equal(blocked.delegation.rootChatId, tree.to.id);
  assert.ok([tree.topJob.id, tree.nestedJob.id].includes(blocked.delegationId));

  // Releasing the destination tree's occupied rows frees the depth>1 branch.
  // They stay completed rather than cancelled: cancelling the branch's own
  // delegation would trip the parent_cancelling gate below.
  updateDelegationRecord(tree.topJob.id, { status: 'completed' });
  updateDelegationRecord(tree.nestedJob.id, { status: 'completed' });
  assert.equal(listOccupiedTreeSlots({
    active: loadDelegations(),
    rootDelegationId: tree.rootDelegationId,
  }).length, 0);
  const started = await withEnv({
    CRETLI_DELEGATION_MAX_DEPTH: '3',
    CRETLI_DELEGATION_TREE_SLOT_LIMIT: '2',
  }, () => startReview(tree.grandchild, 'nested-takeover-slot-free'));
  assert.equal(started.ok, true, JSON.stringify(started));
  const startedRow = getDelegationById(started.delegation.id);
  assert.equal(startedRow.rootChatId, tree.to.id);
  assert.equal(startedRow.rootDelegationId, tree.rootDelegationId);
  assert.equal(isRowInDelegationTree(startedRow, tree.rootDelegationId), true);
  // The new job is a real occupied slot of the destination tree, not just a
  // passive row: the tree cap counts it exactly like the moved rows.
  const occupiedAfterStart = listOccupiedTreeSlots({
    active: loadDelegations(),
    rootDelegationId: tree.rootDelegationId,
  });
  assert.equal(occupiedAfterStart.length, 1);
  assert.equal(occupiedAfterStart[0].id, startedRow.id);
  const gateWithNewJob = resolveDelegationTreeSlots({
    active: loadDelegations(),
    rootDelegationId: tree.rootDelegationId,
    limit: 1,
  });
  assert.equal(gateWithNewJob.ok, false);
  assert.equal(gateWithNewJob.code, 'tree_slot_limit');
  assert.equal(gateWithNewJob.blocker.id, startedRow.id);
  assert.equal(gateWithNewJob.blocker.rootChatId, tree.to.id);
  assert.equal(isRowInDelegationTree(gateWithNewJob.blocker, tree.rootDelegationId), true);
  releaseRows(started);
  // Finishing the new job frees its slot again.
  assert.equal(listOccupiedTreeSlots({
    active: loadDelegations(),
    rootDelegationId: tree.rootDelegationId,
  }).length, 0);
});

test('F2: tree budget gate after nested takeover reads the destination tree', async () => {
  const tree = baseNestedTree();
  upsertDelegationWorkflow({ parentChatId: tree.from.id, treeBudgetTokens: 1000 });
  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'testfake',
    model: 'nested-takeover-budget',
    eventType: 'delta',
    chatId: tree.grandchild.id,
    delegationId: tree.nestedJob.id,
    tokens: { textInput: 600 },
  });
  const sourceUsage = summarizeDelegationTreeUsage({ rootChatId: tree.from.id });
  assert.equal(sourceUsage.tokens, 600);
  assert.equal(inspectDelegationTreeBudget(tree.grandchild.id), null);

  const takeover = await service.orchestrationTakeover(takeoverInput(tree));
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  assert.equal(resolveDelegationTreeRootChatId(tree.grandchild.id), tree.to.id);

  const destinationUsage = summarizeDelegationTreeUsage({ rootChatId: tree.to.id });
  assert.equal(destinationUsage.tokens, 600);
  assert.deepEqual(
    [...destinationUsage.delegationIds].sort(),
    [tree.topJob.id, tree.nestedJob.id].sort(),
  );
  // The same spend no longer counts toward the historical source tree.
  assert.equal(summarizeDelegationTreeUsage({ rootChatId: tree.from.id }).measured, false);
  assert.equal(inspectDelegationTreeBudget(tree.from.id), null);
  // 600 < 1000: the moved spend alone is still under the destination cap.
  assert.equal(inspectDelegationTreeBudget(tree.grandchild.id), null);

  // A new successful start in the depth>1 branch after the takeover belongs to
  // the destination tree as well, so its own ledger spend adds to usage(to)
  // while usage(from) stays unmeasured.
  const newStart = await withEnv({ CRETLI_DELEGATION_MAX_DEPTH: '3' }, () => (
    startReview(tree.grandchild, 'nested-takeover-budget-new-job')
  ));
  assert.equal(newStart.ok, true, JSON.stringify(newStart));
  const newStartRow = getDelegationById(newStart.delegation.id);
  assert.equal(newStartRow.rootChatId, tree.to.id);
  assert.equal(isRowInDelegationTree(newStartRow, tree.rootDelegationId), true);
  assert.equal(summarizeDelegationTreeUsage({ rootChatId: tree.to.id }).tokens, 600);
  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'testfake',
    model: 'nested-takeover-budget',
    eventType: 'delta',
    chatId: newStartRow.childChatId,
    delegationId: newStartRow.id,
    tokens: { textInput: 300 },
  });
  const usageWithNewJob = summarizeDelegationTreeUsage({ rootChatId: tree.to.id });
  assert.equal(usageWithNewJob.measured, true);
  assert.equal(usageWithNewJob.tokens, 900);
  assert.equal(usageWithNewJob.delegationIds.includes(newStartRow.id), true);
  const sourceUsageAfterNewJob = summarizeDelegationTreeUsage({ rootChatId: tree.from.id });
  assert.equal(sourceUsageAfterNewJob.measured, false);
  assert.equal(sourceUsageAfterNewJob.tokens, 0);
  assert.equal(inspectDelegationTreeBudget(tree.grandchild.id), null);
  releaseRows(newStart);

  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'testfake',
    model: 'nested-takeover-budget',
    eventType: 'delta',
    chatId: tree.grandchild.id,
    delegationId: tree.nestedJob.id,
    tokens: { textInput: 600 },
  });
  const block = inspectDelegationTreeBudget(tree.grandchild.id);
  assert.equal(block.code, 'tree_budget_exceeded');
  // 600 (moved nested job) + 300 (new post-takeover job) + 600 = 1500.
  assert.match(block.error, /tokens 1500\/1000/);
  assert.match(block.error, new RegExp(tree.to.id));
  assert.doesNotMatch(block.error, new RegExp(tree.from.id));
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: tree.grandchild.id }).code, 'tree_budget_exceeded');

  // A real depth>1 start is blocked by the destination tree budget.
  const blockedStart = await withEnv({ CRETLI_DELEGATION_MAX_DEPTH: '3' }, () => (
    startReview(tree.grandchild, 'nested-takeover-budget-full')
  ));
  assert.equal(blockedStart.ok, false, JSON.stringify(blockedStart));
  assert.equal(blockedStart.code, 'tree_budget_exceeded');
});

test('F3: takeover keeps delegationDepth and delegationGrant on every moved branch', async () => {
  const tree = baseNestedTree();
  const noGrantChild = chat({
    delegationParentChatId: tree.child.id,
    delegationDepth: 2,
    delegationRootChatId: tree.from.id,
    delegationRootDelegationId: tree.rootDelegationId,
  });
  const noGrantJob = createDelegationRecord({
    parentChatId: tree.child.id,
    childChatId: noGrantChild.id,
    workspaceFolder: workspace,
    leafId: tree.todo.id,
    depth: 2,
    rootChatId: tree.from.id,
    rootDelegationId: tree.rootDelegationId,
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
  });

  const takeover = await service.orchestrationTakeover(takeoverInput(tree));
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  assert.equal(takeover.moved.delegations, 3);

  const chats = loadChats();
  const expectedDepthByChat = new Map([
    [tree.child.id, 1],
    [tree.grandchild.id, 2],
    [noGrantChild.id, 2],
  ]);
  for (const [chatId, expectedDepth] of expectedDepthByChat) {
    const movedChat = chats.find((row) => row.id === chatId);
    assert.equal(movedChat.delegationParentChatId, tree.to.id);
    assert.equal(movedChat.delegationRootChatId, tree.to.id);
    assert.equal(movedChat.delegationDepth, expectedDepth);
    assert.equal(readChatDelegationDepth(movedChat), expectedDepth);
  }
  assert.equal(hasNestedDelegationGrant(chats.find((row) => row.id === tree.child.id)), true);
  assert.equal(hasNestedDelegationGrant(chats.find((row) => row.id === tree.grandchild.id)), true);
  assert.equal(hasNestedDelegationGrant(chats.find((row) => row.id === noGrantChild.id)), false);

  // Rows keep their historical parent and depth; only control moved.
  assert.equal(getDelegationById(tree.topJob.id).depth, 1);
  assert.equal(getDelegationById(tree.nestedJob.id).depth, 2);
  assert.equal(getDelegationById(tree.nestedJob.id).parentChatId, tree.child.id);
  assert.equal(getDelegationById(noGrantJob.id).depth, 2);
  assert.equal(getDelegationById(noGrantJob.id).parentChatId, tree.child.id);

  // Preserved depth 2 + grant lets the branch open one more level (depth 3).
  const granted = await withEnv({ CRETLI_DELEGATION_MAX_DEPTH: '3' }, () => (
    startReview(tree.grandchild, 'nested-takeover-granted')
  ));
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const grantedRow = getDelegationById(granted.delegation.id);
  assert.equal(grantedRow.depth, 3);
  assert.equal(grantedRow.rootChatId, tree.to.id);
  assert.equal(grantedRow.rootDelegationId, tree.rootDelegationId);
  releaseRows(granted);

  // The branch that was moved without a grant stays denied.
  const denied = await withEnv({ CRETLI_DELEGATION_MAX_DEPTH: '3' }, () => (
    startReview(noGrantChild, 'nested-takeover-no-grant')
  ));
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(denied.code, 'nested_delegation_denied');

  // Preserved depth 2 is over the limit when the maximum is 2.
  const tooDeep = await withEnv({ CRETLI_DELEGATION_MAX_DEPTH: '2' }, () => (
    startReview(tree.grandchild, 'nested-takeover-too-deep')
  ));
  assert.equal(tooDeep.ok, false, JSON.stringify(tooDeep));
  assert.equal(tooDeep.code, 'depth_exceeded');
});

test('F3: scope=all takes a direct unattributed job that subtree scope leaves behind', async () => {
  // Subtree scope: only leaf-attributed seeds plus their nested rows move.
  const subtreeTree = baseNestedTree();
  const subtreeSiblingChat = chat({
    delegationParentChatId: subtreeTree.from.id,
    delegationDepth: 1,
    delegationRootChatId: subtreeTree.from.id,
  });
  const subtreeUnattributedJob = createDelegationRecord({
    parentChatId: subtreeTree.from.id,
    childChatId: subtreeSiblingChat.id,
    workspaceFolder: workspace,
    depth: 1,
    rootChatId: subtreeTree.from.id,
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
  });
  const subtreeTakeover = await service.orchestrationTakeover(takeoverInput(subtreeTree));
  assert.equal(subtreeTakeover.ok, true, JSON.stringify(subtreeTakeover));
  assert.equal(subtreeTakeover.moved.delegations, 2);
  assert.equal(delegationController(getDelegationById(subtreeTree.nestedJob.id)), subtreeTree.to.id);
  assert.equal(delegationController(getDelegationById(subtreeUnattributedJob.id)), subtreeTree.from.id);

  // scope=all: the direct unattributed job joins the takeover too.
  const allTree = baseNestedTree();
  const allSiblingChat = chat({
    delegationParentChatId: allTree.from.id,
    delegationDepth: 1,
    delegationRootChatId: allTree.from.id,
  });
  const allUnattributedJob = createDelegationRecord({
    parentChatId: allTree.from.id,
    childChatId: allSiblingChat.id,
    workspaceFolder: workspace,
    depth: 1,
    rootChatId: allTree.from.id,
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
  });
  const allTakeover = await service.orchestrationTakeover(takeoverInput(allTree, { scope: 'all' }));
  assert.equal(allTakeover.ok, true, JSON.stringify(allTakeover));
  assert.equal(allTakeover.moved.delegations, 3);
  assert.equal(delegationController(getDelegationById(allTree.nestedJob.id)), allTree.to.id);
  assert.equal(delegationController(getDelegationById(allUnattributedJob.id)), allTree.to.id);
  assert.equal(getDelegationById(allUnattributedJob.id).rootChatId, allTree.to.id);
  assert.equal(loadChats().find((row) => row.id === allSiblingChat.id).delegationParentChatId, allTree.to.id);
});

test('F3: nested branch with another leafId moves; a foreign leaf workflow is not claimed', async () => {
  const tree = baseNestedTree();
  const otherTodo = addTodo(workspace, workspace, { title: 'Other leaf', orchestratorChatId: tree.from.id }).item;
  const foreignTodo = addTodo(workspace, workspace, { title: 'Unrelated leaf', orchestratorChatId: tree.from.id }).item;
  const otherGrandchild = chat({
    delegationParentChatId: tree.child.id,
    delegationDepth: 2,
    delegationRootChatId: tree.from.id,
    delegationRootDelegationId: tree.rootDelegationId,
    delegationGrant: true,
  });
  const otherLeafJob = createDelegationRecord({
    parentChatId: tree.child.id,
    childChatId: otherGrandchild.id,
    workspaceFolder: workspace,
    leafId: otherTodo.id,
    depth: 2,
    rootChatId: tree.from.id,
    rootDelegationId: tree.rootDelegationId,
    executor: { transport: 'testfake', model: 'testfake/test' },
    status: 'completed',
  });
  upsertDelegationWorkflow({ parentChatId: tree.from.id, leafId: otherTodo.id, round: 2, maxRounds: 5 });
  // This leaf has no selected job, so it is not part of the takeover.
  upsertDelegationWorkflow({ parentChatId: tree.from.id, leafId: foreignTodo.id, round: 7, maxRounds: 9 });

  const takeover = await service.orchestrationTakeover(takeoverInput(tree));
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  // The nested branch is taken whole even though it belongs to another leaf.
  assert.equal(takeover.moved.delegations, 3);
  assert.equal(delegationController(getDelegationById(otherLeafJob.id)), tree.to.id);
  assert.equal(loadChats().find((row) => row.id === otherGrandchild.id).delegationParentChatId, tree.to.id);
  // Its leaf workflow follows the moved branch.
  assert.equal(getDelegationWorkflow(tree.to.id, otherTodo.id).round, 2);
  assert.equal(getDelegationWorkflow(tree.from.id, otherTodo.id), null);
  // The unrelated leaf workflow stays with the source chat.
  assert.equal(getDelegationWorkflow(tree.from.id, foreignTodo.id).round, 7);
  assert.equal(getDelegationWorkflow(tree.to.id, foreignTodo.id), null);
});
