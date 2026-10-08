/**
 * Unit tests for the durable approved-prompt queue, durable Stop/cancel and
 * durable waiting (leaf R4).
 *
 * Every test uses its own temporary data dir, so the suite never touches the
 * real `data/` store. The inter-process SIGKILL durability cases live in
 * `tests/recovery-queue-crash.test.js`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeRecoveryStore,
  getRecoveryStoreDatabase,
  getRun,
  listRuns,
  openRecoveryStore,
  transitionRun,
  writeRunIntent,
} from '../lib/recovery/recovery-store.js';
import { createRecoveryIds, newRecoveryId } from '../lib/recovery/recovery-ids.js';
import {
  RECOVERY_QUEUE_ENTRY_STATES,
  RECOVERY_QUEUE_WAITING_KINDS,
  RecoveryQueueError,
  claimNextQueuedEntry,
  enqueueApprovedPrompt,
  getQueueEntry,
  getRunCancel,
  getRunWaiting,
  isRecoveryQueueError,
  isRunCancelled,
  listCancelledRuns,
  listQueueEntries,
  listWaitingRuns,
  markRunWaiting,
  requestRunCancel,
  resolveQueueEntryAction,
  resolveRunWaiting,
} from '../lib/recovery/recovery-queue.js';

/**
 * @returns {string}
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'recovery-queue-'));
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
 * Seed one logical run through the real intent store.
 *
 * @param {object} store
 * @param {{ family?: string, owner?: string, workspaceFolder?: string, chatId?: string }} [extra]
 * @returns {{ ids: object, run: object }}
 */
function seedRun(store, extra = {}) {
  const ids = createRecoveryIds();
  const family = extra.family || 'chat';
  const owner = extra.owner || 'chat-run-service';
  const result = writeRunIntent(
    {
      logicalRunId: ids.logicalRunId,
      attemptId: ids.attemptId,
      requestId: ids.requestId,
      family,
      owner,
      workspaceFolder: extra.workspaceFolder || '',
      chatId: extra.chatId || '',
    },
    store
  );
  return { ids, run: result.run };
}

/**
 * A prompt payload with quotes, a newline and multibyte characters so a
 * round-trip can be compared byte-for-byte.
 */
const RICH_PROMPT = 'Approved: "deploy" \u0105\u0107\u0119\u0142\nline-2 \u{1f680}';

/**
 * @param {object} store
 * @param {object} ids
 * @param {object} [extra]
 * @returns {object}
 */
function enqueue(store, ids, extra = {}) {
  const queueIds = createRecoveryIds();
  const result = enqueueApprovedPrompt(
    {
      logicalRunId: ids.logicalRunId,
      attemptId: ids.attemptId,
      requestId: queueIds.requestId,
      family: 'chat',
      owner: 'chat-run-service',
      prompt: RICH_PROMPT,
      promptRef: 'ref-1',
      workspaceFolder: extra.workspaceFolder ?? '',
      chatId: extra.chatId ?? '',
      harness: 'sdk',
      model: 'model-x',
      mode: 'agent',
      ...extra,
    },
    store
  );
  return result;
}

// ---------------------------------------------------------------------------
// enqueueApprovedPrompt
// ---------------------------------------------------------------------------

test('enqueue persists payload + metadata and is idempotent by requestId', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store, { workspaceFolder: '/ws', chatId: 'chat-1' });
      const queueIds = createRecoveryIds();
      const input = {
        logicalRunId: ids.logicalRunId,
        attemptId: ids.attemptId,
        requestId: queueIds.requestId,
        family: 'chat',
        owner: 'chat-run-service',
        workspaceFolder: '/ws',
        chatId: 'chat-1',
        harness: 'sdk',
        model: 'model-x',
        mode: 'agent',
        prompt: RICH_PROMPT,
        promptRef: 'ref-1',
        now: '2026-05-01T00:00:00.000Z',
      };

      const first = enqueueApprovedPrompt(input, store);
      assert.equal(first.created, true);
      assert.equal(first.entry.state, 'queued');
      assert.equal(first.entry.queueId, queueIds.requestId);
      assert.equal(first.entry.logicalRunId, ids.logicalRunId);
      assert.equal(first.entry.attemptId, ids.attemptId);
      assert.equal(first.entry.prompt, RICH_PROMPT);
      assert.equal(first.entry.promptRef, 'ref-1');
      assert.equal(first.entry.createdAt, '2026-05-01T00:00:00.000Z');
      assert.equal(first.entry.workspaceFolder, '/ws');

      assert.deepEqual(getQueueEntry(queueIds.requestId, store), first.entry);

      const replay = enqueueApprovedPrompt(input, store);
      assert.equal(replay.created, false);
      assert.equal(replay.entry.queueId, first.entry.queueId);
      assert.equal(replay.entry.prompt, RICH_PROMPT);
      assert.equal(listQueueEntries({}, store).length, 1);

      // No idempotency ledger duplicate either.
      const ledger = store.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_requests WHERE kind = 'queue_enqueue'")
        .get();
      assert.equal(Number(ledger.n), 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enqueue default queueId equals requestId and an explicit queueId is kept', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const queueIds = createRecoveryIds();
      const result = enqueueApprovedPrompt(
        {
          logicalRunId: ids.logicalRunId,
          attemptId: ids.attemptId,
          requestId: queueIds.requestId,
          family: 'chat',
          owner: 'chat-run-service',
        },
        store
      );
      assert.equal(result.entry.queueId, queueIds.requestId);

      const second = enqueueApprovedPrompt(
        {
          logicalRunId: ids.logicalRunId,
          attemptId: ids.attemptId,
          requestId: createRecoveryIds().requestId,
          queueId: 'external-key-42',
          family: 'chat',
          owner: 'chat-run-service',
        },
        store
      );
      assert.equal(second.entry.queueId, 'external-key-42');
      assert.ok(getQueueEntry('external-key-42', store));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enqueue rejects malformed input with invalid_queue_input and writes nothing', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const good = {
        logicalRunId: ids.logicalRunId,
        attemptId: ids.attemptId,
        requestId: createRecoveryIds().requestId,
        family: 'chat',
        owner: 'chat-run-service',
      };
      const cases = [
        { ...good, logicalRunId: 'not-an-id' },
        { ...good, attemptId: 'att_not-a-uuid' },
        { ...good, requestId: '' },
        { ...good, requestId: 'req_after_crash' },
        { ...good, requestId: newRecoveryId('logical_run') },
        { ...good, family: 'nope' },
        { ...good, owner: 'someone-else' },
        { ...good, queueId: '   ' },
      ];
      for (const bad of cases) {
        assert.throws(
          () => enqueueApprovedPrompt(bad, store),
          (err) => {
            assert.ok(isRecoveryQueueError(err));
            assert.equal(err.code, 'invalid_queue_input');
            return true;
          }
        );
      }
      assert.equal(listQueueEntries({}, store).length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enqueue of an unknown run is invalid_queue_input with run_not_found', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = createRecoveryIds();
      assert.throws(
        () =>
          enqueueApprovedPrompt(
            {
              logicalRunId: ids.logicalRunId,
              attemptId: ids.attemptId,
              requestId: createRecoveryIds().requestId,
              family: 'chat',
              owner: 'chat-run-service',
            },
            store
          ),
        (err) => {
          assert.equal(err.code, 'invalid_queue_input');
          assert.equal(err.details.cause, 'run_not_found');
          return true;
        }
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enqueue rejects a reused requestId for another identity with request_conflict', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const a = seedRun(store);
      const b = seedRun(store);
      const queueIds = createRecoveryIds();
      enqueueApprovedPrompt(
        {
          logicalRunId: a.ids.logicalRunId,
          attemptId: a.ids.attemptId,
          requestId: queueIds.requestId,
          family: 'chat',
          owner: 'chat-run-service',
        },
        store
      );

      assert.throws(
        () =>
          enqueueApprovedPrompt(
            {
              logicalRunId: b.ids.logicalRunId,
              attemptId: b.ids.attemptId,
              requestId: queueIds.requestId,
              family: 'chat',
              owner: 'chat-run-service',
            },
            store
          ),
        (err) => {
          assert.ok(err instanceof RecoveryQueueError);
          assert.equal(err.code, 'request_conflict');
          assert.equal(err.details.requestId, queueIds.requestId);
          return true;
        }
      );
      assert.equal(listQueueEntries({}, store).length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed enqueue throws queue_write_failed and leaves no partial row', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const { ids } = seedRun(store);

    // Writable connection flipped read-only: the committed write must fail
    // loudly instead of pretending the prompt was queued.
    store.db.exec('PRAGMA query_only = ON;');
    assert.throws(
      () =>
        enqueueApprovedPrompt(
          {
            logicalRunId: ids.logicalRunId,
            attemptId: ids.attemptId,
            requestId: createRecoveryIds().requestId,
            family: 'chat',
            owner: 'chat-run-service',
            prompt: RICH_PROMPT,
          },
          store
        ),
      (err) => isRecoveryQueueError(err) && err.code === 'queue_write_failed'
    );
    store.db.exec('PRAGMA query_only = OFF;');
    assert.equal(listQueueEntries({}, store).length, 0, 'no partial queue row');
    const ledger = store.db
      .prepare("SELECT COUNT(*) AS n FROM recovery_requests WHERE kind = 'queue_enqueue'")
      .get();
    assert.equal(Number(ledger.n), 0, 'no partial request ledger row');
    closeRecoveryStore(store);

    // A raw database close is the same block-ACK failure.
    const second = openRecoveryStore({ dataDir: dir });
    getRecoveryStoreDatabase(second).close();
    assert.throws(
      () =>
        enqueueApprovedPrompt(
          {
            logicalRunId: ids.logicalRunId,
            attemptId: ids.attemptId,
            requestId: createRecoveryIds().requestId,
            family: 'chat',
            owner: 'chat-run-service',
          },
          second
        ),
      (err) => isRecoveryQueueError(err) && err.code === 'queue_write_failed'
    );
    second.closed = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// claimNextQueuedEntry
// ---------------------------------------------------------------------------

test('two independent connections resolve a claim to exactly one winner', () => {
  const dir = tempDir();
  const storeA = openRecoveryStore({ dataDir: dir });
  const storeB = openRecoveryStore({ dataDir: dir });
  try {
    const { ids } = seedRun(storeA);
    const queueIds = createRecoveryIds();
    enqueueApprovedPrompt(
      {
        logicalRunId: ids.logicalRunId,
        attemptId: ids.attemptId,
        requestId: queueIds.requestId,
        family: 'chat',
        owner: 'chat-run-service',
      },
      storeA
    );

    const first = claimNextQueuedEntry({}, storeA);
    const second = claimNextQueuedEntry({}, storeB);
    const winners = [first, second].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one connection claims the entry');
    assert.equal(winners[0].entry.state, 'launched');
    assert.equal(getQueueEntry(queueIds.requestId, storeB).state, 'launched');
    assert.equal(listQueueEntries({ state: 'queued' }, storeA).length, 0);
  } finally {
    closeRecoveryStore(storeA);
    closeRecoveryStore(storeB);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim skips waiting/cancelled runs and waiting/cancelled entries', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      // Waiting run (queued entry stays queued; claim is blocked by run state).
      const waitingRun = seedRun(store);
      enqueue(store, waitingRun.ids);
      const waitingMark = markRunWaiting(
        {
          logicalRunId: waitingRun.ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        store
      );
      assert.equal(waitingMark.ok, true);

      // Cancelled run (and its queued entry cancelled by requestRunCancel).
      const cancelledRun = seedRun(store);
      enqueue(store, cancelledRun.ids);
      requestRunCancel(
        { logicalRunId: cancelledRun.ids.logicalRunId, requestId: createRecoveryIds().requestId },
        store
      );

      // Crash-gap simulation: a queued entry whose run is already cancelled but
      // whose own state never caught up. The claim join must still skip it.
      const gapRun = seedRun(store);
      const gapEntry = enqueue(store, gapRun.ids).entry;
      transitionRun(
        { logicalRunId: gapRun.ids.logicalRunId, expectedRevision: 1, to: 'cancelled' },
        store
      );
      assert.equal(getQueueEntry(gapEntry.queueId, store).state, 'queued');

      assert.equal(claimNextQueuedEntry({}, store), null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claim honors family and workspace filters', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const chat = seedRun(store, { workspaceFolder: '/ws/chat' });
      const delegationIds = createRecoveryIds();
      writeRunIntent(
        {
          logicalRunId: delegationIds.logicalRunId,
          attemptId: delegationIds.attemptId,
          requestId: delegationIds.requestId,
          family: 'delegation',
          owner: 'delegation-service',
          workspaceFolder: '/ws/deleg',
        },
        store
      );
      enqueue(store, chat.ids, { workspaceFolder: '/ws/chat' });
      enqueueApprovedPrompt(
        {
          logicalRunId: delegationIds.logicalRunId,
          attemptId: delegationIds.attemptId,
          requestId: createRecoveryIds().requestId,
          family: 'delegation',
          owner: 'delegation-service',
          workspaceFolder: '/ws/deleg',
        },
        store
      );

      const delegationClaim = claimNextQueuedEntry({ family: 'delegation' }, store);
      assert.ok(delegationClaim);
      assert.equal(delegationClaim.entry.family, 'delegation');

      const workspaceClaim = claimNextQueuedEntry({ workspaceFolder: '/ws/chat' }, store);
      assert.ok(workspaceClaim);
      assert.equal(workspaceClaim.entry.workspaceFolder, '/ws/chat');

      assert.equal(claimNextQueuedEntry({ family: 'delegation' }, store), null);
      assert.equal(claimNextQueuedEntry({ family: 'nope' }, store), null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// requestRunCancel / isRunCancelled
// ---------------------------------------------------------------------------

test('requestRunCancel durably cancels the run and its queued entries, idempotently', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const entry = enqueue(store, ids).entry;
      const cancelIds = createRecoveryIds();

      const first = requestRunCancel(
        { logicalRunId: ids.logicalRunId, requestId: cancelIds.requestId, reason: 'user_stop' },
        store
      );
      assert.equal(first.cancelled, true);
      assert.equal(first.alreadyCancelled, false);
      assert.equal(first.run.state, 'cancelled');
      assert.equal(first.entries.length, 1);
      assert.equal(first.entries[0].state, 'cancelled');
      assert.equal(first.cancel.reason, 'user_stop');

      assert.equal(isRunCancelled(ids.logicalRunId, store), true);
      assert.equal(getRunCancel(ids.logicalRunId, store).requestId, cancelIds.requestId);

      const cancelled = listCancelledRuns({}, store);
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].logicalRunId, ids.logicalRunId);
      assert.equal(cancelled[0].reason, 'user_stop');

      // Same requestId replay: idempotent, no duplicate ledger row.
      const replay = requestRunCancel(
        { logicalRunId: ids.logicalRunId, requestId: cancelIds.requestId },
        store
      );
      assert.equal(replay.cancelled, false);
      assert.equal(replay.alreadyCancelled, true);
      const ledger = store.db
        .prepare("SELECT COUNT(*) AS n FROM recovery_requests WHERE kind = 'run_cancel'")
        .get();
      assert.equal(Number(ledger.n), 1);

      // A different requestId on an already-cancelled run is still idempotent.
      const again = requestRunCancel(
        { logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId },
        store
      );
      assert.equal(again.cancelled, false);
      assert.equal(again.alreadyCancelled, true);

      // Stop wins over the queued entry: it can never be claimed again.
      assert.equal(claimNextQueuedEntry({}, store), null);
      assert.equal(getQueueEntry(entry.queueId, store).state, 'cancelled');
      assert.deepEqual(resolveQueueEntryAction(getQueueEntry(entry.queueId, store), getRun(ids.logicalRunId, store)), {
        action: 'skip',
        automatic: false,
        rationale: 'Run lub wpis anulowany trwale; Stop zakazuje wznowienia.',
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requestRunCancel rejects bad input and a reused requestId for another run', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const a = seedRun(store);
      const b = seedRun(store);
      const cancelIds = createRecoveryIds();

      assert.throws(
        () => requestRunCancel({ logicalRunId: 'nope', requestId: cancelIds.requestId }, store),
        (err) => err.code === 'invalid_cancel_input'
      );
      assert.throws(
        () => requestRunCancel({ logicalRunId: a.ids.logicalRunId, requestId: '' }, store),
        (err) => err.code === 'invalid_cancel_input'
      );
      assert.throws(
        () =>
          requestRunCancel(
            { logicalRunId: newRecoveryId('logical_run'), requestId: cancelIds.requestId },
            store
          ),
        (err) => err.code === 'invalid_cancel_input' && err.details.cause === 'run_not_found'
      );

      requestRunCancel({ logicalRunId: a.ids.logicalRunId, requestId: cancelIds.requestId }, store);
      assert.throws(
        () => requestRunCancel({ logicalRunId: b.ids.logicalRunId, requestId: cancelIds.requestId }, store),
        (err) => err.code === 'request_conflict'
      );

      assert.equal(isRunCancelled(a.ids.logicalRunId, store), true);
      assert.equal(isRunCancelled(b.ids.logicalRunId, store), false);
      assert.equal(isRunCancelled('', store), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed cancel throws cancel_write_failed', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const { ids } = seedRun(store);
    store.db.exec('PRAGMA query_only = ON;');
    assert.throws(
      () =>
        requestRunCancel(
          { logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId },
          store
        ),
      (err) => isRecoveryQueueError(err) && err.code === 'cancel_write_failed'
    );
    store.db.exec('PRAGMA query_only = OFF;');
    assert.equal(getRun(ids.logicalRunId, store).state, 'starting');
    assert.equal(getRunCancel(ids.logicalRunId, store), null);
    closeRecoveryStore(store);

    const second = openRecoveryStore({ dataDir: dir });
    getRecoveryStoreDatabase(second).close();
    assert.throws(
      () =>
        requestRunCancel(
          { logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId },
          second
        ),
      (err) => isRecoveryQueueError(err) && err.code === 'cancel_write_failed'
    );
    second.closed = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling a completed run does not throw and does not resurrect it', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: 1, to: 'completed' }, store);
      const result = requestRunCancel(
        { logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId },
        store
      );
      assert.equal(result.cancelled, false);
      assert.equal(result.alreadyCancelled, false);
      assert.equal(getRun(ids.logicalRunId, store).state, 'completed');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// markRunWaiting / resolveRunWaiting
// ---------------------------------------------------------------------------

test('markRunWaiting transitions to waiting and durably records pending input', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const waitingIds = createRecoveryIds();
      const result = markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'approval',
          requestId: waitingIds.requestId,
          promptRef: 'approval-1',
          now: '2026-06-01T00:00:00.000Z',
        },
        store
      );
      assert.equal(result.ok, true);
      assert.equal(result.applied, true);
      assert.equal(result.conflict, false);
      assert.equal(result.run.state, 'waiting');

      const waiting = getRunWaiting(ids.logicalRunId, store);
      assert.equal(waiting.kind, 'approval');
      assert.equal(waiting.state, 'pending');
      assert.equal(waiting.promptRef, 'approval-1');

      const listed = listWaitingRuns({}, store);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].family, 'chat');
      assert.equal(listed[0].owner, 'chat-run-service');
      assert.equal(listed[0].runState, 'waiting');
      assert.equal(listWaitingRuns({ kind: 'question' }, store).length, 0);
      assert.equal(listWaitingRuns({ kind: 'approval' }, store).length, 1);

      // Idempotent replay by requestId.
      const replay = markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'approval',
          requestId: waitingIds.requestId,
        },
        store
      );
      assert.equal(replay.ok, true);
      assert.equal(replay.applied, false);
      assert.equal(replay.reason, 'already_waiting');

      // A stale revision is a value conflict, not a throw.
      const stale = markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        store
      );
      assert.equal(stale.ok, false);
      assert.equal(stale.conflict, true);
      assert.equal(stale.reason, 'revision_conflict');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markRunWaiting rejects a bad kind with invalid_waiting_input', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      assert.deepEqual([...RECOVERY_QUEUE_WAITING_KINDS], ['question', 'approval']);
      for (const kind of ['', 'confirm', 'auto']) {
        assert.throws(
          () =>
            markRunWaiting(
              {
                logicalRunId: ids.logicalRunId,
                expectedRevision: 1,
                kind,
                requestId: createRecoveryIds().requestId,
              },
              store
            ),
          (err) => err.code === 'invalid_waiting_input'
        );
      }
      assert.throws(
        () =>
          markRunWaiting(
            {
              logicalRunId: ids.logicalRunId,
              expectedRevision: 0,
              kind: 'question',
              requestId: createRecoveryIds().requestId,
            },
            store
          ),
        (err) => err.code === 'invalid_waiting_input'
      );
      assert.equal(getRun(ids.logicalRunId, store).state, 'starting');
      assert.equal(listWaitingRuns({}, store).length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markRunWaiting conflicts when a requestId is reused for another run', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const a = seedRun(store);
      const b = seedRun(store);
      const waitingIds = createRecoveryIds();
      markRunWaiting(
        {
          logicalRunId: a.ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: waitingIds.requestId,
        },
        store
      );
      assert.throws(
        () =>
          markRunWaiting(
            {
              logicalRunId: b.ids.logicalRunId,
              expectedRevision: 1,
              kind: 'question',
              requestId: waitingIds.requestId,
            },
            store
          ),
        (err) => err.code === 'request_conflict'
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRunWaiting returns to running, clears pending input and is idempotent', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        store
      );
      const resolveIds = createRecoveryIds();
      const result = resolveRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 2,
          requestId: resolveIds.requestId,
          answer: 'yes',
        },
        store
      );
      assert.equal(result.ok, true);
      assert.equal(result.applied, true);
      assert.equal(result.run.state, 'running');
      assert.equal(getRunWaiting(ids.logicalRunId, store), null);
      assert.equal(listWaitingRuns({}, store).length, 0);

      const replay = resolveRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 2,
          requestId: resolveIds.requestId,
        },
        store
      );
      assert.equal(replay.ok, true);
      assert.equal(replay.applied, false);
      assert.equal(replay.reason, 'already_resolved');

      // A different requestId after the run is running is also idempotent.
      const again = resolveRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 3,
          requestId: createRecoveryIds().requestId,
          answer: 'again',
        },
        store
      );
      assert.equal(again.ok, true);
      assert.equal(again.applied, false);
      assert.equal(again.reason, 'already_resolved');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a waiting run keeps a never-claimed queued entry claimable after resolve', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const entry = enqueue(store, ids).entry;
      markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        store
      );
      assert.equal(getQueueEntry(entry.queueId, store).state, 'queued');
      assert.equal(claimNextQueuedEntry({}, store), null);

      const waiting = getRunWaiting(ids.logicalRunId, store);
      const run = getRun(ids.logicalRunId, store);
      const decision = resolveQueueEntryAction(entry, run);
      assert.equal(decision.action, 'manual_only');
      assert.equal(decision.automatic, false);
      assert.equal(waiting.state, 'pending');

      resolveRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 2,
          requestId: createRecoveryIds().requestId,
          answer: 'go',
        },
        store
      );
      assert.equal(getQueueEntry(entry.queueId, store).state, 'queued');
      const claimed = claimNextQueuedEntry({}, store);
      assert.ok(claimed, 'queued entry is claimable after waiting resolves');
      assert.equal(claimed.entry.queueId, entry.queueId);
      assert.equal(claimed.entry.state, 'launched');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markRunWaiting parks a launched queue entry and resolve restores launched', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const entry = enqueue(store, ids).entry;
      const claimed = claimNextQueuedEntry({}, store);
      assert.equal(claimed.entry.queueId, entry.queueId);
      markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        store
      );
      assert.equal(getQueueEntry(entry.queueId, store).state, 'waiting');
      assert.equal(claimNextQueuedEntry({}, store), null);

      resolveRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 2,
          requestId: createRecoveryIds().requestId,
          answer: 'go',
        },
        store
      );
      assert.equal(getQueueEntry(entry.queueId, store).state, 'launched');
      assert.equal(claimNextQueuedEntry({}, store), null, 'already launched, not re-claimed');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getRunWaiting and listWaitingRuns synthesize pending input when the ledger row is missing', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      const waitingIds = createRecoveryIds();
      const entry = enqueue(store, ids).entry;
      const applied = transitionRun(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          to: 'waiting',
          patch: {
            waitingRequestId: waitingIds.requestId,
            waitingKind: 'question',
            waitingPromptRef: 'synth-ref',
            waitingSince: '2026-06-01T00:00:00.000Z',
          },
        },
        store
      );
      assert.equal(applied.ok, true);
      assert.equal(getRun(ids.logicalRunId, store).state, 'waiting');

      const waiting = getRunWaiting(ids.logicalRunId, store);
      assert.ok(waiting, 'pending question is discoverable from run metadata');
      assert.equal(waiting.requestId, waitingIds.requestId);
      assert.equal(waiting.kind, 'question');
      assert.equal(waiting.state, 'pending');
      assert.equal(waiting.promptRef, 'synth-ref');

      const listed = listWaitingRuns({}, store);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].runState, 'waiting');

      const decision = resolveQueueEntryAction(entry, getRun(ids.logicalRunId, store));
      assert.equal(decision.action, 'manual_only');
      assert.equal(decision.automatic, false);

      const resolved = resolveRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 2,
          requestId: createRecoveryIds().requestId,
          answer: 'ok',
        },
        store
      );
      assert.equal(resolved.ok, true);
      assert.equal(getRunWaiting(ids.logicalRunId, store), null);
      assert.equal(listWaitingRuns({}, store).length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed markRunWaiting throws waiting_write_failed and leaves no pending row', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const { ids } = seedRun(store);
    store.db.exec('PRAGMA query_only = ON;');
    assert.throws(
      () =>
        markRunWaiting(
          {
            logicalRunId: ids.logicalRunId,
            expectedRevision: 1,
            kind: 'question',
            requestId: createRecoveryIds().requestId,
          },
          store
        ),
      (err) => isRecoveryQueueError(err) && err.code === 'waiting_write_failed'
    );
    store.db.exec('PRAGMA query_only = OFF;');
    assert.equal(getRun(ids.logicalRunId, store).state, 'starting');
    assert.equal(getRunWaiting(ids.logicalRunId, store), null);
    assert.equal(listWaitingRuns({}, store).length, 0);
    closeRecoveryStore(store);

    const second = openRecoveryStore({ dataDir: dir });
    getRecoveryStoreDatabase(second).close();
    assert.throws(
      () =>
        markRunWaiting(
          {
            logicalRunId: ids.logicalRunId,
            expectedRevision: 1,
            kind: 'approval',
            requestId: createRecoveryIds().requestId,
          },
          second
        ),
      (err) => isRecoveryQueueError(err) && err.code === 'waiting_write_failed'
    );
    second.closed = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRunWaiting rejects bad input with invalid_waiting_input', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const { ids } = seedRun(store);
      assert.throws(
        () =>
          resolveRunWaiting(
            { logicalRunId: ids.logicalRunId, expectedRevision: 1, requestId: 'nope' },
            store
          ),
        (err) => err.code === 'invalid_waiting_input'
      );
      assert.throws(
        () =>
          resolveRunWaiting(
            { logicalRunId: ids.logicalRunId, expectedRevision: 0, requestId: createRecoveryIds().requestId },
            store
          ),
        (err) => err.code === 'invalid_waiting_input'
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveQueueEntryAction
// ---------------------------------------------------------------------------

test('resolveQueueEntryAction is deterministic and never auto-launches waiting', () => {
  assert.deepEqual([...RECOVERY_QUEUE_ENTRY_STATES], ['queued', 'launched', 'waiting', 'cancelled']);

  const queued = { state: 'queued' };
  const launched = { state: 'launched' };
  const entryWaiting = { state: 'waiting' };
  const entryCancelled = { state: 'cancelled' };
  const runRunning = { state: 'running' };
  const runStarting = { state: 'starting' };
  const runWaiting = { state: 'waiting' };
  const runCancelled = { state: 'cancelled' };
  const runCompleted = { state: 'completed' };

  const launch = resolveQueueEntryAction(queued, runRunning);
  assert.equal(launch.action, 'launch');
  assert.equal(launch.automatic, true);

  // A queued entry whose run is starting is still launchable (non-waiting,
  // non-cancelled).
  assert.equal(resolveQueueEntryAction(queued, runStarting).action, 'launch');
  assert.equal(resolveQueueEntryAction(queued, runCompleted).action, 'launch');

  for (const decision of [
    resolveQueueEntryAction(queued, runWaiting),
    resolveQueueEntryAction(entryWaiting, runRunning),
    resolveQueueEntryAction(entryWaiting, runWaiting),
  ]) {
    assert.equal(decision.action, 'manual_only');
    assert.equal(decision.automatic, false);
  }

  for (const decision of [
    resolveQueueEntryAction(entryCancelled, runRunning),
    resolveQueueEntryAction(queued, runCancelled),
    resolveQueueEntryAction(entryCancelled, runCancelled),
    resolveQueueEntryAction(launched, runRunning),
    resolveQueueEntryAction(queued, null),
    resolveQueueEntryAction(null, runRunning),
    resolveQueueEntryAction(undefined, undefined),
  ]) {
    assert.equal(decision.action, 'skip');
    assert.equal(decision.automatic, false);
  }
});

// ---------------------------------------------------------------------------
// Persistence across close/reopen + foreign keys
// ---------------------------------------------------------------------------

test('queue, cancel and waiting survive close/reopen', () => {
  const dir = tempDir();
  const queueIds = createRecoveryIds();
  const cancelIds = createRecoveryIds();
  try {
    let runId;
    const first = openRecoveryStore({ dataDir: dir });
    try {
      const { ids } = seedRun(first);
      runId = ids.logicalRunId;
      enqueueApprovedPrompt(
        {
          logicalRunId: ids.logicalRunId,
          attemptId: ids.attemptId,
          requestId: queueIds.requestId,
          family: 'chat',
          owner: 'chat-run-service',
          prompt: RICH_PROMPT,
        },
        first
      );
      markRunWaiting(
        {
          logicalRunId: ids.logicalRunId,
          expectedRevision: 1,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        },
        first
      );
    } finally {
      closeRecoveryStore(first);
    }

    const waitingReopen = openRecoveryStore({ dataDir: dir });
    try {
      const entry = getQueueEntry(queueIds.requestId, waitingReopen);
      assert.equal(entry.prompt, RICH_PROMPT, 'prompt bytes survive reopen');
      assert.equal(entry.state, 'queued');
      assert.equal(getRunWaiting(runId, waitingReopen).kind, 'question');
      assert.equal(claimNextQueuedEntry({}, waitingReopen), null);

      // The explicit answer then the Stop both survive another reopen.
      resolveRunWaiting(
        {
          logicalRunId: runId,
          expectedRevision: 2,
          requestId: createRecoveryIds().requestId,
          answer: 'yes',
        },
        waitingReopen
      );
      requestRunCancel({ logicalRunId: runId, requestId: cancelIds.requestId }, waitingReopen);
    } finally {
      closeRecoveryStore(waitingReopen);
    }

    const cancelReopen = openRecoveryStore({ dataDir: dir });
    try {
      assert.equal(isRunCancelled(runId, cancelReopen), true);
      assert.equal(getRunCancel(runId, cancelReopen).requestId, cancelIds.requestId);
      assert.equal(getQueueEntry(queueIds.requestId, cancelReopen).state, 'cancelled');
      assert.equal(listCancelledRuns({}, cancelReopen).length, 1);
      assert.equal(
        resolveQueueEntryAction(getQueueEntry(queueIds.requestId, cancelReopen), getRun(runId, cancelReopen))
          .action,
        'skip'
      );
    } finally {
      closeRecoveryStore(cancelReopen);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue/cancel/waiting rows are foreign-keyed to recovery_runs', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
      const at = '2026-07-01T00:00:00.000Z';
      const missing = newRecoveryId('logical_run');

      assert.throws(
        () =>
          store.db
            .prepare(`
              INSERT INTO recovery_queue(
                queue_id, logical_run_id, family, owner, state, created_at, updated_at, json
              ) VALUES('q-missing', ?, 'chat', 'chat-run-service', 'queued', ?, ?, '{}')
            `)
            .run(missing, at, at),
        /FOREIGN KEY/i
      );
      assert.throws(
        () =>
          store.db
            .prepare(
              "INSERT INTO recovery_cancels(logical_run_id, request_id, reason, created_at, json) VALUES(?, '', 'x', ?, '{}')"
            )
            .run(missing, at),
        /FOREIGN KEY/i
      );
      assert.throws(
        () =>
          store.db
            .prepare(
              "INSERT INTO recovery_waiting(logical_run_id, request_id, kind, state, created_at, updated_at, json) VALUES(?, '', 'question', 'pending', ?, ?, '{}')"
            )
            .run(missing, at, at),
        /FOREIGN KEY/i
      );

      const { ids } = seedRun(store);
      enqueue(store, ids);
      requestRunCancel({ logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId }, store);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery store schema v3 keeps runs and CAS semantics intact', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      assert.equal(listRuns({}, store).length, 0);
      const { ids } = seedRun(store);
      const applied = transitionRun(
        { logicalRunId: ids.logicalRunId, expectedRevision: 1, to: 'running' },
        store
      );
      assert.equal(applied.ok, true);
      assert.equal(applied.run.revision, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
