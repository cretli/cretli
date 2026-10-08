/**
 * Crash-durability tests for the durable queue, Stop/cancel and waiting
 * (leaf R4).
 *
 * A real child process performs the durable write through the real queue API,
 * signals readiness and is then killed with SIGKILL. Reopening the store in the
 * parent proves the write survived a process death:
 *
 * a. an enqueued approved prompt is present and its payload is byte-identical;
 * b. a Stop that returned before the kill is durable — the run can never be
 *    auto-resumed (`resolveQueueEntryAction` is skip / no resurrect);
 * c. a `waiting` question survives and is still `manual_only`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  closeRecoveryStore,
  getRun,
  openRecoveryStore,
} from '../lib/recovery/recovery-store.js';
import {
  claimNextQueuedEntry,
  enqueueApprovedPrompt,
  getQueueEntry,
  getRunCancel,
  getRunWaiting,
  isRunCancelled,
  listQueueEntries,
  listWaitingRuns,
  markRunWaiting,
  resolveQueueEntryAction,
} from '../lib/recovery/recovery-queue.js';
import {
  spawnRecoveryCrashChild,
  supportsSigkill,
} from './helpers/recovery-crash-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-store.js')).href;
const IDS_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-ids.js')).href;
const QUEUE_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-queue.js')).href;

const SKIP = supportsSigkill() ? false : 'SIGKILL is not supported on this platform';

/** The payload is passed through the environment so the bytes are exact. */
const PROMPT = 'Approved "deploy" \u0105\u0107\u0119\u0142 \u{1f680}';
const COMMON_CHILD_HEAD = `
import fs from 'node:fs';
import path from 'node:path';
import { openRecoveryStore, writeRunIntent } from ${JSON.stringify(STORE_URL)};
import { createRecoveryIds } from ${JSON.stringify(IDS_URL)};
import { enqueueApprovedPrompt } from ${JSON.stringify(QUEUE_URL)};

const dataDir = process.env.RECOVERY_CRASH_DATA_DIR;
const store = openRecoveryStore({ dataDir });
const runIds = createRecoveryIds();
writeRunIntent({
  logicalRunId: runIds.logicalRunId,
  attemptId: runIds.attemptId,
  requestId: runIds.requestId,
  family: 'chat',
  owner: 'chat-run-service',
}, store);
const queueIds = createRecoveryIds();
const enqueued = enqueueApprovedPrompt({
  logicalRunId: runIds.logicalRunId,
  attemptId: runIds.attemptId,
  requestId: queueIds.requestId,
  family: 'chat',
  owner: 'chat-run-service',
  prompt: process.env.RECOVERY_CRASH_PROMPT,
  promptRef: 'crash-ref',
}, store);
if (!enqueued.created) throw new Error('queue entry was not created');
`;

const ENQUEUE_SCRIPT = `
${COMMON_CHILD_HEAD}
fs.writeFileSync(
  path.join(dataDir, 'queue-ids.json'),
  JSON.stringify({ runIds, queueIds, prompt: process.env.RECOVERY_CRASH_PROMPT })
);
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

const CANCEL_SCRIPT = `
${COMMON_CHILD_HEAD}
import { requestRunCancel } from ${JSON.stringify(QUEUE_URL)};
const cancelIds = createRecoveryIds();
const cancel = requestRunCancel({
  logicalRunId: runIds.logicalRunId,
  requestId: cancelIds.requestId,
  reason: 'user_stop',
}, store);
fs.writeFileSync(
  path.join(dataDir, 'cancel-ids.json'),
  JSON.stringify({ runIds, queueIds, cancelIds, cancelled: cancel.cancelled, alreadyCancelled: cancel.alreadyCancelled })
);
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

const WAITING_SCRIPT = `
${COMMON_CHILD_HEAD}
import { markRunWaiting } from ${JSON.stringify(QUEUE_URL)};
const waitingIds = createRecoveryIds();
const result = markRunWaiting({
  logicalRunId: runIds.logicalRunId,
  expectedRevision: 1,
  kind: 'question',
  requestId: waitingIds.requestId,
  promptRef: 'question-1',
}, store);
if (!result.ok || result.run.state !== 'waiting') throw new Error('run did not enter waiting');
fs.writeFileSync(
  path.join(dataDir, 'waiting-ids.json'),
  JSON.stringify({ runIds, queueIds, waitingIds, state: result.run.state })
);
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);
`;

test('an enqueued approved prompt survives SIGKILL with a byte-identical payload', { skip: SKIP }, async () => {
  const child = await spawnRecoveryCrashChild({
    script: ENQUEUE_SCRIPT,
    env: { RECOVERY_CRASH_PROMPT: PROMPT },
  });
  try {
    assert.ok(child.pid, 'child has a pid');
    const ids = JSON.parse(readFileSync(path.join(child.dataDir, 'queue-ids.json'), 'utf8'));

    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', 'child was killed with SIGKILL');

    const store = openRecoveryStore({ dataDir: child.dataDir });
    try {
      const entry = getQueueEntry(ids.queueIds.requestId, store);
      assert.ok(entry, 'the approved prompt survived the SIGKILL');
      assert.equal(entry.state, 'queued');
      assert.equal(entry.prompt, ids.prompt, 'payload is byte-identical');
      assert.equal(entry.prompt, PROMPT);
      assert.equal(entry.logicalRunId, ids.runIds.logicalRunId);
      assert.equal(entry.promptRef, 'crash-ref');
      assert.equal(listQueueEntries({}, store).length, 1);

      // The enqueue ledger survived too: replaying after the crash is
      // idempotent instead of duplicating the prompt.
      const replay = enqueueApprovedPrompt(
        {
          logicalRunId: ids.runIds.logicalRunId,
          attemptId: ids.runIds.attemptId,
          requestId: ids.queueIds.requestId,
          family: 'chat',
          owner: 'chat-run-service',
          prompt: PROMPT,
        },
        store
      );
      assert.equal(replay.created, false);
      assert.equal(replay.entry.prompt, PROMPT);
      assert.equal(listQueueEntries({}, store).length, 1);

      // The recovered entry is still safely launchable.
      const decision = resolveQueueEntryAction(entry, getRun(ids.runIds.logicalRunId, store));
      assert.equal(decision.action, 'launch');
      assert.equal(decision.automatic, true);
    } finally {
      closeRecoveryStore(store);
    }
  } finally {
    await child.dispose();
  }
});

test('a Stop that returned before SIGKILL stays cancelled and never resurrects', { skip: SKIP }, async () => {
  const child = await spawnRecoveryCrashChild({ script: CANCEL_SCRIPT });
  try {
    assert.ok(child.pid, 'child has a pid');
    const ids = JSON.parse(readFileSync(path.join(child.dataDir, 'cancel-ids.json'), 'utf8'));
    assert.equal(ids.cancelled, true, 'the child observed a fresh cancel before READY');

    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', 'child was killed with SIGKILL');

    const store = openRecoveryStore({ dataDir: child.dataDir });
    try {
      assert.equal(isRunCancelled(ids.runIds.logicalRunId, store), true);
      const cancel = getRunCancel(ids.runIds.logicalRunId, store);
      assert.ok(cancel, 'cancel ledger survived');
      assert.equal(cancel.requestId, ids.cancelIds.requestId);
      assert.equal(cancel.reason, 'user_stop');
      assert.equal(getRun(ids.runIds.logicalRunId, store).state, 'cancelled');

      const entry = getQueueEntry(ids.queueIds.requestId, store);
      assert.equal(entry.state, 'cancelled', 'the queued entry was retired by the Stop');

      const decision = resolveQueueEntryAction(entry, getRun(ids.runIds.logicalRunId, store));
      assert.equal(decision.action, 'skip');
      assert.equal(decision.automatic, false);
      assert.equal(claimNextQueuedEntry({}, store), null, 'nothing to claim after Stop');
    } finally {
      closeRecoveryStore(store);
    }
  } finally {
    await child.dispose();
  }
});

test('a waiting question survives SIGKILL and stays manual_only', { skip: SKIP }, async () => {
  const child = await spawnRecoveryCrashChild({ script: WAITING_SCRIPT });
  try {
    assert.ok(child.pid, 'child has a pid');
    const ids = JSON.parse(readFileSync(path.join(child.dataDir, 'waiting-ids.json'), 'utf8'));
    assert.equal(ids.state, 'waiting');

    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', 'child was killed with SIGKILL');

    const store = openRecoveryStore({ dataDir: child.dataDir });
    try {
      const waiting = getRunWaiting(ids.runIds.logicalRunId, store);
      assert.ok(waiting, 'pending waiting survived the SIGKILL');
      assert.equal(waiting.kind, 'question');
      assert.equal(waiting.state, 'pending');
      assert.equal(waiting.promptRef, 'question-1');
      assert.equal(getRun(ids.runIds.logicalRunId, store).state, 'waiting');

      const listed = listWaitingRuns({}, store);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].runState, 'waiting');

      const entry = getQueueEntry(ids.queueIds.requestId, store);
      assert.equal(entry.state, 'queued', 'never-claimed entry stays queued while run waits');
      assert.equal(claimNextQueuedEntry({}, store), null, 'a waiting run is never auto-claimed');

      const decision = resolveQueueEntryAction(entry, getRun(ids.runIds.logicalRunId, store));
      assert.equal(decision.action, 'manual_only');
      assert.equal(decision.automatic, false);

      // The waiting ledger survived: the same requestId is an idempotent replay
      // rather than a second pending question.
      const replay = markRunWaiting(
        {
          logicalRunId: ids.runIds.logicalRunId,
          expectedRevision: 2,
          kind: 'question',
          requestId: ids.waitingIds.requestId,
        },
        store
      );
      assert.equal(replay.ok, true);
      assert.equal(replay.applied, false);
      assert.equal(replay.reason, 'already_waiting');
      assert.equal(listWaitingRuns({}, store).length, 1);
    } finally {
      closeRecoveryStore(store);
    }
  } finally {
    await child.dispose();
  }
});
