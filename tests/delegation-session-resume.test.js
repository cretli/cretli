import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import {
  buildSessionResumeRecord,
  inspectDelegationSessionResume,
  SESSION_RESUME_REASON as R,
} from '../lib/delegation-session-resume.js';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import { inspectReviewRecheckWithoutChange } from '../lib/delegation-review-recheck-gate.js';
import { bindRoomToDelegation, syncRoomDelegationAssignment } from '../lib/delegation-run-bridge.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const parentChatId = randomUUID();
const leafId = randomUUID();
const MODEL = 'claude-opus-5-5::effort=low';

/** One finished reviewer row bound to its own child chat. */
function reviewRow(overrides = {}) {
  return {
    id: randomUUID(),
    parentChatId,
    childChatId: randomUUID(),
    leafId,
    assignment: 'review',
    reviewSubject: 'plan',
    reviewMode: '',
    status: 'completed',
    reportVerdict: 'PASS',
    executionMode: 'agent',
    executionFolder: '/tmp/wt',
    planReviewerPhase: 'independent',
    executor: { transport: 'claude', model: MODEL, options: {} },
    sessionContinuity: { identity: randomUUID(), generation: 0, historyHeadSeq: 7 },
    sessionContinuityConfirmed: true,
    ...overrides,
  };
}

/** Gate input for a plan-review start that wants to resume `source`. */
function gateInput(source, rows, overrides = {}) {
  const chats = new Map(rows.map((row) => [row.childChatId, { id: row.childChatId, claudeSessionId: `sess-${row.childChatId}` }]));
  return {
    resumeSessionOf: source.id,
    parentChatId,
    assignment: 'review',
    reviewSubject: 'plan',
    reviewMode: '',
    leafId,
    executor: { transport: 'claude', model: MODEL, options: {} },
    executionMode: 'agent',
    executionFolder: '/tmp/wt',
    planReviewerPhase: 'independent',
    delegations: rows,
    findChat: (id) => chats.get(id) || null,
    capabilities: { canResumeSession: true },
    lockoutActive: false,
    isRunActive: () => false,
    currentContinuity: () => ({ ...source.sessionContinuity }),
    ...overrides,
  };
}

// --- default: nothing requested means nothing changes ----------------------
{
  const source = reviewRow();
  const decision = inspectDelegationSessionResume(gateInput(source, [source], { resumeSessionOf: '' }));
  assert.equal(decision.requested, false);
  assert.equal(decision.resume, false);
  assert.equal(buildSessionResumeRecord(decision), null);
}

// --- a pair keeps the right two sessions; each round is a new delegation ---
{
  const slotA = reviewRow();
  const slotB = reviewRow({ executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} } });
  const rows = [slotA, slotB];
  const a = inspectDelegationSessionResume(gateInput(slotA, rows));
  const b = inspectDelegationSessionResume(gateInput(slotB, rows, {
    executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} },
  }));
  assert.equal(a.resume, true);
  assert.equal(b.resume, true);
  assert.equal(a.childChatId, slotA.childChatId);
  assert.equal(b.childChatId, slotB.childChatId);
  assert.notEqual(a.childChatId, b.childChatId);
  assert.equal(a.round, 2);
  const record = buildSessionResumeRecord(a);
  assert.equal(record.status, 'resumed');
  assert.equal(record.sourceDelegationId, slotA.id);
  // The next round chains from the resumed row, not from the first one.
  const roundTwo = reviewRow({ childChatId: slotA.childChatId, sessionResume: record });
  const next = inspectDelegationSessionResume(gateInput(roundTwo, [roundTwo, slotB]));
  assert.equal(next.resume, true);
  assert.equal(next.round, 3);
  assert.equal(next.childChatId, slotA.childChatId);
}

// --- full round chain: a newer resumed row is not superseded by its source --
{
  // The whole history is present: the original review (slotA), the resumed
  // round on slotA's chat (roundTwo) and the peer (slotB). Resuming roundTwo
  // must chain forward from slotA's chat; the OLDER slotA row must not report
  // `resume_source_superseded` just because it shares the chat.
  const slotA = reviewRow({ queuedAt: '2026-02-01T00:00:00Z' });
  const roundTwo = reviewRow({
    childChatId: slotA.childChatId,
    sessionContinuity: { ...slotA.sessionContinuity },
    queuedAt: '2026-02-02T00:00:00Z',
    sessionResume: {
      requested: true,
      status: 'resumed',
      reasonCode: R.RESUMED,
      reason: 'ok',
      sourceDelegationId: slotA.id,
      round: 2,
      sessionGeneration: 0,
    },
  });
  const slotB = reviewRow({
    queuedAt: '2026-02-01T12:00:00Z',
    executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} },
  });
  const rows = [slotA, roundTwo, slotB];
  const next = inspectDelegationSessionResume(gateInput(roundTwo, rows));
  assert.equal(next.resume, true);
  assert.notEqual(next.reasonCode, R.SOURCE_SUPERSEDED);
  assert.equal(next.round, 3);
  assert.equal(next.childChatId, slotA.childChatId);
  // The negative path stays covered: naming the older row still supersedes.
  const stale = inspectDelegationSessionResume(gateInput(slotA, rows));
  assert.equal(stale.resume, false);
  assert.equal(stale.reasonCode, R.SOURCE_SUPERSEDED);
}

// --- hard exclusions force a new chat with a reason; the peer stays --------
{
  const slotA = reviewRow();
  const slotB = reviewRow({ executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} } });
  const rows = [slotA, slotB];
  const lockedA = inspectDelegationSessionResume(gateInput(slotA, rows, { lockoutActive: true }));
  assert.equal(lockedA.resume, false);
  assert.equal(lockedA.reasonCode, R.LOCKED_OUT);
  assert.ok(lockedA.reason.length > 10);
  const recorded = buildSessionResumeRecord(lockedA, { generation: 0 });
  assert.equal(recorded.status, 'fallback');
  assert.equal(recorded.reasonCode, R.LOCKED_OUT);
  const stillB = inspectDelegationSessionResume(gateInput(slotB, rows, {
    executor: { transport: 'claude', model: 'claude-sonnet-5-5', options: {} },
  }));
  assert.equal(stillB.resume, true);
  assert.equal(stillB.childChatId, slotB.childChatId);

  const implementer = {
    id: randomUUID(),
    parentChatId,
    leafId,
    assignment: 'implement',
    status: 'completed',
    executor: { transport: 'codex', model: 'claude-opus-5-5' },
  };
  const independence = inspectDelegationSessionResume(gateInput(slotA, [...rows, implementer]));
  assert.equal(independence.reasonCode, R.INDEPENDENCE);
  assert.equal(independence.resume, false);

  const changed = inspectDelegationSessionResume(gateInput(slotA, rows, {
    executor: { transport: 'claude', model: 'claude-opus-5-5::effort=high', options: {} },
  }));
  assert.equal(changed.reasonCode, R.CONFIG_CHANGED);
  const folder = inspectDelegationSessionResume(gateInput(slotA, rows, { executionFolder: '/tmp/other' }));
  assert.equal(folder.reasonCode, R.CONFIG_CHANGED);
  const scope = inspectDelegationSessionResume(gateInput(slotA, rows, { reviewSubject: 'code' }));
  assert.equal(scope.reasonCode, R.SCOPE_CHANGED);
  const otherLeaf = inspectDelegationSessionResume(gateInput(slotA, rows, { leafId: randomUUID() }));
  assert.equal(otherLeaf.reasonCode, R.SCOPE_CHANGED);
  const notReview = inspectDelegationSessionResume(gateInput(slotA, rows, { assignment: 'implement' }));
  assert.equal(notReview.reasonCode, R.REVIEW_ONLY);
}

// --- no resume capability, reset, restart, cancel, busy, missing -----------
{
  const source = reviewRow();
  const rows = [source];
  const expect = (overrides, code) => {
    const decision = inspectDelegationSessionResume(gateInput(source, rows, overrides));
    assert.equal(decision.resume, false, code);
    assert.equal(decision.reasonCode, code);
  };
  expect({ capabilities: { canResumeSession: false } }, R.UNSUPPORTED);
  expect({ currentContinuity: () => ({ ...source.sessionContinuity, generation: 1 }) }, R.SESSION_RESET);
  expect({ currentContinuity: () => ({ ...source.sessionContinuity, historyHeadSeq: 8 }) }, R.WORK_HISTORY);
  expect({ currentContinuity: () => null }, R.CONTINUITY_UNKNOWN);
  for (const confirmed of [undefined, false, null]) {
    const legacy = { ...source, sessionContinuityConfirmed: confirmed };
    const decision = inspectDelegationSessionResume(gateInput(legacy, [legacy]));
    assert.equal(decision.resume, false);
    assert.equal(decision.reasonCode, R.CONTINUITY_UNKNOWN);
  }
  expect({ isRunActive: () => true }, R.SOURCE_BUSY);
  expect({ findChat: () => null }, R.CHAT_MISSING);
  expect({ findChat: (id) => ({ id }) }, R.SESSION_MISSING);
  expect({ resumeSessionOf: randomUUID() }, R.SOURCE_NOT_FOUND);
  expect({ parentChatId: randomUUID() }, R.SOURCE_NOT_FOUND);
  const gate = (patch) => inspectDelegationSessionResume(gateInput({ ...source, ...patch }, [{ ...source, ...patch }]));
  assert.equal(gate({ status: 'running' }).reasonCode, R.SOURCE_BUSY);
  assert.equal(gate({ status: 'cancelled' }).reasonCode, R.SOURCE_CANCELLED);
  assert.equal(gate({ status: 'interrupted' }).reasonCode, R.AFTER_RESTART);
  assert.equal(gate({ status: 'failed' }).reasonCode, R.SOURCE_UNUSABLE);
  assert.equal(gate({ reportVerdict: '' }).reasonCode, R.SOURCE_UNUSABLE);
}

// --- concurrent start never shares an active session -----------------------
{
  const source = reviewRow();
  const first = inspectDelegationSessionResume(gateInput(source, [source]));
  assert.equal(first.resume, true);
  // The first start's queued row now owns the chat.
  const claim = reviewRow({ childChatId: source.childChatId, status: 'queued', reportVerdict: '' });
  const second = inspectDelegationSessionResume(gateInput(source, [source, claim]));
  assert.equal(second.resume, false);
  assert.equal(second.reasonCode, R.SOURCE_CLAIMED);
}

// --- independent phase never inherits peer opinions ------------------------
{
  const exchanged = reviewRow({ planReviewerPhase: 'exchange', exchangeOfDelegationId: randomUUID() });
  const leaked = inspectDelegationSessionResume(gateInput(exchanged, [exchanged]));
  assert.equal(leaked.reasonCode, R.PEER_CONTEXT);
  const fine = inspectDelegationSessionResume(gateInput(exchanged, [exchanged], { planReviewerPhase: 'exchange' }));
  assert.equal(fine.resume, true);
  const prompt = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review the plan',
    executionMode: 'agent',
    assignment: 'review',
    sessionResume: { round: 2 },
  });
  assert.match(prompt.prompt, /\[RESUMED REVIEW ROUND 2\]/);
  assert.match(prompt.prompt, /does not apply to the current material/);
  assert.doesNotMatch(prompt.prompt, /PEER|peer/);
}

// --- unchanged material still hits the recheck gate ------------------------
{
  const reviewed = {
    ...reviewRow({ reviewSubject: 'code', queuedAt: new Date(Date.now() - 60000).toISOString() }),
  };
  const refused = inspectReviewRecheckWithoutChange({
    parentChatId,
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    executor: reviewed.executor,
  });
  // No rows in the store for this controller yet: allowed.
  assert.equal(refused.ok, true);
  const parent = addChat(`sess-${randomUUID()}`, 'Parent', null, '/tmp', 'model', { agentTransport: 'claude' });
  const stored = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: randomUUID(),
    status: 'completed',
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    executionMode: 'agent',
    sourceKind: 'text',
    executor: { transport: 'claude', model: MODEL },
  });
  const storedRow = getDelegationById(stored.id);
  assert.ok(storedRow);
  // Mark it finished with a usable verdict via a direct persist update.
  const { updateDelegationRecord } = await import('../lib/persist/delegations-persist.js');
  updateDelegationRecord(stored.id, { status: 'completed', reportVerdict: 'PASS' });
  const gate = inspectReviewRecheckWithoutChange({
    parentChatId: parent.id,
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    executor: { transport: 'claude', model: MODEL },
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'review_recheck_no_material_change');
}

// --- persistence + read-only re-binding of a re-entered chat ---------------
{
  const parent = addChat(`sess-${randomUUID()}`, 'Parent', null, '/tmp', 'model', { agentTransport: 'claude', sdkMode: 'agent' });
  const child = addChat(`sess-${randomUUID()}`, 'Child (review)', null, '/tmp', 'model', {
    agentTransport: 'claude',
    sdkMode: 'agent',
    forkParentChatId: parent.id,
    forkKind: 'delegation',
    delegationParentChatId: parent.id,
    delegationAssignment: 'review',
  });
  const first = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    status: 'completed',
    assignment: 'review',
    executionMode: 'agent',
    sourceKind: 'text',
  });
  const second = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    status: 'running',
    assignment: 'review',
    executionMode: 'agent',
    sourceKind: 'text',
    sessionResume: {
      requested: true,
      status: 'resumed',
      reasonCode: 'resumed',
      reason: 'ok',
      sourceDelegationId: first.id,
      round: 2,
      sessionGeneration: 0,
    },
  });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.attemptId, second.attemptId);
  assert.equal(getDelegationById(second.id).sessionResume.sourceDelegationId, first.id);
  assert.equal(getDelegationById(first.id).sessionResume, null);
  updateChat(child.id, { delegationId: second.id, delegationAssignment: 'review', sdkMode: 'agent' });
  assert.equal(loadChats().find((row) => row.id === child.id).delegationId, second.id);
  const room = { chatId: child.id, sdkMode: 'agent' };
  bindRoomToDelegation(room, { delegationId: second.id, attemptId: second.attemptId, assignment: 'review' });
  assert.equal(room.delegationId, second.id);
  assert.equal(room.delegationAssignment, 'review');
  assert.equal(syncRoomDelegationAssignment(room), 'review');
}

// --- prefix stability: per-round data never moves the stable head ----------
{
  const base = {
    sourceKind: 'text',
    executionMode: 'agent',
    assignment: 'review',
    parentChatId,
  };
  const roundOne = buildDelegationExecutorPrompt({
    ...base, taskText: 'Round one body', delegationId: randomUUID(), leafMaterialText: 'material A',
  });
  const roundTwo = buildDelegationExecutorPrompt({
    ...base,
    taskText: 'Round two body with a different, longer task',
    delegationId: randomUUID(),
    leafMaterialText: 'material B',
    sessionResume: { round: 2 },
  });
  assert.equal(roundOne.prefixFingerprint, roundTwo.prefixFingerprint);
  assert.ok(roundOne.prompt.startsWith(roundOne.stablePrefix));
  assert.ok(roundTwo.prompt.startsWith(roundTwo.stablePrefix));
  assert.equal(roundOne.stablePrefix, roundTwo.stablePrefix);
  // The round block is appended at the very end.
  assert.ok(roundTwo.prompt.trimEnd().endsWith(roundTwo.prompt.slice(roundTwo.prompt.indexOf('[RESUMED REVIEW ROUND 2]')).trimEnd()));
  assert.ok(roundTwo.prompt.indexOf('Round two body') < roundTwo.prompt.indexOf('[RESUMED REVIEW ROUND 2]'));
  // A different role/mode configuration is a different prefix, deterministically.
  const implement = buildDelegationExecutorPrompt({ ...base, assignment: 'implement', taskText: 'x' });
  assert.notEqual(implement.prefixFingerprint, roundOne.prefixFingerprint);
  const again = buildDelegationExecutorPrompt({ ...base, taskText: 'Round one body', delegationId: randomUUID() });
  assert.equal(again.prefixFingerprint, roundOne.prefixFingerprint);
}

// --- closure code review keeps the sticky audit reviewer -------------------
{
  const chatId = randomUUID();
  const now = Date.now();
  const history = buildModelPickHistory({
    role: 'review',
    chatId,
    leafId,
    codeReviewAuditDone: true,
    codeReviewAuditReviewer: `claude/${MODEL}`,
    delegations: [
      {
        parentChatId: chatId,
        leafId,
        status: 'completed',
        assignment: 'review',
        pickRole: 'review',
        executor: { transport: 'claude', model: MODEL },
        reviewMode: 'audit',
        reportVerdict: 'PASS',
        report: 'VERDICT: PASS',
        // A resume record on the audit row must not change the semantics.
        sessionResume: { requested: true, status: 'resumed', round: 2 },
        createdAt: new Date(now - 120000).toISOString(),
      },
      {
        parentChatId: chatId,
        status: 'completed',
        assignment: 'implement',
        pickRole: 'implement',
        executor: { transport: 'testfakeb', model: 'testfakeb-chat' },
        createdAt: new Date(now - 180000).toISOString(),
      },
    ],
    harnesses: ['claude', 'testfakeb'],
    now,
  });
  assert.equal(history.leafReviewSticky.key, `claude/${MODEL}`);
  const picked = selectModelPick({
    role: 'review',
    harnesses: [
      { id: 'claude', enabled: true, ready: true, can_delegate: true },
      { id: 'testfakeb', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: {
      claude: { favorites_configured: true, items: [{ id: MODEL, available: true, roles: ['review'] }] },
      testfakeb: { favorites_configured: true, items: [{ id: 'testfakeb-chat', available: true, roles: ['review'] }] },
    },
    history,
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.model, MODEL);
}

console.log('delegation-session-resume.test.js OK');

// --- fix round: F1 superseded source, F2 grant drift, F3 tail reminder ---
{
  const r1 = reviewRow({ queuedAt: '2026-01-01T00:00:00Z', sessionResume: { status: 'resumed', round: 2, sourceDelegationId: 'x' } });
  const r2 = reviewRow({
    childChatId: r1.childChatId,
    planReviewerPhase: 'exchange',
    queuedAt: '2026-01-02T00:00:00Z',
    sessionResume: { status: 'resumed', round: 3, sourceDelegationId: r1.id },
  });
  const rows = [r1, r2];
  const stale = inspectDelegationSessionResume(gateInput(r1, rows));
  assert.equal(stale.resume, false);
  assert.equal(stale.reasonCode, R.SOURCE_SUPERSEDED);
  // Latest row that saw the exchange phase still refuses an independent start.
  const peer = inspectDelegationSessionResume(gateInput(r2, rows));
  assert.equal(peer.resume, false);
  assert.equal(peer.reasonCode, R.PEER_CONTEXT);
}
{
  const src = reviewRow({ allowChildDelegations: true, depth: 1, rootChatId: parentChatId });
  const rows = [src];
  const drift = inspectDelegationSessionResume(gateInput(src, rows, { allowChildDelegations: false, depth: 1, rootChatId: parentChatId }));
  assert.equal(drift.resume, false);
  assert.equal(drift.reasonCode, R.CONFIG_CHANGED);
  const same = inspectDelegationSessionResume(gateInput(src, rows, { allowChildDelegations: true, depth: 1, rootChatId: parentChatId }));
  assert.equal(same.resume, true);
}
{
  const out = buildDelegationExecutorPrompt({
    sourceKind: 'plan', planMarkdown: '# Plan', assignment: 'review', executionMode: 'agent',
  });
  assert.ok(out.ok);
  assert.ok(out.prompt.trimEnd().endsWith('as specified in the report instructions above.'));
  assert.ok(out.prompt.startsWith(out.stablePrefix));
  assert.ok(!out.stablePrefix.includes('[REPORT REMINDER]'));
}

// --- optional resume_context_cap_rounds (default off) -----------------------
{
  const first = reviewRow();
  const record = buildSessionResumeRecord(inspectDelegationSessionResume(gateInput(first, [first])));
  const second = reviewRow({ childChatId: first.childChatId, sessionResume: record });
  const rows = [second];
  // Off by default: a missing, zero or invalid cap never changes the decision.
  for (const cap of [undefined, 0, -1, Number.NaN]) {
    const off = inspectDelegationSessionResume(gateInput(second, rows, { resumeContextCapRounds: cap }));
    assert.equal(off.resume, true);
    assert.equal(off.round, 3);
  }
  // A cap that still fits the next round resumes.
  assert.equal(inspectDelegationSessionResume(gateInput(second, rows, { resumeContextCapRounds: 3 })).resume, true);
  // Exceeded: fresh session with the stable reason code, recorded as a fallback.
  const capped = inspectDelegationSessionResume(gateInput(second, rows, { resumeContextCapRounds: 2 }));
  assert.equal(capped.resume, false);
  assert.equal(capped.reasonCode, 'resume_context_cap');
  assert.equal(capped.reasonCode, R.RESUME_CONTEXT_CAP);
  assert.ok(capped.reason.includes('resume_context_cap_rounds'));
  const recorded = buildSessionResumeRecord(capped, { generation: 0 });
  assert.equal(recorded.status, 'fallback');
  assert.equal(recorded.reasonCode, 'resume_context_cap');
}
// The same cap applies to plan / implement / fix starts.
{
  const implement = {
    ...reviewRow({ assignment: 'implement', reviewSubject: '', reportVerdict: '' }),
    workRole: 'implement',
    sessionResume: { status: 'resumed', round: 2, reasonCode: 'resumed' },
  };
  const work = (overrides) => inspectDelegationSessionResume(gateInput(implement, [implement], {
    assignment: 'implement', workRole: 'fix', reviewSubject: '', ...overrides,
  }));
  assert.equal(work({}).resume, true);
  assert.equal(work({ resumeContextCapRounds: 3 }).resume, true);
  const capped = work({ resumeContextCapRounds: 2 });
  assert.equal(capped.resume, false);
  assert.equal(capped.reasonCode, R.RESUME_CONTEXT_CAP);
}
