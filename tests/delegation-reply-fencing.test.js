import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  patchMockChatRun,
  registerMockChatRunAdapter,
} from '../lib/chat-run/mock-adapter.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

registerMockChatRunAdapter('opencode');

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

const parent = addChat(crypto.randomUUID(), 'fence-parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

const started = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: 'Fence test task',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});
assert.equal(started.ok, true);
const job = started.delegation;
const staleRunId = String(job.runId || '').trim();
assert.ok(staleRunId);

const liveRunId = 'live-executing-run-id';
patchMockChatRun(job.childChatId, { runId: liveRunId, busy: true });

const staleReply = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Report with stale run_id from delegation_show.',
  idempotencyKey: 'fence-stale-run',
  runId: staleRunId,
});
assert.equal(staleReply.ok, false);
assert.equal(staleReply.code, 'run_mismatch');
assert.match(staleReply.error, /run_id does not match the executing run\./);
assert.match(staleReply.error, new RegExp(`run_id=${liveRunId}`));

const childClient = createInProcessMcpClient({
  harness: 'opencode',
  chatId: job.childChatId,
  workspaceFolder: ISOLATED_DATA_DIR,
});
const childHandlers = createCretliMcpToolHandlers(childClient, {
  chatId: job.childChatId,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});
const mcpStale = await childHandlers.delegation_reply({
  message_text: 'MCP stale run_id',
  idempotency_key: 'fence-mcp-stale',
  run_id: staleRunId,
});
assert.equal(mcpStale.isError, true);
assert.match(mcpStale.content[0].text, new RegExp(`run_id=${liveRunId}`));

const withoutFence = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Report without run_id or attempt_id.',
  idempotencyKey: 'fence-no-ids',
});
assert.equal(withoutFence.ok, true);
assert.ok(withoutFence.message?.id);

updateDelegationRecord(job.id, { runId: liveRunId });
const aligned = getDelegationById(job.id);
assert.equal(aligned.runId, liveRunId);

console.log('delegation-reply-fencing.test.js OK');
