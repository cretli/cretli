/**
 * Unit tests for the launch/finish lifecycle layer (leaf R5).
 *
 * Every test uses its own temporary data dir, so the suite never touches the
 * real `data/` store. The inter-process SIGKILL durability case lives in
 * `tests/recovery-lifecycle-crash.test.js`.
 *
 * The tests encode the two hard guarantees of the leaf: intent-before-launch (a
 * launch is only ever returned when the intent — and any approved prompt — are
 * durable) and "no acceptance proof, no automatic relaunch".
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeRecoveryStore,
  getRun,
  listRuns,
  openRecoveryStore,
} from '../lib/recovery/recovery-store.js';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.js';
import {
  enqueueApprovedPrompt,
  getQueueEntry,
  listQueueEntries,
  markRunWaiting,
  requestRunCancel,
} from '../lib/recovery/recovery-queue.js';
import { buildLogicalUsageIdentity } from '../lib/usage/usage-contract.js';
import {
  RECOVERY_LIFECYCLE_SCHEMA_VERSION,
  RUN_ACCEPTANCE_SOURCES,
  RUN_ACCEPTANCE_STATES,
  RUN_TERMINAL_PROOF_SOURCES,
  RecoveryLifecycleError,
  attachHistoryRef,
  beginRunLaunch,
  buildUsageIdentity,
  canAutoRelaunch,
  finishRun,
  isRecoveryLifecycleError,
  markAcceptanceUnconfirmed,
  recordExecutorAck,
} from '../lib/recovery/recovery-lifecycle.js';

/**
 * @returns {string}
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'recovery-lifecycle-'));
}

/**
 * @param {string} dir
 * @param {(store: object) => void} fn
 */
function withStore(dir, fn) {
  const store = openRecoveryStore({ dataDir: dir });
  try {
    fn(store);
  } finally {
    closeRecoveryStore(store);
  }
}

/**
 * @param {string} code
 * @returns {(err: unknown) => boolean}
 */
function lifecycleCode(code) {
  return (err) => isRecoveryLifecycleError(err) && err.code === code;
}

/**
 * Launch and ack a run, returning its ids and the post-ack run (state `running`,
 * `accepted` proof, revision 2).
 *
 * @param {object} store
 * @param {string} [harness]
 * @returns {{ ids: object, run: object }}
 */
function launchAndAck(store, harness = 'sdk') {
  const ids = createRecoveryIds();
  const launched = beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service', harness }, store);
  const ack = recordExecutorAck(
    { logicalRunId: ids.logicalRunId, expectedRevision: launched.run.revision, source: 'adapter_ack' },
    store
  );
  return { ids, run: ack.run };
}

// --- constants sanity ------------------------------------------------------

test('the lifecycle vocabulary matches the pinned contract of leaf R5', () => {
  assert.deepEqual([...RUN_ACCEPTANCE_STATES], ['accepted', 'unconfirmed']);
  assert.deepEqual([...RUN_ACCEPTANCE_SOURCES], ['adapter_ack', 'lookup_request', 'manual']);
  assert.deepEqual([...RUN_TERMINAL_PROOF_SOURCES], [
    'agent_report',
    'adapter_event',
    'probe_idle',
    'user_cancel',
    'manual',
  ]);
  assert.equal(RECOVERY_LIFECYCLE_SCHEMA_VERSION, 1);
  assert.ok(new RecoveryLifecycleError('x', { code: 'launch_blocked' }) instanceof Error);
});

// --- A. beginRunLaunch -----------------------------------------------------

test('beginRunLaunch persists a starting intent and replays idempotently by requestId', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      const first = beginRunLaunch(
        { ...ids, family: 'chat', owner: 'chat-run-service', harness: 'sdk', mode: 'agent', chatId: 'chat-1' },
        store
      );
      assert.equal(first.created, true);
      assert.equal(first.mayStart, true);
      assert.equal(first.run.state, 'starting');
      assert.equal(first.attempt.state, 'starting');
      assert.equal(first.attempt.attemptId, ids.attemptId);
      assert.deepEqual(first.ids, ids);
      assert.equal(first.queueEntry, null);
      // The launch token is metadata only — it must never carry prompt content.
      assert.equal(first.launchToken.state, 'starting');
      assert.equal('prompt' in first.launchToken, false);

      const replay = beginRunLaunch(
        { ...ids, family: 'chat', owner: 'chat-run-service', harness: 'sdk', mode: 'agent', chatId: 'chat-1' },
        store
      );
      assert.equal(replay.created, false);
      assert.equal(listRuns({}, store).length, 1, 'a replay must not add a second run row');
      assert.equal(getRun(ids.logicalRunId, store).state, 'starting');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beginRunLaunch rejects an unknown family / mismatched owner / bad id', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      assert.throws(
        () => beginRunLaunch({ ...ids, family: 'nonsense', owner: 'chat-run-service' }, store),
        lifecycleCode('invalid_launch_input')
      );
      assert.throws(
        () => beginRunLaunch({ ...ids, family: 'chat', owner: 'delegation-service' }, store),
        lifecycleCode('invalid_launch_input')
      );
      assert.throws(
        () =>
          beginRunLaunch(
            { logicalRunId: 'lrun_not-a-uuid', attemptId: ids.attemptId, requestId: ids.requestId, family: 'chat', owner: 'chat-run-service' },
            store
          ),
        lifecycleCode('invalid_launch_input')
      );
      assert.equal(listRuns({}, store).length, 0, 'no rejected launch persists');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed intent write blocks the launch and persists nothing', () => {
  const dir = tempDir();
  try {
    const ids = createRecoveryIds();
    const store = openRecoveryStore({ dataDir: dir });
    closeRecoveryStore(store);
    // Closed store: the intent write throws and the launch is blocked.
    assert.throws(
      () => beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service', prompt: 'hello' }, store),
      lifecycleCode('launch_blocked')
    );

    const reopened = openRecoveryStore({ dataDir: dir });
    try {
      assert.equal(getRun(ids.logicalRunId, reopened), null, 'no run was persisted');
      assert.equal(listQueueEntries({}, reopened).length, 0, 'no queue entry was persisted');
    } finally {
      closeRecoveryStore(reopened);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beginRunLaunch durably queues an approved prompt and blocks on a queue write failure', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      const launched = beginRunLaunch(
        { ...ids, family: 'chat', owner: 'chat-run-service', prompt: 'ship it', mode: 'agent' },
        store
      );
      assert.equal(launched.queueEntry.state, 'queued');
      const entry = getQueueEntry(launched.ids.requestId, store);
      assert.equal(entry.state, 'queued');
      assert.equal(entry.prompt, 'ship it');

      // Isolate the queue branch while the intent still succeeds. The run-intent
      // and queue ledger rows are keyed by (kind, request_id), so reusing a
      // requestId that is already bound to a *different* run's queue entry makes
      // the enqueue conflict without touching the (fresh) intent write. That
      // proves the queue step — not just the intent step — is a block signal.
      const foreign = createRecoveryIds();
      beginRunLaunch({ ...foreign, family: 'chat', owner: 'chat-run-service' }, store);
      const sharedReq = createRecoveryIds().requestId;
      enqueueApprovedPrompt(
        {
          logicalRunId: foreign.logicalRunId,
          attemptId: foreign.attemptId,
          requestId: sharedReq,
          family: 'chat',
          owner: 'chat-run-service',
          prompt: 'occupied',
        },
        store
      );
      const yIds = createRecoveryIds();
      assert.throws(
        () =>
          beginRunLaunch(
            {
              logicalRunId: yIds.logicalRunId,
              attemptId: yIds.attemptId,
              requestId: sharedReq,
              cycleId: yIds.cycleId,
              family: 'chat',
              owner: 'chat-run-service',
              prompt: 'late',
            },
            store
          ),
        (err) =>
          isRecoveryLifecycleError(err) &&
          err.code === 'launch_blocked' &&
          err.details.stage === 'queue' &&
          err.details.cause === 'request_conflict'
      );
      assert.equal(
        listQueueEntries({ logicalRunId: yIds.logicalRunId }, store).length,
        0,
        'a blocked launch added no queue entry for the new run'
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beginRunLaunch surfaces a foreign requestId as launch_blocked, never a silent foreign run', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      const other = createRecoveryIds();
      assert.throws(
        () =>
          beginRunLaunch(
            { ...other, requestId: ids.requestId, family: 'chat', owner: 'chat-run-service' },
            store
          ),
        (err) =>
          isRecoveryLifecycleError(err) && err.code === 'launch_blocked' && err.details.cause === 'request_conflict'
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- B. recordExecutorAck --------------------------------------------------

test('recordExecutorAck moves the run to running with an accepted proof and is idempotent', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      const launched = beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      const ack = recordExecutorAck(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: launched.run.revision,
          source: 'adapter_ack',
          adapterRunId: 'adm-1',
        },
        store
      );
      assert.equal(ack.applied, true);
      assert.equal(ack.run.state, 'running');
      assert.equal(ack.run.infraOutcome, 'accepted');
      assert.equal(ack.run.acceptance.state, 'accepted');
      assert.equal(ack.run.acceptance.source, 'adapter_ack');
      assert.equal(ack.acceptance.adapterRunId, 'adm-1');
      const rev = ack.run.revision;

      const again = recordExecutorAck(
        { logicalRunId: ids.logicalRunId, expectedRevision: rev, source: 'adapter_ack' },
        store
      );
      assert.equal(again.applied, false);
      assert.equal(again.reason, 'already_accepted');
      assert.equal(again.run.revision, rev, 'an already-accepted run must not grow its revision');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordExecutorAck requires a known source and cannot accept a terminal run', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      assert.throws(
        () => recordExecutorAck({ logicalRunId: ids.logicalRunId, expectedRevision: 1 }, store),
        lifecycleCode('invalid_acceptance_input')
      );
      assert.throws(
        () => recordExecutorAck({ logicalRunId: ids.logicalRunId, expectedRevision: 1, source: 'telegram' }, store),
        lifecycleCode('invalid_acceptance_input')
      );

      // A run cancelled without ever being accepted stays terminal and cannot
      // be "accepted" afterwards.
      const term = createRecoveryIds();
      const t0 = beginRunLaunch({ ...term, family: 'chat', owner: 'chat-run-service' }, store);
      finishRun(
        {
          logicalRunId: term.logicalRunId,
          expectedRevision: t0.run.revision,
          to: 'cancelled',
          infraOutcome: 'cancelled',
          proof: { source: 'user_cancel' },
        },
        store
      );
      const conflict = recordExecutorAck(
        { logicalRunId: term.logicalRunId, expectedRevision: t0.run.revision + 1, source: 'manual' },
        store
      );
      assert.equal(conflict.conflict, true);
      assert.equal(conflict.reason, 'illegal_transition');
      assert.equal(getRun(term.logicalRunId, store).state, 'cancelled');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- C. markAcceptanceUnconfirmed -----------------------------------------

test('markAcceptanceUnconfirmed keeps the run starting and cuts the relaunch gate', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      const launched = beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      const marked = markAcceptanceUnconfirmed(
        { logicalRunId: ids.logicalRunId, expectedRevision: launched.run.revision, reasonToken: 'ack-window-crash' },
        store
      );
      assert.equal(marked.applied, true);
      assert.equal(marked.run.state, 'starting', 'unconfirmed must not pretend the run is running');
      assert.equal(marked.run.acceptance.state, 'unconfirmed');
      assert.equal(marked.run.acceptance.reason, 'ack-window-crash');

      const gate = canAutoRelaunch({ logicalRunId: ids.logicalRunId, liveness: 'alive', harness: 'opencode' }, store);
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'no_acceptance_proof');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- E. canAutoRelaunch: the core gate ------------------------------------

test('the gate denies an auto relaunch without an acceptance proof, even for a reattach-capable live adapter', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service', harness: 'opencode' }, store);

      const plain = canAutoRelaunch({ logicalRunId: ids.logicalRunId }, store);
      assert.equal(plain.allowed, false);
      assert.equal(plain.reason, 'no_acceptance_proof');

      // The same run, now described as a live opencode executor, is STILL denied:
      // the missing acceptance proof outranks the adapter decision. Remove gate
      // rule E2 and this assertion goes red.
      const optimistic = canAutoRelaunch({ logicalRunId: ids.logicalRunId, liveness: 'alive', harness: 'opencode' }, store);
      assert.equal(optimistic.allowed, false);
      assert.equal(optimistic.reason, 'no_acceptance_proof');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate reflects run state and only an automatic adapter decision allows relaunch', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      // cancelled (after a real accepted ack)
      const cancelled = launchAndAck(store);
      requestRunCancel(
        { logicalRunId: cancelled.ids.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user_cancel' },
        store
      );
      const gCancelled = canAutoRelaunch({ logicalRunId: cancelled.ids.logicalRunId }, store);
      assert.equal(gCancelled.allowed, false);
      assert.equal(gCancelled.reason, 'cancelled');

      // waiting (question)
      const waiting = launchAndAck(store);
      markRunWaiting(
        {
          logicalRunId: waiting.ids.logicalRunId,
          expectedRevision: waiting.run.revision,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        store
      );
      const gWaiting = canAutoRelaunch({ logicalRunId: waiting.ids.logicalRunId }, store);
      assert.equal(gWaiting.allowed, false);
      assert.equal(gWaiting.reason, 'waiting');

      // still active (running after ack)
      const active = launchAndAck(store);
      const gActive = canAutoRelaunch({ logicalRunId: active.ids.logicalRunId }, store);
      assert.equal(gActive.allowed, false);
      assert.equal(gActive.reason, 'still_active');

      // interrupted + claude + dead -> manual_only (resume_session is not automatic)
      const claude = launchAndAck(store, 'claude');
      finishRun(
        {
          logicalRunId: claude.ids.logicalRunId,
          expectedRevision: claude.run.revision,
          to: 'interrupted',
          infraOutcome: 'interrupted',
          reason: 'running_orphan',
          proof: { source: 'probe_idle' },
        },
        store
      );
      const gClaude = canAutoRelaunch({ logicalRunId: claude.ids.logicalRunId, liveness: 'dead', harness: 'claude' }, store);
      assert.equal(gClaude.allowed, false);
      assert.equal(gClaude.reason, 'manual_only');
      assert.equal(gClaude.decision, 'resume_session');

      // interrupted + opencode + alive + prior accepted ack -> reattach (automatic)
      const opencode = launchAndAck(store, 'opencode');
      finishRun(
        {
          logicalRunId: opencode.ids.logicalRunId,
          expectedRevision: opencode.run.revision,
          to: 'interrupted',
          infraOutcome: 'interrupted',
          reason: 'running_orphan',
          proof: { source: 'adapter_event' },
        },
        store
      );
      const gOpencode = canAutoRelaunch({ logicalRunId: opencode.ids.logicalRunId, liveness: 'alive', harness: 'opencode' }, store);
      assert.equal(gOpencode.allowed, true);
      assert.equal(gOpencode.decision, 'reattach');

      // interrupted with reason unknown -> not_recoverable path (allowed false)
      const unknown = launchAndAck(store, 'sdk');
      finishRun(
        {
          logicalRunId: unknown.ids.logicalRunId,
          expectedRevision: unknown.run.revision,
          to: 'interrupted',
          infraOutcome: 'interrupted',
          reason: 'unknown',
          proof: { source: 'agent_report' },
        },
        store
      );
      const gUnknown = canAutoRelaunch({ logicalRunId: unknown.ids.logicalRunId, liveness: 'dead', harness: 'sdk' }, store);
      assert.equal(gUnknown.allowed, false);
      assert.equal(gUnknown.reason, 'manual_only');
      assert.equal(gUnknown.decision, 'not_recoverable');

      // missing run -> run_missing; empty input -> invalid_gate_input
      const gMissing = canAutoRelaunch({ logicalRunId: createRecoveryIds().logicalRunId }, store);
      assert.equal(gMissing.allowed, false);
      assert.equal(gMissing.reason, 'run_missing');
      assert.throws(() => canAutoRelaunch({}, store), lifecycleCode('invalid_gate_input'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- D. finishRun --------------------------------------------------------

test('finishRun without a terminal proof is refused and leaves the state untouched', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      const launched = beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      assert.throws(
        () =>
          finishRun(
            { logicalRunId: ids.logicalRunId, expectedRevision: launched.run.revision, to: 'completed', infraOutcome: 'completed' },
            store
          ),
        lifecycleCode('terminal_proof_required')
      );
      assert.throws(
        () =>
          finishRun(
            {
              logicalRunId: ids.logicalRunId,
              expectedRevision: launched.run.revision,
              to: 'completed',
              infraOutcome: 'completed',
              proof: { source: 'bogus_source' },
            },
            store
          ),
        lifecycleCode('terminal_proof_required')
      );
      assert.equal(getRun(ids.logicalRunId, store).state, 'starting', 'a refused finish must not mutate the state');

      // A non-terminal `to` is an input error, not a terminal write.
      assert.throws(
        () =>
          finishRun(
            {
              logicalRunId: ids.logicalRunId,
              expectedRevision: launched.run.revision,
              to: 'running',
              infraOutcome: 'accepted',
              proof: { source: 'manual' },
            },
            store
          ),
        lifecycleCode('invalid_terminal_input')
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finishRun records the terminal state and the server outranks the agent report', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      // completed, no blocking report -> accepted
      const done = launchAndAck(store);
      const completed = finishRun(
        {
          logicalRunId: done.ids.logicalRunId,
          expectedRevision: done.run.revision,
          to: 'completed',
          infraOutcome: 'completed',
          proof: { source: 'agent_report', detail: 'task complete' },
        },
        store
      );
      assert.equal(completed.applied, true);
      assert.equal(completed.run.state, 'completed');
      assert.equal(completed.run.terminalProof.source, 'agent_report');
      assert.equal(completed.run.terminalProof.state, 'completed');
      assert.equal(completed.outcome.accepted, true);
      assert.equal(completed.outcome.terminal, true);

      // completed but a FAIL verdict -> not accepted
      const fail = launchAndAck(store);
      const failResult = finishRun(
        {
          logicalRunId: fail.ids.logicalRunId,
          expectedRevision: fail.run.revision,
          to: 'completed',
          infraOutcome: 'completed',
          agentVerdict: 'FAIL',
          proof: { source: 'manual' },
        },
        store
      );
      assert.equal(failResult.outcome.accepted, false);

      // interrupted with a PASS agent report -> server truth wins
      const interrupted = launchAndAck(store);
      const interruptResult = finishRun(
        {
          logicalRunId: interrupted.ids.logicalRunId,
          expectedRevision: interrupted.run.revision,
          to: 'interrupted',
          infraOutcome: 'interrupted',
          reason: 'process_gone',
          agentVerdict: 'PASS',
          proof: { source: 'probe_idle' },
        },
        store
      );
      assert.equal(interruptResult.run.state, 'interrupted');
      assert.equal(interruptResult.run.reason, 'process_gone');
      assert.equal(interruptResult.outcome.accepted, false);
      assert.equal(interruptResult.outcome.countsAsFailure, true);

      // completed/cancelled must not inject 'unknown' as a reason
      const clean = launchAndAck(store);
      const cleanResult = finishRun(
        {
          logicalRunId: clean.ids.logicalRunId,
          expectedRevision: clean.run.revision,
          to: 'cancelled',
          infraOutcome: 'cancelled',
          proof: { source: 'user_cancel' },
        },
        store
      );
      assert.equal(cleanResult.run.reason, '', 'a cancelled finish leaves reason untouched (no unknown injection)');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finishRun on an already terminal run is idempotent for the same state and conflicts for another', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const run = launchAndAck(store);
      const completed = finishRun(
        {
          logicalRunId: run.ids.logicalRunId,
          expectedRevision: run.run.revision,
          to: 'completed',
          infraOutcome: 'completed',
          proof: { source: 'adapter_event' },
        },
        store
      );
      assert.equal(completed.applied, true);
      const rev = completed.run.revision;

      const replay = finishRun(
        {
          logicalRunId: run.ids.logicalRunId,
          expectedRevision: rev,
          to: 'completed',
          infraOutcome: 'completed',
          proof: { source: 'adapter_event' },
        },
        store
      );
      assert.equal(replay.applied, false);
      assert.equal(replay.reason, 'already_terminal');
      assert.equal(replay.run.revision, rev, 'an already-terminal replay performs no second write');
      assert.equal(replay.outcome.accepted, true);

      const different = finishRun(
        {
          logicalRunId: run.ids.logicalRunId,
          expectedRevision: rev,
          to: 'cancelled',
          infraOutcome: 'cancelled',
          proof: { source: 'user_cancel' },
        },
        store
      );
      assert.equal(different.conflict, true);
      assert.equal(different.reason, 'illegal_transition');
      assert.equal(getRun(run.ids.logicalRunId, store).state, 'completed', 'a conflicting finish mutates nothing');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CAS conflicts across all mutators ----------------------------------

test('a stale expectedRevision conflicts without mutating the run', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);

      const ack = recordExecutorAck(
        { logicalRunId: ids.logicalRunId, expectedRevision: 99, source: 'adapter_ack' },
        store
      );
      assert.equal(ack.conflict, true);
      assert.equal(ack.reason, 'revision_conflict');

      const unconfirmed = markAcceptanceUnconfirmed(
        { logicalRunId: ids.logicalRunId, expectedRevision: 99, reasonToken: 'x' },
        store
      );
      assert.equal(unconfirmed.conflict, true);
      assert.equal(unconfirmed.reason, 'revision_conflict');

      const history = attachHistoryRef(
        { logicalRunId: ids.logicalRunId, expectedRevision: 99, history: { chatId: 'c', seq: 1 } },
        store
      );
      assert.equal(history.conflict, true);
      assert.equal(history.reason, 'revision_conflict');

      const finish = finishRun(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 99,
          to: 'completed',
          infraOutcome: 'completed',
          proof: { source: 'manual' },
        },
        store
      );
      assert.equal(finish.conflict, true);
      assert.equal(finish.reason, 'revision_conflict');

      const run = getRun(ids.logicalRunId, store);
      assert.equal(run.revision, 1, 'no conflicting write bumped the revision');
      assert.equal(run.state, 'starting');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- F. attachHistoryRef + buildUsageIdentity ----------------------------

test('attachHistoryRef validates the reference and persists it across a restart', () => {
  const dir = tempDir();
  try {
    let logicalRunId = '';
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      logicalRunId = ids.logicalRunId;
      const launched = beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      const rev = launched.run.revision;

      assert.throws(
        () => attachHistoryRef({ logicalRunId, expectedRevision: rev, history: { chatId: 'c', seq: 0 } }, store),
        lifecycleCode('invalid_terminal_input')
      );
      assert.throws(
        () => attachHistoryRef({ logicalRunId, expectedRevision: rev, history: { chatId: 'c', seq: 'x' } }, store),
        lifecycleCode('invalid_terminal_input')
      );
      assert.throws(
        () => attachHistoryRef({ logicalRunId, expectedRevision: rev, history: { seq: 5 } }, store),
        lifecycleCode('invalid_terminal_input')
      );

      const attached = attachHistoryRef(
        { logicalRunId, expectedRevision: rev, history: { chatId: 'chat-9', seq: 42 } },
        store
      );
      assert.equal(attached.applied, true);
      assert.equal(attached.run.state, 'starting', 'attaching history keeps the lifecycle state');
      assert.equal(attached.run.history.chatId, 'chat-9');
      assert.equal(attached.run.history.seq, 42);
    });

    // Reopen the same data dir: the history reference survived the restart.
    withStore(dir, (store) => {
      const run = getRun(logicalRunId, store);
      assert.ok(run, 'run survived the restart');
      assert.equal(run.history.seq, 42);
      assert.equal(run.history.chatId, 'chat-9');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildUsageIdentity maps recovery ids into a durable_sequence telemetry identity', () => {
  const ids = createRecoveryIds();
  const input = {
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    sessionId: 'session-abc',
    requestId: ids.requestId,
    harness: 'opencode',
  };
  const mapped = buildUsageIdentity(input);

  // The mapping is directly consumable by the telemetry contract.
  assert.equal(buildLogicalUsageIdentity(mapped).identityClass, 'durable_sequence');

  // Ids are handed over unchanged and remain single short tokens.
  assert.equal(mapped.runId, ids.logicalRunId);
  assert.equal(mapped.attemptId, ids.attemptId);
  assert.equal(mapped.sourceSessionId, 'session-abc');
  assert.equal(mapped.requestId, ids.requestId);
  for (const value of [ids.logicalRunId, ids.attemptId, ids.requestId]) {
    assert.ok(value.length <= 64, `${value} must fit the 64-char telemetry cap`);
    assert.equal(/\s/.test(value), false, `${value} must contain no whitespace`);
  }

  // Purity: identical input yields an identical result with no I/O.
  assert.deepEqual(buildUsageIdentity(input), buildUsageIdentity(input));
});

// --- durability of acceptance + terminal proof --------------------------

test('acceptance and terminal proof survive a store restart with a stable gate verdict', () => {
  const dir = tempDir();
  let logicalRunId = '';
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      logicalRunId = ids.logicalRunId;
      const launched = beginRunLaunch({ ...ids, family: 'chat', owner: 'chat-run-service' }, store);
      const ack = recordExecutorAck(
        {
          logicalRunId,
          expectedRevision: launched.run.revision,
          source: 'adapter_ack',
          adapterRunId: 'adm-9',
        },
        store
      );
      const finish = finishRun(
        {
          logicalRunId,
          expectedRevision: ack.run.revision,
          to: 'completed',
          infraOutcome: 'completed',
          proof: { source: 'adapter_event', detail: 'ok' },
        },
        store
      );
      assert.equal(finish.applied, true);
    });

    withStore(dir, (store) => {
      const run = getRun(logicalRunId, store);
      assert.equal(run.state, 'completed');
      assert.equal(run.acceptance.state, 'accepted');
      assert.equal(run.acceptance.adapterRunId, 'adm-9');
      assert.equal(run.terminalProof.source, 'adapter_event');
      assert.equal(run.terminalProof.state, 'completed');

      const gate = canAutoRelaunch({ logicalRunId, liveness: 'alive', harness: 'opencode' }, store);
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'already_completed');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
