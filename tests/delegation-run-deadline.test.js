import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  classifyExploreAttemptOutcome,
  createDelegationService,
  finishDelegation,
} from '../lib/delegation-service.js';
import { inferDelegationWorkflowFromHistory } from '../lib/delegation-workflow-leaf.js';
import { finishCancellingWithStopProof } from '../lib/delegation-cancelling-deadline.js';
import {
  DELEGATION_RUN_DEADLINE_IMPLEMENT_MS,
  DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS,
  readDelegationRunDeadlineImplementMs,
  readDelegationRunDeadlineReviewFixMs,
  resolveEffectiveRunDeadlineEpoch,
} from '../lib/delegation-run-deadline.js';
import {
  resetDelegationRuntimeHealth,
  tickDelegationRuntime,
} from '../lib/delegation-runtime-worker.js';
import {
  hangNextMockChatRunCancel,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
  seedMockChatRun,
} from '../lib/chat-run/mock-adapter.js';
import {
  DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
  isDelegationSlotOccupied,
} from '../lib/delegation-status.js';
import { applyDelegationWorkflowPatch } from '../lib/delegation-workflow.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

test.beforeEach(() => {
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
});

/**
 * @param {object} input
 * @returns {object}
 */
function runningJob(input) {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const child = addChat(crypto.randomUUID(), 'child', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const created = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: input.assignment || 'implement',
    pickRole: input.pickRole || '',
    status: 'running',
    attemptId: input.attemptId || crypto.randomUUID(),
    runId: input.runId || crypto.randomUUID(),
    leafId: input.leafId || '',
  });
  const runId = input.runId || crypto.randomUUID();
  const row = updateDelegationRecord(created.id, {
    startedAt: input.startedAt,
    runDefaultLimitActive: input.runDefaultLimitActive !== false,
    runDeadlineAt: input.runDeadlineAt || '',
    runId,
  });
  seedMockChatRun(child.id, { runId, busy: input.busy !== false, waitingForInput: false });
  return getDelegationById(row.id);
}

test('default limits: fix at 20 min cancelled, implement at 25 min not cancelled', async () => {
  const t0 = Date.parse('2026-10-12T10:00:00.000Z');
  const fixJob = runningJob({
    assignment: 'review',
    pickRole: 'fix',
    startedAt: new Date(t0 - DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS - 1000).toISOString(),
    attemptId: 'fix-deadline',
    runId: 'fix-run',
  });
  const implementJob = runningJob({
    assignment: 'implement',
    pickRole: 'implement',
    startedAt: new Date(t0 - 25 * 60 * 1000).toISOString(),
    attemptId: 'impl-under',
    runId: 'impl-run',
  });
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: t0, drainMailbox: false });
  const fixAfter = getDelegationById(fixJob.id);
  const implAfter = getDelegationById(implementJob.id);
  assert.ok(['cancelling', 'interrupted'].includes(fixAfter.status), fixAfter.status);
  assert.equal(fixAfter.cancelCause, 'run_deadline_exceeded');
  assert.equal(implAfter.status, 'running');
  finishDelegation(fixAfter, { status: 'cancelled' });
  finishDelegation(implAfter, { status: 'cancelled' });
});

test('explicit shorter and longer deadlines override default; zero disables default', () => {
  const t0 = Date.parse('2026-10-12T12:00:00.000Z');
  const started = new Date(t0 - 30 * 60 * 1000).toISOString();
  const shorter = runningJob({
    pickRole: 'fix',
    assignment: 'review',
    startedAt: started,
    runDeadlineAt: new Date(t0 - 1000).toISOString(),
  });
  assert.ok(resolveEffectiveRunDeadlineEpoch(shorter) <= t0 - 1000);
  const longer = runningJob({
    pickRole: 'fix',
    assignment: 'review',
    startedAt: started,
    runDeadlineAt: new Date(t0 + 60 * 60 * 1000).toISOString(),
  });
  const longerEpoch = resolveEffectiveRunDeadlineEpoch(longer);
  assert.ok(Number.isFinite(longerEpoch));
  assert.ok(longerEpoch > t0);
  const disabled = runningJob({
    pickRole: 'implement',
    startedAt: started,
    runDefaultLimitActive: true,
  });
  const prev = process.env.CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS;
  process.env.CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS = '0';
  try {
    assert.equal(readDelegationRunDeadlineImplementMs(), 0);
    assert.equal(resolveEffectiveRunDeadlineEpoch(disabled), null);
  } finally {
    if (prev === undefined) delete process.env.CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS;
    else process.env.CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS = prev;
  }
  finishDelegation(shorter, { status: 'cancelled' });
  finishDelegation(longer, { status: 'cancelled' });
  finishDelegation(disabled, { status: 'cancelled' });
});

test('workflow deadline_at applies without default flag', async () => {
  const t0 = Date.parse('2026-10-12T14:00:00.000Z');
  const leafId = 'dddddddd-1111-2222-3333-444455556666';
  const job = runningJob({
    leafId,
    startedAt: new Date(t0 - 60 * 60 * 1000).toISOString(),
    runDefaultLimitActive: false,
  });
  applyDelegationWorkflowPatch({
    parentChatId: job.parentChatId,
    leafId,
    deadlineAt: new Date(t0 - 500).toISOString(),
    clearStop: true,
  });
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: t0, drainMailbox: false });
  const after = getDelegationById(job.id);
  assert.ok(['cancelling', 'interrupted', 'cancelled'].includes(after.status));
  assert.notEqual(after.cancelCause, 'run_deadline_exceeded');
  if (after.status !== 'cancelled') finishDelegation(after, { status: 'cancelled' });
});

test('leaf workflow deadline cancel does not stamp run_deadline_exceeded on finish', async () => {
  const t0 = Date.parse('2026-10-12T15:00:00.000Z');
  const leafId = 'eeeeeeee-1111-2222-3333-444455556666';
  const job = runningJob({
    leafId,
    startedAt: new Date(t0 - 60 * 60 * 1000).toISOString(),
    runDefaultLimitActive: false,
    busy: true,
  });
  applyDelegationWorkflowPatch({
    parentChatId: job.parentChatId,
    leafId,
    deadlineAt: new Date(t0 - 500).toISOString(),
    clearStop: true,
  });
  resetDelegationRuntimeHealth();
  const releaseCancel = hangNextMockChatRunCancel();
  await tickDelegationRuntime({ now: t0, drainMailbox: false });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  releaseCancel();
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  const cancelling = getDelegationById(job.id);
  assert.equal(cancelling.status, 'cancelling');
  assert.notEqual(cancelling.cancelCause, 'run_deadline_exceeded');
  const finished = finishCancellingWithStopProof(cancelling, {
    finishDelegation,
    status: 'cancelled',
    error: cancelling.error || 'Leaf deadline stop.',
  });
  assert.equal(finished?.status, 'cancelled');
  assert.notEqual(finished?.interruptCode, DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED);
});

test('run_deadline_exceeded review does not advance workflow round or verdict', () => {
  const parentChatId = crypto.randomUUID();
  const leafId = 'ffffffff-1111-2222-3333-444455556666';
  const t0 = Date.parse('2026-10-12T18:00:00.000Z');
  const implement = createDelegationRecord({
    parentChatId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    status: 'completed',
    assignment: 'implement',
    leafId,
    createdAt: new Date(t0 - 120000).toISOString(),
  });
  const reviewDeadline = updateDelegationRecord(
    createDelegationRecord({
      parentChatId,
      workspaceFolder: ISOLATED_DATA_DIR,
      executor: { transport: 'opencode', model: 'opencode/test' },
      status: 'interrupted',
      assignment: 'review',
      leafId,
      createdAt: new Date(t0 - 60000).toISOString(),
    }).id,
    {
      interruptCode: DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
      report: '',
    },
  );
  const inferred = inferDelegationWorkflowFromHistory({
    parentChatId,
    leafId,
    delegations: [implement, reviewDeadline],
  });
  assert.equal(inferred.reviewEventCount, 0);
  assert.equal(inferred.lastVerdict, 'unspecified');
  assert.equal(inferred.round, 1);
});

test('explore classification treats run_deadline_exceeded as non-infra', () => {
  assert.equal(
    classifyExploreAttemptOutcome({
      status: 'interrupted',
      interruptCode: DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
    }),
    null,
  );
  assert.equal(
    classifyExploreAttemptOutcome({ status: 'interrupted', interruptCode: 'running_orphan' }),
    'infra_fail',
  );
});

test('slot stays occupied until stop is confirmed', async () => {
  const t0 = Date.parse('2026-10-12T16:00:00.000Z');
  const job = runningJob({
    pickRole: 'fix',
    assignment: 'review',
    startedAt: new Date(t0 - DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS - 5000).toISOString(),
    busy: true,
  });
  resetDelegationRuntimeHealth();
  const releaseCancel = hangNextMockChatRunCancel();
  await tickDelegationRuntime({ now: t0, drainMailbox: false });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  const cancelling = getDelegationById(job.id);
  assert.equal(cancelling.status, 'cancelling');
  assert.equal(isDelegationSlotOccupied(cancelling), true);
  releaseCancel();
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  patchMockChatRun(cancelling.childChatId, { busy: false, waitingForInput: false });
  const localService = createDelegationService({ isModelAvailable: () => true });
  await localService.cancel(cancelling.id);
  const finished = getDelegationById(job.id);
  assert.equal(finished.status, 'interrupted');
  assert.equal(finished.interruptCode, DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED);
  assert.equal(isDelegationSlotOccupied(finished), false);
});

test('env readers for role defaults', () => {
  assert.equal(readDelegationRunDeadlineReviewFixMs({ CRETLI_DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS: '600000' }), 600000);
  assert.equal(readDelegationRunDeadlineImplementMs({ CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS: 'bad' }), DELEGATION_RUN_DEADLINE_IMPLEMENT_MS);
});
