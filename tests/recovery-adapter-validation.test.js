/**
 * Leaf R7: per-harness, per-exact-SDK-version validation matrix for the recovery
 * MVP adapter contract (declared rows plus an explicit store-driven evaluator).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDurableRequestLookup } from '../lib/chat-run/kernel-adapter.js';
import {
  beginRunLaunch,
  canAutoRelaunch,
  recordExecutorAck,
} from '../lib/recovery/recovery-lifecycle.js';
import { markRunWaiting, requestRunCancel } from '../lib/recovery/recovery-queue.js';
import { closeRecoveryStore, openRecoveryStore } from '../lib/recovery/recovery-store.js';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.js';
import {
  RECOVERY_DEFERRED_ADAPTERS,
  RECOVERY_MVP_ADAPTERS,
  RUN_TRANSCRIPT_LOSS_REASONS,
  describeRecoveryAdapterContract,
  resolveRecoveryAdapter,
} from '../lib/recovery/recovery-contract.js';
import {
  RECOVERY_VALIDATION_SCENARIOS,
  adapterValidationRecordCoversVersion,
  buildAdapterValidationVersionKey,
  buildRecoveryAdapterValidationRecord,
  evaluateRecoveryAdapterValidation,
  getRecoveryAdapterValidationMatrix,
  listRecoveryAdapterValidationSubjects,
  resolveHarnessSdkPackageInfo,
} from '../lib/recovery/adapter-validation.js';

const MVP_HARNESSES = Object.keys(RECOVERY_MVP_ADAPTERS);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, Record<string, string>>} */
const EXPECTED_SCENARIO_STATUS = Object.freeze(
  Object.fromEntries(MVP_HARNESSES.map((harness) => [
    harness,
    Object.freeze({
      context: 'validated',
      live_executor: 'validated',
      waiting: 'validated',
      cancel: 'validated',
      missing_transcript: 'validated',
    }),
  ])),
);

/**
 * @returns {string}
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'recovery-adapter-val-'));
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
 * @param {object} store
 * @param {string} harness
 * @returns {{ ids: object, run: object }}
 */
/**
 * @param {string} harness
 * @param {object} store
 * @param {{ sdkVersionOverride?: string, canAutoRelaunch?: Function, createDurableRequestLookup?: Function }} [extra]
 * @returns {object}
 */
function recordWithRuntime(harness, store, extra = {}) {
  const scenarios = evaluateRecoveryAdapterValidation({
    harness,
    store,
    canAutoRelaunch: extra.canAutoRelaunch,
    createDurableRequestLookup: extra.createDurableRequestLookup,
  });
  const pkg = resolveHarnessSdkPackageInfo(harness);
  return buildRecoveryAdapterValidationRecord({
    harness,
    scenarios,
    sdkVersionOverride: extra.sdkVersionOverride,
    packageInfo: extra.sdkVersionOverride ? undefined : pkg,
    packageName: pkg.packageName,
  });
}

function launchAndAck(store, harness) {
  const ids = createRecoveryIds();
  const launched = beginRunLaunch({
    ...ids,
    family: 'chat',
    owner: 'chat-run-service',
    chatId: 'chat-r7',
    harness,
  }, store);
  const ack = recordExecutorAck({
    logicalRunId: ids.logicalRunId,
    expectedRevision: launched.run.revision,
    source: 'adapter_ack',
    adapterRunId: 'run-r7',
  }, store);
  return { ids, run: ack.run };
}

test('validation matrix covers exactly six MVP harnesses plus three deferred', () => {
  const subjects = listRecoveryAdapterValidationSubjects();
  assert.deepEqual([...subjects].sort(), [
    ...MVP_HARNESSES,
    ...RECOVERY_DEFERRED_ADAPTERS,
  ].sort());
  const matrix = getRecoveryAdapterValidationMatrix();
  assert.equal(Object.keys(matrix).length, 9);
  for (const harness of MVP_HARNESSES) {
    assert.equal(matrix[harness].scope, 'mvp');
    assert.equal(matrix[harness].overallStatus, 'pending');
    assert.equal(matrix[harness].scenarios.waiting.status, 'pending');
    assert.equal(matrix[harness].scenarios.waiting.notRun, true);
    assert.equal(matrix[harness].scenarios.cancel.notRun, true);
    assert.equal(matrix[harness].scenarios.missing_transcript.notRun, true);
  }
  for (const deferred of RECOVERY_DEFERRED_ADAPTERS) {
    assert.equal(matrix[deferred].overallStatus, 'unsupported');
    assert.equal(matrix[deferred].deferred, true);
  }
});

test('every MVP harness declares all five validation scenarios with derived statuses', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      for (const harness of MVP_HARNESSES) {
        const record = recordWithRuntime(harness, store);
        assert.equal(record.requiresCrashValidation, true);
        assert.equal(record.enableGateValidation, 'pending');
        const expected = EXPECTED_SCENARIO_STATUS[harness];
        for (const scenario of RECOVERY_VALIDATION_SCENARIOS) {
          assert.ok(record.scenarios[scenario], `${harness} missing scenario ${scenario}`);
          assert.equal(
            record.scenarios[scenario].status,
            expected[scenario],
            `${harness}/${scenario}`,
          );
        }
        assert.equal(record.scenarios.waiting.gateReason, 'waiting');
        assert.equal(record.scenarios.cancel.gateReason, 'cancelled');
        assert.equal(record.scenarios.waiting.autoRelaunchAllowed, false);
        assert.equal(record.scenarios.cancel.autoRelaunchAllowed, false);
      }
      const matrix = getRecoveryAdapterValidationMatrix({ store });
      assert.equal(matrix.codex.scenarios.waiting.gateReason, 'waiting');
      assert.equal(matrix.opencode.scenarios.missing_transcript.foreignRoomTranscriptLossReason, 'no_live_run_match');
      assert.equal(matrix.claude.scenarios.missing_transcript.foreignRoomTranscriptLossReason, 'fresh_turn_in_saved_session');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version keying: one SDK version does not satisfy another', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const harness = 'sdk';
      const vA = recordWithRuntime(harness, store, { sdkVersionOverride: '1.0.37' });
      const vB = recordWithRuntime(harness, store, { sdkVersionOverride: '1.0.38' });
      assert.equal(vA.versionKey, buildAdapterValidationVersionKey(harness, '1.0.37'));
      assert.equal(vB.versionKey, buildAdapterValidationVersionKey(harness, '1.0.38'));
      assert.ok(adapterValidationRecordCoversVersion(vA, '1.0.37'));
      assert.ok(!adapterValidationRecordCoversVersion(vA, '1.0.38'));
      assert.ok(!adapterValidationRecordCoversVersion(vB, '1.0.37'));
      assert.equal(vA.overallStatus, 'pending');
      assert.equal(vB.overallStatus, 'pending');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deferred and unknown harnesses never reach validated overall status', () => {
  for (const deferred of RECOVERY_DEFERRED_ADAPTERS) {
    const record = buildRecoveryAdapterValidationRecord({ harness: deferred });
    assert.notEqual(record.overallStatus, 'validated');
    assert.equal(record.overallStatus, 'unsupported');
    assert.equal(Object.keys(record.scenarios).length, 0);
    const view = describeRecoveryAdapterContract(deferred);
    assert.equal(view.validation, '');
    assert.equal(view.adapterValidation.overallStatus, 'unsupported');
  }
  const unknown = buildRecoveryAdapterValidationRecord({ harness: 'no-such-harness' });
  assert.equal(unknown.overallStatus, 'no_validation');
  assert.notEqual(unknown.overallStatus, 'validated');
  const unknownView = describeRecoveryAdapterContract('no-such-harness');
  assert.equal(unknownView.adapterValidation.overallStatus, 'no_validation');
});

test('context and live_executor map to contract vocabulary for every MVP harness', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      for (const harness of MVP_HARNESSES) {
        const entry = RECOVERY_MVP_ADAPTERS[harness];
        const view = describeRecoveryAdapterContract(harness);
        const record = recordWithRuntime(harness, store);
        const context = record.scenarios.context;
        assert.equal(context.resumeStrategy, entry.resumeStrategy);
        assert.equal(context.transcriptLossReason, view.transcriptLossReason);
        assert.ok(RUN_TRANSCRIPT_LOSS_REASONS.includes(context.transcriptLossReason));
        const live = record.scenarios.live_executor;
        assert.equal(live.canReattach, entry.reattach === true);
        assert.equal(live.resumeStrategy, entry.resumeStrategy);
        if (harness === 'opencode') {
          assert.equal(live.aliveDecision, 'reattach');
          assert.equal(live.aliveAutomatic, true);
          assert.equal(view.transcriptLossReason, 'none');
        } else {
          assert.equal(live.aliveDecision, 'manual_only');
          assert.equal(context.transcriptLossReason, 'fresh_turn_in_saved_session');
          assert.equal(live.deadDecision, 'resume_session');
        }
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing_transcript scenario uses registered loss tokens via kernel lookup', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      for (const transport of [...MVP_HARNESSES, ...RECOVERY_DEFERRED_ADAPTERS]) {
        const launch = beginRunLaunch({
          family: 'chat',
          owner: 'chat-run-service',
          harness: transport,
        }, store);
        recordExecutorAck({
          logicalRunId: launch.ids.logicalRunId,
          expectedRevision: launch.run.revision,
          source: 'adapter_ack',
          adapterRunId: 'run-missing',
        }, store);
        const lookup = createDurableRequestLookup({
          transport,
          rooms: new Map(),
          recoveryStore: store,
        });
        const found = lookup({
          chat: { cursorSessionId: 'sess-missing' },
          requestId: launch.ids.requestId,
        });
        if (RECOVERY_DEFERRED_ADAPTERS.includes(transport)) {
          assert.equal(found.unsupported, true);
          assert.equal(found.transcriptLossReason, 'no_recovery_contract');
          continue;
        }
        assert.equal(found.transcriptLossReason, 'room_missing');
        assert.ok(RUN_TRANSCRIPT_LOSS_REASONS.includes(found.transcriptLossReason));
        const record = recordWithRuntime(transport, store);
        const missing = record.scenarios.missing_transcript;
        assert.equal(missing.emptyRoomTranscriptLossReason, 'room_missing');
        assert.ok(missing.observedLossReasons.includes('room_missing'));
        if (transport === 'opencode') {
          assert.ok(missing.observedLossReasons.includes('no_live_run_match'));
          assert.equal(missing.foreignRoomTranscriptLossReason, 'no_live_run_match');
        } else {
          assert.ok(!missing.observedLossReasons.includes('no_live_run_match'));
          assert.equal(missing.foreignRoomTranscriptLossReason, 'fresh_turn_in_saved_session');
        }
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waiting and cancel matrix rows match canAutoRelaunch for every MVP harness', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      for (const harness of MVP_HARNESSES) {
        const cancelled = launchAndAck(store, harness);
        requestRunCancel({
          logicalRunId: cancelled.ids.logicalRunId,
          requestId: createRecoveryIds().requestId,
          reason: 'user_cancel',
        }, store);
        const gateCancel = canAutoRelaunch({ logicalRunId: cancelled.ids.logicalRunId }, store);
        assert.equal(gateCancel.allowed, false);
        assert.equal(gateCancel.reason, 'cancelled');
        const waiting = launchAndAck(store, harness);
        const waitMark = markRunWaiting({
          logicalRunId: waiting.ids.logicalRunId,
          expectedRevision: waiting.run.revision,
          kind: 'question',
          requestId: createRecoveryIds().requestId,
        }, store);
        assert.equal(waitMark.ok, true);
        assert.equal(waitMark.applied, true);
        const gateWait = canAutoRelaunch({ logicalRunId: waiting.ids.logicalRunId }, store);
        assert.equal(gateWait.allowed, false);
        assert.equal(gateWait.reason, 'waiting');
        const record = recordWithRuntime(harness, store);
        assert.equal(record.scenarios.cancel.status, 'validated');
        assert.equal(record.scenarios.cancel.gateReason, gateCancel.reason);
        assert.equal(record.scenarios.waiting.status, 'validated');
        assert.equal(record.scenarios.waiting.gateReason, gateWait.reason);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MVP enable gate stays pending; describeRecoveryAdapterContract surfaces validation', () => {
  for (const harness of MVP_HARNESSES) {
    const entry = resolveRecoveryAdapter(harness);
    assert.equal(entry.validation, 'pending');
    assert.equal(entry.requiresCrashValidation, true);
    const view = describeRecoveryAdapterContract(harness);
    assert.equal(view.validation, 'pending');
    assert.equal(view.requiresCrashValidation, true);
    assert.equal(view.adapterValidation.overallStatus, 'pending');
    assert.notEqual(view.adapterValidation.overallStatus, 'validated');
    const pkg = resolveHarnessSdkPackageInfo(harness);
    if (pkg.sdkVersion !== 'unknown') {
      assert.equal(view.adapterValidation.sdkVersion, pkg.sdkVersion);
    }
  }
});

test('bypassing canAutoRelaunch or lookup flips that scenario to failed', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const bypassGate = () => ({ allowed: true, reason: 'still_active' });
      const bypassLookup = () => () => ({ transcriptLossReason: 'invented' });
      for (const harness of MVP_HARNESSES) {
        const gated = recordWithRuntime(harness, store, { canAutoRelaunch: bypassGate });
        assert.equal(gated.scenarios.waiting.status, 'failed', `${harness} waiting`);
        assert.equal(gated.scenarios.cancel.status, 'failed', `${harness} cancel`);
        assert.equal(gated.overallStatus, 'failed', harness);
        const lookedUp = recordWithRuntime(harness, store, {
          createDurableRequestLookup: bypassLookup,
        });
        assert.equal(lookedUp.scenarios.missing_transcript.status, 'failed', `${harness} transcript`);
        assert.equal(lookedUp.overallStatus, 'failed', harness);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateRecoveryAdapterValidation refuses to open a store implicitly', () => {
  assert.throws(
    () => evaluateRecoveryAdapterValidation({ harness: 'sdk' }),
    /requires store/,
  );
});

test('describeRecoveryAdapterContract does not open a recovery store', () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'tmpdir-is-a-file');
  writeFileSync(blocker, 'not a directory');
  const hooksPath = path.join(dir, 'spy-recovery-store-hooks.mjs');
  const registerPath = path.join(dir, 'register-spy.mjs');
  const childPath = path.join(dir, 'contract-view-probe.mjs');
  const hooksHref = pathToFileURL(hooksPath).href;
  writeFileSync(hooksPath, `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!String(url).endsWith('/lib/recovery/recovery-store.js')) return loaded;
  const source = String(loaded.source || '');
  const needle = 'export function openRecoveryStore(options = {}) {';
  if (!source.includes(needle)) {
    throw new Error('spy loader missed openRecoveryStore');
  }
  return {
    ...loaded,
    format: 'module',
    source: source.replace(needle, needle + ' globalThis.__cretliOpenRecoveryStoreCalls = (globalThis.__cretliOpenRecoveryStoreCalls || 0) + 1;'),
  };
}
`);
  writeFileSync(registerPath, `
import { register } from 'node:module';
register(${JSON.stringify(hooksHref)}, import.meta.url);
`);
  const contractHref = pathToFileURL(path.join(REPO_ROOT, 'lib/recovery/recovery-contract.js')).href;
  writeFileSync(childPath, `
const { describeRecoveryAdapterContract } = await import(${JSON.stringify(contractHref)});
globalThis.__cretliOpenRecoveryStoreCalls = 0;
const view = describeRecoveryAdapterContract('sdk');
const waiting = view.adapterValidation?.scenarios?.waiting;
if (view.validation !== 'pending') throw new Error('validation ' + view.validation);
if (view.requiresCrashValidation !== true) throw new Error('requiresCrashValidation');
if (view.adapterValidation?.overallStatus !== 'pending') throw new Error('overall ' + view.adapterValidation?.overallStatus);
if (waiting?.status !== 'pending' || waiting?.notRun !== true) throw new Error('waiting was evaluated');
if (globalThis.__cretliOpenRecoveryStoreCalls !== 0) {
  throw new Error('openRecoveryStore calls ' + globalThis.__cretliOpenRecoveryStoreCalls);
}
console.log(JSON.stringify({
  validation: view.validation,
  overallStatus: view.adapterValidation.overallStatus,
  waiting: waiting.status,
  opens: globalThis.__cretliOpenRecoveryStoreCalls,
}));
`);
  const probe = spawnSync(process.execPath, ['--import', pathToFileURL(registerPath).href, childPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: blocker },
  });
  assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
  assert.match(probe.stdout, /"validation":"pending"/);
  assert.match(probe.stdout, /"opens":0/);
  rmSync(dir, { recursive: true, force: true });
});
