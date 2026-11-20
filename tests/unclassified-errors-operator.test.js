import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { saveSettings } from '../lib/persist/settings.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { createExternalMcpClient } from '../lib/mcp/mcp-external-clients.js';
import { registerExternalMcpRoutes } from '../lib/routes/mcp-external-routes.js';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';
import { captureRunEnd, beginRunEndSnapshot } from '../lib/usage/run-end-snapshot.js';
import { noteUnclassifiedRunError } from '../lib/harness-usage-limits.js';
import { resetUnclassifiedRegistries } from '../lib/usage/unclassified-errors.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-unclassified-op-ws-'));
const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-unclassified-op-other-'));
const storeFile = () => resolveDataPath('usage', 'unclassified-errors.jsonl');
const readStore = () => fs.readFileSync(storeFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let server;
let baseUrl = '';

before(async () => {
  const app = express();
  app.use(express.json());
  registerExternalMcpRoutes(app);
  registerUsageRoutes(app, { dataDir: resolveDataPath() });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  fs.rmSync(resolveDataPath('usage'), { recursive: true, force: true });
  resetUnclassifiedRegistries();
  saveSettings({ externalMcpEnabled: true });
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(otherWorkspace, { recursive: true, force: true });
});

async function connect(token) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

function fail(harness, chatId, cwd, message, runId) {
  const room = { sessionKey: `${harness}-${runId}`, modelId: 'm1', chatId, cwd };
  beginRunEndSnapshot(room, { sessionId: room.sessionKey });
  return captureRunEnd({ room, harness, dataDir: resolveDataPath(), payload: { runId, status: 'error', result: message } });
}

async function callTool(client, args = {}) {
  const res = await client.callTool({ name: 'unclassified_errors', arguments: args });
  return { res, text: JSON.stringify(res.content), data: res.isError ? null : JSON.parse(res.content[0].text) };
}

test('captureRunEnd stores lastContext for SDK and non-SDK harnesses; recurrence updates it and keeps it when absent', () => {
  fail('claude', 'chat-1', workspace, 'weird failure alpha', 'r1');
  fail('sdk', 'chat-2', workspace, 'weird failure beta', 'r2');
  let rows = readStore();
  assert.deepEqual(rows.find((r) => r.harness === 'claude').lastContext, { chatId: 'chat-1', workspaceFolder: workspace });
  assert.deepEqual(rows.find((r) => r.harness === 'sdk').lastContext, { chatId: 'chat-2', workspaceFolder: workspace });
  fail('claude', 'chat-9', otherWorkspace, 'weird failure alpha', 'r3');
  rows = readStore();
  const claude = rows.find((r) => r.harness === 'claude');
  assert.equal(claude.count, 2);
  assert.deepEqual(claude.lastContext, { chatId: 'chat-9', workspaceFolder: otherWorkspace });
  fail('claude', '', '', 'weird failure alpha', 'r4');
  const kept = readStore().find((r) => r.harness === 'claude');
  assert.equal(kept.count, 3);
  assert.deepEqual(kept.lastContext, { chatId: 'chat-9', workspaceFolder: otherWorkspace });
});

test('old rows without lastContext still read and rewrite intact', async () => {
  fs.mkdirSync(resolveDataPath('usage'), { recursive: true });
  const old = { ts: '2026-10-25T00:00:00.000Z', harness: 'codex', model: 'm1', signature: 'legacy failure', message: 'legacy failure', count: 2, firstSeenAt: '2026-10-25T00:00:00.000Z', lastSeenAt: '2026-10-25T00:00:00.000Z' };
  fs.writeFileSync(storeFile(), `${JSON.stringify(old)}\n`);
  const { token } = createExternalMcpClient({ name: 'op', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    const { data } = await callTool(client);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].last_context, null);
    assert.equal(data.items[0].count, 2);
  } finally { await client.close(); }
  noteUnclassifiedRunError({ harness: 'codex', model: 'm1', message: 'legacy failure', dataDir: resolveDataPath() });
  const [row] = readStore();
  assert.equal(row.count, 3);
  assert.equal(row.lastContext, undefined);
});

test('tool returns redacted data without raw paths, secrets or workspace; same_workspace variants', async () => {
  const link = path.join(os.tmpdir(), `cretli-unclassified-link-${process.pid}`);
  fs.symlinkSync(workspace, link);
  fail('claude', 'chat-same', `${workspace}${path.sep}`, 'boom at /home/someone/proj/x.js token=abc123secret https://api.example.com/v1?key=1 sk-abcdefghijklmnop1234', 'a');
  fail('codex', 'chat-link', link, 'second odd failure', 'b');
  fail('sdk', 'chat-other', otherWorkspace, 'third odd failure', 'c');
  fail('opencode', '', '', 'fourth odd failure', 'd');
  const { token } = createExternalMcpClient({ name: 'op', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200)); // let run-end background syncs settle
    const snapshotDir = () => fs.readdirSync(resolveDataPath('usage'), { recursive: true }).sort().map((f) => `${f}:${fs.statSync(resolveDataPath('usage', String(f))).mtimeMs}`);
    const before = fs.readFileSync(storeFile(), 'utf8');
    const filesBefore = snapshotDir();
    const { data, text } = await callTool(client);
    for (const needle of ['/home/someone', 'abc123secret', 'api.example.com', 'sk-abcdefghijklmnop1234', workspace, otherWorkspace, 'workspaceFolder']) {
      assert.ok(!text.includes(needle), `leaked ${needle}`);
    }
    const byChat = Object.fromEntries(data.items.filter((i) => i.last_context).map((i) => [i.last_context.chat_id, i.last_context.same_workspace]));
    assert.deepEqual(byChat, { 'chat-same': true, 'chat-link': true, 'chat-other': false });
    assert.equal(data.items.find((i) => i.harness === 'opencode').last_context, null);
    assert.equal(fs.readFileSync(storeFile(), 'utf8'), before, 'store untouched');
    assert.deepEqual(snapshotDir(), filesBefore, 'no data-dir file created or modified');
  } finally { await client.close(); fs.rmSync(link, { force: true }); }
});

test('validation, limit clamp and since filter', async () => {
  for (let i = 0; i < 3; i += 1) fail('claude', `c${i}`, workspace, `distinct failure number ${'x'.repeat(i + 1)}`, `r${i}`);
  const { token } = createExternalMcpClient({ name: 'op', workspaceFolder: workspace, mode: 'operator' });
  const client = await connect(token);
  try {
    assert.equal((await callTool(client, { limit: 1 })).data.items.length, 1);
    assert.equal((await callTool(client, { limit: 100000 })).data.items.length, 3);
    assert.equal((await callTool(client, { since: '2999-01-01T00:00:00Z' })).data.items.length, 0);
    assert.equal((await callTool(client, { since: '2000-01-01T00:00:00Z' })).data.items.length, 3);
    for (const bad of [{ since: 'nope' }, { limit: 0 }, { limit: 'abc' }]) {
      const { res, text } = await callTool(client, bad);
      assert.equal(res.isError, true);
      assert.match(text, /VALIDATION_ERROR/);
    }
  } finally { await client.close(); }
});

test('tool is absent in agent mode; HTTP API never exposes context', async () => {
  fail('claude', 'chat-api', workspace, 'api visible failure', 'r1');
  const agent = createExternalMcpClient({ name: 'ag', workspaceFolder: workspace, mode: 'agent' });
  const client = await connect(agent.token);
  try {
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'unclassified_errors'));
    const { res } = await callTool(client);
    assert.equal(res.isError, true);
  } finally { await client.close(); }
  const api = await fetch(`${baseUrl}/api/usage/unclassified-errors`);
  const body = await api.text();
  assert.match(body, /api visible failure/);
  assert.doesNotMatch(body, /lastContext|workspaceFolder|chat-api/);
});
