/**
 * Versioned recovery contract: run lifecycle, interrupt reasons, recovery
 * decisions, family ownership, the infra/server vs agent-report split, the
 * accounting rules and the adapter contract view (reattach/resume capability
 * plus explicit transcript loss) shared by every recovery leaf (R2..R20).
 *
 * This module is the single source of truth for the recovery vocabulary. It is
 * a *contract* module: it only describes and derives, it never touches the
 * runtime (no chat-run-service, delegation-service or workspace-watcher
 * integration). `docs/recovery-contract.md` documents the matrix in Polish; the
 * values here are the machine-readable contract and MUST stay in sync with that
 * document.
 *
 * Firm boundaries encoded here:
 * - The **server** owns `infraOutcome` and the run lifecycle. An agent report
 *   (outcome/verdict) can never rewrite either of them.
 * - Only `interrupted` / `unknown` runs are recoverable; `completed` and
 *   `cancelled` are final for a given attempt.
 * - A non-alive run is NEVER automatically reattached.
 * - Failure counters and backoff are driven by *infra* signals, not by agent
 *   reports (an agent `failure` does not consume the retry budget).
 */

import { DELEGATION_INTERRUPT_CODES, DELEGATION_TASK_OUTCOMES } from '../delegation-status.js';
import { resolveRecoveryAdapterValidation } from './adapter-validation.js';

/** Bumped whenever the persisted recovery record shape gains/changes a field. */
export const RECOVERY_SCHEMA_VERSION = 1;
/** Human-readable revision of the matrix/contract document. */
export const RECOVERY_CONTRACT_REVISION = '2026-10-08.2';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Lowercased, trimmed token used for enum normalization.
 *
 * @param {unknown} value
 * @returns {string}
 */
function token(value) {
  return text(value).toLowerCase();
}

// ---------------------------------------------------------------------------
// B. Run lifecycle state matrix
// ---------------------------------------------------------------------------

/** Every lifecycle state a logical run may be observed in. */
export const RUN_LIFECYCLE_STATES = Object.freeze([
  'starting',
  'running',
  'waiting',
  'completed',
  'cancelled',
  'interrupted',
  'unknown',
  'recovering',
]);

/**
 * Lifecycle states that end the current attempt. `interrupted` is terminal for
 * the attempt but also recoverable: recovery starts a *new* attempt/generation.
 */
export const RUN_TERMINAL_STATES = Object.freeze(['completed', 'cancelled', 'interrupted']);

/** States in which the run may still make progress without recovery. */
export const RUN_ACTIVE_STATES = Object.freeze(['starting', 'running', 'waiting']);

/** States whose true state is not proven (must never be auto-continued). */
export const RUN_INDETERMINATE_STATES = Object.freeze(['unknown', 'recovering']);

/** States a recovery flow may pick up. */
export const RUN_RECOVERABLE_STATES = Object.freeze(['interrupted', 'unknown']);

/**
 * Allowed lifecycle transitions. Terminal `completed` / `cancelled` have an
 * empty list: only their self-transition is allowed (handled separately). The
 * empty string models "no persisted run yet" -> a new run may only start.
 */
export const RUN_LIFECYCLE_TRANSITIONS = Object.freeze({
  '': Object.freeze(['starting']),
  starting: Object.freeze(['running', 'waiting', 'completed', 'cancelled', 'interrupted', 'unknown']),
  running: Object.freeze(['waiting', 'completed', 'cancelled', 'interrupted', 'unknown']),
  waiting: Object.freeze(['running', 'completed', 'cancelled', 'interrupted', 'unknown']),
  interrupted: Object.freeze(['recovering', 'completed', 'cancelled']),
  unknown: Object.freeze(['recovering', 'completed', 'cancelled']),
  recovering: Object.freeze([
    'starting',
    'running',
    'waiting',
    'completed',
    'cancelled',
    'interrupted',
    'unknown',
  ]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/**
 * @param {unknown} value
 * @returns {string} a canonical state, or '' for an unknown value
 */
export function normalizeRunLifecycleState(value) {
  const raw = token(value);
  return RUN_LIFECYCLE_STATES.includes(raw) ? raw : '';
}

/**
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean} whether the lifecycle edge is allowed
 */
export function canTransitionRunLifecycle(from, to) {
  const current = normalizeRunLifecycleState(from);
  const next = normalizeRunLifecycleState(to);
  if (!next) return false;
  // Self-transition is always allowed, including final states.
  if (current === next) return true;
  return (RUN_LIFECYCLE_TRANSITIONS[current] || []).includes(next);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTerminalRunLifecycle(value) {
  return RUN_TERMINAL_STATES.includes(normalizeRunLifecycleState(value));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isActiveRunLifecycle(value) {
  return RUN_ACTIVE_STATES.includes(normalizeRunLifecycleState(value));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIndeterminateRunLifecycle(value) {
  return RUN_INDETERMINATE_STATES.includes(normalizeRunLifecycleState(value));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecoverableRunLifecycle(value) {
  return RUN_RECOVERABLE_STATES.includes(normalizeRunLifecycleState(value));
}

// ---------------------------------------------------------------------------
// C. Interrupt reasons and recovery decisions
// ---------------------------------------------------------------------------

/**
 * Durable reason a run was interrupted. The delegation codes are the canonical
 * server-restart family and are imported, not re-typed, so a change in
 * `lib/delegation-status.js` cannot silently diverge from this contract.
 * `process_gone` covers an externally killed worker (SIGKILL / OOM); `unknown`
 * is the conservative fallback and is NOT recoverable.
 */
export const RUN_INTERRUPT_REASONS = Object.freeze([
  ...DELEGATION_INTERRUPT_CODES,
  'process_gone',
  'unknown',
]);

/**
 * @param {unknown} value
 * @returns {string} a canonical reason, or 'unknown'
 */
export function normalizeRunInterruptReason(value) {
  const raw = token(value);
  return RUN_INTERRUPT_REASONS.includes(raw) ? raw : 'unknown';
}

/** Vocabulary of recovery decisions. */
export const RUN_RECOVERY_DECISIONS = Object.freeze([
  'reattach',
  'resume_session',
  'new_attempt',
  'manual_only',
  'unsupported',
  'not_recoverable',
]);

/**
 * Which decisions are *legal* for a given interrupt reason. `unknown` maps to
 * `not_recoverable` alone: an unproven cause must never be auto-continued.
 * `new_attempt` is part of the vocabulary for higher layers (policy), but the
 * resolver below never picks it on its own.
 */
export const RUN_RECOVERY_DECISION_BY_REASON = Object.freeze({
  server_restart: Object.freeze(['reattach', 'resume_session', 'new_attempt', 'manual_only']),
  starting_timeout: Object.freeze(['resume_session', 'new_attempt', 'manual_only']),
  running_orphan: Object.freeze(['reattach', 'resume_session', 'new_attempt', 'manual_only']),
  process_gone: Object.freeze(['resume_session', 'new_attempt', 'manual_only']),
  unknown: Object.freeze(['not_recoverable']),
});

/** Liveness values the resolver distinguishes. */
export const RUN_LIVENESS_STATES = Object.freeze(['alive', 'dead', 'unknown']);

/**
 * @param {unknown} value
 * @returns {string} a canonical liveness value, or 'unknown'
 */
export function normalizeRunLiveness(value) {
  const raw = token(value);
  return RUN_LIVENESS_STATES.includes(raw) ? raw : 'unknown';
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the reason has any recovery path at all
 */
export function isRecoverableRunInterruptReason(value) {
  const reason = normalizeRunInterruptReason(value);
  const allowed = RUN_RECOVERY_DECISION_BY_REASON[reason] || [];
  return allowed.some((decision) => decision !== 'not_recoverable');
}

/**
 * Resolve one recovery decision from a reason, an adapter capability and the
 * observed liveness.
 *
 * Precedence (deterministic):
 * 1. missing/unsupported adapter -> `unsupported`
 * 2. reason with no recovery path -> `not_recoverable`
 * 3. liveness `alive` + adapter can reattach + `reattach` allowed for reason ->
 *    `reattach` (automatic)
 * 4. liveness not `alive` + resume strategy + `resume_session` allowed for
 *    reason -> `resume_session`
 * 5. otherwise -> `manual_only` when allowed for reason
 *
 * `RUN_RECOVERY_DECISION_BY_REASON` is authoritative: the resolver never returns
 * a decision absent from that reason's list (except `unsupported` /
 * `not_recoverable`). A non-alive run never yields `reattach`, and only
 * `reattach` is automatic.
 *
 * @param {{
 *   reason?: unknown,
 *   adapter?: object|string|null,
 *   harness?: unknown,
 *   liveness?: unknown,
 * }} [input]
 * @returns {{
 *   decision: string,
 *   reason: string,
 *   adapter: string,
 *   liveness: string,
 *   automatic: boolean,
 *   rationale: string,
 * }}
 */
export function resolveRecoveryDecision(input = {}) {
  const reason = normalizeRunInterruptReason(input.reason);
  const liveness = normalizeRunLiveness(input.liveness);
  let descriptor = null;
  if (input.adapter && typeof input.adapter === 'object') {
    descriptor = input.adapter;
  } else if (text(input.adapter)) {
    descriptor = resolveRecoveryAdapter(input.adapter);
  }
  const adapter = text(descriptor?.harness ?? input.harness);
  const base = { reason, adapter, liveness };
  const supported = Boolean(descriptor && descriptor.supported !== false && text(descriptor.harness));

  if (!supported) {
    return {
      ...base,
      decision: 'unsupported',
      automatic: false,
      rationale: 'Adapter nie zadeklarowal capability recovery (scope unsupported).',
    };
  }
  if (!isRecoverableRunInterruptReason(reason)) {
    return {
      ...base,
      decision: 'not_recoverable',
      automatic: false,
      rationale: `Reason ${reason} nie ma sciezki recovery; wymagana decyzja czlowieka.`,
    };
  }
  const allowedForReason = RUN_RECOVERY_DECISION_BY_REASON[reason] || [];
  if (
    liveness === 'alive' &&
    descriptor.reattach === true &&
    allowedForReason.includes('reattach')
  ) {
    return {
      ...base,
      decision: 'reattach',
      automatic: true,
      rationale: 'Wykonawca zywy i adapter potrafi reattach; automatyczne podlaczenie.',
    };
  }
  if (
    liveness !== 'alive' &&
    text(descriptor.resumeStrategy) &&
    allowedForReason.includes('resume_session')
  ) {
    return {
      ...base,
      decision: 'resume_session',
      automatic: false,
      rationale: 'Wykonawca nie zyje, ale adapter ma strategie wznowienia zachowanej sesji.',
    };
  }
  if (allowedForReason.includes('manual_only')) {
    return {
      ...base,
      decision: 'manual_only',
      automatic: false,
      rationale: 'Brak bezpiecznego automatycznego kroku; wymagane reczne wznowienie.',
    };
  }
  return {
    ...base,
    decision: allowedForReason[0] || 'not_recoverable',
    automatic: false,
    rationale: 'Brak bezpiecznego automatycznego kroku; wymagane reczne wznowienie.',
  };
}

// ---------------------------------------------------------------------------
// D. Ownership of run families
// ---------------------------------------------------------------------------

/**
 * Exactly one server-side owner per run family. Recovery must not duplicate a
 * family's own claim/queue logic; it asks the owner instead.
 */
export const RUN_FAMILY_OWNERS = Object.freeze({
  chat: Object.freeze({
    family: 'chat',
    owner: 'chat-run-service',
    module: 'lib/chat-run-service.js',
    purpose: 'Start/cancel/probe zwyklego runu czatu i blokada per czat.',
  }),
  delegation: Object.freeze({
    family: 'delegation',
    owner: 'delegation-service',
    module: 'lib/delegation-service.js',
    purpose: 'Cykl zycia delegacji, slot rodzica i jednorazowa kontynuacja.',
  }),
  watcher: Object.freeze({
    family: 'watcher',
    owner: 'workspace-watcher',
    module: 'lib/workspace-watcher.js',
    purpose: 'Cykle watchera, lease, failures i backoff workspace.',
  }),
  mailbox: Object.freeze({
    family: 'mailbox',
    owner: 'delegation-mailbox',
    module: 'lib/delegation-mailbox.js',
    purpose: 'Dostarczanie raportow i wiadomosci do rodzica (outbox/inbox).',
  }),
  workflow: Object.freeze({
    family: 'workflow',
    owner: 'delegation-workflow',
    module: 'lib/delegation-workflow.js',
    purpose: 'Stan petli plan/implement/review/fix i jej budzet.',
  }),
  scout: Object.freeze({
    family: 'scout',
    owner: 'workspace-watcher-scout',
    module: 'lib/workspace-watcher-scout.js',
    purpose: 'Skanowanie workspace i propozycje findings.',
  }),
});

/**
 * @param {unknown} family
 * @returns {object|null} the frozen owner entry, or null
 */
export function ownerOfRunFamily(family) {
  const id = token(family);
  return RUN_FAMILY_OWNERS[id] || null;
}

/**
 * Guard for the ownership invariant: every family is present exactly once, has
 * a matching `family` key and a non-empty `owner`, and no owner is reused by
 * two families.
 *
 * @returns {true}
 * @throws {Error} when the invariant is violated
 */
export function assertSingleRunFamilyOwner() {
  const seenOwners = new Map();
  for (const [family, entry] of Object.entries(RUN_FAMILY_OWNERS)) {
    if (!entry || entry.family !== family) {
      throw new Error(`recovery: family ${family} has a malformed owner entry`);
    }
    if (!text(entry.owner)) {
      throw new Error(`recovery: family ${family} has no owner`);
    }
    if (seenOwners.has(entry.owner)) {
      throw new Error(
        `recovery: owner ${entry.owner} is shared by ${seenOwners.get(entry.owner)} and ${family}`
      );
    }
    seenOwners.set(entry.owner, family);
  }
  return true;
}

// ---------------------------------------------------------------------------
// E. Infra (server) outcome vs agent report
// ---------------------------------------------------------------------------

/**
 * Outcome the *server* assigns to a run. Only the server may set this; an agent
 * report never changes it.
 */
export const RUN_INFRA_OUTCOMES = Object.freeze([
  'none',
  'accepted',
  'completed',
  'cancelled',
  'interrupted',
  'unsupported',
  'unknown',
]);

/**
 * Outcome the *agent* declares about its task. Kept identical to
 * `DELEGATION_TASK_OUTCOMES` by construction.
 */
export const RUN_AGENT_OUTCOMES = Object.freeze([...DELEGATION_TASK_OUTCOMES]);

/** Verdict the agent/reviewer declares. Kept separate from the outcome. */
export const RUN_AGENT_VERDICTS = Object.freeze(['unspecified', 'PASS', 'FAIL', 'BLOCKED', 'conflict']);

const AGENT_VERDICT_BY_LOWER = new Map(
  RUN_AGENT_VERDICTS.map((verdict) => [verdict.toLowerCase(), verdict])
);

/**
 * @param {unknown} value
 * @returns {string} a canonical infra outcome, or 'unknown'
 */
export function normalizeRunInfraOutcome(value) {
  const raw = token(value);
  return RUN_INFRA_OUTCOMES.includes(raw) ? raw : 'unknown';
}

/**
 * @param {unknown} value
 * @returns {string} a canonical agent outcome, or 'unspecified'
 */
export function normalizeRunAgentOutcome(value) {
  const raw = token(value);
  return RUN_AGENT_OUTCOMES.includes(raw) ? raw : 'unspecified';
}

/**
 * Verdicts are case-insensitive on input but canonicalized on output.
 *
 * @param {unknown} value
 * @returns {string} a canonical verdict, or 'unspecified'
 */
export function normalizeRunAgentVerdict(value) {
  return AGENT_VERDICT_BY_LOWER.get(token(value)) || 'unspecified';
}

/**
 * Combine the server infra outcome with the agent report without letting the
 * report rewrite the server truth.
 *
 * - `accepted` requires infra `completed` and an agent report that does not
 *   block (`FAIL` / `BLOCKED` / `conflict` verdicts or `failure` / `blocked`
 *   outcomes).
 * - `interrupted` / `unsupported` / `unknown` are never accepted and count as
 *   infra failures, even when the agent reported `PASS`.
 * - `cancelled` is terminal but is not a failure.
 * - A `conflict` verdict always blocks acceptance.
 * - Agent failure/blocked does NOT increment the infra failure counter.
 *
 * @param {{
 *   infraOutcome?: unknown,
 *   agentOutcome?: unknown,
 *   agentVerdict?: unknown,
 * }} [input]
 * @returns {{
 *   outcomeSource: 'server',
 *   infraOutcome: string,
 *   agentOutcome: string,
 *   agentVerdict: string,
 *   accepted: boolean,
 *   countsAsFailure: boolean,
 *   terminal: boolean,
 *   rationale: string,
 * }}
 */
export function resolveRunOutcome(input = {}) {
  const infraOutcome = normalizeRunInfraOutcome(input.infraOutcome);
  const agentOutcome = normalizeRunAgentOutcome(input.agentOutcome);
  const agentVerdict = normalizeRunAgentVerdict(input.agentVerdict);
  const terminal = RUN_TERMINAL_STATES.includes(infraOutcome);
  const infraFailure =
    infraOutcome === 'interrupted' || infraOutcome === 'unsupported' || infraOutcome === 'unknown';
  const verdictBlocks =
    agentVerdict === 'FAIL' || agentVerdict === 'BLOCKED' || agentVerdict === 'conflict';
  const agentBlocks = agentOutcome === 'failure' || agentOutcome === 'blocked';
  const accepted = infraOutcome === 'completed' && !verdictBlocks && !agentBlocks;
  // Only infra signals feed the failure counter/backoff; the agent report is
  // accounted separately (see RECOVERY_ACCOUNTING_RULES.agentReport).
  const countsAsFailure = infraFailure;

  let rationale;
  if (infraOutcome === 'completed') {
    rationale = accepted
      ? 'Infra completed, a raport agenta nie blokuje akceptacji.'
      : `Infra completed, ale raport agenta (${agentVerdict}/${agentOutcome}) blokuje akceptacje.`;
  } else if (infraOutcome === 'cancelled') {
    rationale = 'Run anulowany; terminalny, ale nie liczy sie jako failure.';
  } else if (infraFailure) {
    rationale = `Infra ${infraOutcome}: brak dowodu ukonczenia; raport agenta nie zmienia tego stanu.`;
  } else {
    rationale = `Infra ${infraOutcome}: run nieosiagnal terminalnego stanu.`;
  }

  return {
    outcomeSource: 'server',
    infraOutcome,
    agentOutcome,
    agentVerdict,
    accepted,
    countsAsFailure,
    terminal,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// F. Failure / backoff / budget / cycle accounting
// ---------------------------------------------------------------------------

export const RECOVERY_BACKOFF_BASE_MS = 30000;
export const RECOVERY_BACKOFF_CAP_MS = 3600000;

/** Event kinds the deterministic accounting reducer understands. */
export const RECOVERY_EVENT_KINDS = Object.freeze([
  'cycle_start',
  'cycle_success',
  'infra_failure',
  'interrupted',
  'agent_failure',
  'user_cancel',
]);

/**
 * Machine-readable description of the accounting rules. `docs/recovery-contract.md`
 * documents the same rules in prose.
 */
export const RECOVERY_ACCOUNTING_RULES = Object.freeze({
  failures: Object.freeze({
    incrementsOn: Object.freeze(['infra_failure', 'interrupted']),
    resetsOn: Object.freeze(['cycle_success']),
    ignores: Object.freeze(['agent_failure', 'user_cancel', 'cycle_start']),
    note: 'Tylko sygnaly infrastruktury licza sie do failures; raport agenta nie.',
  }),
  backoff: Object.freeze({
    baseMs: RECOVERY_BACKOFF_BASE_MS,
    capMs: RECOVERY_BACKOFF_CAP_MS,
    formula: 'min(baseMs * 2^(failures-1), capMs); 0 dla failures <= 0',
    setOn: Object.freeze(['infra_failure', 'interrupted']),
    clearedOn: Object.freeze(['cycle_success', 'user_cancel']),
  }),
  budget: Object.freeze({
    unit: 'cycles_started',
    budgetUsed: 'cyclesStarted',
    refundedOn: Object.freeze([]),
    note: 'Infra-failure nie zwraca budzetu; budgetRefunded pozostaje false.',
  }),
  cycleCount: Object.freeze({
    incrementsOn: Object.freeze(['cycle_start']),
    note: 'cycleCount i cyclesStarted rosna razem na cycle_start.',
  }),
  cycleStart: Object.freeze({
    kind: 'cycle_start',
    effect: 'cyclesStarted+1, cycleCount+1, failures bez zmian',
  }),
  agentReport: Object.freeze({
    kinds: Object.freeze(['agent_failure']),
    effect: 'brak wplywu na failures/backoff/budget; zapisywany tylko lastEventKind',
  }),
});

/**
 * Exponential backoff with a hard cap. Deterministic and side-effect free.
 *
 * @param {{ failures?: unknown, baseMs?: unknown, capMs?: unknown }} [input]
 * @returns {number} milliseconds (0 when there is no failure)
 */
export function computeRecoveryBackoffMs(input = {}) {
  const failures = Math.max(0, Math.floor(Number(input.failures) || 0));
  if (failures <= 0) return 0;
  const base = Number(input.baseMs);
  const cap = Number(input.capMs);
  const baseMs = Number.isFinite(base) && base > 0 ? base : RECOVERY_BACKOFF_BASE_MS;
  const capMs = Number.isFinite(cap) && cap > 0 ? cap : RECOVERY_BACKOFF_CAP_MS;
  return Math.min(baseMs * 2 ** (failures - 1), capMs);
}

/**
 * @param {unknown} value
 * @returns {string} a canonical event kind, or ''
 */
export function normalizeRecoveryEventKind(value) {
  const raw = token(value);
  return RECOVERY_EVENT_KINDS.includes(raw) ? raw : '';
}

/**
 * @param {object} [previous]
 * @returns {object}
 */
function readAccountingSnapshot(previous = {}) {
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  const rawBackoff = previous.backoffUntil;
  // `Number(null) === 0`, so an absent backoff must be filtered explicitly.
  const backoff = rawBackoff == null || rawBackoff === '' ? Number.NaN : Number(rawBackoff);
  return {
    failures: count(previous.failures),
    consecutiveFailures: count(previous.consecutiveFailures),
    backoffUntil: Number.isFinite(backoff) ? backoff : null,
    cyclesStarted: count(previous.cyclesStarted),
    cycleCount: count(previous.cycleCount),
    budgetUsed: count(previous.budgetUsed),
    budgetRefunded: previous.budgetRefunded === true,
    lastEventKind: text(previous.lastEventKind),
  };
}

/**
 * Pure accounting reducer. `now` is injected so the result is reproducible; no
 * wall-clock or external dependency is used.
 *
 * Event effects:
 * - `cycle_start`: cyclesStarted+1, cycleCount+1, failures unchanged.
 * - `cycle_success`: failures=0, consecutiveFailures=0, backoffUntil=null.
 * - `infra_failure` / `interrupted`: failures+1, consecutiveFailures+1,
 *   backoffUntil = now + backoff(failures).
 * - `agent_failure`: state unchanged (agent report only).
 * - `user_cancel`: failures unchanged and no backoff (backoffUntil=null).
 *
 * `budgetUsed` always mirrors `cyclesStarted`; no event refunds budget.
 * Unrecognized event kinds are ignored and keep the previous `lastEventKind`.
 *
 * @param {{
 *   previous?: object,
 *   event?: { kind?: unknown },
 *   now?: number,
 *   baseMs?: number,
 *   capMs?: number,
 * }} [input]
 * @returns {{
 *   failures: number,
 *   consecutiveFailures: number,
 *   backoffUntil: number|null,
 *   cyclesStarted: number,
 *   cycleCount: number,
 *   budgetUsed: number,
 *   budgetRefunded: boolean,
 *   lastEventKind: string,
 * }}
 */
export function nextRecoveryAccounting(input = {}) {
  const state = readAccountingSnapshot(input.previous == null ? {} : input.previous);
  const now = Number(input.now);
  const nowMs = Number.isFinite(now) ? now : 0;
  const kind = normalizeRecoveryEventKind(input.event?.kind);
  if (!kind) return state;

  state.lastEventKind = kind;
  switch (kind) {
    case 'cycle_start':
      state.cyclesStarted += 1;
      state.cycleCount += 1;
      break;
    case 'cycle_success':
      state.failures = 0;
      state.consecutiveFailures = 0;
      state.backoffUntil = null;
      break;
    case 'infra_failure':
    case 'interrupted':
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.backoffUntil =
        nowMs +
        computeRecoveryBackoffMs({
          failures: state.failures,
          baseMs: input.baseMs,
          capMs: input.capMs,
        });
      break;
    case 'user_cancel':
      // failures unchanged, and no backoff is scheduled (cleared).
      state.backoffUntil = null;
      break;
    case 'agent_failure':
      // agent report only: failures/backoff/budget untouched.
      break;
    default:
      break;
  }
  state.budgetUsed = state.cyclesStarted;
  state.budgetRefunded = false;
  return state;
}

// ---------------------------------------------------------------------------
// G. MVP adapters
// ---------------------------------------------------------------------------

/**
 * @param {object} entry
 * @returns {object}
 */
function defineMvpAdapter(entry) {
  return Object.freeze({
    reattach: false,
    requiresCrashValidation: true,
    validation: 'pending',
    scope: 'mvp',
    ...entry,
  });
}

/**
 * Adapters validated as MVP. Every entry still requires a per-harness,
 * per-SDK-version crash test (`validation: 'pending'`); recovery must not be
 * enabled automatically before that test passes.
 */
export const RECOVERY_MVP_ADAPTERS = Object.freeze({
  sdk: defineMvpAdapter({ harness: 'sdk', resumeStrategy: 'agent_resume', reattach: false }),
  claude: defineMvpAdapter({ harness: 'claude', resumeStrategy: 'session_resume', reattach: false }),
  codex: defineMvpAdapter({ harness: 'codex', resumeStrategy: 'resume_thread', reattach: false }),
  qwen: defineMvpAdapter({ harness: 'qwen', resumeStrategy: 'session_resume', reattach: false }),
  deepseek: defineMvpAdapter({ harness: 'deepseek', resumeStrategy: 'session_id', reattach: false }),
  opencode: defineMvpAdapter({ harness: 'opencode', resumeStrategy: 'server_reattach', reattach: true }),
});

/** Harnesses whose full tool recovery is explicitly outside the MVP. */
export const RECOVERY_DEFERRED_ADAPTERS = Object.freeze(['codebuddy', 'openrouter']);

/** Why the deferred harnesses are not part of the MVP. */
export const RECOVERY_DEFERRED_ADAPTER_REASONS = Object.freeze({
  codebuddy:
    'Runner po utracie procesu tworzy swieza live session bez wznowienia zapisanego ID; pelny tool recovery wymaga osobnej pracy.',
  openrouter:
    'Odtwarza tylko tekst user/assistant, bez pelnej petli tool-call/tool-result; nie kwalifikuje sie do auto-resume.',
});

const UNSUPPORTED_ADAPTER = Object.freeze({ supported: false, scope: 'unsupported' });

/**
 * @param {unknown} harness
 * @returns {object} the frozen MVP adapter entry or an `unsupported` descriptor
 */
export function resolveRecoveryAdapter(harness) {
  const id = token(harness);
  const entry = RECOVERY_MVP_ADAPTERS[id];
  if (entry) return entry;
  return Object.freeze({ ...UNSUPPORTED_ADAPTER, harness: id });
}

// ---------------------------------------------------------------------------
// H. Explicit transcript/context loss and the adapter contract view
// ---------------------------------------------------------------------------

/**
 * Reason tokens for an EXPLICIT transcript/context-loss signal, which plan
 * section 3 requires ("Jawna obsługa utraty kontekstu, zaginionych sesji"):
 * recovery must never silently pretend that the prior context survived.
 *
 * These are metadata, not policy — the token names what is *not* preserved; it
 * never decides whether a resume is allowed (that is `resolveRecoveryDecision`
 * plus the R5 acceptance gate and the R14 policy).
 */
export const RUN_TRANSCRIPT_LOSS_REASONS = Object.freeze([
  /** The same live executor session continues (a reattach-capable adapter). */
  'none',
  /** Observed: the in-memory room that held the transcript is gone (restart). */
  'room_missing',
  /** Observed: the room survives but holds no live run matching the durable one. */
  'no_live_run_match',
  /** A resume starts a fresh turn in a saved session id, not mid-transcript. */
  'fresh_turn_in_saved_session',
  /** The transport declared no recovery contract at all. */
  'no_recovery_contract',
]);

/**
 * @param {unknown} value
 * @returns {string} a canonical loss reason, or '' for an unknown value
 */
export function normalizeRunTranscriptLossReason(value) {
  const raw = token(value);
  return RUN_TRANSCRIPT_LOSS_REASONS.includes(raw) ? raw : '';
}

/**
 * The complete adapter contract for one harness: the static
 * `RECOVERY_MVP_ADAPTERS` descriptor plus the capability and limitation signals
 * a runtime adapter must expose, so no leaf re-types a second capability table.
 *
 * What the caller learns:
 * - `supported` / `scope`: whether the harness has a recovery contract at all.
 *   A deferred (`RECOVERY_DEFERRED_ADAPTERS`) or unknown harness is reported as
 *   an EXPLICIT `unsupported` through the contract's own
 *   `resolveRecoveryDecision` / `RUN_INFRA_OUTCOMES` vocabulary — never as a
 *   silent false a caller could read as "the run ended".
 * - `reattach` / `canReattach` / `resumeStrategy` / `canResumeSession` /
 *   `requiresCrashValidation` / `validation`: the declared MVP row.
 *   `canReattach`/`canResumeSession` are the names the live adapter surface uses
 *   (`lib/chat-run-service.js#getChatRunAdapterCapabilities`), which may only
 *   narrow them. Recovery stays disabled until the per-SDK-version live SIGKILL
 *   crash suite (R19) flips `validation`.
 * - `transcriptLost` / `transcriptLossReason`: whether a resume of THIS adapter
 *   can keep the prior transcript. Only a reattach keeps the live context; every
 *   other MVP strategy re-enters a saved session id as a fresh turn, and a
 *   transport without a contract keeps an explicitly unknown context.
 * - `adapterValidation`: the R7 declared row (`lib/recovery/adapter-validation.js`).
 *   Static `context` / `live_executor` scenarios are derived here. `waiting`,
 *   `cancel` and `missing_transcript` stay `pending` (`notRun: true`) until a
 *   caller runs `evaluateRecoveryAdapterValidation` with an explicit store.
 *   Overall `validated` still requires the R19 crash proof. This view never
 *   opens a recovery store.
 *
 * Side-effect free aside from an optional package.json read for the SDK version
 * key. No recovery-store, SQLite or temp-directory work.
 *
 * @param {unknown} harness
 * @returns {{
 *   harness: string,
 *   supported: boolean,
 *   scope: string,
 *   deferred: boolean,
 *   reattach: boolean,
 *   canReattach: boolean,
 *   resumeStrategy: string,
 *   canResumeSession: boolean,
 *   requiresCrashValidation: boolean,
 *   validation: string,
 *   transcriptLost: boolean,
 *   transcriptLossReason: string,
 *   decision: string,
 *   infraOutcome: string,
 *   rationale: string,
 *   adapterValidation: object,
 * }}
 */
export function describeRecoveryAdapterContract(harness) {
  const descriptor = resolveRecoveryAdapter(harness);
  const id = token(descriptor.harness);
  const supported = descriptor.supported !== false && Boolean(id);
  const resumeStrategy = text(descriptor.resumeStrategy);
  const reattach = supported && descriptor.reattach === true;
  const transcriptLossReason = !supported
    ? 'no_recovery_contract'
    : reattach
      ? 'none'
      : 'fresh_turn_in_saved_session';
  // Only an unsupported adapter has a decision here; a supported one needs a
  // reason and a liveness observation, which is policy input (R8/R12/R14).
  const decision = supported
    ? null
    : resolveRecoveryDecision({ adapter: descriptor, liveness: 'unknown' });
  const adapterValidation = resolveRecoveryAdapterValidation(id);
  return Object.freeze({
    harness: id,
    supported,
    scope: supported ? 'mvp' : (text(descriptor.scope) || 'unsupported'),
    deferred: RECOVERY_DEFERRED_ADAPTERS.includes(id),
    reattach,
    canReattach: reattach,
    resumeStrategy,
    canResumeSession: supported && Boolean(resumeStrategy),
    requiresCrashValidation: supported && descriptor.requiresCrashValidation === true,
    validation: supported ? text(descriptor.validation) : '',
    transcriptLost: transcriptLossReason !== 'none',
    transcriptLossReason,
    decision: decision ? decision.decision : '',
    infraOutcome: decision ? 'unsupported' : '',
    rationale: decision ? decision.rationale : '',
    adapterValidation,
  });
}
