/**
 * MCP `delegation_ack` — parent channel, terminal gate, unverified clearing.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { buildDelegationQualityCycles } from '../lib/delegation-cycle-outcomes.js';
import {
  MCP_BUILTIN_TOOL_NAME_LIMIT,
  mcpBuiltinToolEncodedLength,
} from '../lib/mcp/mcp-tool-names.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

const workspace = ISOLATED_DATA_DIR;
const parent = addChat(randomUUID(), 'ack-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const child = addChat(randomUUID(), 'ack-child', null, workspace, 'sdk/composer', {
  agentTransport: 'sdk',
  sdkMode: 'agent',
  delegationParentChatId: parent.id,
});

assert.ok(DELEGATION_MCP_TOOLS.some((tool) => tool.name === 'delegation_ack'));
assert.ok(mcpBuiltinToolEncodedLength('delegation_ack') <= MCP_BUILTIN_TOOL_NAME_LIMIT);

/**
 * @param {object} overrides
 */
function terminalJob(overrides = {}) {
  const row = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: workspace,
    executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    assignment: 'review',
    executionMode: 'agent',
    ...overrides,
  });
  updateDelegationRecord(row.id, {
    status: 'completed',
    runStoppingAt: '',
    report: 'TASK: review\nVERDICT: PASS',
    unverified: true,
  });
  return getDelegationById(row.id);
}

const parentClient = createInProcessMcpClient({
  harness: 'opencode',
  chatId: parent.id,
  workspaceFolder: workspace,
});
const parentHandlers = createCretliMcpToolHandlers(parentClient, {
  chatId: parent.id,
  workspaceFolder: workspace,
  mode: 'agent',
});

const job = terminalJob();
const reviewed = await parentHandlers.delegation_ack({ delegation_id: job.id, reason: 'reviewed' });
assert.equal(reviewed.isError, false);
assert.equal(reviewed.structuredContent.skipped, false);
const afterReview = getDelegationById(job.id);
assert.equal(afterReview.unverified, false);
assert.equal(afterReview.acknowledgedReason, 'reviewed');
assert.ok(String(afterReview.acknowledgedAt || '').trim());

const acceptImplement = createDelegationRecord({
  parentChatId: parent.id,
  workspaceFolder: workspace,
  executor: { transport: 'opencode', model: 'glm' },
  assignment: 'implement',
  executionMode: 'agent',
});
updateDelegationRecord(acceptImplement.id, {
  status: 'completed',
  report: 'TASK: implement\nVERDICT: PASS',
});
const acceptReview = terminalJob({ assignment: 'review' });
const accepted = await parentHandlers.delegation_ack({ delegation_id: acceptReview.id, reason: 'accepted' });
assert.equal(accepted.isError, false);
const afterAccept = getDelegationById(acceptReview.id);
assert.equal(afterAccept.acknowledgedReason, 'accepted');
const cycles = buildDelegationQualityCycles({
  rows: [getDelegationById(acceptImplement.id), afterAccept],
  parentChatId: parent.id,
  includeOpen: true,
});
assert.equal(cycles.some((cycle) => cycle.manualAccepted === true), true);

const childClient = createInProcessMcpClient({
  harness: 'sdk',
  chatId: child.id,
  workspaceFolder: workspace,
});
const childHandlers = createCretliMcpToolHandlers(childClient, {
  chatId: child.id,
  workspaceFolder: workspace,
  mode: 'agent',
});
const childAck = await childHandlers.delegation_ack({ delegation_id: job.id });
assert.equal(childAck.isError, true);

const running = createDelegationRecord({
  parentChatId: parent.id,
  workspaceFolder: workspace,
  executor: { transport: 'opencode', model: 'glm' },
  assignment: 'implement',
});
updateDelegationRecord(running.id, { status: 'running', unverified: true });
const skipped = await parentHandlers.delegation_ack({ delegation_id: running.id });
assert.equal(skipped.isError, false);
assert.equal(skipped.structuredContent.skipped, true);
assert.equal(getDelegationById(running.id).unverified, true);

const missing = await parentHandlers.delegation_ack({ delegation_id: '00000000-0000-0000-0000-000000000000' });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /not found/i);

removeIsolatedDataDir();
console.log('delegation-ack.test.js OK');
