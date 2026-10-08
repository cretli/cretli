/**
 * Launch/finish lifecycle layer (leaf R5) built on the R2..R4 primitives.
 *
 * This module answers three questions that every higher recovery leaf needs a
 * single, durable source of truth for:
 *
 * 1. **Intent before launch.** `beginRunLaunch` persists the run intent (and,
 *    when the input already carries an approved prompt, durably queues it)
 *    *before* the caller is allowed to start an executor. A persistence failure
 *    is the block signal: it throws `RecoveryLifecycleError('launch_blocked')`
 *    and the caller MUST NOT launch. `mayStart:true` is only ever returned on a
 *    fully durable success path.
 * 2. **Acceptance needs proof.** A run reaches `accepted` only through
 *    `recordExecutorAck`, which requires an executor-supplied `source` and
 *    performs a CAS `starting -> running`. Without a durable executor ack the
 *    state is `unconfirmed` (`markAcceptanceUnconfirmed`), never silently
 *    `accepted`.
 * 3. **Terminal needs proof.** `finishRun` records a terminal state only when
 *    the caller supplies a `proof`; without it the run state is not written at
 *    all (`terminal_proof_required`).
 *
 * The leaf's absolute gate is `canAutoRelaunch`: without an `accepted` proof no
 * automatic relaunch is allowed, whatever the adapter decision would otherwise
 * say. Only a decision that is itself `automatic` (in practice `reattach` with a
 * live executor and a reattach-capable adapter) can pass the gate.
 *
 * History/telemetry binding is metadata-only: `attachHistoryRef` writes a
 * durable `{ chatId, seq }` reference through the store CAS patch, and
 * `buildUsageIdentity` is a pure mapper whose output is directly consumable by
 * `lib/usage/usage-contract.js#buildLogicalUsageIdentity` (`durableSequence`).
 * Like `recovery-ids.js`, this module does NOT import or modify the telemetry
 * modules; the binding is proven in tests, not by importing them here.
 *
 * Scope boundary: like the rest of `lib/recovery/**` this is a store-level
 * layer only. It has NO timers, NO `process.env`, NO runtime imports
 * (`chat-run-service.js`, `room-kernel.js`, `lib/agent-harness/*`,
 * `delegation-*`, `workspace-watcher*`, routes, `server.js`) and it implements
 * NO recovery policy, resume or reconciliation. Registering these primitives
 * into `startChatRun`, reconciliation or resume is carried by leaves
 * R6/R8/R10/R12; the recovery policy itself is R14.
 *
 * Persistence: no new SQLite tables and no schema-version bump. Acceptance,
 * terminal proof and the history reference are stored on the run row's JSON via
 * `transitionRun(..., patch)`. `RECOVERY_LIFECYCLE_SCHEMA_VERSION` versions only
 * those lifecycle sub-objects, not the base store record.
 */

import {
  getRun,
  transitionRun,
  writeRunIntent,
} from './recovery-store.js';
import {
  enqueueApprovedPrompt,
  getRunWaiting,
  isRunCancelled,
} from './recovery-queue.js';
import { createRecoveryIds, isRecoveryId } from './recovery-ids.js';
import {
  RUN_ACTIVE_STATES,
  RUN_TERMINAL_STATES,
  isTerminalRunLifecycle,
  normalizeRunInfraOutcome,
  normalizeRunLifecycleState,
  ownerOfRunFamily,
  resolveRecoveryDecision,
  resolveRunOutcome,
} from './recovery-contract.js';

/** Shape version of the lifecycle sub-objects written through `patch`. */
export const RECOVERY_LIFECYCLE_SCHEMA_VERSION = 1;

/** Acceptance states a run may hold. There is no implicit `accepted`. */
export const RUN_ACCEPTANCE_STATES = Object.freeze(['accepted', 'unconfirmed']);

/** Which executor evidence may back an `accepted` state. */
export const RUN_ACCEPTANCE_SOURCES = Object.freeze(['adapter_ack', 'lookup_request', 'manual']);

/** Which terminal evidence may back a terminal state. */
export const RUN_TERMINAL_PROOF_SOURCES = Object.freeze([
  'agent_report',
  'adapter_event',
  'probe_idle',
  'user_cancel',
  'manual',
]);

/** Error codes this layer may raise (see docs/recovery-lifecycle.md). */
export const RECOVERY_LIFECYCLE_ERROR_CODES = Object.freeze([
  'invalid_launch_input',
  'launch_blocked',
  'invalid_acceptance_input',
  'acceptance_write_failed',
  'invalid_terminal_input',
  'terminal_proof_required',
  'terminal_write_failed',
  'invalid_gate_input',
  'store_unavailable',
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Lifecycle-layer failure. `.code` is a stable machine code and `.details`
 * carries structured context (never prompt content). Logical conflicts are
 * returned as values, not thrown: only validation errors and real store/queue
 * persistence failures throw.
 */
export class RecoveryLifecycleError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [options]
   */
  constructor(message, { code = 'recovery_lifecycle_error', details = {} } = {}) {
    super(String(message));
    this.name = 'RecoveryLifecycleError';
    this.code = String(code);
    this.details = details && typeof details === 'object' ? details : {};
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoveryLifecycleError(err) {
  return err instanceof RecoveryLifecycleError;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {RecoveryLifecycleError}
 */
function lifecycleError(code, message, details = {}) {
  return new RecoveryLifecycleError(message, { code, details });
}

/**
 * Map an underlying store/queue persistence failure onto this layer's stable
 * code, preserving the source code in `details.cause`. Any lifecycle error is
 * re-thrown unchanged so an already-classified failure is not swallowed.
 *
 * @param {unknown} err
 * @param {string} failureCode
 * @param {object} [details]
 * @returns {RecoveryLifecycleError}
 */
function asWriteFailure(err, failureCode, details = {}) {
  if (isRecoveryLifecycleError(err)) return err;
  const cause = String(err?.code || err?.message || err);
  return lifecycleError(failureCode, `${err?.message || err}`, { ...details, cause });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string} an ISO timestamp; `now` may be a number (ms) or a date string
 */
function normalizeNow(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const parsed = new Date(String(value));
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

/**
 * @param {unknown} value
 * @returns {number|null} a floor integer >= 1, or null when unusable
 */
function normalizeRevision(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

/**
 * Resolve the four run ids: mint a correlated set for anything the caller did
 * not supply, and validate every supplied id against its kind. A malformed
 * supplied id is a hard `invalid_launch_input`.
 *
 * @param {object} src
 * @param {string} code the code to raise for a malformed supplied id
 * @returns {{ logicalRunId: string, attemptId: string, requestId: string, cycleId: string }}
 */
function resolveLaunchIds(src, code) {
  const minted = createRecoveryIds();
  const pick = (raw, kind, fallback) => {
    const value = text(raw);
    if (!value) return fallback;
    if (!isRecoveryId(value, kind)) {
      throw lifecycleError(code, `Invalid ${kind} id`, { field: kind, value });
    }
    return value;
  };
  return {
    logicalRunId: pick(src.logicalRunId, 'logical_run', minted.logicalRunId),
    attemptId: pick(src.attemptId, 'attempt', minted.attemptId),
    requestId: pick(src.requestId, 'request', minted.requestId),
    cycleId: pick(src.cycleId, 'cycle', minted.cycleId),
  };
}

/**
 * Validate `family`/`owner` against the contract ownership table.
 *
 * @param {object} src
 * @param {string} code
 * @returns {{ family: string, owner: string }}
 */
function resolveFamilyOwner(src, code) {
  const family = text(src.family).toLowerCase();
  const owner = text(src.owner);
  const ownerEntry = ownerOfRunFamily(family);
  if (!ownerEntry) {
    throw lifecycleError(code, `Unknown run family ${JSON.stringify(family)}`, { field: 'family' });
  }
  if (!owner || ownerEntry.owner !== owner) {
    throw lifecycleError(code, `owner does not match family ${family}`, {
      field: 'owner',
      family,
      expectedOwner: ownerEntry.owner,
    });
  }
  return { family, owner };
}

/**
 * A terminal proof must carry a known `source`; `detail`/`adapterRunId` are
 * optional metadata. Missing proof or an empty/foreign source is
 * `terminal_proof_required` — there is deliberately no default.
 *
 * @param {unknown} value
 * @returns {{ source: string, detail: string, adapterRunId: string }}
 */
function buildTerminalProof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw lifecycleError('terminal_proof_required', 'A terminal proof with a source is required', {
      field: 'proof',
    });
  }
  const source = text(value.source).toLowerCase();
  if (!RUN_TERMINAL_PROOF_SOURCES.includes(source)) {
    throw lifecycleError(
      'terminal_proof_required',
      `Terminal proof source ${JSON.stringify(text(value.source))} is not a known proof`,
      { field: 'proof.source', allowed: RUN_TERMINAL_PROOF_SOURCES }
    );
  }
  return { source, detail: text(value.detail), adapterRunId: text(value.adapterRunId) };
}

// ---------------------------------------------------------------------------
// A. beginRunLaunch — intent before launch
// ---------------------------------------------------------------------------

/**
 * Persist the launch intent *before* any prompt reaches an executor.
 *
 * In order it: validates family/owner and ids, writes the run intent
 * (`writeRunIntent`, state `starting` + first attempt), and — when the input
 * carries an approved prompt — durably queues it (`enqueueApprovedPrompt`)
 * before returning the launch token. Metadata only: the prompt content is never
 * echoed into the returned `launchToken`, and the base store keeps intent rows
 * metadata-only.
 *
 * **Contract for the caller:** a non-throwing return is the ONLY point at which
 * launching the executor is permitted. Any persistence failure throws
 * `RecoveryLifecycleError('launch_blocked')` (intent write OR queue write), and
 * the caller MUST NOT then start the executor — otherwise a crash would leave an
 * untracked or under-tracked run. `mayStart` is `true` exclusively on that
 * success path.
 *
 * Idempotency rides on `requestId`: replaying the same `requestId` with the same
 * identity returns the existing run (`created:false`, a single run row); the same
 * `requestId` bound to a different identity is surfaced as `launch_blocked`
 * (`details.cause = 'request_conflict'`) rather than silently pointing the caller
 * at a foreign run.
 *
 * Required: `family` (a `RUN_FAMILY_OWNERS` key), `owner` (matching the family).
 * Optional ids (minted when absent): `logicalRunId`, `attemptId`, `requestId`,
 * `cycleId`. Optional metadata: `chatId`, `workspaceFolder`, `harness`, `model`,
 * `sessionId`, `instanceToken`, `generation`, `mode`, `now`. Optional approved
 * prompt: `prompt` or `promptRef`.
 *
 * @param {object} input
 * @param {object} [store] process-default store when omitted
 * @returns {{
 *   created: boolean,
 *   ids: { logicalRunId: string, attemptId: string, requestId: string, cycleId: string },
 *   run: object,
 *   attempt: object,
 *   queueEntry: object|null,
 *   mayStart: true,
 *   launchToken: { logicalRunId: string, attemptId: string, requestId: string, state: string, createdAt: string },
 * }}
 * @throws {RecoveryLifecycleError} `invalid_launch_input` | `launch_blocked`
 */
export function beginRunLaunch(input, store) {
  const src = input && typeof input === 'object' ? input : {};
  const { family, owner } = resolveFamilyOwner(src, 'invalid_launch_input');
  const ids = resolveLaunchIds(src, 'invalid_launch_input');

  const intentInput = {
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family,
    owner,
    chatId: text(src.chatId),
    workspaceFolder: text(src.workspaceFolder),
    harness: text(src.harness),
    model: text(src.model),
    sessionId: text(src.sessionId),
    instanceToken: text(src.instanceToken),
    generation: src.generation,
    mode: text(src.mode),
    now: src.now,
  };

  /** @type {{ created: boolean, run: object, attempt: object }} */
  let intent;
  try {
    intent = writeRunIntent(intentInput, store);
  } catch (err) {
    // Any store failure is the block signal: the caller must not launch.
    throw asWriteFailure(err, 'launch_blocked', {
      logicalRunId: ids.logicalRunId,
      requestId: ids.requestId,
    });
  }

  const run = intent.run || {};
  const hasPrompt =
    (src.prompt !== undefined && src.prompt !== null) || text(src.promptRef) !== '';

  /** @type {object|null} */
  let queueEntry = null;
  if (hasPrompt) {
    // Durably queue the approved prompt BEFORE returning the launch token. A
    // queue failure is likewise a block-ACK: no partial start is pretended.
    try {
      const enqueued = enqueueApprovedPrompt(
        {
          logicalRunId: ids.logicalRunId,
          attemptId: ids.attemptId,
          requestId: ids.requestId,
          family,
          owner,
          chatId: intentInput.chatId,
          workspaceFolder: intentInput.workspaceFolder,
          harness: intentInput.harness,
          model: intentInput.model,
          mode: intentInput.mode,
          prompt: src.prompt,
          promptRef: text(src.promptRef),
          now: src.now,
        },
        store
      );
      queueEntry = enqueued.entry;
    } catch (err) {
      throw asWriteFailure(err, 'launch_blocked', {
        logicalRunId: ids.logicalRunId,
        requestId: ids.requestId,
        stage: 'queue',
      });
    }
  }

  return {
    created: intent.created,
    ids,
    run,
    attempt: intent.attempt,
    queueEntry,
    mayStart: true,
    // Metadata-only token; never carries the prompt body.
    launchToken: {
      logicalRunId: ids.logicalRunId,
      attemptId: ids.attemptId,
      requestId: ids.requestId,
      state: text(run.state),
      createdAt: text(run.createdAt),
    },
  };
}

// ---------------------------------------------------------------------------
// B. recordExecutorAck — accepted only with executor evidence
// ---------------------------------------------------------------------------

/**
 * Move a run from `starting` to `running` with an `accepted` proof, using a CAS
 * that requires the caller's `expectedRevision` and the current `starting`
 * state. Acceptance is stored on the run JSON (`patch.acceptance`), never as a
 * separate table.
 *
 * - a run whose `acceptance.state` is already `accepted` returns
 *   `{ applied:false, reason:'already_accepted' }` with NO write (revision does
 *   not grow);
 * - a terminal run cannot be "accepted" — it returns a conflict
 *   (`reason:'illegal_transition'`) without any transition attempt;
 * - a CAS conflict (revision/state drift) is returned as `{ conflict:true }`, not
 *   thrown; only a real store failure throws
 *   `RecoveryLifecycleError('acceptance_write_failed')`.
 *
 * Required: `logicalRunId`, `expectedRevision`, `source` (a
 * `RUN_ACCEPTANCE_SOURCES` value). Optional: `adapterRunId`, `now`.
 *
 * @param {{
 *   logicalRunId: string,
 *   expectedRevision: number,
 *   source: unknown,
 *   adapterRunId?: unknown,
 *   now?: number|string,
 * }} input
 * @param {object} [store]
 * @returns {{ applied: boolean, conflict: boolean, reason: string, run: object|null, acceptance: object|null }}
 * @throws {RecoveryLifecycleError} `invalid_acceptance_input` | `acceptance_write_failed`
 */
export function recordExecutorAck(input, store) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  if (!isRecoveryId(logicalRunId, 'logical_run')) {
    throw lifecycleError('invalid_acceptance_input', 'Invalid acceptance input: logicalRunId', {
      field: 'logicalRunId',
    });
  }
  const expectedRevision = normalizeRevision(src.expectedRevision);
  if (expectedRevision === null) {
    throw lifecycleError('invalid_acceptance_input', 'Invalid acceptance input: expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const source = text(src.source).toLowerCase();
  if (!RUN_ACCEPTANCE_SOURCES.includes(source)) {
    throw lifecycleError(
      'invalid_acceptance_input',
      `Acceptance source ${JSON.stringify(text(src.source))} is not a known evidence kind`,
      { field: 'source', allowed: RUN_ACCEPTANCE_SOURCES }
    );
  }

  try {
    const run = getRun(logicalRunId, store);
    if (run && run.acceptance && text(run.acceptance.state) === 'accepted') {
      return { applied: false, conflict: false, reason: 'already_accepted', run, acceptance: run.acceptance };
    }
    if (run && isTerminalRunLifecycle(run.state)) {
      // A terminal run must not be re-opened into `accepted`.
      return { applied: false, conflict: true, reason: 'illegal_transition', run, acceptance: null };
    }
    const acceptance = {
      schemaVersion: RECOVERY_LIFECYCLE_SCHEMA_VERSION,
      state: 'accepted',
      source,
      adapterRunId: text(src.adapterRunId),
      ackedAt: normalizeNow(src.now),
    };
    const result = transitionRun(
      {
        logicalRunId,
        expectedRevision,
        to: 'running',
        expectedState: 'starting',
        infraOutcome: 'accepted',
        patch: { acceptance },
        now: src.now,
      },
      store
    );
    if (!result.applied) {
      return {
        applied: false,
        conflict: true,
        reason: result.reason,
        run: result.run || null,
        acceptance: null,
      };
    }
    return { applied: true, conflict: false, reason: 'applied', run: result.run, acceptance };
  } catch (err) {
    throw asWriteFailure(err, 'acceptance_write_failed', { logicalRunId });
  }
}

// ---------------------------------------------------------------------------
// C. markAcceptanceUnconfirmed — explicit "no proof yet"
// ---------------------------------------------------------------------------

/**
 * Record that a run has NO acceptance proof yet (the crash window between launch
 * and ack). The run does NOT change state — it stays in its current state
 * (normally `starting`); this is a self-transition that only stamps
 * `patch.acceptance = { state:'unconfirmed', ... }`. Because the state is
 * preserved, this never lies about the run having started.
 *
 * The `unconfirmed` state feeds `canAutoRelaunch`: `accepted` is the only
 * acceptance value that can clear the gate.
 *
 * Required: `logicalRunId`, `expectedRevision`, a non-empty `reasonToken`.
 * Optional: `now`.
 *
 * @param {{
 *   logicalRunId: string,
 *   expectedRevision: number,
 *   reasonToken: unknown,
 *   now?: number|string,
 * }} input
 * @param {object} [store]
 * @returns {{ applied: boolean, conflict: boolean, reason: string, run: object|null, acceptance: object|null }}
 * @throws {RecoveryLifecycleError} `invalid_acceptance_input` | `acceptance_write_failed`
 */
export function markAcceptanceUnconfirmed(input, store) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  if (!isRecoveryId(logicalRunId, 'logical_run')) {
    throw lifecycleError('invalid_acceptance_input', 'Invalid acceptance input: logicalRunId', {
      field: 'logicalRunId',
    });
  }
  const expectedRevision = normalizeRevision(src.expectedRevision);
  if (expectedRevision === null) {
    throw lifecycleError('invalid_acceptance_input', 'Invalid acceptance input: expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const reasonToken = text(src.reasonToken);
  if (!reasonToken) {
    throw lifecycleError('invalid_acceptance_input', 'Invalid acceptance input: reasonToken', {
      field: 'reasonToken',
    });
  }

  try {
    const run = getRun(logicalRunId, store);
    if (!run) {
      return { applied: false, conflict: true, reason: 'not_found', run: null, acceptance: null };
    }
    const acceptance = {
      schemaVersion: RECOVERY_LIFECYCLE_SCHEMA_VERSION,
      state: 'unconfirmed',
      reason: reasonToken,
      markedAt: normalizeNow(src.now),
    };
    // Self-transition: `to` equals the current state so the lifecycle is not
    // moved, only the acceptance metadata is stamped.
    const result = transitionRun(
      {
        logicalRunId,
        expectedRevision,
        to: run.state,
        expectedState: run.state,
        patch: { acceptance },
        now: src.now,
      },
      store
    );
    if (!result.applied) {
      return {
        applied: false,
        conflict: true,
        reason: result.reason,
        run: result.run || null,
        acceptance: null,
      };
    }
    return { applied: true, conflict: false, reason: 'applied', run: result.run, acceptance };
  } catch (err) {
    throw asWriteFailure(err, 'acceptance_write_failed', { logicalRunId });
  }
}

// ---------------------------------------------------------------------------
// D. finishRun — terminal state requires terminal proof
// ---------------------------------------------------------------------------

/**
 * Record a terminal outcome, gated on a durable terminal proof.
 *
 * - `to` MUST be a `RUN_TERMINAL_STATES` value; a non-terminal `to` is
 *   `invalid_terminal_input`.
 * - `proof` MUST carry a `source` from `RUN_TERMINAL_PROOF_SOURCES`; a missing
 *   or empty/foreign proof is `terminal_proof_required` and NO terminal state is
 *   written. This is the leaf's core rule.
 * - the server owns `infraOutcome` (normalized, required, never overwritten by an
 *   agent report); `agentOutcome`/`agentVerdict` are recorded as metadata only and
 *   feed `resolveRunOutcome`, which never lets the report rewrite the server truth.
 * - `reason` is forwarded to the CAS only for an `interrupted` finish with a
 *   caller-supplied reason; for `completed`/`cancelled` nothing is injected (so
 *   the reason is never spuriously set to `'unknown'`).
 * - a run already terminal with the SAME `to` returns `{ applied:false,
 *   reason:'already_terminal' }` with no second write; with a DIFFERENT `to` it
 *   returns a conflict (`illegal_transition`) with no mutation — the lifecycle is
 *   final for finishing even though the base matrix would otherwise tolerate an
 *   `interrupted -> completed` edge.
 * - a CAS conflict is returned, not thrown; only a store failure throws
 *   `RecoveryLifecycleError('terminal_write_failed')`.
 *
 * Required: `logicalRunId`, `expectedRevision`, `to`, `proof`, `infraOutcome`.
 * Optional: `reason`, `agentOutcome`, `agentVerdict`, `now`.
 *
 * @param {object} input
 * @param {object} [store]
 * @returns {{
 *   applied: boolean,
 *   conflict: boolean,
 *   reason: string,
 *   run: object|null,
 *   outcome: object|null,
 * }}
 * @throws {RecoveryLifecycleError} `invalid_terminal_input` | `terminal_proof_required` | `terminal_write_failed`
 */
export function finishRun(input, store) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  if (!isRecoveryId(logicalRunId, 'logical_run')) {
    throw lifecycleError('invalid_terminal_input', 'Invalid terminal input: logicalRunId', {
      field: 'logicalRunId',
    });
  }
  const expectedRevision = normalizeRevision(src.expectedRevision);
  if (expectedRevision === null) {
    throw lifecycleError('invalid_terminal_input', 'Invalid terminal input: expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const to = normalizeRunLifecycleState(src.to);
  if (!to || !RUN_TERMINAL_STATES.includes(to)) {
    throw lifecycleError(
      'invalid_terminal_input',
      `finishRun target ${JSON.stringify(text(src.to))} must be a terminal state`,
      { field: 'to', allowed: RUN_TERMINAL_STATES }
    );
  }
  if (text(src.infraOutcome) === '') {
    throw lifecycleError('invalid_terminal_input', 'Invalid terminal input: infraOutcome', {
      field: 'infraOutcome',
    });
  }
  // Validate proof before reading/writing so a proof-less finish never mutates.
  const proof = buildTerminalProof(src.proof);
  const infraOutcome = normalizeRunInfraOutcome(src.infraOutcome);

  try {
    const run = getRun(logicalRunId, store);
    if (run && isTerminalRunLifecycle(run.state)) {
      if (text(run.state) === to) {
        const outcome = resolveRunOutcome({
          infraOutcome: run.infraOutcome,
          agentOutcome: run.agentOutcome,
          agentVerdict: run.agentVerdict,
        });
        return { applied: false, conflict: false, reason: 'already_terminal', run, outcome };
      }
      return {
        applied: false,
        conflict: true,
        reason: 'illegal_transition',
        run,
        outcome: null,
      };
    }

    const terminalProof = {
      schemaVersion: RECOVERY_LIFECYCLE_SCHEMA_VERSION,
      source: proof.source,
      detail: proof.detail,
      adapterRunId: proof.adapterRunId,
      state: to,
      recordedAt: normalizeNow(src.now),
    };
    const casInput = {
      logicalRunId,
      expectedRevision,
      to,
      infraOutcome,
      patch: { terminalProof },
      now: src.now,
    };
    // Only an `interrupted` finish carries a reason, and only when the caller
    // actually supplied one — never inject `'unknown'` into completed/cancelled.
    if (to === 'interrupted' && text(src.reason) !== '') {
      casInput.reason = src.reason;
    }
    if (src.agentOutcome !== undefined && src.agentOutcome !== null) {
      casInput.agentOutcome = src.agentOutcome;
    }
    if (src.agentVerdict !== undefined && src.agentVerdict !== null) {
      casInput.agentVerdict = src.agentVerdict;
    }

    const result = transitionRun(casInput, store);
    const outcome = resolveRunOutcome({
      infraOutcome,
      agentOutcome: src.agentOutcome,
      agentVerdict: src.agentVerdict,
    });
    if (!result.applied) {
      return { applied: false, conflict: true, reason: result.reason, run: result.run || null, outcome: null };
    }
    return { applied: true, conflict: false, reason: 'applied', run: result.run, outcome };
  } catch (err) {
    throw asWriteFailure(err, 'terminal_write_failed', { logicalRunId });
  }
}

// ---------------------------------------------------------------------------
// E. canAutoRelaunch — the absolute "no acceptance proof, no auto relaunch" gate
// ---------------------------------------------------------------------------

/**
 * Decide whether an automatic relaunch is permitted. The rules are evaluated in
 * a fixed order and every rejection is returned as a value (`allowed:false`),
 * never thrown:
 *
 * 1. no such run -> `run_missing`
 * 2. `acceptance.state !== 'accepted'` (absent OR `unconfirmed`) ->
 *    `no_acceptance_proof` — the leaf's PRIMARY rule; it outranks the adapter
 *    decision, so even a reattach-capable live adapter cannot pass without proof
 * 3. run `cancelled` (state or durable cancel) -> `cancelled`
 * 4. run `waiting` (state or pending waiting record) -> `waiting`
 * 5. run in `RUN_ACTIVE_STATES` (`starting`/`running`) -> `still_active`
 * 6. run `completed` -> `already_completed`
 * 7. run `interrupted`/`unknown` -> delegate to `resolveRecoveryDecision`;
 *    `allowed:true` ONLY when that decision is itself `automatic` (in practice
 *    `reattach` with a live executor and a reattach-capable adapter), otherwise
 *    `manual_only` carrying the decision.
 *
 * `liveness`/`harness` are used ONLY for the case-7 delegation; they cannot lift
 * the acceptance-proof rule. A malformed input throws `invalid_gate_input`; a
 * store that cannot be read throws `store_unavailable`.
 *
 * @param {{ logicalRunId?: unknown, liveness?: unknown, harness?: unknown }} [input]
 * @param {object} [store]
 * @returns {{
 *   allowed: boolean,
 *   reason: string,
 *   decision?: string,
 *   rationale: string,
 * }}
 * @throws {RecoveryLifecycleError} `invalid_gate_input` | `store_unavailable`
 */
export function canAutoRelaunch(input = {}, store) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  if (!logicalRunId) {
    throw lifecycleError('invalid_gate_input', 'canAutoRelaunch requires a logicalRunId', {
      field: 'logicalRunId',
    });
  }

  try {
    const run = getRun(logicalRunId, store);
    if (!run) {
      return { allowed: false, reason: 'run_missing', rationale: 'Brak runu o podanym logicalRunId.' };
    }

    const state = text(run.state);
    const acceptanceState = run.acceptance ? text(run.acceptance.state) : '';

    // Rule 2 — the load-bearing gate, evaluated before any state/adapter logic.
    if (acceptanceState !== 'accepted') {
      return {
        allowed: false,
        reason: 'no_acceptance_proof',
        rationale: acceptanceState
          ? `Stan akceptacji to '${acceptanceState}'; brak dowodu accepted.`
          : 'Run nie ma dowodu akceptacji (acceptance nie zostalo zapisane).',
      };
    }

    // Rule 3 — durable/user cancel.
    if (state === 'cancelled' || isRunCancelled(logicalRunId, store)) {
      return { allowed: false, reason: 'cancelled', rationale: 'Run anulowany trwale; Stop zakazuje wznowienia.' };
    }

    // Rule 4 — waiting on a human answer.
    if (state === 'waiting' || getRunWaiting(logicalRunId, store)) {
      return { allowed: false, reason: 'waiting', rationale: 'Run czeka na odpowiedz czlowieka; brak auto-wznowienia.' };
    }

    // Rule 5 — still active.
    if (RUN_ACTIVE_STATES.includes(state)) {
      return { allowed: false, reason: 'still_active', rationale: `Run jest aktywny (${state}); nie ma czego restartowac.` };
    }

    // Rule 6 — completed.
    if (state === 'completed') {
      return { allowed: false, reason: 'already_completed', rationale: 'Run ukonczony; nie ponawiamy automatycznie.' };
    }

    // Rule 7 — interrupted / unknown: consult the adapter decision, but an
    // automatic decision alone is not enough without the acceptance proof (which
    // has already been confirmed above).
    const harness = text(src.harness);
    const decision = resolveRecoveryDecision({
      reason: run.reason,
      adapter: harness,
      harness,
      liveness: src.liveness,
    });
    if (decision.automatic === true) {
      return { allowed: true, reason: decision.decision, decision: decision.decision, rationale: decision.rationale };
    }
    return {
      allowed: false,
      reason: 'manual_only',
      decision: decision.decision,
      rationale: decision.rationale,
    };
  } catch (err) {
    throw asWriteFailure(err, 'store_unavailable', { logicalRunId });
  }
}

// ---------------------------------------------------------------------------
// F. attachHistoryRef — durable link to chat history
// ---------------------------------------------------------------------------

/**
 * Attach a durable history reference `{ chatId, seq }` to the run through a
 * self-transition (no lifecycle change). `seq` must be an integer > 0 and
 * `chatId` non-empty; a malformed reference raises the validation code
 * `invalid_terminal_input` (the same input-validation code family used elsewhere
 * in this leaf — see docs/recovery-lifecycle.md). A CAS conflict is returned; a
 * store that cannot be read/written throws `store_unavailable`.
 *
 * Required: `logicalRunId`, `expectedRevision`, `history: { chatId, seq }`.
 * Optional: `now`.
 *
 * @param {{
 *   logicalRunId: string,
 *   expectedRevision: number,
 *   history?: { chatId?: unknown, seq?: unknown },
 *   now?: number|string,
 * }} input
 * @param {object} [store]
 * @returns {{ applied: boolean, conflict: boolean, reason: string, run: object|null, history: object|null }}
 * @throws {RecoveryLifecycleError} `invalid_terminal_input` | `store_unavailable`
 */
export function attachHistoryRef(input, store) {
  const src = input && typeof input === 'object' ? input : {};
  const logicalRunId = text(src.logicalRunId);
  if (!isRecoveryId(logicalRunId, 'logical_run')) {
    throw lifecycleError('invalid_terminal_input', 'Invalid history input: logicalRunId', {
      field: 'logicalRunId',
    });
  }
  const expectedRevision = normalizeRevision(src.expectedRevision);
  if (expectedRevision === null) {
    throw lifecycleError('invalid_terminal_input', 'Invalid history input: expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const history = src.history && typeof src.history === 'object' ? src.history : {};
  const chatId = text(history.chatId);
  const seq = Number(history.seq);
  if (!chatId) {
    throw lifecycleError('invalid_terminal_input', 'Invalid history input: history.chatId', {
      field: 'history.chatId',
    });
  }
  if (!Number.isInteger(seq) || seq <= 0) {
    throw lifecycleError('invalid_terminal_input', 'Invalid history input: history.seq must be an integer > 0', {
      field: 'history.seq',
      seq: history.seq,
    });
  }

  try {
    const run = getRun(logicalRunId, store);
    if (!run) {
      return { applied: false, conflict: true, reason: 'not_found', run: null, history: null };
    }
    const record = {
      schemaVersion: RECOVERY_LIFECYCLE_SCHEMA_VERSION,
      chatId,
      seq,
      attachedAt: normalizeNow(src.now),
    };
    // Self-transition keeps the state, stamps only the history reference.
    const result = transitionRun(
      {
        logicalRunId,
        expectedRevision,
        to: run.state,
        expectedState: run.state,
        patch: { history: record },
        now: src.now,
      },
      store
    );
    if (!result.applied) {
      return { applied: false, conflict: true, reason: result.reason, run: result.run || null, history: null };
    }
    return { applied: true, conflict: false, reason: 'applied', run: result.run, history: record };
  } catch (err) {
    throw asWriteFailure(err, 'store_unavailable', { logicalRunId });
  }
}

/**
 * Pure mapper from recovery ids to the `buildLogicalUsageIdentity` input shape.
 * No I/O, no store, no telemetry import. It does NOT shorten or transform ids
 * (the R2 header guarantees they are single trimmed tokens the telemetry
 * normalizers accept unchanged). The result is directly consumable: passing it to
 * `lib/usage/usage-contract.js#buildLogicalUsageIdentity` yields
 * `identityClass === 'durable_sequence'`.
 *
 * @param {{
 *   logicalRunId?: unknown,
 *   attemptId?: unknown,
 *   sessionId?: unknown,
 *   requestId?: unknown,
 *   harness?: unknown,
 * }} [input]
 * @returns {{
 *   durableSequence: true,
 *   runId: unknown,
 *   attemptId: unknown,
 *   sourceSessionId: unknown,
 *   requestId: unknown,
 *   harness: unknown,
 * }}
 */
export function buildUsageIdentity(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    durableSequence: true,
    runId: src.logicalRunId,
    attemptId: src.attemptId,
    sourceSessionId: src.sessionId,
    requestId: src.requestId,
    harness: src.harness,
  };
}
