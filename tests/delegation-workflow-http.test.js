import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addChat } from '../lib/persist/chats-persist.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { applyDelegationWorkflowPatch, getDelegationWorkflow } from '../lib/delegation-workflow.js';

const workspace = ISOLATED_DATA_DIR;
const parent = addChat(crypto.randomUUID(), 'workflow-http-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const child = addChat(crypto.randomUUID(), 'workflow-http-child', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
  delegationParentChatId: parent.id,
});

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace });

async function invokeRoute(method, route, req) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)(req, res);
  return { status, body };
}

const shownEmpty = await invokeRoute('GET', '/api/chats/:id/delegation-workflow', {
  params: { id: parent.id },
  query: { workspaceFolder: workspace },
  body: {},
});
assert.equal(shownEmpty.status, 200);
assert.equal(shownEmpty.body.workflow, null);

const written = await invokeRoute('POST', '/api/chats/:id/delegation-workflow', {
  params: { id: parent.id },
  query: {},
  body: {
    workspaceFolder: workspace,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    idempotencyKey: 'http-review-1',
  },
});
assert.equal(written.status, 200);
assert.equal(written.body.workflow.consecutiveSameFail, 1);
const replayed = await invokeRoute('POST', '/api/chats/:id/delegation-workflow', {
  params: { id: parent.id },
  query: {},
  body: {
    workspaceFolder: workspace,
    round: 1,
    lastVerdict: 'FAIL',
    findingsText: 'same finding',
    idempotencyKey: 'http-review-1',
  },
});
assert.equal(replayed.body.replayed, true);
assert.equal(replayed.body.workflow.consecutiveSameFail, 1);

const childWrite = await invokeRoute('POST', '/api/chats/:id/delegation-workflow', {
  params: { id: child.id },
  query: {},
  body: {
    workspaceFolder: workspace,
    round: 9,
    lastVerdict: 'FAIL',
  },
});
assert.equal(childWrite.status, 409);
assert.equal(childWrite.body.code, 'workflow_parent_required');
assert.equal(getDelegationWorkflow(parent.id).round, 1);

const outOfScope = await invokeRoute('POST', '/api/chats/:id/delegation-workflow', {
  params: { id: parent.id },
  query: {},
  body: { workspaceFolder: '/another-workspace', round: 2 },
});
assert.equal(outOfScope.status, 403);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const collect = (fn) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => fn(raw ? JSON.parse(raw) : {}));
  };
  if (req.method === 'POST' && url.pathname === '/api/login') {
    req.resume();
    req.on('end', () => {
      reply(200, { ok: true, csrfToken: 'csrf' }, { 'Set-Cookie': 'cr_session=tok; Path=/; HttpOnly' });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    return reply(200, { ok: true, chats: [parent, child] });
  }
  const workflowMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/delegation-workflow$/);
  if (workflowMatch) {
    const chatId = decodeURIComponent(workflowMatch[1]);
    if (req.method === 'GET') {
      return reply(200, { ok: true, workflow: getDelegationWorkflow(chatId) });
    }
    if (req.method === 'POST') {
      collect((body) => {
        try {
          const workflow = applyDelegationWorkflowPatch({
            parentChatId: chatId,
            workspaceFolder: body.workspaceFolder,
            role: body.role,
            round: body.round,
            maxRounds: body.maxRounds,
            lastImplementer: body.lastImplementer,
            findingsText: body.findingsText,
            findingsHash: body.findingsHash,
            lastVerdict: body.lastVerdict,
            reportText: body.reportText,
            fanoutVerdicts: body.fanoutVerdicts,
            stopReason: body.stopReason,
            clearStop: body.clearStop,
            deadlineAt: body.deadlineAt,
            materialRevision: body.materialRevision,
            idempotencyKey: body.idempotencyKey,
          });
          reply(200, { ok: true, workflow, replayed: workflow.replayed === true });
        } catch (err) {
          reply(Number(err?.status) || 409, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: err?.code || 'idempotency_conflict',
          });
        }
      });
      return;
    }
  }
  reply(404, { ok: false, error: 'Not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const apiClient = new CretliApiClient({ baseUrl: `http://127.0.0.1:${port}`, password: 'good' });
  const handlers = createCretliMcpToolHandlers(apiClient, {
    chatId: parent.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const viaHttp = await handlers.workflow_update({
    round: 1,
    last_verdict: 'FAIL',
    findings_text: 'same finding',
    idempotency_key: 'stdio-review-1',
  });
  assert.equal(viaHttp.isError, false);
  const viaHttpReplay = await handlers.workflow_update({
    round: 1,
    last_verdict: 'FAIL',
    findings_text: 'same finding',
    idempotency_key: 'stdio-review-1',
  });
  assert.equal(viaHttpReplay.structuredContent.replayed, true);
  const shown = await handlers.workflow_show({});
  assert.equal(shown.isError, false);
  assert.equal(shown.structuredContent.workflow.round, 1);
  assert.ok(Array.isArray(shown.structuredContent.loop), 'workflow_show exposes loop read-model rows');

  const clientWithoutListDelegations = {
    async getChat({ chatId }) {
      if (chatId === parent.id) return parent;
      return null;
    },
    async getDelegationWorkflow(opts) {
      return apiClient.getDelegationWorkflow(opts);
    },
  };
  const handlersNoList = createCretliMcpToolHandlers(clientWithoutListDelegations, {
    chatId: parent.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const shownNoList = await handlersNoList.workflow_show({});
  assert.equal(shownNoList.isError, false);
  assert.equal(shownNoList.structuredContent.workflow.round, 1);
  assert.deepEqual(shownNoList.structuredContent.loop, []);

  const clientListThrows = {
    ...clientWithoutListDelegations,
    async listDelegations() {
      throw new Error('listDelegations transport failed');
    },
  };
  const handlersListError = createCretliMcpToolHandlers(clientListThrows, {
    chatId: parent.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const shownListError = await handlersListError.workflow_show({});
  assert.equal(shownListError.isError, false);
  assert.equal(shownListError.structuredContent.workflow.round, 1);
  assert.deepEqual(shownListError.structuredContent.loop, []);
} finally {
  server.close();
}

const localClient = createInProcessMcpClient({
  harness: 'opencode',
  chatId: parent.id,
  workspaceFolder: workspace,
});
const local = createCretliMcpToolHandlers(localClient, {
  chatId: parent.id,
  workspaceFolder: workspace,
  mode: 'agent',
});
const localUpdate = await local.workflow_update({
  round: 2,
  last_verdict: 'FAIL',
  findings_text: 'same finding',
  idempotency_key: 'local-review-2',
});
assert.equal(localUpdate.isError, false);
assert.equal(localUpdate.structuredContent.workflow.round, 2);
assert.equal(localUpdate.structuredContent.workflow.consecutiveSameFail, 3);

console.log('delegation-workflow-http.test.js OK');
