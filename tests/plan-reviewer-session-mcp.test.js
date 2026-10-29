import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools } from '../lib/mcp/mcp-policy.js';
import { inspectPlanReviewerDelegationStart } from '../lib/plan-reviewer-cooperation-service.js';
import { upsertPlanReviewerSession } from '../lib/persist/plan-reviewer-sessions-persist.js';

const workspace = ISOLATED_DATA_DIR;
const parent = addChat(randomUUID(), 'Plan coordinator', null, workspace, 'test', { sdkMode: 'agent' });
const context = { chatId: parent.id, workspaceFolder: workspace, mode: 'agent' };
const client = createInProcessMcpClient(context);
const handlers = createCretliMcpToolHandlers(client, context);
addTodo(ISOLATED_DATA_DIR, workspace, { title: 'Plan session regression' });
const todoId = loadTodosData(ISOLATED_DATA_DIR, workspace).items[0].id;
const args = { todo_id: todoId, cooperation_mode: 'exchange' };
assert.ok(getBuiltinMcpMutatingTools().includes('reviewer_session'));
const initial = await handlers.reviewer_session(args);
assert.equal(initial.isError, false);
const original = initial.structuredContent.session;
assert.equal(original.coordinatorChatId, parent.id);
assert.equal(original.cooperationMode, 'exchange');
assert.equal((await handlers.reviewer_session(args)).structuredContent.session.id, original.id);
// Saving the first plan invalidates the pre-created session; preparing a round recovers.
updateTodo(ISOLATED_DATA_DIR, workspace, todoId, { plan: { markdown: '# Version 1' } });
assert.equal((await inspectPlanReviewerDelegationStart({ planReviewerSessionId: original.id, reviewSubject: 'plan' })).code, 'stale');
const current = (await handlers.reviewer_session(args)).structuredContent.session;
assert.notEqual(current.id, original.id);
assert.equal((await inspectPlanReviewerDelegationStart({ planReviewerSessionId: current.id, reviewSubject: 'plan' })).ok, true);
upsertPlanReviewerSession({ ...current, phase: 'closed' });
const retryClosed = (await handlers.reviewer_session(args)).structuredContent.session;
assert.equal(retryClosed.id, current.id);
assert.equal(retryClosed.phase, 'closed');
for (const mode of ['plan', 'ask']) {
  const restricted = createCretliMcpToolHandlers(client, { ...context, mode });
  const denied = await restricted.reviewer_session(args);
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.code, 'PLAN_MODE_DENIED');
}
const missing = await handlers.reviewer_session({ todo_id: randomUUID() });
assert.equal(missing.isError, true);
assert.equal(missing.structuredContent.code, 'NOT_FOUND');
const outside = await handlers.reviewer_session({ todo_id: todoId, cooperation_mode: 'independent' });
assert.equal(outside.structuredContent.session.coordinatorChatId, parent.id);
await assert.rejects(client.ensurePlanReviewerSession({
  todoId, workspaceFolder: workspace, coordinatorChatId: randomUUID(),
}), { code: 'OUT_OF_SCOPE' });
const todo = loadTodosData(ISOLATED_DATA_DIR, workspace).items[0];
assert.equal(todo.status, 'idea');
assert.equal(todo.plan.approvedAt || '', '');
removeIsolatedDataDir();
console.log('plan-reviewer-session-mcp: all passed');
