import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  buildAutoContextCompressionAttemptKey,
  evaluateAutoContextCompressionGate,
} from '../lib/context-compression.js';
import {
  applyClaudeMeasuredContextUsage,
  buildChatContextSnapshot,
  resetChatContextMeterState,
  shouldRefreshContextUsageStamp,
  stampContextUsageEpoch,
} from '../app_front/features/chat/chatContextMeter.js';

const NOW = 1_800_000_000_000;
const base = {
  provenance: 'measured',
  isEstimated: false,
  inputTokens: 170000,
  fillPercent: 85,
  contextWindowTokens: 200000,
  updatedAt: NOW - 1000,
  measurementEpoch: 2,
  currentEpoch: 2,
};
const gate = (patch, options = {}) =>
  evaluateAutoContextCompressionGate({ ...base, ...patch }, { thresholdPercent: 80, now: NOW, ...options });

// exact/current measurement above threshold may schedule
assert.deepEqual(gate({}), { allowed: true, reason: 'threshold_reached' });
assert.equal(gate({ fillPercent: 79 }).allowed, false);
assert.equal(gate({ fillPercent: 79 }).reason, 'below_threshold');

// uncertain readings must not schedule
assert.equal(gate({ provenance: 'estimated', isEstimated: true }).reason, 'estimated');
assert.equal(gate({ provenance: 'none', inputTokens: null, fillPercent: null }).allowed, false);
assert.equal(gate({ updatedAt: NOW - 31 * 60 * 1000 }).reason, 'stale');
assert.equal(gate({ updatedAt: null }).reason, 'stale');
assert.equal(gate({ measurementEpoch: 1 }).reason, 'epoch_mismatch');
assert.equal(gate({ measurementEpoch: null }).reason, 'epoch_mismatch');
assert.equal(gate({ contextWindowTokens: null }).reason, 'unknown_window');
assert.equal(gate({ contextWindowTokens: 0 }).reason, 'unknown_window');
assert.equal(evaluateAutoContextCompressionGate(null).allowed, false);

// explicit zero usage and missing usage are distinguished, neither schedules
assert.equal(gate({ inputTokens: 0, fillPercent: 0 }).reason, 'zero_usage');
assert.equal(gate({ inputTokens: null }).reason, 'no_usage');
assert.equal(gate({ inputTokens: undefined }).reason, 'no_usage');

// real snapshot: transcript-length estimate never passes, even above threshold
const estimatedChat = {
  agentTransport: 'claude',
  model: 'claude-sonnet-4-5',
  _contextMeasuredWindowTokens: 1000,
  _buffer: 'x'.repeat(8000),
};
const estimatedSnap = buildChatContextSnapshot(estimatedChat, 'claude-sonnet-4-5');
assert.equal(estimatedSnap.isEstimated, true);
assert.ok(estimatedSnap.fillPercent >= 95);
assert.equal(
  evaluateAutoContextCompressionGate({ ...estimatedSnap, currentEpoch: estimatedSnap.contextMeterEpoch }, { now: NOW }).allowed,
  false,
);

// real snapshot: measured Claude usage passes, then a reset (new epoch) blocks it
const chat = { agentTransport: 'claude', model: 'claude-sonnet-4-5' };
applyClaudeMeasuredContextUsage(chat, { totalTokens: 190000 }, 'claude-sonnet-4-5', 200000);
let snap = buildChatContextSnapshot(chat, 'claude-sonnet-4-5');
let verdict = evaluateAutoContextCompressionGate(
  { ...snap, currentEpoch: snap.contextMeterEpoch },
  { thresholdPercent: 80, now: snap.updatedAt + 1000 },
);
assert.equal(verdict.allowed, true);
const staleKey = buildAutoContextCompressionAttemptKey(snap);

// recovery: reset clears the measurement; a late snapshot from the old epoch is rejected
const oldEpochSnap = { ...snap, currentEpoch: 1 };
assert.equal(
  evaluateAutoContextCompressionGate(oldEpochSnap, { thresholdPercent: 80, now: snap.updatedAt + 1000 }).reason,
  'epoch_mismatch',
);
resetChatContextMeterState(chat, { reason: 'sdk_reset', markFreshSession: true });
snap = buildChatContextSnapshot(chat, 'claude-sonnet-4-5');
verdict = evaluateAutoContextCompressionGate({ ...snap, currentEpoch: snap.contextMeterEpoch }, { now: NOW });
assert.equal(verdict.allowed, false);

// after reset a fresh measurement carries the new epoch and is allowed again
applyClaudeMeasuredContextUsage(chat, { totalTokens: 190000 }, 'claude-sonnet-4-5', 200000);
snap = buildChatContextSnapshot(chat, 'claude-sonnet-4-5');
assert.equal(snap.measurementEpoch, snap.contextMeterEpoch);
assert.equal(
  evaluateAutoContextCompressionGate({ ...snap, currentEpoch: snap.contextMeterEpoch }, { now: snap.updatedAt + 1000 }).allowed,
  true,
);

// no re-trigger: the attempt key is stable for one reading and changes with a new one
assert.equal(buildAutoContextCompressionAttemptKey(snap), buildAutoContextCompressionAttemptKey({ ...snap }));
assert.notEqual(buildAutoContextCompressionAttemptKey(snap), staleKey);
assert.notEqual(
  buildAutoContextCompressionAttemptKey(snap),
  buildAutoContextCompressionAttemptKey({ ...snap, inputTokens: snap.inputTokens + 1 }),
);

// diag poll simulation (mirrors applyServerContextUsageFromDiag's stamping)
const poll = (c, tokens, at) => {
  const refresh = shouldRefreshContextUsageStamp(c, tokens);
  c._contextUsageInputTokens = tokens;
  if (refresh) {
    c._contextUsageUpdatedAt = at;
    stampContextUsageEpoch(c);
  }
};
const diagChat = { agentTransport: 'sdk', _contextMeterEpoch: 3 };
poll(diagChat, 170000, NOW - 40 * 60 * 1000);
const firstStamp = diagChat._contextUsageUpdatedAt;
const diagSnap = () => ({
  ...base,
  inputTokens: diagChat._contextUsageInputTokens,
  updatedAt: diagChat._contextUsageUpdatedAt,
  measurementEpoch: diagChat._contextUsageEpoch,
  currentEpoch: 3,
});
const keyBefore = buildAutoContextCompressionAttemptKey(diagSnap());
// (1) unchanged re-polls keep updatedAt, epoch and attempt key
for (let i = 1; i <= 5; i += 1) poll(diagChat, 170000, NOW + i * 2000);
assert.equal(diagChat._contextUsageUpdatedAt, firstStamp);
assert.equal(diagChat._contextUsageEpoch, 3);
assert.equal(buildAutoContextCompressionAttemptKey(diagSnap()), keyBefore);
// (3) the old measurement re-polled unchanged is still stale
assert.equal(evaluateAutoContextCompressionGate(diagSnap(), { thresholdPercent: 80, now: NOW }).reason, 'stale');
// (2) a changed measurement refreshes the stamp and produces a new key
poll(diagChat, 180000, NOW - 1000);
assert.equal(diagChat._contextUsageUpdatedAt, NOW - 1000);
assert.notEqual(buildAutoContextCompressionAttemptKey(diagSnap()), keyBefore);
assert.equal(evaluateAutoContextCompressionGate(diagSnap(), { thresholdPercent: 80, now: NOW }).allowed, true);
// helper: missing stamp refreshes; null -> value and value -> null count as changes
assert.equal(shouldRefreshContextUsageStamp({}, 5), true);
assert.equal(shouldRefreshContextUsageStamp(diagChat, 180000), false);
assert.equal(shouldRefreshContextUsageStamp(diagChat, null), true);

console.log('auto-context-compression-gate.test.js: ok');


// boundary: auto reset only with no run, no queued/in-flight message, same epoch
{
  const { evaluateAutoContextCompressionBoundary: boundary } = await import('../lib/context-compression.js');
  const clear = { serverBusy: false, queuedCount: 0, optimisticPending: 0, resetPending: false, scheduledEpoch: 2, currentEpoch: 2 };
  assert.deepEqual(boundary(clear), { ok: true, reason: 'boundary_clear' });
  assert.equal(boundary({ ...clear, serverBusy: true }).reason, 'run_active');
  assert.equal(boundary({ ...clear, serverBusy: undefined }).reason, 'run_active'); // unknown busy state is not safe
  assert.equal(boundary({ ...clear, queuedCount: 1 }).reason, 'queued_message');
  assert.equal(boundary({ ...clear, optimisticPending: 1 }).reason, 'message_in_flight'); // concurrent new message
  assert.equal(boundary({ ...clear, resetPending: true }).reason, 'reset_pending'); // re-trigger while resetting
  assert.equal(boundary({ ...clear, currentEpoch: 3 }).reason, 'epoch_changed'); // reset happened meanwhile
  assert.equal(boundary(null).ok, false);
}

// reset failure must not alter the old session or history (createFreshSdkContextEntry is pure)
{
  const { createFreshSdkContextEntry } = await import('../lib/persist/chats-persist.js');
  const old = { id: 'c1', cursorSessionId: 's-old', sdkAgentId: 'a1' };
  const next = createFreshSdkContextEntry(old, 's-new');
  assert.equal(old.cursorSessionId, 's-old');
  assert.equal(old.sdkAgentId, 'a1');
  assert.equal(next.cursorSessionId, 's-new');
  assert.equal(next.id, 'c1');
  assert.equal('sdkAgentId' in next, false);
}
console.log('auto-context-compression boundary tests ok');
