/**
 * The managed-bridge token pins the delegation attempt, so every harness that
 * reuses a bridge/session across turns must key the reuse on the attempt; and
 * in-process (managed) harnesses prove their round through callProvenance built
 * from the per-run context. Local stubs only.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { shouldReuseDeepSeekHarness } from '../harnesses/deepseek/deepseek-harness-cache.js';
import { openCodeBridgeFingerprint } from '../harnesses/opencode/mcp-opencode-sync.js';
import { liveSessionKey, liveSessionKeyParts } from '../harnesses/codebuddy/codebuddy-agent-ws.js';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { registerMockChatRunAdapter, resetMockChatRuns, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { confirmDurableFinish } from './helpers/delegation-durable-finish.js';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

// (a) DeepSeek: same revision/readOnly, other attempt => no reuse.
{
  const harness = {};
  const room = { _harness: harness, _mcpRevision: 'r', _reviewReadOnly: true, _harnessAttemptId: 'a1' };
  assert.equal(shouldReuseDeepSeekHarness(room, 'r', true, 'a1'), true);
  assert.equal(shouldReuseDeepSeekHarness(room, 'r', true, 'a2'), false);
}
// (a) OpenCode: fingerprint differs per attempt, same for the same attempt.
{
  const prep = { revision: 1, bridge: { command: 'node', args: ['x'], env: { CRETLI_URL: 'u' } } };
  const ctx = (attemptId) => ({ sessionId: 's', chatId: 'c', mode: 'agent', attemptId, delegationId: 'd' });
  assert.equal(openCodeBridgeFingerprint(prep, ctx('a1')), openCodeBridgeFingerprint(prep, ctx('a1')));
  assert.notEqual(openCodeBridgeFingerprint(prep, ctx('a1')), openCodeBridgeFingerprint(prep, ctx('a2')));
}
// (a) CodeBuddy live session key.
{
  const room = (a) => ({ modelId: 'm', cwd: '/w', sdkMode: 'agent', delegationAttemptId: a });
  assert.equal(liveSessionKey(room('a1')), liveSessionKey(room('a1')));
  assert.notEqual(liveSessionKey(room('a1')), liveSessionKey(room('a2')));
  assert.equal(liveSessionKeyParts(room('a1')).attemptId, 'a1');
}

// (b) In-process context in a multi-attempt chat.
resetMockChatRuns();
registerMockChatRunAdapter('testfake');
stopDelegationRuntimeWorker();
const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({ workspaceDirForAgent: () => workspace, dataDir: workspace, isModelAvailable: () => true });
const parent = addChat(randomUUID(), 'reuse-keys-parent', null, workspace, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
saveDelegationSettings(workspace, { reviewer_policy: { plan: { selection: 'auto', session: 'leaf' } } }, { dataDir: workspace });
async function start(text, overrides = {}) {
  const r = await service.createAndStart({
    parentChatId: parent.id, sourceKind: 'text', taskText: text,
    executor: { transport: 'testfake', model: 'testfake/test' }, idempotencyKey: randomUUID(),
    executionMode: 'agent', assignment: 'review', reviewSubject: 'plan', returnWhenStarting: false, ...overrides,
  });
  assert.equal(r.ok, true, r.error || 'start failed');
  return r.delegation;
}
const report = (v) => `Checked.\nTASK: review\nVERDICT: ${v}`;
const first = await start('one');
patchMockChatRun(first.childChatId, { busy: false });
await confirmDurableFinish(finishDelegation(first, { status: 'completed', report: report('FAIL') }));
updateChat(first.childChatId, { opencodeSessionId: 'oc-reuse-keys' });
const second = await start('two', { resumeSessionOf: first.id });
patchMockChatRun(second.childChatId, { busy: false });

const ctxFor = (round) => buildMcpRuntimeContext({
  chat: { id: second.childChatId, workspaceFolder: workspace, agentTransport: 'openrouter' },
  room: { chatId: second.childChatId, cwd: workspace, delegationAttemptId: round.attemptId, delegationId: round.id, sdkMode: 'agent' },
  harness: 'openrouter', mode: 'agent',
});
const stale = ctxFor(first);
assert.deepEqual(stale.callProvenance, { attemptId: first.attemptId, delegationId: first.id });
{
  const res = await sendDelegationReply({
    fromChatId: second.childChatId, body: report('PASS'), replyKind: 'final_report', taskOutcome: 'success',
    callAttemptId: stale.callProvenance.attemptId, callDelegationId: stale.callProvenance.delegationId,
    idempotencyKey: `ip-stale-${second.id}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'stale_session_provenance');
}
{
  const cur = ctxFor(second);
  const res = await sendDelegationReply({
    fromChatId: second.childChatId, body: report('PASS'), replyKind: 'final_report', taskOutcome: 'success',
    callAttemptId: cur.callProvenance.attemptId, callDelegationId: cur.callProvenance.delegationId,
    idempotencyKey: `ip-current-${second.id}`,
  });
  assert.equal(res.ok, true, res.error || JSON.stringify(res));
}
console.log('mcp-bridge-reuse-keys: ok');
process.exit(0);
