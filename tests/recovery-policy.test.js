import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_RESTART_RECOVERY_MODES,
  DEFAULT_CHAT_RESTART_RECOVERY_MODE,
  applyChatRestartRecoveryPatch,
  evaluateAutomaticResume,
  getChatRestartRecoverySettings,
  normalizeChatRestartRecoveryMode,
  resolveChatRestartRecoveryMode,
  resumeRunIfAutomatic,
} from '../lib/recovery/recovery-policy.ts';

const run = {
  logicalRunId: 'r1', chatId: 'c1', revision: 3, state: 'interrupted', reason: 'server_restart',
  harness: 'sdk', sessionId: 's1', workspaceFolder: '/w/a', acceptance: { state: 'accepted' },
};
const caps = { canResumeSession: true };

test('default and migration: missing/invalid -> manual', () => {
  assert.equal(normalizeChatRestartRecoveryMode(undefined), 'manual');
  assert.equal(normalizeChatRestartRecoveryMode('AUTO'), 'manual');
  assert.equal(resolveChatRestartRecoveryMode({}, '/w/a'), 'manual');
  assert.equal(resolveChatRestartRecoveryMode(null), 'manual');
});

test('workspace override wins; invalid override is dropped', () => {
  const settings = { chatRestartRecoveryMode: 'off', chatRestartRecoveryWorkspaces: { '/w/a': 'automatic', '/w/b': 'bogus' } };
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'automatic');
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/b'), 'off');
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/c'), 'off');
  assert.deepEqual(getChatRestartRecoverySettings(settings).workspaces, { '/w/a': 'automatic' });
});

test('settings patch validates, sets and clears overrides', () => {
  const settings = {};
  assert.equal(applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryMode: 'nope' }).error !== '', true);
  assert.deepEqual(settings, {});
  assert.equal(applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryMode: 'off' }).changed, true);
  applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: 'automatic' } });
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'automatic');
  applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: null } });
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'off');
  assert.notEqual(applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryWorkspace: { mode: 'off' } }).error, '');
  assert.notEqual(applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryWorkspace: { workspaceFolder: '/x', mode: 'zz' } }).error, '');
});

test('mode validation rejects coercible values and preserves settings', () => {
  const settings = { chatRestartRecoveryMode: 'automatic', chatRestartRecoveryWorkspaces: { '/w/a': 'off' } };
  for (const value of [[], {}, ['automatic'], { toString: () => 'automatic' }]) {
    const result = applyChatRestartRecoveryPatch(settings, { chatRestartRecoveryMode: value });
    assert.notEqual(result.error, '');
    assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'off');
  }
  const missing = applyChatRestartRecoveryPatch(settings, {});
  assert.equal(missing.changed, false);
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'off');
  const invalidWorkspace = applyChatRestartRecoveryPatch(settings, {
    chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: ['automatic'] },
  });
  assert.notEqual(invalidWorkspace.error, '');
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'off');
  const omittedWorkspaceMode = applyChatRestartRecoveryPatch(settings, {
    chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a' },
  });
  assert.notEqual(omittedWorkspaceMode.error, '');
  assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'off');
});

test('automatic gate: only confirmed, supported, with context', () => {
  const ok = { mode: 'automatic', run, liveness: 'dead', capabilities: caps, adapterValidated: true };
  assert.equal(evaluateAutomaticResume(ok).allowed, true);
  for (const mode of ['off', 'manual', 'bogus']) assert.equal(evaluateAutomaticResume({ ...ok, mode }).allowed, false);
  assert.equal(evaluateAutomaticResume({ ...ok, run: { ...run, state: 'unknown' } }).reason, 'not_confirmed_interrupted');
  assert.equal(evaluateAutomaticResume({ ...ok, run: { ...run, acceptance: { state: 'unconfirmed' } } }).reason, 'no_acceptance_proof');
  assert.equal(evaluateAutomaticResume({ ...ok, run: { ...run, reason: 'unknown' } }).reason, 'reason_not_recoverable');
  assert.equal(evaluateAutomaticResume({ ...ok, liveness: 'unknown' }).reason, 'liveness_not_confirmed_dead');
  assert.equal(evaluateAutomaticResume({ ...ok, liveness: 'alive' }).allowed, false);
  assert.equal(evaluateAutomaticResume({ ...ok, capabilities: {} }).reason, 'adapter_unsupported');
  assert.equal(evaluateAutomaticResume({ ...ok, adapterValidated: false }).reason, 'adapter_not_validated');
  assert.equal(evaluateAutomaticResume({ ...ok, adapterValidated: undefined }).reason, 'adapter_not_validated');
  assert.equal(evaluateAutomaticResume({ ...ok, run: { ...run, sessionId: '' } }).reason, 'context_unavailable');
  assert.equal(evaluateAutomaticResume({ ...ok, run: null }).reason, 'run_missing');
});

test('resumeRunIfAutomatic delegates with actor automatic, never confirmUnknown', async () => {
  const calls = [];
  const resumeService = { resumeRun: async (input) => { calls.push(input); return { status: 'resumed' }; } };
  const base = { run, resumeService, probeLiveness: () => 'dead', getCapabilities: () => caps, isAdapterValidated: () => true };
  const manual = await resumeRunIfAutomatic({ ...base, settings: {} });
  assert.deepEqual([manual.attempted, manual.reason, calls.length], [false, 'mode_manual', 0]);
  const settings = { chatRestartRecoveryWorkspaces: { '/w/a': 'automatic' } };
  const auto = await resumeRunIfAutomatic({ ...base, settings });
  assert.equal(auto.attempted, true);
  assert.equal(calls[0].actor, 'automatic');
  assert.equal(calls[0].confirmUnknown, false);
  assert.equal(calls[0].expectedRevision, 3);
  const dup = await resumeRunIfAutomatic({ ...base, settings });
  assert.equal(dup.outcome.status, 'resumed');
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey);
});

test('rollout defaults: the policy is manual, automatic is opt-in and never the fallback', async () => {
  assert.equal(DEFAULT_CHAT_RESTART_RECOVERY_MODE, 'manual');
  assert.deepEqual([...CHAT_RESTART_RECOVERY_MODES], ['off', 'manual', 'automatic']);
  // No settings, empty settings, garbage and a mistyped override all resolve to manual.
  for (const settings of [undefined, null, {}, { chatRestartRecoveryMode: 'auto' }, { chatRestartRecoveryWorkspaces: { '/w/a': 'yes' } }, { chatRestartRecoveryMode: true }]) {
    assert.equal(resolveChatRestartRecoveryMode(settings, '/w/a'), 'manual');
  }
  assert.deepEqual(getChatRestartRecoverySettings({}), { mode: 'manual', workspaces: {} });
  // Only an explicit, exact `automatic` opts in.
  assert.equal(resolveChatRestartRecoveryMode({ chatRestartRecoveryMode: 'automatic' }), 'automatic');
  // Under the default mode even a perfectly confirmed run is never resumed automatically.
  const ok = { run, liveness: 'dead', capabilities: caps };
  assert.deepEqual(evaluateAutomaticResume({ ...ok, mode: resolveChatRestartRecoveryMode({}, '/w/a') }), { allowed: false, reason: 'mode_manual' });
  const calls = [];
  const outcome = await resumeRunIfAutomatic({
    run, settings: {}, probeLiveness: () => 'dead', getCapabilities: () => caps,
    resumeService: { resumeRun: async (input) => { calls.push(input); return { status: 'resumed' }; } },
  });
  assert.equal(outcome.attempted, false);
  assert.equal(calls.length, 0);
});

test('automatic needs a validated adapter even when the policy is automatic', async () => {
  const calls = [];
  const resumeService = { resumeRun: async (input) => { calls.push(input); return { status: 'resumed' }; } };
  const settings = { chatRestartRecoveryMode: 'automatic' };
  const base = { run, settings, resumeService, probeLiveness: () => 'dead', getCapabilities: () => caps };
  for (const isAdapterValidated of [undefined, () => false, () => 'yes']) {
    const out = await resumeRunIfAutomatic({ ...base, isAdapterValidated });
    assert.deepEqual([out.attempted, out.reason], [false, 'adapter_not_validated']);
  }
  assert.equal(calls.length, 0);
});
