/**
 * Server-side enforcement of the per-subject reviewer policy on every review
 * start: the policy decides session reuse (not the caller), the first known
 * member is reused while the pair is still being learned, and a reuse decision
 * is persisted for every review (also when nothing could be reused).
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { readReviewerPairMembers } from '../lib/persist/reviewer-pairs-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { applyDelegationWorkflowPatch } from '../lib/delegation-workflow.js';
import { registerMockChatRunAdapter, resetMockChatRuns, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
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
const newParent = () => addChat(randomUUID(), 'policy-parent', null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const setPolicy = (reviewer_policy) => saveDelegationSettings(workspace, { reviewer_policy }, { dataDir: workspace });

async function startReview(parent, model, overrides = {}) {
  const result = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: `review ${model}`,
    executor: { transport: 'opencode', model },
    idempotencyKey: randomUUID(),
    executionMode: 'agent',
    assignment: 'review',
    reviewSubject: 'plan',
    returnWhenStarting: false,
    ...overrides,
  });
  assert.equal(result.ok, true, result.error || 'start failed');
  return result.delegation;
}

function finish(row, session = `oc-${row.id}`) {
  patchMockChatRun(row.childChatId, { busy: false });
  const done = finishDelegation(row, { status: 'completed', report: 'TASK: review\nVERDICT: PASS\nok' });
  updateChat(row.childChatId, { opencodeSessionId: session });
  return done;
}

function finishFail(row, session = `oc-${row.id}`) {
  patchMockChatRun(row.childChatId, { busy: false });
  const done = finishDelegation(row, {
    status: 'completed',
    report: 'TASK: review\nVERDICT: FAIL\nF1 STILL_OPEN (P2)',
  });
  updateChat(row.childChatId, { opencodeSessionId: session });
  return done;
}

// 1. No policy saved: automatic + fresh. No resume record, but the snapshot says why.
{
  const parent = newParent();
  const a = await startReview(parent, 'opencode/a');
  assert.equal(a.sessionResume, null);
  assert.equal(a.reviewerPolicy.session, 'fresh');
  assert.equal(a.reviewerPolicy.reuse.reasonCode, 'reuse_fresh_by_policy');
  finish(a);
  const b = await startReview(parent, 'opencode/a');
  assert.notEqual(b.childChatId, a.childChatId, 'fresh policy never re-enters a chat');
  finish(b);
}

// 2. Learned pair + leaf reuse: the FIRST known member is reused before the pair is complete.
setPolicy({ plan: { selection: 'fixed_pair', members_source: 'learned', session: 'leaf' } });
{
  const parent = newParent();
  const first = await startReview(parent, 'opencode/a');
  assert.equal(first.sessionResume.status, 'fresh');
  assert.equal(first.sessionResume.reasonCode, 'reuse_learning_pair');
  assert.equal(first.reviewerPolicy.reuse.reasonCode, 'reuse_learning_pair');
  assert.equal(readReviewerPairMembers(parent.id, undefined, 'plan').length, 1, 'learning added the first member');
  finish(first);
  const second = await startReview(parent, 'opencode/a');
  assert.equal(second.sessionResume.status, 'resumed', JSON.stringify(second.sessionResume));
  assert.equal(second.childChatId, first.childChatId, 'same chat, new review round');
  assert.notEqual(second.id, first.id, 'a reused chat is still a new delegation');
  assert.equal(second.reviewerPolicy.reuse.status, 'resumed');
  assert.equal(second.reviewerPolicy.reuse.sourceDelegationId, first.id);
  assert.equal(getDelegationById(first.id).sessionResume.status, 'fresh', 'the earlier round is never rewritten');
  finish(second);
  // Second member joins; the pair is complete and a third reviewer is outside it.
  const other = await startReview(parent, 'opencode/b');
  assert.equal(readReviewerPairMembers(parent.id, undefined, 'plan').length, 2);
  finish(other);
  const outsider = await startReview(parent, 'opencode/c');
  assert.equal(outsider.sessionResume.reasonCode, 'reuse_not_pool_member');
  assert.equal(outsider.reviewerPolicy.membership, 'outside_pool');
  assert.equal(readReviewerPairMembers(parent.id, undefined, 'plan').length, 2, 'an outsider never redefines the pair');
  // Effort never makes a second reviewer: a different effort of a member is still that member.
  const sameBase = await startReview(parent, 'opencode/a::effort=low');
  assert.equal(sameBase.reviewerPolicy.membership, 'member');
}

// 3. Another subject is not affected by the plan policy.
{
  const parent = newParent();
  const code = await startReview(parent, 'opencode/a', { reviewSubject: 'other' });
  assert.equal(code.reviewerPolicy.subject, 'other');
  assert.equal(code.reviewerPolicy.session, 'fresh', 'review:other keeps the legacy (off) behavior');
}

// 4. Cross-leaf scope is a separate opt-in; with `leaf` a different execution folder never reuses.
setPolicy({ plan: { selection: 'fixed_pair', members_source: 'learned', session: 'orchestrator' } });
{
  const parent = newParent();
  const first = await startReview(parent, 'opencode/a');
  finish(first);
  const second = await startReview(parent, 'opencode/a');
  assert.equal(second.sessionResume.status, 'resumed');
  assert.equal(second.reviewerPolicy.session, 'orchestrator');
  assert.equal(second.reviewerPolicy.revision.length, 12);
  finish(second);
}

// 5. A busy source is a recorded fallback, never a shared live session.
{
  const parent = newParent();
  const first = await startReview(parent, 'opencode/a');
  finish(first);
  const second = await startReview(parent, 'opencode/a');
  const racer = await startReview(parent, 'opencode/a');
  assert.equal(second.sessionResume.status, 'resumed');
  assert.notEqual(racer.childChatId, second.childChatId);
  assert.equal(racer.sessionResume.status, 'fallback');
  assert.ok(racer.reviewerPolicy.reuse.reason.length > 0, 'a fallback always carries a reason');
}

// 6. Cross-leaf reuse is opt-in: `orchestrator` reuses across leaves of the same
// controller, `leaf` refuses and records why (this is the extension the plan
// gates behind an explicit scope choice).
setPolicy({ plan: { selection: 'fixed_pair', members_source: 'learned', session: 'orchestrator' } });
{
  const parent = newParent();
  const first = await startReview(parent, 'opencode/a', { leafId: 'aaaaaaaa-0000-0000-0000-00000000a001' });
  assert.equal(first.reviewerPolicy.session, 'orchestrator');
  finish(first);
  const across = await startReview(parent, 'opencode/a', {
    leafId: 'aaaaaaaa-0000-0000-0000-00000000a002',
  });
  assert.equal(across.sessionResume.status, 'resumed', JSON.stringify(across.sessionResume));
  assert.equal(across.childChatId, first.childChatId, 'orchestrator scope reuses an eligible session across leaves');
  assert.notEqual(across.id, first.id, 'reuse is still a new delegation');
  finish(across);
}
setPolicy({ plan: { selection: 'fixed_pair', members_source: 'learned', session: 'leaf' } });
{
  const parent = newParent();
  const first = await startReview(parent, 'opencode/a', { leafId: 'aaaaaaaa-0000-0000-0000-00000000b001' });
  finish(first);
  const other = await startReview(parent, 'opencode/a', { leafId: 'aaaaaaaa-0000-0000-0000-00000000b002' });
  assert.notEqual(other.childChatId, first.childChatId, 'leaf scope never crosses leaves');
  assert.equal(other.sessionResume.reasonCode, 'reuse_no_eligible_source');
  assert.ok(other.sessionResume.reason.length > 0);
  finish(other);
}

// 7. A changed execution folder is a recorded fallback, never a reused session.
setPolicy({ plan: { selection: 'fixed_pair', members_source: 'learned', session: 'orchestrator' } });
{
  const parent = newParent();
  const leaf = 'aaaaaaaa-0000-0000-0000-00000000d001';
  const first = await startReview(parent, 'opencode/a', { leafId: leaf });
  finish(first);
  updateChat(parent.id, { executionFolder: process.cwd() });
  const changed = await startReview(parent, 'opencode/a', { leafId: leaf });
  assert.equal(changed.sessionResume.status, 'fallback', JSON.stringify(changed.sessionResume));
  assert.equal(changed.sessionResume.reasonCode, 'resume_config_changed');
  assert.notEqual(changed.childChatId, first.childChatId, 'a folder change needs a fresh session');
  assert.ok(changed.reviewerPolicy.reuse.reason.length > 0, 'the fallback reason is persisted');
  finish(changed);
}

// 8. Code review phases: audit -> closure opens a fresh chat with `phase_changed`;
// closure -> closure keeps the same reviewer chat.
setPolicy({
  code: {
    selection: 'fixed_pair',
    members_source: 'configured',
    members: [
      { harness: 'opencode', model: 'opencode/a' },
      { harness: 'opencode', model: 'opencode/b' },
    ],
    session: 'leaf',
  },
});
{
  const parent = newParent();
  const leaf = 'aaaaaaaa-0000-0000-0000-00000000e001';
  applyDelegationWorkflowPatch({
    parentChatId: parent.id,
    leafId: leaf,
    workspaceFolder: workspace,
    codeReviewAuditDone: false,
    codeReviewClosureCount: 0,
    maxCodeReviewClosures: 4,
    round: 1,
    materialRevision: 'code-phase-rev-1',
    idempotencyKey: 'code-phase-seed',
  });
  const audit = await startReview(parent, 'opencode/a', { reviewSubject: 'code', leafId: leaf });
  assert.equal(audit.reviewMode, 'audit');
  finishFail(audit); // audit FAIL resolves the round -> auditDone=true
  const closure = await startReview(parent, 'opencode/a', {
    reviewSubject: 'code',
    leafId: leaf,
    allowRecheck: true,
  });
  assert.equal(closure.reviewMode, 'closure');
  assert.equal(closure.sessionResume.status, 'fallback', JSON.stringify(closure.sessionResume));
  assert.equal(closure.sessionResume.reasonCode, 'phase_changed');
  assert.notEqual(closure.childChatId, audit.childChatId, 'audit and closure never share a chat');
  finishFail(closure);
  const closureAgain = await startReview(parent, 'opencode/a', {
    reviewSubject: 'code',
    leafId: leaf,
    allowRecheck: true,
  });
  assert.equal(closureAgain.sessionResume.status, 'resumed', JSON.stringify(closureAgain.sessionResume));
  assert.equal(closureAgain.childChatId, closure.childChatId, 'closure -> closure keeps the reviewer chat');
  assert.notEqual(closureAgain.id, closure.id, 'the reused chat is a new review round');
  finishFail(closureAgain);
}

// 9. An explicit resume_session_of works even under a fresh policy (the server
// still applies every safety gate first).
setPolicy({ plan: { selection: 'auto', session: 'fresh' } });
{
  const parent = newParent();
  const first = await startReview(parent, 'opencode/a');
  assert.equal(first.sessionResume, null, 'an auto/fresh policy requests no resume');
  assert.equal(first.reviewerPolicy.reuse.reasonCode, 'reuse_fresh_by_policy');
  finish(first);
  const explicit = await startReview(parent, 'opencode/a', { resumeSessionOf: first.id });
  assert.equal(explicit.sessionResume.status, 'resumed', JSON.stringify(explicit.sessionResume));
  assert.equal(explicit.childChatId, first.childChatId);
  assert.equal(explicit.reviewerPolicy.reuse.status, 'resumed');
  finish(explicit);
}

// 10. F12: `reviewedBefore` is per subject. A reviewer's first session for
// `plan` is not mislabelled "no eligible source" because it reviewed `code`.
setPolicy({
  plan: {
    selection: 'fixed_pair',
    members_source: 'configured',
    members: [
      { harness: 'opencode', model: 'opencode/a' },
      { harness: 'opencode', model: 'opencode/b' },
    ],
    session: 'leaf',
  },
  code: {
    selection: 'fixed_pair',
    members_source: 'configured',
    members: [
      { harness: 'opencode', model: 'opencode/a' },
      { harness: 'opencode', model: 'opencode/b' },
    ],
    session: 'leaf',
  },
});
{
  const parent = newParent();
  const leaf = 'aaaaaaaa-0000-0000-0000-00000000f001';
  const code = await startReview(parent, 'opencode/a', { reviewSubject: 'code', leafId: leaf });
  finish(code);
  const plan = await startReview(parent, 'opencode/a', { reviewSubject: 'plan', leafId: leaf });
  assert.equal(plan.sessionResume.status, 'fresh', JSON.stringify(plan.sessionResume));
  assert.equal(plan.sessionResume.reasonCode, 'reuse_first_session', 'another subject is not an ineligible source');
  assert.notEqual(plan.childChatId, code.childChatId);
  finish(plan);
}

console.log('reviewer-policy-service.test.js OK');
