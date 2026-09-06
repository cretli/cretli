import { removeIsolatedDataDir, ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireAuth, setPassword } from '../lib/auth.js';
import { registerAuthRoutes } from '../lib/routes/auth-routes.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { registerHarnessCatalogRoutes } from '../lib/routes/harness-catalog-routes.js';
import { loadTodosData } from '../lib/persist/todos-persist.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile } from '../lib/chat-plan-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';

setPassword('stdio-plan-password');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-ws-'));
const foreignDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-foreign-'));
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/cretli-mcp.js');

setBuiltinMcpRuntimeDeps({
  dataDir: resolveDataPath(),
  taskRuns: new Map(),
  agentRuns: new Map(),
  loadTasksForWorkspace: () => ({ tasks: [] }),
  workspaceDirForAgent: () => workspace,
});

const chat = addChat('stdio-plan-sess', 'Stdio remote chat', null, workspace, 'm', {
  agentTransport: 'opencode',
  sdkMode: 'plan',
});
writeChatPlanFile({
  cwd: workspace,
  chatId: chat.id,
  title: 'Remote plan',
  markdown: '# Remote plan\n\n- read me from the server',
  sourceTurnId: 'stdio-plan',
});
const seededDelegation = createDelegationRecord({
  parentChatId: chat.id,
  workspaceFolder: workspace,
  planRevision: 1,
  planMarkdown: '# Remote plan\n\n- read me from the server',
  status: 'finished',
  executor: { transport: 'opencode', model: 'opencode/test' },
});
updateDelegationRecord(seededDelegation.id, {
  report: 'Remote delegation report from the server instance.',
  status: 'finished',
});

const app = express();
app.use(express.json());
registerAuthRoutes(app, {
  useHttps: false,
  buildWidgetAuthorizationPayload: () => ({}),
  isWidgetAuthRequest: () => false,
  parseWidgetAuthParams: () => null,
});
app.use((req, res, next) => requireAuth(req, res, next));
registerHarnessCatalogRoutes(app);
registerChatsRoutes(app, {
  widgetChatListScope: () => true,
  dataDir: resolveDataPath(),
  agentSessions: new Map(),
  getCurrentAgentRunResumeId: () => '',
  setCurrentAgentRunResumeId: () => {},
  agentCmd: '',
  agentModel: '',
  workspaceDirForAgent: () => workspace,
  getCurrentWorkspaceFile: () => null,
  getCurrentCwd: () => workspace,
  buildAgentSpawnEnv: () => ({}),
});
registerDelegationsRoutes(app, {
  workspaceDirForAgent: () => workspace,
  dataDir: resolveDataPath(),
});
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
const baseUrl = `http://127.0.0.1:${port}`;

function spawnStdio(mode) {
  return spawn(process.execPath, [script], {
    env: {
      ...process.env,
      CRETLI_URL: baseUrl,
      CRETLI_CLI_PASSWORD: 'stdio-plan-password',
      CRETLI_MCP_TOKEN: '',
      CRETLI_INSECURE_TLS: '1',
      CRETLI_MCP_NEWLINE: '1',
      CRETLI_MCP_WORKSPACE: workspace,
      CRETLI_MCP_CHAT_ID: chat.id,
      CRETLI_MCP_MODE: mode,
      CRETLI_DATA_DIR: foreignDataDir,
      CURSOR_REMOTE_DATA_DIR: foreignDataDir,
      CRETLI_TEST_DATA_DIR: foreignDataDir,
      CURSOR_REMOTE_TEST_DATA_DIR: foreignDataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function callTool(child, id, name, args) {
  const replies = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio timeout waiting for ${id}`)), 8000);
    let buffer = '';
    const onData = (chunk) => {
      buffer += String(chunk);
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('{')) replies.push(JSON.parse(line));
        nl = buffer.indexOf('\n');
      }
      if (replies.some((row) => row.id === id)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
  });
  return replies.find((row) => row.id === id);
}

const planChild = spawnStdio('plan');
const planReply = await callTool(planChild, 1, 'todo_create', {
  title: 'should not persist',
  idempotency_key: 'stdio-plan-todo',
});
assert.equal(planReply.result.isError, true);
assert.match(planReply.result.content[0].text, /PLAN_MODE_DENIED/);
planChild.kill('SIGKILL');

const serverTodos = loadTodosData(ISOLATED_DATA_DIR, workspace);
assert.equal((serverTodos.items || []).length, 0);
assert.equal(fs.existsSync(path.join(foreignDataDir, 'todos')), false);

const agentChild = spawnStdio('agent');
const agentReply = await callTool(agentChild, 2, 'todo_create', {
  title: 'created remotely',
  idempotency_key: 'stdio-agent-todo',
});
assert.equal(agentReply.result.isError, false);
assert.match(agentReply.result.content[0].text, /Created TODO/);
agentChild.kill('SIGKILL');

const afterAgent = loadTodosData(ISOLATED_DATA_DIR, workspace);
assert.equal((afterAgent.items || []).length, 1);
assert.equal(afterAgent.items[0].title, 'created remotely');
assert.equal(fs.existsSync(path.join(foreignDataDir, 'todos')), false);

const reader = spawnStdio('plan');
const planShown = await callTool(reader, 3, 'chat_plan_show', {});
assert.equal(planShown.result.isError, false);
assert.match(planShown.result.content[0].text, /read me from the server/);
const delegationShown = await callTool(reader, 4, 'delegation_show', {
  delegation_id: seededDelegation.id,
});
assert.equal(delegationShown.result.isError, false);
assert.match(delegationShown.result.content[0].text, /Remote delegation report from the server instance/);
const planStart = await callTool(reader, 5, 'delegation_start', {
  plan_revision: 1,
  harness: 'opencode',
  model: 'opencode/test',
  idempotency_key: 'stdio-plan-start',
});
assert.equal(planStart.result.isError, true);
assert.match(planStart.result.content[0].text, /PLAN_MODE_DENIED/);
const planDelegationReply = await callTool(reader, 6, 'delegation_reply', {
  message_text: 'nope',
  idempotency_key: 'stdio-plan-reply',
});
assert.equal(planDelegationReply.result.isError, true);
assert.match(planDelegationReply.result.content[0].text, /PLAN_MODE_DENIED/);
reader.kill('SIGKILL');
assert.equal(fs.existsSync(path.join(foreignDataDir, 'chats.json')), false);
assert.equal(fs.existsSync(path.join(foreignDataDir, 'delegations.json')), false);

httpServer.close();
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(foreignDataDir, { recursive: true, force: true });
removeIsolatedDataDir();
console.log('mcp-stdio-plan-policy.test.js OK');
