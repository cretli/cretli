/**
 * Start-path reuse of plan / implement / fix sessions: the Settings switches
 * decide, the gate validates, every return is a NEW delegation/attempt, and
 * nothing crosses leaves, roles or into review history.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
process.env.CRETLI_LEAF_MATERIAL_CHECKPOINT = '0';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { addTodo } from '../lib/persist/todos-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-service.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { clearDelegationEnvCache } from '../lib/delegation-settings.js';
import {
  createDelegationService,
  finishDelegation,
  refreshFinishedDelegationSessionContinuity,
} from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, resetMockChatRuns, getMockChatRun, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';
import { releaseDelegationOwnerLock } from '../lib/delegation-owner-lock.js';
import { confirmDurableFinish, createDurableFinishRoom } from './helpers/delegation-durable-finish.js';
import { readCurrentSessionContinuity } from '../lib/delegation-session-continuity.js';
import { discardBufferedHistory } from '../lib/persist/history-room-flusher.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { CONTEXT_RESTART_REASON, recordContextRestart, resetContextRestartsForTests } from '../lib/usage/context-restarts.ts';
import { resetCacheStateForTests } from '../lib/usage/cache-state.ts';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
stopDelegationRuntimeWorker();

const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
});
const parent = addChat(randomUUID(), 'work-resume-parent', null, workspace, 'opencode/orchestrator', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const leafA = randomUUID();
const leafB = randomUUID();
const leafReset = randomUUID();
const leafHistory = randomUUID();
const leafBridge = randomUUID();
const execFileAsync = promisify(execFile);

async function startAfterProcessRestart(leafId) {
  releaseDelegationOwnerLock({ dataDir: workspace });
  const { stdout } = await execFileAsync(process.execPath, [
    new URL('./fixtures/delegation-work-resume-restart.mjs', import.meta.url).pathname,
    parent.id, leafId, workspace,
  ], { env: { ...process.env, CRETLI_TEST_DATA_DIR: workspace, CRETLI_DATA_DIR: workspace } });
  return JSON.parse(stdout);
}

function setSwitches(patch) {
  saveDelegationSettings(workspace, patch, { dataDir: workspace });
  clearDelegationEnvCache();
}

const ROLE_INPUT = {
  plan: { assignment: 'implement', requestedRole: 'plan', executionMode: 'plan' },
  implement: { assignment: 'implement', executionMode: 'agent' },
  fix: { assignment: 'fix', requestedRole: 'fix', executionMode: 'agent' },
  review: { assignment: 'review', reviewSubject: 'code', executionMode: 'agent' },
};

// Cache view stub mirroring freshness.cache.{state,reason}; unset chats are unknown.
const cacheByChat = new Map();
const guardService = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
  buildChatCacheView: (chatId) => ({
    freshness: { cache: cacheByChat.get(chatId) || { state: 'unknown', reason: 'no_cached_turn' } },
  }),
});
let activeService = service;
const hasEmptyReportBlock = (row) => row.sessionResume?.reasonCode === 'work_previous_empty_report';

async function start(role, leafId, overrides = {}) {
  const { keepOpen = false, ...rest } = overrides;
  const result = await activeService.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: `${role} task ${randomUUID()}`,
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: randomUUID(),
    // These flows reuse one executor across roles on purpose.
    allowSameModelReview: true,
    leafId,
    resumeRounds: true,
    returnWhenStarting: false,
    ...ROLE_INPUT[role],
    ...rest,
  });
  assert.equal(result.ok, true, `${role}: ${result.error || result.code}`);
  assert.ok(!result.queued, `${role} parked behind: ${JSON.stringify(result.queueConflict)}`);
  const row = result.delegation;
  if (!keepOpen) await finish(row);
  return row;
}

async function finish(row, outcome = {}) {
  patchMockChatRun(row.childChatId, { busy: false });
  const done = finishDelegation(row, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS\nok', ...outcome });
  updateChat(row.childChatId, { opencodeSessionId: `oc-${row.childChatId}` });
  await confirmDurableFinish(done);
  return getDelegationById(done.id);
}

// 1. Defaults: implement/fix reuse is on (scope leaf), plan stays opt-in; roles are classified.
const impl1 = await start('implement', leafA);
assert.equal(impl1.workRole, 'implement');
assert.equal(impl1.continuationPolicy.enabled, true);
assert.equal(impl1.continuationPolicy.source, 'default');
assert.equal(impl1.continuationPolicy.scope, 'leaf');
assert.equal(impl1.sessionResume.status, 'fresh', 'no earlier chat to return to');
const implDefaultResumed = await start('implement', leafA);
assert.equal(implDefaultResumed.sessionResume.status, 'resumed', JSON.stringify(implDefaultResumed.sessionResume));
assert.equal(implDefaultResumed.childChatId, impl1.childChatId, 'default resumes the leaf chat');
// An explicitly stored false wins over the new default: fresh chat, nothing reused.
setSwitches({ continue_implement_sessions: false, continue_fix_sessions: false });
const implFresh = await start('implement', leafA);
assert.equal(implFresh.continuationPolicy.enabled, false);
assert.equal(implFresh.continuationPolicy.source, 'workspace');
assert.notEqual(implFresh.childChatId, impl1.childChatId, 'explicit off is a fresh chat');
assert.equal(implFresh.sessionResume.reasonCode, 'work_fresh_by_policy');
assert.equal(implFresh.sessionResume.status, 'fresh');

// 2. Implement on: same leaf resumes automatically as a NEW delegation + attempt.
setSwitches({ continue_implement_sessions: true });
const implResumed = await start('implement', leafA);
assert.equal(implResumed.sessionResume.status, 'resumed', JSON.stringify(implResumed.sessionResume));
assert.equal(implResumed.childChatId, implFresh.childChatId);
assert.notEqual(implResumed.id, implFresh.id);
assert.notEqual(implResumed.attemptId, implFresh.attemptId);
assert.equal(implResumed.sessionResume.workRole, 'implement');
assert.equal(implResumed.verdict || '', '', 'no inherited verdict');
assert.match(getMockChatRun(implResumed.childChatId).prompt, /\[RESUMED IMPLEMENT SESSION, ROUND 2\]/);
assert.equal(getDelegationById(implFresh.id).sessionResume.status, 'fresh', 'the earlier row is never rewritten');

// 3. Another leaf never shares the chat.
const implOtherLeaf = await start('implement', leafB);
assert.notEqual(implOtherLeaf.childChatId, implResumed.childChatId);
assert.equal(implOtherLeaf.sessionResume.reasonCode, 'work_no_eligible_source');

// 4. implement -> fix is only allowed when the FIX switch is on.
const fixFresh = await start('fix', leafA);
assert.equal(fixFresh.workRole, 'fix');
assert.equal(fixFresh.sessionResume.reasonCode, 'work_fresh_by_policy');
assert.notEqual(fixFresh.childChatId, implResumed.childChatId);
setSwitches({ continue_fix_sessions: true });
const fixResumed = await start('fix', leafA);
assert.equal(fixResumed.sessionResume.status, 'resumed', JSON.stringify(fixResumed.sessionResume));
// Newest finished implement/fix of the leaf is the fix chat -> fix -> fix.
assert.equal(fixResumed.childChatId, fixFresh.childChatId);

// 5. A review never joins a work chat and a work start never joins a review chat.
setSwitches({ reviewer_policy: { code: { selection: 'auto', members_source: 'learned', members: [], session: 'leaf' } } });
const review = await start('review', leafA);
assert.equal(review.workRole, 'review_code');
assert.notEqual(review.childChatId, fixResumed.childChatId);
const implAfterReview = await start('implement', leafA);
assert.notEqual(implAfterReview.childChatId, review.childChatId);

// 6. Plan authoring is classified apart from plan review and has its own switch.
const plan1 = await start('plan', leafA);
assert.equal(plan1.workRole, 'plan');
assert.equal(plan1.sessionResume.reasonCode, 'work_fresh_by_policy');
setSwitches({ continue_plan_sessions: true });
const plan2 = await start('plan', leafA);
assert.equal(plan2.sessionResume.status, 'resumed', JSON.stringify(plan2.sessionResume));
assert.equal(plan2.childChatId, plan1.childChatId);
const implAfterPlan = await start('implement', leafA);
assert.notEqual(implAfterPlan.childChatId, plan1.childChatId, 'plan history never becomes implement history');

// 7. A context reset advances a durable generation across a new Node process.
const beforeReset = await start('implement', leafReset);
recordContextRestart({
  chatId: beforeReset.childChatId,
  harness: 'opencode',
  reason: CONTEXT_RESTART_REASON.PROCESS_RECREATED,
});
assert.equal(
  loadChats().find((chat) => chat.id === beforeReset.childChatId)?.delegationSessionGeneration,
  1,
  'generation is durable before runtime state is discarded',
);
resetCacheStateForTests();
resetContextRestartsForTests();
const afterReset = await startAfterProcessRestart(leafReset);
assert.equal(afterReset.ok, true);
assert.notEqual(afterReset.childChatId, beforeReset.childChatId);
assert.equal(afterReset.sessionResume.reasonCode, 'resume_session_reset');

// 8. A normal user turn in the child chat after the delegation finished is
// foreign history, even though it creates no delegation row.
const beforeForeignTurn = await start('implement', leafHistory);
await appendChatHistoryEvents(beforeForeignTurn.childChatId, `oc-${beforeForeignTurn.childChatId}`, [
  { rec: { kind: 'localUser', text: 'Unrelated follow-up after the delegation finished.' } },
]);
const afterForeignTurn = await start('implement', leafHistory);
assert.notEqual(afterForeignTurn.childChatId, beforeForeignTurn.childChatId);
assert.equal(afterForeignTurn.sessionResume.reasonCode, 'resume_foreign_history');

// 9. The production run bridge moves the source boundary only after its final
// history record has committed; that system-owned record must not look like an
// unrelated user turn on the next start.
const bridgeSource = await start('implement', leafBridge, { keepOpen: true });
const liveBridgeSource = getDelegationById(bridgeSource.id);
patchMockChatRun(bridgeSource.childChatId, { busy: false });
const bridgeStream = randomUUID();
await noteDelegationRoomEvent({
  chatId: bridgeSource.childChatId,
  delegationId: bridgeSource.id,
  delegationAttemptId: liveBridgeSource.attemptId,
  delegationAssignment: 'implement',
  serverHold: true,
  _runId: liveBridgeSource.runId,
  eventStreamId: bridgeStream,
  _currentRunAssistantText: 'TASK: implement\nVERDICT: PASS\nDone.',
  async _flushHistory() {
    await appendChatHistoryEvents(bridgeSource.childChatId, `oc-${bridgeSource.childChatId}`, [
      { rec: { kind: 'meta', variant: 'runFinished', payload: 'completed', eventStreamId: bridgeStream, roomEventSeq: 1 } },
    ]);
    return { ok: true, pending: 0, deadLettered: 0 };
  },
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: liveBridgeSource.runId,
  roomEventSeq: 1,
});
updateChat(bridgeSource.childChatId, { opencodeSessionId: `oc-${bridgeSource.childChatId}` });
const afterBridgeFinish = await start('implement', leafBridge);
assert.equal(afterBridgeFinish.sessionResume.status, 'resumed', JSON.stringify(afterBridgeFinish.sessionResume));
assert.equal(afterBridgeFinish.childChatId, bridgeSource.childChatId);

// The terminal record may be committed before the flush resolves. A later
// ordinary turn must remain outside the finished delegation's boundary.
for (const mutation of ['turn', 'reset']) {
  const leafId = randomUUID();
  const source = await start('implement', leafId, { keepOpen: true });
  const live = getDelegationById(source.id);
  patchMockChatRun(source.childChatId, { busy: false });
  const stream = randomUUID();
  let releaseFlush;
  const barrier = new Promise((resolve) => { releaseFlush = resolve; });
  let signalFlushing;
  const flushing = new Promise((resolve) => { signalFlushing = resolve; });
  const finishPromise = noteDelegationRoomEvent({
    chatId: source.childChatId,
    delegationId: source.id,
    delegationAttemptId: live.attemptId,
    delegationAssignment: 'implement',
    serverHold: true,
    _runId: live.runId,
    eventStreamId: stream,
    _currentRunAssistantText: 'TASK: implement\nVERDICT: PASS\nDone.',
    async _flushHistory() {
      await appendChatHistoryEvents(source.childChatId, `oc-${source.childChatId}`, [
        { rec: { kind: 'meta', variant: 'runFinished', payload: 'completed', eventStreamId: stream, roomEventSeq: 1 } },
      ]);
      signalFlushing();
      await barrier;
      return { ok: true, pending: 0, deadLettered: 0 };
    },
  }, { type: 'sdkRunFinished', status: 'completed', runId: live.runId, roomEventSeq: 1 });
  await flushing;
  if (mutation === 'turn') {
    await appendChatHistoryEvents(source.childChatId, `oc-${source.childChatId}`, [
      { rec: { kind: 'localUser', text: 'Foreign turn during terminal flush.' } },
    ]);
  } else {
    recordContextRestart({ chatId: source.childChatId, harness: 'opencode', reason: CONTEXT_RESTART_REASON.PROCESS_RECREATED });
  }
  releaseFlush();
  await finishPromise;
  updateChat(source.childChatId, { opencodeSessionId: `oc-${source.childChatId}` });
  const next = await start('implement', leafId);
  assert.notEqual(next.childChatId, source.childChatId);
  assert.equal(next.sessionResume.reasonCode, mutation === 'turn' ? 'resume_foreign_history' : 'resume_session_reset');
}

// A-F11: finishing without a durable terminal proof must never authorize the
// next real start, including while the history append is waiting for its ACK.
for (const failure of ['during-flush', 'attempt-changed', 'failed-flusher', 'failed-result', 'pending', 'throw', 'reject', 'missing-marker', 'wrong-stream', 'wrong-seq', 'no-flusher', 'direct-finish', 'legacy']) {
  const leafId = randomUUID();
  const source = await start('implement', leafId, { keepOpen: true });
  patchMockChatRun(source.childChatId, { busy: false });
  updateChat(source.childChatId, { opencodeSessionId: `oc-${source.childChatId}` });
  let releaseFlush;
  let signalFlushing;
  const barrier = new Promise((resolve) => { releaseFlush = resolve; });
  const flushing = new Promise((resolve) => { signalFlushing = resolve; });
  const { room, payload } = createDurableFinishRoom(source, {
    async append(target, items) {
      if (failure === 'failed-flusher') throw new Error('Durable append refused');
      if (failure === 'missing-marker') return { ok: true };
      if (failure === 'during-flush' || failure === 'attempt-changed') {
        signalFlushing();
        await barrier;
      }
      return appendChatHistoryEvents(target.chatId, target.sessionKey, items);
    },
  });
  if (failure === 'failed-result') room._flushHistory = () => ({ ok: false, pending: 0 });
  if (failure === 'pending') room._flushHistory = () => ({ ok: true, pending: 1 });
  if (failure === 'throw') room._flushHistory = () => { throw new Error('Synchronous flush failure'); };
  if (failure === 'reject') room._flushHistory = async () => { throw new Error('Rejected flush'); };
  if (failure === 'wrong-stream') room._persistBuf[0].rec.eventStreamId = randomUUID();
  if (failure === 'wrong-seq') room._persistBuf[0].rec.roomEventSeq = 2;
  if (failure === 'no-flusher') delete room._flushHistory;
  let finishing;
  if (failure === 'direct-finish' || failure === 'legacy') {
    finishDelegation(source, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS\nDone.' });
    if (failure === 'legacy') {
      await confirmDurableFinish(source);
      // A legacy optimistic snapshot has a matching head but no confirmation.
      updateDelegationRecord(source.id, { sessionContinuityConfirmed: null });
    }
  } else {
    finishing = noteDelegationRoomEvent(room, payload);
    if (failure === 'during-flush' || failure === 'attempt-changed') await flushing;
    else await finishing;
  }
  if (failure === 'attempt-changed') {
    const newerAttempt = randomUUID();
    updateDelegationRecord(source.id, { attemptId: newerAttempt });
    room.delegationAttemptId = newerAttempt;
    releaseFlush();
    await finishing;
  }
  const unconfirmed = getDelegationById(source.id);
  assert.equal(unconfirmed.status, 'completed', failure);
  assert.equal(unconfirmed.sessionContinuityConfirmed, false, failure);
  if (!['attempt-changed', 'wrong-stream', 'wrong-seq'].includes(failure)) {
    assert.deepEqual(unconfirmed.sessionContinuity, readCurrentSessionContinuity(source.childChatId),
      `${failure}: the unchanged head alone must not allow reuse`);
  }
  if (failure === 'failed-flusher') {
    assert.equal(room._persistInflight.items.length, 1, 'real flusher retains the unacknowledged terminal record');
    assert.equal(room._persistFlushChain instanceof Promise, true);
  }
  // Neither a refresh without a terminal boundary nor an old attempt may
  // manufacture confirmation from the unchanged live history head.
  refreshFinishedDelegationSessionContinuity({ delegationId: source.id, attemptId: source.attemptId });
  refreshFinishedDelegationSessionContinuity({
    delegationId: source.id, attemptId: randomUUID(),
    expectedSession: unconfirmed.sessionContinuity, boundary: unconfirmed.sessionContinuity,
  });
  assert.equal(getDelegationById(source.id).sessionContinuityConfirmed, false, failure);
  const next = await start('implement', leafId);
  assert.notEqual(next.childChatId, source.childChatId, failure);
  assert.equal(next.sessionResume.reasonCode, 'resume_continuity_unknown', failure);
  if (failure === 'during-flush') {
    releaseFlush();
    await finishing;
    assert.equal(getDelegationById(source.id).sessionContinuityConfirmed, true, 'ACK confirms only the old source');
    assert.notEqual(getDelegationById(next.id).childChatId, source.childChatId);
  }
  discardBufferedHistory(source.childChatId);
}

// A confirmed terminal proof survives persistence and process restart.
const durableLeaf = randomUUID();
const durableSource = await start('implement', durableLeaf);
assert.equal(getDelegationById(durableSource.id).sessionContinuityConfirmed, true);
const durableNext = await startAfterProcessRestart(durableLeaf);
assert.equal(durableNext.sessionResume.status, 'resumed');
assert.equal(durableNext.childChatId, durableSource.childChatId);

// 10. Switching a switch off returns to fresh, even for an explicit pointer.
setSwitches({ continue_implement_sessions: false });
const forced = await start('implement', leafA, { resumeSessionOf: implAfterPlan.id });
assert.notEqual(forced.childChatId, implAfterPlan.childChatId);
assert.equal(forced.sessionResume.reasonCode, 'work_fresh_by_policy');

setSwitches({ continue_implement_sessions: true });
// Scope selection is carried from saved Settings through lookup and final gate.
for (const role of ['plan', 'implement', 'fix']) {
  setSwitches({ [`continue_${role}_sessions`]: true, [`${role}_session_scope`]: 'leaf' });
  const first = await start(role, randomUUID());
  setSwitches({ [`${role}_session_scope`]: 'orchestrator' });
  const next = await start(role, randomUUID());
  assert.equal(next.continuationPolicy.scope, 'orchestrator');
  assert.equal(next.sessionResume.status, 'resumed', `${role}: ${JSON.stringify(next.sessionResume)}`);
  assert.equal(next.childChatId, first.childChatId, role);
  setSwitches({ [`${role}_session_scope`]: 'leaf' });
  const isolated = await start(role, randomUUID());
  assert.notEqual(isolated.childChatId, next.childChatId);
}
setSwitches({ implement_session_scope: 'leaf' });
const unscoped = await start('implement', '');
assert.equal(unscoped.sessionResume.reasonCode, 'resume_no_leaf');

// Missing explicit IDs still keep a directly linked TODO and its reuse chain.
const linkedTodo = addTodo(workspace, workspace, { title: 'Linked reuse regression', status: 'doing' }).item;
updateChat(parent.id, { todoId: linkedTodo.id });
const linkedImplement = await start('implement', '');
const linkedFix = await start('fix', '');
assert.equal(linkedImplement.leafId, linkedTodo.id);
assert.equal(linkedFix.leafId, linkedTodo.id);
assert.equal(linkedFix.sessionResume.status, 'resumed');
assert.equal(linkedFix.childChatId, linkedImplement.childChatId);
const linkedGroup = addTodo(workspace, workspace, { title: 'Ambiguous reuse group', status: 'doing' }).item;
for (const title of ['First active leaf', 'Second active leaf']) {
  addTodo(workspace, workspace, { title, status: 'doing', parentId: linkedGroup.id });
}
updateChat(parent.id, { todoId: linkedGroup.id });
// The rejection must follow the new default alone (no stored switch), not only explicit true.
setSwitches({ continue_implement_sessions: null, continue_fix_sessions: null });
const ambiguousStart = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: 'Implement the current task',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: randomUUID(),
  ...ROLE_INPUT.implement,
});
assert.equal(ambiguousStart.ok, false);
assert.equal(ambiguousStart.code, 'leaf_id_required_for_session_reuse');
assert.equal(ambiguousStart.delegation, undefined, 'no paid child starts without the task scope');
setSwitches({ continue_implement_sessions: true, continue_fix_sessions: true });
updateChat(parent.id, { todoId: null });

// Stage 1 guards: cold-cache and empty-report fail-safes (work roles only).
activeService = guardService;
setSwitches({ continue_implement_sessions: true, continue_fix_sessions: true, implement_session_scope: 'leaf', fix_session_scope: 'leaf' });
const guardLeafCold = randomUUID();
const coldSource = await start('implement', guardLeafCold);
// Warm, unknown and cold with a non-TTL reason fail open.
for (const cache of [
  { state: 'warm', reason: 'within_ttl' },
  { state: 'unknown', reason: 'unknown_ttl' },
  { state: 'cold', reason: 'context_epoch_changed' },
  { state: 'cold', reason: 'session_restarted' },
]) {
  cacheByChat.set(coldSource.childChatId, cache);
  const open = await start('implement', guardLeafCold);
  assert.equal(open.sessionResume.status, 'resumed', JSON.stringify(cache));
  assert.equal(open.childChatId, coldSource.childChatId, JSON.stringify(cache));
}
// Cold by TTL: new chat, reason recorded; fix -> implement source is guarded too.
cacheByChat.set(coldSource.childChatId, { state: 'cold', reason: 'ttl_expired' });
const coldFresh = await start('implement', guardLeafCold);
assert.notEqual(coldFresh.childChatId, coldSource.childChatId);
assert.equal(coldFresh.sessionResume.reasonCode, 'work_cache_expired');
assert.equal(coldFresh.sessionResume.status, 'fallback');
cacheByChat.set(coldFresh.childChatId, { state: 'cold', reason: 'ttl_expired' });
const coldFix = await start('fix', guardLeafCold);
assert.equal(coldFix.sessionResume.reasonCode, 'work_cache_expired');
// Explicit resume_session_of is exempt (it still passes every other gate).
const coldExplicitLeaf = randomUUID();
const coldExplicitSource = await start('implement', coldExplicitLeaf);
cacheByChat.set(coldExplicitSource.childChatId, { state: 'cold', reason: 'ttl_expired' });
const coldExplicit = await start('implement', coldExplicitLeaf, { resumeSessionOf: coldExplicitSource.id });
assert.equal(coldExplicit.sessionResume.status, 'resumed', JSON.stringify(coldExplicit.sessionResume));
assert.equal(coldExplicit.childChatId, coldExplicitSource.childChatId);
cacheByChat.clear();

// Empty resumed attempt: failed next to an older completed source.
const emptyLeafFailed = randomUUID();
const emptyBase = await start('implement', emptyLeafFailed);
const emptyFailed = await start('implement', emptyLeafFailed, { keepOpen: true });
assert.equal(emptyFailed.childChatId, emptyBase.childChatId);
assert.equal(emptyFailed.sessionResume.status, 'resumed');
await finish(emptyFailed, { status: 'failed', report: '  ' });
const afterEmptyFailed = await start('implement', emptyLeafFailed);
assert.notEqual(afterEmptyFailed.childChatId, emptyBase.childChatId);
assert.equal(afterEmptyFailed.sessionResume.reasonCode, 'work_previous_empty_report');

// Empty completed resumed attempt that is itself the selected source; a fix start is guarded too.
const emptyLeafDone = randomUUID();
await start('implement', emptyLeafDone);
const emptyDone = await start('implement', emptyLeafDone, { keepOpen: true });
assert.equal(emptyDone.sessionResume.status, 'resumed');
await finish(emptyDone, { status: 'completed', report: '' });
const afterEmptyDone = await start('fix', emptyLeafDone);
assert.notEqual(afterEmptyDone.childChatId, emptyDone.childChatId);
assert.equal(afterEmptyDone.sessionResume.reasonCode, 'work_previous_empty_report');
// Explicit resume_session_of ignores the empty-report guard.
const emptyExplicit = await start('implement', emptyLeafDone, { resumeSessionOf: emptyDone.id });
assert.equal(emptyExplicit.sessionResume.status, 'resumed', JSON.stringify(emptyExplicit.sessionResume));
assert.equal(emptyExplicit.childChatId, emptyDone.childChatId);
// Only the NEWEST terminal attempt of the same chat counts: the healthy explicit
// attempt above sits after the empty one, so automatic resume works again, and
// the implement -> fix edge still resumes the same chat.
const afterHealthy = await start('implement', emptyLeafDone);
assert.equal(afterHealthy.sessionResume.status, 'resumed', JSON.stringify(afterHealthy.sessionResume));
assert.equal(afterHealthy.childChatId, emptyDone.childChatId);
const fixAfterHealthy = await start('fix', emptyLeafDone);
assert.equal(fixAfterHealthy.sessionResume.status, 'resumed', JSON.stringify(fixAfterHealthy.sessionResume));
assert.equal(fixAfterHealthy.childChatId, emptyDone.childChatId);

// Cancelled / interrupted attempts never count for the empty-report guard.
for (const terminal of ['cancelled', 'interrupted']) {
  // Older empty resumed attempt followed by a newer non-counting row: the empty
  // attempt is still the newest failed/completed one, so the chat stays blocked.
  const leafEmpty = randomUUID();
  await start('implement', leafEmpty);
  const emptyAttempt = await start('implement', leafEmpty, { keepOpen: true });
  await finish(emptyAttempt, { status: 'failed', report: '' });
  const laterEmpty = await start('implement', leafEmpty, { resumeSessionOf: emptyAttempt.id, keepOpen: true });
  await finish(laterEmpty, { status: terminal, report: '' });
  const blocked = await start('implement', leafEmpty);
  assert.notEqual(blocked.childChatId, emptyAttempt.childChatId, terminal);
  assert.equal(blocked.sessionResume.reasonCode, 'work_previous_empty_report', terminal);
  // Healthy attempt followed only by a cancelled/interrupted row: guard B must
  // not fire. (The pre-existing supersede gate still refuses a source that a
  // newer row already used, so the outcome is that gate's code, not guard B's.)
  const leafHealthy = randomUUID();
  await start('implement', leafHealthy);
  const healthy = await start('implement', leafHealthy);
  assert.equal(healthy.sessionResume.status, 'resumed', terminal);
  const trailing = await start('implement', leafHealthy, { resumeSessionOf: healthy.id, keepOpen: true });
  await finish(trailing, { status: terminal, report: '' });
  const afterTrailing = await start('implement', leafHealthy);
  assert.equal(afterTrailing.sessionResume.reasonCode, 'resume_source_superseded', terminal);
  assert.equal(hasEmptyReportBlock(afterTrailing), false, terminal);
}
activeService = service;

// A parked second start never shares the live chat of the running one.
const racerA = await start('implement', leafA, { keepOpen: true });
const racerB = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: `implement racer ${randomUUID()}`,
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: randomUUID(),
  leafId: leafA,
  resumeRounds: true,
  returnWhenStarting: false,
  ...ROLE_INPUT.implement,
});
assert.equal(racerB.queued, true, 'one execution job per controller: the second is parked');
assert.notEqual(racerB.delegation.childChatId, racerA.childChatId);
assert.notEqual(racerB.delegation.sessionResume?.status, 'resumed');
await finish(racerA);

console.log('delegation-work-session-resume-service.test.js OK');
