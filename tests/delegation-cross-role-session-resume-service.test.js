/**
 * Start path of the opt-in `continue_cross_role_sessions` setting: the service
 * builds the candidate list (same-role first, then cross-role), runs the
 * Stage 1 fail-safe guards per candidate and records the first candidate's
 * refusal when none resumes. Every resume is still a NEW delegation/attempt.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
process.env.CRETLI_LEAF_MATERIAL_CHECKPOINT = '0';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { getDelegationById, loadDelegations } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { clearDelegationEnvCache } from '../lib/delegation-settings.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, resetMockChatRuns, getMockChatRun, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';
import { confirmDurableFinish } from './helpers/delegation-durable-finish.js';
import { buildTodoReviewSnapshot } from '../lib/todo-review-sync.js';

resetMockChatRuns();
registerMockChatRunAdapter('claude');
registerMockChatRunAdapter('testfake');
stopDelegationRuntimeWorker();

const workspace = ISOLATED_DATA_DIR;
// Cache view stub mirroring freshness.cache.{state,reason}; unset chats are unknown.
const cacheByChat = new Map();
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
  buildChatCacheView: (chatId) => ({
    freshness: { cache: cacheByChat.get(chatId) || { state: 'unknown', reason: 'no_cached_turn' } },
  }),
});
const parent = addChat(randomUUID(), 'cross-role-parent', null, workspace, 'claude/test', {
  agentTransport: 'claude',
  sdkMode: 'agent',
});

function setSwitches(patch) {
  saveDelegationSettings(workspace, patch, { dataDir: workspace });
  clearDelegationEnvCache();
}

const ROLE_INPUT = {
  implement: { assignment: 'implement', executionMode: 'agent' },
  fix: { assignment: 'fix', requestedRole: 'fix', executionMode: 'agent' },
  review: { assignment: 'review', reviewSubject: 'code', executionMode: 'agent' },
};
const REPORT = {
  implement: 'TASK: implement\nVERDICT: PASS\nok',
  fix: 'TASK: implement\nVERDICT: PASS\nok',
  review: 'TASK: review\nVERDICT: FAIL\none finding',
};

async function start(role, leafId, overrides = {}) {
  const { keepOpen = false, ...rest } = overrides;
  const result = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: `${role} task ${randomUUID()}`,
    executor: { transport: 'claude', model: 'claude/test' },
    idempotencyKey: randomUUID(),
    // These flows reuse one executor across roles on purpose.
    allowSameModelReview: true,
    leafId,
    resumeRounds: true,
    allowRecheck: true,
    returnWhenStarting: false,
    ...ROLE_INPUT[role],
    ...rest,
  });
  assert.equal(result.ok, true, `${role}: ${result.error || result.code}`);
  assert.ok(!result.queued, `${role} parked behind: ${JSON.stringify(result.queueConflict)}`);
  const row = result.delegation;
  if (!keepOpen) return finish(row, { report: REPORT[role] });
  return row;
}

async function finish(row, outcome = {}) {
  patchMockChatRun(row.childChatId, { busy: false });
  const done = finishDelegation(row, { status: 'completed', ...outcome });
  updateChat(row.childChatId, { claudeSessionId: `oc-${row.childChatId}` });
  await confirmDurableFinish(done);
  return getDelegationById(done.id);
}

const reviewPolicy = { code: { selection: 'auto', members_source: 'learned', members: [], session: 'leaf' } };
setSwitches({ reviewer_policy: reviewPolicy, continue_implement_sessions: true, continue_fix_sessions: true });

// 1. Setting off (default): roles never share a chat, codes are today's.
const leafOff = randomUUID();
const offImpl = await start('implement', leafOff);
const offReview = await start('review', leafOff);
assert.notEqual(offReview.childChatId, offImpl.childChatId);
assert.notEqual(offReview.sessionResume.reasonCode, 'resumed_cross_role');
const offFix = await start('fix', leafOff);
assert.equal(offFix.childChatId, offImpl.childChatId, 'same-role fix -> implement edge is unchanged');
assert.equal(offFix.sessionResume.reasonCode, 'resumed');

// 2. Setting on: code review after implement re-enters the implement chat.
setSwitches({ continue_cross_role_sessions: true });
const leaf = randomUUID();
const impl = await start('implement', leaf);
const review = await start('review', leaf);
assert.equal(review.sessionResume.status, 'resumed', JSON.stringify(review.sessionResume));
assert.equal(review.sessionResume.reasonCode, 'resumed_cross_role');
assert.equal(review.sessionResume.crossRole, true);
assert.equal(review.sessionResume.sourceWorkRole, 'implement');
assert.equal(review.childChatId, impl.childChatId);
assert.notEqual(review.id, impl.id);
assert.equal(review.sessionResume.round, 2);
assert.match(getMockChatRun(review.childChatId).prompt, /\[RESUMED REVIEW ROUND 2\][\s\S]*CODE REVIEW \(read-only\)/);
// The server snapshot (existing sync, unchanged) never calls it independent.
const snapshot = buildTodoReviewSnapshot({ leafId: leaf, rows: loadDelegations() });
assert.equal(snapshot.code.reviewers.find((row) => row.delegationId === review.id)?.independence, 'same_model_same_harness');
assert.equal(snapshot.code.independence.independent, false);

// 3. Fix after that review: same-role source (the implement row) is superseded,
// so the cross-role candidate (the review, latest row of the chat) is tried.
const fix = await start('fix', leaf);
assert.equal(fix.sessionResume.status, 'resumed', JSON.stringify(fix.sessionResume));
assert.equal(fix.sessionResume.reasonCode, 'resumed_cross_role');
assert.equal(fix.sessionResume.sourceDelegationId, review.id);
assert.equal(fix.childChatId, impl.childChatId);
assert.equal(fix.sessionResume.round, 3);
assert.match(getMockChatRun(fix.childChatId).prompt, /\[RESUMED FIX SESSION, ROUND 3\][\s\S]*Your role is now FIX/);

// 4. Mixed chat keeps working: the next review re-enters the same chat again.
const review2 = await start('review', leaf);
assert.equal(review2.childChatId, impl.childChatId, JSON.stringify(review2.sessionResume));
assert.equal(review2.sessionResume.reasonCode, 'resumed_cross_role');

// 5. Fan-out: two simultaneous reviews -> one resumed, one fresh.
const fix2 = await start('fix', leaf);
assert.equal(fix2.childChatId, impl.childChatId);
const fanA = await start('review', leaf, { keepOpen: true });
const fanB = await start('review', leaf, { keepOpen: true });
assert.equal(fanA.childChatId, impl.childChatId, JSON.stringify(fanA.sessionResume));
assert.notEqual(fanB.childChatId, impl.childChatId);
assert.notEqual(fanB.sessionResume.status, 'resumed');
await finish(fanA, { report: REPORT.review });
await finish(fanB, { report: REPORT.review });

// 6. A work start with its per-role switch off stays fresh even with the new setting on.
setSwitches({ continue_fix_sessions: false });
const fixOff = await start('fix', leaf);
assert.notEqual(fixOff.childChatId, impl.childChatId);
assert.equal(fixOff.sessionResume.reasonCode, 'work_fresh_by_policy');
setSwitches({ continue_fix_sessions: true });

// 7. Guards per candidate: a cold cross-role source falls through to the next
// candidate. Chats: I (implement), R1 and R2 (pure review chats).
const leafCold = randomUUID();
setSwitches({ continue_cross_role_sessions: false });
const coldImpl = await start('implement', leafCold);
const reviewR1 = await start('review', leafCold);
// The same-model reviewer never re-enters R1 (independence), so R2 is a new chat.
const reviewR2 = await start('review', leafCold);
setSwitches({ continue_cross_role_sessions: true });
assert.notEqual(reviewR1.childChatId, coldImpl.childChatId);
assert.notEqual(reviewR2.childChatId, reviewR1.childChatId);
cacheByChat.set(coldImpl.childChatId, { state: 'cold', reason: 'ttl_expired' });
cacheByChat.set(reviewR2.childChatId, { state: 'cold', reason: 'ttl_expired' });
const fixThrough = await start('fix', leafCold);
assert.equal(fixThrough.sessionResume.status, 'resumed', JSON.stringify(fixThrough.sessionResume));
assert.equal(fixThrough.sessionResume.reasonCode, 'resumed_cross_role');
assert.equal(fixThrough.childChatId, reviewR1.childChatId, 'cold same-role and cold newest cross candidate are skipped');
cacheByChat.clear();

// 8. No candidate left: fresh chat, the FIRST candidate's reason is recorded.
// Same-role candidate (chat I) lost its harness session; the only cross-role
// candidate (review chat R) is cold.
const leafNone = randomUUID();
setSwitches({ continue_cross_role_sessions: false });
const noneImpl = await start('implement', leafNone);
const noneReview = await start('review', leafNone);
setSwitches({ continue_cross_role_sessions: true });
assert.notEqual(noneReview.childChatId, noneImpl.childChatId);
updateChat(noneImpl.childChatId, { claudeSessionId: '' });
cacheByChat.set(noneReview.childChatId, { state: 'cold', reason: 'ttl_expired' });
const noneFix = await start('fix', leafNone);
assert.notEqual(noneFix.childChatId, noneImpl.childChatId);
assert.notEqual(noneFix.childChatId, noneReview.childChatId);
assert.equal(noneFix.sessionResume.status, 'fallback');
assert.equal(noneFix.sessionResume.reasonCode, 'resume_session_missing', 'first (same-role) candidate wins the record');
// A review start whose only candidate is cold records the guard reason itself.
const leafColdReview = randomUUID();
const coldOnly = await start('implement', leafColdReview);
cacheByChat.set(coldOnly.childChatId, { state: 'cold', reason: 'ttl_expired' });
const coldReview = await start('review', leafColdReview);
assert.notEqual(coldReview.childChatId, coldOnly.childChatId);
assert.equal(coldReview.sessionResume.reasonCode, 'work_cache_expired');
// Explicit resume_session_of is exempt from the guards.
const explicitReview = await start('review', leafColdReview, { resumeSessionOf: coldOnly.id });
assert.equal(explicitReview.sessionResume.status, 'resumed', JSON.stringify(explicitReview.sessionResume));
assert.equal(explicitReview.childChatId, coldOnly.childChatId);
cacheByChat.clear();

// 9. Empty-report guard keyed on the source chat: the newest attempt there is
// an empty resumed attempt of ANOTHER role than the start (implement vs review).
const leafEmpty = randomUUID();
const emptyBase = await start('implement', leafEmpty);
const emptyResumed = await start('implement', leafEmpty, { keepOpen: true });
assert.equal(emptyResumed.childChatId, emptyBase.childChatId);
await finish(emptyResumed, { report: '' });
const afterEmpty = await start('review', leafEmpty);
assert.notEqual(afterEmpty.childChatId, emptyBase.childChatId);
assert.equal(afterEmpty.sessionResume.reasonCode, 'work_previous_empty_report');
const explicitEmpty = await start('review', leafEmpty, { resumeSessionOf: emptyResumed.id });
assert.equal(explicitEmpty.sessionResume.status, 'resumed', JSON.stringify(explicitEmpty.sessionResume));
assert.equal(explicitEmpty.childChatId, emptyBase.childChatId);

// 10. Same base model, different `::` params: never the same session.
const leafParams = randomUUID();
const paramsImpl = await start('implement', leafParams);
const paramsReview = await start('review', leafParams, { executor: { transport: 'claude', model: 'claude/test::effort=low' } });
assert.notEqual(paramsReview.childChatId, paramsImpl.childChatId);

// 11. Setting on: guards A/B also run on the SAME-ROLE candidate. The mixed
// chat (implement + review rows) is cold, so the review -> review candidate is
// rejected with the guard reason instead of silently resuming.
setSwitches({ continue_cross_role_sessions: true });
const leafMixed = randomUUID();
const mixedImpl = await start('implement', leafMixed);
const mixedReview = await finish(await start('review', leafMixed, { keepOpen: true }), { report: 'TASK: review\nVERDICT: PASS\nok' });
assert.equal(mixedReview.childChatId, mixedImpl.childChatId);
const mixedWarm = await start('review', leafMixed);
assert.equal(mixedWarm.childChatId, mixedImpl.childChatId, JSON.stringify(mixedWarm.sessionResume));
cacheByChat.set(mixedImpl.childChatId, { state: 'cold', reason: 'ttl_expired' });
const mixedCold = await start('review', leafMixed);
assert.notEqual(mixedCold.childChatId, mixedImpl.childChatId);
assert.equal(mixedCold.sessionResume.reasonCode, 'work_cache_expired');
cacheByChat.clear();
// Same for an empty resumed attempt of another role as the newest attempt of the chat.
const leafMixedEmpty = randomUUID();
const mixedEmptyBase = await start('implement', leafMixedEmpty);
const mixedEmptyReview = await finish(await start('review', leafMixedEmpty, { keepOpen: true }), { report: 'TASK: review\nVERDICT: PASS\nok' });
assert.equal(mixedEmptyReview.childChatId, mixedEmptyBase.childChatId);
const mixedEmptyFix = await start('fix', leafMixedEmpty, { keepOpen: true });
assert.equal(mixedEmptyFix.childChatId, mixedEmptyBase.childChatId);
await finish(mixedEmptyFix, { report: '' });
const afterMixedEmpty = await start('review', leafMixedEmpty);
assert.notEqual(afterMixedEmpty.childChatId, mixedEmptyBase.childChatId);
assert.equal(afterMixedEmpty.sessionResume.reasonCode, 'work_previous_empty_report');

// 12. Setting off: the same-role review candidate is NOT guarded (unchanged
// reviewer path): a cold review chat is refused by the usual gate, never by a guard.
setSwitches({ continue_cross_role_sessions: false });
const leafPure = randomUUID();
await start('implement', leafPure);
const pureReview = await start('review', leafPure);
cacheByChat.set(pureReview.childChatId, { state: 'cold', reason: 'ttl_expired' });
const pureReview2 = await start('review', leafPure);
assert.notEqual(pureReview2.sessionResume.reasonCode, 'work_cache_expired');
assert.notEqual(pureReview2.sessionResume.reasonCode, 'work_previous_empty_report');
cacheByChat.clear();

// 13. testfake is not a cross-role transport (its permission sync is not
// fail-closed): the review starts a fresh chat with the unsupported reason.
setSwitches({ continue_cross_role_sessions: true });
const leafOpenCode = randomUUID();
const openCodeExecutor = { transport: 'testfake', model: 'testfake/test' };
const ocImpl = await start('implement', leafOpenCode, { executor: openCodeExecutor });
const ocReview = await start('review', leafOpenCode, { executor: openCodeExecutor });
assert.notEqual(ocReview.childChatId, ocImpl.childChatId);
assert.equal(ocReview.sessionResume.reasonCode, 'resume_cross_role_unsupported', JSON.stringify(ocReview.sessionResume));

setSwitches({ continue_cross_role_sessions: null });
console.log('delegation-cross-role-session-resume-service.test.js OK');
process.exit(0);
