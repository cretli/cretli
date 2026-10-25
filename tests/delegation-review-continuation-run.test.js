/**
 * Review finish diagnostics: a codex review guard resume (or VERDICT follow-up)
 * continues the SAME attempt under a new adapter run id. These synthetic
 * regressions reproduce the history/record divergence (the history shows the
 * run finished, the record stays `running`, a plain cancel ends
 * `review_cancel_stuck`) and pin the fenced adoption of the continuation run.
 * No live session is touched: rooms are plain objects and the adapter is the
 * in-process mock.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  createDelegationService,
  finishDelegation,
  hasInFlightDelegationStart,
} from '../lib/delegation-service.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { probeChatRunLiveness, registerChatRunAdapter } from '../lib/chat-run-service.js';
import {
  getMockChatRunStartCount,
  hangNextMockChatRunCancel,
  registerMockChatRunAdapter,
  resetMockChatRuns,
  seedMockChatRun,
} from '../lib/chat-run/mock-adapter.ts';
import { resolveCancellingDeadline } from '../lib/delegation-cancelling-deadline.js';
import { tickDelegationRuntime, stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';
import { readDelegationStopProof } from '../lib/delegation-slot-stop.js';
import {
  DELEGATION_CANCELLING_TIMEOUT_MS,
  DELEGATION_RUNNING_ORPHAN_GRACE_MS,
  isDelegationSlotOccupied,
} from '../lib/delegation-status.js';

stopDelegationRuntimeWorker();
const service = createDelegationService({
  isModelAvailable: () => true,
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
});

test.beforeEach(() => {
  resetMockChatRuns();
  registerMockChatRunAdapter('testfake');
});

/**
 * @param {string} label
 * @returns {{ job: object, room: object }}
 */
function reviewJob(label) {
  const parent = addChat(crypto.randomUUID(), `${label} parent`, null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), `${label} child`, null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    forkParentChatId: parent.id,
    forkKind: 'delegation',
    delegationParentChatId: parent.id,
    delegationAssignment: 'review',
  });
  const job = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'review',
    executionMode: 'agent',
    sourceKind: 'text',
    taskText: 'Review only.',
    status: 'running',
    runId: 'run-1',
  });
  const room = { chatId: child.id, delegationAssignment: 'review', sdkMode: 'agent' };
  bindRoomToDelegation(room, { delegationId: job.id, attemptId: job.attemptId, assignment: 'review' });
  return { job: getDelegationById(job.id), room };
}

/**
 * Guard denial: the first run ends `plan_guard_cancelled` while the codex room
 * already queued the read-only follow-up (finish deferred).
 *
 * @param {object} room
 */
async function denyAndDefer(room) {
  room._codexReviewGuardResumeQueued = true;
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'plan_guard_cancelled', runId: 'run-1' });
  room._codexReviewGuardResumeQueued = false;
}

/** @param {object} row */
function ageCancelling(row) {
  return updateDelegationRecord(row.id, {
    lastTransitionAt: new Date(Date.now() - DELEGATION_CANCELLING_TIMEOUT_MS - 50).toISOString(),
  });
}

test('reproduction: an unadopted continuation run diverges and a plain cancel ends review_cancel_stuck', async () => {
  const { job, room } = reviewJob('repro');
  await denyAndDefer(room);
  // Simulate the pre-fix room: the continuation starts without the adoption marker.
  room._delegationContinuation = null;
  await noteDelegationRoomEvent(room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: true });
  seedMockChatRun(job.childChatId, { runId: 'run-2', busy: false });
  // The adapter history records the continuation run as finished ...
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'cancelled', runId: 'run-2' });
  // ... yet the record still fences on run-1 and stays running.
  const diverged = getDelegationById(job.id);
  assert.equal(diverged.status, 'running');
  assert.equal(diverged.runId, 'run-1');
  // Liveness for run-1 is unknown, never a confirmed idle: no orphan release.
  assert.equal(probeChatRunLiveness({ chatId: job.childChatId, runId: 'run-1' }).known, false);
  // A plain cancel cannot confirm the stop and the read-only review is
  // finished as infrastructure (`review_cancel_stuck`), not as user cancel.
  const cancelling = ageCancelling(updateDelegationRecord(job.id, { status: 'cancelling' }));
  const live = probeChatRunLiveness({ chatId: job.childChatId, runId: cancelling.runId });
  resolveCancellingDeadline(cancelling, Date.now(), { busy: live.busy, known: live.known }, {
    finishDelegation,
    hasInFlightDelegationStart,
  });
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'review_cancel_stuck');
});

test('guard resume adopts the continuation run; a no-report finish classifies as no-verdict infra', async () => {
  const { job, room } = reviewJob('adopt');
  await denyAndDefer(room);
  assert.equal(getDelegationById(job.id).status, 'running');
  await noteDelegationRoomEvent(room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: true });
  assert.equal(getDelegationById(job.id).runId, 'run-2');
  assert.equal(getDelegationById(job.id).attemptId, job.attemptId, 'same attempt, new run');
  // Late end of the OLD run after the retry: fenced out, never finalizes run-2.
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'cancelled', runId: 'run-1' });
  assert.equal(getDelegationById(job.id).status, 'running');
  // Confirmed end of the right run without a report: existing incomplete path.
  room._currentRunAssistantText = '';
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: 'run-2' });
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'failed');
  assert.match(String(after.error || ''), /VERDICT/);
  assert.notEqual(after.reportVerdict, 'PASS');
});

test('after adoption a plain Stop hits the live continuation run (adapter_abort, not review_cancel_stuck)', async () => {
  const { job, room } = reviewJob('stop');
  await denyAndDefer(room);
  await noteDelegationRoomEvent(room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: true });
  seedMockChatRun(job.childChatId, { runId: 'run-2', busy: true });
  const cancelled = await service.cancel(job.id);
  assert.equal(cancelled.ok, true);
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(readDelegationStopProof(after)?.kind, 'adapter_abort');
  assert.notEqual(after.interruptCode, 'review_cancel_stuck');
});

test('unconfirmed Stop keeps the job cancelling with the slot held and starts nothing', async () => {
  const { job, room } = reviewJob('stop-hang');
  await denyAndDefer(room);
  await noteDelegationRoomEvent(room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: true });
  seedMockChatRun(job.childChatId, { runId: 'run-2', busy: true });
  const starts = getMockChatRunStartCount();
  hangNextMockChatRunCancel();
  void service.cancel(job.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'cancelling');
  assert.equal(isDelegationSlotOccupied(after), true);
  assert.equal(getMockChatRunStartCount(), starts, 'no auto-resume or replay');
});

test('adoption is fenced: wrong attempt, non-queued prompt or a moved record keep the old run', async () => {
  const wrongAttempt = reviewJob('fence-attempt');
  await denyAndDefer(wrongAttempt.room);
  wrongAttempt.room.delegationAttemptId = 'other-attempt';
  await noteDelegationRoomEvent(wrongAttempt.room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: true });
  assert.equal(getDelegationById(wrongAttempt.job.id).runId, 'run-1');

  const direct = reviewJob('fence-direct');
  await denyAndDefer(direct.room);
  await noteDelegationRoomEvent(direct.room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: false });
  assert.equal(getDelegationById(direct.job.id).runId, 'run-1');
  // The marker is consumed once: a later queued prompt does not adopt either.
  await noteDelegationRoomEvent(direct.room, { type: 'sdkPromptStarted', runId: 'run-3', fromQueue: true });
  assert.equal(getDelegationById(direct.job.id).runId, 'run-1');

  const moved = reviewJob('fence-moved');
  await denyAndDefer(moved.room);
  updateDelegationRecord(moved.job.id, { runId: 'run-retry' });
  await noteDelegationRoomEvent(moved.room, { type: 'sdkPromptStarted', runId: 'run-2', fromQueue: true });
  assert.equal(getDelegationById(moved.job.id).runId, 'run-retry');

  const waiting = reviewJob('fence-waiting');
  updateDelegationRecord(waiting.job.id, { status: 'waiting_for_input' });
  // A waiting_for_input deferral is not a continuation: no marker is written.
  await noteDelegationRoomEvent(waiting.room, { type: 'sdkRunFinished', status: 'completed', runId: 'run-1' });
  assert.equal(waiting.room._delegationContinuation ?? null, null);
  assert.equal(getDelegationById(waiting.job.id).status, 'waiting_for_input');
});

test('live long tool, waiting_for_input and unknown liveness never yield a false terminal or release', async () => {
  const old = new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString();
  const busy = reviewJob('live-tool');
  seedMockChatRun(busy.job.childChatId, { runId: 'run-1', busy: true });
  const waiting = reviewJob('live-waiting');
  seedMockChatRun(waiting.job.childChatId, { runId: 'run-1', busy: false, waitingForInput: true });
  updateDelegationRecord(waiting.job.id, { status: 'waiting_for_input' });
  const unknown = reviewJob('live-unknown');
  // No adapter run at all for this chat: state_missing is unknown, not idle.
  for (const row of [busy.job, waiting.job, unknown.job]) {
    updateDelegationRecord(row.id, { lastTransitionAt: old, idleObservedAt: old });
  }
  const starts = getMockChatRunStartCount();
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(busy.job.id).status, 'running');
  assert.equal(getDelegationById(waiting.job.id).status, 'waiting_for_input');
  assert.equal(getDelegationById(unknown.job.id).status, 'running');
  for (const row of [busy.job, waiting.job, unknown.job]) {
    assert.equal(isDelegationSlotOccupied(getDelegationById(row.id)), true);
  }
  assert.equal(getMockChatRunStartCount(), starts, 'no auto-resume');
});

test('adapter exception during a review is unknown: the record stays running', async () => {
  registerChatRunAdapter({
    transport: 'testfake',
    getState: () => { throw new Error('adapter down'); },
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'x' }),
  });
  const { job } = reviewJob('adapter-down');
  const old = new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString();
  updateDelegationRecord(job.id, { lastTransitionAt: old, idleObservedAt: old });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'running');
});
