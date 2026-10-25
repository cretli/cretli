/**
 * cretli_feedback end to end: in-process MCP bridge (plan mode) and the external /mcp endpoint.
 * Covers filing, dedup counter, size and rate limits, secret masking, isolation from other todos
 * and the Watcher never selecting the feedback root or its reports. Also proves the real
 * <repo>/data directory is left untouched.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { addTodo, loadTodosData, todosDocumentPath } = await import('../lib/persist/todos-persist.js');
const { FEEDBACK_ROOT_TITLE } = await import('../lib/persist/feedback-store.js');
const { saveSettings } = await import('../lib/persist/settings.js');
const { resolveDataPath, resolveProjectPath } = await import('../lib/runtime-paths.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
const { FEEDBACK_RATE_LIMITS, resetFeedbackRateLimits } = await import('../lib/mcp/builtin/feedback-tools.js');
const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
const { createExternalMcpClient } = await import('../lib/mcp/mcp-external-clients.js');
const { setExternalMcpRateLimit } = await import('../lib/mcp/mcp-external-audit.js');
const { registerExternalMcpRoutes } = await import('../lib/routes/mcp-external-routes.js');
const { claimNextWorkspaceTodo, pickNextWorkspaceReadyTodo } = await import('../lib/workspace-watcher.js');

/**
 * The repo-level data directory that tests must never write to. This run's writes are proven
 * to go to the isolated temp dir (first test) and the real todos document is checked last.
 */
const REAL_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');


const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-feedback-e2e-ws-'));
const cretliCwd = resolveProjectPath();
const dataDir = ISOLATED_DATA_DIR;
const items = () => loadTodosData(dataDir, cretliCwd).items;
const feedbackRoot = () => items().find((row) => row.title === FEEDBACK_ROOT_TITLE);

// Hashing the whole real data/ is too slow in a live checkout (multi-GB stores) and
// racy while a server writes to it. Instead, the real Cretli todos document must
// not gain any report this run files.
const REAL_TODOS_FILE = todosDocumentPath(REAL_DATA_DIR, cretliCwd);
const RUN_MARKERS = /bridge e2e report|bridge rate|bridge secret check|external e2e report|external rate|external secret check|legit isolation report/gi;
/** @returns {number} */
function countRealRunMarkers() {
  if (!fs.existsSync(REAL_TODOS_FILE)) return 0;
  return (fs.readFileSync(REAL_TODOS_FILE, 'utf8').match(RUN_MARKERS) || []).length;
}
const realMarkersBefore = countRealRunMarkers();

setBuiltinMcpRuntimeDeps({ dataDir });
saveSettings({ externalMcpEnabled: true });

/** @type {http.Server} */
let server;
let baseUrl = '';

before(async () => {
  const app = express();
  app.use(express.json());
  registerExternalMcpRoutes(app);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(workspace, { recursive: true, force: true });
  removeIsolatedDataDir();
});

/**
 * @param {string} token
 */
async function connect(token) {
  const client = new Client({ name: 'feedback-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

/**
 * @param {string} chatId
 */
function bridgeHandlers(chatId) {
  const builtinClient = createInProcessMcpClient({ harness: 'opencode', chatId, workspaceFolder: workspace });
  return createCretliMcpToolHandlers(builtinClient, {
    chatId,
    workspaceFolder: workspace,
    harness: 'opencode',
    mode: 'plan',
    builtinClient,
  });
}

/** @param {any} res */
const resultText = (res) => (res?.content || []).map((part) => part.text || '').join('\n');

test('real data/ is not the data dir of this run', () => {
  assert.ok(path.resolve(resolveDataPath()).startsWith(path.resolve(ISOLATED_DATA_DIR)));
  assert.notEqual(path.resolve(ISOLATED_DATA_DIR), REAL_DATA_DIR);
});

test('in-process bridge: plan-mode client files an idea under the feedback root, duplicate bumps the counter', async () => {
  resetFeedbackRateLimits();
  const h = bridgeHandlers('chat-e2e-bridge');
  const first = await h.cretli_feedback({ kind: 'missing_tool', summary: 'Bridge e2e report', details: 'needs X' });
  assert.equal(first.isError, false, resultText(first));
  assert.equal(first.structuredContent.action, 'created');
  const root = feedbackRoot();
  assert.ok(root, 'root is created');
  assert.equal(items().filter((row) => row.title === FEEDBACK_ROOT_TITLE).length, 1);
  const row = items().find((it) => it.id === first.structuredContent.id);
  assert.equal(row.parentId, root.id);
  assert.equal(row.status, 'idea');
  assert.equal(row.assignee, undefined);

  const before = items().length;
  const dup = await h.cretli_feedback({ kind: 'missing_tool', summary: ' bridge E2E report. ' });
  assert.equal(dup.structuredContent.action, 'duplicate');
  assert.equal(dup.structuredContent.id, first.structuredContent.id);
  assert.equal(dup.structuredContent.count, 2);
  assert.equal(items().length, before);

  const denied = await h.todo_create({ title: 'plan must deny', idempotency_key: 'e2e-plan-deny' });
  assert.equal(denied.isError, true);
  assert.match(resultText(denied), /PLAN_MODE_DENIED/);
});

test('in-process bridge: oversize fields and unknown fields are errors that store nothing', async () => {
  resetFeedbackRateLimits();
  const h = bridgeHandlers('chat-e2e-oversize');
  const before = items().length;
  for (const args of [
    { kind: 'bug', summary: 'x'.repeat(201) },
    { kind: 'bug', summary: 's', details: 'x'.repeat(4001) },
    { kind: 'bug', summary: 's', repro: 'x'.repeat(2001) },
    { kind: 'bug', summary: 's', tool: 'x'.repeat(101) },
    { kind: 'bug', summary: 's', unknown_field: 1 },
  ]) {
    const res = await h.cretli_feedback(args);
    assert.equal(res.isError, true, JSON.stringify(Object.keys(args)));
    assert.match(resultText(res), /VALIDATION_ERROR/);
  }
  assert.equal(items().length, before);
});

test('in-process bridge: the per-chat rate limit returns an error', async () => {
  resetFeedbackRateLimits();
  const h = bridgeHandlers('chat-e2e-rate');
  for (let i = 0; i < FEEDBACK_RATE_LIMITS.internal.limit; i += 1) {
    const ok = await h.cretli_feedback({ kind: 'idea', summary: `bridge rate idea ${i}` });
    assert.equal(ok.isError, false, resultText(ok));
  }
  const before = items().length;
  const over = await h.cretli_feedback({ kind: 'idea', summary: 'bridge rate overflow' });
  assert.equal(over.isError, true);
  assert.match(resultText(over), /rate limit/i);
  assert.equal(items().length, before);
  // Another chat has its own window.
  const other = await bridgeHandlers('chat-e2e-rate-2').cretli_feedback({ kind: 'idea', summary: 'bridge rate other chat' });
  assert.equal(other.isError, false);
});

test('in-process bridge: secrets in details are masked in the stored body', async () => {
  resetFeedbackRateLimits();
  const token = 'mcp1.abcdefgh12345678.ZYXWVUTS87654321';
  const res = await bridgeHandlers('chat-e2e-secret').cretli_feedback({
    kind: 'bug',
    summary: 'bridge secret check',
    details: `token ${token} key sk-abcdefghijklmnopqrstuv at /home/alice/proj host 192.168.1.20 api_key=hunter2hunter2`,
  });
  assert.equal(res.isError, false, resultText(res));
  const body = items().find((it) => it.id === res.structuredContent.id).body;
  for (const leaked of [token, 'sk-abcdefghij', '/home/alice', '192.168.1.20', 'hunter2']) {
    assert.ok(!body.includes(leaked), `leaked ${leaked}`);
    assert.ok(!resultText(res).includes(leaked), `echoed ${leaked}`);
  }
});

test('in-process bridge: the tool cannot read or modify other todos or set a status', async () => {
  resetFeedbackRateLimits();
  const victim = addTodo(dataDir, cretliCwd, { title: 'Private victim todo', body: 'secret-victim-body', status: 'ready' }).item;
  // addTodo returns { ..., item }: guard against a vacuous undefined === undefined comparison.
  assert.equal(typeof victim.id, 'string');
  assert.ok(victim.id.length > 0);
  const snapshot = JSON.stringify(items().find((row) => row.id === victim.id));
  assert.ok(snapshot && snapshot.includes('secret-victim-body'), 'snapshot holds the real victim row');
  const h = bridgeHandlers('chat-e2e-isolation');
  for (const args of [
    { kind: 'bug', summary: 'poke', todo_id: victim.id },
    { kind: 'bug', summary: 'poke', status: 'done' },
    { kind: 'bug', summary: 'poke', parent_id: victim.id },
    { kind: 'bug', summary: 'poke', assignee: { harness: 'codex', role: 'implement' } },
  ]) {
    const res = await h.cretli_feedback(args);
    assert.equal(res.isError, true);
    assert.match(resultText(res), /VALIDATION_ERROR/);
  }
  const ok = await h.cretli_feedback({ kind: 'bug', summary: 'legit isolation report', details: `about ${victim.id}` });
  assert.equal(ok.isError, false);
  assert.ok(!JSON.stringify(ok).includes('secret-victim-body'));
  assert.equal(JSON.stringify(items().find((row) => row.id === victim.id)), snapshot, 'other todo is byte-identical');
  assert.equal(items().find((row) => row.id === ok.structuredContent.id).status, 'idea');
});

test('external /mcp: plan-mode client files, dedups, hits validation and secret masking', async () => {
  resetFeedbackRateLimits();
  setExternalMcpRateLimit();
  const { token } = createExternalMcpClient({ name: 'e2e-planner', workspaceFolder: workspace, mode: 'plan' });
  const client = await connect(token);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'cretli_feedback'));

    const filed = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'docs', summary: 'External e2e report' } });
    assert.notEqual(filed.isError, true, JSON.stringify(filed.content));
    const id = /** @type {any} */ (filed.structuredContent).id;
    const row = items().find((it) => it.id === id);
    assert.equal(row.parentId, feedbackRoot().id);
    assert.equal(row.status, 'idea');

    const dup = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'docs', summary: 'external e2e report' } });
    assert.equal(/** @type {any} */ (dup.structuredContent).action, 'duplicate');
    assert.equal(/** @type {any} */ (dup.structuredContent).count, 2);

    const big = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'bug', summary: 'x'.repeat(201) } });
    assert.equal(big.isError, true);

    const secret = await client.callTool({
      name: 'cretli_feedback',
      arguments: { kind: 'bug', summary: 'external secret check', details: 'key sk-abcdefghijklmnopqrstuv at /home/alice/p host 10.0.0.5' },
    });
    assert.notEqual(secret.isError, true, JSON.stringify(secret.content));
    const body = items().find((it) => it.id === /** @type {any} */ (secret.structuredContent).id).body;
    for (const leaked of ['sk-abcdefghij', '/home/alice', '10.0.0.5']) assert.ok(!body.includes(leaked), `leaked ${leaked}`);

    const poke = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'bug', summary: 'poke', todo_id: row.id } });
    assert.equal(poke.isError, true);
    const write = await client.callTool({ name: 'todo_update', arguments: { todo_id: row.id, patch: { status: 'ready' }, expected_updated_at: row.updatedAt } });
    assert.equal(write.isError, true, 'plan mode cannot change the report status');
    assert.equal(items().find((it) => it.id === id).status, 'idea');
  } finally {
    await client.close();
  }
});

test('external /mcp: the per-client rate limit returns an error and stores nothing', async () => {
  resetFeedbackRateLimits();
  setExternalMcpRateLimit(1000);
  const { token } = createExternalMcpClient({ name: 'e2e-rate', workspaceFolder: workspace, mode: 'plan' });
  const client = await connect(token);
  try {
    for (let i = 0; i < FEEDBACK_RATE_LIMITS.external.limit; i += 1) {
      const ok = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'idea', summary: `external rate idea ${i}` } });
      assert.notEqual(ok.isError, true, JSON.stringify(ok.content));
    }
    const before = items().length;
    const over = await client.callTool({ name: 'cretli_feedback', arguments: { kind: 'idea', summary: 'external rate overflow' } });
    assert.equal(over.isError, true);
    assert.match(JSON.stringify(over.content), /rate limit/i);
    assert.equal(items().length, before);
  } finally {
    await client.close();
    setExternalMcpRateLimit();
  }
});

test('Watcher selection never picks the feedback root or its reports', async () => {
  resetFeedbackRateLimits();
  const root = feedbackRoot();
  assert.ok(root, 'earlier tests created reports');
  const children = items().filter((row) => row.parentId === root.id);
  assert.ok(children.length >= 3);
  assert.ok(children.every((row) => row.status === 'idea' && !row.assignee));

  // Control: a genuinely ready leaf is the only thing the claim can return.
  const ready = addTodo(dataDir, cretliCwd, { title: 'Watcher control leaf', body: 'work', status: 'ready' }).item;
  const picked = pickNextWorkspaceReadyTodo({ items: items(), failures: {}, maxFailures: 3 });
  assert.equal(picked?.id, ready.id);

  // Drain every ready leaf (this file's own non-feedback todos); each claim must be one of them.
  const feedbackIds = new Set([root.id, ...children.map((row) => row.id)]);
  const claimedIds = [];
  for (let i = 0; i < 10; i += 1) {
    const res = claimNextWorkspaceTodo({ dataDir, workspaceFolder: cretliCwd, claimedByChatId: `chat-e2e-claimer-${i}`, releaseStaleClaims: false });
    if (!res.claimed) {
      assert.equal(res.reason, 'no_ready_work');
      break;
    }
    claimedIds.push(res.todoId);
  }
  assert.ok(claimedIds.includes(ready.id), 'the control leaf is claimable');
  assert.ok(claimedIds.every((id) => !feedbackIds.has(id)), 'no feedback todo was claimed');
  assert.ok(claimedIds.length < 10, 'claiming terminated with no_ready_work');

  const rootAfter = items().find((row) => row.id === root.id);
  assert.equal(rootAfter.status, 'idea');
  assert.ok(!rootAfter.claimedByChatId);
  for (const child of items().filter((row) => row.parentId === root.id)) {
    assert.equal(child.status, 'idea');
    assert.ok(!child.claimedByChatId);
  }
});

test('the real Cretli todos document gains no report from this run', () => {
  assert.equal(countRealRunMarkers(), realMarkersBefore);
});
