/**
 * Sender side of reply fencing: signed attempt/delegation claims in the MCP
 * bridge token -> callProvenance -> rejection of a stale round; fail-closed
 * fallback C for tokens without claims. Local stubs only.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { registerMockChatRunAdapter, resetMockChatRuns, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { confirmDurableFinish } from './helpers/delegation-durable-finish.js';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';
import { mintMcpIntegrationToken, verifyMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { buildManagedBridgeStdio, resolveAuthorizedMcpContext } from '../lib/mcp/mcp-session.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
stopDelegationRuntimeWorker();

// (5) Old token without claims still verifies and yields no provenance.
{
  const legacy = mintMcpIntegrationToken({ sessionId: 's', chatId: 'c', harness: 'sdk', incarnation: 'inc' });
  const claims = verifyMcpIntegrationToken(legacy);
  assert.equal('attemptId' in claims, false);
  assert.equal('delegationId' in claims, false);
  const withClaims = verifyMcpIntegrationToken(mintMcpIntegrationToken({
    sessionId: 's', chatId: 'c', incarnation: 'inc', attemptId: 'a1', delegationId: 'd1',
  }));
  assert.equal(withClaims.attemptId, 'a1');
  assert.equal(withClaims.delegationId, 'd1');
}

const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({ workspaceDirForAgent: () => workspace, dataDir: workspace, isModelAvailable: () => true });
const parent = addChat(randomUUID(), 'token-parent', null, workspace, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
saveDelegationSettings(workspace, { reviewer_policy: { plan: { selection: 'auto', session: 'leaf' } } }, { dataDir: workspace });

async function start(text, overrides = {}) {
  const result = await service.createAndStart({
    parentChatId: parent.id, sourceKind: 'text', taskText: text,
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: randomUUID(), executionMode: 'agent', assignment: 'review', reviewSubject: 'plan',
    returnWhenStarting: false, ...overrides,
  });
  assert.equal(result.ok, true, result.error || 'start failed');
  return result.delegation;
}
const report = (v) => `Checked.\nTASK: review\nVERDICT: ${v}`;

// Mint a bridge token exactly as the spawn path does for a given round.
function tokenFor(chatId, round) {
  const stdio = buildManagedBridgeStdio({
    sessionId: `sess-${chatId}`, chatId, workspaceId: '', workspaceFile: '', workspaceFolder: workspace,
    harness: 'sdk', mode: 'agent', getMode: () => 'agent',
    attemptId: round.attemptId, runId: round.runId || '', delegationId: round.id,
  });
  return verifyMcpIntegrationToken(stdio.env.CRETLI_MCP_TOKEN);
}

const first = await start('round one');
patchMockChatRun(first.childChatId, { busy: false });
// Fresh chat with one attempt: a claimless call still works (fallback C needs >1).
const oneAttempt = await sendDelegationReply({
  fromChatId: first.childChatId, body: 'progress', replyKind: 'progress', idempotencyKey: `n1-${first.id}`,
});
assert.equal(oneAttempt.ok, true, oneAttempt.error || JSON.stringify(oneAttempt));

const oldClaims = tokenFor(first.childChatId, first);
assert.equal(oldClaims.attemptId, first.attemptId);
await confirmDurableFinish(finishDelegation(first, { status: 'completed', report: report('FAIL') }));
updateChat(first.childChatId, { opencodeSessionId: 'oc-token-prov' });
const second = await start('round two', { resumeSessionOf: first.id });
assert.equal(second.childChatId, first.childChatId);
patchMockChatRun(second.childChatId, { busy: false });

// The old token is still valid for the live session (same incarnation), but its
// claims name round one: end-to-end it must be rejected for round two.
const staleCtx = resolveAuthorizedMcpContext(oldClaims);
assert.deepEqual(staleCtx.callProvenance, { attemptId: first.attemptId, delegationId: first.id });
{
  const res = await sendDelegationReply({
    fromChatId: second.childChatId, body: report('PASS'), replyKind: 'final_report', taskOutcome: 'success',
    sessionAttemptId: staleCtx.attemptId, sessionRunId: staleCtx.runId,
    callAttemptId: staleCtx.callProvenance.attemptId, callDelegationId: staleCtx.callProvenance.delegationId,
    idempotencyKey: `tok-stale-${second.id}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'stale_session_provenance');
}

// (1) Token without claims after a rebind (chat hosted 2 attempts): fail closed.
{
  const res = await sendDelegationReply({
    fromChatId: second.childChatId, body: report('PASS'), replyKind: 'final_report', taskOutcome: 'success',
    idempotencyKey: `tok-noclaim-${second.id}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'stale_session_provenance');
  // (4) REST shape: no provenance at all, >1 attempt => rejected.
  const rest = await sendDelegationReply({
    fromChatId: second.childChatId, delegationId: second.id, body: 'note', replyKind: 'progress',
    attemptId: '', runId: '', idempotencyKey: `tok-rest-${second.id}`,
  });
  assert.equal(rest.ok, false);
  assert.equal(rest.code, 'stale_session_provenance');
}

// (3) Explicit ids win over fallback C: a wrong attempt id keeps attempt_mismatch.
{
  const res = await sendDelegationReply({
    fromChatId: second.childChatId, delegationId: second.id, body: 'note', replyKind: 'progress',
    attemptId: randomUUID(), idempotencyKey: `tok-explicit-${second.id}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'attempt_mismatch');
}

// (2) A token minted for the current round works.
{
  const ctx = resolveAuthorizedMcpContext(tokenFor(second.childChatId, second));
  const res = await sendDelegationReply({
    fromChatId: second.childChatId, body: report('PASS'), replyKind: 'final_report', taskOutcome: 'success',
    callAttemptId: ctx.callProvenance.attemptId, callDelegationId: ctx.callProvenance.delegationId,
    idempotencyKey: `tok-current-${second.id}`,
  });
  assert.equal(res.ok, true, res.error || JSON.stringify(res));
}

console.log('mcp-reply-provenance-token: ok');
process.exit(0);
