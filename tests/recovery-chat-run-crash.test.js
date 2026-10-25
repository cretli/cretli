/**
 * End-to-end chat-run SIGKILL boundary matrix (leaf R19a of R19).
 *
 * Every test spawns a real child process with its own data dir that drives the
 * production `startChatRun` path against a mock executor, freezes at one
 * boundary and is killed with a real SIGKILL. A second child ("boot") then
 * plays the restarted server: it runs the R8 boot classification exactly as
 * `bootDelegationRuntime` does and optionally re-issues the same requestId.
 * The parent finally inspects the durable store, the side-effect log of the
 * mock executor and the manual-resume gate (R12).
 *
 * The mock executor's only observable effect is a line appended to
 * `side-effects.log` (`LAUNCH`, `TOOL`, `FINISH`, `CANCEL`, `CONTINUATION`), so
 * "no re-send" and "no duplicated tool side effect" are asserted on real files,
 * not on in-memory counters. No model is ever called.
 *
 * Findings:
 * - G1 (closed) `classifyAndRecordOpenRuns` CAS-moves a `starting`/`running`
 *   run with dead-executor proof to `interrupted` (reason `process_gone`);
 *   `unknown` liveness and live executors keep their lifecycle state.
 * - G2 (documented, intentional) production boot passes no `cancelRequested`/
 *   `terminalProof`/`waiting` callbacks (lib/delegation-runtime-boot.js
 *   `classifyAndRecordOpenRuns`), so evidence is derived from lifecycle state
 *   only. Pinned by the "G2" source test below; see docs/recovery-contract.md.
 * - G3 (closed by todo e43108ed) `checkRunFence` now guards the resumed attempt's
 *   adapter ack, which links the new adapter run and moves the run to `running`.
 * - G4 (documented, intentional) an unknown adapter start failure stays
 *   `starting` + acceptance `unconfirmed` (lib/chat-run/chat-run-recovery.ts
 *   `recordChatRunStartFailed`); boot keeps it `starting` (liveness unknown), a retry is
 *   refused with `acceptance_unconfirmed` and resume is `not_resumable`
 *   (no operator resume path; open decision). See docs/recovery-contract.md.
 * - G5 (closed) a crash during a resume attempt leaves the run in `recovering`;
 *   boot lists it (`listOpenRuns({ includeRecovering })`) and releases the claim
 *   to `interrupted` (dead executor) or `unknown`, with a durable reason. A live
 *   claim holder or executor is never touched, and a replayed key is
 *   `superseded`, not `in_progress` forever.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeRecoveryStore, getRun, openRecoveryStore } from '../lib/recovery/recovery-store.ts';
import { classifyAndRecordOpenRuns, runDueBootReprobes } from '../lib/recovery/recovery-boot.ts';
import { canAutoRelaunch } from '../lib/recovery/recovery-lifecycle.ts';
import { RESUME_CONTINUATION_PROMPT, createRecoveryResumeService } from '../lib/recovery/recovery-resume.ts';
import { getChatRunRecordByCallerRequest } from '../lib/chat-run/chat-run-recovery.ts';
import {
  createCrashDataDir,
  spawnRecoveryBarrier,
  spawnRecoveryCrashChild,
  supportsSigkill,
} from './helpers/recovery-crash-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_URL = pathToFileURL(path.join(HERE, 'helpers', 'recovery-chat-run-child.js')).href;
const SKIP = supportsSigkill() ? false : 'SIGKILL is not supported on this platform';
const REQ = 'req-fixed';
const TEST_TIMEOUT_MS = 30_000;
const SCRIPT = `await import(${JSON.stringify(CHILD_URL)});`;

/** @returns {Promise<object>} a harness child running one stage of the helper */
function spawnStage(dataDir, stage, extra = {}) {
  return spawnRecoveryCrashChild({
    script: SCRIPT,
    dataDir,
    timeoutMs: 20_000,
    env: {
      CRETLI_DATA_DIR: dataDir,
      CURSOR_REMOTE_DATA_DIR: dataDir,
      CRETLI_TEST_DATA_DIR: dataDir,
      CURSOR_REMOTE_TEST_DATA_DIR: dataDir,
      CR_STAGE: stage,
      ...extra,
    },
  });
}

/** @returns {object|null} the parsed `RESULT {...}` line of a child */
function readResult(child) {
  const line = child.stdout().split('\n').find((row) => row.startsWith('RESULT '));
  return line ? JSON.parse(line.slice('RESULT '.length)) : null;
}

/** Start the run stage, wait for READY at the boundary, SIGKILL it. */
async function killAt(dataDir, killPoint, extra = {}) {
  const child = await spawnStage(dataDir, 'run', { CR_KILL_AT: killPoint, ...extra });
  try {
    assert.ok(child.pid, 'run child has a pid');
    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', `child was killed with SIGKILL at ${killPoint}`);
    return readResult(child);
  } finally {
    await child.dispose();
  }
}

/** Restart the "server": boot classification (+ optional replay). */
async function boot(dataDir, extra = {}) {
  const child = await spawnStage(dataDir, 'boot', extra);
  try {
    await child.waitForExit(15_000);
    const result = readResult(child);
    assert.ok(result, `boot child reported a result\n${child.stderr()}`);
    return result;
  } finally {
    await child.dispose();
  }
}

function sideEffects(dataDir) {
  const file = path.join(dataDir, 'side-effects.log');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const count = (name) => lines.filter((line) => line === name).length;
  return { lines, count };
}

function readRow(store) {
  return getChatRunRecordByCallerRequest(REQ, store);
}

/** Manual resume through the real R12 service with a counting continuation. */
async function tryResume(store, row, extra = {}) {
  const continuations = [];
  const service = createRecoveryResumeService({
    store,
    probeLiveness: () => extra.liveness || 'dead',
    getCapabilities: () => ({ canResumeSession: true, canReattach: extra.canReattach === true }),
    startContinuation: async (call) => {
      continuations.push(call);
      return { accepted: true, adapterRunId: 'run-resumed' };
    },
  });
  const result = await service.resumeRun({
    chatId: row.chatId,
    logicalRunId: row.logicalRunId,
    expectedState: row.state,
    expectedRevision: row.revision,
    idempotencyKey: extra.key || 'manual-gate',
    confirmUnknown: extra.confirmUnknown === true,
  });
  return { result, continuations };
}

/** Runs `body(dataDir, store)` with an isolated dir and a parent-side store. */
async function withScenario(body) {
  const dataDir = createCrashDataDir();
  let store = null;
  try {
    await body(dataDir, () => {
      store = openRecoveryStore({ dataDir });
      return store;
    });
  } finally {
    if (store) closeRecoveryStore(store);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('kill before the launch intent: nothing durable, a retry launches exactly once', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await killAt(dataDir, 'before_intent');
    const afterBoot = await boot(dataDir, { CR_RETRY: '1' });
    assert.equal(afterBoot.scanned, 0, 'no intent was written, so there is no open run to classify');
    assert.equal(afterBoot.retry.ok, true, 'without an intent the same requestId may launch');
    const store = open();
    const row = readRow(store);
    assert.equal(row.state, 'running');
    assert.equal(row.acceptance.state, 'accepted');
    assert.equal(sideEffects(dataDir).count('LAUNCH'), 1, 'exactly one launch overall');
  }));

for (const point of ['before_accept', 'before_ack_persist']) {
  const launched = point === 'before_ack_persist' ? 1 : 0;
  const title = point === 'before_accept'
    ? 'kill after the intent but before the adapter accepts'
    : 'kill after the adapter accepted but before the ack is persisted';
  test(`${title}: unknown acceptance is never auto re-sent`, { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
    withScenario(async (dataDir, open) => {
      await killAt(dataDir, point);
      const store = open();
      const before = readRow(store);
      assert.equal(before.state, 'starting', 'the intent is durable');
      assert.equal(before.acceptance == null, true, 'no acceptance proof was persisted');
      assert.equal(canAutoRelaunch({ logicalRunId: before.logicalRunId, liveness: 'dead', harness: 'codex' }, store).reason, 'no_acceptance_proof');
      closeRecoveryStore(store);

      const afterBoot = await boot(dataDir, { CR_RETRY: '1' });
      assert.equal(afterBoot.scanned, 1);
      assert.equal(afterBoot.classifications[0].state, 'unknown', 'no liveness proof -> unknown, never guessed');
      assert.equal(afterBoot.classifications[0].reason, 'unknown_liveness');
      assert.ok(afterBoot.classifications[0].reprobeAt, 'a bounded re-probe is scheduled');
      assert.deepEqual(afterBoot.retry, { ok: false, code: 'acceptance_unconfirmed' });

      const reopened = open();
      const row = readRow(reopened);
      assert.equal(row.state, 'starting', 'G1: boot classification does not move the lifecycle state');
      assert.equal(row.bootEvidence.state, 'unknown');
      assert.equal(row.acceptance.state, 'unconfirmed', 'the replayed request only records the doubt');
      assert.equal(sideEffects(dataDir).count('LAUNCH'), launched, 'the prompt was not re-sent by recovery');

      const gate = await tryResume(reopened, row, { confirmUnknown: true });
      assert.equal(gate.result.status, 'not_resumable');
      assert.equal(gate.result.reason, 'state_starting');
      assert.equal(gate.continuations.length, 0);
    }));
}

test('kill during a tool call: tool effect happens once, dead executor -> interrupted and resumable', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await killAt(dataDir, 'tool');
    assert.equal(sideEffects(dataDir).count('TOOL'), 1);

    const missing = await boot(dataDir);
    assert.equal(missing.classifications[0].state, 'unknown');
    assert.equal(missing.classifications[0].reason, 'unknown_liveness');
    const idle = await boot(dataDir, { CR_PROBE: 'idle', CR_RETRY: '1' });
    assert.equal(idle.classifications[0].state, 'interrupted', 'confirmed-dead executor -> interrupted');
    assert.equal(idle.classifications[0].reason, 'dead_executor');
    assert.deepEqual(idle.retry, { ok: true, runId: 'run-1' }, 'an accepted requestId replays; it does not relaunch');

    const store = open();
    const row = readRow(store);
    assert.equal(row.state, 'interrupted', 'G1 closed: dead-executor proof CAS-moves the run to interrupted');
    assert.equal(row.reason, 'process_gone', 'the interrupt reason is durable');
    assert.equal(row.acceptance.state, 'accepted');
    assert.equal(row.bootEvidence.state, 'interrupted');
    assert.equal(idle.classifications[0].interrupted, true);
    const gate = await tryResume(store, row);
    assert.equal(gate.result.status, 'resumed', 'manual resume accepts the boot-interrupted run');
    assert.equal(gate.continuations.length, 1);
    const effects = sideEffects(dataDir);
    assert.equal(effects.count('LAUNCH'), 1, 'recovery did not relaunch');
    assert.equal(effects.count('TOOL'), 1, 'recovery did not repeat the tool side effect');
  }));

test('kill after finish but before the terminal record: no proof is invented, a late finish completes once', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await killAt(dataDir, 'before_terminal');
    const store = open();
    const before = readRow(store);
    assert.equal(before.state, 'running');
    assert.equal(before.terminalProof == null, true, 'the terminal record was never written');
    closeRecoveryStore(store);

    const afterBoot = await boot(dataDir, { CR_FINISH_LATE: '1', CR_RETRY: '1' });
    assert.equal(afterBoot.classifications[0].state, 'unknown', 'FINISH in the log is not a durable terminal proof');
    assert.deepEqual(afterBoot.finishLate, [true, false], 'the terminal write is applied once and is idempotent');
    assert.deepEqual(afterBoot.retry, { ok: true, runId: 'run-1' });

    const reopened = open();
    const row = readRow(reopened);
    assert.equal(row.state, 'completed');
    assert.equal(row.terminalProof.source, 'adapter_event');
    const gate = await tryResume(reopened, row);
    assert.equal(gate.result.status, 'not_resumable');
    assert.equal(gate.result.reason, 'state_completed');
    const effects = sideEffects(dataDir);
    assert.deepEqual([effects.count('LAUNCH'), effects.count('TOOL'), effects.count('FINISH')], [1, 1, 1]);
  }));

test('kill during cleanup: the terminal record stands, the run is closed and nothing relaunches', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    const result = await killAt(dataDir, 'cleanup');
    assert.deepEqual(result, { terminalWritten: true });
    const afterBoot = await boot(dataDir, { CR_RETRY: '1' });
    assert.equal(afterBoot.scanned, 0, 'a completed run is not an open run');
    assert.deepEqual(afterBoot.retry, { ok: true, runId: 'run-1' });

    const store = open();
    const row = readRow(store);
    assert.equal(row.state, 'completed');
    assert.equal(row.infraOutcome, 'completed');
    assert.equal(canAutoRelaunch({ logicalRunId: row.logicalRunId, liveness: 'dead', harness: 'codex' }, store).reason, 'already_completed');
    const gate = await tryResume(store, row);
    assert.equal(gate.result.status, 'not_resumable');
    assert.equal(gate.continuations.length, 0);
    assert.equal(sideEffects(dataDir).count('LAUNCH'), 1);
  }));

/** Seed an interrupted run, then SIGKILL a resume attempt so the run stays `recovering`. */
async function seedRecovering(dataDir, open) {
  const seed = await spawnStage(dataDir, 'seed', { CR_KILL_AT: 'seed_interrupted' });
  await seed.waitForExit(15_000);
  await seed.dispose();
  const store = open();
  const interrupted = readRow(store);
  assert.equal(interrupted.state, 'interrupted', 'a failed finish is a durable interrupted run');
  closeRecoveryStore(store);

  const recover = await spawnStage(dataDir, 'recover');
  try {
    assert.equal((await recover.kill()).signal, 'SIGKILL');
  } finally {
    await recover.dispose();
  }
  assert.equal(sideEffects(dataDir).count('CONTINUATION'), 1, 'the continuation started once before the kill');
  return interrupted;
}

test('G5 closed: kill during a recovery attempt, boot without proof releases the claim to unknown', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    const interrupted = await seedRecovering(dataDir, open);
    let store = open();
    assert.equal(readRow(store).state, 'recovering', 'the claim survives the kill until boot');
    closeRecoveryStore(store);

    const afterBoot = await boot(dataDir, { CR_RETRY: '1' });
    assert.equal(afterBoot.scanned, 1, 'a recovering run of a dead owner is visible to boot');
    assert.equal(afterBoot.classifications[0].state, 'unknown', 'no liveness proof -> unknown, never guessed');
    store = open();
    const row = readRow(store);
    assert.equal(row.state, 'unknown', 'the claim is released to a lifecycle unknown');
    assert.equal(row.reason, 'process_gone', 'the release reason is durable');
    assert.equal(row.bootEvidence.state, 'unknown');

    // Replaying the same key no longer reports the stored claim as in progress.
    const replay = await tryResume(store, interrupted, { key: 'manual-1' });
    assert.notEqual(replay.result.status, 'in_progress', 'same key must not replay in_progress forever');
    assert.equal(replay.result.status, 'superseded');
    assert.equal(replay.result.reason, 'claim_not_finished');
    assert.equal(replay.continuations.length, 0);
    // The run is resumable again through the unknown gate (explicit confirmation).
    const fresh = await tryResume(store, readRow(store), { key: 'manual-2', confirmUnknown: true });
    assert.notEqual(fresh.result.status, 'already_recovering');
    const effects = sideEffects(dataDir);
    assert.equal(effects.count('LAUNCH'), 1, 'recovery did not relaunch');
  }));

test('G5 closed: kill during a recovery attempt, dead executor proof -> interrupted', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await seedRecovering(dataDir, open);
    const afterBoot = await boot(dataDir, { CR_PROBE: 'idle' });
    assert.equal(afterBoot.scanned, 1);
    assert.equal(afterBoot.classifications[0].state, 'interrupted');
    assert.equal(afterBoot.classifications[0].interrupted, true);
    const store = open();
    const row = readRow(store);
    assert.equal(row.state, 'interrupted');
    assert.equal(row.reason, 'process_gone');
    const gate = await tryResume(store, row, { key: 'manual-3' });
    assert.equal(gate.result.status, 'resumed', 'the released run is resumable again');
    assert.equal(sideEffects(dataDir).count('LAUNCH'), 1);
  }));

test('G5 negative: a recovering run of a live instance or live executor is not touched', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await seedRecovering(dataDir, open);
    const store = open();
    const before = readRow(store);
    assert.equal(before.state, 'recovering');

    const liveHolder = classifyAndRecordOpenRuns({ store, claimHolderAlive: () => true });
    assert.equal(liveHolder.scanned, 0, 'a claim held by a live instance is skipped');
    const liveExecutor = classifyAndRecordOpenRuns({ store, probeLiveness: () => ({ known: true, busy: true }) });
    assert.equal(liveExecutor.classifications[0].classification.state, 'still_running');
    assert.equal(liveExecutor.classifications[0].interrupted, undefined);
    // The periodic re-probe path never lists `recovering` runs at all.
    const reprobe = runDueBootReprobes({ store, now: Date.now() + 3_600_000 });
    assert.equal(reprobe.scanned, 0);

    const after = readRow(store);
    assert.equal(after.state, 'recovering', 'the live claim survives');
    assert.equal(after.activeAttemptId, before.activeAttemptId);
    const other = await tryResume(store, after, { key: 'manual-live' });
    assert.equal(other.result.status, 'already_recovering', 'the lock still excludes a second resume');
    assert.equal(other.continuations.length, 0);
  }));

test('a Stop recorded before the kill stays cancelled and cannot be resumed', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await killAt(dataDir, 'stop');
    const afterBoot = await boot(dataDir, { CR_PROBE: 'idle' });
    let store = open();
    const row = readRow(store);
    assert.equal(row.state, 'cancelled', 'Stop is durable and terminal before the executor is cancelled');
    assert.equal(afterBoot.scanned, 0, 'a cancelled run is not an open run, so boot cannot reopen it');
    const gate = await tryResume(store, row, { confirmUnknown: true });
    assert.equal(gate.result.status, 'cancelled');
    assert.equal(gate.result.reason, 'user_stop');
    assert.equal(gate.continuations.length, 0);
    assert.equal(canAutoRelaunch({ logicalRunId: row.logicalRunId, liveness: 'dead', harness: 'codex' }, store).reason, 'cancelled');
    assert.equal(sideEffects(dataDir).count('CANCEL'), 1);
    assert.equal(sideEffects(dataDir).count('LAUNCH'), 1);
    closeRecoveryStore(store);
    store = null;
  }));

test('launch error: a known refusal is terminal and retryable, an unknown one stays unconfirmed (G4)', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async () => {
  await withScenario(async (dataDir, open) => {
    const result = await killAt(dataDir, 'launch_error', { CR_ERR_CODE: 'recipient_busy' });
    assert.deepEqual(result, { startError: 'recipient_busy' });
    const store = open();
    const row = getRunByAnyRequest(store);
    assert.equal(row.state, 'cancelled', 'refused launch is a durable terminal state, not starting');
    assert.match(row.terminalProof.detail, /^launch_refused:recipient_busy/);
    closeRecoveryStore(store);
    const afterBoot = await boot(dataDir, { CR_RETRY: '1' });
    assert.equal(afterBoot.scanned, 0);
    assert.equal(afterBoot.retry.ok, true, 'a proven refusal may be retried');
    assert.equal(sideEffects(dataDir).count('LAUNCH'), 1);
  });
  await withScenario(async (dataDir, open) => {
    const result = await killAt(dataDir, 'launch_error', { CR_ERR_CODE: 'boom' });
    assert.deepEqual(result, { startError: 'boom' });
    const afterBoot = await boot(dataDir, { CR_RETRY: '1' });
    assert.equal(afterBoot.classifications[0].state, 'unknown');
    assert.deepEqual(afterBoot.retry, { ok: false, code: 'acceptance_unconfirmed' });
    const store = open();
    const row = getRunByAnyRequest(store);
    assert.equal(row.state, 'starting', 'G4: an unproven failure is not terminal');
    assert.equal(row.acceptance.state, 'unconfirmed');
    assert.equal(sideEffects(dataDir).count('LAUNCH'), 0, 'neither the failing launch nor the retry reached an executor');
  });
});

test('G2: production boot intentionally passes no cancelRequested/terminalProof/waiting callbacks', { skip: SKIP }, () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'delegation-runtime-boot.js'), 'utf8');
  const start = src.indexOf('classifyAndRecordOpenRuns({');
  assert.notEqual(start, -1, 'boot calls classifyAndRecordOpenRuns');
  const call = src.slice(start, src.indexOf('});', start));
  for (const name of ['cancelRequested', 'terminalProof', 'waiting']) {
    assert.equal(call.includes(name), false, `boot call site does not pass ${name}`);
  }
  assert.match(call, /probeLiveness/, 'liveness is the only boot-supplied evidence callback');
});

test('a live executor surviving the server kill is still_running, with no new launch', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    await killAt(dataDir, 'executor');
    const pid = Number(fs.readFileSync(path.join(dataDir, 'executor.pid'), 'utf8'));
    try {
      process.kill(pid, 0);
      const afterBoot = await boot(dataDir, { CR_PROBE: 'executor', CR_RETRY: '1' });
      assert.equal(afterBoot.classifications[0].state, 'still_running');
      assert.equal(afterBoot.classifications[0].reason, 'alive_executor');
      assert.deepEqual(afterBoot.retry, { ok: true, runId: 'run-1' }, 'replays the accepted run, no second launch');
      const store = open();
      const row = readRow(store);
      assert.equal(row.state, 'running', 'the slot is left to the live executor (state untouched)');
      assert.equal(row.bootEvidence.state, 'still_running');
      assert.equal(afterBoot.classifications[0].interrupted, false);
      const gate = await tryResume(store, row, { liveness: 'alive', canReattach: true });
      assert.equal(gate.result.status, 'not_resumable');
      assert.equal(gate.continuations.length, 0);
      assert.equal(sideEffects(dataDir).count('LAUNCH'), 1);
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }));

test('a manual resume of an interrupted run honours the R12 gate and the wired fence (G3 closed)', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    const seed = await spawnStage(dataDir, 'seed', { CR_KILL_AT: 'seed_interrupted' });
    await seed.waitForExit(15_000);
    await seed.dispose();
    const store = open();
    const row = readRow(store);
    assert.equal(row.state, 'interrupted');
    const stale = await tryResume(store, { ...row, revision: row.revision + 5 }, { key: 'stale' });
    assert.equal(stale.result.status, 'conflict');
    const unconfirmed = await tryResume(store, row, { liveness: 'unknown', key: 'unk' });
    assert.equal(unconfirmed.result.status, 'liveness_unknown');
    const first = await tryResume(store, row, { key: 'go-1' });
    assert.equal(first.result.status, 'resumed');
    assert.equal(first.result.path, 'new_turn_same_session');
    assert.equal(first.result.fencing, 'enforced');
    assert.equal(first.continuations.length, 1);
    assert.equal(first.continuations[0].prompt, RESUME_CONTINUATION_PROMPT, 'the original prompt is never replayed');
    const after = getRun(row.logicalRunId, store);
    assert.equal(after.state, 'running', 'G3: the fenced adapter ack moves a resumed run to running');
    assert.equal(after.acceptance.adapterRunId, 'run-resumed', 'the new adapter run is linked to the new attempt');
    assert.equal(after.acceptance.attemptId, first.result.attemptId);
    const again = await tryResume(store, after, { key: 'go-1' });
    assert.equal(again.result.replayed, true);
    assert.equal(again.continuations.length, 0, 'the same key never launches twice');
    const second = await tryResume(store, after, { key: 'go-2' });
    assert.equal(second.result.reason, 'state_running');
    assert.equal(second.continuations.length, 0);
  }));

test('two server instances racing on one open run produce exactly one claimer', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir, open) => {
    const seed = await spawnStage(dataDir, 'seed', { CR_KILL_AT: 'seed_interrupted' });
    await seed.waitForExit(15_000);
    await seed.dispose();
    const barrier = await spawnRecoveryBarrier({
      script: SCRIPT,
      dataDir,
      count: 2,
      timeoutMs: 20_000,
      env: {
        CRETLI_DATA_DIR: dataDir,
        CURSOR_REMOTE_DATA_DIR: dataDir,
        CRETLI_TEST_DATA_DIR: dataDir,
        CURSOR_REMOTE_TEST_DATA_DIR: dataDir,
        CR_STAGE: 'race',
      },
      envForIndex: (index) => ({ CR_RACE_KEY: `race-${index}` }),
    });
    try {
      barrier.release();
      await barrier.waitForExit(20_000);
      const results = barrier.handles.map(readResult);
      const statuses = results.map((entry) => entry.status);
      assert.equal(statuses.filter((status) => status === 'resumed').length, 1, `exactly one claimer: ${statuses}`);
      const loser = statuses.find((status) => status !== 'resumed');
      assert.ok(['already_recovering', 'conflict', 'not_resumable', 'superseded'].includes(loser), `loser: ${loser}`);
      assert.equal(sideEffects(dataDir).count('CONTINUATION'), 1, 'one continuation across both instances');
      const store = open();
      assert.equal(readRow(store).state, 'running');
    } finally {
      await barrier.dispose();
    }
  }));

/** The single chat-run row of a scenario, whatever caller ordinal it used. */
function getRunByAnyRequest(store) {
  return readRow(store);
}
