import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService, finishDelegation, inspectDelegationSlot, reconcileDelegationsOnBoot, releaseDelegationRunSlot } from '../lib/delegation-service.js';
import { findDelegationByChildChatId, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  getMockChatRunStartCount,
  listMockChatRunChatIds,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
  setMockChatRunFailStart,
  setMockChatRunListener,
} from '../lib/chat-run/mock-adapter.js';
import { probeChatRunLiveness } from '../lib/chat-run-service.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { isTerminalDelegationStatus } from '../lib/delegation-status.js';
import {
  clearHarnessStartupFailureLockout,
  clearHarnessUsageLimit,
  getHarnessUsageLimit,
  listHarnessUsageLimitsForWorkspace,
  noteHarnessStartupFailureLockout,
} from '../lib/harness-usage-limits.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { resolveStartupRetryCount, resolveStartupRetryDelayMs } from '../lib/delegation-startup-failure.js';

const HARNESS = 'opencode';
const MODEL = 'opencode/retry-test';
const TRANSIENT = 'Transport not started';
const FIRST_EVENT_TIMEOUT = 'OpenCode prompt first event timed out';
const RETRY_DELAY_MS = '5';

const startupLockouts = () => listHarnessUsageLimitsForWorkspace({ dataDir: ISOLATED_DATA_DIR, workspaceFolder: ISOLATED_DATA_DIR })
  .filter((row) => row.code === 'startup_failure');

const limitFor = () => getHarnessUsageLimit({
  harness: HARNESS,
  model: MODEL,
  dataDir: ISOLATED_DATA_DIR,
  workspaceFolder: ISOLATED_DATA_DIR,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Count adapter starts for one child chat only. The global mock counter also
 * counts unrelated mailbox deliveries to other chats after a terminal finish,
 * which are not retry attempts.
 *
 * @param {string} childChatId
 * @returns {{ count: () => number }}
 */
function trackStartsForChat(childChatId) {
  let starts = 0;
  const previous = currentStartListener;
  currentStartListener = (event) => {
    if (event?.type === 'started' && String(event.chatId || '') === childChatId) starts += 1;
    previous?.(event);
  };
  setMockChatRunListener((event) => currentStartListener?.(event));
  return { count: () => starts };
}

/** @type {((event: object) => void) | null} */
let currentStartListener = null;

/**
 * @param {() => unknown} check
 * @param {{ timeout?: number, interval?: number }} [options]
 */
async function waitFor(check, options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 3000;
  const interval = Number.isFinite(options.interval) ? options.interval : 5;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

const reset = () => {
  currentStartListener = null;
  for (const chatId of listMockChatRunChatIds()) {
    const row = findDelegationByChildChatId(chatId);
    if (row && !isTerminalDelegationStatus(row.status)) {
      finishDelegation(row, { status: 'completed', report: 'TASK: implement\nVERDICT: PASS' });
    }
    const latest = row ? getDelegationById(row.id) : null;
    if (latest) releaseDelegationRunSlot(latest);
    patchMockChatRun(chatId, { busy: false, waitingForInput: false });
  }
  setMockChatRunFailStart(0);
  clearHarnessStartupFailureLockout({
    harness: HARNESS,
    model: MODEL,
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: ISOLATED_DATA_DIR,
  });
  // `` clears every row for the harness, including the global (empty-model)
  // auth/quota rows a failed case may have left behind.
  clearHarnessUsageLimit(HARNESS, '', ISOLATED_DATA_DIR);
  delete process.env.CRETLI_STARTUP_FAILURE_RETRIES;
  delete process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS;
};

const setup = (model = MODEL) => {
  registerMockChatRunAdapter(HARNESS);
  const parent = addChat(crypto.randomUUID(), 'Parent', null, ISOLATED_DATA_DIR, model, {
    agentTransport: HARNESS, sdkMode: 'agent',
  });
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    dataDir: ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = RETRY_DELAY_MS;
  const start = (key) => service.createAndStart({
    parentChatId: parent.id, sourceKind: 'text', taskText: 'Do the work.',
    assignment: 'implement', executionMode: 'agent',
    executor: { transport: HARNESS, model },
    idempotencyKey: key,
  });
  return { start, service, parent };
};

/**
 * Drive the async run-bridge path: the accepted run reports a terminal error
 * (first-event timeout after accept), which is what `finishDelegation` sees.
 *
 * @param {{ id: string, childChatId: string, attemptId: string }} delegation
 * @returns {Promise<void>}
 */
async function finishFromRunBridge(delegation, error = FIRST_EVENT_TIMEOUT) {
  patchMockChatRun(delegation.childChatId, { busy: false, waitingForInput: false });
  const room = {
    chatId: delegation.childChatId,
    delegationId: delegation.id,
    delegationAttemptId: delegation.attemptId,
    delegationAssignment: 'implement',
    serverHold: true,
    _currentRunAssistantText: '',
  };
  await noteDelegationRoomEvent(room, {
    type: 'sdkRunFinished',
    status: 'error',
    lastErrorMessage: error,
    lastErrorCode: 'adapter_timeout',
  });
}

test('resolveStartupRetryCount defaults to 1 and clamps to 0..3', () => {
  reset();
  assert.equal(resolveStartupRetryCount(), 1);
  process.env.CRETLI_STARTUP_FAILURE_RETRIES = '9';
  assert.equal(resolveStartupRetryCount(), 3);
  process.env.CRETLI_STARTUP_FAILURE_RETRIES = '0';
  assert.equal(resolveStartupRetryCount(), 0);
  reset();
});

test('settings startupFailureRetries / startupFailureRetryDelayMs win over env and are clamped', () => {
  reset();
  const prev = loadSettings();
  try {
    process.env.CRETLI_STARTUP_FAILURE_RETRIES = '2';
    process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = '3000';
    saveSettings({ ...prev, startupFailureRetries: 3, startupFailureRetryDelayMs: 500 });
    assert.equal(resolveStartupRetryCount(), 3);
    assert.equal(resolveStartupRetryDelayMs(), 500);
    saveSettings({ ...prev, startupFailureRetries: 99, startupFailureRetryDelayMs: 99999 });
    assert.equal(resolveStartupRetryCount(), 3);
    assert.equal(resolveStartupRetryDelayMs(), 10000);
    saveSettings({ ...prev, startupFailureRetries: 0 });
    assert.equal(resolveStartupRetryCount(), 0);
    saveSettings({ ...prev });
    assert.equal(resolveStartupRetryCount(), 2, 'env applies when settings has no key');
  } finally {
    saveSettings(prev);
    reset();
  }
});

test('resolveStartupRetryDelayMs defaults to 2s and clamps to 0..10s', () => {
  reset();
  assert.equal(resolveStartupRetryDelayMs(), 2000);
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = '0';
  assert.equal(resolveStartupRetryDelayMs(), 0);
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = '99999';
  assert.equal(resolveStartupRetryDelayMs(), 10000);
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = 'not-a-number';
  assert.equal(resolveStartupRetryDelayMs(), 2000);
  reset();
});

test('a synchronous transient accept failure is retried and leaves no lockout', async () => {
  reset();
  const { start } = setup();
  setMockChatRunFailStart(1, TRANSIENT);
  const before = getMockChatRunStartCount();
  const result = await start('retry-ok');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 202);
  assert.equal(result.delegation.status, 'starting');
  assert.equal(result.delegation.startupRetry?.used, 1);
  const running = await waitFor(() => {
    const row = getDelegationById(result.delegation.id);
    return row?.status === 'running' ? row : null;
  });
  assert.equal(getMockChatRunStartCount() - before, 1, 'only the retry reaches a started run');
  assert.equal(running.startupRetry?.used, 1, 'the running transition preserves the retry budget');
  assert.equal(startupLockouts().length, 0);
  assert.equal(limitFor(), null);
  reset();
});

test('a *flash* named model is retried the same way', async () => {
  reset();
  const { start } = setup('opencode/flash-fast');
  setMockChatRunFailStart(1, TRANSIENT);
  const result = await start('retry-flash');
  assert.equal(result.status, 202, JSON.stringify(result));
  assert.equal(result.delegation.status, 'starting');
  const running = await waitFor(() => {
    const row = getDelegationById(result.delegation.id);
    return row?.status === 'running' ? row : null;
  });
  assert.equal(running.executor.model, 'opencode/flash-fast');
  assert.equal(startupLockouts().length, 0);
  reset();
});

test('a first-event timeout after accept is retried on the async bridge path', async () => {
  reset();
  const { start } = setup();
  const created = await start('retry-async');
  assert.equal(created.delegation.status, 'running');
  const firstAttempt = created.delegation.attemptId;
  assert.equal(String(firstAttempt || '').length > 0, true);
  const before = getMockChatRunStartCount();
  await finishFromRunBridge(created.delegation);
  const regressed = getDelegationById(created.delegation.id);
  assert.equal(regressed.status, 'starting', 'the job stays non-terminal between attempts');
  assert.notEqual(regressed.attemptId, firstAttempt, 'the retry uses a fresh attemptId');
  assert.equal(regressed.startupRetry?.used, 1);
  const running = await waitFor(() => {
    const row = getDelegationById(created.delegation.id);
    return row?.status === 'running' ? row : null;
  });
  assert.notEqual(running.attemptId, firstAttempt);
  assert.equal(getMockChatRunStartCount() - before, 1, 'exactly one retry run is started');
  assert.equal(startupLockouts().length, 0, 'a successful retry writes no lockout row');
  reset();
});

test('repeated async first-event timeouts exhaust the default budget and record exactly one lockout', async () => {
  reset();
  const { start } = setup();
  const created = await start('retry-async-exhausted');
  assert.equal(created.delegation.status, 'running');
  const starts = trackStartsForChat(created.delegation.childChatId);
  // Default budget is 1 retry, so the second first-event timeout on the
  // retried attempt must fall through to the terminal path: the budget was
  // preserved across the `running` transition of the retry attempt.
  await finishFromRunBridge(created.delegation);
  const regressed = getDelegationById(created.delegation.id);
  assert.equal(regressed.status, 'starting', 'the retry attempt is scheduled');
  assert.equal(regressed.startupRetry?.used, 1, 'one retry is spent');
  const retried = await waitFor(() => {
    const row = getDelegationById(created.delegation.id);
    return row?.status === 'running' ? row : null;
  });
  assert.equal(retried.startupRetry?.used, 1, 'the running transition does NOT reset the budget');
  await finishFromRunBridge(retried);
  const failed = await waitFor(() => {
    const row = getDelegationById(created.delegation.id);
    return row && isTerminalDelegationStatus(row.status) ? row : null;
  });
  assert.equal(failed.status, 'failed', 'budget exhaustion produces a terminal failure');
  assert.equal(failed.attemptId, retried.attemptId, 'no third attempt is scheduled');
  assert.equal(starts.count(), 1, 'exactly one retry run was started for this chat');
  assert.equal(startupLockouts().length, 1, 'exactly one lockout after budget exhaustion');
  reset();
});

test('the first executor-output event clears the retry budget, a local user echo does not', async () => {
  reset();
  const { start } = setup();
  const created = await start('retry-first-event-clears');
  assert.equal(created.delegation.status, 'running');
  const fresh = getDelegationById(created.delegation.id);
  assert.equal(fresh.startupRetry, null);
  const room = (event) => ({
    chatId: created.delegation.childChatId,
    delegationId: created.delegation.id,
    delegationAttemptId: created.delegation.attemptId,
    delegationAssignment: 'implement',
    serverHold: true,
    _currentRunAssistantText: '',
    ...(event ? {} : {}),
  });
  updateDelegationRecord(created.delegation.id, {
    startupRetry: { used: 1, lastError: TRANSIENT, scheduledAt: new Date().toISOString() },
  });
  // A local user echo is the prompt itself, not executor output: it must NOT
  // clear the budget (the first-event timeout is still pending).
  await noteDelegationRoomEvent(room(), {
    type: 'sdkEvent',
    runId: created.delegation.runId,
    event: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the work' }] } },
  });
  assert.equal(getDelegationById(created.delegation.id).startupRetry?.used, 1, 'a user echo keeps the budget');
  // The authoritative signal: the first executor-output event clears it, so a
  // later failure of this attempt can never be retried as a startup failure of
  // the same startup phase.
  await noteDelegationRoomEvent(room(), {
    type: 'sdkEvent',
    runId: created.delegation.runId,
    event: { type: 'assistant', streamTextMode: 'snapshot', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
  });
  const afterEvent = getDelegationById(created.delegation.id);
  assert.equal(afterEvent.startupRetry, null, 'a confirmed first event clears the budget');
  // A later non-startup failure of the same run finishes terminally with no
  // retry scheduled and no startup lockout.
  await finishFromRunBridge(afterEvent, 'Executor crashed after the first event');
  const failed = await waitFor(() => {
    const row = getDelegationById(created.delegation.id);
    return row && isTerminalDelegationStatus(row.status) ? row : null;
  });
  assert.equal(failed.status, 'failed');
  assert.equal(Boolean(failed.startupRetry), false);
  assert.equal(startupLockouts().length, 0, 'a post-first-event failure records no startup lockout');
  reset();
});

test('every attempt failing records exactly one startup_failure lockout', async () => {
  reset();
  process.env.CRETLI_STARTUP_FAILURE_RETRIES = '2';
  const { start } = setup();
  setMockChatRunFailStart(3, TRANSIENT);
  const before = getMockChatRunStartCount();
  const result = await start('retry-exhausted');
  assert.equal(result.status, 202);
  const failed = await waitFor(() => {
    const row = getDelegationById(result.delegation.id);
    return row && isTerminalDelegationStatus(row.status) ? row : null;
  });
  assert.equal(failed.status, 'failed');
  assert.equal(startupLockouts().length, 1, 'exactly one lockout after the last attempt');
  assert.equal(getMockChatRunStartCount(), before, 'no attempt ever started successfully');
  reset();
});

test('retry count 0 keeps the immediate lockout', async () => {
  reset();
  process.env.CRETLI_STARTUP_FAILURE_RETRIES = '0';
  const { start } = setup();
  setMockChatRunFailStart(1, TRANSIENT);
  const result = await start('retry-off');
  assert.equal(result.ok, false);
  assert.equal(result.delegation.status, 'failed');
  assert.equal(startupLockouts().length, 1);
  reset();
});

test('a non-startup failure is never retried', async () => {
  reset();
  const { start } = setup();
  setMockChatRunFailStart(1, 'executor would not start');
  const before = getMockChatRunStartCount();
  const result = await start('retry-non-startup');
  assert.equal(result.ok, false);
  assert.equal(getMockChatRunStartCount(), before);
  assert.equal(startupLockouts().length, 0);
  reset();
});

test('quota, auth and model-unavailable failures keep their exclusions and are not retried', async () => {
  reset();
  for (const [key, message] of [
    ['retry-quota', "You've hit your usage limit; resets at 2099-01-02 03:04:05"],
    ['retry-auth', 'Unauthorized: invalid API key'],
    ['retry-model', 'model_not_found'],
  ]) {
    // The previous iteration's lockout is preserved by design; clear every row
    // for the harness (including the global empty-model auth/model rows) so the
    // next case starts from a neutral admission state.
    clearHarnessStartupFailureLockout({
      harness: HARNESS,
      model: MODEL,
      dataDir: ISOLATED_DATA_DIR,
      workspaceFolder: ISOLATED_DATA_DIR,
    });
    clearHarnessUsageLimit(HARNESS, '', ISOLATED_DATA_DIR);
    const { start } = setup();
    const before = getMockChatRunStartCount();
    setMockChatRunFailStart(1, message);
    const result = await start(key);
    assert.equal(result.ok, false, message);
    assert.equal(result.delegation.status, 'failed', message);
    assert.equal(getMockChatRunStartCount(), before, `no retry for: ${message}`);
    setMockChatRunFailStart(0);
  }
  reset();
});

test('an explicit run deadline blocks the retry and records one lockout', async () => {
  reset();
  const { start } = setup();
  const created = await start('retry-deadline');
  assert.equal(created.delegation.status, 'running');
  const firstAttempt = created.delegation.attemptId;
  updateDelegationRecord(created.delegation.id, {
    runDeadlineAt: new Date(Date.now() - 1000).toISOString(),
  });
  await finishFromRunBridge(created.delegation);
  const failed = getDelegationById(created.delegation.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attemptId, firstAttempt, 'no fresh attempt is scheduled past the deadline');
  assert.equal(Boolean(failed.startupRetry), false);
  assert.equal(startupLockouts().length, 1);
  reset();
});

test('cancel during the retry delay stops the job without starting a new run', async () => {
  reset();
  const { start, service } = setup();
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = '150';
  const created = await start('retry-cancel');
  assert.equal(created.delegation.status, 'running');
  await finishFromRunBridge(created.delegation);
  const regressed = getDelegationById(created.delegation.id);
  assert.equal(regressed.status, 'starting');
  const retryAttempt = regressed.attemptId;
  const cancelResult = await service.cancel(created.delegation.id);
  assert.equal(cancelResult.ok, true, JSON.stringify(cancelResult));
  await sleep(250);
  const after = getDelegationById(created.delegation.id);
  assert.equal(isTerminalDelegationStatus(after.status), true, `expected terminal, got ${after.status}`);
  assert.equal(after.attemptId, retryAttempt, 'the cancelled job keeps its attempt; no retry run started');
  assert.equal(String(after.runId || ''), '', 'the cancelled retry never bound a run');
  reset();
});

test('a confirmed successful execution clears an existing startup cooldown', async () => {
  reset();
  const { start } = setup();
  const created = await start('retry-clear-cooldown');
  assert.equal(created.delegation.status, 'running');
  noteHarnessStartupFailureLockout({
    harness: HARNESS,
    model: MODEL,
    dataDir: ISOLATED_DATA_DIR,
    workspaceFolder: ISOLATED_DATA_DIR,
  });
  assert.equal(limitFor()?.code, 'startup_failure');
  const running = getDelegationById(created.delegation.id);
  const finished = finishDelegation(running, {
    status: 'completed',
    report: 'TASK: implement\nVERDICT: PASS',
    attemptId: running.attemptId,
  });
  assert.equal(finished.status, 'completed');
  assert.equal(limitFor(), null, 'confirmed success clears the transient cooldown');
  reset();
});

test('boot reconcile interrupts a startup retry row waiting out its delay (no retry, no lockout)', async () => {
  reset();
  const { start } = setup();
  process.env.CRETLI_STARTUP_FAILURE_RETRY_DELAY_MS = '150';
  const created = await start('retry-restart');
  await finishFromRunBridge(created.delegation);
  const waiting = getDelegationById(created.delegation.id);
  assert.equal(waiting.status, 'starting');
  assert.ok(waiting.startupRetry);
  assert.equal(String(waiting.runId || ''), '');
  // The failed attempt's in-process room must not survive the simulated restart.
  // Drop every mock chat run so the boot probe sees the intended unknown-liveness
  // state (`state_missing`) rather than a known-idle leftover room: with a live
  // room the generic known-idle starting branch would also interrupt, so the test
  // would not pin the retry-specific boot path.
  resetMockChatRuns();
  const live = probeChatRunLiveness({ chatId: waiting.childChatId, runId: waiting.runId });
  assert.equal(live.known, false, 'no live adapter state after the simulated restart');
  assert.equal(live.reason, 'state_missing', 'boot reconciles from an unknown-liveness probe');
  const starts = trackStartsForChat(created.delegation.childChatId);
  await reconcileDelegationsOnBoot();
  const after = getDelegationById(created.delegation.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'server_restart');
  assert.equal(inspectDelegationSlot(after).occupied, false, 'slot released');
  await sleep(300);
  assert.equal(getDelegationById(created.delegation.id).status, 'interrupted', 'stale timer must not resume');
  assert.equal(starts.count(), 0, 'no retry run started');
  assert.equal(startupLockouts().length, 0);
  assert.equal(limitFor(), null);
  reset();
});
