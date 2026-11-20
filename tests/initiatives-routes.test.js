import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { InitiativeError } from '../lib/initiatives/constants.js';
import { closeInitiativesServices, getInitiativesService } from '../lib/initiatives/initiatives-service.js';
import { registerInitiativesRoutes } from '../lib/routes/initiatives-routes.js';
import { INITIATIVE_MCP_TOOLS } from '../lib/mcp/builtin/initiative-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';

setPassword('initiative-test-password');
const session = createSession();
const humanHeaders = { cookie: `cr_session=${encodeURIComponent(session)}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(session) };
const token = mintMcpIntegrationToken({ sessionId: 'i', chatId: 'i', workspaceFolder: dataDir, harness: 'test', incarnation: 'i' });
const agentHeaders = { authorization: `Bearer ${token}` };

// Seed the per-dataDir service with a deterministic resolver (the real one needs a registered workspace).
const svc = getInitiativesService(dataDir, {
  hostOptions: { noReceiptsRetention: true },
  resolveScope: async (_d, input) => {
    if (input.workspaceUuid !== 'uuid-a' && input.workspaceId !== 'uuid-a') throw new InitiativeError('workspace_required', 'workspace required');
    return { workspaceUuid: 'uuid-a', homeFolder: dataDir };
  },
});

const app = express();
app.use(express.json());
app.use(requireAuth);
registerInitiativesRoutes(app, { dataDir });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeInitiativesServices();
});
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, url, headers, body) {
  const response = await fetch(base + url, {
    method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const scope = '?workspaceUuid=uuid-a';

test('HTTP CRUD with CAS; workspace is required; human and agent channels differ', async () => {
  const noWs = await request('GET', '/api/initiatives', humanHeaders);
  assert.equal(noWs.status, 409);
  assert.equal(noWs.body.code, 'workspace_required');
  const created = await request('POST', `/api/initiatives${scope}`, humanHeaders, { initiative: { title: 'Route', desiredOutcome: 'o' }, idempotencyKey: 'route-1' });
  assert.equal(created.status, 200);
  const id = created.body.initiative.id;
  const stale = await request('PATCH', `/api/initiatives/${id}${scope}`, humanHeaders, { patch: { horizon: 'now' }, expectedRevision: 5 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'revision_conflict');
  const ok = await request('PATCH', `/api/initiatives/${id}${scope}`, humanHeaders, { patch: { status: 'planned' }, expectedRevision: 1 });
  assert.equal(ok.body.initiative.status, 'planned');
  // The MCP channel is an agent: it cannot decide direction nor archive.
  const denied = await request('PATCH', `/api/initiatives/${id}${scope}`, agentHeaders, { patch: { status: 'active' }, expectedRevision: 2 });
  assert.equal(denied.status, 403);
  const archiveDenied = await request('POST', `/api/initiatives/${id}/archive${scope}`, agentHeaders, { expectedRevision: 2 });
  assert.equal(archiveDenied.status, 403);
  const page = await request('GET', `/api/initiatives${scope}&limit=1`, agentHeaders);
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  const hist = await request('GET', `/api/initiatives/${id}/history${scope}`, humanHeaders);
  assert.deepEqual(hist.body.items.map((h) => h.type), ['created', 'updated']);
  const todo = await request('POST', `/api/initiatives/${id}/todos${scope}`, humanHeaders, { operationId: 'route-op' });
  assert.equal(todo.status, 200);
  assert.equal((await request('POST', `/api/initiatives/${id}/todos${scope}`, agentHeaders, { operationId: 'route-op-2' })).status, 403);
});

test('MCP tools are registered, mutate only through the agent channel and use the session workspace', async () => {
  const names = INITIATIVE_MCP_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['initiative_list', 'initiative_get', 'initiative_history', 'initiative_graph', 'initiative_create', 'initiative_update', 'initiative_relate', 'initiative_link', 'initiative_cite']);
  assert.ok(INITIATIVE_MCP_TOOLS.filter((t) => t.readOnly).length === 4);
  const client = createInProcessMcpClient({ dataDir: () => dataDir });
  const session = { workspaceId: 'uuid-a', workspaceFolder: dataDir, chatId: 'c1' };
  const byName = Object.fromEntries(INITIATIVE_MCP_TOOLS.map((t) => [t.name, t]));
  const created = await byName.initiative_create.handler({ initiative: { title: 'Via MCP', desiredOutcome: 'o' }, idempotencyKey: 'mcp-1' }, { client, session });
  const initiative = created.structuredContent.initiative;
  assert.equal(initiative.status, 'draft');
  await assert.rejects(byName.initiative_update.handler({ id: initiative.id, patch: { status: 'achieved' }, expectedRevision: 1 }, { client, session }), (e) => e.code === 'forbidden');
});
