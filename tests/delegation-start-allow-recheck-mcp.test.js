/**
 * MCP delegation_start forwards the explicit `allow_recheck` override to the
 * client exactly like the REST route, defaulting to false.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { inspectReviewRecheckWithoutChange } from '../lib/delegation-review-recheck-gate.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { registerMockChatRunAdapter } from '../lib/chat-run/mock-adapter.ts';
import { finishDelegation } from '../lib/delegation-service.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';

const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
assert.equal(startTool.inputSchema.properties.allow_recheck.type, 'boolean');
assert.equal(startTool.inputSchema.properties.allowRecheck.type, 'boolean');

const captured = [];
const session = { chatId: 'chat-1', workspaceFolder: '/tmp/ws-mcp', mode: 'agent' };
const client = {
  async getChat() {
    return { id: 'chat-1', workspaceFolder: '/tmp/ws-mcp' };
  },
  async startDelegation(args) {
    captured.push(args);
    return {
      ok: true,
      delegation: {
        id: 'delegation-1',
        status: 'starting',
        assignment: 'implement',
        workRole: 'implement',
        executor: { transport: 'testfake', model: 'testfake/test' },
      },
    };
  },
};
const base = { task_text: 'do the thing', harness: 'testfake', model: 'testfake/test' };

await startTool.handler({ ...base, idempotency_key: 'rc-default' }, { client, session });
await startTool.handler({ ...base, idempotency_key: 'rc-snake', allow_recheck: true }, { client, session });
await startTool.handler({ ...base, idempotency_key: 'rc-camel', allowRecheck: true }, { client, session });
await startTool.handler({ ...base, idempotency_key: 'rc-string', allow_recheck: 'true' }, { client, session });
assert.deepEqual(captured.map((c) => c.allowRecheck), [false, true, true, false]);

// The gate short-circuits on the explicit flag (gate logic itself is untouched).
const gateBase = {
  reviewSubject: 'code',
  workRole: 'review',
  leafId: 'leaf-1',
  executorModel: 'testfake/test',
  delegations: [],
};
assert.equal(inspectReviewRecheckWithoutChange({ ...gateBase, allowRecheck: true }).ok, true);

// Exercise the actual in-process facade; a handler-only spy misses dropped flags.
registerMockChatRunAdapter('testfake');
setBuiltinMcpRuntimeDeps({ dataDir: ISOLATED_DATA_DIR, workspaceDirForAgent: () => ISOLATED_DATA_DIR });
const parent = addChat(crypto.randomUUID(), 'Recheck parent', null, ISOLATED_DATA_DIR, 'testfake/orchestrator', {
  agentTransport: 'testfake', sdkMode: 'agent',
});
const leafId = crypto.randomUUID();
const prior = createDelegationRecord({
  parentChatId: parent.id, childChatId: crypto.randomUUID(), workspaceFolder: ISOLATED_DATA_DIR,
  executor: { transport: 'testfake', model: 'testfake/test' },
  assignment: 'review', reviewSubject: 'code', leafId, status: 'completed',
});
updateDelegationRecord(prior.id, { reportVerdict: 'FAIL' });
const realSession = { chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR, mode: 'agent' };
const realClient = createInProcessMcpClient(realSession);
const reviewArgs = {
  ...base, assignment: 'review', review_subject: 'code', leaf_id: leafId,
};
for (const override of [{}, { allow_recheck: false }, { allow_recheck: 'true' }]) {
  await assert.rejects(startTool.handler({
    ...reviewArgs, ...override, idempotency_key: crypto.randomUUID(),
  }, { client: realClient, session: realSession }), /already reviewed this leaf/);
}
for (const override of [{ allow_recheck: true }, { allowRecheck: true }]) {
  const result = await realClient.startDelegation({
    chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR,
    harness: 'testfake', model: 'testfake/test', sourceKind: 'text', taskText: 'Review the unchanged code',
    assignment: 'review', reviewSubject: 'code', leafId, returnWhenStarting: true,
    idempotencyKey: crypto.randomUUID(), ...override,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  finishDelegation(result.delegation, { status: 'completed' });
}
for (const override of [{ allow_recheck: true }, { allowRecheck: true }]) {
  const result = await startTool.handler({
    ...reviewArgs, ...override, idempotency_key: crypto.randomUUID(),
  }, { client: realClient, session: realSession });
  const delegation = getDelegationById(result.structuredContent.id);
  assert.ok(delegation, JSON.stringify(result));
  finishDelegation(delegation, { status: 'completed' });
}

// Real route registration -> service -> gate: only literal booleans override.
const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => ISOLATED_DATA_DIR, dataDir: ISOLATED_DATA_DIR });
async function postStart(extra) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get('POST /api/chats/:id/delegations')({
    params: { id: parent.id },
    query: { workspaceFolder: ISOLATED_DATA_DIR },
    body: {
      executor: { transport: 'testfake', model: 'testfake/test' }, sourceKind: 'text',
      taskText: 'Review the unchanged code', assignment: 'review', reviewSubject: 'code',
      leafId, returnWhenStarting: true, idempotencyKey: crypto.randomUUID(), ...extra,
    },
  }, res);
  return { status, body };
}
for (const extra of [{}, { allow_recheck: 'false' }, { allowRecheck: 'false' }, { allow_recheck: false }]) {
  const denied = await postStart(extra);
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(denied.body.code, 'review_recheck_no_material_change');
}
for (const extra of [{ allow_recheck: true }, { allowRecheck: true }]) {
  const started = await postStart(extra);
  assert.ok(started.status < 300 && started.body.ok === true, JSON.stringify(started));
  const delegation = getDelegationById(started.body.delegation.id);
  assert.ok(delegation, JSON.stringify(started));
  finishDelegation(delegation, { status: 'completed' });
}

console.log('delegation-start-allow-recheck-mcp.test.js OK');
