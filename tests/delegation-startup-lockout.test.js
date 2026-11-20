import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  clearHarnessStartupFailureLockout,
  clearHarnessUsageLimit,
  getHarnessUsageLimit,
  listHarnessUsageLimitsForWorkspace,
  noteHarnessStartupFailureLockout,
  noteHarnessUsageLimit,
  STARTUP_FAILURE_LOCKOUT_CODE,
} from '../lib/harness-usage-limits.js';
import { createStartupLockoutWorkspacePair } from './helpers/startup-lockout-fixture.js';
import {
  isDelegationStartupFailure,
  resolveOpenCodeDelegatedFirstEventTimeoutMs,
} from '../lib/delegation-startup-failure.js';
import {
  resolveStartupFailureLockoutDurationMs,
  resolveStartupFailureLockoutMs,
} from '../lib/delegation-startup-lockout-policy.js';
import { MODEL_PICK_HARD_GATE_CODES, evaluateModelPickHardGates } from '../lib/model-pick-hard-gates.js';
import { evaluateDelegationStartHardGates } from '../lib/delegation-model-gates.js';
import { finishDelegation } from '../lib/delegation-service.js';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { resolveOpenCodeFirstEventTimeoutMs } from '../harnesses/opencode/opencode-prompt-run.js';
import { DELEGATION_ADAPTER_TIMEOUT_CODE } from '../lib/delegation-adapter-error.js';
import { makeTempDir } from './helpers/temp-dir.js';

test('startup failure classifier accepts first-event timeout and transport errors only', () => {
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: '[adapter_timeout] OpenCode prompt first event timed out',
  }), true);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: 'OpenCode prompt first event timed out',
  }), true);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: 'Transport not started',
  }), true);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: `[${DELEGATION_ADAPTER_TIMEOUT_CODE}] OpenCode prompt timed out`,
  }), false);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: 'OpenCode prompt timed out',
    errors: [{ code: DELEGATION_ADAPTER_TIMEOUT_CODE, message: 'OpenCode prompt timed out' }],
  }), false);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: 'Something timed out during review',
  }), false);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: 'Run deadline exceeded before completion',
  }), false);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: "You've hit your usage limit",
  }), false);
  assert.equal(isDelegationStartupFailure({
    status: 'failed',
    error: 'Review finished with substantive defects in auth.js',
    report: 'VERDICT: FAIL\nFinding still open',
  }), false);
  assert.equal(isDelegationStartupFailure({ status: 'cancelled', error: 'Transport not started' }), false);
});

test('startup lockout blocks model_pick and expires with a fake clock', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cr-startup-lockout-'));
  const { wsA } = createStartupLockoutWorkspacePair();
  const prevLockoutMs = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = '7200000';
  try {
    const now = Date.now();
    assert.equal(noteHarnessStartupFailureLockout({
      harness: 'opencode',
      model: 'vendor/model-a',
      dataDir,
      workspaceFolder: wsA,
      now,
    }), true);
    const locked = getHarnessUsageLimit({
      harness: 'opencode',
      model: 'vendor/model-a',
      dataDir,
      workspaceFolder: wsA,
    });
    assert.equal(locked?.code, STARTUP_FAILURE_LOCKOUT_CODE);
    const lockouts = listHarnessUsageLimitsForWorkspace({ dataDir, workspaceFolder: wsA });
    const gate = evaluateModelPickHardGates({
      role: 'review',
      harness: 'opencode',
      model: 'vendor/model-a',
      lockouts,
      now,
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, MODEL_PICK_HARD_GATE_CODES.STARTUP_FAILURE_LOCKOUT);
    assert.equal(gate.reason, 'startup-failure');
    const afterReset = Date.parse(locked.resetAt) + 1000;
    const clearedGate = evaluateModelPickHardGates({
      role: 'review',
      harness: 'opencode',
      model: 'vendor/model-a',
      lockouts,
      now: afterReset,
    });
    assert.equal(clearedGate.ok, true);
  } finally {
    if (prevLockoutMs === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prevLockoutMs;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('usage-limit lockout is not replaced by startup lockout', () => {
  const dataDir = makeTempDir('cr-startup-vs-usage-');
  const { wsA } = createStartupLockoutWorkspacePair();
  try {
    noteHarnessUsageLimit({
      harness: 'opencode',
      model: 'vendor/model-b',
      message: 'Usage limit reached; resets at 2099-01-02 03:04:05',
      dataDir,
    });
    assert.equal(noteHarnessStartupFailureLockout({
      harness: 'opencode',
      model: 'vendor/model-b',
      dataDir,
      workspaceFolder: wsA,
    }), false);
    assert.equal(getHarnessUsageLimit({ harness: 'opencode', model: 'vendor/model-b', dataDir })?.code, 'usage_limit');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('second startup failure within 24h extends lockout to 12h', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cr-startup-escalate-'));
  const { wsA } = createStartupLockoutWorkspacePair();
  const prevBase = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  const prevExtended = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_EXTENDED_MS;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = String(2 * 60 * 60 * 1000);
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_EXTENDED_MS = String(12 * 60 * 60 * 1000);
  // The lockout store filters expired rows with Date.now(); the test uses
  // historical timestamps, so advance the clock to the second failure time.
  const realNow = Date.now;
  const firstAt = Date.parse('2026-10-12T08:00:00.000Z');
  const secondAt = firstAt + 2 * 60 * 60 * 1000;
  Date.now = () => secondAt;
  try {
    noteHarnessStartupFailureLockout({
      harness: 'codebuddy',
      model: 'cb-model',
      dataDir,
      workspaceFolder: wsA,
      now: firstAt,
    });
    clearHarnessStartupFailureLockout({ harness: 'codebuddy', model: 'cb-model', dataDir, workspaceFolder: wsA });
    noteHarnessStartupFailureLockout({
      harness: 'codebuddy',
      model: 'cb-model',
      dataDir,
      workspaceFolder: wsA,
      now: secondAt,
    });
    const locked = getHarnessUsageLimit({ harness: 'codebuddy', model: 'cb-model', dataDir, workspaceFolder: wsA });
    const durationMs = Date.parse(locked.resetAt) - secondAt;
    assert.equal(durationMs, 12 * 60 * 60 * 1000);
  } finally {
    Date.now = realNow;
    if (prevBase === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prevBase;
    if (prevExtended === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_EXTENDED_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_EXTENDED_MS = prevExtended;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('successful delegation finish clears startup lockout only', () => {
  const dataDir = ISOLATED_DATA_DIR;
  const { wsA } = createStartupLockoutWorkspacePair();
  const prevLockoutMs = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = '7200000';
  const model = `ds-model-clear-${process.pid}`;
  const harness = 'mock';
  try {
    noteHarnessStartupFailureLockout({ harness, model, dataDir, workspaceFolder: wsA });
    assert.ok(getHarnessUsageLimit({ harness, model, dataDir, workspaceFolder: wsA }));
    const delegation = createDelegationRecord({
      id: `del-startup-clear-${process.pid}`,
      parentChatId: 'chat-parent',
      childChatId: 'chat-child',
      workspaceFolder: wsA,
      executor: { transport: harness, model },
      status: 'running',
      assignment: 'implement',
      attemptId: 'attempt-1',
    });
    finishDelegation(delegation, {
      status: 'completed',
      report: 'Done.\nVERDICT: PASS',
      attemptId: 'attempt-1',
    });
    assert.equal(getHarnessUsageLimit({ harness, model, dataDir, workspaceFolder: wsA }), null);
    noteHarnessUsageLimit({
      harness,
      model,
      message: 'Usage limit reached; resets at 2099-01-02 03:04:05',
      dataDir,
    });
    const usageLocked = getHarnessUsageLimit({ harness, model, dataDir });
    assert.equal(usageLocked?.code, 'usage_limit');
    finishDelegation(getDelegationById(delegation.id) || delegation, {
      status: 'completed',
      report: 'Done again.\nVERDICT: PASS',
      attemptId: 'attempt-1',
    });
    assert.equal(getHarnessUsageLimit({ harness, model, dataDir })?.code, 'usage_limit');
  } finally {
    if (prevLockoutMs === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prevLockoutMs;
    clearHarnessStartupFailureLockout({ harness, model, dataDir, workspaceFolder: wsA });
    clearHarnessUsageLimit(harness, model, dataDir);
  }
});

test('named delegation_start may override startup lockout; pick-linked start may not', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cr-startup-named-'));
  const { wsA } = createStartupLockoutWorkspacePair();
  const prevLockoutMs = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = '7200000';
  try {
    const harness = 'mock';
    const model = `locked-model-${process.pid}`;
    noteHarnessStartupFailureLockout({ harness, model, dataDir, workspaceFolder: wsA });
    const lockouts = listHarnessUsageLimitsForWorkspace({ dataDir, workspaceFolder: wsA });
    const named = evaluateDelegationStartHardGates({
      role: 'implement',
      harness,
      model,
      harnessRow: { enabled: true, ready: true, can_delegate: true },
      favoritesConfigured: true,
      favoriteModels: [model],
      modelRoles: ['implement'],
      lockouts,
      usageLimits: lockouts,
      permitStartupFailureLockoutOverride: true,
      allowNamedModel: true,
    });
    assert.equal(named.ok, true, named.error || named.code);
    const pickLinked = evaluateDelegationStartHardGates({
      role: 'implement',
      harness,
      model,
      harnessRow: { enabled: true, ready: true, can_delegate: true },
      favoritesConfigured: true,
      favoriteModels: [model],
      modelRoles: ['implement'],
      lockouts,
      usageLimits: lockouts,
      allowNamedModel: true,
    });
    assert.equal(pickLinked.ok, false);
    assert.equal(pickLinked.code, MODEL_PICK_HARD_GATE_CODES.STARTUP_FAILURE_LOCKOUT);
  } finally {
    if (prevLockoutMs === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prevLockoutMs;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('delegated OpenCode first-event timeout defaults to 2 minutes; user chat stays at 3 minutes', () => {
  const prevDelegated = process.env.OPENCODE_DELEGATED_FIRST_EVENT_TIMEOUT_MS;
  const prevNormal = process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS;
  delete process.env.OPENCODE_DELEGATED_FIRST_EVENT_TIMEOUT_MS;
  delete process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS;
  try {
    assert.equal(resolveOpenCodeDelegatedFirstEventTimeoutMs(), 120000);
    assert.ok(resolveOpenCodeFirstEventTimeoutMs() >= 180000);
  } finally {
    if (prevDelegated === undefined) delete process.env.OPENCODE_DELEGATED_FIRST_EVENT_TIMEOUT_MS;
    else process.env.OPENCODE_DELEGATED_FIRST_EVENT_TIMEOUT_MS = prevDelegated;
    if (prevNormal === undefined) delete process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS;
    else process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS = prevNormal;
  }
});

test('finishDelegation does not record startup lockout after post-first-event prompt timeout', () => {
  const dataDir = ISOLATED_DATA_DIR;
  const { wsA } = createStartupLockoutWorkspacePair();
  const model = `mimo-runtime-timeout-${process.pid}`;
  try {
    const delegation = createDelegationRecord({
      id: `del-startup-runtime-timeout-${process.pid}`,
      parentChatId: 'chat-parent-rt',
      childChatId: 'chat-child-rt',
      workspaceFolder: wsA,
      executor: { transport: 'opencode', model },
      status: 'running',
      assignment: 'review',
      attemptId: 'attempt-rt',
    });
    finishDelegation(delegation, {
      status: 'failed',
      error: `[${DELEGATION_ADAPTER_TIMEOUT_CODE}] OpenCode prompt timed out`,
      attemptId: 'attempt-rt',
    });
    assert.equal(getHarnessUsageLimit({ harness: 'opencode', model, dataDir, workspaceFolder: wsA }), null);
  } finally {
    clearHarnessStartupFailureLockout({ harness: 'opencode', model, dataDir, workspaceFolder: wsA });
  }
});

test('finishDelegation records startup lockout after adapter timeout when retries are disabled', () => {
  const dataDir = ISOLATED_DATA_DIR;
  const { wsA } = createStartupLockoutWorkspacePair();
  const prevLockoutMs = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  const prevRetryCount = process.env.CRETLI_STARTUP_FAILURE_RETRIES;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = '7200000';
  // The service scheduler normally retries a transient startup failure before
  // the lockout; this test pins the disabled-retry path (immediate lockout).
  process.env.CRETLI_STARTUP_FAILURE_RETRIES = '0';
  const model = `mimo-model-x-${process.pid}`;
  try {
    const delegation = createDelegationRecord({
      id: `del-startup-finish-${process.pid}`,
      parentChatId: 'chat-parent-2',
      childChatId: 'chat-child-2',
      workspaceFolder: wsA,
      executor: { transport: 'opencode', model },
      status: 'running',
      assignment: 'review',
      attemptId: 'attempt-2',
    });
    finishDelegation(delegation, {
      status: 'failed',
      error: `[${DELEGATION_ADAPTER_TIMEOUT_CODE}] OpenCode prompt first event timed out`,
      attemptId: 'attempt-2',
    });
    assert.equal(
      getHarnessUsageLimit({ harness: 'opencode', model, dataDir, workspaceFolder: wsA })?.code,
      STARTUP_FAILURE_LOCKOUT_CODE,
    );
    finishDelegation(getDelegationById(delegation.id) || delegation, {
      status: 'failed',
      error: 'VERDICT: FAIL\nStill broken',
      attemptId: 'attempt-2',
    });
    assert.equal(getHarnessUsageLimit({ harness: 'opencode', model, dataDir, workspaceFolder: wsA })?.code,
      STARTUP_FAILURE_LOCKOUT_CODE,
      'substantive FAIL must not replace an existing startup lockout row',
    );
  } finally {
    if (prevLockoutMs === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prevLockoutMs;
    if (prevRetryCount === undefined) delete process.env.CRETLI_STARTUP_FAILURE_RETRIES;
    else process.env.CRETLI_STARTUP_FAILURE_RETRIES = prevRetryCount;
    clearHarnessStartupFailureLockout({ harness: 'opencode', model, dataDir, workspaceFolder: wsA });
  }
});

test('startup lockout is scoped per workspace; usage lockout stays global', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cr-startup-ws-scope-'));
  const { wsA, wsB } = createStartupLockoutWorkspacePair();
  const prevLockoutMs = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = '7200000';
  const sharedModel = 'vendor/shared-model';
  try {
    assert.equal(noteHarnessStartupFailureLockout({
      harness: 'opencode',
      model: sharedModel,
      dataDir,
      workspaceFolder: wsA,
    }), true);
    const lockoutsA = listHarnessUsageLimitsForWorkspace({ dataDir, workspaceFolder: wsA });
    const lockoutsB = listHarnessUsageLimitsForWorkspace({ dataDir, workspaceFolder: wsB });
    assert.equal(evaluateModelPickHardGates({
      role: 'review',
      harness: 'opencode',
      model: sharedModel,
      lockouts: lockoutsA,
    }).ok, false);
    assert.equal(evaluateModelPickHardGates({
      role: 'review',
      harness: 'opencode',
      model: sharedModel,
      lockouts: lockoutsB,
    }).ok, true);
    noteHarnessUsageLimit({
      harness: 'opencode',
      model: 'vendor/usage-global',
      message: 'Usage limit reached; resets at 2099-01-02 03:04:05',
      dataDir,
    });
    for (const ws of [wsA, wsB]) {
      assert.equal(
        getHarnessUsageLimit({ harness: 'opencode', model: 'vendor/usage-global', dataDir, workspaceFolder: ws })?.code,
        'usage_limit',
        ws,
      );
    }
    const delegationB = createDelegationRecord({
      id: `del-startup-ws-b-${process.pid}`,
      parentChatId: 'chat-parent-b',
      childChatId: 'chat-child-b',
      workspaceFolder: wsB,
      executor: { transport: 'opencode', model: sharedModel },
      status: 'running',
      assignment: 'implement',
      attemptId: 'attempt-b',
    });
    finishDelegation(delegationB, {
      status: 'completed',
      report: 'Done.\nVERDICT: PASS',
      attemptId: 'attempt-b',
    });
    assert.equal(getHarnessUsageLimit({
      harness: 'opencode',
      model: sharedModel,
      dataDir,
      workspaceFolder: wsA,
    })?.code, STARTUP_FAILURE_LOCKOUT_CODE);
    assert.equal(getHarnessUsageLimit({
      harness: 'opencode',
      model: sharedModel,
      dataDir,
      workspaceFolder: wsB,
    }), null);
  } finally {
    if (prevLockoutMs === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prevLockoutMs;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('resolveStartupFailureLockoutMs honors zero disable', () => {
  const prev = process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
  process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = '0';
  try {
    assert.equal(resolveStartupFailureLockoutMs(), 0);
    assert.equal(resolveStartupFailureLockoutDurationMs({ repeatedWithinWindow: true }), 0);
  } finally {
    if (prev === undefined) delete process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS;
    else process.env.CRETLI_STARTUP_FAILURE_LOCKOUT_MS = prev;
  }
});
