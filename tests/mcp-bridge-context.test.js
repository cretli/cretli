import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMcpServer, updateMcpServer } from '../lib/mcp/mcp-service.js';
import { addChatAsync } from '../lib/persist/chats-persist.js';
import { getChatByIdAsync } from '../lib/persist/chats-persist.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { mintMcpIntegrationToken, verifyMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  revokeMcpExecutionContext,
  resetMcpExecutionRegistryForTests,
} from '../lib/mcp/mcp-execution-registry.js';
import {
  buildMcpRuntimeContext,
  buildManagedBridgeStdio,
  resolveAuthorizedMcpContext,
} from '../lib/mcp/mcp-session.js';
import { encodeMcpToolName } from '../lib/mcp/mcp-tool-names.js';
import { resetMcpRuntimeForTests } from '../lib/mcp/mcp-runtime.js';
import { requireAuth, setPassword } from '../lib/auth.js';
import { mapBridgeToolResult } from '../scripts/cretli-mcp.js';

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
assert.equal((await resolveAuthorizedMcpContext({
  sessionId: runtime.sessionId,
  chatId: runtime.chatId,
  harness: 'sdk',
  incarnation: snapshot.incarnation,
})).mode, 'agent');
room.sdkMode = 'plan';
chat.sdkMode = 'plan';
assert.equal(runtime.getMode(), 'plan');

revokeMcpExecutionContext(runtime);
rememberMcpExecutionContext(runtime);
const restored = lookupMcpExecutionContext(runtime);
assert.notEqual(restored.incarnation, snapshot.incarnation);
let oldTokenRejected = false;
try {
  await resolveAuthorizedMcpContext({
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

const automaticExternal = await createMcpServer({
  name: 'Automatic fixture', enabled: true, availableToAutomaticAgents: true,
  harnesses: ['sdk'], scope: 'all', transport: 'stdio', connection: { command: process.execPath, args: [fixture] },
}, 1);
const autoChat = await addChatAsync('sess-auto', '[Delegation] automatic test', '', '/tmp/mcp-bridge', '', {
  agentTransport: 'sdk', delegationId: 'delegation-test', delegationAssignment: 'implement',
});
const autoRoom = { sessionKey: 'sess-auto', chatId: autoChat.id, transport: 'sdk', sdkMode: 'agent' };
const autoRuntime = buildMcpRuntimeContext({ chat: autoChat, room: autoRoom, harness: 'sdk', mode: 'agent' });
rememberMcpExecutionContext(autoRuntime);
const autoBridge = buildManagedBridgeStdio(autoRuntime);
const autoTokenClaims = verifyMcpIntegrationToken(autoBridge.env.CRETLI_MCP_TOKEN);
assert.equal(autoTokenClaims.automaticMcpPolicy, 'allowlist');
const authorizedAutoContext = resolveAuthorizedMcpContext(autoTokenClaims);
assert.equal(authorizedAutoContext.automaticMcpPolicy, 'allowlist');
const legacyClaims = { ...autoTokenClaims };
delete legacyClaims.automaticMcpPolicy;
const unconfirmedAutoContext = resolveAuthorizedMcpContext(legacyClaims);
assert.equal(unconfirmedAutoContext.automaticMcpPolicy, 'allowlist', 'missing policy claims fail closed for a delegated session');
const autoToken = autoBridge.env.CRETLI_MCP_TOKEN;
const allowedAutoName = encodeMcpToolName(automaticExternal.server.id, 'ping_read');
const autoCatalogRes = await fetch(`http://127.0.0.1:${port}/api/mcp/bridge/tools`, { headers: { Authorization: `Bearer ${autoToken}` } });
const autoCatalog = await autoCatalogRes.json();
assert.ok(autoCatalog.tools.some((tool) => tool.name === allowedAutoName));
const allowedAutoCall = await callBridge(allowedAutoName, { token: 'allowed' }, {}, autoToken);
assert.equal(allowedAutoCall.json.ok, true);
const deniedAutoCall = await callBridge(readName, { token: 'hidden' }, {}, autoToken);
assert.match(deniedAutoCall.json.error, /not available to automatic agents/i);
const scoutChat = await addChatAsync('sess-scout', 'Scout', '', '/tmp/mcp-bridge', '', { agentTransport: 'sdk', pickPurpose: 'scout', readOnlyScout: true });
const scoutContext = buildMcpRuntimeContext({ chat: scoutChat, room: { sessionKey: 'sess-scout', chatId: scoutChat.id, transport: 'sdk' }, harness: 'sdk' });
rememberMcpExecutionContext(scoutContext);
const scoutBridge = buildManagedBridgeStdio(scoutContext);
const scoutToken = scoutBridge.env.CRETLI_MCP_TOKEN;
const scoutCatalogRes = await fetch(`http://127.0.0.1:${port}/api/mcp/bridge/tools`, { headers: { Authorization: `Bearer ${scoutToken}` } });
const scoutCatalog = await scoutCatalogRes.json();
assert.equal(scoutCatalog.tools.some((tool) => tool.name === readName), false);
const scoutDenied = await callBridge(readName, { token: 'hidden' }, {}, scoutToken);
assert.match(scoutDenied.json.error, /not available to automatic agents/i);
const renamedScout = { ...(await getChatByIdAsync(scoutChat.id)), title: 'A normal-looking title', pickPurpose: 'scout' };
const renamedScoutContext = buildMcpRuntimeContext({ chat: renamedScout, room: { chatId: scoutChat.id }, harness: 'sdk' });
assert.equal(renamedScoutContext.automaticMcpPolicy, 'allowlist');

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

// Tool-result compression: the server flag alone decides; the stdio bridge env is irrelevant.
const bigToken = 'same line\n'.repeat(1500);
const savedBridgeFlag = process.env.CRETLI_TOOL_RESULT_COMPRESSION;
try {
  for (const serverOn of [false, true]) {
    for (const bridgeEnv of [undefined, '1']) {
      // The server and the bridge share this test process; the bridge no longer reads the env at all.
      if (serverOn) process.env.CRETLI_TOOL_RESULT_COMPRESSION = '1';
      else delete process.env.CRETLI_TOOL_RESULT_COMPRESSION;
      const routed = await callBridge(readName, { token: bigToken });
      assert.equal(routed.json.compressed, serverOn, `route compressed flag, server ${serverOn}`);
      if (serverOn) delete process.env.CRETLI_TOOL_RESULT_COMPRESSION;
      if (bridgeEnv) process.env.CRETLI_TOOL_RESULT_COMPRESSION = bridgeEnv;
      const mapped = mapBridgeToolResult(routed.json);
      const text = mapped.content[0].text;
      if (serverOn) {
        assert.match(text, /^\[full tool result: [a-f0-9]{64}/, `compressed for model, bridge env ${bridgeEnv}`);
      } else {
        assert.ok(!text.startsWith('[full tool result: '), 'no marker when the server is OFF');
        assert.ok(text.includes(bigToken.slice(0, 200)), 'full content when the server is OFF');
      }
    }
  }
} finally {
  if (savedBridgeFlag === undefined) delete process.env.CRETLI_TOOL_RESULT_COMPRESSION;
  else process.env.CRETLI_TOOL_RESULT_COMPRESSION = savedBridgeFlag;
}

// A server-supplied `raw.compressed: true` must not leak into the route response.
const spoofed = await callBridge(readName, { token: '__spoof__' });
assert.equal(spoofed.json.compressed, false);
assert.equal(mapBridgeToolResult(spoofed.json).content[0].text, 'pong:__spoof__');

// A marker-looking text without `compressed: true` is treated as raw content.
const markerLike = { ok: true, output: '[full tool result: abc]\nx', content: [{ type: 'text', text: 'exact raw' }] };
assert.strictEqual(mapBridgeToolResult(markerLike), markerLike);
assert.equal(mapBridgeToolResult({ ok: true, output: markerLike.output, compressed: true }).content[0].text, markerLike.output);

revokeMcpExecutionContext(runtime);
const gone = await callBridge(writeName, { text: 'gone' });
assert.equal(gone.status, 403);
assert.equal(writeCount(), 1);

rememberMcpExecutionContext(runtime);
const afterDisableToken = mintMcpIntegrationToken({
  ...runtime,
  incarnation: lookupMcpExecutionContext(runtime).incarnation,
});
await updateMcpServer(created.server.id, { enabled: false }, automaticExternal.revision);
const disabled = await callBridge(writeName, { text: 'off' }, {}, afterDisableToken);
assert.equal(disabled.json.ok, false);
assert.ok(disabled.status === 400 || /not active|disabled|Unknown MCP tool/i.test(String(disabled.json.error || '')));
assert.equal(writeCount(), 1);

server.close();
resetMcpExecutionRegistryForTests();
await resetMcpRuntimeForTests();
removeIsolatedDataDir();
console.log('mcp-bridge-context.test.js OK');
