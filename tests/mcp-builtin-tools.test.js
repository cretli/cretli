import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import {
  CRETILI_MCP_TOOL_DEFS,
  createCretliMcpToolHandlers,
} from '../lib/mcp/mcp-builtin-tools.js';
import { BUILTIN_MCP_MUTATING_TOOLS, BUILTIN_MCP_READ_TOOLS } from '../lib/mcp/mcp-policy.js';
import { callTool } from '../lib/mcp/mcp-runtime.js';
import { createBuiltinCretliServer } from '../lib/mcp/mcp-config.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { hashDelegationContent } from '../lib/delegation-request.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

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
  'chat_plan_show', 'delegation_list', 'delegation_show', 'delegation_start', 'delegation_cancel',
  'delegation_reply', 'delegation_inbox',
  'task_list', 'task_run_list', 'agent_list', 'agent_run_list', 'harness_list', 'model_list',
]) {
  assert.ok(names.includes(name), name);
}
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('todo_list'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_plan_show'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_history'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('chat_event'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('todo_create'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_start'));
assert.ok(BUILTIN_MCP_MUTATING_TOOLS.includes('delegation_reply'));
assert.ok(BUILTIN_MCP_READ_TOOLS.includes('delegation_inbox'));
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
assert.equal(listA.structuredContent.items[0].title, 'Ship MCP v2');

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
const started = await handlersA.delegation_start({
  plan_revision: planDoc.revision,
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'del-a',
});
assert.equal(started.isError, false);
const delegationId = started.structuredContent.id;
assert.ok(started.structuredContent.child_chat_id);

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
  status: 'finished',
  executor: { transport: 'opencode', model: 'opencode/test' },
});
updateDelegationRecord(reportRow.id, {
  report: 'A'.repeat(4500),
  status: 'finished',
});
const reportPage1 = await handlersA.delegation_show({
  delegation_id: reportRow.id,
  field: 'report',
});
assert.equal(reportPage1.isError, false);
assert.equal(reportPage1.structuredContent.truncated, true);
assert.ok(reportPage1.structuredContent.next_cursor);
updateDelegationRecord(reportRow.id, {
  report: 'B'.repeat(4500),
  status: 'finished',
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

removeIsolatedDataDir();
console.log('mcp-builtin-tools.test.js OK');
