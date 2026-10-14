/**
 * Start-path integration of the optional session resume: the second review
 * re-enters the first reviewer's chat as a NEW delegation, falls back with a
 * recorded reason when it cannot, and never lets two starts share a session.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, resetMockChatRuns, getMockChatRun, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
stopDelegationRuntimeWorker();

const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
});
const parent = addChat(randomUUID(), 'resume-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

async function startReview(text, overrides = {}) {
  const result = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: text,
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: randomUUID(),
    executionMode: 'agent',
    assignment: 'review',
    returnWhenStarting: false,
    ...overrides,
  });
  assert.equal(result.ok, true, result.error || 'start failed');
  return result.delegation;
}

function finish(row, verdict = 'PASS') {
  // A finished run releases the chat; the mock keeps `busy` until told otherwise.
  patchMockChatRun(row.childChatId, { busy: false });
  return finishDelegation(row, { status: 'completed', report: `TASK: review\nVERDICT: ${verdict}\nok` });
}

// Default path: no pointer, no session record, a brand-new chat.
const first = await startReview('round one');
assert.equal(first.sessionResume, null);
finish(first);
updateChat(first.childChatId, { opencodeSessionId: 'oc-session-1' });

// Explicit resume: same chat, new delegation/attempt, round 2.
const second = await startReview('round two', { resumeSessionOf: first.id });
assert.equal(second.sessionResume?.status, 'resumed', JSON.stringify(second.sessionResume));
assert.equal(second.childChatId, first.childChatId);
assert.notEqual(second.id, first.id);
assert.notEqual(second.attemptId, first.attemptId);
assert.equal(second.sessionResume.round, 2);
assert.match(getMockChatRun(second.childChatId).prompt, /\[RESUMED REVIEW ROUND 2\]/);
assert.equal(getDelegationById(first.id).sessionResume, null, 'the earlier round is never rewritten');

// A concurrent start naming the same session never shares the live chat.
const third = await startReview('round two (racer)', { resumeSessionOf: first.id });
assert.equal(third.sessionResume?.status, 'fallback');
assert.equal(third.sessionResume.reasonCode, 'resume_session_claimed');
assert.notEqual(third.childChatId, first.childChatId);

// A missing pointer target is a recorded fallback, not an error.
const missing = await startReview('round x', { resumeSessionOf: randomUUID() });
assert.equal(missing.sessionResume.reasonCode, 'resume_source_not_found');
assert.notEqual(missing.childChatId, first.childChatId);

console.log('delegation-session-resume-service.test.js OK');
