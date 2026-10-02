import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { inspectDelegationSlot, recordDelegationVerifyResult } from '../lib/delegation-service.js';
import {
  aggregateReviewFanoutVerdicts,
  mapDelegationRoleToAssignment,
  parseDelegationVerdict,
  resolveVerdictNextStep,
} from '../lib/delegation-verdict.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

assert.equal(mapDelegationRoleToAssignment('plan'), 'review');
assert.equal(mapDelegationRoleToAssignment('fix'), 'implement');
assert.equal(parseDelegationVerdict('done\nVERDICT: PASS\n'), 'PASS');
assert.equal(parseDelegationVerdict('plan body TASK:auditVERDICT:PASS'), 'PASS');
assert.equal(parseDelegationVerdict('VERDICT: PASS\nVERDICT: FAIL'), 'conflict');
assert.equal(parseDelegationVerdict('no line'), 'unspecified');
assert.equal(aggregateReviewFanoutVerdicts(['PASS', 'FAIL']), 'FAIL');
assert.equal(aggregateReviewFanoutVerdicts(['PASS', 'PASS']), 'PASS');
assert.equal(aggregateReviewFanoutVerdicts(['PASS', 'BLOCKED']), 'BLOCKED');
assert.equal(resolveVerdictNextStep('conflict'), 'fix');
assert.equal(resolveVerdictNextStep('unspecified'), 'stop');

const parent = addChat(crypto.randomUUID(), 'contract-parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const completedHeld = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: crypto.randomUUID(),
  workspaceFolder: ISOLATED_DATA_DIR,
  executor: { transport: 'opencode', model: 'opencode/test' },
  assignment: 'implement',
});
updateDelegationRecord(completedHeld.id, {
  status: 'completed',
  taskOutcome: 'unspecified',
  runStoppingAt: new Date().toISOString(),
  report: `${'x'.repeat(50)}\nVERDICT: PASS`,
});
recordDelegationVerifyResult({
  delegationId: completedHeld.id,
  attemptId: completedHeld.attemptId,
  result: { ok: false, dataDir: '/tmp/isolated-review-data' },
});
const heldRow = getDelegationById(completedHeld.id);
const occupied = inspectDelegationSlot(heldRow);
assert.equal(occupied.occupied, true);
assert.equal(occupied.code, 'run_stopping');

const interrupted = createDelegationRecord({
  parentChatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
  executor: { transport: 'opencode', model: 'opencode/test' },
});
updateDelegationRecord(interrupted.id, { status: 'interrupted', runStoppingAt: '' });
assert.equal(inspectDelegationSlot(getDelegationById(interrupted.id)).occupied, false);

const client = createInProcessMcpClient({
  harness: 'opencode',
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
});
const handlers = createCretliMcpToolHandlers(client, {
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});
const shown = await handlers.delegation_show({ delegation_id: completedHeld.id });
assert.equal(shown.isError, false);
assert.equal(shown.structuredContent.status, 'completed');
assert.equal(shown.structuredContent.task_outcome, 'unspecified');
assert.equal(shown.structuredContent.slot_occupied, true);
assert.equal(shown.structuredContent.run_stopping, true);
assert.equal(shown.structuredContent.verdict, 'PASS');
assert.equal(shown.structuredContent.verify_result.status, 'failed');
assert.equal(shown.structuredContent.verify_result.exitCode, 1);
assert.match(shown.content[0].text, /review_verify: failed exit=1/);
assert.match(shown.content[0].text, /slot_occupied=true/);
assert.match(shown.content[0].text, /status=completed/);

const listed = await handlers.delegation_list({});
assert.equal(listed.isError, false);
const held = listed.structuredContent.items.find((row) => row.id === completedHeld.id);
assert.equal(held.slot_occupied, true);
assert.equal(held.task_outcome, 'unspecified');

const waitHeld = await handlers.delegation_wait({ ids: [completedHeld.id], timeout_ms: 0 });
assert.equal(waitHeld.isError, false);
assert.equal(waitHeld.structuredContent.status, 'pending');
assert.equal(waitHeld.structuredContent.items[0].run_stopping, true);
updateDelegationRecord(completedHeld.id, { runStoppingAt: '' });
const waitFree = await handlers.delegation_wait({ ids: [completedHeld.id], timeout_ms: 0 });
assert.equal(waitFree.structuredContent.status, 'done');

console.log('delegation-contract.test.js OK');
