import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  resetMcpExecutionRegistryForTests,
} from '../lib/mcp/mcp-execution-registry.js';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { encodeMcpToolName } from '../lib/mcp/mcp-tool-names.js';
import { resetMcpRuntimeForTests } from '../lib/mcp/mcp-runtime.js';
import { BUILTIN_CRETILI_SERVER_ID } from '../lib/mcp/mcp-config.js';
import { requireAuth, setPassword } from '../lib/auth.js';
import { installWidgetApiGate } from '../lib/widget/widget-http.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';

setPassword('test-password-123');
resetMcpExecutionRegistryForTests();
await resetMcpRuntimeForTests();

const workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-todo-'));
mkdirSync(workspace, { recursive: true });
const chat = addChat('bridge-sess', 'Bridge chat', null, workspace, 'm', {
  agentTransport: 'sdk',
  sdkMode: 'agent',
});
setBuiltinMcpRuntimeDeps({
  dataDir: resolveDataPath(),
  taskRuns: new Map(),
  agentRuns: new Map(),
  loadTasksForWorkspace: () => ({ tasks: [] }),
  workspaceDirForAgent: () => '',
});

const room = {
  sessionKey: 'bridge-sess',
  chatId: chat.id,
  cwd: workspace,
  sdkMode: 'agent',
  transport: 'sdk',
};
const runtime = buildMcpRuntimeContext({
  chat,
  room,
  harness: 'sdk',
  mode: room.sdkMode,
});
rememberMcpExecutionContext(runtime);
const token = mintMcpIntegrationToken({
  ...runtime,
  incarnation: lookupMcpExecutionContext(runtime).incarnation,
});

const app = express();
app.use(express.json());
app.use((req, res, next) => requireAuth(req, res, next));
installWidgetApiGate(app);
registerMcpRoutes(app);
registerTodosRoutes(app, {
  dataDir: resolveDataPath(),
  getCurrentCwd: () => '/tmp/global-ui-cwd-should-not-be-used',
  getCurrentWorkspaceFile: () => null,
  agentModel: '',
  getLocalCallbackBaseUrl: () => 'http://127.0.0.1',
  useHttps: false,
});
const httpServer = await new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const port = httpServer.address().port;
const root = path.dirname(fileURLToPath(import.meta.url));

const deniedTodos = await fetch(`http://127.0.0.1:${port}/api/todos`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.equal(deniedTodos.status, 403);

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

const chunks = [];
const listed = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('stdio timeout')), 8000);
  child.stdout.on('data', (buf) => {
    chunks.push(buf.toString('utf8'));
    const lines = chunks.join('').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === 2) {
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {
        // wait
      }
    }
  });
  child.stderr.on('data', () => {});
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
});
assert.ok(listed.result.tools.some((tool) => String(tool.name).includes('todo_list')));

const toolName = encodeMcpToolName(BUILTIN_CRETILI_SERVER_ID, 'todo_create');
const created = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('call timeout')), 8000);
  child.stdout.on('data', (buf) => {
    chunks.push(buf.toString('utf8'));
    const lines = chunks.join('').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === 3) {
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {
        // wait
      }
    }
  });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: { title: 'From bridge', idempotency_key: 'bridge-1' },
    },
  });
});
assert.equal(created.result.isError, false);
assert.ok(created.result.structuredContent?.item?.id, JSON.stringify(created.result));
assert.match(created.result.content[0].text, /Created TODO/);

child.kill();
httpServer.close();
resetMcpExecutionRegistryForTests();
removeIsolatedDataDir();
console.log('mcp-builtin-bridge.test.js OK');
