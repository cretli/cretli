/**
 * delegation_start plan-reviewer metadata and reviewer_session forwarding
 * through the real handlers and both client implementations.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import {
  createPlanReviewerSession,
  registerPlanReviewerDelegation,
  syncPlanReviewerSessionAfterDelegationFinish,
} from '../lib/plan-reviewer-cooperation-service.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';

const tool = (name) => DELEGATION_MCP_TOOLS.find((item) => item.name === name);
const start = tool('delegation_start');
const props = start.inputSchema.properties;
for (const key of ['plan_reviewer_session_id', 'plan_reviewer_slot', 'plan_reviewer_phase']) {
  assert.ok(props[key], key);
}
assert.equal(tool('reviewer_session').readOnly, false);

const session = { chatId: 'chat-1', workspaceFolder: '/w', mode: 'agent' };
const calls = [];
const client = {
  async getChat() { return { id: 'chat-1' }; },
  async startDelegation(payload) {
    calls.push(payload);
    return { ok: true, delegation: { id: 'd1', status: 'running', executor: {} } };
  },
};
const base = { harness: 'h', model: 'm', idempotency_key: 'k', task_text: 'x', review_subject: 'plan' };
for (const [phase, slot] of [['independent', 0], ['independent', 1], ['exchange', 0], ['exchange', 2]]) {
  await start.handler({ ...base, plan_reviewer_session_id: 's1', plan_reviewer_phase: phase, plan_reviewer_slot: slot, exchange_of_delegation_id: phase === 'exchange' ? 'o0' : undefined }, { client, session });
  const sent = calls.at(-1);
  assert.equal(sent.planReviewerSessionId, 's1');
  assert.equal(sent.planReviewerPhase, phase);
  assert.equal(sent.planReviewerSlot, slot);
}
await start.handler({ ...base, planReviewerSessionId: 's2' }, { client, session });
assert.equal(calls.at(-1).planReviewerSessionId, 's2');
assert.equal(calls.at(-1).planReviewerSlot, undefined);
await start.handler(base, { client, session });
assert.equal('planReviewerSessionId' in calls.at(-1), false);
for (const bad of [
  { plan_reviewer_session_id: 's', plan_reviewer_slot: -1 },
  { plan_reviewer_session_id: 's', plan_reviewer_slot: 1.5 },
  { plan_reviewer_session_id: 's', plan_reviewer_phase: 'bogus' },
  { plan_reviewer_slot: 1 },
  { plan_reviewer_session_id: 's', plan_reviewer_phase: 'exchange' },
  { plan_reviewer_session_id: 's', plan_reviewer_phase: 'exchange', exchange_of_delegation_id: '  ' },
  { exchange_of_delegation_id: 'o1' },
  { plan_reviewer_session_id: 's', plan_reviewer_phase: 'exchange', exchange_of_delegation_id: 'o1', origin_delegation_id: 'o2' },
]) {
  await assert.rejects(start.handler({ ...base, ...bad }, { client, session }), { code: 'VALIDATION_ERROR' });
}

// Exchange origin: every alias is normalized to one exchangeOfDelegationId.
for (const key of ['exchange_of_delegation_id', 'exchangeOfDelegationId', 'origin_delegation_id', 'originDelegationId']) {
  await start.handler({ ...base, plan_reviewer_session_id: 's1', plan_reviewer_phase: 'exchange', [key]: ' orig-1 ' }, { client, session });
  const sent = calls.at(-1);
  assert.equal(sent.exchangeOfDelegationId, 'orig-1', key);
  assert.equal(sent.planReviewerPhase, 'exchange');
}
await start.handler({ ...base, plan_reviewer_session_id: 's1', exchange_of_delegation_id: 'o', origin_delegation_id: 'o' }, { client, session });
assert.equal(calls.at(-1).exchangeOfDelegationId, 'o');
await start.handler({ ...base, plan_reviewer_session_id: 's1', plan_reviewer_phase: 'independent' }, { client, session });
assert.equal('exchangeOfDelegationId' in calls.at(-1), false);

// Behavioral: metadata forwarded by the handler links the exchange verdict to the original row.
{
  const workspace = path.join(ISOLATED_DATA_DIR, `ws-${randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  addTodo(ISOLATED_DATA_DIR, workspace, { title: 'Plan', body: 'b' });
  const todoId = loadTodosData(ISOLATED_DATA_DIR, workspace).items[0].id;
  updateTodo(ISOLATED_DATA_DIR, workspace, todoId, { plan: { markdown: '# Plan\n', updatedAt: new Date().toISOString() } });
  let sess = createPlanReviewerSession({
    dataDir: ISOLATED_DATA_DIR, workspaceFolder: workspace, todoId, coordinatorChatId: randomUUID(), cooperationMode: 'exchange',
  }).session;
  const a = randomUUID();
  const b = randomUUID();
  sess = registerPlanReviewerDelegation(sess, a, 0);
  sess = registerPlanReviewerDelegation(sess, b, 1);
  for (const [id, verdict] of [[a, 'PASS'], [b, 'FAIL']]) {
    sess = syncPlanReviewerSessionAfterDelegationFinish({
      id, planReviewerSessionId: sess.id, planReviewerPhase: 'independent', workspaceFolder: workspace,
      status: 'finished', report: `r\nVERDICT: ${verdict}`, finishedAt: new Date().toISOString(),
    });
  }
  assert.equal(sess.phase, 'exchange');
  calls.length = 0;
  await start.handler({ ...base, plan_reviewer_session_id: sess.id, plan_reviewer_phase: 'exchange', origin_delegation_id: a }, { client, session });
  const sent = calls.at(-1);
  const exchangeId = randomUUID();
  sess = registerPlanReviewerDelegation(sess, exchangeId, 0, { phase: sent.planReviewerPhase, originDelegationId: sent.exchangeOfDelegationId });
  assert.equal(sess.reviewers.find((r) => r.delegationId === a).exchangeDelegationId, exchangeId);
  sess = syncPlanReviewerSessionAfterDelegationFinish({
    id: exchangeId, planReviewerSessionId: sess.id, planReviewerPhase: sent.planReviewerPhase,
    exchangeOfDelegationId: sent.exchangeOfDelegationId, workspaceFolder: workspace,
    status: 'finished', report: 'x\nVERDICT: FAIL', finishedAt: new Date().toISOString(),
  });
  const row = sess.reviewers.find((r) => r.delegationId === a);
  assert.equal(row.exchangeUsed, true);
  assert.equal(row.exchangeVerdict, 'FAIL');
  assert.equal(row.verdict, 'PASS');
}

// reviewer_session binds coordinator/workspace to the session and validates input.
const reviewer = tool('reviewer_session');
const ensured = [];
const rsClient = {
  async listTodos() { return [{ id: 'abcdef12-0000-4000-8000-000000000000' }, { id: 'abcdef12-1111-4000-8000-000000000000' }, { id: 'ffffffff-0000-4000-8000-000000000000' }]; },
  async ensurePlanReviewerSession(payload) { ensured.push(payload); return { ok: true, session: { id: 's1', phase: 'independent' } }; },
};
const out = await reviewer.handler({ todo_id: 'ffffffff', coordinator_chat_id: 'evil', workspace_folder: '/evil' }, { client: rsClient, session });
assert.equal(out.structuredContent.session_id, 's1');
assert.deepEqual(ensured[0], {
  todoId: 'ffffffff-0000-4000-8000-000000000000', workspaceFolder: '/w', coordinatorChatId: 'chat-1', cooperationMode: 'independent',
});
await assert.rejects(reviewer.handler({ todo_id: 'abcdef12' }, { client: rsClient, session }), { code: 'VALIDATION_ERROR' });
await assert.rejects(reviewer.handler({ todo_id: '00000000' }, { client: rsClient, session }), { code: 'NOT_FOUND' });
await assert.rejects(reviewer.handler({ todo_id: 'ffffffff', cooperation_mode: 'x' }, { client: rsClient, session }), { code: 'VALIDATION_ERROR' });
await assert.rejects(reviewer.handler({ todo_id: 'ffffffff' }, { client: rsClient, session: {} }), { code: 'WORKSPACE_REQUIRED' });
const failing = { ...rsClient, async ensurePlanReviewerSession() { return { ok: false, code: 'not_found', error: 'Todo not found.' }; } };
await assert.rejects(reviewer.handler({ todo_id: 'ffffffff' }, { client: failing, session }), { code: 'NOT_FOUND' });

// Remote forwarding is covered in remote-api-client.test.js; in-process facade:
assert.equal(typeof createInProcessMcpClient({ chatId: 'c' }).ensurePlanReviewerSession, 'function');
assert.equal(typeof createInProcessMcpClient({ chatId: 'c' }).startDelegation, 'function');
console.log('plan-reviewer-delegation-metadata: all passed');
