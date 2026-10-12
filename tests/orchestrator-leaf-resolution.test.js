import './helpers/isolated-data-dir.js';
process.env.CRETLI_LEAF_MATERIAL_CHECKPOINT = '0';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, updateTodo } from '../lib/persist/todos-persist.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { getModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { inspectDelegationWorkflowStart } from '../lib/delegation-workflow.js';
import { isFlashDelegationModel } from '../lib/model-pick-gate-primitives.js';
import {
  LEAF_SOURCE_INFERRED,
  LEAF_RESOLUTION_WARNING_MISSING,
  resolveRequestLeafContext,
} from '../lib/orchestrator-leaf-resolution.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const workspace = ISOLATED_DATA_DIR;

function makeOrchestratorTree({
  doingLeaves = 1,
  largeLeaf = false,
  bindRootOnChat = false,
  zeroDoingLeaves = false,
  projectDir = workspace,
} = {}) {
  const rootPlaceholder = addTodo(workspace, projectDir, {
    title: 'Root',
    status: 'doing',
  }).item;
  assert.ok(rootPlaceholder?.id);
  const orchestrator = addChat(randomUUID(), 'orch', null, projectDir, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
    ...(bindRootOnChat ? { todoId: rootPlaceholder.id } : {}),
  });
  updateTodo(workspace, projectDir, rootPlaceholder.id, {
    orchestratorChatId: orchestrator.id,
  });
  const root = { ...rootPlaceholder, orchestratorChatId: orchestrator.id };
  /** @type {string[]} */
  const leafIds = [];
  if (zeroDoingLeaves) {
    const idle = addTodo(workspace, projectDir, {
      title: 'Idle leaf',
      status: 'ready',
      parentId: root.id,
      body: 'Waiting.',
    }).item;
    assert.ok(idle?.id);
    return { orchestrator, root, leafIds };
  }
  for (let i = 0; i < doingLeaves; i += 1) {
    const body = largeLeaf
      ? ['Files:', 'lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/d.js'].join('\n')
      : 'Touch lib/single.js only.';
    const leaf = addTodo(workspace, projectDir, {
      title: `Leaf ${i + 1}`,
      status: 'doing',
      parentId: root.id,
      body,
    }).item;
    assert.ok(leaf?.id);
    leafIds.push(String(leaf.id));
  }
  return { orchestrator, root, leafIds, projectDir };
}

function makeGrandchildDoingLeafTree({ bindRootOnChat = false, projectDir = workspace } = {}) {
  const rootRow = addTodo(workspace, projectDir, {
    title: 'Root',
    status: 'doing',
  }).item;
  assert.ok(rootRow?.id);
  const orchestrator = addChat(randomUUID(), 'orch-grand', null, projectDir, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
    ...(bindRootOnChat ? { todoId: rootRow.id } : {}),
  });
  updateTodo(workspace, projectDir, rootRow.id, { orchestratorChatId: orchestrator.id });
  const mid = addTodo(workspace, projectDir, {
    title: 'Mid',
    status: 'doing',
    parentId: rootRow.id,
  }).item;
  assert.ok(mid?.id);
  const leaf = addTodo(workspace, projectDir, {
    title: 'Grand leaf',
    status: 'doing',
    parentId: mid.id,
    body: 'Deep leaf work.',
  }).item;
  assert.ok(leaf?.id);
  return { orchestrator, root: rootRow, leafIds: [String(leaf.id)] };
}

const flashItem = { id: 'qwen3.8-flash', label: 'Flash', roles: ['implement'] };
const solidItem = { id: 'qwen3-max', label: 'Max', roles: ['implement'] };

const mockPickClient = {
  async listHarnessCatalog() {
    return [{ id: 'opencode', enabled: true, ready: true, can_delegate: true }];
  },
  async listHarnessModels({ harness }) {
    if (harness === 'opencode') {
      return { favorites_configured: true, items: [flashItem, solidItem] };
    }
    return { favorites_configured: false, items: [] };
  },
  async getTodo({ todoId }) {
    const { loadTodosData } = await import('../lib/persist/todos-persist.js');
    const item = loadTodosData(ISOLATED_DATA_DIR, workspace).items.find((row) => row.id === todoId);
    return item || null;
  },
  async listTodos() {
    const { loadTodosData } = await import('../lib/persist/todos-persist.js');
    return loadTodosData(ISOLATED_DATA_DIR, workspace).items;
  },
};

test('resolveRequestLeafContext infers a single doing leaf for the orchestrator chat', () => {
  const { orchestrator, leafIds } = makeOrchestratorTree({ doingLeaves: 1 });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'model_pick',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, leafIds[0]);
  assert.equal(ctx.leafSource, LEAF_SOURCE_INFERRED);
});

test('resolveRequestLeafContext warns when two doing leaves exist', () => {
  const { orchestrator } = makeOrchestratorTree({ doingLeaves: 2 });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'model_pick',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, '');
  assert.equal(ctx.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
  assert.equal(ctx.warning?.candidates?.length, 2);
});

test('resolveRequestLeafContext does not infer for a non-orchestrator chat', () => {
  makeOrchestratorTree({ doingLeaves: 1 });
  const stranger = addChat(randomUUID(), 'other', null, workspace, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: stranger.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'model_pick',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, '');
  assert.equal(ctx.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
});

test('model_pick without leaf_id excludes flash on a large inferred leaf and persists leaf_source', async () => {
  const { orchestrator } = makeOrchestratorTree({ doingLeaves: 1, largeLeaf: true });
  const handlers = createCretliMcpToolHandlers(mockPickClient, {
    mode: 'agent',
    chatId: orchestrator.id,
    workspaceFolder: workspace,
  });
  const result = await handlers.model_pick({ role: 'implement' });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  const structured = result.structuredContent;
  assert.equal(structured.leaf_source, LEAF_SOURCE_INFERRED);
  assert.ok(structured.leafId);
  assert.equal(structured.pick.model, 'qwen3-max');
  assert.ok(!isFlashDelegationModel(structured.pick.model));
  const record = getModelPickRecord(structured.pickId);
  assert.equal(record.leafId, structured.leafId);
  assert.equal(record.leafSource, LEAF_SOURCE_INFERRED);
});

test('delegation_start without leaf_id stores inferred leaf on the job and workflow row', async () => {
  const { orchestrator, leafIds } = makeOrchestratorTree({ doingLeaves: 1 });
  const service = createDelegationService({
    workspaceDirForAgent: () => workspace,
    isModelAvailable: () => true,
  });
  const started = await service.createAndStart({
    parentChatId: orchestrator.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text',
    taskText: 'Implement the leaf.',
    executionMode: 'agent',
    assignment: 'implement',
    idempotencyKey: randomUUID(),
    returnWhenStarting: true,
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.leafId, leafIds[0]);
  assert.equal(started.leaf_source, LEAF_SOURCE_INFERRED);
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.leafId, leafIds[0]);
  const workflowGate = inspectDelegationWorkflowStart({
    parentChatId: orchestrator.id,
    leafId: leafIds[0],
    assignment: 'implement',
  });
  assert.equal(workflowGate.ok, true);
});

test('explicit leaf outside orchestrator subtree is rejected', async () => {
  const { orchestrator } = makeOrchestratorTree({ doingLeaves: 1 });
  const foreign = addTodo(workspace, workspace, {
    title: 'Foreign leaf',
    status: 'doing',
    body: 'Other tree.',
  }).item;
  assert.ok(foreign?.id);
  const service = createDelegationService({
    workspaceDirForAgent: () => workspace,
    isModelAvailable: () => true,
  });
  const started = await service.createAndStart({
    parentChatId: orchestrator.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text',
    taskText: 'Implement.',
    executionMode: 'agent',
    assignment: 'implement',
    idempotencyKey: randomUUID(),
    leafId: foreign.id,
  });
  assert.equal(started.ok, false);
  assert.equal(started.code, 'leaf_outside_orchestrator_subtree');
});

test('explicit leaf_id wins over orchestrator inference', async () => {
  const { orchestrator, leafIds } = makeOrchestratorTree({ doingLeaves: 2 });
  const explicitLeaf = leafIds[1];
  updateTodo(workspace, workspace, leafIds[0], { status: 'ready' }); // default projectDir=workspace
  const ctx = resolveRequestLeafContext({
    input: { leaf_id: explicitLeaf },
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'model_pick',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, explicitLeaf);
  assert.equal(ctx.leafSource, 'explicit');
});

test('resolveRequestLeafContext warns with zero doing leaves (root is not a leaf)', () => {
  const { orchestrator, root } = makeOrchestratorTree({ zeroDoingLeaves: true, bindRootOnChat: true });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'model_pick',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, '');
  assert.notEqual(ctx.leafId, root.id);
  assert.equal(ctx.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
  assert.equal(ctx.warning?.candidates?.length, 0);
});

test('resolveRequestLeafContext does not treat chat todoId root as explicit when ambiguous', () => {
  const { orchestrator, root, leafIds } = makeOrchestratorTree({ doingLeaves: 2, bindRootOnChat: true });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'delegation_start',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, '');
  assert.notEqual(ctx.leafId, root.id);
  assert.equal(ctx.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
  assert.equal(ctx.warning?.candidates?.length, 2);
  assert.ok(ctx.warning?.candidates?.some((row) => row.id === leafIds[0]));
});

test('resolveRequestLeafContext infers a doing grandchild leaf', () => {
  const { orchestrator, leafIds } = makeGrandchildDoingLeafTree({ bindRootOnChat: true });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'fix',
    purpose: 'model_pick',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, leafIds[0]);
  assert.equal(ctx.leafSource, LEAF_SOURCE_INFERRED);
});

test('orchestrator leaf inference respects CRETLI_ORCHESTRATOR_LEAF_INFERENCE=off', () => {
  const { orchestrator, leafIds } = makeOrchestratorTree({ doingLeaves: 1 });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: orchestrator.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'model_pick',
    env: { CRETLI_ORCHESTRATOR_LEAF_INFERENCE: 'off' },
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, '');
  assert.notEqual(ctx.leafId, leafIds[0]);
  assert.equal(ctx.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
});

test('legacy chat todo link without orchestrator roots does not infer a leaf', () => {
  const todo = addTodo(workspace, workspace, { title: 'Standalone', status: 'doing', body: 'solo' }).item;
  assert.ok(todo?.id);
  const parent = addChat(randomUUID(), 'legacy-linked', null, workspace, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
    todoId: todo.id,
  });
  const ctx = resolveRequestLeafContext({
    input: {},
    parentChatId: parent.id,
    workspaceFolder: workspace,
    role: 'implement',
    purpose: 'delegation_start',
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.leafId, '');
  assert.notEqual(ctx.leafId, todo.id);
  assert.equal(ctx.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
});

test('delegation_start with chat bound to root warns and does not persist root as leaf when two doing leaves', async () => {
  const isolatedProject = path.join(workspace, `orch-bind-${randomUUID()}`);
  fs.mkdirSync(isolatedProject, { recursive: true });
  const { orchestrator, root, leafIds, projectDir } = makeOrchestratorTree({
    doingLeaves: 2,
    bindRootOnChat: true,
    projectDir: isolatedProject,
  });
  const service = createDelegationService({
    workspaceDirForAgent: () => projectDir,
    isModelAvailable: () => true,
  });
  const started = await service.createAndStart({
    parentChatId: orchestrator.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text',
    taskText: 'Implement.',
    executionMode: 'agent',
    assignment: 'implement',
    idempotencyKey: randomUUID(),
    returnWhenStarting: true,
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(String(started.leafId ?? ''), '');
  assert.notEqual(String(started.leafId ?? ''), root.id);
  assert.equal(started.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
  assert.equal(started.warning?.candidates?.length, 2);
  const row = getDelegationById(started.delegation.id);
  assert.equal(String(row.leafId ?? ''), '');
  assert.notEqual(String(row.leafId ?? ''), root.id);
  assert.ok(leafIds.includes(String(started.warning?.candidates?.[0]?.id))
    || leafIds.includes(String(started.warning?.candidates?.[1]?.id)));
});

test('model_pick with two doing leaves returns leaf_id_missing warning contract', async () => {
  const { orchestrator, root } = makeOrchestratorTree({ doingLeaves: 2, bindRootOnChat: true });
  const handlers = createCretliMcpToolHandlers(mockPickClient, {
    mode: 'agent',
    chatId: orchestrator.id,
    workspaceFolder: workspace,
  });
  const result = await handlers.model_pick({ role: 'implement' });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  const structured = result.structuredContent;
  assert.equal(structured.leafId, undefined);
  assert.equal(structured.warning?.code, LEAF_RESOLUTION_WARNING_MISSING);
  assert.equal(structured.warning?.candidates?.length, 2);
  assert.notEqual(structured.leaf_source, LEAF_SOURCE_INFERRED);
  assert.notEqual(structured.pick?.leafId, root.id);
});
