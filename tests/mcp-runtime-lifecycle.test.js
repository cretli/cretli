import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, updateMcpServer } from '../lib/mcp/mcp-service.js';
import {
  callTool,
  disposeConnection,
  disposeContext,
  disposeSessionConnections,
  listTools,
  mcpConnectionKey,
  resetMcpRuntimeForTests,
  testMcpServer,
} from '../lib/mcp/mcp-runtime.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';
import { listMcpStatuses, resetMcpStatusForTests } from '../lib/mcp/mcp-status.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-fixture-server.js');
process.env.CRETLI_MCP_CONNECT_TIMEOUT_MS = '8000';

const created = await createMcpServer({
  name: 'Life',
  enabled: true,
  harnesses: ['openrouter'],
  transport: 'stdio',
  connection: { command: process.execPath, args: [fixture] },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);
let server = normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === created.server.id);
const contextA = {
  harness: 'openrouter',
  sessionId: 'sess-a',
  workspaceFolder: '/tmp/mcp-a',
  mode: 'agent',
  revision: created.revision,
};
const contextB = {
  harness: 'openrouter',
  sessionId: 'sess-b',
  workspaceFolder: '/tmp/mcp-a',
  mode: 'agent',
  revision: created.revision,
};

assert.notEqual(mcpConnectionKey(contextA, server), mcpConnectionKey(contextB, server));

const toolsA = await listTools(contextA, server);
assert.ok(toolsA.some((tool) => tool.name === 'ping_read'));
const diagnostic = await testMcpServer(contextA, server);
assert.equal(diagnostic.ok, true);
const statuses = listMcpStatuses({ sessionId: 'sess-a' });
assert.ok(statuses.some((row) => row.source === 'session' && row.connectionState === 'connected'));
assert.ok(statuses.some((row) => row.source === 'diagnostic' && row.connectionState === 'tested'));

const delayCounter = path.join(os.tmpdir(), `mcp-delay-count-${process.pid}.txt`);
fs.writeFileSync(delayCounter, '0');
const delayedCreated = await createMcpServer({
  name: 'Delayed',
  enabled: true,
  harnesses: ['openrouter'],
  transport: 'stdio',
  connection: {
    command: process.execPath,
    args: [fixture],
    env: {
      MCP_CONNECT_DELAY_MS: '500',
      MCP_WRITE_COUNTER_FILE: delayCounter,
    },
  },
}, loadMcpDocument().revision);
const delayedServer = normalizeMcpServers(loadMcpDocument().servers)
  .find((row) => row.id === delayedCreated.server.id);
const liveContext = {
  harness: 'openrouter',
  sessionId: 'sess-delay',
  workspaceFolder: '/tmp/mcp-delay',
  mode: 'agent',
  getMode() {
    return liveContext.mode;
  },
};
const pendingWrite = callTool(liveContext, delayedServer, 'write_note', { text: 'late' });
await new Promise((resolve) => setTimeout(resolve, 80));
liveContext.mode = 'plan';
const delayedResult = await pendingWrite;
assert.equal(delayedResult.denied, true);
assert.equal(Number(fs.readFileSync(delayCounter, 'utf8') || '0'), 0);

const unknownCounter = path.join(os.tmpdir(), `mcp-unknown-mode-${process.pid}.txt`);
fs.writeFileSync(unknownCounter, '0');
const unknownCreated = await createMcpServer({
  name: 'UnknownMode',
  enabled: true,
  harnesses: ['openrouter'],
  transport: 'stdio',
  connection: {
    command: process.execPath,
    args: [fixture],
    env: {
      MCP_CONNECT_DELAY_MS: '500',
      MCP_WRITE_COUNTER_FILE: unknownCounter,
    },
  },
}, loadMcpDocument().revision);
const unknownServer = normalizeMcpServers(loadMcpDocument().servers)
  .find((row) => row.id === unknownCreated.server.id);
const unknownContext = {
  harness: 'openrouter',
  sessionId: 'sess-unknown-mode',
  workspaceFolder: '/tmp/mcp-unknown',
  mode: 'agent',
  getMode() {
    return unknownContext.mode;
  },
};
const pendingUnknown = callTool(unknownContext, unknownServer, 'write_note', { text: 'late' });
await new Promise((resolve) => setTimeout(resolve, 80));
unknownContext.mode = '';
const unknownResult = await pendingUnknown;
assert.equal(unknownResult.denied, true);
assert.equal(Number(fs.readFileSync(unknownCounter, 'utf8') || '0'), 0);

await updateMcpServer(created.server.id, {
  connection: { args: [fixture, '--noop'] },
}, loadMcpDocument().revision);
server = normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === created.server.id);
assert.notEqual(
  mcpConnectionKey(contextA, { ...server, connection: { command: process.execPath, args: [fixture] } }),
  mcpConnectionKey(contextA, server),
);

const hangServer = {
  id: 'hang',
  kind: 'external',
  enabled: true,
  transport: 'stdio',
  connection: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 100000)'] },
};
process.env.CRETLI_MCP_CONNECT_TIMEOUT_MS = '400';
const started = Date.now();
const hung = await testMcpServer({ ...contextA, sessionId: 'hang' }, hangServer);
assert.equal(hung.ok, false);
assert.ok(Date.now() - started < 8000);

const abort = new AbortController();
abort.abort();
const cancelled = await callTool(contextA, server, 'ping_read', { token: 'x' }, abort.signal);
assert.equal(cancelled.ok, false);

// Room teardown passes only the session key and cwd. A connection keyed with a
// workspace file must still be closed, or its stdio child outlives the room.
{
  const keyedContext = { ...contextA, sessionId: 'sess-leak', workspaceFile: '/tmp/mcp-a/app.code-workspace', workspaceId: 'ws-1' };
  await listTools(keyedContext, server);
  const teardownContext = { sessionId: 'sess-leak', workspaceFolder: '/tmp/mcp-a' };
  await disposeContext(teardownContext, [server]);
  assert.ok(
    listMcpStatuses({ sessionId: 'sess-leak' }).some((row) => row.connectionState === 'connected'),
    'exact isolation match does not see the keyed connection',
  );
  assert.equal(await disposeSessionConnections('sess-leak'), 1);
  assert.equal(await disposeSessionConnections('sess-leak'), 0);
  assert.equal(await disposeSessionConnections(''), 0);
}

// Teardown racing a connect: the client is not in the pool yet, so the connect
// itself must notice the cancellation and close instead of registering.
{
  const racingContext = { ...contextA, sessionId: 'sess-race' };
  const racing = listTools(racingContext, server).then(() => 'connected', () => 'rejected');
  assert.equal(await disposeSessionConnections('sess-race'), 1);
  assert.equal(await racing, 'rejected');
  assert.ok(
    !listMcpStatuses({ sessionId: 'sess-race' }).some((row) => row.connectionState === 'connected'),
    'a cancelled connect must not leave a pooled client behind',
  );
  assert.equal(await disposeSessionConnections('sess-race'), 0);
}

await disposeContext(liveContext, [delayedServer]);
await disposeContext(unknownContext, [unknownServer]);
await disposeContext(contextA, [server]);
await disposeContext(contextB, [server]);
await disposeConnection(mcpConnectionKey(contextA, server));
await resetMcpRuntimeForTests();
resetMcpStatusForTests();
removeIsolatedDataDir();
console.log('mcp-runtime-lifecycle.test.js OK');
