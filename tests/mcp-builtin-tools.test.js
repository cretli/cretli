import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat, applyAutoTitle } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import {
  CRETILI_MCP_TOOL_DEFS,
  createCretliMcpToolHandlers,
} from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools, getBuiltinMcpReadTools } from '../lib/mcp/mcp-policy.js';
import { callTool } from '../lib/mcp/mcp-runtime.js';
import { createBuiltinCretliServer } from '../lib/mcp/mcp-config.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { getWorkspaceWatcher, mutateWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { hashDelegationContent } from '../lib/delegation-request.js';
import {
  hangNextMockChatRunStart,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

const BUILTIN_MCP_READ_TOOLS = getBuiltinMcpReadTools();
const BUILTIN_MCP_MUTATING_TOOLS = getBuiltinMcpMutatingTools();

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const workspaceA = mkdtempSync(path.join(os.tmpdir(), 'mcp-todo-a-'));
const workspaceB = mkdtempSync(path.join(os.tmpdir(), 'mcp-todo-b-'));
mkdirSync(path.join(workspaceA, '.cursor', 'agents'), { recursive: true });
writeFileSync(path.join(workspaceA, '.cursor', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.');
mkdirSync(path.join(workspaceA, '.vscode'), { recursive: true });
writeFileSync(path.join(workspaceA, '.vscode', 'tasks.json'), JSON.stringify({
  version: '2.0.0',
  tasks: [{ label: 'build', type: 'shell', command: 'echo hi' }],
}));

const chatA = addChat('sess-a', 'Workspace A chat', null, workspaceA, 'model-a', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const chatB = addChat('sess-b', 'Workspace B chat', null, workspaceB, 'model-b', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

setBuiltinMcpRuntimeDeps({
  dataDir: resolveDataPath(),
  taskRuns: new Map([
    ['run-a', { taskLabel: 'build', cwd: workspaceA }],
    ['run-b', { taskLabel: 'other', cwd: workspaceB }],
  ]),
  agentRuns: new Map([
    ['arun-a', { agentName: 'reviewer', cwd: workspaceA }],
    ['arun-b', { agentName: 'other', cwd: workspaceB }],
  ]),
  loadTasksForWorkspace: ({ workspaceFolder }) => {
    if (workspaceFolder === workspaceA) {
      return { tasks: [{ label: 'build', type: 'shell', folderPath: workspaceA, folderName: path.basename(workspaceA) }] };
    }
    return { tasks: [] };
  },
  workspaceDirForAgent: () => '',
});

const names = CRETILI_MCP_TOOL_DEFS.map((tool) => tool.name);
for (const name of [
  'chat_list', 'chat_show', 'chat_history', 'chat_event',
  'todo_list', 'todo_show', 'todo_create', 'todo_update',
  'chat_plan_show', 'delegation_list', 'delegation_show', 'delegation_verify', 'delegation_wait', 'delegation_start', 'delegation_cancel',
  'delegation_reply', 'delegation_inbox', 'workflow_show', 'workflow_update',
  'delegation_rate', 'delegation_ack',
  'watcher_show', 'watcher_update',
  'watcher_status', 'watcher_set', 'watcher_report', 'watcher_claim_next', 'scout_findings',
  'task_list', 'task_run_list', 'agent_list', 'agent_run_list', 'harness_list', 'model_list', 'model_pick',
]) {
  assert.ok(names.includes(name), name);
}
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('todo_list'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_plan_show'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_history'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_event'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('todo_create'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_start'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_verify'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_reply'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('delegation_inbox'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('delegation_wait'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('workflow_show'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('workflow_update'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_rate'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_ack'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('model_pick'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('watcher_show'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('watcher_update'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('watcher_status'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('watcher_set'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('watcher_report'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('watcher_claim_next'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('scout_findings'));
assert.equal(CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'todo_list')?.annotations.readOnlyHint, true);

const builtin = createBuiltinCretliServer();
const client = createInProcessMcpClient({ harness: 'opencode', chatId: chatA.id, workspaceFolder: workspaceA });
const sessionA = {
  chatId: chatA.id,
  workspaceFolder: workspaceA,
  harness: 'opencode',
  mode: 'agent',
  builtinClient: client,
};
const handlersA = createCretliMcpToolHandlers(client, sessionA);

const created = await handlersA.todo_create({
  title: 'Ship MCP',
  body: 'Details',
  status: 'ready',
  idempotency_key: 'idem-a',
});
assert.equal(created.isError, false);
assert.match(created.content[0].text, /Created TODO/);
assert.equal(created.structuredContent.item.title, 'Ship MCP');
const todoId = created.structuredContent.item.id;

const replayed = await handlersA.todo_create({
  title: 'Ship MCP',
  body: 'Details',
  status: 'ready',
  idempotency_key: 'idem-a',
});
assert.equal(replayed.structuredContent.replayed, true);
assert.equal(replayed.structuredContent.item.id, todoId);

const conflictKey = await handlersA.todo_create({
  title: 'Other title',
  idempotency_key: 'idem-a',
});
assert.equal(conflictKey.isError, true);
assert.match(conflictKey.content[0].text, /CONFLICT/);

const invalidStatus = await handlersA.todo_create({
  title: 'Bad status',
  status: 'nope',
  idempotency_key: 'idem-bad-status',
});
assert.equal(invalidStatus.isError, true);
assert.match(invalidStatus.content[0].text, /VALIDATION_ERROR/);

const listed = await handlersA.todo_list({});
assert.equal(listed.structuredContent.items.length, 1);
assert.ok(listed.structuredContent.items[0].id);

const shown = await handlersA.todo_show({ todo_id: todoId });
assert.equal(shown.structuredContent.item.id, todoId);
const updatedAt = shown.structuredContent.item.updated_at;

const extraPatch = await handlersA.todo_update({
  todo_id: todoId,
  expected_updated_at: updatedAt,
  patch: { title: 'Nope', chatId: 'x' },
});
assert.equal(extraPatch.isError, true);

const stale = await handlersA.todo_update({
  todo_id: todoId,
  expected_updated_at: '1999-01-01T00:00:00.000Z',
  patch: { title: 'Stale' },
});
assert.equal(stale.isError, true);
assert.match(stale.content[0].text, /CONFLICT/);

const updated = await handlersA.todo_update({
  todo_id: todoId,
  expected_updated_at: updatedAt,
  patch: { title: 'Ship MCP v2', status: 'doing' },
});
assert.equal(updated.isError, false);
assert.equal(updated.structuredContent.item.title, 'Ship MCP v2');
assert.equal(updated.structuredContent.item.status, 'doing');

const watchShow = await handlersA.watcher_show({});
assert.equal(watchShow.isError, false);
assert.equal(watchShow.structuredContent.watcher.mode, 'off');

const watcherStatus = await handlersA.watcher_status({});
assert.equal(watcherStatus.isError, false);
assert.equal(watcherStatus.structuredContent.watcher.mode, 'off');
assert.match(watcherStatus.content[0].text, /recent_decisions:/);

// State writes are orchestrator-only. Make chatA the cycle orchestrator first.
mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: chatA.id }), { dataDir: resolveDataPath() });

const watchUpdate = await handlersA.watcher_update({ mode: 'observe' });
assert.equal(watchUpdate.isError, false);
assert.equal(watchUpdate.structuredContent.watcher.mode, 'observe');

const setByOrchestrator = await handlersA.watcher_set({ mode: 'observe', policy: { maxParallel: 1 } });
assert.equal(setByOrchestrator.isError, false);
assert.equal(setByOrchestrator.structuredContent.watcher.mode, 'observe');

const foreignWatcherHandlers = createCretliMcpToolHandlers(client, {
  chatId: chatB.id,
  workspaceFolder: workspaceA,
  harness: 'opencode',
  mode: 'agent',
});
const foreignSet = await foreignWatcherHandlers.watcher_set({ mode: 'autopilot' });
assert.equal(foreignSet.isError, true);
assert.match(foreignSet.content[0].text, /OUT_OF_SCOPE/);
assert.equal((await handlersA.watcher_status({})).structuredContent.watcher.mode, 'observe');

const watchAfter = await handlersA.watcher_show({});
assert.equal(watchAfter.structuredContent.watcher.mode, 'observe');
assert.match(watchAfter.content[0].text, /mode: observe/);

const planTodoId = todoId;
const planShow = await handlersA.todo_show({ todo_id: planTodoId });
const planUpdated = await handlersA.todo_update({
  todo_id: planTodoId,
  expected_updated_at: planShow.structuredContent.item.updated_at,
  patch: { plan: { markdown: '# Draft plan\n\nStep 1' } },
});
assert.match(planUpdated.content[0].text, /Updated TODO/);
assert.equal(planUpdated.isError, false);
const savedPlan = await handlersA.todo_show({ todo_id: planTodoId, field: 'plan' });
assert.match(savedPlan.content[0].text, /# Draft plan/);
const approvalDenied = await handlersA.todo_update({
  todo_id: planTodoId,
  expected_updated_at: planUpdated.structuredContent.item.updated_at,
  patch: { plan: { approvedAt: new Date().toISOString() } },
});
assert.equal(approvalDenied.isError, true);
assert.match(approvalDenied.content[0].text, /only include markdown/);

const watchBadMode = await handlersA.watcher_update({ mode: 'turbo' });
assert.equal(watchBadMode.isError, true);
assert.match(watchBadMode.content[0].text, /VALIDATION_ERROR/);


const handlersB = createCretliMcpToolHandlers(client, {
  chatId: chatB.id,
  workspaceFolder: workspaceB,
  harness: 'opencode',
  mode: 'agent',
});
const createdB = await handlersB.todo_create({
  title: 'B only',
  idempotency_key: 'idem-a',
});
assert.equal(createdB.isError, false);
const listB = await handlersB.todo_list({});
assert.equal(listB.structuredContent.items.length, 1);
assert.equal(listB.structuredContent.items[0].title, 'B only');
const listA = await handlersA.todo_list({});
assert.equal(listA.structuredContent.items.find((item) => item.id === todoId).title, 'Ship MCP v2');

const noFolder = createCretliMcpToolHandlers(client, { chatId: '', workspaceFolder: '', mode: 'agent' });
const missingWs = await noFolder.todo_list({});
assert.equal(missingWs.isError, true);
assert.match(missingWs.content[0].text, /WORKSPACE_REQUIRED/);

writeChatPlanFile({
  cwd: workspaceA,
  chatId: chatA.id,
  title: 'Build',
  markdown: '# Build\n\n- step',
  sourceTurnId: 't1',
});
const plan = await handlersA.chat_plan_show({});
assert.ok(plan.structuredContent.revision >= 1);

const planDoc = readChatPlanDocument({ cwd: workspaceA, chatId: chatA.id });
const releaseSlowStart = hangNextMockChatRunStart();
let startTimeout;
const startResult = await Promise.race([
  handlersA.delegation_start({
    plan_revision: planDoc.revision,
    harness: 'opencode',
    model: 'opencode/test',
    idempotency_key: 'del-a',
  }),
  new Promise((resolve) => {
    startTimeout = setTimeout(() => resolve(null), 1000);
  }),
]);
clearTimeout(startTimeout);
releaseSlowStart();
assert.ok(startResult, 'delegation_start should acknowledge before adapter acceptance');
const started = startResult;
assert.equal(started.isError, false);
assert.equal(started.structuredContent.status, 'starting');
const delegationId = started.structuredContent.id;
assert.ok(started.structuredContent.child_chat_id);
const listedA = await handlersA.delegation_list({});
assert.match(listedA.content[0].text, new RegExp(delegationId.replace(/-/g, '\\-')));
const foreignList = await handlersA.delegation_list({ chat_id: chatB.id });
assert.equal(foreignList.isError, true);
assert.match(foreignList.content[0].text, /OUT_OF_SCOPE/);
const foreignListOk = await handlersA.delegation_list({ chat_id: chatB.id, scope: 'all' });
assert.equal(foreignListOk.isError, false);

const childClient = createInProcessMcpClient({
  harness: 'opencode',
  chatId: started.structuredContent.child_chat_id,
  workspaceFolder: workspaceA,
});
const handlersChild = createCretliMcpToolHandlers(childClient, {
  chatId: started.structuredContent.child_chat_id,
  workspaceFolder: workspaceA,
  harness: 'opencode',
  mode: 'agent',
  builtinClient: childClient,
});
const nestedStart = await handlersChild.delegation_start({
  task_text: 'grandchild',
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'nested-denied',
});
assert.equal(nestedStart.isError, true);
assert.match(nestedStart.content[0].text, /CONFLICT/);
assert.match(nestedStart.content[0].text, /Child chats cannot start another delegation/);

const parentWorkflow = await handlersA.workflow_update({
  round: 1,
  last_verdict: 'FAIL',
  findings_text: 'same finding',
  idempotency_key: 'wf-review-1',
});
assert.equal(parentWorkflow.isError, false);
assert.equal(parentWorkflow.structuredContent.workflow.consecutiveSameFail, 1);
const parentReplay = await handlersA.workflow_update({
  round: 1,
  last_verdict: 'FAIL',
  findings_text: 'same finding',
  idempotency_key: 'wf-review-1',
});
assert.equal(parentReplay.structuredContent.replayed, true);
assert.equal(parentReplay.structuredContent.workflow.consecutiveSameFail, 1);
const parentMaterial = await handlersA.workflow_update({
  material_revision: 'src-2',
  idempotency_key: 'wf-material-bump',
});
assert.equal(parentMaterial.isError, false);
assert.equal(parentMaterial.structuredContent.workflow.consecutiveSameFail, 1);
assert.equal(parentMaterial.structuredContent.workflow.reviewEventCount, 1);
const parentAfterBump = await handlersA.workflow_update({
  last_verdict: 'FAIL',
  findings_text: 'same finding',
  idempotency_key: 'wf-review-after-material',
});
assert.equal(parentAfterBump.isError, false);
assert.equal(parentAfterBump.structuredContent.workflow.consecutiveSameFail, 1);
assert.equal(parentAfterBump.structuredContent.workflow.stopReason, '');
const childSpoof = await handlersChild.workflow_update({
  chat_id: chatA.id,
  round: 9,
  last_verdict: 'FAIL',
  findings_text: 'hijack',
});
assert.equal(childSpoof.isError, true);
assert.match(childSpoof.content[0].text, /CONFLICT/);
const afterSpoof = await handlersA.workflow_show({});
assert.equal(afterSpoof.structuredContent.workflow.round, 1);

const childBridge = await callTool(
  {
    chatId: started.structuredContent.child_chat_id,
    workspaceFolder: workspaceA,
    harness: 'opencode',
    mode: 'agent',
    builtinClient: childClient,
  },
  builtin,
  'workflow_update',
  {
    chat_id: chatA.id,
    round: 9,
    last_verdict: 'FAIL',
    findings_text: 'bridge hijack',
    idempotency_key: 'child-bridge',
  },
);
assert.equal(childBridge.ok, false);
assert.match(String(childBridge.output || childBridge.error || ''), /CONFLICT|parent chat/i);

let childDirectCode = '';
try {
  await childClient.updateDelegationWorkflow({
    chatId: chatA.id,
    workspaceFolder: workspaceA,
    round: 9,
    lastVerdict: 'FAIL',
    findingsText: 'direct hijack',
    idempotencyKey: 'child-direct',
  });
} catch (err) {
  childDirectCode = err?.code || '';
}
assert.equal(childDirectCode, 'CONFLICT');
let childOwnCode = '';
try {
  await childClient.updateDelegationWorkflow({
    workspaceFolder: workspaceA,
    round: 9,
    lastVerdict: 'FAIL',
    idempotencyKey: 'child-own',
  });
} catch (err) {
  childOwnCode = err?.code || '';
}
assert.equal(childOwnCode, 'CONFLICT');
const afterChildDirect = await handlersA.workflow_show({});
assert.equal(afterChildDirect.structuredContent.workflow.round, 1);

const replayDel = await handlersA.delegation_start({
  plan_revision: planDoc.revision,
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'del-a',
});
assert.equal(replayDel.structuredContent.replayed, true);
assert.equal(replayDel.structuredContent.id, delegationId);

writeChatPlanFile({
  cwd: workspaceB,
  chatId: chatB.id,
  title: 'B plan',
  markdown: '# B\n\n- step',
  sourceTurnId: 't-b',
});
const stalePlan = await handlersB.delegation_start({
  chat_id: chatB.id,
  plan_revision: 99,
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'del-stale',
});
assert.equal(stalePlan.isError, true);
assert.match(stalePlan.content[0].text, /CONFLICT/);

const missingAdapter = await handlersB.delegation_start({
  plan_revision: 1,
  harness: 'sdk',
  model: 'composer-2',
  idempotency_key: 'del-adapter',
});
assert.equal(missingAdapter.isError, true);

const cancelled = await handlersA.delegation_cancel({ delegation_id: delegationId });
assert.equal(cancelled.isError, false);

const agents = await handlersA.agent_list({});
assert.ok(agents.structuredContent.items.some((row) => row.name === 'reviewer'));
const chats = await handlersA.chat_list({});
assert.ok(chats.structuredContent.items.some((row) => row.title === 'Workspace A chat'));
assert.ok(!chats.structuredContent.items.some((row) => row.title === 'Workspace B chat'));
assert.ok(!chats.structuredContent.items.some((row) => row.title === 'reviewer'));
const chatsAll = await handlersA.chat_list({ scope: 'all' });
assert.ok(chatsAll.structuredContent.items.some((row) => row.title === 'Workspace B chat'));
const foreignShow = await handlersA.chat_show({ chat: chatB.id });
assert.equal(foreignShow.isError, true);
assert.match(foreignShow.content[0].text, /OUT_OF_SCOPE/);
const foreignOk = await handlersA.chat_show({ chat: chatB.id, scope: 'all' });
assert.equal(foreignOk.isError, false);
assert.match(foreignOk.content[0].text, /Workspace B chat/);
const shownBefore = await handlersA.chat_show({ chat: chatB.id, scope: 'all' });
assert.deepEqual(shownBefore.structuredContent.titleHistory, []);
applyAutoTitle(chatB.id, 'area: titled by server', { reason: 'regenerate', force: true });
const shownAfter = await handlersA.chat_show({ chat: chatB.id, scope: 'all' });
assert.equal(shownAfter.structuredContent.title_source, 'auto');
assert.equal(shownAfter.structuredContent.titleHistory.length, 1);
assert.equal(shownAfter.structuredContent.titleHistory[0].title, 'area: titled by server');
assert.equal(shownAfter.structuredContent.titleHistory[0].reason, 'regenerate');
const foreignEvent = await handlersA.chat_event({ chat: chatB.id, seq: 1, field: 'text' });
assert.equal(foreignEvent.isError, true);
assert.match(foreignEvent.content[0].text, /OUT_OF_SCOPE/);
const foreignEventOk = await handlersA.chat_event({ chat: chatB.id, seq: 1, field: 'text', scope: 'all' });
assert.doesNotMatch(foreignEventOk.content[0].text, /OUT_OF_SCOPE/);
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_history'));
assert.ok(names.includes('chat_history'));
assert.ok(names.includes('chat_event'));
assert.ok(agents.content[0].text.includes('.cursor/agents'));

const taskRuns = await handlersA.task_run_list({});
assert.equal(taskRuns.structuredContent.items.length, 1);
assert.equal(taskRuns.structuredContent.items[0].label, 'build');
const agentRuns = await handlersA.agent_run_list({});
assert.equal(agentRuns.structuredContent.items.length, 1);

const outOfScope = await handlersB.todo_show({ todo_id: todoId });
assert.equal(outOfScope.isError, true);

const planDenied = await callTool(
  { ...sessionA, mode: 'plan', builtinClient: client },
  builtin,
  'todo_create',
  { title: 'blocked', idempotency_key: 'plan-block' },
);
assert.equal(planDenied.denied, true);
const afterPlan = await handlersA.todo_list({});
assert.equal(afterPlan.structuredContent.items.length, 1);

const emptyMode = await callTool(
  { ...sessionA, mode: '', getMode: () => '', builtinClient: client },
  builtin,
  'todo_create',
  { title: 'blocked2', idempotency_key: 'mode-block' },
);
assert.equal(emptyMode.ok, false);

const stdioPlan = createCretliMcpToolHandlers(client, { ...sessionA, mode: 'plan' });
const stdioPlanDenied = await stdioPlan.todo_create({
  title: 'stdio blocked',
  idempotency_key: 'stdio-plan-block',
});
assert.equal(stdioPlanDenied.isError, true);
assert.match(stdioPlanDenied.content[0].text, /PLAN_MODE_DENIED/);

const askDenied = await callTool(
  { ...sessionA, mode: 'ask', builtinClient: client },
  builtin,
  'todo_create',
  { title: 'ask blocked', idempotency_key: 'ask-block' },
);
assert.equal(askDenied.denied, true);
const afterAsk = await handlersA.todo_list({});
assert.equal(afterAsk.structuredContent.items.length, 1);
const stdioAsk = createCretliMcpToolHandlers(client, { ...sessionA, mode: 'ask' });
const stdioAskDenied = await stdioAsk.todo_create({
  title: 'stdio ask blocked',
  idempotency_key: 'stdio-ask-block',
});
assert.equal(stdioAskDenied.isError, true);
assert.match(stdioAskDenied.content[0].text, /Ask mode blocked/);

const models = await handlersA.model_list({ harness: 'sdk' });
assert.ok(models.structuredContent.items.length > 0);
assert.equal(typeof models.structuredContent.items[0].cost_tier, 'number');
assert.equal(typeof models.structuredContent.items[0].quality_tier, 'number');
assert.equal(typeof models.structuredContent.items[0].speed_tier, 'number');
assert.ok(Array.isArray(models.structuredContent.items[0].roles));
const favoriteModels = await handlersA.model_list({ harness: 'sdk', enabled_only: true });
assert.ok(models.structuredContent.items.length >= favoriteModels.structuredContent.items.length);
const unknownRole = await handlersA.model_pick({ role: 'orchestrate' });
assert.equal(unknownRole.isError, true);
assert.match(unknownRole.content[0].text, /VALIDATION_ERROR/);
// `exclude_models` / `exclude_harnesses` must be string arrays; a wrong type is
// a VALIDATION_ERROR instead of being silently dropped by the picker.
const stringExcludeModels = await handlersA.model_pick({ role: 'review', exclude_models: 'grok-4.6' });
assert.equal(stringExcludeModels.isError, true);
assert.match(stringExcludeModels.content[0].text, /VALIDATION_ERROR/);
assert.match(stringExcludeModels.content[0].text, /exclude_models/);
const objectExcludeHarnesses = await handlersA.model_pick({ role: 'review', exclude_harnesses: {} });
assert.equal(objectExcludeHarnesses.isError, true);
assert.match(objectExcludeHarnesses.content[0].text, /exclude_harnesses/);
const mixedExcludeModels = await handlersA.model_pick({ role: 'review', exclude_models: ['grok-4.6', 5] });
assert.equal(mixedExcludeModels.isError, true);
assert.match(mixedExcludeModels.content[0].text, /VALIDATION_ERROR/);
// `count` is an integer 1..5.
for (const badCount of [0, 6, 2.5, 'two']) {
  const rejected = await handlersA.model_pick({ role: 'review', count: badCount });
  assert.equal(rejected.isError, true, `count=${badCount} must be rejected`);
  assert.match(rejected.content[0].text, /count must be an integer between 1 and 5/);
}
const harnesses = await handlersA.harness_list({});
assert.ok(harnesses.structuredContent.items.some((row) => row.id === 'sdk'));
const missingHarness = await handlersA.model_list({});
assert.equal(missingHarness.isError, true);
assert.match(missingHarness.content[0].text, /VALIDATION_ERROR/);
const emptyHarness = await handlersA.model_list({ harness: '   ' });
assert.equal(emptyHarness.isError, true);
assert.match(emptyHarness.content[0].text, /VALIDATION_ERROR/);
const unknownHarness = await handlersA.model_list({ harness: 'cursor-typo' });
assert.equal(unknownHarness.isError, true);
assert.match(unknownHarness.content[0].text, /VALIDATION_ERROR/);
assert.doesNotMatch(unknownHarness.content[0].text, /auto|Composer/);

const longTodo = await handlersA.todo_create({
  title: 'Long body',
  body: 'A'.repeat(4500),
  idempotency_key: 'long-body',
});
assert.equal(longTodo.isError, false);
const longId = longTodo.structuredContent.item.id;
const page1 = await handlersA.todo_show({ todo_id: longId, field: 'body' });
assert.equal(page1.structuredContent.truncated, true);
assert.ok(page1.structuredContent.next_cursor);
assert.equal(page1.structuredContent.item.body.length, 4000);
// The paging hint must be in the text content, not only in structuredContent:
// harnesses that read only MCP content (e.g. Qwen) cannot see structuredContent.
assert.match(page1.content[0].text, /truncated=true/);
assert.ok(page1.content[0].text.includes(`next_cursor=${page1.structuredContent.next_cursor}`));
const page2 = await handlersA.todo_show({
  todo_id: longId,
  field: 'body',
  cursor: page1.structuredContent.next_cursor,
});
assert.equal(page2.structuredContent.truncated, false);
assert.equal(page2.structuredContent.item.body.length, 500);
const staleCursor = await handlersA.todo_show({
  todo_id: longId,
  field: 'body',
  cursor: 'not-this-revision:body:0',
});
assert.equal(staleCursor.isError, true);
assert.match(staleCursor.content[0].text, /CONFLICT/);

const reportRow = createDelegationRecord({
  parentChatId: chatA.id,
  workspaceFolder: workspaceA,
  planRevision: 1,
  planMarkdown: 'plan',
  status: 'completed',
  executor: { transport: 'opencode', model: 'opencode/test' },
});
updateDelegationRecord(reportRow.id, {
  report: 'A'.repeat(4500),
  status: 'completed',
  runStoppingAt: '',
});
const reportPage1 = await handlersA.delegation_show({
  delegation_id: reportRow.id,
  field: 'report',
});
assert.equal(reportPage1.isError, false);
assert.equal(reportPage1.structuredContent.truncated, true);
assert.ok(reportPage1.structuredContent.next_cursor);
// The parent read a terminal report, so it counts as delivered: the queued
// mailbox final_report must not wake it with the same body later.
assert.ok(String(getDelegationById(reportRow.id)?.reportDeliveredAt || '').trim());
assert.match(String(getDelegationById(reportRow.id)?.reportDeliveryId || ''), /^read:/);
updateDelegationRecord(reportRow.id, {
  report: 'B'.repeat(4500),
  status: 'completed',
  runStoppingAt: '',
});
const reportStale = await handlersA.delegation_show({
  delegation_id: reportRow.id,
  field: 'report',
  cursor: reportPage1.structuredContent.next_cursor,
});
assert.equal(reportStale.isError, true);
assert.match(reportStale.content[0].text, /CONFLICT/);

const chatMsg = addChat('sess-msg', 'Message parent', null, workspaceA, 'model-a', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const seededMsg = appendChatHistoryEvents(chatMsg.id, '', [
  { rec: { kind: 'localUser', text: 'Pass this task to a child.', createdAt: '2026-01-03T00:00:00.000Z' } },
]);
const msgClient = createInProcessMcpClient({ harness: 'opencode', chatId: chatMsg.id, workspaceFolder: workspaceA });
const msgHandlers = createCretliMcpToolHandlers(msgClient, {
  chatId: chatMsg.id,
  workspaceFolder: workspaceA,
  mode: 'agent',
});
const msgStart = await msgHandlers.delegation_start({
  history_seq: seededMsg.appended[0].seq,
  content_hash: hashDelegationContent('Pass this task to a child.'),
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'del-msg',
});
assert.equal(msgStart.isError, false);
assert.ok(msgStart.structuredContent.child_chat_id);
const childHandlers = createCretliMcpToolHandlers(
  createInProcessMcpClient({ harness: 'opencode', chatId: msgStart.structuredContent.child_chat_id, workspaceFolder: workspaceA }),
  { chatId: msgStart.structuredContent.child_chat_id, workspaceFolder: workspaceA, mode: 'agent' },
);
const replied = await childHandlers.delegation_reply({
  message_text: 'Child result for the parent.',
  idempotency_key: 'reply-mcp',
});
assert.equal(replied.isError, false);
const inbox = await msgHandlers.delegation_inbox({});
assert.equal(inbox.isError, false);
assert.ok(inbox.structuredContent.items.some((row) => row.kind === 'reply'));
const spoofReply = await msgHandlers.delegation_reply({
  delegation_id: msgStart.structuredContent.id,
  message_text: 'impersonation',
  idempotency_key: 'reply-spoof',
});
assert.equal(spoofReply.isError, true);
const planStartDenied = await callTool(
  { ...sessionA, mode: 'plan', builtinClient: client },
  builtin,
  'delegation_start',
  {
    plan_revision: 1,
    harness: 'opencode',
    model: 'opencode/test',
    idempotency_key: 'plan-start',
  },
);
assert.equal(planStartDenied.denied, true);
const askStartDenied = await callTool(
  { ...sessionA, mode: 'ask', builtinClient: client },
  builtin,
  'delegation_start',
  {
    plan_revision: 1,
    harness: 'opencode',
    model: 'opencode/test',
    idempotency_key: 'ask-start',
  },
);
assert.equal(askStartDenied.denied, true);
const planReplyDenied = await callTool(
  { ...sessionA, mode: 'plan', builtinClient: client },
  builtin,
  'delegation_reply',
  { message_text: 'blocked', idempotency_key: 'plan-reply' },
);
assert.equal(planReplyDenied.denied, true);

await handlersA.todo_create({ title: 'Claim lease via MCP', status: 'ready', idempotency_key: 'claim-ttl' });
const leasedClaim = await handlersA.watcher_update({ action: 'claim_next', ttl_ms: 1000 });
assert.equal(leasedClaim.isError, false);
assert.equal(leasedClaim.structuredContent.claimed, true);
const claimedItem = leasedClaim.structuredContent.item;
assert.equal(Date.parse(claimedItem.claimLeaseUntil) - Date.parse(claimedItem.claimedAt), 1000);
assert.ok(claimedItem.claimedByChatId, 'the calling chat owns the claim by default');
const leaseShown = await handlersA.todo_show({ todo_id: claimedItem.id });
assert.equal(leaseShown.structuredContent.item.claim_lease_until, claimedItem.claimLeaseUntil);

// watcher_claim_next is the spec-named alias of the same atomic claim.
await handlersA.todo_create({ title: 'Claim via watcher_claim_next', status: 'ready', idempotency_key: 'claim-spec' });
const specClaim = await handlersA.watcher_claim_next({ ttl_ms: 2000 });
assert.equal(specClaim.isError, false);
assert.equal(specClaim.structuredContent.claimed, true);
assert.equal(specClaim.structuredContent.item.claimedByChatId, chatA.id);

await handlersA.todo_create({ title: 'Claim hijack guard', status: 'ready', idempotency_key: 'claim-hijack' });
mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: chatA.id }), { dataDir: resolveDataPath() });
const hijackClaim = await foreignWatcherHandlers.watcher_claim_next({ claimed_by_chat_id: chatA.id, ttl_ms: 1000 });
assert.equal(hijackClaim.isError, true, 'a non-orchestrator chat cannot claim on behalf of another chat');
assert.match(hijackClaim.content[0].text, /OUT_OF_SCOPE/);

// Scout proposals through MCP: submit/list/accept. Scout never creates a todo by
// itself, so accepting with the default policy produces no todo.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  activeScoutScan: {
    scanId: 'mcp-scout-scan',
    chatId: chatA.id,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    submitToken: 'mcp-scout-token',
  },
}), { dataDir: resolveDataPath() });
const scoutSubmitted = await handlersA.scout_findings({
  action: 'submit',
  scan_id: 'mcp-scout-scan',
  submit_token: 'mcp-scout-token',
  findings: [{ title: 'MCP scout finding', category: 'bug', rationale: 'r', files: ['x.js'] }],
});
assert.equal(scoutSubmitted.isError, false);
assert.equal(scoutSubmitted.structuredContent.added, 1);
const scoutListed = await handlersA.scout_findings({ action: 'list' });
const scoutTarget = scoutListed.structuredContent.findings.find((finding) => finding.title === 'MCP scout finding');
assert.ok(scoutTarget, 'the submitted finding is listed');
const scoutAccepted = await handlersA.scout_findings({ action: 'accept', ids: [scoutTarget.id] });
assert.equal(scoutAccepted.structuredContent.changed, 1);
assert.equal(scoutAccepted.structuredContent.createdTodos.length, 0, 'scoutAutoCreate defaults to false');

// Finding 1: a real review finding recorded through MCP keeps its summary text,
// not only the opaque hash, so the Scout can dedupe against prior reviews.
mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: chatA.id }), { dataDir: resolveDataPath() });
const recordFindings = await handlersA.watcher_update({
  action: 'record_findings',
  todo_id: 'mcp-review-todo',
  findings_hash: 'mcp-review-hash-1',
  findings_text: 'Session token endpoint concatenates untrusted input',
});
assert.equal(recordFindings.isError, false, 'record_findings accepts findings_text');
const recordedFindingsRow = getWorkspaceWatcher(workspaceA, { dataDir: resolveDataPath() });
assert.equal(
  recordedFindingsRow.findings.byTodo['mcp-review-todo'].summary,
  'Session token endpoint concatenates untrusted input',
  'the review finding summary is persisted, not just the hash',
);

// Finding 4: the recommended submit shape (no scan_id / submit_token) succeeds
// because the tool context auto-injects the active Scout chat's credentials.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  activeScoutScan: {
    scanId: 'mcp-scout-auto',
    chatId: chatA.id,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    submitToken: 'mcp-scout-auto-token',
  },
}), { dataDir: resolveDataPath() });
const recommendedSubmit = await handlersA.scout_findings({
  action: 'submit',
  findings: [{ title: 'Recommended MCP submit', category: 'security', files: ['y.js'] }],
});
assert.equal(recommendedSubmit.isError, false, 'recommended shape auto-injects scan_id + submit_token');
assert.equal(recommendedSubmit.structuredContent.added, 1);

// Finding 7: a foreign chat never gets the active Scout chat's credentials
// injected, so it cannot submit findings it does not own.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  activeScoutScan: {
    scanId: 'mcp-scout-foreign',
    chatId: chatA.id,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    submitToken: 'mcp-scout-foreign-token',
  },
}), { dataDir: resolveDataPath() });
const scoutForeignHandlers = createCretliMcpToolHandlers(client, {
  chatId: chatB.id,
  workspaceFolder: workspaceA,
  harness: 'opencode',
  mode: 'agent',
});
const foreignSubmit = await scoutForeignHandlers.scout_findings({
  action: 'submit',
  findings: [{ title: 'Foreign submit', category: 'bug' }],
});
assert.equal(foreignSubmit.isError, true, 'a foreign chat cannot submit Scout findings');
assert.match(
  String(foreignSubmit.output || foreignSubmit.structuredContent?.error || ''),
  /scout|submit|scope|chat/i,
);

// A read-only Scout runs in Plan mode and must still be able to submit, while
// resolution (accept/reject) stays Agent-only.
const planScoutHandlers = createCretliMcpToolHandlers(client, { ...sessionA, mode: 'plan' });
mutateWorkspaceWatcherRow(workspaceA, () => ({
  activeScoutScan: {
    scanId: 'plan-scout-scan',
    chatId: chatA.id,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    submitToken: 'plan-scout-token',
  },
}), { dataDir: resolveDataPath() });
const planSubmit = await planScoutHandlers.scout_findings({
  action: 'submit',
  scan_id: 'plan-scout-scan',
  submit_token: 'plan-scout-token',
  findings: [{ title: 'Plan-mode scout finding', category: 'improvement' }],
});
assert.equal(planSubmit.isError, false, 'Scout submit is allowed in Plan mode');
const planAccept = await planScoutHandlers.scout_findings({ action: 'accept', ids: [scoutTarget.id] });
assert.equal(planAccept.isError, true, 'accept stays Agent-only');
assert.equal(planAccept.structuredContent.code, 'PLAN_MODE_DENIED');

// Workspace watcher cycle report through MCP: only the cycle's orchestrator chat
// may report it, and the report closes the cycle with a durable record.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  activeCycle: {
    cycleId: 'mcp-cycle',
    todoIds: [],
    startedAt: new Date().toISOString(),
    chatId: chatA.id,
    runId: 'run-mcp-cycle',
    phase: 'running',
  },
}), { dataDir: resolveDataPath() });
const foreignHandlers = createCretliMcpToolHandlers(client, {
  chatId: chatB.id,
  workspaceFolder: workspaceA,
  harness: 'opencode',
  mode: 'agent',
});
const foreignReport = await foreignHandlers.watcher_update({
  action: 'report', outcome: 'success', cycle_id: 'mcp-cycle',
});
assert.equal(foreignReport.isError, false);
assert.equal(foreignReport.structuredContent.ok, false);
assert.equal(foreignReport.structuredContent.reason, 'not_orchestrator');
assert.ok(getWorkspaceWatcher(workspaceA, { dataDir: resolveDataPath() }).activeCycle, 'foreign report cannot close');

const ownReport = await handlersA.watcher_update({
  action: 'report', outcome: 'success', cycle_id: 'mcp-cycle', report_id: 'mcp-report', todo_ids: [],
});
assert.equal(ownReport.isError, false);
assert.equal(ownReport.structuredContent.closed, true);
assert.equal(getWorkspaceWatcher(workspaceA, { dataDir: resolveDataPath() }).activeCycle, null);
const ownReplay = await handlersA.watcher_update({
  action: 'report', outcome: 'failure', cycle_id: 'mcp-cycle', report_id: 'mcp-report',
});
assert.equal(ownReplay.structuredContent.replayed, true);

// watcher_report: the spec-named tool shares the same orchestrator-only rule and
// treats idempotency_key as the replay key.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  activeCycle: {
    cycleId: 'mcp-cycle-2',
    todoIds: [],
    startedAt: new Date().toISOString(),
    chatId: chatA.id,
    runId: 'run-mcp-cycle-2',
    phase: 'running',
  },
}), { dataDir: resolveDataPath() });
const foreignSpecReport = await foreignWatcherHandlers.watcher_report({
  outcome: 'success', cycle_id: 'mcp-cycle-2', idempotency_key: 'mcp-report-2',
});
assert.equal(foreignSpecReport.isError, false);
assert.equal(foreignSpecReport.structuredContent.ok, false);
assert.equal(foreignSpecReport.structuredContent.reason, 'not_orchestrator');
assert.ok(getWorkspaceWatcher(workspaceA, { dataDir: resolveDataPath() }).activeCycle, 'foreign watcher_report cannot close');

const specReport = await handlersA.watcher_report({
  outcome: 'success', cycle_id: 'mcp-cycle-2', idempotency_key: 'mcp-report-2', summary: 'cycle done',
});
assert.equal(specReport.isError, false);
assert.equal(specReport.structuredContent.closed, true);
assert.equal(getWorkspaceWatcher(workspaceA, { dataDir: resolveDataPath() }).activeCycle, null);
const specReplay = await handlersA.watcher_report({
  outcome: 'failure', cycle_id: 'mcp-cycle-2', idempotency_key: 'mcp-report-2',
});
assert.equal(specReplay.structuredContent.replayed, true);

// Multi-slot authorization: while a cycle is live, ONLY activeCycles[].chatId
// authorizes. A stale row-level orchestratorChatId must not let its old chat
// drive a different live cycle.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  orchestratorChatId: chatB.id,
  activeCycles: [{
    cycleId: 'mcp-multi',
    todoIds: [],
    startedAt: new Date().toISOString(),
    chatId: chatA.id,
    runId: 'run-mcp-multi',
    phase: 'running',
  }],
}), { dataDir: resolveDataPath() });
const staleOrchestratorSet = await foreignWatcherHandlers.watcher_set({ mode: 'autopilot' });
assert.equal(staleOrchestratorSet.isError, true, 'a stale orchestratorChatId does not authorize while a live cycle exists');
assert.match(staleOrchestratorSet.content[0].text, /OUT_OF_SCOPE/);
const liveCycleSet = await handlersA.watcher_set({ mode: 'observe' });
assert.equal(liveCycleSet.isError, false, 'the live cycle chat is authorized');

// Repair the fixture so the shared store is not left with a live cycle.
mutateWorkspaceWatcherRow(workspaceA, () => ({
  orchestratorChatId: '',
  activeCycles: [],
  activeCycle: null,
}), { dataDir: resolveDataPath() });

removeIsolatedDataDir();
console.log('mcp-builtin-tools.test.js OK');
