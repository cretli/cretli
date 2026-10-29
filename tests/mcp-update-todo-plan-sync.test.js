import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, loadTodosData } from '../lib/persist/todos-legacy-adapter.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { getPlanReviewerSessionById } from '../lib/persist/plan-reviewer-sessions-persist.js';
import { ensurePlanReviewerSession, inspectPlanReviewerDelegationStart } from '../lib/plan-reviewer-cooperation-service.js';

const workspace = ISOLATED_DATA_DIR;
const parent = addChat(randomUUID(), 'Plan coordinator', null, workspace, 'test', { sdkMode: 'agent' });
const client = createInProcessMcpClient({ chatId: parent.id, workspaceFolder: workspace, mode: 'agent' });
addTodo(ISOLATED_DATA_DIR, workspace, { title: 'MCP plan edit parity' });
const todoId = loadTodosData(ISOLATED_DATA_DIR, workspace).items[0].id;
await client.updateTodo({ workspaceFolder: workspace, todoId, plan: { markdown: '# Version 1' } });
const session = ensurePlanReviewerSession({
  dataDir: ISOLATED_DATA_DIR, todoId, workspaceFolder: workspace, coordinatorChatId: parent.id, cooperationMode: 'independent',
});
const sessionId = session.session.id;
assert.equal(inspectPlanReviewerDelegationStart({ planReviewerSessionId: sessionId, reviewSubject: 'plan' }).ok, true);
// An MCP plan rewrite must stale the cooperation session (parity with the REST route).
await client.updateTodo({ workspaceFolder: workspace, todoId, plan: { markdown: '# Version 2' } });
assert.equal(getPlanReviewerSessionById(sessionId).phase, 'stale');
assert.equal(inspectPlanReviewerDelegationStart({ planReviewerSessionId: sessionId, reviewSubject: 'plan' }).code, 'stale');
// A non-plan write must not.
const fresh = ensurePlanReviewerSession({
  dataDir: ISOLATED_DATA_DIR, todoId, workspaceFolder: workspace, coordinatorChatId: parent.id, cooperationMode: 'independent',
});
const freshId = fresh.session.id;
await client.updateTodo({ workspaceFolder: workspace, todoId, title: 'Renamed' });
assert.notEqual(getPlanReviewerSessionById(freshId).phase, 'stale');
removeIsolatedDataDir();
console.log('mcp-update-todo-plan-sync: all passed');
