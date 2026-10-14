/**
 * A client that drops the connection after the request body was received must
 * not cancel a bridge `delegation_verify` run: the run finishes and its result
 * is recorded on the delegation.
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { CretliApiClient, BRIDGE_VERIFY_TIMEOUT_MS } from '../lib/remote-api-client.js';
import { MCP_CRETILI_BRIDGE_PREFIX } from '../lib/mcp/mcp-tool-names.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { executeTool } from '../lib/agent-harness/tool-executor.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  resetMcpExecutionRegistryForTests,
} from '../lib/mcp/mcp-execution-registry.js';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { resetMcpRuntimeForTests } from '../lib/mcp/mcp-runtime.js';
import { requireAuth, setPassword } from '../lib/auth.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { REVIEW_VERIFY_IDS, isReviewVerifyInFlight } from '../lib/sdk/sdk-review-verify.js';

setPassword('test-password-123');
resetMcpExecutionRegistryForTests();
await resetMcpRuntimeForTests();

const repoRoot = path.resolve(import.meta.dirname, '..');
const workspace = mkdtempSync(path.join(os.tmpdir(), 'verify-disconnect-'));
const chat = addChat('verify-disc-sess', 'Verify disconnect', null, workspace, 'm', {
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
const room = { sessionKey: 'verify-disc-sess', chatId: chat.id, cwd: workspace, sdkMode: 'agent', transport: 'sdk' };
const runtime = buildMcpRuntimeContext({ chat, room, harness: 'sdk', mode: 'agent' });
rememberMcpExecutionContext(runtime);
const token = mintMcpIntegrationToken({ ...runtime, incarnation: lookupMcpExecutionContext(runtime).incarnation });

const delegation = createDelegationRecord({
  parentChatId: chat.id,
  executor: { transport: 'opencode', model: 'm' },
  assignment: 'implement',
  executionMode: 'agent',
  executionFolder: repoRoot,
  workspaceFolder: workspace,
});

const app = express();
let bodyReceived;
const received = new Promise((resolve) => { bodyReceived = resolve; });
app.use(express.json());
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/mcp/bridge/call') bodyReceived(req.body);
  next();
});
app.use((req, res, next) => requireAuth(req, res, next));
registerMcpRoutes(app);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();

const body = JSON.stringify({
  name: 'mcp__cretli_builtincretl__delegation_verify',
  arguments: { delegation_id: delegation.id, ids: [REVIEW_VERIFY_IDS[0]] },
});
await new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/mcp/bridge/call',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {});
  received.then((parsed) => {
    assert.equal(parsed.arguments.delegation_id, delegation.id);
    req.destroy();
    resolve();
  }, reject);
  req.end(body);
  setTimeout(() => reject(new Error('write timeout')), 5000).unref();
});

const deadline = Date.now() + 120000;
let record = getDelegationById(delegation.id);
while (!record?.verifyResult && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  record = getDelegationById(delegation.id);
}
assert.ok(record.verifyResult, 'verify result recorded after the client disconnected');
assert.equal(record.verifyResult.source, 'delegation_verify');
assert.equal(isReviewVerifyInFlight({ projectRoot: repoRoot }), false);

// Exercise the real tools endpoint, then observe the budgets on actual client requests.
const client = new CretliApiClient({ baseUrl: `http://127.0.0.1:${port}`, bearerToken: token });
const listed = await client.getMcpBridgeTools();
const entry = listed.tools.find((tool) => tool.name.endsWith('__delegation_verify') && tool._serverId === 'builtin-cretli');
assert.ok(entry, 'builtin verify name comes from the tools route');
const timeouts = [];
const originalTimeout = http.ClientRequest.prototype.setTimeout;
http.ClientRequest.prototype.setTimeout = function observeTimeout(ms, ...rest) {
  timeouts.push(ms);
  return originalTimeout.call(this, ms, ...rest);
};
try {
  for (const name of [entry.name, entry.name.slice('mcp__'.length)]) {
    await client.callMcpBridgeTool(name, { delegation_id: delegation.id, ids: [REVIEW_VERIFY_IDS[0]] });
    assert.equal(timeouts.pop(), BRIDGE_VERIFY_TIMEOUT_MS);
  }
  // A harness must strip its outer prefix before sending a name to stdio.
  const wrapped = `${MCP_CRETILI_BRIDGE_PREFIX}${entry.name}`;
  await assert.rejects(client.callMcpBridgeTool(wrapped, {}), (error) => error.status === 400);
  assert.equal(timeouts.pop(), 30000);
  assert.equal(wrapped.slice(MCP_CRETILI_BRIDGE_PREFIX.length), entry.name);
  for (const name of ['mcp__cretli_builtincretl__delegation_show', 'mcp__external__delegation_verify']) {
    await client.callMcpBridgeTool(name, {}).catch(() => {});
    assert.equal(timeouts.pop(), 30000);
  }
} finally {
  http.ClientRequest.prototype.setTimeout = originalTimeout;
}

// Both production call paths join one run and persist its shared dataDir independently.
const secondDelegation = createDelegationRecord({
  parentChatId: chat.id, executor: { transport: 'opencode', model: 'm' },
  assignment: 'review', executionMode: 'agent', executionFolder: repoRoot, workspaceFolder: workspace,
});
const context = {
  client: { getDelegation: async ({ delegationId }) => getDelegationById(delegationId) },
  session: { chatId: chat.id, workspaceFolder: workspace },
};
const verify = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_verify');
const show = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_show');
const harnessRun = executeTool('run_terminal_command', {
  command: `node scripts/review-verify.js ${REVIEW_VERIFY_IDS[0]}`,
}, {
  cwd: repoRoot, mode: 'agent', assignment: 'review',
  delegationId: secondDelegation.id, attemptId: secondDelegation.attemptId,
});
const bridgeRun = verify.handler({ delegation_id: delegation.id, ids: [REVIEW_VERIFY_IDS[0]] }, context);
const during = await show.handler({ delegation_id: delegation.id }, context);
assert.equal(during.structuredContent.verify_running, true);
assert.equal(during.structuredContent.verify_recorded, true);
const [harnessResult, bridgeResult] = await Promise.all([harnessRun, bridgeRun]);
assert.equal(harnessResult.ok, true);
assert.equal(bridgeResult.structuredContent.verify_result.status, 'passed');
const firstRecord = getDelegationById(delegation.id);
const secondRecord = getDelegationById(secondDelegation.id);
assert.equal(firstRecord.verifyResult.dataDir, secondRecord.verifyResult.dataDir);
assert.ok(existsSync(secondRecord.verifyResult.dataDir));
const recorded = await show.handler({ delegation_id: secondDelegation.id }, context);
assert.equal(recorded.structuredContent.verify_recorded, true);
assert.match(recorded.content[0].text, /verify_recorded=true verify_running=false/);
updateDelegationRecord(secondDelegation.id, { attemptId: 'reset-attempt', verifyResult: null });
const reset = await show.handler({ delegation_id: secondDelegation.id }, context);
assert.equal(reset.structuredContent.verify_recorded, false);
assert.match(reset.content[0].text, /verify_recorded=false verify_running=false/);
assert.equal(isReviewVerifyInFlight({ projectRoot: repoRoot }), false);

await new Promise((resolve) => server.close(resolve));
rmSync(workspace, { recursive: true, force: true });
removeIsolatedDataDir();
