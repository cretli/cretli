import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  createExternalMcpClient,
  listExternalMcpClients,
  revokeExternalMcpClient,
  updateExternalMcpClientMode,
  verifyExternalMcpToken,
  rotateExternalMcpClientToken,
} from '../lib/mcp/mcp-external-clients.js';
import { EXTERNAL_MCP_AUDIT_FILE, setExternalMcpRateLimit } from '../lib/mcp/mcp-external-audit.js';
import { bindOperatorSessionId, registerExternalMcpRoutes } from '../lib/routes/mcp-external-routes.js';
import { loadMcpDocument, saveMcpDocument } from '../lib/persist/mcp-persist.js';
import { createBuiltinCretliServer } from '../lib/mcp/mcp-config.js';
import { addTodo, loadTodosData, updateTodo, writeTodoReview } from '../lib/persist/todos-persist.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  getMockChatRun,
  getMockChatRunStartCount,
  patchMockChatRun,
  seedMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.ts';
import { unregisterChatRunAdapter } from '../lib/chat-run-service.js';
import { listHarnessModels } from '../lib/harness-catalog.js';
import { buildNamedDelegationStartHardGateInput } from '../lib/delegation-model-gates.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-external-mcp-ws-'));
/** @type {http.Server} */
let server;
let baseUrl = '';

before(async () => {
  const app = express();
  app.use(express.json());
  registerExternalMcpRoutes(app);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  saveSettings({});
  fs.rmSync(resolveDataPath('mcp-external-clients.json'), { force: true });
  fs.rmSync(resolveDataPath(EXTERNAL_MCP_AUDIT_FILE), { force: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(resolveDataPath(`operator-journal.sqlite${suffix}`), { force: true });
  setExternalMcpRateLimit();
});

test('operator session identity is stable within a client and cannot collide across tokens', () => {
  assert.equal(bindOperatorSessionId('client-a', 'terminal-1'), bindOperatorSessionId('client-a', 'terminal-1'));
  assert.notEqual(bindOperatorSessionId('client-a', 'terminal-1'), bindOperatorSessionId('client-b', 'terminal-1'));
  assert.notEqual(bindOperatorSessionId('client-a', 'terminal-1'), bindOperatorSessionId('client-a', 'terminal-2'));
  assert.doesNotMatch(bindOperatorSessionId('client-a', 'terminal-1'), /client-a|terminal-1/);
});

test('HTTP todo_integration lease cannot be impersonated with another token and the same session header', async () => {
  saveSettings({ externalMcpEnabled: true });
  const first = createExternalMcpClient({ name: 'first', workspaceFolder: workspace, mode: 'operator' });
  const second = createExternalMcpClient({ name: 'second', workspaceFolder: workspace, mode: 'operator' });
  const headers = { 'x-cretli-operator-session': 'shared-label' };
  const owner = await connect(first.token, headers);
  const impostor = await connect(second.token, headers);
  try {
    const handoff = await owner.callTool({ name: 'operator_handoff', arguments: {} });
    assert.notEqual(handoff.isError, true, JSON.stringify(handoff.content));
    await assert.rejects(
      impostor.callTool({ name: 'todo_integration', arguments: { todo_id: 'missing', action: 'prepare', expected_updated_at: 'missing' } }),
      /operator_handoff|another active session/,
    );
    const ownerReachedTool = await owner.callTool({ name: 'todo_integration', arguments: { todo_id: 'missing', action: 'prepare', expected_updated_at: 'missing' } });
    assert.equal(ownerReachedTool.isError, true);
    assert.doesNotMatch(JSON.stringify(ownerReachedTool.content), /OPERATOR_LEASE_REQUIRED/);
  } finally {
    await owner.close();
    await impostor.close();
  }
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(workspace, { recursive: true, force: true });
  removeIsolatedDataDir();
});

/**
 * @param {string} token
 * @param {Record<string, string>} [extraHeaders]
 */
async function connect(token, extraHeaders = {}) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } },
  });
  await client.connect(transport);
  return client;
}

/**
 * @param {Record<string, string>} headers
 */
async function rawPost(headers) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('tokens are shown once, stored as a hash, revocable and expiring', () => {
  const { client, token } = createExternalMcpClient({ name: 'Claude Code', workspaceFolder: workspace, mode: 'plan', ttlDays: 1 });
  assert.match(token, /^cmx1\./);
  const stored = fs.readFileSync(resolveDataPath('mcp-external-clients.json'), 'utf8');
  assert.equal(stored.includes(token.split('.')[2]), false, 'the secret must not be stored');
  assert.equal(verifyExternalMcpToken(token).id, client.id);
  assert.equal('secretHash' in listExternalMcpClients()[0], false);

  assert.throws(() => verifyExternalMcpToken(`${token}x`), /Invalid MCP client token/);
  assert.throws(() => verifyExternalMcpToken(token, { now: Date.now() + 2 * 24 * 60 * 60 * 1000 }), /expired/);
  assert.equal(revokeExternalMcpClient(client.id), true);
  assert.throws(() => verifyExternalMcpToken(token), /revoked/);
  assert.equal(revokeExternalMcpClient('missing'), false);
});

test('rotating a token keeps the client and invalidates the old token', () => {
  const { client, token } = createExternalMcpClient({ name: 'Rotate me', workspaceFolder: workspace, mode: 'agent', ttlDays: 7 });
  const rotated = rotateExternalMcpClientToken(client.id);
  assert.ok(rotated);
  assert.notEqual(rotated.token, token);
  assert.equal(rotated.client.id, client.id);
  assert.equal(rotated.client.mode, 'agent');
  assert.equal(rotated.client.expiresAt, client.expiresAt);
  assert.throws(() => verifyExternalMcpToken(token), /Invalid MCP client token/);
  assert.equal(verifyExternalMcpToken(rotated.token).id, client.id);
  assert.equal(rotateExternalMcpClientToken('missing'), null);
  revokeExternalMcpClient(client.id);
  assert.throws(() => rotateExternalMcpClientToken(client.id), /revoked/);
});

test('client input is validated', () => {
  assert.throws(() => createExternalMcpClient({ name: '', workspaceFolder: workspace }), /name/);
  assert.throws(() => createExternalMcpClient({ name: 'x', workspaceFolder: 'relative/dir' }), /absolute/);
  assert.throws(() => createExternalMcpClient({ name: 'x', workspaceFolder: path.join(workspace, 'missing') }), /existing directory/);
  assert.throws(() => createExternalMcpClient({ name: 'x', workspaceFolder: '/' }), /filesystem root/);
  assert.throws(() => createExternalMcpClient({ name: 'x', workspaceFolder: workspace, mode: 'ask' }), /mode/);
  assert.throws(() => createExternalMcpClient({ name: 'x', workspaceFolder: workspace, ttlDays: 0 }), /ttlDays/);
});

test('/mcp is closed until enabled, and rejects browsers and bad tokens', async () => {
  const { token } = createExternalMcpClient({ name: 'c', workspaceFolder: workspace });
  assert.equal((await rawPost({ Authorization: `Bearer ${token}` })).status, 403, 'disabled by default');

  saveSettings({ externalMcpEnabled: true });
  assert.equal((await rawPost({})).status, 401, 'no token');
  assert.equal((await rawPost({ Authorization: 'Bearer cmx1.nope.nope' })).status, 401, 'unknown token');
  assert.equal(
    (await rawPost({ Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).status,
    403,
    'browser Origin is refused',
  );
});

test('a valid client lists the built-in Cretli tools; plan mode denies writes', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { token } = createExternalMcpClient({ name: 'planner', workspaceFolder: workspace, mode: 'plan' });
  const client = await connect(token);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('todo_list'), 'built-in todo tools are exposed');
    assert.ok(names.every((name) => !name.startsWith('mcp__')), 'tool names are not bridge-encoded');

    const listed = await client.callTool({ name: 'todo_list', arguments: {} });
    assert.notEqual(listed.isError, true, JSON.stringify(listed.content));

    const write = await client.callTool({ name: 'todo_create', arguments: { title: 'should be denied' } });
    assert.equal(write.isError, true, 'plan mode must deny a write tool');
  } finally {
    await client.close();
  }
});

test('plan-mode (non-operator) client lists and calls cretli_feedback; other writes stay denied', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { token } = createExternalMcpClient({ name: 'feedback-planner', workspaceFolder: workspace, mode: 'plan' });
  const client = await connect(token);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'cretli_feedback'), 'listed for a non-operator client');
    const filed = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'missing_tool', summary: 'External plan client report' } });
    assert.notEqual(filed.isError, true, JSON.stringify(filed.content));
    const write = await client.callTool({ name: 'todo_create', arguments: { title: 'should be denied' } });
    assert.equal(write.isError, true, 'plan mode still denies other writes');
  } finally {
    await client.close();
  }
});

test('operator tools are listed only for operator clients', async () => {
  saveSettings({ externalMcpEnabled: true });
  const agent = createExternalMcpClient({ name: 'agent', workspaceFolder: workspace, mode: 'agent' });
  const operator = createExternalMcpClient({ name: 'operator', workspaceFolder: workspace, mode: 'operator' });
  const agentClient = await connect(agent.token);
  const operatorClient = await connect(operator.token);
  try {
    const agentNames = (await agentClient.listTools()).tools.map((tool) => tool.name);
    assert.ok(agentNames.includes('todo_create'), 'agent mode keeps the full catalog');
    assert.ok(agentNames.every((name) => !name.startsWith('operator_')), 'agent mode must not see operator tools');
    const denied = await agentClient.callTool({ name: 'operator_plan_approve', arguments: { todo_id: 'x', expected_updated_at: 'x' } });
    assert.equal(denied.isError, true, 'agent mode cannot call operator tools');

    const operatorNames = (await operatorClient.listTools()).tools.map((tool) => tool.name);
    assert.ok(operatorNames.includes('todo_create'), 'operator mode keeps the agent catalog');
    for (const name of ['operator_plan_approve', 'operator_plan_review_start', 'operator_chat_send', 'operator_chat_status', 'operator_chat_stop', 'operator_chat_wait', 'operator_guide', 'operator_prompt_change_propose', 'unclassified_errors']) {
      assert.ok(operatorNames.includes(name), `operator mode lists ${name}`);
    }

    // initialize instructions: common rules for every mode, the operator loop
    // and a pointer to operator_guide only for operator clients.
    const agentInstructions = String(agentClient.getInstructions() || '');
    const operatorInstructions = String(operatorClient.getInstructions() || '');
    assert.match(agentInstructions, /approved by a human only/);
    assert.doesNotMatch(agentInstructions, /operator_guide/);
    for (const text of [agentInstructions, operatorInstructions]) {
      assert.match(text, /report it with cretli_feedback \(kind, summary, details\)\. Never include secrets\./);
    }
    assert.ok(agentInstructions.length <= 2000, 'agent instructions stay short');
    assert.ok(operatorInstructions.length <= 3500, 'operator instructions stay short');
    assert.match(operatorInstructions, /operator_guide/);
    const guide = await operatorClient.callTool({ name: 'operator_guide', arguments: {} });
    assert.notEqual(guide.isError, true, JSON.stringify(guide.content));
    assert.match(JSON.parse(/** @type {any} */ (guide.content)[0].text).markdown, /Cretli operator playbook/);
    const proposal = await operatorClient.callTool({ name: 'operator_prompt_change_propose', arguments: { prompt_key: 'common', text: '- Proposed from MCP.', reason: 'Focused wording.' } });
    assert.notEqual(proposal.isError, true, JSON.stringify(proposal.content));
    assert.match(String(operatorClient.getInstructions() || ''), /Cretli MCP:/, 'a proposal does not activate itself');
  } finally {
    await agentClient.close();
    await operatorClient.close();
  }
});

test('operator model controls require operator mode and reject stale ETags', async () => {
  saveSettings({ externalMcpEnabled: true });
  const operator = createExternalMcpClient({ name: 'model-operator', workspaceFolder: workspace, mode: 'operator' });
  const agent = createExternalMcpClient({ name: 'model-agent', workspaceFolder: workspace, mode: 'agent' });
  const op = await connect(operator.token);
  const ordinary = await connect(agent.token);
  const call = async (name, args) => {
    const result = await op.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  try {
    for (const name of ['operator_model_overrides', 'operator_model_profiles', 'operator_favorites', 'operator_model_stats']) {
      assert.ok((await op.listTools()).tools.some((tool) => tool.name === name));
      assert.equal((await ordinary.callTool({ name, arguments: {} })).isError, true);
    }
    const overrides = await call('operator_model_overrides', { operation: 'list' });
    const created = await call('operator_model_overrides', { operation: 'create', if_match: overrides.etag, action: 'prefer', harness: 'codex', role: 'implement', scope: 'workspace', reason: 'available capacity', expires_at: new Date(Date.now() + 3600000).toISOString() });
    assert.equal(created.record.workspaceFolder, workspace.toLowerCase());
    assert.equal((await op.callTool({ name: 'operator_model_overrides', arguments: { operation: 'create', if_match: overrides.etag, action: 'prefer', harness: 'codex', reason: 'stale', expires_at: new Date(Date.now() + 3600000).toISOString() } })).isError, true);
    const revoked = await call('operator_model_overrides', { operation: 'revoke', id: created.record.id, if_match: created.etag });
    assert.ok(revoked.record.revokedAt);

    const profiles = await call('operator_model_profiles', { operation: 'get' });
    const patched = await call('operator_model_profiles', { operation: 'patch', if_match: profiles.etag, rotation: { mode: 'balanced', band: 0.25 } });
    assert.notEqual(patched.etag, profiles.etag);
    assert.equal((await op.callTool({ name: 'operator_model_profiles', arguments: { operation: 'patch', if_match: profiles.etag, rotation: { mode: 'off' } } })).isError, true);

    const favorites = await call('operator_favorites', { operation: 'list', harness: 'codex' });
    const set = await call('operator_favorites', { operation: 'set', harness: 'codex', models: ['gpt-6.1-sol'], if_match: favorites.etag });
    assert.deepEqual(set.models, ['gpt-6.1-sol']);
    assert.equal((await op.callTool({ name: 'operator_favorites', arguments: { operation: 'set', harness: 'codex', models: [], if_match: favorites.etag } })).isError, true);
    const roleSet = await call('operator_favorites', { operation: 'set', harness: 'codex', role: 'implement', models: ['gpt-5.6-sol::effort=medium'], if_match: set.etag });
    const roleSet2 = await call('operator_favorites', { operation: 'set', harness: 'codex', role: 'review', models: [], if_match: roleSet.etag });
    assert.deepEqual((await call('operator_favorites', { operation: 'list', harness: 'codex', role: 'review' })).favorites.codex, []);
    assert.deepEqual(loadSettings().codexChatEnabledModels, ['gpt-6.1-sol']);
    assert.ok(listHarnessModels({ harness: 'codex', enabledOnly: true, role: 'implement' }).items.some((row) => row.id === 'gpt-5.6-sol::effort=medium'));
    assert.equal(listHarnessModels({ harness: 'codex', enabledOnly: true, role: 'review' }).items.length, 0);
    const oldEmptyPolicy = process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
    process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'all';
    try {
      assert.equal(listHarnessModels({ harness: 'codex', enabledOnly: true, role: 'review' }).items.length, 0);
      assert.equal(buildNamedDelegationStartHardGateInput({ harness: 'codex', model: 'gpt-5.6-sol::effort=medium', role: 'review' }).favoritesConfigured, false);
    } finally {
      if (oldEmptyPolicy === undefined) delete process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
      else process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = oldEmptyPolicy;
    }
    assert.deepEqual(buildNamedDelegationStartHardGateInput({ harness: 'codex', model: 'gpt-5.6-sol::effort=medium', role: 'review' }).favoriteModels, []);
    assert.ok(buildNamedDelegationStartHardGateInput({ harness: 'codex', model: 'gpt-5.6-sol::effort=medium', role: 'implement' }).favoriteModels.includes('gpt-5.6-sol::effort=medium'));
    assert.notEqual(roleSet2.etag, roleSet.etag);
    const stats = await call('operator_model_stats', { role: 'implement' });
    assert.ok(Array.isArray(stats.selection.candidates));
    assert.equal(typeof stats.plan_pace, 'object');
  } finally {
    await op.close();
    await ordinary.close();
  }
});

test('operator_plan_approve approves a drafted plan with CAS and records who approved it', async () => {
  saveSettings({ externalMcpEnabled: true });
  const dataDir = resolveDataPath();
  addTodo(dataDir, workspace, { title: 'operator approve target', status: 'idea' });
  const created = loadTodosData(dataDir, workspace).items.find((row) => row.title === 'operator approve target');
  assert.ok(created);
  updateTodo(dataDir, workspace, created.id, { plan: { markdown: '# Version 1' } });
  const drafted = loadTodosData(dataDir, workspace).items.find((row) => row.id === created.id);
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const stale = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: created.id, expected_updated_at: '2000-01-01T00:00:00.000Z' },
    });
    assert.equal(stale.isError, true, 'a stale revision is refused');
    assert.equal(loadTodosData(dataDir, workspace).items.find((row) => row.id === created.id).plan.approvedAt, undefined);

    const approved = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: created.id.slice(0, 8), expected_updated_at: drafted.updatedAt, note: 'reviewers passed' },
    });
    assert.notEqual(approved.isError, true, JSON.stringify(approved.content));
    const saved = loadTodosData(dataDir, workspace).items.find((row) => row.id === created.id);
    assert.ok(saved.plan.approvedAt, 'plan is approved');
    assert.equal(saved.plan.markdown, '# Version 1', 'approval keeps the plan text');
    const changelog = (saved.changelog || []).map((entry) => entry.text).join('\n');
    assert.match(changelog, /external MCP client "night-watch"/);
    assert.match(changelog, /reviewers passed/);
    assert.deepEqual(saved.plan.approvedBy, { kind: 'mcp-operator', clientId: saved.plan.approvedBy.clientId, clientName: 'night-watch' });
    assert.ok(saved.plan.approvedBy.clientId, 'client id is recorded');
    const shown = await client.callTool({ name: 'todo_show', arguments: { todo_id: created.id } });
    assert.deepEqual(shown.structuredContent.item.plan_approved_by, saved.plan.approvedBy, 'todo_show exposes the approver');
  } finally {
    await client.close();
  }
});

test('an agent cannot set plan.approvedBy or approvedAt through todo_update', async () => {
  saveSettings({ externalMcpEnabled: true });
  const todo = seedTodo('agent forge approval', '# Plan');
  const { token } = createExternalMcpClient({ name: 'agent-writer', workspaceFolder: workspace, mode: 'agent' });
  const client = await connect(token);
  try {
    const forged = await client.callTool({
      name: 'todo_update',
      arguments: {
        todo_id: todo.id,
        expected_updated_at: todo.updatedAt,
        patch: { plan: { markdown: '# Plan', approvedBy: { kind: 'mcp-operator', clientId: 'x', clientName: 'x' } } },
      },
    });
    assert.equal(forged.isError, true, 'approvedBy is rejected');
    const forgedAt = await client.callTool({
      name: 'todo_update',
      arguments: { todo_id: todo.id, expected_updated_at: todo.updatedAt, patch: { plan: { markdown: '# Plan', approvedAt: '2030-01-01T00:00:00.000Z' } } },
    });
    assert.equal(forgedAt.isError, true, 'approvedAt is rejected');
    const after = readTodo(todo.id);
    assert.equal(after.plan?.approvedBy, undefined);
    assert.equal(after.plan?.approvedAt, undefined);
  } finally {
    await client.close();
  }
});

/**
 * @param {string} title
 * @param {string} [markdown] Plan text; omitted leaves the todo without a plan.
 */
function seedTodo(title, markdown) {
  const dataDir = resolveDataPath();
  addTodo(dataDir, workspace, { title, status: 'idea' });
  const created = loadTodosData(dataDir, workspace).items.find((row) => row.title === title);
  assert.ok(created);
  if (markdown) updateTodo(dataDir, workspace, created.id, { plan: { markdown } });
  return loadTodosData(dataDir, workspace).items.find((row) => row.id === created.id);
}

/** @param {string} id */
function readTodo(id) {
  return loadTodosData(resolveDataPath(), workspace).items.find((row) => row.id === id);
}

test('operator_plan_approve refuses a todo without a plan', async () => {
  saveSettings({ externalMcpEnabled: true });
  const todo = seedTodo('approve without plan');
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const res = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: todo.id, expected_updated_at: todo.updatedAt },
    });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /no plan to approve/);
    assert.equal(readTodo(todo.id).plan?.approvedAt, undefined);
  } finally {
    await client.close();
  }
});

test('operator_plan_approve refuses while the plan review is pending', async () => {
  saveSettings({ externalMcpEnabled: true });
  const todo = seedTodo('approve pending review', '# Plan');
  // The review snapshot is server-owned and does not bump the CAS token.
  writeTodoReview(resolveDataPath(), workspace, todo.id, { plan: { state: 'pending', subject: 'plan' } });
  assert.equal(readTodo(todo.id).updatedAt, todo.updatedAt, 'review write keeps the CAS token');
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const res = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: todo.id, expected_updated_at: todo.updatedAt },
    });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /Plan review is still pending/);
    assert.equal(readTodo(todo.id).plan?.approvedAt, undefined);
  } finally {
    await client.close();
  }
});

test('operator_plan_approve with a stale expected_updated_at on a draft plan is a conflict and approves nothing', async () => {
  saveSettings({ externalMcpEnabled: true });
  const todo = seedTodo('approve stale draft', '# Plan');
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const res = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: todo.id, expected_updated_at: '2000-01-01T00:00:00.000Z' },
    });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /CONFLICT/);
    assert.match(JSON.stringify(res.content), /does not match the current todo revision/);
    assert.equal(readTodo(todo.id).plan?.approvedAt, undefined, 'a stale approval writes nothing');
    assert.equal(readTodo(todo.id).updatedAt, todo.updatedAt);
  } finally {
    await client.close();
  }
});

test('operator_plan_approve on an approved plan: matching CAS is a no-op, a stale CAS is a conflict', async () => {
  saveSettings({ externalMcpEnabled: true });
  const todo = seedTodo('approve replay', '# Plan');
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const first = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: todo.id, expected_updated_at: todo.updatedAt },
    });
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    const approved = readTodo(todo.id);
    assert.ok(approved.plan.approvedAt);

    const replay = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: todo.id, expected_updated_at: approved.updatedAt },
    });
    assert.notEqual(replay.isError, true, JSON.stringify(replay.content));
    const replayBody = JSON.parse(/** @type {any} */ (replay.content)[0].text);
    assert.equal(replayBody.already_approved, true);
    assert.equal(readTodo(todo.id).updatedAt, approved.updatedAt, 'the replay writes nothing');

    const stale = await client.callTool({
      name: 'operator_plan_approve',
      arguments: { todo_id: todo.id, expected_updated_at: '2000-01-01T00:00:00.000Z' },
    });
    assert.equal(stale.isError, true, 'a stale revision is not a successful no-op');
    assert.match(JSON.stringify(stale.content), /CONFLICT/);
    assert.equal(readTodo(todo.id).updatedAt, approved.updatedAt);
  } finally {
    await client.close();
  }
});

test('operator_chat_send refuses a busy chat and replays an idempotency_key without a second start', async () => {
  saveSettings({ externalMcpEnabled: true });
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
  const chat = addChat('sess-external-send', 'external send target', null, workspace, 'm', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const first = await client.callTool({
      name: 'operator_chat_send',
      arguments: { chat: chat.id, text: 'hello', idempotency_key: 'key-1' },
    });
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    const firstBody = JSON.parse(/** @type {any} */ (first.content)[0].text);
    assert.equal(firstBody.accepted, true);
    assert.ok(firstBody.run_id);
    assert.equal(getMockChatRun(chat.id)?.busy, true);
    assert.equal(getMockChatRunStartCount(), 1);

    // Same key while the chat is busy: replayed, never sent twice.
    const replay = await client.callTool({
      name: 'operator_chat_send',
      arguments: { chat: chat.id, text: 'hello', idempotency_key: 'key-1' },
    });
    assert.notEqual(replay.isError, true, JSON.stringify(replay.content));
    assert.equal(JSON.parse(/** @type {any} */ (replay.content)[0].text).run_id, firstBody.run_id);
    assert.equal(getMockChatRunStartCount(), 1, 'the replay does not start a second run');

    // A new key against the busy chat is refused.
    const busy = await client.callTool({
      name: 'operator_chat_send',
      arguments: { chat: chat.id, text: 'second', idempotency_key: 'key-2' },
    });
    assert.equal(busy.isError, true);
    assert.match(JSON.stringify(busy.content), /recipient_busy/);
    assert.equal(getMockChatRunStartCount(), 1);
  } finally {
    await client.close();
    unregisterChatRunAdapter('opencode');
    resetMockChatRuns();
  }
});

test('operator_chat_send without idempotency_key is a VALIDATION_ERROR and starts nothing', async () => {
  saveSettings({ externalMcpEnabled: true });
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
  const chat = addChat('sess-external-nokey', 'external no-key target', null, workspace, 'm', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    // The chat exists and is idle, so only the missing key can cause the refusal.
    const res = await client.callTool({ name: 'operator_chat_send', arguments: { chat: chat.id, text: 'hello' } });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /VALIDATION_ERROR/);
    assert.match(JSON.stringify(res.content), /idempotency_key is required/);
    assert.equal(getMockChatRunStartCount(), 0, 'no run is started without a key');
  } finally {
    await client.close();
    unregisterChatRunAdapter('opencode');
    resetMockChatRuns();
  }
});

test('operator_chat_send: busy chat refuses without wait_idle_ms and sends once idle with it', async () => {
  saveSettings({ externalMcpEnabled: true });
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
  const chat = addChat('sess-external-wait', 'external wait target', null, workspace, 'm', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  seedMockChatRun(chat.id, { runId: 'busy-run', busy: true });
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const refused = await client.callTool({
      name: 'operator_chat_send',
      arguments: { chat: chat.id, text: 'now', idempotency_key: 'wait-0' },
    });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /recipient_busy/);
    assert.equal(getMockChatRunStartCount(), 0, 'a refused send starts no run');

    // The chat goes idle shortly after the waiting call begins.
    const pending = client.callTool({
      name: 'operator_chat_send',
      arguments: { chat: chat.id, text: 'later', idempotency_key: 'wait-1', wait_idle_ms: 10000 },
    });
    setTimeout(() => patchMockChatRun(chat.id, { busy: false }), 300);
    const sent = await pending;
    assert.notEqual(sent.isError, true, JSON.stringify(sent.content));
    const body = JSON.parse(/** @type {any} */ (sent.content)[0].text);
    assert.equal(body.accepted, true);
    assert.notEqual(body.run_id, 'busy-run');
    assert.equal(getMockChatRunStartCount(), 1, 'exactly one run starts after the wait');
  } finally {
    await client.close();
    unregisterChatRunAdapter('opencode');
    resetMockChatRuns();
  }
});

test('operator chat tools stay inside the client workspace', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const missing = await client.callTool({ name: 'operator_chat_status', arguments: { chat: '00000000-0000' } });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /NOT_FOUND/);
    const noKey = await client.callTool({ name: 'operator_chat_send', arguments: { chat: 'x', text: 'hi' } });
    assert.equal(noKey.isError, true);
  } finally {
    await client.close();
  }
});

function readAudit() {
  const file = resolveDataPath(EXTERNAL_MCP_AUDIT_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('tool calls are audited without arguments or token, and the rate limit rejects with 429', async () => {
  saveSettings({ externalMcpEnabled: true });
  setExternalMcpRateLimit(2);
  const { client: info, token } = createExternalMcpClient({ name: 'audited', workspaceFolder: workspace, mode: 'plan' });
  const client = await connect(token);
  try {
    await client.callTool({ name: 'todo_list', arguments: { query: 'secret-argument-value' } });
    const denied = await client.callTool({ name: 'todo_create', arguments: { title: 'x' } });
    assert.equal(denied.isError, true);
    const afterCalls = readAudit();
    assert.equal(afterCalls.length, 4);
    assert.deepEqual(afterCalls.map((row) => [row.clientId, row.tool, row.outcome]), [
      [info.id, 'todo_list', 'started'],
      [info.id, 'todo_list', 'ok'],
      [info.id, 'todo_create', 'started'],
      [info.id, 'todo_create', 'error'],
    ]);
    assert.ok(!Number.isNaN(Date.parse(afterCalls[0].at)));
  } finally {
    await client.close();
  }

  const call = (name) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: { title: 'never-run' } } }),
    });
  const limited = await call('todo_create');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');

  const rows = readAudit();
  assert.equal(rows.length, 5);
  assert.deepEqual([rows[4].tool, rows[4].outcome], ['todo_create', 'rejected']);
  const raw = fs.readFileSync(resolveDataPath(EXTERNAL_MCP_AUDIT_FILE), 'utf8');
  assert.equal(raw.includes(token.split('.')[2]), false, 'the secret must not be audited');
  assert.equal(raw.includes('secret-argument-value'), false, 'arguments must not be audited');
  assert.equal(raw.includes('never-run'), false, 'arguments must not be audited');
  assert.equal(
    loadTodosData(resolveDataPath(), workspace).items.some((row) => row.title === 'never-run'),
    false,
    'a rate-limited tool is not executed',
  );
});

test('a tool call is audited as rejected when the built-in MCP server is disabled (503)', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { client: info, token } = createExternalMcpClient({ name: 'inactive', workspaceFolder: workspace, mode: 'plan' });
  const before = loadMcpDocument();
  await saveMcpDocument([{ ...createBuiltinCretliServer(), enabled: false }], before.revision);
  try {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'todo_list', arguments: { query: 'inactive-secret-arg' } } }),
    });
    assert.equal(res.status, 503);
    const rows = readAudit();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].clientId, rows[0].tool, rows[0].outcome], [info.id, 'todo_list', 'rejected']);
    const raw = fs.readFileSync(resolveDataPath(EXTERNAL_MCP_AUDIT_FILE), 'utf8');
    assert.equal(raw.includes(token.split('.')[2]), false, 'the secret must not be audited');
    assert.equal(raw.includes('inactive-secret-arg'), false, 'arguments must not be audited');
  } finally {
    await saveMcpDocument([], loadMcpDocument().revision);
  }
});

test('fail-closed: when the started audit record cannot be written the tool is not executed', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { token } = createExternalMcpClient({ name: 'unaudited', workspaceFolder: workspace, mode: 'agent' });
  const auditPath = resolveDataPath(EXTERNAL_MCP_AUDIT_FILE);
  // A directory at the audit path makes every append fail (EISDIR), even for root.
  fs.mkdirSync(auditPath, { recursive: true });
  const client = await connect(token);
  try {
    await assert.rejects(
      client.callTool({ name: 'todo_create', arguments: { title: 'audit-down-never-run' } }),
      /Audit log unavailable/,
    );
    assert.equal(
      loadTodosData(resolveDataPath(), workspace).items.some((row) => row.title === 'audit-down-never-run'),
      false,
      'the tool must not run when the audit write fails',
    );
  } finally {
    await client.close();
    fs.rmSync(auditPath, { recursive: true, force: true });
  }
});

test('client mode can be changed in place and applies to the next request', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { client, token } = createExternalMcpClient({ name: 'switch', workspaceFolder: workspace, mode: 'plan' });

  const patch = async (id, body) => {
    const res = await fetch(`${baseUrl}/api/mcp/external-clients/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await patch(client.id, { mode: 'root' })).status, 400, 'unknown mode is refused');
  assert.equal((await patch('missing-id', { mode: 'agent' })).status, 404);

  const changed = await patch(client.id, { mode: 'operator' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.client.mode, 'operator');
  assert.equal(changed.body.client.secretHash, undefined, 'the secret hash never leaves the module');

  const mcp = await connect(token);
  try {
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('operator_chat_status'), 'the same token now sees operator tools');
  } finally {
    await mcp.close();
  }

  revokeExternalMcpClient(client.id);
  assert.throws(() => updateExternalMcpClientMode(client.id, 'agent'), /revoked/);
});

test('operator watcher tools show and reset failures and backoff', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { upsertWorkspaceWatcher } = await import('../lib/persist/workspace-watchers-persist.js');
  upsertWorkspaceWatcher(workspace, {
    mode: 'autopilot',
    failures: { 'todo-a': 3 },
    backoffUntil: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    blockedBackoff: { 'todo-b': { count: 4, until: new Date(Date.now() + 3600 * 1000).toISOString() } },
  });
  const operator = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const agent = createExternalMcpClient({ name: 'agent', workspaceFolder: workspace, mode: 'agent' });
  const client = await connect(operator.token);
  const agentClient = await connect(agent.token);
  try {
    const status = await client.callTool({ name: 'operator_watcher_status', arguments: {} });
    assert.notEqual(status.isError, true, JSON.stringify(status.content));
    const before = JSON.parse(/** @type {any} */ (status.content)[0].text);
    assert.equal(before.failures['todo-a'], 3);
    assert.ok(Array.isArray(before.doing_attention), 'status lists doing todos that need attention');
    assert.ok(before.backoff_until);
    assert.equal(before.blocked_backoff['todo-b'].count, 4, 'status lists per-todo blocked backoff');

    const refused = await client.callTool({ name: 'operator_watcher_reset', arguments: {} });
    assert.equal(refused.isError, true, 'reset needs confirm: true');

    const denied = await agentClient.callTool({ name: 'operator_watcher_reset', arguments: { confirm: true } });
    assert.equal(denied.isError, true, 'agent-mode clients cannot reset the watcher');

    const reset = await client.callTool({ name: 'operator_watcher_reset', arguments: { confirm: true, reason: 'test' } });
    assert.notEqual(reset.isError, true, JSON.stringify(reset.content));
    const after = JSON.parse(/** @type {any} */ (reset.content)[0].text).after;
    assert.deepEqual(after.failures, {});
    assert.equal(after.backoff_until, '');
    assert.equal(after.blocked_backoff['todo-b'].count, 4, 'a flagless reset keeps per-todo blocked backoff');
    assert.equal(after.mode, 'autopilot', 'mode is left alone');

    const pauseRefused = await client.callTool({ name: 'operator_watcher_pause', arguments: { paused: true } });
    assert.equal(pauseRefused.isError, true, 'pause needs confirm: true');
    const pauseDenied = await agentClient.callTool({ name: 'operator_watcher_pause', arguments: { paused: true, confirm: true } });
    assert.equal(pauseDenied.isError, true, 'agent-mode clients cannot pause the watcher');
    const paused = await client.callTool({ name: 'operator_watcher_pause', arguments: { paused: true, confirm: true, reason: 'test' } });
    assert.notEqual(paused.isError, true, JSON.stringify(paused.content));
    assert.equal(JSON.parse(/** @type {any} */ (paused.content)[0].text).paused, true);
    const resumed = await client.callTool({ name: 'operator_watcher_pause', arguments: { paused: false, confirm: true } });
    const resumedView = JSON.parse(/** @type {any} */ (resumed.content)[0].text);
    assert.equal(resumedView.paused, false);
    assert.equal(resumedView.mode, 'autopilot', 'pause leaves the mode alone');
  } finally {
    await client.close();
    await agentClient.close();
  }
});

test('operator_watcher_reset clears blocked backoff by todo_ids or all_blocked', async () => {
  saveSettings({ externalMcpEnabled: true });
  const { upsertWorkspaceWatcher } = await import('../lib/persist/workspace-watchers-persist.js');
  const until = new Date(Date.now() + 3600 * 1000).toISOString();
  const dataDir = resolveDataPath();
  addTodo(dataDir, workspace, { title: 'backoff one', status: 'ready' });
  addTodo(dataDir, workspace, { title: 'backoff two', status: 'ready' });
  const rows = loadTodosData(dataDir, workspace).items;
  const one = rows.find((row) => row.title === 'backoff one');
  const two = rows.find((row) => row.title === 'backoff two');
  const seed = () => upsertWorkspaceWatcher(workspace, {
    mode: 'autopilot',
    blockedBackoff: { [one.id]: { count: 2, until }, [two.id]: { count: 3, until } },
  });
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  const call = async (args) => {
    const res = await client.callTool({ name: 'operator_watcher_reset', arguments: args });
    return { res, body: res.isError ? null : JSON.parse(/** @type {any} */ (res.content)[0].text) };
  };
  try {
    seed();
    const partial = await call({ confirm: true, todo_ids: [one.id] });
    assert.deepEqual(Object.keys(partial.body.before.blocked_backoff).sort(), [one.id, two.id].sort());
    assert.deepEqual(Object.keys(partial.body.after.blocked_backoff), [two.id], 'only the named todo is released');

    seed();
    const all = await call({ confirm: true, all_blocked: true });
    assert.deepEqual(all.body.after.blocked_backoff, {});

    seed();
    const none = await call({ confirm: true });
    assert.deepEqual(Object.keys(none.body.after.blocked_backoff).sort(), [one.id, two.id].sort(), 'no flags keeps blocked backoff');

    seed();
    const both = await call({ confirm: true, all_blocked: true, todo_ids: [one.id] });
    assert.equal(both.res.isError, true, 'all_blocked and todo_ids are exclusive');

    seed();
    const bothEmpty = await call({ confirm: true, all_blocked: true, todo_ids: [] });
    assert.equal(bothEmpty.res.isError, true, 'all_blocked with an empty todo_ids array is rejected too');
  } finally {
    await client.close();
  }
});

test('operator_watcher_release_unknown goes through the guarded release path', async () => {
  saveSettings({ externalMcpEnabled: true });
  const dataDir = resolveDataPath();
  addTodo(dataDir, workspace, { title: 'release target', status: 'ready' });
  const target = loadTodosData(dataDir, workspace).items.find((row) => row.title === 'release target');
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(listed.includes('operator_watcher_release_unknown'));
    const noConfirm = await client.callTool({
      name: 'operator_watcher_release_unknown',
      arguments: { todo_id: target.id, expected_updated_at: target.updatedAt },
    });
    assert.equal(noConfirm.isError, true, 'confirm: true is required');
    const notDoing = await client.callTool({
      name: 'operator_watcher_release_unknown',
      arguments: { todo_id: target.id, expected_updated_at: target.updatedAt, confirm: true },
    });
    assert.equal(notDoing.isError, true, 'a ready todo is not released');
    assert.match(JSON.stringify(notDoing.content), /not-doing/);
  } finally {
    await client.close();
  }
});

test('operator_plan_review_start starts a refine coordinator chat with the server prompt; a retry replays', async () => {
  saveSettings({ externalMcpEnabled: true });
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
  const { setBuiltinMcpRuntimeDeps, getBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  const previous = getBuiltinMcpRuntimeDeps().startTodoAgent;
  const todo = seedTodo('plan review target');
  updateTodo(resolveDataPath(), workspace, todo.id, { plan: { markdown: '# Plan\n- step' } });
  const chat = addChat('sess-plan-review', '[Todo plan] plan review target', null, workspace, 'm', {
    agentTransport: 'opencode',
    sdkMode: 'plan',
  });
  /** @type {any[]} */
  const calls = [];
  setBuiltinMcpRuntimeDeps({
    startTodoAgent: async (input) => {
      calls.push(input);
      const startedChat = calls.length === 1
        ? chat
        : addChat('sess-plan-review-explicit', '[Todo plan] explicit model', null, workspace, input.body.model, {
          agentTransport: 'opencode',
          sdkMode: 'plan',
        });
      return { chat: startedChat, initialPrompt: 'Review the plan with two reviewers', planReviewerSession: { id: 'prs-1' } };
    },
  });
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const res = await client.callTool({
      name: 'operator_plan_review_start',
      arguments: { todo_id: todo.id, harness: 'opencode', idempotency_key: 'review-1' },
    });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const body = JSON.parse(/** @type {any} */ (res.content)[0].text);
    assert.equal(body.chat_id, chat.id);
    assert.equal(body.plan_reviewer_session_id, 'prs-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.mode, 'refine');
    assert.equal(calls[0].body.agentTransport, 'opencode');
    assert.equal(calls[0].body.model, '', 'an omitted model lets the harness select its default');
    assert.equal(calls[0].workspaceFolder, workspace);
    assert.equal(body.model, 'm');
    assert.equal(getMockChatRunStartCount(), 1, 'the coordinator run starts with the refine prompt');

    const explicit = await client.callTool({
      name: 'operator_plan_review_start',
      arguments: { todo_id: todo.id, harness: 'opencode', model: 'gpt-explicit', idempotency_key: 'review-explicit' },
    });
    assert.notEqual(explicit.isError, true, JSON.stringify(explicit.content));
    assert.equal(JSON.parse(/** @type {any} */ (explicit.content)[0].text).model, 'gpt-explicit');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.model, 'gpt-explicit');

    const replay = await client.callTool({
      name: 'operator_plan_review_start',
      arguments: { todo_id: todo.id, harness: 'opencode', idempotency_key: 'review-1' },
    });
    assert.equal(JSON.parse(/** @type {any} */ (replay.content)[0].text).replayed, true);
    assert.equal(calls.length, 2, 'a retry with the same key creates no additional chat');
    assert.equal(getMockChatRunStartCount(), 2);
  } finally {
    await client.close();
    setBuiltinMcpRuntimeDeps({ startTodoAgent: previous });
    unregisterChatRunAdapter('opencode');
    resetMockChatRuns();
  }
});

test('operator_plan_review_start refuses a todo without a draft plan and starts nothing', async () => {
  saveSettings({ externalMcpEnabled: true });
  const todo = seedTodo('plan review without plan');
  const { token } = createExternalMcpClient({ name: 'night-watch', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const res = await client.callTool({
      name: 'operator_plan_review_start',
      arguments: { todo_id: todo.id, harness: 'claude', idempotency_key: 'review-2' },
    });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res.content), /no plan to review/);
  } finally {
    await client.close();
  }
});
