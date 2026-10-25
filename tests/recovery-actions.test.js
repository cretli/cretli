import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_ACTION,
  recoveryResumeNeedsConfirm,
  resolveRecoveryActionFeedback,
  resolveRecoveryConfirmUnknown,
  shouldLoadDelegationRecovery,
} from '../app_front/features/chat/recoveryActions.js';
import { resolveHarnessChatStateMeta } from '../app_front/features/chat/chatStatusMeta.js';
import { agentRunStateDedupeKey } from '../app_front/features/chat/agentPresenceStore.js';
import { readSubchatOutcome } from '../app_front/features/sidebar/sidebarSubchatGroups.js';

test('unknown runs require an explicit confirmation before confirmUnknown is sent', () => {
  const unknown = { state: 'unknown', needsConfirm: true };
  assert.equal(recoveryResumeNeedsConfirm(unknown), true);
  // No user decision yet -> never true.
  assert.equal(resolveRecoveryConfirmUnknown(unknown, false), false);
  assert.equal(resolveRecoveryConfirmUnknown(unknown, undefined), false);
  // Explicit confirmation -> true.
  assert.equal(resolveRecoveryConfirmUnknown(unknown, true), true);
  // A server view without the flag still refuses to confirm implicitly.
  assert.equal(recoveryResumeNeedsConfirm({ state: 'unknown' }), true);
  // Interrupted runs need no confirmation at all.
  const interrupted = { state: 'interrupted', needsConfirm: false };
  assert.equal(recoveryResumeNeedsConfirm(interrupted), false);
  assert.equal(resolveRecoveryConfirmUnknown(interrupted, true), false);
});

test('recovery actions are loaded for interrupted, failed and waiting cards only', () => {
  for (const status of ['interrupted', 'failed', 'waiting_for_input', 'cancelling']) {
    assert.equal(shouldLoadDelegationRecovery(status), true, status);
  }
  for (const status of ['completed', 'running', 'starting', 'queued', 'cancelled', '']) {
    assert.equal(shouldLoadDelegationRecovery(status), false, status);
  }
});

test('resume feedback maps success, in-progress, conflict, not_resumable and limit statuses', () => {
  assert.deepEqual(resolveRecoveryActionFeedback(RECOVERY_ACTION.RESUME, { status: 'resumed' }),
    { tone: 'success', key: 'chat.recoveryResumeStarted' });
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'already_recovering' }).key,
    'chat.recoveryResumeInProgress');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'conflict' }).key,
    'chat.recoveryResumeConflict');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'not_resumable' }).key,
    'chat.recoveryResumeNotResumable');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'limit_blocked' }).key,
    'chat.recoveryResumeLimitBlocked');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'family_blocked' }).key,
    'chat.recoveryResumeFamilyBlocked');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'liveness_unknown' }).key,
    'chat.recoveryResumeLivenessUnknown');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'unsupported' }).key,
    'chat.recoveryResumeUnsupported');
  assert.equal(resolveRecoveryActionFeedback('resume', { status: 'launch_failed' }).key,
    'chat.recoveryResumeLaunchFailed');
  assert.equal(resolveRecoveryActionFeedback('resume', {}).tone, 'error');
});

test('keep-stopped feedback maps success, conflict and not_resumable', () => {
  assert.deepEqual(resolveRecoveryActionFeedback(RECOVERY_ACTION.KEEP_STOPPED, { status: 'kept_stopped' }),
    { tone: 'success', key: 'chat.recoveryKeepStoppedDone' });
  assert.equal(resolveRecoveryActionFeedback(RECOVERY_ACTION.KEEP_STOPPED, { status: 'conflict' }).key,
    'chat.recoveryKeepStoppedConflict');
  assert.equal(resolveRecoveryActionFeedback(RECOVERY_ACTION.KEEP_STOPPED, { status: 'not_resumable' }).key,
    'chat.recoveryKeepStoppedNotResumable');
  assert.equal(resolveRecoveryActionFeedback(RECOVERY_ACTION.KEEP_STOPPED, { status: 'not_found' }).key,
    'chat.recoveryKeepStoppedNotFound');
});

test('sidebar status mapping renders recovery states', () => {
  const attention = (recoveryStatus) => resolveHarnessChatStateMeta({
    connection: 'connected',
    serverRunState: { state: 'attention', recoveryStatus },
  });
  assert.equal(attention('interrupted_restart').label, 'Interrupted after restart');
  assert.equal(attention('interrupted_restart').status, 'interrupted_restart');
  assert.equal(attention('unknown').label, 'Unknown');
  assert.equal(attention('unknown').tone, 'attention');

  const busy = resolveHarnessChatStateMeta({
    connection: 'connected',
    serverRunState: { state: 'busy', recoveryStatus: 'resuming' },
  });
  assert.equal(busy.label, 'Resuming');
  assert.equal(busy.tone, 'active');

  const waiting = resolveHarnessChatStateMeta({
    connection: 'connected',
    serverRunState: { state: 'waiting', recoveryStatus: 'waiting' },
  });
  assert.equal(waiting.label, 'Waiting');

  // The delegation interrupt code still maps without a recovery row.
  const interruptCode = resolveHarnessChatStateMeta({
    connection: 'connected',
    serverRunState: { state: 'attention', delegationStatus: 'interrupted', interruptCode: 'server_restart' },
  });
  assert.equal(interruptCode.label, 'Interrupted after restart');
});

test('subchat grouping treats recovery interruptions as interrupted', () => {
  assert.equal(readSubchatOutcome({
    _serverRunState: { state: 'attention', recoveryStatus: 'interrupted_restart' },
  }), 'interrupted');
  assert.equal(readSubchatOutcome({
    _serverRunState: { state: 'attention', recoveryStatus: 'unknown' },
  }), 'interrupted');
  assert.equal(readSubchatOutcome({
    _serverRunState: { state: 'busy', recoveryStatus: 'resuming' },
  }), 'running');
});

test('presence dedupe distinguishes recovery status changes', () => {
  const base = { state: 'attention', attention: true, delegationId: '' };
  assert.notEqual(
    agentRunStateDedupeKey({ ...base, recoveryStatus: 'interrupted_restart' }),
    agentRunStateDedupeKey({ ...base, recoveryStatus: 'unknown' }),
  );
  assert.equal(
    agentRunStateDedupeKey({ ...base, recoveryStatus: 'unknown' }),
    agentRunStateDedupeKey({ ...base, recoveryStatus: 'unknown' }),
  );
  assert.notEqual(
    agentRunStateDedupeKey({ state: 'attention', attention: true, interruptCode: '' }),
    agentRunStateDedupeKey({ state: 'attention', attention: true, interruptCode: 'server_restart' }),
  );
});

test('failed recovery-runs responses are null, not an empty list', async () => {
  const { readRecoveryRunsResponse } = await import('../app_front/features/chat/recoveryActions.js');
  assert.equal(readRecoveryRunsResponse({ ok: false, error: 'HTTP 500' }), null);
  assert.equal(readRecoveryRunsResponse(null), null);
  assert.equal(readRecoveryRunsResponse({ ok: true }), null);
  assert.deepEqual(readRecoveryRunsResponse({ ok: true, runs: [] }), []);
  assert.deepEqual(readRecoveryRunsResponse({ runs: [{ a: 1 }] }), [{ a: 1 }]);
});

test('latest-request guard rejects stale reads', async () => {
  const { createLatestRequestGuard } = await import('../app_front/features/chat/recoveryActions.js');
  const guard = createLatestRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});

test('recovery widget registry notifies every surface of a chat until unregistered', async () => {
  const { registerRecoveryWidget, notifyRecoveryWidgets } = await import('../app_front/features/chat/recoveryActions.js');
  let a = 0;
  let b = 0;
  /** @type {Array<object | null>} */
  const feedbackSeen = [];
  const offA = registerRecoveryWidget('child-1', (feedback) => { a += 1; feedbackSeen.push(feedback); });
  registerRecoveryWidget('child-1', (feedback) => { b += 1; feedbackSeen.push(feedback); });
  const actionFeedback = { tone: 'success', key: 'chat.recoveryKeepStoppedDone' };
  assert.equal(notifyRecoveryWidgets('child-1', actionFeedback), 2);
  // The action result reaches every surface, so a refresh that empties the
  // list cannot erase the confirmation it belongs to.
  assert.deepEqual(feedbackSeen, [actionFeedback, actionFeedback]);
  offA();
  assert.equal(notifyRecoveryWidgets('child-1'), 1);
  assert.equal(notifyRecoveryWidgets('other'), 0);
  assert.deepEqual([a, b], [1, 2]);
});

test('notify can skip the surface that already refreshed itself', async () => {
  const { registerRecoveryWidget, notifyRecoveryWidgets } = await import('../app_front/features/chat/recoveryActions.js');
  let sourceCalls = 0;
  let otherCalls = 0;
  const sourceRefresh = () => { sourceCalls += 1; };
  registerRecoveryWidget('skip-chat', sourceRefresh);
  registerRecoveryWidget('skip-chat', () => { otherCalls += 1; });
  notifyRecoveryWidgets('skip-chat', { tone: 'success', key: 'chat.recoveryKeepStoppedDone' }, sourceRefresh);
  assert.equal(sourceCalls, 0, 'the already refreshed surface is not read twice');
  assert.equal(otherCalls, 1);
});

test('sidebar keeps recovery status for background chats without a socket', () => {
  for (const [recoveryStatus, label] of [['interrupted', 'Interrupted'], ['unknown', 'Unknown']]) {
    const meta = resolveHarnessChatStateMeta({
      surface: 'sidebar',
      socketExpected: false,
      connection: 'disconnected',
      serverRunState: { state: 'attention', recoveryStatus },
    });
    assert.equal(meta.label, label);
    assert.notEqual(meta.label, 'Ready');
  }
  // No recovery row: stale archive attention still collapses to Ready.
  const stale = resolveHarnessChatStateMeta({
    surface: 'sidebar',
    socketExpected: false,
    serverRunState: { state: 'attention', delegationStatus: 'completed' },
  });
  assert.equal(stale.label, 'Ready');
});

test('waiting presence with interrupted recovery is not masked by the waiting-for-agents label', () => {
  const meta = resolveHarnessChatStateMeta({
    serverRunState: { state: 'waiting', recoveryStatus: 'interrupted', waitingAgentCount: 2 },
  });
  assert.equal(meta.label, 'Interrupted');
});
