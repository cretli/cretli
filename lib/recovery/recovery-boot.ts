/**
 * Boot evidence classification and the bounded `unknown` re-probe plan (leaf R8)
 * built on the R1..R7 recovery primitives.
 *
 * After a process death the server owns every fact about a run: it must decide,
 * for each persisted run, whether the old attempt completed, is still alive, was
 * interrupted, is waiting for a human answer, was cancelled, cannot be probed
 * yet (`unknown`) or belongs to an adapter with no recovery contract
 * (`unsupported`). This module is the single classifier for that decision and
 * the single source for the "unknown is never guessed" rule.
 *
 * Firm boundaries:
 * - `unknown` is a *lack of proof*, never a guess. It is re-probed with a
 *   bounded exponential backoff (`resolveBootUnknownReprobe`) and, once the
 *   bounded attempts are exhausted, escalated durably instead of being treated
 *   as dead or alive.
 * - Classification only describes evidence; it never starts, resumes or
 *   reattaches anything. The recovery decision itself stays with
 *   `resolveRecoveryDecision` (R1/R14); this module reports the evidence and a
 *   durable reason.
 * - No runtime imports (`chat-run-service`, `delegation-*`,
 *   `workspace-watcher*`, routes, `server.js`). Callers inject a liveness probe
 *   and the run list, so the classifier stays deterministic and testable.
 *
 * `recordBootEvidence` persists the classification onto the run row's JSON via
 * the R2 store CAS (`transitionRun` self-patch). It writes metadata only and
 * never changes the lifecycle state.
 */

import {
  computeRecoveryBackoffMs,
  normalizeRunInterruptReason,
  normalizeRunLifecycleState,
  normalizeRunLiveness,
  resolveRecoveryAdapter,
} from './recovery-contract.ts';
import { listOpenRuns, transitionRun } from './recovery-store.ts';
import type { CodedError, ThrownLike } from './recovery-types.ts';

/** Shape version of the durable `bootEvidence` sub-object. */
export const BOOT_EVIDENCE_SCHEMA_VERSION = 1;

/**
 * Every classification a persistent run may receive at boot. The names are the
 * R8 vocabulary and are intentionally NOT the lifecycle states: `still_running`
 * and `unsupported` describe evidence the lifecycle enum does not carry.
 */
export const BOOT_EVIDENCE_STATES = Object.freeze([
  'completed',
  'still_running',
  'interrupted',
  'waiting',
  'cancelled',
  'unknown',
  'unsupported',
]);

/**
 * Durable reason behind a classification. `interrupt_reason` keeps the R1
 * interrupt vocabulary (`server_restart`, `process_gone`, ...) separately so a
 * reader can tell *why* the classifier chose `interrupted`.
 */
export const BOOT_EVIDENCE_REASONS = Object.freeze([
  'terminal_proof',
  'user_cancel',
  'alive_executor',
  'waiting_for_input',
  'unsupported_adapter',
  'dead_executor',
  'unknown_liveness',
]);

/** Default bounded backoff for re-probing `unknown` evidence. */
export const BOOT_UNKNOWN_REPROBE_BASE_MS = 15000;
export const BOOT_UNKNOWN_REPROBE_CAP_MS = 240000;
/** After this many re-probes the run is escalated, never guessed. */
export const BOOT_UNKNOWN_MAX_REPROBES = 4;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegativeInt(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Resolve the adapter descriptor from the many shapes callers have: a
 * `describeRecoveryAdapterContract` view, a raw `RECOVERY_MVP_ADAPTERS` entry, a
 * harness id or an explicit object. An unreadable descriptor is `unsupported`,
 * never a silent success.
 *
 * @param {{ adapter?: unknown, harness?: unknown }} input
 * @returns {object}
 */
function resolveAdapterDescriptor(input: { adapter?: unknown, harness?: unknown } = {}): Record<string, any> {
  const adapter = input.adapter;
  if (adapter && typeof adapter === 'object') return adapter;
  const harness = text(adapter) || text(input.harness);
  if (!harness) return Object.freeze({ supported: false, scope: 'unsupported' });
  return resolveRecoveryAdapter(harness);
}

/**
 * @param {object} descriptor
 * @param {unknown} harness
 * @returns {{ supported: boolean, harness: string }}
 */
function readAdapterSupport(descriptor: Record<string, any>, harness: unknown): { supported: boolean, harness: string } {
  const id = text(descriptor?.harness) || text(harness);
  return {
    supported: Boolean(descriptor && descriptor.supported !== false && id),
    harness: id,
  };
}

/**
 * Classify the durable evidence of one run at boot.
 *
 * Precedence (deterministic, documented in `docs/recovery-contract.md` R8):
 * 1. a durable cancel request -> `cancelled` (terminal and final),
 * 2. a durable terminal proof (or the `completed` lifecycle state) -> `completed`,
 * 3. a live executor -> `still_running`,
 * 4. a durable waiting record -> `waiting`,
 * 5. an adapter without a recovery contract -> `unsupported`,
 * 6. confirmed-dead liveness -> `interrupted` (with the R1 interrupt reason),
 * 7. anything unproven -> `unknown` (requires a bounded re-probe).
 *
 * A terminal fact always wins over liveness: once a run provably completed or
 * was cancelled, a stale probe cannot reopen it.
 *
 * @param {{
 *   state?: unknown,
 *   liveness?: unknown,
 *   reason?: unknown,
 *   adapter?: unknown,
 *   harness?: unknown,
 *   terminalProof?: unknown,
 *   cancelRequested?: unknown,
 *   waiting?: unknown,
 * }} [input]
 * @returns {{
 *   schemaVersion: number,
 *   state: string,
 *   reason: string,
 *   interruptReason: string,
 *   adapter: string,
 *   liveness: string,
 *   terminal: boolean,
 *   recoverable: boolean,
 *   requiresReprobe: boolean,
 *   requiresEscalation: boolean,
 *   rationale: string,
 * }}
 */
export function classifyBootEvidence(input: { state?: unknown, liveness?: unknown, reason?: unknown, adapter?: unknown, harness?: unknown, terminalProof?: unknown, cancelRequested?: unknown, waiting?: unknown, } = {}): { schemaVersion: number, state: string, reason: string, interruptReason: string, adapter: string, liveness: string, terminal: boolean, recoverable: boolean, requiresReprobe: boolean, requiresEscalation: boolean, rationale: string, } {
  const state = normalizeRunLifecycleState(input.state);
  const liveness = normalizeRunLiveness(input.liveness);
  const interruptReason = normalizeRunInterruptReason(input.reason);
  const cancelRequested = input.cancelRequested === true;
  const terminalProof = input.terminalProof === true || state === 'completed';
  const waiting = input.waiting === true;
  const descriptor = resolveAdapterDescriptor(input);
  const { supported, harness } = readAdapterSupport(descriptor, input.harness);
  const base = {
    schemaVersion: BOOT_EVIDENCE_SCHEMA_VERSION,
    adapter: harness,
    liveness,
    terminal: false,
    recoverable: false,
    requiresReprobe: false,
    requiresEscalation: false,
  };

  if (cancelRequested || state === 'cancelled') {
    return {
      ...base,
      state: 'cancelled',
      reason: 'user_cancel',
      interruptReason,
      terminal: true,
      rationale: 'Trwaly cancel jest terminalny i finalny; probe go nie otwiera.',
    };
  }
  if (terminalProof) {
    return {
      ...base,
      state: 'completed',
      reason: 'terminal_proof',
      interruptReason,
      terminal: true,
      rationale: 'Trwaly dowod zakonczenia; proba jest zamknieta.',
    };
  }
  if (liveness === 'alive') {
    return {
      ...base,
      state: 'still_running',
      reason: 'alive_executor',
      interruptReason,
      rationale: 'Wykonawca zywy; nie ruszamy slotu i nie wznawiamy.',
    };
  }
  if (waiting || state === 'waiting') {
    return {
      ...base,
      state: 'waiting',
      reason: 'waiting_for_input',
      interruptReason,
      rationale: 'Trwaly zapis oczekiwania; run czeka na odpowiedz, nie na recovery.',
    };
  }
  if (!supported) {
    return {
      ...base,
      state: 'unsupported',
      reason: 'unsupported_adapter',
      interruptReason,
      rationale: 'Adapter nie ma kontraktu recovery; stan jawny, nigdy ciche zero.',
    };
  }
  if (liveness === 'dead') {
    return {
      ...base,
      state: 'interrupted',
      reason: 'dead_executor',
      interruptReason,
      recoverable: true,
      rationale: 'Potwierdzona smierc wykonawcy z trwalym reason przerwania.',
    };
  }
  return {
    ...base,
    state: 'unknown',
    reason: 'unknown_liveness',
    interruptReason,
    recoverable: true,
    requiresReprobe: true,
    rationale: 'Brak dowodu zycia lub smierci; wymagany bounded re-probe, nigdy zgadywanie.',
  };
}

/**
 * Plan the next bounded re-probe of `unknown` evidence. Deterministic and
 * side-effect free: `now` is injected, and no wall clock is read.
 *
 * The delay grows exponentially (`base * 2^(attempt-1)`) and is hard capped.
 * After `maxAttempts` re-probes the plan is `escalate`: the run stays `unknown`
 * with a durable escalation reason instead of being guessed alive or dead.
 *
 * @param {{
 *   attempts?: unknown,
 *   now?: number,
 *   baseMs?: number,
 *   capMs?: number,
 *   maxAttempts?: number,
 * }} [input]
 * @returns {{
 *   action: 'reprobe' | 'escalate',
 *   attempt: number,
 *   delayMs: number,
 *   nextProbeAt: number | null,
 *   escalated: boolean,
 *   bounded: boolean,
 *   reason: string,
 *   rationale: string,
 * }}
 */
export function resolveBootUnknownReprobe(input: { attempts?: unknown, now?: number, baseMs?: number, capMs?: number, maxAttempts?: number, } = {}): { action: 'reprobe' | 'escalate', attempt: number, delayMs: number, nextProbeAt: number | null, escalated: boolean, bounded: boolean, reason: string, rationale: string, } {
  const attempts = nonNegativeInt(input.attempts);
  const maxAttempts = Math.max(1, Math.floor(Number(input.maxAttempts)) || BOOT_UNKNOWN_MAX_REPROBES);
  const baseMs = positiveMs(input.baseMs, BOOT_UNKNOWN_REPROBE_BASE_MS);
  const capMs = Math.max(baseMs, positiveMs(input.capMs, BOOT_UNKNOWN_REPROBE_CAP_MS));
  const now = Number.isFinite(input.now) ? Number(input.now) : 0;
  const attempt = attempts + 1;

  if (attempt > maxAttempts) {
    return {
      action: 'escalate',
      attempt,
      delayMs: 0,
      nextProbeAt: null,
      escalated: true,
      bounded: true,
      reason: 'unknown_reprobe_exhausted',
      rationale: `Po ${maxAttempts} probach stan pozostaje unknown; eskalacja zamiast zgadywania.`,
    };
  }
  const delayMs = Math.min(computeRecoveryBackoffMs({ failures: attempt, baseMs, capMs }), capMs);
  return {
    action: 'reprobe',
    attempt,
    delayMs,
    nextProbeAt: now + delayMs,
    escalated: false,
    bounded: delayMs <= capMs,
    reason: 'unknown_liveness',
    rationale: `Re-probe ${attempt}/${maxAttempts} za ${delayMs} ms; stan pozostaje unknown.`,
  };
}

function buildBootEvidenceAt(value: unknown) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  const parsed = new Date(typeof value === 'number' ? value : String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

/**
 * Build the durable `bootEvidence` record persisted on the run row. Pure: the
 * caller decides when it is written.
 *
 * @param {{
 *   classification?: object,
 *   attempt?: unknown,
 *   reprobeAt?: unknown,
 *   escalated?: unknown,
 *   restartIntent?: object | null,
 *   now?: unknown,
 * }} [input]
 * @returns {object}
 */
export function buildBootEvidenceRecord(input: { classification?: Record<string, any>, attempt?: unknown, reprobeAt?: unknown, escalated?: unknown, restartIntent?: Record<string, any> | null, now?: unknown, } = {}): Record<string, any> {
  const classification = input.classification && typeof input.classification === 'object'
    ? input.classification
    : classifyBootEvidence(input as Parameters<typeof classifyBootEvidence>[0]);
  const at = buildBootEvidenceAt(input.now);
  return {
    schemaVersion: BOOT_EVIDENCE_SCHEMA_VERSION,
    state: text(classification.state),
    reason: text(classification.reason),
    interruptReason: text(classification.interruptReason),
    terminal: classification.terminal === true,
    recoverable: classification.recoverable === true,
    requiresReprobe: classification.requiresReprobe === true,
    requiresEscalation: classification.requiresEscalation === true || input.escalated === true,
    attempt: nonNegativeInt(input.attempt),
    reprobeAt: text(input.reprobeAt),
    escalated: input.escalated === true,
    escalationReason: input.escalated === true ? 'unknown_reprobe_exhausted' : '',
    at,
    // R9: planned-shutdown evidence, present only when a valid consumed intent
    // was supplied. It never alters state/reason/interruptReason above.
    ...(input.restartIntent && typeof input.restartIntent === 'object'
      ? {
        restartIntent: {
          reason: text(input.restartIntent.reason),
          signal: text(input.restartIntent.signal),
          instanceId: text(input.restartIntent.instanceId),
          writtenAt: text(input.restartIntent.writtenAt),
        },
      }
      : {}),
  };
}

/**
 * Persist one classification onto a run row's JSON through the store CAS.
 * By default writes metadata only (the lifecycle state is re-applied
 * unchanged). With `interruptRun` (dead-executor proof on a `starting`/`running`
 * run) the same CAS moves the run to `interrupted` with a durable reason.
 *
 * @param {{
 *   run: object,
 *   classification?: object,
 *   attempt?: unknown,
 *   reprobeAt?: unknown,
 *   escalated?: unknown,
 *   restartIntent?: object | null,
 *   now?: unknown,
 *   store?: object,
 * }} input
 * @returns {{ ok: boolean, applied: boolean, conflict: boolean, reason: string, run: object|null, evidence: object }}
 */
export function recordBootEvidence(input: { interruptRun?: boolean, unknownRun?: boolean, run?: Record<string, any>, classification?: Record<string, any>, attempt?: unknown, reprobeAt?: unknown, escalated?: unknown, restartIntent?: Record<string, any> | null, now?: unknown, store?: Record<string, any>, } = {}): { ok: boolean, applied: boolean, conflict: boolean, reason: string, run: Record<string, any>|null, evidence: Record<string, any> } {
  const run = input.run;
  if (!run || typeof run !== 'object') {
    const error: CodedError = new Error('recordBootEvidence requires a run row');
    error.code = 'invalid_boot_evidence_input';
    throw error;
  }
  const logicalRunId = text(run.logicalRunId);
  const expectedRevision = Number(run.revision);
  if (!logicalRunId || !Number.isFinite(expectedRevision) || expectedRevision < 1) {
    const error: CodedError = new Error('recordBootEvidence requires logicalRunId and revision');
    error.code = 'invalid_boot_evidence_input';
    throw error;
  }
  const evidence = buildBootEvidenceRecord({
    classification: input.classification,
    attempt: input.attempt,
    reprobeAt: input.reprobeAt,
    escalated: input.escalated,
    restartIntent: input.restartIntent,
    now: input.now,
  });
  const result = transitionRun({
    logicalRunId,
    expectedRevision: Math.floor(expectedRevision),
    to: input.interruptRun === true ? 'interrupted' : input.unknownRun === true ? 'unknown' : text(run.state),
    expectedState: text(run.state),
    ...(input.interruptRun === true || input.unknownRun === true
      ? { reason: text(evidence.interruptReason) && evidence.interruptReason !== 'unknown' ? evidence.interruptReason : 'process_gone' }
      : {}),
    patch: { bootEvidence: evidence },
    now: input.now as string | number | undefined,
  }, input.store);
  return { ...result, evidence };
}

/** Page size used when reading every open run from the store. */
const OPEN_RUNS_PAGE_SIZE = 1000;

/**
 * Read ALL open runs by paging `listOpenRuns`, so a registry larger than one
 * page is never silently truncated (boot and re-probe must see every run).
 *
 * @param {object} [store]
 * @returns {object[]}
 */
export function listAllOpenRuns(store?: Record<string, any>, options: { includeRecovering?: boolean } = {}): Record<string, any>[] {
  const all: Record<string, any>[] = [];
  for (let offset = 0; ; offset += OPEN_RUNS_PAGE_SIZE) {
    const page = listOpenRuns({ limit: OPEN_RUNS_PAGE_SIZE, offset, includeRecovering: options.includeRecovering === true }, store);
    all.push(...page);
    if (page.length < OPEN_RUNS_PAGE_SIZE) return all;
  }
}

/**
 * Best-effort boot pass over the persisted open runs: classify each, and for
 * `unknown` write the next bounded re-probe plan (or the durable escalation).
 *
 * The recovery store is dormant unless something opened it, so an unavailable
 * store is reported, not thrown: boot reconciliation must never fail because
 * the optional registry is not there. Individual write conflicts are returned
 * per row for the caller to inspect; a store/IO failure aborts the pass.
 *
 * @param {{
 *   listRuns?: () => object[],
 *   probeLiveness?: (run: object) => { known?: boolean, busy?: boolean } | null | undefined,
 *   terminalProof?: (run: object) => boolean,
 *   waiting?: (run: object) => boolean,
 *   cancelRequested?: (run: object) => boolean,
 *   restartIntent?: object | null,
 *   now?: number,
 *   maxAttempts?: number,
 *   baseMs?: number,
 *   capMs?: number,
 *   store?: object,
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   scanned: number,
 *   recorded: number,
 *   classifications: object[],
 *   errors: object[],
 * }}
 */
export function classifyAndRecordOpenRuns(input: { listRuns?: () => Record<string, any>[], probeLiveness?: (run: Record<string, any>) => { known?: boolean, busy?: boolean } | null | undefined, terminalProof?: (run: Record<string, any>) => boolean, waiting?: (run: Record<string, any>) => boolean, cancelRequested?: (run: Record<string, any>) => boolean, claimHolderAlive?: (run: Record<string, any>) => boolean, restartIntent?: Record<string, any> | null, now?: number, maxAttempts?: number, baseMs?: number, capMs?: number, store?: Record<string, any>, } = {}): { ok: boolean, reason: string, scanned: number, recorded: number, classifications: Record<string, any>[], errors: Record<string, any>[], } {
  let runs: Record<string, any>[];
  try {
    runs = typeof input.listRuns === 'function' ? input.listRuns() : listAllOpenRuns(input.store, { includeRecovering: true });
  } catch (err) {
    return {
      ok: false,
      reason: 'store_unavailable',
      scanned: 0,
      recorded: 0,
      classifications: [],
      errors: [{
        logicalRunId: '',
        code: String((err as ThrownLike)?.code || 'store_unavailable'),
        message: err instanceof Error ? err.message : String(err || 'store_unavailable'),
      }],
    };
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const probeLiveness = typeof input.probeLiveness === 'function' ? input.probeLiveness : null;
  const isTerminalProof = typeof input.terminalProof === 'function' ? input.terminalProof : () => false;
  const isWaiting = typeof input.waiting === 'function' ? input.waiting : () => false;
  const isCancelled = typeof input.cancelRequested === 'function' ? input.cancelRequested : () => false;
  // A throwing holder probe proves nothing, so the claim is left alone.
  const claimHolderAlive = (run: Record<string, any>) => {
    try { return typeof input.claimHolderAlive === 'function' && input.claimHolderAlive(run) === true; } catch { return true; }
  };
  const classifications: Record<string, any>[] = [];
  const errors: Record<string, any>[] = [];
  let recorded = 0;

  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== 'object') continue;
    // A `recovering` run holds a resume claim. A claim whose holder is alive
    // (an in-flight resume of a live instance) is never touched.
    if (run.state === 'recovering' && claimHolderAlive(run)) continue;
    let liveness = 'unknown';
    try {
      const probe = probeLiveness ? probeLiveness(run) : null;
      if (probe && probe.known === true) liveness = probe.busy === true ? 'alive' : 'dead';
    } catch {
      // A probe that throws proves nothing: that is exactly `unknown`.
      liveness = 'unknown';
    }
    const classification = classifyBootEvidence({
      state: run.state,
      liveness,
      reason: run.reason,
      adapter: run.harness,
      terminalProof: isTerminalProof(run),
      cancelRequested: isCancelled(run),
      waiting: isWaiting(run),
    });
    const entry: { logicalRunId: string; classification: Record<string, any>; attempt: number; escalated: boolean; reprobeAt: string; recorded?: boolean; interrupted?: boolean; markedUnknown?: boolean } = { logicalRunId: text(run.logicalRunId), classification, attempt: 0, escalated: false, reprobeAt: '' };
    if (classification.state === 'unknown') {
      const previousAttempt = nonNegativeInt(run.bootEvidence?.attempt);
      const plan = resolveBootUnknownReprobe({
        attempts: previousAttempt,
        now,
        maxAttempts: input.maxAttempts,
        baseMs: input.baseMs,
        capMs: input.capMs,
      });
      entry.attempt = plan.attempt;
      entry.escalated = plan.action === 'escalate';
      entry.reprobeAt = plan.nextProbeAt == null ? '' : new Date(plan.nextProbeAt).toISOString();
    }
    // Dead-executor proof moves an in-flight run to `interrupted` in the same
    // CAS as the evidence write; `unknown` and live executors keep their state.
    const moveToInterrupted = classification.state === 'interrupted'
      && (run.state === 'starting' || run.state === 'running' || run.state === 'recovering');
    // G5: a `recovering` run found at boot lost its claim holder (the previous
    // process). Without dead-executor proof it becomes lifecycle `unknown`
    // (resumable with confirmUnknown); a live executor keeps its state.
    const moveToUnknown = run.state === 'recovering' && classification.state === 'unknown';
    try {
      const result = recordBootEvidence({
        run,
        classification,
        interruptRun: moveToInterrupted,
        unknownRun: moveToUnknown,
        attempt: entry.attempt,
        reprobeAt: entry.reprobeAt,
        escalated: entry.escalated,
        restartIntent: input.restartIntent,
        now,
        store: input.store,
      });
      if (result.ok) recorded += 1;
      if (result.ok && moveToInterrupted) entry.interrupted = true;
      if (result.ok && moveToUnknown) entry.markedUnknown = true;
      entry.recorded = result.ok === true;
      if (!result.ok) {
        errors.push({
          logicalRunId: entry.logicalRunId,
          code: result.reason || 'conflict',
          message: 'Boot evidence write lost a CAS race.',
        });
      }
    } catch (err) {
      entry.recorded = false;
      errors.push({
        logicalRunId: entry.logicalRunId,
        code: String((err as ThrownLike)?.code || 'boot_evidence_write_failed'),
        message: err instanceof Error ? err.message : String(err || 'boot_evidence_write_failed'),
      });
    }
    classifications.push(entry);
  }
  return {
    ok: errors.length === 0,
    reason: errors.length === 0 ? 'classified' : 'partial',
    scanned: classifications.length,
    recorded,
    classifications,
    errors,
  };
}

/**
 * Whether a persisted run is an `unknown` boot-evidence row whose bounded
 * re-probe is due (`reprobeAt <= now`) and not yet escalated.
 *
 * @param {object} run
 * @param {number} now
 * @returns {boolean}
 */
function isBootReprobeDue(run: Record<string, any>, now: number): boolean {
  const evidence = run?.bootEvidence;
  if (!evidence || evidence.state !== 'unknown' || evidence.escalated === true) return false;
  const dueAt = Date.parse(text(evidence.reprobeAt));
  return Number.isFinite(dueAt) && dueAt <= now;
}

/**
 * Production executor of the stored `unknown` re-probe plan: re-classifies the
 * open runs whose `reprobeAt` is due, with `attempt = previous + 1`, and writes
 * the next backoff plan or the durable escalation (`unknown_reprobe_exhausted`).
 * Best-effort and bounded by `limit` per call.
 *
 * @param {Parameters<typeof classifyAndRecordOpenRuns>[0] & { limit?: number }} [input]
 * @returns {ReturnType<typeof classifyAndRecordOpenRuns>}
 */
export function runDueBootReprobes(input: Parameters<typeof classifyAndRecordOpenRuns>[0] & { limit?: number } = {}): ReturnType<typeof classifyAndRecordOpenRuns> {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const limit = Math.max(1, Math.floor(Number(input.limit)) || 5);
  return classifyAndRecordOpenRuns({
    ...input,
    now,
    listRuns: () => {
      const runs = typeof input.listRuns === 'function' ? input.listRuns() : listAllOpenRuns(input.store);
      return (Array.isArray(runs) ? runs : []).filter((run) => isBootReprobeDue(run, now)).slice(0, limit);
    },
  });
}
