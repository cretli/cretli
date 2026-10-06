import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
} from '../lib/persist/delegations-persist.js';
import {
  bindRoomToDelegation,
  noteDelegationRoomEvent,
} from '../lib/delegation-run-bridge.js';
import {
  buildCodexReviewGuardResumePrompt,
  canResumeCodexReviewAfterGuard,
  CODEX_REVIEW_GUARD_RESUME_DISPLAY,
  CODEX_REVIEW_GUARD_RESUME_MAX,
} from '../lib/codex/codex-review-guard-resume.js';
import { REVIEW_GUARD_USER_MESSAGE } from '../lib/sdk/sdk-guard-messages.js';

assert.equal(
  canResumeCodexReviewAfterGuard({ assignment: 'review', resumesUsed: 0 }),
  true,
);
assert.equal(
  canResumeCodexReviewAfterGuard({ assignment: 'review', resumesUsed: 1 }),
  true,
);
assert.equal(
  canResumeCodexReviewAfterGuard({
    assignment: 'review',
    resumesUsed: CODEX_REVIEW_GUARD_RESUME_MAX,
  }),
  false,
);
assert.equal(canResumeCodexReviewAfterGuard({ assignment: 'implement' }), false);
assert.equal(canResumeCodexReviewAfterGuard({ assignment: '' }), false);
assert.equal(buildCodexReviewGuardResumePrompt().includes(REVIEW_GUARD_USER_MESSAGE), true);
assert.match(CODEX_REVIEW_GUARD_RESUME_DISPLAY, /Continuing read-only/);

const parent = addChat('sess-codex-guard-parent', 'Parent', null, '/tmp', 'model', {
  agentTransport: 'codex',
  sdkMode: 'agent',
});
const child = addChat('sess-codex-guard-child', 'Child (review)', null, '/tmp', 'model', {
  agentTransport: 'codex',
  sdkMode: 'agent',
  forkParentChatId: parent.id,
  forkKind: 'delegation',
  delegationParentChatId: parent.id,
  delegationAssignment: 'review',
});
const resumed = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: child.id,
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
const resumeRoom = {
  chatId: child.id,
  delegationAssignment: 'review',
  sdkMode: 'agent',
  _codexReviewGuardResumeQueued: true,
};
bindRoomToDelegation(resumeRoom, {
  delegationId: resumed.id,
  attemptId: resumed.attemptId,
  assignment: 'review',
});
await noteDelegationRoomEvent(resumeRoom, {
  type: 'sdkRunFinished',
  status: 'plan_guard_cancelled',
  runId: 'guard-turn',
});
assert.equal(getDelegationById(resumed.id).status, 'running');

const closed = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: child.id,
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});
const closedRoom = {
  chatId: child.id,
  delegationAssignment: 'review',
  sdkMode: 'agent',
};
bindRoomToDelegation(closedRoom, {
  delegationId: closed.id,
  attemptId: closed.attemptId,
  assignment: 'review',
});
await noteDelegationRoomEvent(closedRoom, {
  type: 'sdkRunFinished',
  status: 'plan_guard_cancelled',
  runId: 'guard-turn-final',
});
assert.equal(getDelegationById(closed.id).status, 'cancelled');

console.log('codex-review-guard-resume.test.js OK');
