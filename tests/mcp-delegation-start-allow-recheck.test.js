/**
 * Contract test for the MCP `delegation_start` review recheck override
 * (`allow_recheck` / `allowRecheck`).
 *
 * Besides the schema/forwarding/persistence shape, this test proves the core
 * contract end to end: the flag actually bypasses
 * `review_recheck_no_material_change` at the start path, and the first stored
 * value wins when the same idempotency key is replayed with the flag changed.
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  listDelegationsForController,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-recheck-'));

/**
 * @param {string} label
 * @returns {object}
 */
function addTestChat(label) {
  return addChat(`sess-${label}-${randomUUID()}`, label, null, workspace, 'model-a', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

try {
  setBuiltinMcpRuntimeDeps({
    dataDir: resolveDataPath(),
    taskRuns: new Map(),
    loadTasksForWorkspace: () => ({ tasks: [] }),
    workspaceDirForAgent: () => '',
  });

  // (a) schema exposes both spellings as booleans.
  const startDef = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'delegation_start');
  assert.equal(startDef.inputSchema.properties.allow_recheck.type, 'boolean');
  assert.equal(startDef.inputSchema.properties.allowRecheck.type, 'boolean');

  // (b) handler forwards a normalized boolean to the client.
  const handlerChat = addTestChat('Handler chat');
  const calls = [];
  const fakeClient = {
    async getChat() { return handlerChat; },
    async startDelegation(input) {
      calls.push(input);
      return { ok: false, error: 'stub start rejected', code: 'stub' };
    },
  };
  const fakeHandlers = createCretliMcpToolHandlers(fakeClient, {
    chatId: handlerChat.id,
    workspaceFolder: workspace,
    harness: 'opencode',
    mode: 'agent',
  });
  const base = { harness: 'opencode', model: 'opencode/test', task_text: 'review it' };
  const variants = [{ allow_recheck: true }, { allowRecheck: true }, {}, { allow_recheck: 'yes' }, { allow_recheck: false }];
  for (const [index, extra] of variants.entries()) {
    const result = await fakeHandlers.delegation_start({
      ...base,
      idempotency_key: `handler-${index}`,
      ...extra,
    });
    // The stub client refuses every start; assert the expected rejection
    // instead of swallowing handler errors.
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(calls.map((call) => call.allowRecheck), [true, true, false, false, false]);

  // (c) persistence defaults to false and only accepts a real boolean.
  const executor = { transport: 'opencode', model: 'rev-a' };
  assert.equal(createDelegationRecord({ parentChatId: 'p1', executor, assignment: 'review', allowRecheck: true }).allowRecheck, true);
  assert.equal(createDelegationRecord({ parentChatId: 'p2', executor, assignment: 'review' }).allowRecheck, false);
  assert.equal(createDelegationRecord({ parentChatId: 'p3', executor, assignment: 'review', allowRecheck: 'true' }).allowRecheck, false);

  // (d) the flag actually bypasses `review_recheck_no_material_change`, and a
  // replay keeps the first stored value (the field is outside the request hash).
  const recheckChat = addTestChat('Recheck chat');
  const leafId = randomUUID();
  const reviewer = { transport: 'opencode', model: 'opencode/test' };
  const priorReview = createDelegationRecord({
    parentChatId: recheckChat.id,
    childChatId: randomUUID(),
    workspaceFolder: workspace,
    executor: reviewer,
    assignment: 'review',
    status: 'completed',
    leafId,
    reviewSubject: 'code',
  });
  updateDelegationRecord(priorReview.id, {
    reportVerdict: 'FAIL',
    queuedAt: new Date(Date.now() - 60000).toISOString(),
  });
  const recheckClient = createInProcessMcpClient({
    harness: 'opencode',
    chatId: recheckChat.id,
    workspaceFolder: workspace,
  });
  const recheckSession = {
    chatId: recheckChat.id,
    workspaceFolder: workspace,
    harness: 'opencode',
    mode: 'agent',
    builtinClient: recheckClient,
  };
  const startTool = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_start');
  assert.ok(startTool, 'delegation_start tool handler exists');
  const reviewStart = {
    task_text: 'Review the leaf.',
    harness: 'opencode',
    model: 'opencode/test',
    assignment: 'review',
    review_subject: 'code',
    leaf_id: leafId,
  };

  // Use the raw tool handler so the assertion sees the gate error code itself;
  // the generic MCP wrapper folds every 409 into CONFLICT.
  await assert.rejects(
    startTool.handler(
      { ...reviewStart, idempotency_key: 'recheck-refused' },
      { client: recheckClient, session: recheckSession },
    ),
    (err) => err?.code === 'review_recheck_no_material_change',
    'the same reviewer on unchanged material is refused without allow_recheck',
  );
  assert.equal(
    listDelegationsForController(recheckChat.id).length,
    1,
    'a refused recheck must not create a delegation row',
  );

  // The same refusal must reach MCP clients through the generic wrapper.
  const wrappedHandlers = createCretliMcpToolHandlers(recheckClient, recheckSession);
  const wrappedRefusal = await wrappedHandlers.delegation_start({
    ...reviewStart,
    idempotency_key: 'recheck-refused-wrapped',
  });
  assert.equal(wrappedRefusal.isError, true);
  assert.equal(wrappedRefusal.structuredContent.code, 'CONFLICT');
  assert.match(wrappedRefusal.content[0].text, /already reviewed this leaf/);

  const allowed = await startTool.handler(
    { ...reviewStart, idempotency_key: 'recheck-allowed', allow_recheck: true },
    { client: recheckClient, session: recheckSession },
  );
  assert.equal(allowed.isError, false, allowed.content?.[0]?.text);
  assert.equal(allowed.structuredContent.allow_recheck, true);
  assert.equal(allowed.structuredContent.replayed, false);
  const allowedRow = getDelegationById(allowed.structuredContent.id);
  assert.equal(allowedRow.allowRecheck, true);
  assert.equal(allowedRow.assignment, 'review');
  assert.equal(allowedRow.reviewSubject, 'code');
  assert.equal(allowedRow.leafId, leafId);

  // Replay with the flag flipped to false: no idempotency conflict (the flag is
  // not in requestHash) and the first stored value wins.
  const replay = await startTool.handler(
    { ...reviewStart, idempotency_key: 'recheck-allowed', allow_recheck: false },
    { client: recheckClient, session: recheckSession },
  );
  assert.equal(replay.isError, false, replay.content?.[0]?.text);
  assert.equal(replay.structuredContent.replayed, true);
  assert.equal(replay.structuredContent.id, allowed.structuredContent.id);
  assert.equal(replay.structuredContent.allow_recheck, true);
  assert.equal(getDelegationById(replay.structuredContent.id).allowRecheck, true);

  // (e) delegation_show summary exposes the flag.
  const shown = await wrappedHandlers.delegation_show({ delegation_id: allowed.structuredContent.id });
  assert.equal(shown.structuredContent.allow_recheck, true);

  // (f) the in-process client normalizes both spellings directly (not only
  // through the handler): true aliases persist true, everything else false.
  const directChat = addTestChat('Direct chat');
  const directClient = createInProcessMcpClient({
    harness: 'opencode',
    chatId: directChat.id,
    workspaceFolder: workspace,
  });
  const directCases = [
    [{ allow_recheck: true }, true],
    [{ allowRecheck: true }, true],
    [{}, false],
    [{ allow_recheck: 'true' }, false],
    [{ allow_recheck: false }, false],
  ];
  for (const [index, [extra, expected]] of directCases.entries()) {
    const result = await directClient.startDelegation({
      chatId: directChat.id,
      workspaceFolder: workspace,
      harness: 'opencode',
      model: 'opencode/test',
      taskText: `Direct start ${index}`,
      sourceKind: 'text',
      assignment: 'implement',
      idempotencyKey: `direct-${index}`,
      returnWhenStarting: true,
      ...extra,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.delegation.allowRecheck, expected);
    assert.equal(getDelegationById(result.delegation.id).allowRecheck, expected);
  }

  console.log('mcp-delegation-start-allow-recheck: ok');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  removeIsolatedDataDir();
}
