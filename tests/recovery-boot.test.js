/**
 * Leaf R8 — boot evidence classification and the bounded `unknown` re-probe.
 *
 * These tests use a temporary recovery store per case and clean up afterwards,
 * so the suite never touches the real `data/` store.
 */

import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BOOT_EVIDENCE_REASONS,
  BOOT_EVIDENCE_STATES,
  BOOT_UNKNOWN_MAX_REPROBES,
  BOOT_UNKNOWN_REPROBE_BASE_MS,
  BOOT_UNKNOWN_REPROBE_CAP_MS,
  buildBootEvidenceRecord,
  classifyAndRecordOpenRuns,
  classifyBootEvidence,
  recordBootEvidence,
  runDueBootReprobes,
  resolveBootUnknownReprobe,
} from '../lib/recovery/recovery-boot.ts';
import {
  closeRecoveryStore,
  getRun,
  listOpenRuns,
  openRecoveryStore,
  transitionRun,
  writeRunIntent,
} from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { makeTempDir } from './helpers/temp-dir.js';

/**
 * @returns {string}
 */
function tempDir() {
  return makeTempDir('recovery-boot-');
}

/**
 * @param {object} [extra]
 * @returns {{ logicalRunId: string, attemptId: string, requestId: string, family: string, owner: string }}
 */
function baseIntent(extra = {}) {
  const ids = createRecoveryIds();
  return {
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    ...extra,
  };
}

test('the classification vocabulary covers exactly the R8 states and reasons', () => {
  assert.deepEqual(
    [...BOOT_EVIDENCE_STATES],
    ['completed', 'still_running', 'interrupted', 'waiting', 'cancelled', 'unknown', 'unsupported'],
  );
  assert.equal(BOOT_EVIDENCE_REASONS.includes('terminal_proof'), true);
  assert.equal(BOOT_EVIDENCE_REASONS.includes('unknown_liveness'), true);
  assert.equal(BOOT_EVIDENCE_REASONS.includes('unsupported_adapter'), true);
});

test('classifyBootEvidence: terminal facts win over a live executor', () => {
  const completed = classifyBootEvidence({
    state: 'running',
    liveness: 'alive',
    terminalProof: true,
    adapter: 'testfake',
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.reason, 'terminal_proof');
  assert.equal(completed.terminal, true);
  assert.equal(completed.requiresReprobe, false);

  const cancelled = classifyBootEvidence({
    state: 'running',
    liveness: 'alive',
    cancelRequested: true,
    adapter: 'testfake',
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.reason, 'user_cancel');
  assert.equal(cancelled.terminal, true);
});

test('classifyBootEvidence: alive, waiting and dead evidence map to their states', () => {
  const alive = classifyBootEvidence({ state: 'running', liveness: 'alive', adapter: 'testfake' });
  assert.equal(alive.state, 'still_running');
  assert.equal(alive.reason, 'alive_executor');

  const waiting = classifyBootEvidence({
    state: 'waiting',
    liveness: 'unknown',
    waiting: true,
    adapter: 'testfake',
  });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.reason, 'waiting_for_input');

  const dead = classifyBootEvidence({
    state: 'running',
    liveness: 'dead',
    reason: 'server_restart',
    adapter: 'testfake',
  });
  assert.equal(dead.state, 'interrupted');
  assert.equal(dead.reason, 'dead_executor');
  assert.equal(dead.interruptReason, 'server_restart');
  assert.equal(dead.recoverable, true);
});

test('classifyBootEvidence: an adapter without a contract is explicitly unsupported', () => {
  const unsupported = classifyBootEvidence({ state: 'running', liveness: 'dead', adapter: 'codebuddy' });
  assert.equal(unsupported.state, 'unsupported');
  assert.equal(unsupported.reason, 'unsupported_adapter');
  assert.equal(unsupported.recoverable, false);
});

test('classifyBootEvidence: unproven liveness is unknown, never guessed', () => {
  const unknown = classifyBootEvidence({ state: 'running', liveness: 'unknown', adapter: 'testfake' });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'unknown_liveness');
  assert.equal(unknown.requiresReprobe, true);
  assert.equal(unknown.recoverable, true);
  // The classifier must not smuggle a guessed liveness into the result.
  assert.equal(unknown.liveness, 'unknown');

  const missingProbe = classifyBootEvidence({ state: 'starting', adapter: 'testfake' });
  assert.equal(missingProbe.state, 'unknown');
  assert.equal(missingProbe.requiresReprobe, true);
});

test('resolveBootUnknownReprobe: bounded exponential backoff then escalation', () => {
  const now = 1_000_000;
  const options = { now, baseMs: 1000, capMs: 3000, maxAttempts: 4 };
  const delays = [];
  for (let attempts = 0; attempts < 4; attempts += 1) {
    const plan = resolveBootUnknownReprobe({ ...options, attempts });
    assert.equal(plan.action, 'reprobe');
    assert.equal(plan.attempt, attempts + 1);
    assert.equal(plan.escalated, false);
    assert.equal(plan.bounded, true);
    assert.ok(plan.delayMs <= 3000, `delay ${plan.delayMs} must stay capped`);
    assert.equal(plan.nextProbeAt, now + plan.delayMs);
    delays.push(plan.delayMs);
  }
  assert.deepEqual(delays, [1000, 2000, 3000, 3000]);

  const escalated = resolveBootUnknownReprobe({ ...options, attempts: 4 });
  assert.equal(escalated.action, 'escalate');
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.delayMs, 0);
  assert.equal(escalated.nextProbeAt, null);
  assert.equal(escalated.reason, 'unknown_reprobe_exhausted');
});

test('resolveBootUnknownReprobe: defaults are bounded by the cap', () => {
  assert.equal(BOOT_UNKNOWN_MAX_REPROBES, 4);
  assert.ok(BOOT_UNKNOWN_REPROBE_CAP_MS > BOOT_UNKNOWN_REPROBE_BASE_MS);
  for (let attempts = 0; attempts <= BOOT_UNKNOWN_MAX_REPROBES; attempts += 1) {
    const plan = resolveBootUnknownReprobe({ attempts, now: 0 });
    assert.ok(plan.delayMs <= BOOT_UNKNOWN_REPROBE_CAP_MS);
    assert.equal(typeof plan.escalated, 'boolean');
  }
});

test('buildBootEvidenceRecord carries the durable reason and the re-probe plan', () => {
  const classification = classifyBootEvidence({ state: 'running', liveness: 'unknown', adapter: 'testfake' });
  const record = buildBootEvidenceRecord({
    classification,
    attempt: 2,
    reprobeAt: '2026-10-16T00:00:00.000Z',
    now: 1_700_000_000_000,
  });
  assert.equal(record.state, 'unknown');
  assert.equal(record.reason, 'unknown_liveness');
  assert.equal(record.attempt, 2);
  assert.equal(record.reprobeAt, '2026-10-16T00:00:00.000Z');
  assert.equal(record.at, new Date(1_700_000_000_000).toISOString());
  assert.equal(record.requiresReprobe, true);
});

test('recordBootEvidence persists a durable reason and never changes the lifecycle state', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const intent = baseIntent({ harness: 'testfake', chatId: 'chat-1' });
    const { run } = writeRunIntent(intent, store);
    assert.equal(run.state, 'starting');
    assert.equal(run.revision, 1);

    const classification = classifyBootEvidence({
      state: run.state,
      liveness: 'unknown',
      adapter: run.harness,
    });
    const plan = resolveBootUnknownReprobe({ attempts: 0, now: 1_700_000_000_000 });
    const result = recordBootEvidence({
      run,
      classification,
      attempt: plan.attempt,
      reprobeAt: new Date(plan.nextProbeAt).toISOString(),
      now: 1_700_000_000_000,
      store,
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.run.state, 'starting', 'classification must be metadata-only');
    assert.equal(result.run.revision, 2);

    const persisted = getRun(intent.logicalRunId, store);
    assert.equal(persisted.bootEvidence.state, 'unknown');
    assert.equal(persisted.bootEvidence.reason, 'unknown_liveness');
    assert.equal(persisted.bootEvidence.attempt, 1);
    assert.equal(persisted.bootEvidence.reprobeAt, new Date(plan.nextProbeAt).toISOString());
    assert.equal(persisted.bootEvidence.escalated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBootEvidence reports a CAS conflict instead of overwriting a newer revision', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const { run } = writeRunIntent(baseIntent({ harness: 'testfake' }), store);
    const stale = { ...run, revision: run.revision + 5 };
    const result = recordBootEvidence({
      run: stale,
      classification: classifyBootEvidence({ state: 'running', liveness: 'unknown', adapter: 'testfake' }),
      store,
    });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(result.reason, 'revision_conflict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyAndRecordOpenRuns classifies, records, and escalates unknown evidence after the bound', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    writeRunIntent(baseIntent({ harness: 'testfake', chatId: 'chat-unknown' }), store);

    const probeUnknown = () => ({ known: false, busy: false });
    let last = null;
    for (let round = 0; round < BOOT_UNKNOWN_MAX_REPROBES + 1; round += 1) {
      last = classifyAndRecordOpenRuns({
        store,
        probeLiveness: probeUnknown,
        now: 1_700_000_000_000 + round * 1000,
        baseMs: 1000,
        capMs: 3000,
      });
      assert.equal(last.scanned, 1);
      assert.equal(last.recorded, 1);
      assert.equal(last.classifications[0].classification.state, 'unknown');
    }
    assert.equal(last.classifications[0].attempt, BOOT_UNKNOWN_MAX_REPROBES + 1);
    assert.equal(last.classifications[0].escalated, true);

    const persisted = getRun(
      last.classifications[0].logicalRunId,
      store,
    );
    assert.equal(persisted.bootEvidence.state, 'unknown');
    assert.equal(persisted.bootEvidence.escalated, true);
    assert.equal(persisted.bootEvidence.requiresEscalation, true);
    assert.equal(persisted.bootEvidence.escalationReason, 'unknown_reprobe_exhausted');
    assert.equal(persisted.bootEvidence.attempt, BOOT_UNKNOWN_MAX_REPROBES + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyAndRecordOpenRuns reports an unavailable store instead of throwing', () => {
  closeRecoveryStore();
  const result = classifyAndRecordOpenRuns();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'store_unavailable');
  assert.equal(result.scanned, 0);
  assert.equal(result.errors[0].code, 'store_not_open');
});

test('runDueBootReprobes executes the stored plan after reprobeAt and escalates when exhausted', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    writeRunIntent(baseIntent({ harness: 'testfake', chatId: 'chat-reprobe' }), store);
    const probeUnknown = () => ({ known: false, busy: false });
    const opts = { store, probeLiveness: probeUnknown, baseMs: 1000, capMs: 1000, maxAttempts: 2 };
    const t0 = 1_700_000_000_000;
    const first = classifyAndRecordOpenRuns({ ...opts, now: t0 });
    const id = first.classifications[0].logicalRunId;
    assert.equal(getRun(id, store).bootEvidence.attempt, 1);

    const early = runDueBootReprobes({ ...opts, now: t0 + 10 });
    assert.equal(early.scanned, 0, 'not due yet: no re-probe');

    const second = runDueBootReprobes({ ...opts, now: t0 + 1500 });
    assert.equal(second.scanned, 1);
    assert.equal(getRun(id, store).bootEvidence.attempt, 2);
    assert.equal(getRun(id, store).bootEvidence.escalated, false);

    const third = runDueBootReprobes({ ...opts, now: t0 + 3000 });
    assert.equal(third.scanned, 1);
    const persisted = getRun(id, store).bootEvidence;
    assert.equal(persisted.escalated, true);
    assert.equal(persisted.escalationReason, 'unknown_reprobe_exhausted');

    const after = runDueBootReprobes({ ...opts, now: t0 + 999_999 });
    assert.equal(after.scanned, 0, 'an escalated row is never re-probed again');
  } finally {
    closeRecoveryStore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot pass and re-probe page past the 1000-row listOpenRuns limit', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const total = 1001;
    let lastId = '';
    for (let i = 0; i < total; i += 1) {
      const intent = baseIntent({ harness: 'testfake', chatId: `chat-${i}` });
      lastId = intent.logicalRunId;
      writeRunIntent(intent, store);
    }
    assert.equal(listOpenRuns({}, store).length, 1000, 'a single page is capped');
    const opts = { store, probeLiveness: () => ({ known: false, busy: false }), baseMs: 1000, capMs: 1000 };
    const t0 = 1_700_000_000_000;
    const first = classifyAndRecordOpenRuns({ ...opts, now: t0 });
    assert.equal(first.scanned, total);
    assert.equal(first.recorded, total);
    assert.equal(getRun(lastId, store).bootEvidence.attempt, 1, 'the last run is classified too');
    const second = runDueBootReprobes({ ...opts, now: t0 + 5000, limit: 1000 });
    assert.equal(second.scanned, 1000);
    // The re-probe must reach rows beyond the first page eventually.
    const third = runDueBootReprobes({ ...opts, now: t0 + 5000, limit: 1000 });
    assert.equal(third.scanned, 1, 'the row beyond the first page is due and reachable');
  } finally {
    closeRecoveryStore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1 matrix: dead-executor proof CAS-moves only starting/running to interrupted', () => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    const mk = (chatId, state) => {
      const intent = baseIntent({ harness: 'testfake', chatId });
      const row = writeRunIntent(intent, store);
      const run = row.run || row;
      if (state !== 'starting') {
        transitionRun({ logicalRunId: intent.logicalRunId, expectedRevision: run.revision, to: state }, store);
      }
      return intent.logicalRunId;
    };
    const ids = {
      starting: mk('c-starting', 'starting'),
      running: mk('c-running', 'running'),
      waiting: mk('c-waiting', 'waiting'),
      cancel: mk('c-cancel', 'running'),
    };
    const dead = () => ({ known: true, busy: false });
    const out = classifyAndRecordOpenRuns({
      store,
      probeLiveness: dead,
      waiting: (run) => run.logicalRunId === ids.waiting,
      cancelRequested: (run) => run.logicalRunId === ids.cancel,
    });
    assert.equal(out.ok, true);
    assert.equal(getRun(ids.starting, store).state, 'interrupted');
    assert.equal(getRun(ids.starting, store).reason, 'process_gone');
    assert.equal(getRun(ids.running, store).state, 'interrupted');
    assert.equal(getRun(ids.waiting, store).state, 'waiting', 'waiting is not an interrupt');
    assert.equal(getRun(ids.cancel, store).state, 'running', 'a cancel request is classified, not interrupted');
    // unknown liveness and a live executor never move the run
    const live = mk('c-live', 'running');
    const unk = mk('c-unk', 'running');
    classifyAndRecordOpenRuns({
      store,
      listRuns: () => [getRun(live, store), getRun(unk, store)],
      probeLiveness: (run) => (run.logicalRunId === live ? { known: true, busy: true } : { known: false }),
    });
    assert.equal(getRun(live, store).state, 'running');
    assert.equal(getRun(unk, store).state, 'running');
    assert.equal(getRun(unk, store).bootEvidence.state, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
