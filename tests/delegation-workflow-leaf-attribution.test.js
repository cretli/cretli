import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  applyDelegationWorkflowPatch,
  getDelegationWorkflow,
  inspectDelegationWorkflowStart,
  resolveDelegationWorkflowRow,
} from '../lib/delegation-workflow.js';
import { formatTodoRef } from '../lib/todo-ref.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { buildDelegationRequestHash, hashDelegationContent } from '../lib/delegation-request.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';
import {
  resetDelegationRuntimeHealth,
  tickDelegationRuntime,
} from '../lib/delegation-runtime-worker.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

/**
 * Terminal job attributed only via persisted `leafId` (no todo ref in sourceText).
 *
 * @param {string} parentChatId
 * @param {string} leafId
 * @param {'implement' | 'review' | 'fix'} assignment
 * @param {string} [report]
 */
function leafJobByStoredField(parentChatId, leafId, assignment, report = '') {
  const sourceText = `${assignment} without ref line`;
  const record = createDelegationRecord({
    parentChatId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment,
    sourceKind: 'text',
    sourceText,
    sourceHash: hashDelegationContent(sourceText),
    requestHash: buildDelegationRequestHash({
      parentChatId,
      sourceKind: 'text',
      sourceHash: hashDelegationContent(`${assignment}-${crypto.randomUUID()}`),
      harness: 'opencode',
      model: 'opencode/test',
      assignment,
    }),
    idempotencyKey: crypto.randomUUID(),
    leafId,
  });
  assert.equal(record.leafId, leafId);
  assert.ok(!sourceText.includes('cretli-ref'));
  if (report) updateDelegationRecord(record.id, { report });
  return record;
}

// History, deadline scope, and budget use persisted leafId without sourceText ref.
{
  const parentChatId = crypto.randomUUID();
  const leafA = 'aaa11111-2222-3333-4444-555566667777';
  const leafB = 'bbb22222-3333-4444-5555-666677778888';
  leafJobByStoredField(parentChatId, leafA, 'implement');
  leafJobByStoredField(parentChatId, leafA, 'review', 'VERDICT: FAIL\none');
  const inferred = resolveDelegationWorkflowRow({ parentChatId, leafId: leafA });
  assert.equal(inferred.round, 1);
  assert.equal(inferred.lastVerdict, 'FAIL');

  const parent = addChat(parentChatId, 'leaf-field parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const jobA = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: addChat(crypto.randomUUID(), 'leaf A run', null, ISOLATED_DATA_DIR, 'opencode/test').id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'leaf-a-run',
    runId: 'leaf-a-run-id',
    sourceText: 'running without ref',
    leafId: leafA,
  });
  const jobB = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: addChat(crypto.randomUUID(), 'leaf B run', null, ISOLATED_DATA_DIR, 'opencode/test').id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'leaf-b-run',
    runId: 'leaf-b-run-id',
    sourceText: `${formatTodoRef(leafB)}\nlegacy ref sibling`,
    leafId: leafB,
  });
  applyDelegationWorkflowPatch({
    parentChatId: parent.id,
    leafId: leafA,
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
    clearStop: true,
  });
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.ok(['cancelling', 'cancelled'].includes(getDelegationById(jobA.id).status));
  assert.equal(getDelegationById(jobB.id).status, 'running');
  finishDelegation(getDelegationById(jobA.id), { status: 'cancelled' });
  finishDelegation(getDelegationById(jobB.id), { status: 'cancelled' });

  const measuredJob = leafJobByStoredField(parentChatId, leafA, 'implement');
  applyDelegationWorkflowPatch({ parentChatId, leafId: leafA, budgetTokens: 500 });
  recordUsage({
    provider: 'openai',
    feature: 'chat',
    harness: 'sdk',
    model: 'leaf-field-budget',
    eventType: 'delta',
    chatId: measuredJob.childChatId,
    delegationId: measuredJob.id,
    tokens: { textInput: 400, textOutput: 200 },
  });
  const budgetBlock = inspectDelegationWorkflowStart({ parentChatId, leafId: leafA });
  assert.equal(budgetBlock.ok, false);
  assert.equal(budgetBlock.code, 'workflow_budget_exhausted');
}

// createAndStart persists leaf_id on the delegation record.
{
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const leafId = 'ccc33333-4444-5555-6666-777788889999';
  const parent = addChat(crypto.randomUUID(), 'create-start leaf', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const started = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'plain task without todo ref',
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    leafId,
    idempotencyKey: `leaf-persist-${leafId}`,
    returnWhenStarting: true,
  });
  assert.equal(started.ok, true);
  const stored = getDelegationById(started.delegation.id);
  assert.equal(stored.leafId, leafId);
  assert.ok(!String(stored.sourceText).includes('cretli-ref'));
  finishDelegation(stored, { status: 'cancelled' });
}

// Remote HTTP start forwards leaf_id, resume_rounds, and max_rounds.
{
  let capturedBody = null;
  const parent = addChat(crypto.randomUUID(), 'http-forward parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/api/login') {
      req.resume();
      req.on('end', () => reply(200, { ok: true, csrfToken: 'csrf' }));
      return;
    }
    const delegationsMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/delegations$/);
    if (delegationsMatch && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += String(chunk); });
      req.on('end', () => {
        capturedBody = raw ? JSON.parse(raw) : {};
        reply(202, { ok: true, status: 202, delegation: { id: crypto.randomUUID() } });
      });
      return;
    }
    reply(404, { ok: false });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = new CretliApiClient({ baseUrl: `http://127.0.0.1:${port}`, password: 'x' });
    await client.startDelegation({
      chatId: parent.id,
      workspaceFolder: ISOLATED_DATA_DIR,
      harness: 'opencode',
      model: 'opencode/test',
      sourceKind: 'text',
      taskText: 'remote leaf',
      assignment: 'implement',
      leaf_id: 'ddd44444-5555-6666-7777-888899990000',
      resume_rounds: true,
      max_rounds: 7,
      returnWhenStarting: true,
    });
    assert.equal(capturedBody.leafId, 'ddd44444-5555-6666-7777-888899990000');
    assert.equal(capturedBody.resumeRounds, true);
    assert.equal(capturedBody.maxRounds, 7);
  } finally {
    server.close();
  }
}

console.log('delegation-workflow-leaf-attribution.test.js OK');
