import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMcpServer, updateMcpServer } from '../lib/mcp/mcp-service.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  revokeMcpExecutionContext,
  resetMcpExecutionRegistryForTests,
} from '../lib/mcp/mcp-execution-registry.js';
import {
  buildMcpRuntimeContext,
  resolveAuthorizedMcpContext,
} from '../lib/mcp/mcp-session.js';
import { encodeMcpToolName } from '../lib/mcp/mcp-tool-names.js';
import { resetMcpRuntimeForTests } from '../lib/mcp/mcp-runtime.js';
import { requireAuth, setPassword } from '../lib/auth.js';

setPassword('test-password-123');

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-fixture-server.js');
const counterFile = path.join(os.tmpdir(), `mcp-write-count-${process.pid}.txt`);
fs.writeFileSync(counterFile, '0');

const created = await createMcpServer({
  name: 'Fixture',
  enabled: true,
  harnesses: ['sdk', 'qwen', 'codebuddy'],
  scope: 'all',
  transport: 'stdio',
  connection: {
    command: process.execPath,
    args: [fixture],
    env: { MCP_WRITE_COUNTER_FILE: counterFile },
  },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);

resetMcpExecutionRegistryForTests();
await resetMcpRuntimeForTests();

const room = {
  sessionKey: 'sess-plan-1',
  chatId: 'chat-plan-1',
  cwd: '/tmp/mcp-bridge',
  sdkMode: 'plan',
  transport: 'sdk',
};
const chat = {
  id: 'chat-plan-1',
  cursorSessionId: 'sess-plan-1',
  workspaceFolder: '/tmp/mcp-bridge',
  agentTransport: 'sdk',
  sdkMode: 'plan',
};
const runtime = buildMcpRuntimeContext({
  chat,
  room,
  harness: 'sdk',
  mode: room.sdkMode,
});
rememberMcpExecutionContext(runtime);
const snapshot = lookupMcpExecutionContext(runtime);
assert.ok(snapshot?.incarnation);
const token = mintMcpIntegrationToken({
  ...runtime,
  incarnation: snapshot.incarnation,
});

room.sdkMode = 'agent';
chat.sdkMode = 'agent';
assert.equal(resolveAuthorizedMcpContext({
  sessionId: runtime.sessionId,
  chatId: runtime.chatId,
  harness: 'sdk',
  incarnation: snapshot.incarnation,
}).mode, 'agent');
room.sdkMode = 'plan';
chat.sdkMode = 'plan';
assert.equal(runtime.getMode(), 'plan');

revokeMcpExecutionContext(runtime);
rememberMcpExecutionContext(runtime);
const restored = lookupMcpExecutionContext(runtime);
assert.notEqual(restored.incarnation, snapshot.incarnation);
let oldTokenRejected = false;
try {
  resolveAuthorizedMcpContext({
    sessionId: runtime.sessionId,
    chatId: runtime.chatId,
    harness: 'sdk',
    incarnation: snapshot.incarnation,
  });
} catch (err) {
  oldTokenRejected = err.code === 'MCP_AUTHZ';
}
assert.equal(oldTokenRejected, true);

const app = express();
app.use(express.json());
app.use((req, res, next) => requireAuth(req, res, next));
registerMcpRoutes(app);

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const server = await listen();
const port = server.address().port;
const liveToken = mintMcpIntegrationToken({
  ...runtime,
  incarnation: restored.incarnation,
});

async function callBridge(name, args, extraBody = {}, bearer = liveToken) {
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp/bridge/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, arguments: args, ...extraBody }),
  });
  return { status: res.status, json: await res.json() };
}

function writeCount() {
  return Number(fs.readFileSync(counterFile, 'utf8') || '0');
}

const writeName = encodeMcpToolName(created.server.id, 'write_note');
const readName = encodeMcpToolName(created.server.id, 'ping_read');

const unauth = await callBridge(writeName, { text: 'x' }, {}, 'not-a-token');
assert.equal(unauth.status, 401);

const oldTokenHttp = await callBridge(writeName, { text: 'x' }, {}, token);
assert.equal(oldTokenHttp.status, 403);

const deniedNoMode = await callBridge(writeName, { text: 'nope' });
assert.equal(deniedNoMode.json.denied, true);
assert.equal(writeCount(), 0);

const deniedSpoof = await callBridge(writeName, { text: 'nope' }, { mode: 'agent' });
assert.equal(deniedSpoof.json.denied, true);
assert.equal(writeCount(), 0);

const listed = await fetch(`http://127.0.0.1:${port}/api/mcp/bridge/tools`, {
  headers: { Authorization: `Bearer ${liveToken}` },
});
const catalog = await listed.json();
assert.ok(catalog.tools.some((tool) => String(tool.name).endsWith('chat_show')));
assert.ok(catalog.tools.some((tool) => String(tool.name).endsWith('ping_read')));

room.sdkMode = 'agent';
const allowedWrite = await callBridge(writeName, { text: 'ok' });
assert.equal(allowedWrite.json.ok, true);
assert.equal(writeCount(), 1);

room.sdkMode = 'plan';
const deniedAgain = await callBridge(writeName, { text: 'again' });
assert.equal(deniedAgain.json.denied, true);
assert.equal(writeCount(), 1);

const planRead = await callBridge(readName, { token: 'plan' });
assert.equal(planRead.json.ok, true);

revokeMcpExecutionContext(runtime);
const gone = await callBridge(writeName, { text: 'gone' });
assert.equal(gone.status, 403);
assert.equal(writeCount(), 1);

rememberMcpExecutionContext(runtime);
const afterDisableToken = mintMcpIntegrationToken({
  ...runtime,
  incarnation: lookupMcpExecutionContext(runtime).incarnation,
});
await updateMcpServer(created.server.id, { enabled: false }, created.revision);
const disabled = await callBridge(writeName, { text: 'off' }, {}, afterDisableToken);
assert.equal(disabled.json.ok, false);
assert.ok(disabled.status === 400 || /not active|disabled|Unknown MCP tool/i.test(String(disabled.json.error || '')));
assert.equal(writeCount(), 1);

server.close();
resetMcpExecutionRegistryForTests();
await resetMcpRuntimeForTests();
removeIsolatedDataDir();
console.log('mcp-bridge-context.test.js OK');
