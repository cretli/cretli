import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DELEGATION_INTERRUPT_CODES, DELEGATION_TASK_OUTCOMES } from '../lib/delegation-status.js';
import {
  RECOVERY_ACCOUNTING_RULES,
  RECOVERY_BACKOFF_BASE_MS,
  RECOVERY_BACKOFF_CAP_MS,
  RECOVERY_CONTRACT_REVISION,
  RECOVERY_DEFERRED_ADAPTERS,
  RECOVERY_DEFERRED_ADAPTER_REASONS,
  RECOVERY_EVENT_KINDS,
  RECOVERY_MVP_ADAPTERS,
  RECOVERY_SCHEMA_VERSION,
  RUN_ACTIVE_STATES,
  RUN_AGENT_OUTCOMES,
  RUN_AGENT_VERDICTS,
  RUN_FAMILY_OWNERS,
  RUN_INDETERMINATE_STATES,
  RUN_INFRA_OUTCOMES,
  RUN_INTERRUPT_REASONS,
  RUN_LIFECYCLE_STATES,
  RUN_LIVENESS_STATES,
  RUN_RECOVERABLE_STATES,
  RUN_RECOVERY_DECISIONS,
  RUN_RECOVERY_DECISION_BY_REASON,
  RUN_TERMINAL_STATES,
  assertSingleRunFamilyOwner,
  canTransitionRunLifecycle,
  computeRecoveryBackoffMs,
  isActiveRunLifecycle,
  isIndeterminateRunLifecycle,
  isRecoverableRunInterruptReason,
  isRecoverableRunLifecycle,
  isTerminalRunLifecycle,
  nextRecoveryAccounting,
  normalizeRunAgentOutcome,
  normalizeRunAgentVerdict,
  normalizeRunInfraOutcome,
  normalizeRunInterruptReason,
  normalizeRunLifecycleState,
  normalizeRunLiveness,
  normalizeRunTranscriptLossReason,
  RUN_TRANSCRIPT_LOSS_REASONS,
  describeRecoveryAdapterContract,
  ownerOfRunFamily,
  resolveRecoveryAdapter,
  resolveRecoveryDecision,
  resolveRunOutcome,
} from '../lib/recovery/recovery-contract.js';

test('run lifecycle exposes exactly eight states with the required classifications', () => {
  assert.deepEqual([...RUN_LIFECYCLE_STATES], [
    'starting',
    'running',
    'waiting',
    'completed',
    'cancelled',
    'interrupted',
    'unknown',
    'recovering',
  ]);
  assert.deepEqual([...RUN_TERMINAL_STATES], ['completed', 'cancelled', 'interrupted']);
  assert.deepEqual([...RUN_ACTIVE_STATES], ['starting', 'running', 'waiting']);
  assert.deepEqual([...RUN_INDETERMINATE_STATES], ['unknown', 'recovering']);
  assert.deepEqual([...RUN_RECOVERABLE_STATES], ['interrupted', 'unknown']);
  assert.equal(RECOVERY_SCHEMA_VERSION, 1);

  // Every state is classified by at least one axis; no state is invented.
  for (const state of RUN_LIFECYCLE_STATES) {
    const classified =
      isTerminalRunLifecycle(state) ||
      isActiveRunLifecycle(state) ||
      isIndeterminateRunLifecycle(state) ||
      isRecoverableRunLifecycle(state);
    assert.equal(classified, true, `${state} is classified`);
    assert.equal(normalizeRunLifecycleState(state), state);
  }
  assert.equal(isTerminalRunLifecycle('running'), false);
  assert.equal(isActiveRunLifecycle('unknown'), false);
  assert.equal(isIndeterminateRunLifecycle('recovering'), true);
  assert.equal(isRecoverableRunLifecycle('interrupted'), true);
  assert.equal(isRecoverableRunLifecycle('completed'), false);
  assert.equal(normalizeRunLifecycleState('nonsense'), '');
  assert.equal(normalizeRunLifecycleState('  RUNNING '), 'running');
});

test('transition matrix allows recovery edges and forbids resurrection', () => {
  const allowed = {
    '': ['starting'],
    starting: ['running', 'waiting', 'completed', 'cancelled', 'interrupted', 'unknown'],
    running: ['waiting', 'completed', 'cancelled', 'interrupted', 'unknown'],
    waiting: ['running', 'completed', 'cancelled', 'interrupted', 'unknown'],
    interrupted: ['recovering', 'completed', 'cancelled'],
    unknown: ['recovering', 'completed', 'cancelled'],
    recovering: ['starting', 'running', 'waiting', 'completed', 'cancelled', 'interrupted', 'unknown'],
    completed: [],
    cancelled: [],
  };
  const fromStates = ['', ...RUN_LIFECYCLE_STATES];
  for (const from of fromStates) {
    for (const to of RUN_LIFECYCLE_STATES) {
      const expected = from === to || (allowed[from] || []).includes(to);
      assert.equal(
        canTransitionRunLifecycle(from, to),
        expected,
        `${from || '<empty>'} -> ${to}`
      );
    }
  }

  // Explicit acceptance edges from the leaf requirements.
  assert.equal(canTransitionRunLifecycle('', 'starting'), true);
  assert.equal(canTransitionRunLifecycle('interrupted', 'recovering'), true);
  assert.equal(canTransitionRunLifecycle('unknown', 'recovering'), true);
  assert.equal(canTransitionRunLifecycle('completed', 'completed'), true);
  assert.equal(canTransitionRunLifecycle('cancelled', 'cancelled'), true);
  assert.equal(canTransitionRunLifecycle('completed', 'running'), false);
  assert.equal(canTransitionRunLifecycle('cancelled', 'running'), false);
  assert.equal(canTransitionRunLifecycle('unknown', 'starting'), false);
  assert.equal(canTransitionRunLifecycle('starting', 'starting'), true);
  assert.equal(canTransitionRunLifecycle('running', ''), false);
  assert.equal(canTransitionRunLifecycle('running', 'nonsense'), false);

  // Document matrix cell: recovering -> waiting (post-recovery run may wait for input).
  assert.equal(canTransitionRunLifecycle('recovering', 'waiting'), true);
  assert.equal(canTransitionRunLifecycle('recovering', 'running'), true);
  assert.equal(canTransitionRunLifecycle('recovering', 'starting'), true);
});

test('interrupt reasons normalize and stay aligned with the delegation codes', () => {
  assert.deepEqual([...RUN_INTERRUPT_REASONS], [
    'server_restart',
    'starting_timeout',
    'running_orphan',
    'process_gone',
    'unknown',
  ]);
  for (const code of DELEGATION_INTERRUPT_CODES) {
    assert.ok(RUN_INTERRUPT_REASONS.includes(code), `${code} from DELEGATION_INTERRUPT_CODES`);
  }
  assert.equal(normalizeRunInterruptReason('server_restart'), 'server_restart');
  assert.equal(normalizeRunInterruptReason('SERVER_RESTART'), 'server_restart');
  assert.equal(normalizeRunInterruptReason('process_gone'), 'process_gone');
  assert.equal(normalizeRunInterruptReason('garbage'), 'unknown');
  assert.equal(normalizeRunInterruptReason(''), 'unknown');
  assert.equal(normalizeRunInterruptReason(null), 'unknown');

  assert.equal(isRecoverableRunInterruptReason('server_restart'), true);
  assert.equal(isRecoverableRunInterruptReason('process_gone'), true);
  assert.equal(isRecoverableRunInterruptReason('unknown'), false);

  for (const reason of RUN_INTERRUPT_REASONS) {
    const decisions = RUN_RECOVERY_DECISION_BY_REASON[reason];
    assert.ok(Array.isArray(decisions) && decisions.length > 0, `${reason} has decisions`);
    for (const decision of decisions) {
      assert.ok(RUN_RECOVERY_DECISIONS.includes(decision), `${decision} is vocabulary`);
    }
  }
});

test('recovery decisions never auto-reattach a non-alive run', () => {
  const sdk = resolveRecoveryAdapter('sdk');
  const opencode = resolveRecoveryAdapter('opencode');
  assert.deepEqual([...RUN_LIVENESS_STATES], ['alive', 'dead', 'unknown']);
  assert.equal(normalizeRunLiveness('weird'), 'unknown');

  // Missing/unsupported adapter is always unsupported.
  const missing = resolveRecoveryDecision({ reason: 'server_restart', adapter: null, liveness: 'unknown' });
  assert.equal(missing.decision, 'unsupported');
  assert.equal(missing.automatic, false);
  assert.equal(missing.adapter, '');

  const unknownHarness = resolveRecoveryDecision({
    reason: 'server_restart',
    adapter: resolveRecoveryAdapter('nieznany'),
    liveness: 'alive',
  });
  assert.equal(unknownHarness.decision, 'unsupported');

  // Alive + reattach capability is the only automatic decision.
  const aliveOpenCode = resolveRecoveryDecision({ reason: 'server_restart', adapter: opencode, liveness: 'alive' });
  assert.equal(aliveOpenCode.decision, 'reattach');
  assert.equal(aliveOpenCode.automatic, true);
  assert.equal(aliveOpenCode.adapter, 'opencode');
  assert.equal(aliveOpenCode.reason, 'server_restart');

  // Non-alive runs resume a session or fall back to manual; never auto reattach.
  const deadSdk = resolveRecoveryDecision({ reason: 'server_restart', adapter: sdk, liveness: 'dead' });
  assert.equal(deadSdk.decision, 'resume_session');
  assert.equal(deadSdk.automatic, false);
  const unknownLivenessSdk = resolveRecoveryDecision({
    reason: 'server_restart',
    adapter: sdk,
    liveness: 'unknown',
  });
  assert.equal(unknownLivenessSdk.decision, 'resume_session');
  assert.equal(unknownLivenessSdk.automatic, false);

  for (const liveness of ['dead', 'unknown', 'weird']) {
    for (const adapter of [sdk, opencode]) {
      const resolved = resolveRecoveryDecision({ reason: 'server_restart', adapter, liveness });
      assert.notEqual(resolved.decision, 'reattach', `${adapter.harness}/${liveness} is not reattach`);
      assert.equal(resolved.automatic, false, `${adapter.harness}/${liveness} is not automatic`);
    }
  }

  // Alive but no reattach channel cannot be resumed automatically.
  const aliveSdk = resolveRecoveryDecision({ reason: 'server_restart', adapter: sdk, liveness: 'alive' });
  assert.notEqual(aliveSdk.decision, 'reattach');
  assert.equal(aliveSdk.automatic, false);

  // No resume strategy at all -> manual only.
  const noStrategy = resolveRecoveryDecision({
    reason: 'server_restart',
    adapter: { harness: 'custom', resumeStrategy: '', reattach: false },
    liveness: 'dead',
  });
  assert.equal(noStrategy.decision, 'manual_only');

  // An unproven reason has no recovery path even with a capable adapter.
  const notRecoverable = resolveRecoveryDecision({ reason: 'unknown', adapter: opencode, liveness: 'alive' });
  assert.equal(notRecoverable.decision, 'not_recoverable');
  assert.equal(notRecoverable.automatic, false);

  // A harness id string is accepted as the adapter argument.
  const byId = resolveRecoveryDecision({ reason: 'server_restart', adapter: 'sdk', liveness: 'dead' });
  assert.equal(byId.decision, 'resume_session');
  assert.equal(byId.adapter, 'sdk');

  // Reasons that forbid reattach must not auto-reattach even when opencode + alive.
  const aliveProcessGone = resolveRecoveryDecision({
    reason: 'process_gone',
    adapter: opencode,
    liveness: 'alive',
  });
  assert.equal(aliveProcessGone.decision, 'manual_only');
  assert.equal(aliveProcessGone.automatic, false);

  const aliveStartingTimeout = resolveRecoveryDecision({
    reason: 'starting_timeout',
    adapter: opencode,
    liveness: 'alive',
  });
  assert.equal(aliveStartingTimeout.decision, 'manual_only');
  assert.equal(aliveStartingTimeout.automatic, false);
});

test('resolveRecoveryDecision respects RUN_RECOVERY_DECISION_BY_REASON for every reason × adapter × liveness', () => {
  const reasons = RUN_INTERRUPT_REASONS;
  const adapters = ['sdk', 'claude', 'opencode'].map((harness) => resolveRecoveryAdapter(harness));
  const livenessValues = ['alive', 'dead', 'unknown'];
  const globalDecisions = new Set(['unsupported', 'not_recoverable', ...RUN_RECOVERY_DECISIONS]);

  for (const reason of reasons) {
    const normalizedReason = normalizeRunInterruptReason(reason);
    const allowed = RUN_RECOVERY_DECISION_BY_REASON[normalizedReason] || [];
    for (const adapter of adapters) {
      for (const liveness of livenessValues) {
        const resolved = resolveRecoveryDecision({ reason, adapter, liveness });
        assert.ok(globalDecisions.has(resolved.decision), `${reason}/${adapter.harness}/${liveness}`);
        if (resolved.decision === 'unsupported' || resolved.decision === 'not_recoverable') {
          assert.equal(resolved.automatic, false);
          continue;
        }
        assert.ok(
          allowed.includes(resolved.decision),
          `${reason}/${adapter.harness}/${liveness} -> ${resolved.decision} not in ${allowed.join(',')}`
        );
        assert.equal(resolved.automatic, resolved.decision === 'reattach');
      }
    }
  }
});

test('each run family has exactly one owner', () => {
  const families = ['chat', 'delegation', 'watcher', 'mailbox', 'workflow', 'scout'];
  assert.deepEqual(Object.keys(RUN_FAMILY_OWNERS).sort(), [...families].sort());
  const owners = new Set();
  for (const family of families) {
    const entry = ownerOfRunFamily(family);
    assert.ok(entry, `${family} has an owner`);
    assert.equal(entry.family, family);
    assert.ok(entry.owner, `${family}.owner`);
    assert.ok(entry.module, `${family}.module`);
    assert.ok(entry.purpose, `${family}.purpose`);
    assert.equal(owners.has(entry.owner), false, `${entry.owner} owns only one family`);
    owners.add(entry.owner);
  }
  assert.equal(assertSingleRunFamilyOwner(), true);
  assert.equal(ownerOfRunFamily('nope'), null);
  assert.equal(ownerOfRunFamily('CHAT'), RUN_FAMILY_OWNERS.chat);
});

test('infra outcome and agent report stay separated; agent never rewrites infra', () => {
  assert.deepEqual([...RUN_AGENT_OUTCOMES], [...DELEGATION_TASK_OUTCOMES]);
  assert.deepEqual([...RUN_AGENT_VERDICTS], ['unspecified', 'PASS', 'FAIL', 'BLOCKED', 'conflict']);
  assert.ok(RUN_INFRA_OUTCOMES.includes('interrupted'));

  assert.equal(normalizeRunInfraOutcome('interrupted'), 'interrupted');
  assert.equal(normalizeRunInfraOutcome('nonsense'), 'unknown');
  assert.equal(normalizeRunAgentOutcome('failure'), 'failure');
  assert.equal(normalizeRunAgentOutcome('nonsense'), 'unspecified');
  assert.equal(normalizeRunAgentVerdict('pass'), 'PASS');
  assert.equal(normalizeRunAgentVerdict('BLOCKED'), 'BLOCKED');
  assert.equal(normalizeRunAgentVerdict('conflict'), 'conflict');
  assert.equal(normalizeRunAgentVerdict('nonsense'), 'unspecified');

  // (2)+(3) An agent PASS cannot rescue an interrupted run.
  const interruptedPass = resolveRunOutcome({
    infraOutcome: 'interrupted',
    agentOutcome: 'success',
    agentVerdict: 'PASS',
  });
  assert.equal(interruptedPass.accepted, false);
  assert.equal(interruptedPass.countsAsFailure, true);
  assert.equal(interruptedPass.terminal, true);
  assert.equal(interruptedPass.infraOutcome, 'interrupted');
  assert.equal(interruptedPass.outcomeSource, 'server');

  // (1) Infra completed + agent failure/blocked is not accepted, but does not
  // count as an infra failure.
  const completedFailure = resolveRunOutcome({
    infraOutcome: 'completed',
    agentOutcome: 'failure',
    agentVerdict: 'PASS',
  });
  assert.equal(completedFailure.accepted, false);
  assert.equal(completedFailure.infraOutcome, 'completed');
  assert.equal(completedFailure.countsAsFailure, false);
  assert.equal(completedFailure.terminal, true);

  const completedBlocked = resolveRunOutcome({
    infraOutcome: 'completed',
    agentOutcome: 'blocked',
    agentVerdict: 'BLOCKED',
  });
  assert.equal(completedBlocked.accepted, false);

  // (1) Happy path.
  const completedPass = resolveRunOutcome({
    infraOutcome: 'completed',
    agentOutcome: 'success',
    agentVerdict: 'PASS',
  });
  assert.equal(completedPass.accepted, true);
  assert.equal(completedPass.countsAsFailure, false);
  assert.equal(completedPass.terminal, true);

  // (4) conflict always blocks.
  const conflict = resolveRunOutcome({
    infraOutcome: 'completed',
    agentOutcome: 'success',
    agentVerdict: 'conflict',
  });
  assert.equal(conflict.accepted, false);

  // Cancelled is terminal but not a failure, even with an agent PASS.
  const cancelledPass = resolveRunOutcome({ infraOutcome: 'cancelled', agentVerdict: 'PASS' });
  assert.equal(cancelledPass.accepted, false);
  assert.equal(cancelledPass.countsAsFailure, false);
  assert.equal(cancelledPass.terminal, true);

  // unknown / unsupported count as failures.
  const unknownFail = resolveRunOutcome({ infraOutcome: 'unknown', agentVerdict: 'FAIL' });
  assert.equal(unknownFail.accepted, false);
  assert.equal(unknownFail.countsAsFailure, true);
  assert.equal(unknownFail.terminal, false);
  const unsupported = resolveRunOutcome({ infraOutcome: 'unsupported', agentVerdict: 'PASS' });
  assert.equal(unsupported.accepted, false);
  assert.equal(unsupported.countsAsFailure, true);

  // A bogus infra value normalizes to unknown and a PASS cannot fix it.
  const bogusInfra = resolveRunOutcome({ infraOutcome: 'PASS', agentVerdict: 'PASS' });
  assert.equal(bogusInfra.infraOutcome, 'unknown');
  assert.equal(bogusInfra.accepted, false);
});

test('recovery backoff is exponential, monotonic and capped', () => {
  assert.equal(computeRecoveryBackoffMs({ failures: 0 }), 0);
  assert.equal(computeRecoveryBackoffMs({ failures: -3 }), 0);
  assert.equal(computeRecoveryBackoffMs({}), 0);
  assert.equal(computeRecoveryBackoffMs({ failures: 1 }), RECOVERY_BACKOFF_BASE_MS);
  assert.equal(computeRecoveryBackoffMs({ failures: 2 }), RECOVERY_BACKOFF_BASE_MS * 2);
  assert.equal(computeRecoveryBackoffMs({ failures: 3 }), RECOVERY_BACKOFF_BASE_MS * 4);
  assert.equal(computeRecoveryBackoffMs({ failures: 100 }), RECOVERY_BACKOFF_CAP_MS);
  assert.equal(computeRecoveryBackoffMs({ failures: 2, baseMs: 1000, capMs: 1500 }), 1500);
  assert.equal(
    computeRecoveryBackoffMs({ failures: 1, baseMs: Number.NaN, capMs: -1 }),
    RECOVERY_BACKOFF_BASE_MS
  );

  const series = [1, 2, 3, 4, 5, 6, 7, 8].map((failures) =>
    computeRecoveryBackoffMs({ failures })
  );
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index] >= series[index - 1], 'backoff is monotonic');
  }
  assert.equal(series[series.length - 1], RECOVERY_BACKOFF_CAP_MS);
});

test('accounting separates infra failures from the agent report', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual([...RECOVERY_EVENT_KINDS], [
    'cycle_start',
    'cycle_success',
    'infra_failure',
    'interrupted',
    'agent_failure',
    'user_cancel',
  ]);
  assert.equal(RECOVERY_ACCOUNTING_RULES.backoff.baseMs, RECOVERY_BACKOFF_BASE_MS);
  assert.equal(RECOVERY_ACCOUNTING_RULES.backoff.capMs, RECOVERY_BACKOFF_CAP_MS);

  const fromNull = nextRecoveryAccounting({ previous: null, event: { kind: 'cycle_start' }, now: 0 });
  assert.equal(fromNull.cyclesStarted, 1);
  assert.equal(fromNull.cycleCount, 1);
  assert.equal(fromNull.failures, 0);
  assert.equal(fromNull.lastEventKind, 'cycle_start');

  const started = nextRecoveryAccounting({ previous: {}, event: { kind: 'cycle_start' }, now });
  assert.equal(started.cyclesStarted, 1);
  assert.equal(started.cycleCount, 1);
  assert.equal(started.failures, 0);
  assert.equal(started.budgetUsed, 1);
  assert.equal(started.budgetRefunded, false);
  assert.equal(started.lastEventKind, 'cycle_start');

  // An agent failure never touches failures/backoff/budget.
  const agentFailure = nextRecoveryAccounting({ previous: started, event: { kind: 'agent_failure' }, now });
  assert.equal(agentFailure.failures, 0);
  assert.equal(agentFailure.consecutiveFailures, 0);
  assert.equal(agentFailure.backoffUntil, null);
  assert.equal(agentFailure.cyclesStarted, 1);
  assert.equal(agentFailure.budgetUsed, 1);
  assert.equal(agentFailure.lastEventKind, 'agent_failure');

  // Infra failure increments and schedules a backoff.
  const infraFailure = nextRecoveryAccounting({
    previous: agentFailure,
    event: { kind: 'infra_failure' },
    now,
  });
  assert.equal(infraFailure.failures, 1);
  assert.equal(infraFailure.consecutiveFailures, 1);
  assert.equal(infraFailure.backoffUntil, now + RECOVERY_BACKOFF_BASE_MS);
  assert.equal(infraFailure.budgetUsed, 1);
  assert.equal(infraFailure.budgetRefunded, false);

  const interrupted = nextRecoveryAccounting({
    previous: infraFailure,
    event: { kind: 'interrupted' },
    now,
  });
  assert.equal(interrupted.failures, 2);
  assert.equal(interrupted.consecutiveFailures, 2);
  assert.equal(interrupted.backoffUntil, now + RECOVERY_BACKOFF_BASE_MS * 2);

  // A user cancel keeps failures but schedules no backoff.
  const cancelled = nextRecoveryAccounting({ previous: interrupted, event: { kind: 'user_cancel' }, now });
  assert.equal(cancelled.failures, 2);
  assert.equal(cancelled.backoffUntil, null);
  assert.equal(cancelled.lastEventKind, 'user_cancel');
  assert.equal(cancelled.budgetUsed, 1);

  // Success resets failures and backoff but never shrinks the budget.
  const success = nextRecoveryAccounting({ previous: cancelled, event: { kind: 'cycle_success' }, now });
  assert.equal(success.failures, 0);
  assert.equal(success.consecutiveFailures, 0);
  assert.equal(success.backoffUntil, null);
  assert.equal(success.cyclesStarted, 1);
  assert.equal(success.cycleCount, 1);
  assert.equal(success.budgetUsed, 1);

  // An unknown event kind is ignored and keeps the previous last event.
  const ignored = nextRecoveryAccounting({ previous: success, event: { kind: 'bogus' }, now });
  assert.equal(ignored.failures, 0);
  assert.equal(ignored.lastEventKind, 'cycle_success');
  assert.equal(ignored.cyclesStarted, 1);
});

test('MVP adapters cover six harnesses and defer the rest', () => {
  const harnesses = ['sdk', 'claude', 'codex', 'qwen', 'deepseek', 'opencode'];
  assert.deepEqual(Object.keys(RECOVERY_MVP_ADAPTERS).sort(), [...harnesses].sort());
  for (const harness of harnesses) {
    const entry = RECOVERY_MVP_ADAPTERS[harness];
    assert.equal(entry.harness, harness);
    assert.equal(entry.scope, 'mvp');
    assert.equal(entry.requiresCrashValidation, true);
    assert.equal(entry.validation, 'pending');
    assert.ok(entry.resumeStrategy, `${harness} has a resume strategy`);
    assert.equal(typeof entry.reattach, 'boolean');
    assert.equal(resolveRecoveryAdapter(harness), entry);
  }

  assert.deepEqual([...RECOVERY_DEFERRED_ADAPTERS], ['codebuddy', 'openrouter', 'mistral']);
  assert.equal(RECOVERY_MVP_ADAPTERS.codebuddy, undefined);
  assert.equal(RECOVERY_MVP_ADAPTERS.openrouter, undefined);
  assert.ok(RECOVERY_DEFERRED_ADAPTER_REASONS.codebuddy);
  assert.ok(RECOVERY_DEFERRED_ADAPTER_REASONS.openrouter);

  const unknown = resolveRecoveryAdapter('nieznany');
  assert.equal(unknown.supported, false);
  assert.equal(unknown.scope, 'unsupported');
  assert.equal(unknown.harness, 'nieznany');

  assert.equal(RECOVERY_MVP_ADAPTERS.opencode.reattach, true);
  assert.equal(RECOVERY_MVP_ADAPTERS.opencode.resumeStrategy, 'server_reattach');
  assert.equal(RECOVERY_MVP_ADAPTERS.codex.resumeStrategy, 'resume_thread');
});

test('documentation matches the machine contract revision and vocabulary', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const docPath = join(here, '..', 'docs', 'recovery-contract.md');
  assert.equal(existsSync(docPath), true, 'docs/recovery-contract.md exists');
  const doc = readFileSync(docPath, 'utf8');

  assert.ok(doc.includes(RECOVERY_CONTRACT_REVISION), 'document carries the contract revision');
  assert.ok(doc.includes('RECOVERY_SCHEMA_VERSION'), 'document mentions the schema version');
  for (const state of RUN_LIFECYCLE_STATES) {
    assert.ok(doc.includes(state), `state ${state} is documented`);
  }
  for (const adapter of Object.keys(RECOVERY_MVP_ADAPTERS)) {
    assert.ok(doc.includes(adapter), `adapter ${adapter} is documented`);
  }
  for (const deferred of RECOVERY_DEFERRED_ADAPTERS) {
    assert.ok(doc.includes(deferred), `deferred adapter ${deferred} is documented`);
  }
  for (const reason of RUN_TRANSCRIPT_LOSS_REASONS) {
    assert.ok(doc.includes(reason), `transcript loss reason ${reason} is documented`);
  }
  assert.ok(doc.includes('describeRecoveryAdapterContract'), 'document explains the adapter contract view');
  assert.ok(doc.includes('infraOutcome'), 'document explains the infra outcome split');
  assert.ok(doc.includes('backoffUntil'), 'document explains backoff accounting');
});

test('the adapter contract view mirrors the MVP table and states the resume cost', () => {
  for (const harness of Object.keys(RECOVERY_MVP_ADAPTERS)) {
    const entry = RECOVERY_MVP_ADAPTERS[harness];
    const view = describeRecoveryAdapterContract(harness);
    assert.equal(view.harness, harness);
    assert.equal(view.supported, true, `${harness} declared a recovery contract`);
    assert.equal(view.scope, 'mvp');
    assert.equal(view.deferred, false);
    assert.equal(view.reattach, entry.reattach);
    assert.equal(view.canReattach, entry.reattach);
    assert.equal(view.resumeStrategy, entry.resumeStrategy);
    assert.equal(view.canResumeSession, true);
    assert.equal(view.requiresCrashValidation, true);
    assert.equal(view.validation, 'pending');
    // A supported adapter has no decision here: that needs a reason and an
    // observed liveness, which is policy input (R8/R12/R14).
    assert.equal(view.decision, '');
    assert.equal(view.infraOutcome, '');
    // Only a reattach keeps the live transcript; every other MVP row re-enters a
    // saved session id as a fresh turn, and that must be said out loud.
    assert.equal(view.transcriptLost, entry.reattach !== true);
    assert.equal(
      view.transcriptLossReason,
      entry.reattach === true ? 'none' : 'fresh_turn_in_saved_session'
    );
    assert.ok(view.adapterValidation && typeof view.adapterValidation === 'object');
    assert.equal(view.adapterValidation.harness, harness);
    assert.equal(view.adapterValidation.overallStatus, 'pending');
    assert.equal(view.adapterValidation.scenarios?.context?.status, 'validated');
    assert.equal(view.adapterValidation.scenarios?.live_executor?.status, 'validated');
    assert.equal(view.adapterValidation.scenarios?.waiting?.status, 'pending');
    assert.equal(view.adapterValidation.scenarios?.waiting?.notRun, true);
    assert.equal(view.adapterValidation.scenarios?.cancel?.status, 'pending');
    assert.equal(view.adapterValidation.scenarios?.missing_transcript?.status, 'pending');
    assert.equal(view.adapterValidation.enableGateValidation, 'pending');
    assert.equal(view.adapterValidation.requiresCrashValidation, true);
  }

  assert.equal(describeRecoveryAdapterContract('opencode').canReattach, true);
  assert.equal(describeRecoveryAdapterContract('opencode').transcriptLost, false);
  assert.equal(describeRecoveryAdapterContract('claude').transcriptLossReason, 'fresh_turn_in_saved_session');
});

test('a harness without a recovery contract is an explicit unsupported', () => {
  for (const deferred of RECOVERY_DEFERRED_ADAPTERS) {
    const view = describeRecoveryAdapterContract(deferred);
    assert.equal(view.supported, false);
    assert.equal(view.deferred, true);
    assert.equal(view.scope, 'unsupported');
    assert.equal(view.canReattach, false);
    assert.equal(view.canResumeSession, false);
    assert.equal(view.resumeStrategy, '');
    assert.equal(view.requiresCrashValidation, false);
    assert.equal(view.validation, '');
    // The tokens come from the shared vocabulary, not a second table.
    assert.ok(RUN_RECOVERY_DECISIONS.includes(view.decision), 'decision is a contract token');
    assert.equal(view.decision, 'unsupported');
    assert.ok(RUN_INFRA_OUTCOMES.includes(view.infraOutcome), 'infra outcome is a contract token');
    assert.equal(view.infraOutcome, 'unsupported');
    assert.equal(view.transcriptLost, true);
    assert.equal(view.transcriptLossReason, 'no_recovery_contract');
    assert.ok(view.rationale, 'unsupported carries the resolver rationale');
    // The same answer as asking the resolver directly: `unsupported` is reused,
    // never re-derived by the adapter view.
    const direct = resolveRecoveryDecision({ adapter: deferred, liveness: 'unknown' });
    assert.equal(view.decision, direct.decision, 'decision comes from the resolver');
    assert.equal(view.rationale, direct.rationale, 'rationale comes from the resolver');
  }

  const unknown = describeRecoveryAdapterContract('');
  assert.equal(unknown.harness, '');
  assert.equal(unknown.supported, false);
  assert.equal(unknown.deferred, false);
  assert.equal(unknown.decision, 'unsupported');
});

test('transcript loss reasons are a closed vocabulary', () => {
  assert.deepEqual([...RUN_TRANSCRIPT_LOSS_REASONS], [
    'none',
    'room_missing',
    'no_live_run_match',
    'fresh_turn_in_saved_session',
    'no_recovery_contract',
  ]);
  assert.equal(normalizeRunTranscriptLossReason('  ROOM_Missing '), 'room_missing');
  assert.equal(normalizeRunTranscriptLossReason('none'), 'none');
  assert.equal(normalizeRunTranscriptLossReason('invented'), '');
  assert.equal(normalizeRunTranscriptLossReason(undefined), '');
});
