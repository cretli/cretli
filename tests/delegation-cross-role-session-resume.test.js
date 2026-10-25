/**
 * Opt-in cross-role chat reuse (`continue_cross_role_sessions`): pure gate,
 * candidate lookup, round implementer and independence. The service start path
 * is covered by tests/delegation-cross-role-session-resume-service.test.js.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  buildSessionResumePromptBlock,
  buildSessionResumeRecord,
  findCrossRoleResumeSources,
  inspectDelegationSessionResume,
  normalizeSessionResumeRecord,
  SESSION_RESUME_REASON as R,
} from '../lib/delegation-session-resume.js';
import { findRoundImplementer } from '../lib/delegation-round-implementer.js';
import { isCrossRoleSessionPair } from '../lib/delegation-work-role.js';
import { buildTodoReviewSnapshot } from '../lib/todo-review-sync.js';

const parentChatId = randomUUID();
const leafId = randomUUID();
const MODEL = 'claude-opus-5-5::effort=low';
let clock = Date.parse('2026-10-20T10:00:00.000Z');

/** Next queue time: fixtures are created in chronological order. */
function nextStamp() {
  clock += 60_000;
  return new Date(clock).toISOString();
}

/**
 * @param {'implement'|'fix'|'review_code'|'review_plan'|'review_other'|'plan'} workRole
 * @param {object} [overrides]
 */
function row(workRole, overrides = {}) {
  const isReview = workRole.startsWith('review_');
  return {
    id: randomUUID(),
    attemptId: randomUUID(),
    parentChatId,
    childChatId: randomUUID(),
    leafId,
    workRole,
    assignment: isReview ? 'review' : 'implement',
    reviewSubject: isReview ? workRole.replace('review_', '') : '',
    reviewMode: '',
    status: 'completed',
    reportVerdict: isReview ? 'FAIL' : '',
    report: 'TASK: x\nVERDICT: PASS',
    executionMode: 'agent',
    executionFolder: '/tmp/wt',
    planReviewerPhase: '',
    queuedAt: nextStamp(),
    executor: { transport: 'claude', model: MODEL, options: {} },
    sessionContinuity: { identity: 'id-1', generation: 0, historyHeadSeq: 7 },
    sessionContinuityConfirmed: true,
    ...overrides,
  };
}

/** Gate input for a start of `workRole` that wants to resume `source`. */
function gateInput(source, rows, workRole, overrides = {}) {
  const isReview = workRole.startsWith('review_');
  const chats = new Map(rows.map((r) => [r.childChatId, { id: r.childChatId, claudeSessionId: `sess-${r.childChatId}` }]));
  return {
    resumeSessionOf: source.id,
    crossRoleSessions: true,
    workRole,
    parentChatId,
    assignment: isReview ? 'review' : 'implement',
    reviewSubject: isReview ? workRole.replace('review_', '') : '',
    reviewMode: '',
    sessionScope: 'leaf',
    leafId,
    executor: { transport: 'claude', model: MODEL, options: {} },
    executionMode: 'agent',
    executionFolder: '/tmp/wt',
    delegations: rows,
    findChat: (id) => chats.get(id) || null,
    capabilities: { canResumeSession: true },
    lockoutActive: false,
    isRunActive: () => false,
    currentContinuity: () => ({ ...source.sessionContinuity }),
    ...overrides,
  };
}

test('role pairs: only code review <-> implement/fix cross', () => {
  assert.equal(isCrossRoleSessionPair('review_code', 'implement'), true);
  assert.equal(isCrossRoleSessionPair('review_code', 'fix'), true);
  assert.equal(isCrossRoleSessionPair('fix', 'review_code'), true);
  assert.equal(isCrossRoleSessionPair('implement', 'review_code'), true);
  for (const [a, b] of [['review_plan', 'implement'], ['review_other', 'fix'], ['plan', 'review_code'], ['fix', 'review_plan'], ['implement', 'fix'], ['review_code', 'review_code']]) {
    assert.equal(isCrossRoleSessionPair(a, b), false, `${a} <- ${b}`);
  }
});

test('setting off: refusals keep their existing codes', () => {
  const impl = row('implement');
  const review = row('review_code', { childChatId: impl.childChatId });
  const rows = [impl, review];
  const fix = inspectDelegationSessionResume(gateInput(review, rows, 'fix', { crossRoleSessions: false }));
  assert.equal(fix.reasonCode, R.ROLE_CHANGED);
  const reviewStart = inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code', { crossRoleSessions: false }));
  assert.equal(reviewStart.reasonCode, R.SCOPE_CHANGED);
  assert.deepEqual(findCrossRoleResumeSources({ delegations: rows, parentChatId, leafId, workRole: 'plan', executor: impl.executor }), []);
});

test('fix after a code review re-enters the review chat; code review after implement re-enters the implement chat', () => {
  const impl = row('implement');
  const reviewStart = inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code'));
  assert.equal(reviewStart.resume, true, reviewStart.reasonCode);
  assert.equal(reviewStart.reasonCode, R.RESUMED_CROSS_ROLE);
  assert.equal(reviewStart.childChatId, impl.childChatId);
  assert.equal(reviewStart.round, 2);
  assert.equal(reviewStart.crossRole, true);
  assert.equal(reviewStart.sourceWorkRole, 'implement');
  const record = buildSessionResumeRecord(reviewStart, {});
  assert.equal(record.status, 'resumed');
  assert.equal(record.crossRole, true);
  assert.equal(record.sourceWorkRole, 'implement');
  assert.deepEqual(normalizeSessionResumeRecord(record), record, 'the stored shape keeps the card marker');
  assert.match(buildSessionResumePromptBlock(record), /CODE REVIEW \(read-only\)[\s\S]*current material/);

  const review = row('review_code');
  const fixStart = inspectDelegationSessionResume(gateInput(review, [review], 'fix'));
  assert.equal(fixStart.resume, true, fixStart.reasonCode);
  assert.equal(fixStart.reasonCode, R.RESUMED_CROSS_ROLE);
  assert.equal(fixStart.childChatId, review.childChatId);
  assert.equal(fixStart.workRole, 'fix');
  const fixRecord = buildSessionResumeRecord(fixStart, {});
  assert.match(buildSessionResumePromptBlock(fixRecord), /Your role is now FIX/);
  // A same-role resume carries no marker.
  const sameRole = buildSessionResumeRecord({ requested: true, resume: true, reasonCode: R.RESUMED, round: 2 });
  assert.equal(sameRole.crossRole, undefined);
});

test('negative cases keep falling back with their codes', () => {
  const impl = row('implement');
  const review = row('review_code');
  const otherLeaf = { leafId: randomUUID() };
  assert.equal(inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code', otherLeaf)).reasonCode, R.SCOPE_CHANGED);
  assert.equal(inspectDelegationSessionResume(gateInput(review, [review], 'fix', otherLeaf)).reasonCode, R.SCOPE_CHANGED);
  // Orchestrator scope never widens a cross-role reuse to another leaf.
  assert.equal(inspectDelegationSessionResume(gateInput(review, [review], 'fix', { ...otherLeaf, sessionScope: 'orchestrator' })).reasonCode, R.SCOPE_CHANGED);
  assert.equal(inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code', { parentChatId: randomUUID() })).reasonCode, R.SOURCE_NOT_FOUND);
  const otherParams = { executor: { transport: 'claude', model: 'claude-opus-5-5::effort=high', options: {} } };
  assert.equal(inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code', otherParams)).reasonCode, R.CONFIG_CHANGED);
  assert.equal(inspectDelegationSessionResume(gateInput(review, [review], 'fix', otherParams)).reasonCode, R.CONFIG_CHANGED);
  assert.equal(inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code', { isRunActive: () => true })).reasonCode, R.SOURCE_BUSY);
  const claimer = row('implement', { childChatId: impl.childChatId, status: 'running' });
  assert.equal(inspectDelegationSessionResume(gateInput(impl, [impl, claimer], 'review_code')).reasonCode, R.SOURCE_CLAIMED);
  // A code review source without a usable verdict is not a source.
  const noVerdict = row('review_code', { reportVerdict: '' });
  assert.equal(inspectDelegationSessionResume(gateInput(noVerdict, [noVerdict], 'fix')).reasonCode, R.SOURCE_UNUSABLE);
  // Plan roles and other review subjects never cross.
  assert.equal(inspectDelegationSessionResume(gateInput(review, [review], 'plan')).reasonCode, R.ROLE_CHANGED);
  const otherStart = inspectDelegationSessionResume(gateInput(impl, [impl], 'review_other'));
  assert.equal(otherStart.reasonCode, R.SCOPE_CHANGED);
  const planReview = inspectDelegationSessionResume(gateInput(impl, [impl], 'review_plan'));
  assert.equal(planReview.reasonCode, R.SCOPE_CHANGED);
  // A transport that failed the permission audit records its own reason.
  const testfakeb = { transport: 'testfakeb', model: 'testfakeb-chat', options: {} };
  const dsImpl = row('implement', { executor: testfakeb });
  const dsDecision = inspectDelegationSessionResume(gateInput(dsImpl, [dsImpl], 'review_code', {
    executor: testfakeb,
    findChat: (id) => ({ id, deepseekSessionId: 'ds' }),
  }));
  assert.equal(dsDecision.reasonCode, R.CROSS_ROLE_UNSUPPORTED);
  assert.equal(dsDecision.resume, false);
});

test('contamination stays limited to this leaf and controller', () => {
  const impl = row('implement');
  const foreign = row('implement', { childChatId: impl.childChatId, leafId: randomUUID(), queuedAt: new Date(clock - 3_600_000).toISOString() });
  const decision = inspectDelegationSessionResume(gateInput(impl, [foreign, impl], 'review_code'));
  assert.equal(decision.reasonCode, R.CONTAMINATED);
  const review = row('review_code');
  const planInChat = row('plan', { childChatId: review.childChatId, queuedAt: new Date(clock - 3_600_000).toISOString() });
  assert.equal(inspectDelegationSessionResume(gateInput(review, [planInChat, review], 'fix')).reasonCode, R.WORK_HISTORY);
});

test('independence: only the round implementer chat may be re-entered by a same-model reviewer', () => {
  // Chat A: model X implemented; chat B: model Z fixed later (round implementer).
  const implX = row('implement');
  const fixZ = row('fix', { executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} } });
  const rows = [implX, fixZ];
  assert.equal(findRoundImplementer({ delegations: rows, leafId })?.childChatId, fixZ.childChatId);
  const decision = inspectDelegationSessionResume(gateInput(implX, rows, 'review_code'));
  assert.equal(decision.reasonCode, R.INDEPENDENCE, 'reuse never raises independence');
  // A newer implement in ANOTHER chat after a resumed review moves the round away.
  const impl = row('implement');
  const crossReview = row('review_code', { childChatId: impl.childChatId, sessionResume: { status: 'resumed', sourceDelegationId: impl.id } });
  const laterImpl = row('implement');
  const next = inspectDelegationSessionResume(gateInput(crossReview, [impl, crossReview, laterImpl], 'review_code'));
  assert.equal(next.reasonCode, R.INDEPENDENCE);
});

test('round implementer equals the review sync choice (failed / cancelled / queued attempts, missing queuedAt)', () => {
  const leaf = randomUUID();
  const base = { leafId: leaf };
  const fixtures = [
    [row('implement', { ...base }), row('fix', { ...base, status: 'failed' })],
    [row('implement', { ...base }), row('fix', { ...base, status: 'cancelled' })],
    [row('implement', { ...base }), row('fix', { ...base, status: 'queued', attemptId: randomUUID() })],
    [row('fix', { ...base, queuedAt: '', startedAt: nextStamp() }), row('implement', { ...base })],
    [row('implement', { ...base, queuedAt: '', startedAt: '' }), row('fix', { ...base, queuedAt: '', startedAt: '' })],
    [row('implement', { ...base }), row('review_code', { ...base }), row('implement', { ...base, executor: { transport: 'codex', model: 'gpt-6-astra', options: {} } })],
  ];
  for (const rows of fixtures) {
    const withAttempts = rows.map((r) => ({ ...r, attemptId: r.attemptId || randomUUID() }));
    const snapshot = buildTodoReviewSnapshot({ leafId: leaf, rows: withAttempts });
    const helper = findRoundImplementer({ delegations: withAttempts, leafId: leaf });
    assert.equal(helper?.delegationId || null, snapshot.code.implementer?.delegationId || null);
    assert.equal(helper?.attemptId || null, snapshot.code.implementer?.attemptId || null);
  }
  assert.equal(findRoundImplementer({ delegations: [], leafId: leaf }), null);
});

test('a cross-role review is never independent in the server snapshot (same model, or auto = unknown)', () => {
  const leaf = randomUUID();
  const impl = row('implement', { leafId: leaf, attemptId: randomUUID(), startedAt: nextStamp(), finishedAt: nextStamp() });
  const review = row('review_code', {
    leafId: leaf,
    childChatId: impl.childChatId,
    attemptId: randomUUID(),
    startedAt: nextStamp(),
    finishedAt: nextStamp(),
    reportVerdict: 'PASS',
    verdict: 'PASS',
    report: 'TASK: review\nVERDICT: PASS',
    sessionResume: { requested: true, status: 'resumed', reasonCode: R.RESUMED_CROSS_ROLE, crossRole: true, sourceWorkRole: 'implement' },
  });
  const snapshot = buildTodoReviewSnapshot({ leafId: leaf, rows: [impl, review] });
  const reviewer = snapshot.code.reviewers.find((r) => r.delegationId === review.id);
  assert.equal(reviewer?.independence, 'same_model_same_harness');
  assert.equal(snapshot.code.independence.independent, false);
  const auto = (r) => ({ ...r, executor: { ...r.executor, model: 'auto' } });
  const autoSnapshot = buildTodoReviewSnapshot({ leafId: leaf, rows: [auto(impl), auto(review)] });
  assert.equal(autoSnapshot.code.reviewers.find((r) => r.delegationId === review.id)?.independence, 'unknown');
  assert.equal(autoSnapshot.code.independence.independent, false);
});

test('candidate lookup: one per chat, decided by the latest finished row, newest first', () => {
  const impl = row('implement');
  const reviewInImplChat = row('review_code', { childChatId: impl.childChatId });
  const reviewChat = row('review_code');
  const otherController = row('review_code', { parentChatId: randomUUID() });
  const otherLeaf = row('review_code', { leafId: randomUUID() });
  const otherModel = row('review_code', { executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} } });
  const rows = [impl, reviewInImplChat, reviewChat, otherController, otherLeaf, otherModel];
  const executor = { transport: 'claude', model: MODEL, options: {} };
  assert.deepEqual(
    findCrossRoleResumeSources({ delegations: rows, parentChatId, leafId, workRole: 'fix', executor }),
    [reviewChat.id, reviewInImplChat.id],
  );
  // The implement chat's latest row is a review, so a review start finds no implement source.
  assert.deepEqual(findCrossRoleResumeSources({ delegations: rows, parentChatId, leafId, workRole: 'review_code', executor }), []);
  assert.deepEqual(findCrossRoleResumeSources({ delegations: rows, parentChatId, leafId: '', workRole: 'fix', executor }), []);
});

test('fan-out: two simultaneous reviews cannot both claim one chat', () => {
  const impl = row('implement');
  const first = inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code'));
  assert.equal(first.resume, true);
  const claimed = row('review_code', { childChatId: impl.childChatId, status: 'queued', queuedAt: nextStamp() });
  const second = inspectDelegationSessionResume(gateInput(impl, [impl, claimed], 'review_code'));
  assert.equal(second.resume, false);
  assert.equal(second.reasonCode, R.SOURCE_CLAIMED);
});

test('testfake is not a cross-role transport: its permission sync is not fail-closed', () => {
  const executor = { transport: 'testfake', model: MODEL, options: {} };
  const impl = row('implement', { executor });
  const decision = inspectDelegationSessionResume(gateInput(impl, [impl], 'review_code', { executor }));
  assert.equal(decision.resume, false);
  assert.equal(decision.reasonCode, R.CROSS_ROLE_UNSUPPORTED);
});

test('orchestrator scope: a cross-role chat holding another leaf work rows is refused', () => {
  const otherLeaf = randomUUID();
  const implA = row('implement', { leafId: otherLeaf });
  const reviewB = row('review_code', { childChatId: implA.childChatId });
  const rows = [implA, reviewB];
  const scoped = { sessionScope: 'orchestrator' };
  const refused = inspectDelegationSessionResume(gateInput(reviewB, rows, 'fix', scoped));
  assert.equal(refused.resume, false);
  assert.equal(refused.reasonCode, R.WORK_HISTORY);
  // Same leaf for every row of the chat still resumes under the orchestrator scope.
  const implB = row('implement');
  const reviewSame = row('review_code', { childChatId: implB.childChatId });
  const ok = inspectDelegationSessionResume(gateInput(reviewSame, [implB, reviewSame], 'fix', scoped));
  assert.equal(ok.resume, true, ok.reasonCode);
  // Setting off: the non-cross orchestrator behaviour is unchanged (leaf not checked on work rows).
  const implA2 = row('implement', { leafId: otherLeaf });
  const off = inspectDelegationSessionResume(gateInput(implA2, [implA2], 'fix', { ...scoped, crossRoleSessions: false }));
  assert.equal(off.resume, true, off.reasonCode);
});
