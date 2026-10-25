/**
 * Public HTTP start path for explicit delegated plan authoring. The MCP
 * argument forwarding is covered by delegation-pick-reason.test.js; this file
 * proves the public request reaches the production service and adapter profile.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { saveSettings } from '../lib/persist/settings.js';
import { assertPlannerAdapterAllowed } from '../lib/delegation-adapter-capabilities.js';
import { createDelegationService, finishDelegation, releaseDelegationRunSlot } from '../lib/delegation-service.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import {
  getMockChatRun,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
  setMockChatRunFailStart,
} from '../lib/chat-run/mock-adapter.ts';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
stopDelegationRuntimeWorker();
saveSettings({ opencodeChatEnabledModels: ['testfake/test'] });

const routes = new Map();
const app = {};
for (const method of ['get', 'put', 'patch', 'post', 'delete']) {
  app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
}
registerDelegationsRoutes(app, {
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  dataDir: ISOLATED_DATA_DIR,
});

async function invokeStart(parent, body) {
  const handler = routes.get('POST /api/chats/:id/delegations');
  assert.ok(handler, 'HTTP delegation start route');
  let status = 200;
  let payload = null;
  const res = {
    status(code) { status = code; return res; },
    json(value) { payload = value; return res; },
  };
  await handler({ params: { id: parent.id }, query: {}, body }, res);
  return { status, body: payload };
}

async function invokeRetry(delegationId) {
  const handler = routes.get('POST /api/delegations/:id/retry');
  assert.ok(handler, 'HTTP delegation retry route');
  let status = 200;
  let payload = null;
  const res = {
    status(code) { status = code; return res; },
    json(value) { payload = value; return res; },
  };
  await handler({ params: { id: delegationId }, query: {}, body: {} }, res);
  return { status, body: payload };
}

function finish(row) {
  patchMockChatRun(row.childChatId, { busy: false });
  return finishDelegation(row, {
    status: 'completed',
    report: 'TASK: audit\nVERDICT: PASS\nPlan proposed.',
  });
}

try {
  const parent = addChat(randomUUID(), 'planner-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const explicit = await invokeStart(parent, {
    executor: { transport: 'testfake', model: 'testfake/test' },
    sourceKind: 'text',
    taskText: 'Inspect the repository and author an implementation plan.',
    assignment: 'implement',
    requested_role: 'plan',
    executionMode: 'agent',
    idempotencyKey: randomUUID(),
    returnWhenStarting: false,
  });
  assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
  assert.equal(explicit.body.ok, true);
  const planner = explicit.body.delegation;
  assert.equal(planner.assignment, 'implement', 'durable API assignment remains backward compatible');
  assert.equal(planner.workRole, 'plan');
  assert.equal(planner.executionMode, 'plan', 'the server overrides an unsafe requested mode');
  const plannerChat = loadChats().find((chat) => chat.id === planner.childChatId);
  assert.equal(plannerChat?.delegationAssignment, 'review', 'adapter receives its certified read-only profile');
  assert.equal(plannerChat?.sdkMode, 'plan');
  const plannerPrompt = getMockChatRun(planner.childChatId)?.prompt || '';
  assert.equal(getMockChatRun(planner.childChatId)?.assignment, 'review');
  assert.match(plannerPrompt, /delegated planner/);
  assert.match(plannerPrompt, /Do not implement or edit files/);
  assert.match(plannerPrompt, /orchestrator to save/);
  assert.doesNotMatch(plannerPrompt, /Work in Agent mode/);
  finish(planner);
  const retried = await invokeRetry(planner.id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.ok, true);
  assert.equal(getMockChatRun(planner.childChatId)?.assignment, 'review', 'planner retry stays read-only at the adapter boundary');
  finish(retried.body.delegation);

  const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
  assert.ok(startTool, 'public MCP delegation_start handler');
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-token') {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    let response;
    if (req.method === 'GET' && url.pathname === '/api/chats') {
      response = { status: 200, body: { chats: loadChats() } };
    } else if (req.method === 'POST' && url.pathname === `/api/chats/${parent.id}/delegations`) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      response = await invokeStart(parent, JSON.parse(raw));
    } else {
      response = { status: 404, body: { error: 'Unknown fixture route' } };
    }
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const mcpClient = new CretliApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, bearerToken: 'fixture-token' });
  try {
  const mcpPlanner = await startTool.handler({
    task_text: 'Author a second implementation plan through the MCP contract.',
    harness: 'testfake',
    model: 'testfake/test',
    assignment: 'implement',
    requested_role: 'plan',
    idempotency_key: randomUUID(),
  }, {
    client: mcpClient,
    session: { chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR, mode: 'agent' },
  });
  assert.notEqual(mcpPlanner.isError, true);
  assert.equal(mcpPlanner.structuredContent.assignment, 'implement');
  assert.equal(mcpPlanner.structuredContent.work_role, 'plan');
  const mcpChat = loadChats().find((chat) => chat.delegationId === mcpPlanner.structuredContent.id);
  assert.equal(mcpChat?.delegationAssignment, 'review');
  assert.equal(mcpChat?.sdkMode, 'plan');
  await new Promise((resolve) => setImmediate(resolve));
  const mcpRow = getDelegationById(mcpPlanner.structuredContent.id);
  assert.ok(mcpRow, 'MCP planner is persisted by the production service');
  patchMockChatRun(mcpRow.childChatId, { busy: false });
  finishDelegation(mcpRow, { status: 'completed', report: 'TASK: audit\nVERDICT: PASS\nPlan proposed.' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const legacy = await invokeStart(parent, {
    executor: { transport: 'testfake', model: 'testfake/test' },
    sourceKind: 'text',
    taskText: 'Review this plan.',
    assignment: 'plan',
    executionMode: 'plan',
    idempotencyKey: randomUUID(),
    returnWhenStarting: false,
  });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body.delegation.assignment, 'review');
  assert.equal(legacy.body.delegation.workRole, 'review_plan');
  assert.equal(legacy.body.delegation.reviewSubject, 'plan');
  finish(legacy.body.delegation);

  const unsupported = assertPlannerAdapterAllowed('unknown-planner', {
    env: { CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED: '1' },
  });
  assert.equal(unsupported.ok, false, 'planner never accepts the review-only uncertified escape hatch');
  assert.equal(unsupported.code, 'planner_read_only_unsupported');

  const queueParent = addChat(randomUUID(), 'planner-queue-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake', sdkMode: 'agent',
  });
  const plannerBody = (taskText) => ({
    executor: { transport: 'testfake', model: 'testfake/test' },
    sourceKind: 'text', taskText, assignment: 'implement', requested_role: 'plan',
    executionMode: 'agent', idempotencyKey: randomUUID(), returnWhenStarting: false,
  });
  const queueHead = await invokeStart(queueParent, plannerBody('First planner holds parent slot.'));
  const queueSecond = await invokeStart(queueParent, plannerBody('Second planner fills review fanout.'));
  const parked = await invokeStart(queueParent, plannerBody('Queued planner starts after first.'));
  assert.equal(parked.body.queued, true);
  finish(queueHead.body.delegation);
  releaseDelegationRunSlot(getDelegationById(queueHead.body.delegation.id));
  const queueService = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    dataDir: ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const drained = await queueService.drainQueue({ parentChatId: queueParent.id });
  assert.ok(drained.started.includes(parked.body.delegation.id));
  const queuedPlanner = getDelegationById(parked.body.delegation.id);
  assert.equal(getMockChatRun(queuedPlanner.childChatId)?.assignment, 'review');
  assert.equal(loadChats().find((chat) => chat.id === queuedPlanner.childChatId)?.sdkMode, 'plan');
  finish(queuedPlanner);
  finish(queueSecond.body.delegation);

  process.env.CRETLI_STARTUP_FAILURE_RETRIES = '1';
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = '0';
  try {
    const retryParent = addChat(randomUUID(), 'planner-startup-retry-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
      agentTransport: 'testfake', sdkMode: 'agent',
    });
    setMockChatRunFailStart(1, 'Transport not started');
    const firstAttempt = await invokeStart(retryParent, plannerBody('Planner startup retry.'));
    assert.equal(firstAttempt.body.ok, true, JSON.stringify(firstAttempt.body));
    let retriedPlanner;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      retriedPlanner = getDelegationById(firstAttempt.body.delegation.id);
      if (retriedPlanner?.status === 'running' && retriedPlanner.startupRetry?.used === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(retriedPlanner?.status, 'running');
    assert.equal(retriedPlanner.startupRetry?.used, 1);
    assert.equal(getMockChatRun(retriedPlanner.childChatId)?.assignment, 'review');
    assert.equal(loadChats().find((chat) => chat.id === retriedPlanner.childChatId)?.sdkMode, 'plan');
    finish(retriedPlanner);
  } finally {
    delete process.env.CRETLI_STARTUP_FAILURE_RETRIES;
    delete process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS;
  }
} finally {
  saveSettings({});
  removeIsolatedDataDir();
}

console.log('delegation-plan-authoring-public.test.js OK');
