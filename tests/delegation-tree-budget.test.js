import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  applyDelegationWorkflowPatch,
  fingerprintDelegationWorkflowPatch,
  inspectDelegationTreeBudget,
  inspectDelegationWorkflowStart,
  resolveDelegationTreeRootChatId,
} from '../lib/delegation-workflow.js';
import { summarizeDelegationTreeUsage } from '../lib/delegation-workflow-budget.js';
import { getDelegationWorkflow } from '../lib/persist/delegation-workflows-persist.js';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { buildDelegationRequestHash, hashDelegationContent } from '../lib/delegation-request.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { MCP_BUILTIN_ERROR_CODES, toCretliMcpToolError } from '../lib/mcp/builtin/errors.js';

let seq = 0;

function rootChat() {
  seq += 1;
  return addChat(`sess-tb-${seq}`, `tb-${seq}`, null, ISOLATED_DATA_DIR, 'm', {});
}

function childChat(root, parent = root, depth = 1) {
  seq += 1;
  return addChat(`sess-tbc-${seq}`, `tbc-${seq}`, null, ISOLATED_DATA_DIR, 'm', {
    delegationParentChatId: parent.id,
    delegationDepth: depth,
    delegationRootChatId: root.id,
    delegationGrant: true,
  });
}

function job(parentChatId, rootChatId, childChatId = '', depth = 1) {
  const text = `tree budget job ${randomUUID()}`;
  return createDelegationRecord({
    parentChatId,
    childChatId,
    rootChatId,
    depth,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment: 'implement',
    sourceKind: 'text',
    sourceText: text,
    sourceHash: hashDelegationContent(text),
    requestHash: buildDelegationRequestHash({
      parentChatId,
      sourceKind: 'text',
      sourceHash: hashDelegationContent(text),
      harness: 'opencode',
      model: 'opencode/test',
      assignment: 'implement',
    }),
    idempotencyKey: randomUUID(),
  });
}

function spend(row, textInput, textOutput = 0) {
  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'sdk',
    model: 'tree-budget-probe',
    eventType: 'delta',
    chatId: row.childChatId,
    delegationId: row.id,
    tokens: { textInput, textOutput },
  });
}

test('tree budget is stored on the chat-wide row and resolves from descendants', () => {
  const root = rootChat();
  const child = childChat(root);
  const grandchild = childChat(root, child, 2);
  applyDelegationWorkflowPatch({
    parentChatId: root.id,
    leafId: 'aaaa1111-1111-2222-3333-444455556666',
    treeBudgetTokens: 1000,
    treeBudgetCostUsd: 2.5,
  });
  const row = getDelegationWorkflow(root.id, '');
  assert.equal(row.treeBudgetTokens, 1000);
  assert.equal(row.treeBudgetCostUsd, 2.5);
  assert.equal(resolveDelegationTreeRootChatId(root.id), root.id);
  assert.equal(resolveDelegationTreeRootChatId(child.id), root.id);
  assert.equal(resolveDelegationTreeRootChatId(grandchild.id), root.id);
});

test('missing measurement neither blocks nor under-reports', () => {
  const root = rootChat();
  const childId = childChat(root).id;
  job(root.id, root.id, childId);
  applyDelegationWorkflowPatch({ parentChatId: root.id, treeBudgetTokens: 10 });
  const summary = summarizeDelegationTreeUsage({ rootChatId: root.id });
  assert.equal(summary.measured, false);
  assert.equal(inspectDelegationTreeBudget(root.id), null);
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: root.id }).ok, true);
});

test('exceeding the tree budget blocks the next start with tree_budget_exceeded', () => {
  const root = rootChat();
  const child = childChat(root);
  const own = job(root.id, root.id, randomUUID());
  const nested = job(child.id, root.id, randomUUID(), 2);
  applyDelegationWorkflowPatch({ parentChatId: root.id, treeBudgetTokens: 1000 });
  spend(own, 300, 100);
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: root.id }).ok, true);
  spend(nested, 500, 200);
  const rootBlock = inspectDelegationWorkflowStart({ parentChatId: root.id });
  assert.equal(rootBlock.ok, false);
  assert.equal(rootBlock.code, 'tree_budget_exceeded');
  assert.equal(rootBlock.status, 409);
  // The descendant inherits the gate through the tree root.
  const childBlock = inspectDelegationWorkflowStart({ parentChatId: child.id });
  assert.equal(childBlock.ok, false);
  assert.equal(childBlock.code, 'tree_budget_exceeded');
  assert.equal(toCretliMcpToolError({ code: 'tree_budget_exceeded', message: 'x' }).code, MCP_BUILTIN_ERROR_CODES.CONFLICT);
  // Raising the cap resumes.
  applyDelegationWorkflowPatch({ parentChatId: root.id, treeBudgetTokens: 50000, idempotencyKey: 'tb-raise' });
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: root.id }).ok, true);
});

test('USD cap blocks on measured usd', () => {
  const root = rootChat();
  const own = job(root.id, root.id, randomUUID());
  applyDelegationWorkflowPatch({ parentChatId: root.id, treeBudgetCostUsd: 0.5 });
  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'opencode',
    model: 'tree-budget-usd',
    eventType: 'delta',
    chatId: own.childChatId,
    delegationId: own.id,
    reportedUsd: 0.75,
    tokens: { textInput: 1, textOutput: 1 },
  });
  const block = inspectDelegationTreeBudget(root.id);
  assert.equal(block.code, 'tree_budget_exceeded');
});

test('spend does not leak across trees', () => {
  const rootA = rootChat();
  const rootB = rootChat();
  const jobA = job(rootA.id, rootA.id, randomUUID());
  const jobB = job(rootB.id, rootB.id, randomUUID());
  applyDelegationWorkflowPatch({ parentChatId: rootA.id, treeBudgetTokens: 100 });
  applyDelegationWorkflowPatch({ parentChatId: rootB.id, treeBudgetTokens: 100 });
  spend(jobB, 5000, 5000);
  assert.equal(summarizeDelegationTreeUsage({ rootChatId: rootA.id }).measured, false);
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: rootA.id }).ok, true);
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: rootB.id }).code, 'tree_budget_exceeded');
  assert.equal(summarizeDelegationTreeUsage({ rootChatId: rootB.id }).delegationIds.includes(jobA.id), false);
});

test('per-leaf budget still works independently of the tree budget', () => {
  const root = rootChat();
  const leafId = 'bbbb2222-1111-2222-3333-444455556666';
  const text = `cretli-ref todo=${leafId}\nleaf job`;
  const leafJob = createDelegationRecord({
    parentChatId: root.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment: 'implement',
    sourceKind: 'text',
    sourceText: text,
    sourceHash: hashDelegationContent(text),
    requestHash: buildDelegationRequestHash({
      parentChatId: root.id,
      sourceKind: 'text',
      sourceHash: hashDelegationContent(text),
      harness: 'opencode',
      model: 'opencode/test',
      assignment: 'implement',
    }),
    idempotencyKey: randomUUID(),
    childChatId: randomUUID(),
  });
  applyDelegationWorkflowPatch({ parentChatId: root.id, leafId, budgetTokens: 100 });
  spend(leafJob, 200, 0);
  const block = inspectDelegationWorkflowStart({ parentChatId: root.id, leafId });
  assert.equal(block.code, 'workflow_budget_exhausted');
});

test('fingerprint without tree budget equals the legacy (pre tree-budget) shape', () => {
  // Field set frozen from before the tree-budget fields existed.
  const legacyPayload = {
    leafId: '',
    role: 'review',
    round: 2,
    maxRounds: '',
    lastImplementer: '',
    lastModel: '',
    findingsHash: 'abc',
    lastVerdict: '',
    reportText: '',
    fanoutVerdicts: [],
    stopReason: { omitted: true },
    clearStop: false,
    deadlineAt: { omitted: true },
    materialRevision: { omitted: true },
    budgetTokens: { omitted: true },
    budgetCostUsd: { omitted: true },
    deadlineCancelKey: { omitted: true },
  };
  const legacyHash = createHash('sha256').update(JSON.stringify(legacyPayload), 'utf8').digest('hex');
  const patch = { role: 'review', round: 2, findingsHash: 'abc' };
  assert.equal(fingerprintDelegationWorkflowPatch(patch), legacyHash);
  assert.notEqual(fingerprintDelegationWorkflowPatch({ ...patch, treeBudgetTokens: 100 }), legacyHash);
  assert.notEqual(fingerprintDelegationWorkflowPatch({ ...patch, tree_budget_usd: 1 }), legacyHash);
});
