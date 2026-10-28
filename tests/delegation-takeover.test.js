import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { getDelegationWorkflow, upsertDelegationWorkflow } from '../lib/persist/delegation-workflows-persist.js';
import { loadDelegationTakeovers } from '../lib/persist/delegation-takeovers-persist.js';
import { createDelegationService, reconcileTakeoversOnBoot, flushDelegationOutbox, finishDelegation, settleDelegationHistoryTasks } from '../lib/delegation-service.js';
import { createMailboxMessage, getMailboxMessageById, updateMailboxMessage, loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import { deliverMailboxToCurrentRecipient, drainChatMailbox, enqueueMailboxMessage, sendDelegationReply, withChatLock } from '../lib/delegation-mailbox.js';
import { getMockChatRun, getMockChatRunStartCount, registerMockChatRunAdapter, resetMockChatRuns, seedMockChatRun, hangNextMockChatRunStart } from '../lib/chat-run/mock-adapter.ts';
import { canChatCancelDelegationTree, collectDelegationSubtreePostOrder } from '../lib/delegation-tree-cancel.js';
import { canChatControlDelegation } from '../lib/delegation-control.js';
import { summarizeDelegationTreeUsage } from '../lib/delegation-workflow-budget.js';
import { recordUsage } from '../lib/usage/usage-ledger.ts';
import { applyDelegationWorkflowPatch } from '../lib/delegation-workflow.js';
import { startChatRun } from '../lib/chat-run-service.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { buildDelegationTreeSnapshot } from '../lib/delegation-tree-view.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
const workspace = ISOLATED_DATA_DIR;
const mk = () => addChat(randomUUID(), 'Takeover test', null, workspace, 'test', { agentTransport: 'testfake', sdkMode: 'agent' });
function fixture() {
  const from = mk();
  const to = mk();
  const child = mk();
  const todo = addTodo(workspace, workspace, { title: 'Takeover root', orchestratorChatId: from.id }).item;
  const job = createDelegationRecord({ parentChatId: from.id, childChatId: child.id, workspaceFolder: workspace, leafId: todo.id, assignment: 'review', executor: { transport: 'testfake', model: 'test' } });
  updateDelegationRecord(job.id, { status: 'completed' });
  upsertDelegationWorkflow({ parentChatId: from.id, leafId: todo.id, round: 3, maxRounds: 9, deadlineAt: '2030-01-01T00:00:00.000Z', lastReviewer: 'reviewer' });
  upsertDelegationWorkflow({ parentChatId: from.id, treeBudgetTokens: 1000, treeBudgetCostUsd: 7 });
  upsertDelegationWorkflow({ parentChatId: to.id, treeBudgetTokens: 0, treeBudgetCostUsd: 3 });
  const message = createMailboxMessage({ fromChatId: child.id, toChatId: from.id, delegationId: job.id, delegationAttemptId: 'attempt', replyKind: 'final_report', body: 'Report', idempotencyKey: `reply:${job.id}` });
  const input = { chatId: to.id, workspaceFolder: workspace, todoId: todo.id, idempotencyKey: randomUUID() };
  return { from, to, child, todo, job, message, input };
}
function assertTransferred(f) {
  const row = getDelegationById(f.job.id);
  assert.equal(row.parentChatId, f.from.id);
  assert.equal(row.controllerChatId, f.to.id);
  assert.equal(row.rootChatId, f.to.id);
  assert.equal(canChatControlDelegation(row, f.to.id), true);
  assert.equal(canChatControlDelegation(row, f.from.id), false);
  assert.equal(loadChats().find((chat) => chat.id === f.child.id).delegationParentChatId, f.to.id);
  assert.equal(getTodoById(workspace, workspace, f.todo.id).orchestratorChatId, f.to.id);
  assert.equal(getDelegationWorkflow(f.to.id, f.todo.id).round, 3);
  assert.equal(getDelegationWorkflow(f.to.id, f.todo.id).maxRounds, 9);
  assert.equal(getDelegationWorkflow(f.to.id, f.todo.id).lastReviewer, 'reviewer');
  assert.equal(getDelegationWorkflow(f.to.id).treeBudgetTokens, 1000);
  assert.equal(getDelegationWorkflow(f.to.id).treeBudgetCostUsd, 3);
  assert.equal(getMailboxMessageById(f.message.id).toChatId, f.to.id);
  assert.throws(() => applyDelegationWorkflowPatch({ parentChatId: f.from.id, leafId: f.todo.id, round: 0 }), { code: 'takeover_workflow_owner' });
}
const service = createDelegationService();
for (const phase of ['started', 'rows', 'workflows', 'mailbox', 'todo', 'done']) {
  const f = fixture();
  const crashing = createDelegationService({ takeoverAfterPhase: (name) => { if (name === phase) throw new Error(`crash:${name}`); } });
  await assert.rejects(crashing.orchestrationTakeover(f.input), /crash:/);
  await reconcileTakeoversOnBoot();
  assertTransferred(f);
  const replay = await service.orchestrationTakeover(f.input);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(loadDelegationTakeovers().filter((row) => row.idempotencyKey === f.input.idempotencyKey).length, 1);
  assert.equal((await service.orchestrationTakeover({ ...f.input, idempotencyKey: randomUUID() })).noop, true);
}
{
  const f = fixture();
  const before = loadDelegationTakeovers().length;
  for (const [patch, code] of [
    [{ workspaceFolder: '/invalid-workspace' }, 'takeover_workspace'],
    [{ chatId: f.child.id }, 'takeover_child_chat'],
    [{ todoId: randomUUID() }, 'takeover_todo_not_found'],
    [{ chatId: f.from.id }, 'takeover_same_chat'],
  ]) {
    const result = await service.orchestrationTakeover({ ...f.input, ...patch });
    assert.equal(result.code, code);
  }
  assert.equal(loadDelegationTakeovers().length, before);
  upsertDelegationWorkflow({ parentChatId: f.to.id, leafId: f.todo.id });
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_workflow_conflict');
}
{
  const f = fixture();
  let release;
  let acquired;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const hold = withChatLock(f.from.id, async () => { acquired(); await new Promise((resolve) => { release = resolve; }); });
  await ready;
  process.env.CRETLI_TAKEOVER_LOCK_TIMEOUT_MS = '10';
  const before = loadDelegationTakeovers().length;
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_busy');
  assert.equal(loadDelegationTakeovers().length, before);
  release();
  await hold;
  delete process.env.CRETLI_TAKEOVER_LOCK_TIMEOUT_MS;
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
}
{
  const f = fixture();
  let release;
  let acquired;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const hold = withChatLock(f.from.id, async () => { acquired(); await new Promise((resolve) => { release = resolve; }); });
  await ready;
  const delivery = deliverMailboxToCurrentRecipient(f.message);
  // Recovery runs the transfer while a delivery waits for the historical recipient.
  const { prepareOrchestrationTakeover, executeOrchestrationTakeoverUnlocked } = await import('../lib/delegation-takeover.js');
  await executeOrchestrationTakeoverUnlocked(await prepareOrchestrationTakeover(f.input));
  await drainChatMailbox(f.to.id);
  release();
  await hold;
  assert.equal((await delivery).status, 'delivered');
  assert.equal(getMockChatRun(f.from.id), null);
  assert.equal(getMockChatRunStartCount(), 1);
  const replay = await enqueueMailboxMessage({ fromChatId: f.child.id, toChatId: f.from.id, delegationId: f.job.id, delegationAttemptId: 'attempt', replyKind: 'final_report', body: 'Report', idempotencyKey: `reply:${f.job.id}` });
  assert.equal(replay.replayed, true);
  assert.equal(getMockChatRunStartCount(), 1);
  updateMailboxMessage(f.message.id, { status: 'dispatching' });
  assert.equal((await deliverMailboxToCurrentRecipient(f.message)).status, 'dispatching');
  assert.equal(getMockChatRunStartCount(), 1);
}
{
  const f = fixture();
  const before = loadDelegationTakeovers().length;
  addTodo(workspace, workspace, { title: 'Local owner', parentId: f.todo.id, orchestratorChatId: mk().id });
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_local_owner');
  assert.equal(loadDelegationTakeovers().length, before);
}
{
  const f = fixture();
  await startChatRun({ chatId: f.from.id, prompt: 'Live source', mode: 'agent', requestId: randomUUID(), deps: {} });
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_source_live');
  assert.equal((await service.orchestrationTakeover({ ...f.input, forceUnavailable: true })).ok, true);
}
{
  const f = fixture();
  const grand = mk();
  const nested = createDelegationRecord({ parentChatId: f.child.id, childChatId: grand.id, workspaceFolder: workspace, leafId: f.todo.id, depth: 2, executor: { transport: 'testfake', model: 'test' } });
  const result = await service.orchestrationTakeover(f.input);
  assert.equal(result.ok, true);
  assert.equal(result.moved.delegations, 2);
  for (const id of [f.job.id, nested.id]) {
    const row = getDelegationById(id);
    assert.equal(row.controllerChatId, f.to.id);
    assert.equal(row.rootChatId, f.to.id);
    assert.equal(canChatCancelDelegationTree(row, f.to.id), true);
    assert.equal(canChatCancelDelegationTree(row, f.from.id), false);
  }
  assert.equal(getDelegationById(nested.id).parentChatId, f.child.id);
  assert.equal(getDelegationById(f.job.id).parentChatId, f.from.id);
  for (const id of [f.child.id, grand.id]) {
    const chat = loadChats().find((row) => row.id === id);
    assert.equal(chat.delegationParentChatId, f.to.id);
    assert.equal(chat.delegationRootChatId, f.to.id);
  }
  assert.equal(getDelegationWorkflow(f.to.id).treeBudgetTokens, 1000);
  const order = collectDelegationSubtreePostOrder({ start: getDelegationById(f.job.id), rows: [getDelegationById(f.job.id), getDelegationById(nested.id)] });
  assert.deepEqual(order.map((row) => row.id), [nested.id, f.job.id]);
}
{
  const f = fixture();
  const crashing = createDelegationService({ takeoverAfterPhase: (phase) => { if (phase === 'rows') throw new Error('pending-transfer'); } });
  await assert.rejects(crashing.orchestrationTakeover(f.input), /pending-transfer/);
  for (const operation of [
    () => service.cancel(f.job.id), () => service.cancelTree(f.job.id),
    () => service.retry(f.job.id), async () => await service.acknowledge(f.job.id),
    async () => await service.rate(f.job.id, { score: 4 }),
    () => service.createAndStart({ parentChatId: f.to.id, leafId: f.todo.id }),
    () => service.cancelForDeletedChat(f.from.id),
  ]) {
    assert.deepEqual(await operation(), { ok: false, status: 409, code: 'takeover_in_progress', error: 'Orchestration takeover is in progress.' });
  }
  assert.equal((await service.orchestrationTakeover({ ...f.input, idempotencyKey: randomUUID() })).code, 'takeover_in_progress');
  assert.equal((await service.orchestrationTakeover({ ...f.input, todoId: randomUUID() })).code, 'idempotency_conflict');
  await reconcileTakeoversOnBoot();
  const client = createInProcessMcpClient({ harness: 'testfake', chatId: f.to.id, workspaceFolder: workspace });
  const todo = await client.getTodo({ workspaceFolder: workspace, todoId: f.todo.id });
  assert.equal(todo.takeovers.length, 1);
  assert.equal(todo.takeovers[0].phase, 'done');
  const tree = buildDelegationTreeSnapshot({ chatId: f.to.id, chat: f.to });
  assert.ok(JSON.stringify(tree).includes(f.job.id));
  assert.ok(JSON.stringify(tree).includes('controller_chat_id'));
}
for (const targetCap of [0, 500, 2000]) {
  const f = fixture();
  upsertDelegationWorkflow({ parentChatId: f.to.id, treeBudgetTokens: targetCap, treeBudgetCostUsd: targetCap / 100 });
  recordUsage({ provider: 'openai', feature: 'chat', harness: 'testfake', model: 'test', eventType: 'delta', chatId: f.child.id, delegationId: f.job.id, tokens: { textInput: 123 } });
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
  const caps = getDelegationWorkflow(f.to.id);
  assert.equal(caps.treeBudgetTokens, targetCap > 0 ? Math.min(1000, targetCap) : 1000);
  assert.equal(caps.treeBudgetCostUsd, targetCap > 0 ? Math.min(7, targetCap / 100) : 7);
  assert.equal(getDelegationWorkflow(f.from.id).treeBudgetTokens, 1000);
  const usage = summarizeDelegationTreeUsage({ rootChatId: f.to.id });
  assert.equal(usage.tokens, 123);
  assert.deepEqual(usage.delegationIds, [f.job.id]);
  await service.orchestrationTakeover(f.input);
  assert.equal(getDelegationWorkflow(f.to.id).treeBudgetTokens, caps.treeBudgetTokens);
}
{
  const f = fixture();
  upsertWorkspaceWatcher(workspace, { activeCycles: [{ cycleId: randomUUID(), chatId: f.from.id, todoIds: [f.todo.id], startedAt: new Date().toISOString() }] });
  const before = loadDelegationTakeovers().length;
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_watcher_cycle_active');
  assert.equal(loadDelegationTakeovers().length, before);
  upsertWorkspaceWatcher(workspace, { activeCycles: [], activeCycle: null });
}


// Public entry points exercise the same production service, including conflict responses.
const { registerDelegationsRoutes } = await import('../lib/routes/delegations-routes.js');
const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
const { tickDelegationRuntime } = await import('../lib/delegation-runtime-worker.js');
const routes = new Map();
registerDelegationsRoutes({
  get: (route, handler) => routes.set(`GET ${route}`, handler),
  post: (route, handler) => routes.set(`POST ${route}`, handler),
}, { dataDir: workspace, workspaceDirForAgent: () => workspace });
async function invoke(route, id, body = {}) {
  const response = { statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await routes.get(`POST ${route}`)({ params: { id }, body, query: {} }, response);
  assert.ok(response.body, 'handler must complete its response');
  return response;
}
function startInput(f) {
  return { parentChatId: f.to.id, sourceKind: 'text', taskText: 'Independent review task',
    assignment: 'review', executionMode: 'agent', executor: { transport: 'testfake', model: 'test' }, idempotencyKey: randomUUID() };
}
{
  const f = fixture();
  assert.equal((await service.orchestrationTakeover({ ...f.input, scope: 'invalid' })).code, 'takeover_scope_invalid');
  updateTodo(workspace, workspace, f.todo.id, { orchestratorChatId: null });
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_owner_missing');
}
{
  const f = fixture();
  upsertWorkspaceWatcher(workspace, { activeCycles: [{ cycleId: randomUUID(), chatId: mk().id, todoIds: [randomUUID()], startedAt: new Date().toISOString() }] });
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true, 'unrelated watcher cycle must not block');
  upsertWorkspaceWatcher(workspace, { activeCycles: [], activeCycle: null });
}
{
  const f = fixture();
  upsertWorkspaceWatcher(workspace, { activeCycles: [{ cycleId: randomUUID(), chatId: mk().id, todoIds: [f.todo.id], startedAt: new Date().toISOString() }] });
  assert.equal((await service.orchestrationTakeover(f.input)).code, 'takeover_watcher_cycle_active');
  upsertWorkspaceWatcher(workspace, { activeCycles: [], activeCycle: null });
}
for (const route of ['/api/chats/:id/orchestration-takeover', '/api/todos/:id/orchestration-takeover']) {
  const f = fixture();
  const response = await invoke(route, route.includes('/todos/') ? f.todo.id : f.to.id, { ...f.input, todoId: f.todo.id });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.to, f.to.id);
  assertTransferred(f);
}
{
  const f = fixture();
  const handlers = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'testfake', chatId: f.to.id, workspaceFolder: workspace }), { chatId: f.to.id, workspaceFolder: workspace, mode: 'agent' });
  const result = await handlers.todo_takeover({ todo_id: f.todo.id, idempotency_key: f.input.idempotencyKey });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.to, f.to.id);
  assertTransferred(f);
}
{
  const f = fixture();
  const crashing = createDelegationService({ takeoverAfterPhase: (phase) => { if (phase === 'rows') throw new Error('route-conflict'); } });
  await assert.rejects(crashing.orchestrationTakeover(f.input), /route-conflict/);
  for (const [route, body] of [
    ['/api/delegations/:id/cancel', {}], ['/api/delegations/:id/cancel', { tree: true }],
    ['/api/delegations/:id/retry', {}], ['/api/delegations/:id/ack', {}], ['/api/delegations/:id/rate', { score: 4 }],
  ]) {
    const response = await invoke(route, f.job.id, body);
    assert.equal(response.statusCode, 409, route);
    assert.equal(response.body.code, 'takeover_in_progress', route);
  }
  await reconcileTakeoversOnBoot();
}
// Replay both queued and already delivered replies through the child-facing API.
for (const replyKind of ['progress', 'final_report']) {
  for (const status of ['queued', 'dispatching', 'delivered']) {
    const f = fixture();
    // This fixture's pre-existing final belongs to another attempt.
    const attemptId = getDelegationById(f.job.id).attemptId;
    const key = randomUUID();
    const body = replyKind === 'final_report' ? 'TASK: review\nVERDICT: PASS\nChecked the implementation.' : 'Still checking';
    const first = await sendDelegationReply({ fromChatId: f.child.id, delegationId: f.job.id, attemptId, body, replyKind, idempotencyKey: key });
    assert.equal(first.ok, true, JSON.stringify(first));
    updateMailboxMessage(first.message.id, { status });
    await service.orchestrationTakeover(f.input);
    const count = loadMailboxMessages().length;
    const starts = getMockChatRunStartCount();
    const replay = await sendDelegationReply({ fromChatId: f.child.id, delegationId: f.job.id, attemptId, body, replyKind, idempotencyKey: key });
    assert.equal(replay.replayed, true, JSON.stringify(replay));
    assert.equal(loadMailboxMessages().length, count);
    assert.equal(getMockChatRunStartCount(), starts);
  }
}
// A writer that resolved the old recipient can enqueue after the mailbox scan.
{
  const f = fixture();
  updateMailboxMessage(f.message.id, { status: 'delivered' });
  let late;
  const transferring = createDelegationService({ takeoverAfterPhase: async (phase) => {
    if (phase !== 'mailbox') return;
    late = await enqueueMailboxMessage({ fromChatId: f.child.id, toChatId: f.from.id, delegationId: f.job.id,
      replyKind: 'progress', body: 'Late progress after scan', idempotencyKey: randomUUID(), deferDelivery: true });
  } });
  assert.equal((await transferring.orchestrationTakeover(f.input)).ok, true);
  assert.equal(late.message.toChatId, f.to.id);
  const before = getMockChatRunStartCount();
  await drainChatMailbox(f.to.id);
  assert.equal(getMockChatRun(f.from.id), null);
  assert.equal(getMailboxMessageById(late.message.id).toChatId, f.to.id);
  assert.equal(getMailboxMessageById(late.message.id).status, 'delivered');
  assert.ok(getMockChatRun(f.to.id).prompt.includes('Late progress after scan'));
  // Subsequent drains cannot duplicate the accepted late write.
  await drainChatMailbox(f.to.id);
  assert.equal(getMockChatRunStartCount(), before + 1);
}
{
  const f = fixture();
  updateDelegationRecord(f.job.id, { status: 'running' });
  updateMailboxMessage(f.message.id, { status: 'delivered' });
  finishDelegation(getDelegationById(f.job.id), { status: 'completed', report: 'TASK: review\nVERDICT: PASS\nReviewed all changes.', enqueueParentReply: true });
await settleDelegationHistoryTasks();
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
  const before = getMockChatRunStartCount();
  await flushDelegationOutbox(getDelegationById(f.job.id));
  assert.ok(getMockChatRun(f.to.id).prompt.includes(f.job.id));
  assert.equal(getMockChatRun(f.from.id), null);
  assert.ok(loadMailboxMessages().some((row) => row.delegationId === f.job.id && row.id !== f.message.id && row.status === 'delivered' && row.toChatId === f.to.id));
  await flushDelegationOutbox(getDelegationById(f.job.id));
  assert.equal(getMockChatRunStartCount(), before + 1);
  const mailboxIntents = getDelegationById(f.job.id).outbox.filter((row) => row.type === 'mailbox');
  assert.equal(mailboxIntents.length, 1);
  assert.ok(mailboxIntents.every((row) => row.deliveredAt));
}

const startService = createDelegationService({ workspaceDirForAgent: () => workspace, isModelAvailable: () => true, dataDir: workspace });
for (const slotHeldBy of ['running', 'cancel_unconfirmed']) {
  const f = fixture();
  updateDelegationRecord(f.job.id, { assignment: 'implement', status: slotHeldBy === 'running' ? 'running' : 'interrupted',
    slotHeldBy, interruptCode: slotHeldBy === 'cancel_unconfirmed' ? 'cancel_unconfirmed' : '', runStoppingAt: new Date().toISOString() });
  seedMockChatRun(f.child.id, { busy: true });
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
  const before = getDelegationById(f.job.id);
  assert.equal((await service.cancelForDeletedChat(f.from.id)).ok, true);
  assert.deepEqual(getDelegationById(f.job.id), before, 'deleting historical parent must leave transferred job untouched');
  assert.equal(getMockChatRun(f.child.id).cancelled, false);
  const starts = getMockChatRunStartCount();
  const blocked = await startService.createAndStart(startInput(f));
  assert.equal(blocked.queued, true, JSON.stringify(blocked));
  assert.equal(blocked.delegation.status, 'queued');
  assert.equal(blocked.queueConflict.code, 'active_delegation_exists');
  updateDelegationRecord(blocked.delegation.id, { status: 'cancelled' });
  assert.equal(getMockChatRunStartCount(), starts);
  updateDelegationRecord(f.job.id, { status: 'cancelled', slotHeldBy: 'running', runStoppingAt: '', interruptCode: '' });
}
for (const dimension of ['tokens', 'usd']) {
  const f = fixture();
  // Spend exceeds the transferred cap while the other dimension stays unlimited.
  upsertDelegationWorkflow({ parentChatId: f.from.id, treeBudgetTokens: dimension === 'tokens' ? 1000 : 0, treeBudgetCostUsd: dimension === 'usd' ? 7 : 0 });
  upsertDelegationWorkflow({ parentChatId: f.to.id, treeBudgetTokens: 0, treeBudgetCostUsd: 0 });
  recordUsage({ provider: 'openai', feature: 'chat', harness: 'testfake', model: 'test', eventType: 'delta', chatId: f.child.id,
    delegationId: f.job.id, tokens: { textInput: dimension === 'tokens' ? 1001 : 0 }, reportedUsd: dimension === 'usd' ? 8 : 0 });
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
  const blocked = await startService.createAndStart(startInput(f));
  assert.equal(blocked.code, 'tree_budget_exceeded', JSON.stringify(blocked));
}
{
  const f = fixture();
  const expired = new Date(Date.now() - 1000).toISOString();
  upsertDelegationWorkflow({ parentChatId: f.from.id, leafId: f.todo.id, deadlineAt: expired });
  updateDelegationRecord(f.job.id, { status: 'running' });
  seedMockChatRun(f.child.id, { busy: true });
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
  await tickDelegationRuntime({ drainMailbox: false });
  assert.equal(getDelegationWorkflow(f.to.id, f.todo.id).stopReason, 'deadline');
  assert.equal(getDelegationWorkflow(f.to.id, f.todo.id).deadlineCancelKey, expired);
  assert.equal(getMockChatRun(f.child.id).cancelled, true);
}
{
  const f = fixture();
  const { subscribeChatListUpdates, unsubscribeChatListUpdates } = await import('../lib/chat-list-updates.js');
  const frames = [];
  const socket = { readyState: 1, bufferedAmount: 0, once() {}, send(message) { frames.push(JSON.parse(message)); } };
  subscribeChatListUpdates(socket, { kind: 'session', workspaceFolder: workspace });
  const before = getTodoById(workspace, workspace, f.todo.id).updatedAt;
  assert.equal((await service.orchestrationTakeover(f.input)).ok, true);
  assert.ok(getTodoById(workspace, workspace, f.todo.id).updatedAt > before);
  assert.ok(frames.some((frame) => frame.type === 'todosChanged' && frame.todoId === f.todo.id && frame.reason === 'orchestration_takeover'));
  unsubscribeChatListUpdates(socket);
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lock order deadlock')), 2000); })]);
  } finally {
    clearTimeout(timer);
  }
}
{
  const f = fixture();
  updateDelegationRecord(f.job.id, { status: 'running' });
  updateMailboxMessage(f.message.id, { status: 'delivered' });
  finishDelegation(getDelegationById(f.job.id), { status: 'completed', report: 'TASK: review\nVERDICT: PASS\nConcurrent finalization.', enqueueParentReply: true });
await settleDelegationHistoryTasks();
  // The worker flushes finalization under store work; takeover follows the same queue.
  const [health, result] = await bounded(Promise.all([
    tickDelegationRuntime({ drainMailbox: false }), service.orchestrationTakeover(f.input),
  ]));
  assert.equal(health.degraded, false);
  assert.equal(result.ok, true);
  await flushDelegationOutbox(getDelegationById(f.job.id));
  assert.equal(getMockChatRun(f.from.id), null);
  assert.ok(getMockChatRun(f.to.id));
}
{
  const f = fixture();
  updateMailboxMessage(f.message.id, { status: 'delivered' });
  const release = hangNextMockChatRunStart();
  // This start holds the destination parent lock while takeover owns store work.
  const starting = startService.createAndStart({ ...startInput(f), parentChatId: f.from.id });
  await bounded((async () => {
    while (!loadChats().some((chat) => chat.delegationParentChatId === f.from.id && chat.id !== f.child.id)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })());
  const taking = service.orchestrationTakeover({ ...f.input, scope: 'all' });
  const ticking = tickDelegationRuntime({ drainMailbox: false });
  release();
  const [started, taken] = await bounded(Promise.all([starting, taking, ticking]));
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(taken.ok, true, JSON.stringify(taken));
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.controllerChatId, f.to.id);
  finishDelegation(row, { status: 'completed', report: 'TASK: review\nVERDICT: PASS\nStarted under parent lock.', enqueueParentReply: true });
await settleDelegationHistoryTasks();
  await bounded(flushDelegationOutbox(getDelegationById(row.id)));
  assert.ok(getMockChatRun(f.to.id));
  updateDelegationRecord(row.id, { runStoppingAt: '' });
}
{
  const f = fixture();
  const release = hangNextMockChatRunStart();
  const delivery = deliverMailboxToCurrentRecipient(f.message);
  // Let delivery enter startChatRun while it owns the recipient chat lock.
  await new Promise((resolve) => setImmediate(resolve));
  const taking = service.orchestrationTakeover({ ...f.input, forceUnavailable: true });
  release();
  const [delivered, taken] = await bounded(Promise.all([delivery, taking]));
  assert.equal(delivered.status, 'delivered');
  assert.equal(taken.ok, true);
  // Already dispatching/delivered messages keep their original accepted recipient.
  assert.equal(getMockChatRun(f.from.id).cancelled, false);
}
console.log('delegation-takeover.test.js OK');


