/**
 * Leaf R9 — restart intent, the SIGTERM decision, bounded shutdown flush and
 * the SIGKILL (no intent) path.
 */

import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { classifyAndRecordOpenRuns } from '../lib/recovery/recovery-boot.ts';
import {
  checkpointOpenRunsForShutdown,
  consumeRestartIntent,
  evaluateRestartIntent,
  getProcessInstance,
  resolveShutdownIntentReason,
  runBoundedShutdownFlush,
  writeRestartIntent,
} from '../lib/recovery/recovery-shutdown.ts';
import {
  consumeBootRestartIntent,
  readBootRestartIntent,
} from '../lib/delegation-runtime-boot.js';
import { closeRecoveryStore, getRun, openRecoveryStore, writeRunIntent } from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { beginServerShutdown, canAcceptNewRun, isServerShuttingDown } from '../lib/update-gate.js';
import { startChatRun } from '../lib/chat-run-service.js';
import { startWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import { makeTempDir } from './helpers/temp-dir.js';

const OTHER_INSTANCE = { instanceId: 'previous-process', generation: 1, pid: 1 };

function withStore(fn) {
  const dir = makeTempDir('recovery-shutdown-');
  const store = openRecoveryStore({ dataDir: dir });
  try {
    return fn(store);
  } finally {
    closeRecoveryStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedRun(store) {
  const ids = createRecoveryIds();
  return writeRunIntent({
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    harness: 'testfake',
  }, store).run;
}

test('intent is written durably and consumed exactly once', () => {
  withStore((store) => {
    const now = 1_700_000_000_000;
    const written = writeRestartIntent({
      signal: 'SIGTERM',
      reason: 'planned_restart',
      now,
      instance: OTHER_INSTANCE,
      store,
    });
    assert.equal(written.reason, 'planned_restart');
    assert.ok(Date.parse(written.deadlineAt) > Date.parse(written.writtenAt));
    const first = consumeRestartIntent({ now: now + 5000, store });
    assert.equal(first.status, 'consumed');
    assert.equal(first.intent.signal, 'SIGTERM');
    assert.equal(first.intent.instanceId, 'previous-process');
    assert.equal(consumeRestartIntent({ now: now + 5000, store }).status, 'absent');
  });
});

test('the intent reason requires an explicit scheduled restart', () => {
  // Only a graceful signal with the explicit restart flag is a planned restart.
  assert.equal(resolveShutdownIntentReason({ signal: 'SIGTERM', restartScheduled: true }), 'planned_restart');
  assert.equal(resolveShutdownIntentReason({ signal: 'SIGINT', restartScheduled: true }), 'planned_restart');
  // The signal alone is not restart proof.
  assert.equal(resolveShutdownIntentReason({ signal: 'SIGTERM' }), 'user_stop');
  assert.equal(resolveShutdownIntentReason({ signal: 'SIGINT', restartScheduled: false }), 'user_stop');
  // Fatal / non-graceful events write no intent at all.
  assert.equal(resolveShutdownIntentReason({ signal: 'uncaught-exception', restartScheduled: true }), null);
  assert.equal(resolveShutdownIntentReason({ signal: 'unhandled-rejection', restartScheduled: true }), null);
  assert.equal(resolveShutdownIntentReason({ signal: 'server-error', restartScheduled: true }), null);
  assert.equal(resolveShutdownIntentReason({ signal: '' }), null);
  assert.equal(resolveShutdownIntentReason(), null);
});

test('a plain SIGTERM without a scheduled restart records user_stop, never planned_restart', () => {
  withStore((store) => {
    const reason = resolveShutdownIntentReason({ signal: 'SIGTERM', restartScheduled: false });
    const written = writeRestartIntent({ signal: 'SIGTERM', reason, now: 1_700_000_000_000, instance: OTHER_INSTANCE, store });
    assert.equal(written.reason, 'user_stop');
    // An unspecified reason is conservative too: planned_restart must be explicit.
    assert.equal(writeRestartIntent({ signal: 'SIGINT', store }).reason, 'user_stop');
  });
});

test('stale, same-instance and malformed intents are ignored (and still deleted)', () => {
  withStore((store) => {
    const now = 1_700_000_000_000;
    writeRestartIntent({ now, instance: OTHER_INSTANCE, deadlineMs: 1000, store });
    const stale = consumeRestartIntent({ now: now + 10 * 60_000, store });
    assert.equal(stale.status, 'ignored');
    assert.equal(stale.reason, 'stale');
    assert.equal(consumeRestartIntent({ store }).status, 'absent');

    writeRestartIntent({ now: Date.now(), store });
    const same = consumeRestartIntent({ store });
    assert.equal(same.status, 'ignored');
    assert.equal(same.reason, 'same_instance');
  });
  assert.equal(evaluateRestartIntent(null).reason, 'malformed');
  assert.equal(evaluateRestartIntent({ schemaVersion: 99 }).reason, 'schema_mismatch');
});

test('SIGKILL path: no intent means boot evidence has no planned-restart marker and stays unknown', () => {
  withStore((store) => {
    seedRun(store);
    const intentResult = consumeRestartIntent({ store });
    assert.equal(intentResult.status, 'absent');
    const out = classifyAndRecordOpenRuns({ restartIntent: intentResult.intent, now: 1_700_000_000_000, store });
    assert.equal(out.classifications[0].classification.state, 'unknown');
    const row = getRun(out.classifications[0].logicalRunId, store);
    assert.equal(row.bootEvidence.state, 'unknown');
    assert.equal('restartIntent' in row.bootEvidence, false);
  });
});

test('a consumed intent is attached as evidence without changing classification or state', () => {
  withStore((store) => {
    const run = seedRun(store);
    writeRestartIntent({ reason: 'planned_restart', now: 1_700_000_000_000, instance: OTHER_INSTANCE, store });
    const intentResult = consumeRestartIntent({ now: 1_700_000_001_000, store });
    const out = classifyAndRecordOpenRuns({ restartIntent: intentResult.intent, now: 1_700_000_001_000, store });
    assert.equal(out.classifications[0].classification.state, 'unknown');
    const row = getRun(run.logicalRunId, store);
    assert.equal(row.bootEvidence.restartIntent.reason, 'planned_restart');
    assert.equal(row.state, run.state);
  });
});

test('boot reads the intent without consuming it so a failed classification keeps the evidence', () => {
  withStore((store) => {
    const now = Date.now();
    writeRestartIntent({
      reason: 'user_stop',
      signal: 'SIGTERM',
      now,
      instance: OTHER_INSTANCE,
      store,
    });
    const first = readBootRestartIntent({ store });
    assert.equal(first.status, 'pending');
    assert.equal(first.intent.reason, 'user_stop');
    // A second read (a classification pass that threw before consuming) still
    // sees the evidence.
    assert.equal(readBootRestartIntent({ store }).status, 'pending');
    // Only a completed classification deletes it.
    assert.equal(consumeBootRestartIntent({ store }).status, 'consumed');
    assert.equal(readBootRestartIntent({ store }).status, 'absent');
  });
});

test('a failed intent read is logged and treated as no intent (never degrades boot)', () => {
  // A closed store handle makes the read throw; evidence-only reads absorb it.
  const closed = { db: null, closed: true };
  assert.deepEqual(readBootRestartIntent({ store: closed }), {
    status: 'absent',
    reason: 'read_failed',
    intent: null,
  });
  assert.equal(consumeBootRestartIntent({ store: closed }), null);
});

test('checkpoint marks open runs as interrupted-by-planned-restart without completing them', () => {
  withStore((store) => {
    const run = seedRun(store);
    const intent = writeRestartIntent({ reason: 'planned_restart', instance: OTHER_INSTANCE, store });
    const result = checkpointOpenRunsForShutdown({ intent, store });
    assert.equal(result.checkpointed, 1);
    const row = getRun(run.logicalRunId, store);
    assert.equal(row.state, run.state);
    assert.equal(row.shutdownCheckpoint.interruptedBy, 'planned_restart');
    assert.equal(row.shutdownCheckpoint.inProgress, true);
  });
});

test('new starts are refused once shutdown begins', async () => {
  assert.equal(canAcceptNewRun(), true);
  beginServerShutdown();
  assert.equal(isServerShuttingDown(), true);
  assert.equal(canAcceptNewRun(), false);
  await assert.rejects(() => startChatRun({ chatId: 'x', prompt: 'hi' }), { code: 'server_shutting_down' });
  const cycle = await startWorkspaceWatcherCycle({});
  assert.deepEqual(cycle, { started: false, reason: 'server_shutting_down' });
});

test('flush is bounded by the hard timeout and reports failures without throwing', async () => {
  const errors = [];
  const result = await runBoundedShutdownFlush({
    timeoutMs: 100,
    tasks: [
      { name: 'hangs', run: () => new Promise(() => {}) },
      { name: 'fails', run: () => { throw new Error('boom'); } },
      { name: 'ok', run: () => 1 },
    ],
    onError: (name) => errors.push(name),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(result.elapsedMs < 1000);
  assert.deepEqual(result.failed, ['fails']);
  assert.deepEqual(result.completed, ['ok']);
  assert.deepEqual(errors, ['fails']);
  assert.ok(getProcessInstance().instanceId);
});
