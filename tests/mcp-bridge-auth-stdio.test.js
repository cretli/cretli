import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  resetMcpExecutionRegistryForTests,
} from '../lib/mcp/mcp-execution-registry.js';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { encodeMcpToolName } from '../lib/mcp/mcp-tool-names.js';
import { requireAuth, setPassword } from '../lib/auth.js';

setPassword('test-password-123');
const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, 'helpers/mcp-fixture-server.js');
const counterFile = path.join(os.tmpdir(), `mcp-stdio-count-${process.pid}.txt`);
fs.writeFileSync(counterFile, '0');

const created = await createMcpServer({
  name: 'Stdio',
  enabled: true,
  harnesses: ['sdk'],
  transport: 'stdio',
  connection: {
    command: process.execPath,
    args: [fixture],
    env: { MCP_WRITE_COUNTER_FILE: counterFile },
  },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);

resetMcpExecutionRegistryForTests();
const room = {
  sessionKey: 'stdio-sess',
  chatId: 'stdio-chat',
  cwd: '/tmp/mcp-stdio',
  sdkMode: 'plan',
};
const chat = {
  id: 'stdio-chat',
  cursorSessionId: 'stdio-sess',
  workspaceFolder: '/tmp/mcp-stdio',
  agentTransport: 'sdk',
  sdkMode: 'plan',
};
const runtime = buildMcpRuntimeContext({ chat, room, harness: 'sdk', mode: room.sdkMode });
rememberMcpExecutionContext(runtime);
const token = mintMcpIntegrationToken({
  ...runtime,
  incarnation: lookupMcpExecutionContext(runtime).incarnation,
});

const app = express();
app.use(express.json());
app.use((req, res, next) => requireAuth(req, res, next));
registerMcpRoutes(app);
const httpServer = await new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const port = httpServer.address().port;
const writeName = encodeMcpToolName(created.server.id, 'write_note');

const child = spawn(process.execPath, [path.join(root, '../scripts/cretli-mcp.js'), '--bridge'], {
  env: {
    ...process.env,
    CRETLI_URL: `http://127.0.0.1:${port}`,
    CRETLI_MCP_TOKEN: token,
    CRETLI_INSECURE_TLS: '1',
    CRETLI_MCP_NEWLINE: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const replies = [];
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('stdio bridge timeout')), 8000);
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('{')) replies.push(JSON.parse(line));
      nl = buffer.indexOf('\n');
    }
    if (replies.some((row) => row.id === 2)) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on('data', () => {});
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: writeName, arguments: { text: 'nope' } } });
});

const callReply = replies.find((row) => row.id === 2);
assert.ok(callReply?.result);
const text = JSON.stringify(callReply.result);
assert.match(text, /Plan mode blocked|denied/i);
assert.equal(Number(fs.readFileSync(counterFile, 'utf8') || '0'), 0);

child.kill('SIGKILL');
httpServer.close();
resetMcpExecutionRegistryForTests();
removeIsolatedDataDir();
console.log('mcp-bridge-auth-stdio.test.js OK');
