import assert from 'node:assert/strict';
import {
  canStartServerRestart,
  evaluateRestartHealth,
  isServerRestartPhaseActive,
  isServerRestartTimedOut,
  shouldSuppressDisconnectUi,
} from '../app_front/app/serverRestartState.js';

assert.equal(isServerRestartPhaseActive('requesting'), true);
assert.equal(isServerRestartPhaseActive('waiting'), true);
assert.equal(isServerRestartPhaseActive('recovering'), true);
assert.equal(isServerRestartPhaseActive('ready'), false);
assert.equal(isServerRestartPhaseActive(undefined), false);

assert.equal(canStartServerRestart(undefined), true);
assert.equal(canStartServerRestart('requesting'), false);
assert.equal(canStartServerRestart('waiting'), false);
assert.equal(canStartServerRestart('recovering'), false);
assert.equal(canStartServerRestart('ready'), true);

assert.equal(isServerRestartTimedOut({
  startedAt: 1_000,
  now: 90_999,
  timeoutMs: 90_000,
}), false);
assert.equal(isServerRestartTimedOut({
  startedAt: 1_000,
  now: 91_001,
  timeoutMs: 90_000,
}), true);

assert.equal(shouldSuppressDisconnectUi({
  phase: 'waiting',
  suppressUntil: 0,
  now: 10_000,
}), true);
assert.equal(shouldSuppressDisconnectUi({
  phase: undefined,
  suppressUntil: 11_000,
  now: 10_000,
}), true);
assert.equal(shouldSuppressDisconnectUi({
  phase: undefined,
  suppressUntil: 9_000,
  now: 10_000,
}), false);

const oldInstance = evaluateRestartHealth({
  health: { ok: true, serverInstanceToken: 'old-token' },
  previousToken: 'old-token',
});
assert.deepEqual(oldInstance, {
  status: 'waiting',
  stableToken: '',
  stableProbeCount: 0,
});

const firstNewProbe = evaluateRestartHealth({
  health: { ok: true, serverInstanceToken: 'new-token' },
  previousToken: 'old-token',
});
assert.deepEqual(firstNewProbe, {
  status: 'stabilizing',
  stableToken: 'new-token',
  stableProbeCount: 1,
});

const secondNewProbe = evaluateRestartHealth({
  health: { ok: true, serverInstanceToken: 'new-token' },
  previousToken: 'old-token',
  stableToken: firstNewProbe.stableToken,
  stableProbeCount: firstNewProbe.stableProbeCount,
});
assert.deepEqual(secondNewProbe, {
  status: 'ready',
  stableToken: 'new-token',
  stableProbeCount: 2,
});

const changedCandidate = evaluateRestartHealth({
  health: { ok: true, serverInstanceToken: 'another-token' },
  previousToken: 'old-token',
  stableToken: 'new-token',
  stableProbeCount: 1,
});
assert.deepEqual(changedCandidate, {
  status: 'stabilizing',
  stableToken: 'another-token',
  stableProbeCount: 1,
});

console.log('All server-restart-state tests passed.');
