/**
 * Client-less recovery scheduler (leaf R15).
 *
 * A server-side tick that offers `interrupted` chat runs to the automatic
 * resume path of R14 (`resumeRunIfAutomatic` -> R12 `resumeRun`, actor
 * `automatic`). It never needs a browser/WebSocket client.
 *
 * Guarantees:
 * - **One attempt.** The idempotency key is per logical run, and a run that
 *   already holds an `auto-` stored result is skipped (`attempt_already_made`),
 *   so a failed launch, a restart or a repeated tick never relaunches.
 * - **Max interruption age.** A run interrupted longer ago than `maxAgeMs` is
 *   left for a human (`too_old`).
 * - **Concurrency.** At most `maxConcurrent` automatic resumes are in flight
 *   (automatic runs in `recovering`, `starting` or `running`, plus this tick's
 *   launches); the rest wait for a later tick (`concurrency_limit`).
 * - **Separate backoff.** A transient refusal (limits, stopping, family,
 *   liveness not yet confirmed) is deferred with its own exponential backoff,
 *   kept in memory per run and independent from failure/backoff accounting of
 *   runs, watcher and delegations. After `maxDeferrals` the run is left to a
 *   human (`deferrals_exhausted`). A refusal is not an attempt.
 * - **Gates are not bypassed.** Stop/cancel, waiting (question/approval) and
 *   the workflow/watcher lock are pre-checked here; mode, liveness, adapter,
 *   family, stopping and cost/harness/permission limits are enforced by
 *   R14/R12. `unknown` runs are never resumed automatically.
 */

import { listRuns } from './recovery-store.ts';
import { getRunWaiting, isRunCancelled } from './recovery-queue.ts';
import { automaticResumeKey, resumeRunIfAutomatic } from './recovery-policy.ts';

export const RECOVERY_SCHEDULER_DEFAULTS = Object.freeze({
  intervalMs: 15_000,
  // Ceiling of the tick-failure backoff (a permanently broken store).
  errorBackoffCapMs: 5 * 60_000,
  maxAgeMs: 10 * 60_000,
  maxConcurrent: 1,
  backoffBaseMs: 15_000,
  backoffCapMs: 240_000,
  maxDeferrals: 5,
  scanLimit: 200,
});

/** Resume statuses that are temporary refusals (deferred, not an attempt). */
const TRANSIENT_STATUSES = new Set(['limit_blocked', 'stopping', 'family_blocked', 'liveness_unknown', 'conflict', 'executor_alive', 'reattach_deferred']);
/** Policy reasons that may change shortly (deferred with backoff). */
const TRANSIENT_POLICY_REASONS = new Set(['liveness_not_confirmed_dead']);
/** `listRuns` clamps every query to this many rows. */
const STORE_MAX_PAGE_SIZE = 1000;

function positive(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function interruptedAtMs(run: Record<string, any> | null | undefined) {
  const ms = Date.parse(String(run?.updatedAt || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function isAutomaticActive(run: Record<string, any>) {
  if (!['recovering', 'starting', 'running'].includes(run?.state)) return false;
  if (run.resumeActor !== 'automatic') return false;
  return Boolean(run.resumeRequests?.[automaticResumeKey(run.logicalRunId)]);
}

function countAutomaticActiveRuns(store: Record<string, any> | undefined, pageSize: number) {
  const safePageSize = Math.min(pageSize, STORE_MAX_PAGE_SIZE);
  let count = 0;
  for (const state of ['recovering', 'starting', 'running']) {
    for (let offset = 0; ; offset += safePageSize) {
      const page = listRuns({ family: 'chat', state, resumeActor: 'automatic', limit: safePageSize, offset }, store);
      count += page.filter(isAutomaticActive).length;
      if (page.length < safePageSize) break;
    }
  }
  return count;
}

/**
 * @param {{
 *   store?: object,
 *   now?: () => number,
 *   loadSettings: () => object,
 *   resumeService: { resumeRun: Function },
 *   probeLiveness: (input: { run: object }) => string,
 *   getCapabilities: (harness: string) => object,
 *   isAdapterValidated?: (harness: string) => boolean,
 *   isLocked?: (input: { run: object }) => boolean,
 *   isReady?: () => boolean,
 *   onError?: (error: unknown) => void,
 *   maxAgeMs?: number, maxConcurrent?: number, backoffBaseMs?: number,
 *   backoffCapMs?: number, maxDeferrals?: number, scanLimit?: number,
 *   errorBackoffCapMs?: number,
 * }} deps
 */
export function createRecoveryScheduler(deps: { store?: Record<string, any>, now?: () => number, loadSettings: () => Record<string, any>, resumeService: { resumeRun: Function }, probeLiveness: (input: { run: Record<string, any> }) => string, getCapabilities: (harness: string) => Record<string, any>, isAdapterValidated?: (harness: string) => boolean, isLocked?: (input: { run: Record<string, any> }) => boolean, isReady?: () => boolean, onError?: (error: unknown) => void, maxAgeMs?: number, maxConcurrent?: number, backoffBaseMs?: number, backoffCapMs?: number, maxDeferrals?: number, scanLimit?: number, errorBackoffCapMs?: number, }) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const cfg = {
    maxAgeMs: positive(deps.maxAgeMs, RECOVERY_SCHEDULER_DEFAULTS.maxAgeMs),
    maxConcurrent: Math.floor(positive(deps.maxConcurrent, RECOVERY_SCHEDULER_DEFAULTS.maxConcurrent)),
    backoffBaseMs: positive(deps.backoffBaseMs, RECOVERY_SCHEDULER_DEFAULTS.backoffBaseMs),
    backoffCapMs: positive(deps.backoffCapMs, RECOVERY_SCHEDULER_DEFAULTS.backoffCapMs),
    maxDeferrals: Math.floor(positive(deps.maxDeferrals, RECOVERY_SCHEDULER_DEFAULTS.maxDeferrals)),
    scanLimit: Math.floor(positive(deps.scanLimit, RECOVERY_SCHEDULER_DEFAULTS.scanLimit)),
  };
  const deferrals: Map<string, { count: number, nextAt: number }> = new Map();
  let ticking = false;
  let stopped = false;

  function defer(run: Record<string, any>, reason: string) {
    const prev = deferrals.get(run.logicalRunId) || { count: 0, nextAt: 0 };
    const count = prev.count + 1;
    const delay = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (count - 1));
    deferrals.set(run.logicalRunId, { count, nextAt: now() + delay });
    return { logicalRunId: run.logicalRunId, action: 'deferred', reason, nextAt: now() + delay };
  }

  /** Pre-claim scheduler gates; returns a skip decision or null. */
  function precheck(run: Record<string, any>) {
    const id = run.logicalRunId;
    const skip = (reason: string) => ({ logicalRunId: id, action: 'skipped', reason });
    if (run.resumeRequests && run.resumeRequests[automaticResumeKey(id)]) return skip('attempt_already_made');
    if (isRunCancelled(id, deps.store) || run.state === 'cancelled') return skip('cancelled');
    if (getRunWaiting(id, deps.store)) return skip('waiting');
    if (run.runStoppingAt) return skip('stopping');
    const age = now() - interruptedAtMs(run);
    if (!Number.isFinite(age) || age > cfg.maxAgeMs) return skip('too_old');
    if (typeof deps.isLocked === 'function' && deps.isLocked({ run })) return skip('workflow_locked');
    const d = deferrals.get(id);
    if (d && d.count >= cfg.maxDeferrals) return skip('deferrals_exhausted');
    if (d && now() < d.nextAt) return skip('backoff');
    return null;
  }

  /**
   * One scheduler pass. Re-entrant calls while a pass runs are ignored.
   *
   * @returns {Promise<{ ran: boolean, reason?: string, decisions: object[] }>}
   */
  async function tick(): Promise<{ ran: boolean, reason?: string, decisions: Record<string, any>[] }> {
    if (ticking) return { ran: false, reason: 'tick_in_progress', decisions: [] };
    if (stopped) return { ran: false, reason: 'stopped', decisions: [] };
    if (typeof deps.isReady === 'function' && !deps.isReady()) return { ran: false, reason: 'not_ready', decisions: [] };
    ticking = true;
    const decisions = [];
    try {
      const settings = deps.loadSettings();
      let inFlight = countAutomaticActiveRuns(deps.store, cfg.scanLimit);
      const runs = [];
      const pageSize = Math.min(cfg.scanLimit, STORE_MAX_PAGE_SIZE);
      for (let offset = 0; ; offset += pageSize) {
        const page = listRuns({ family: 'chat', state: 'interrupted', limit: pageSize, offset }, deps.store);
        runs.push(...page);
        if (page.length < pageSize) break;
      }
      for (const run of runs) {
        if (stopped) {
          decisions.push({ logicalRunId: run.logicalRunId, action: 'skipped', reason: 'stopped' });
          continue;
        }
        const skipped = precheck(run);
        if (skipped) { decisions.push(skipped); continue; }
        if (inFlight >= cfg.maxConcurrent) {
          decisions.push({ logicalRunId: run.logicalRunId, action: 'skipped', reason: 'concurrency_limit' });
          continue;
        }
        const res = await resumeRunIfAutomatic({
          run, settings, resumeService: deps.resumeService,
          probeLiveness: deps.probeLiveness, getCapabilities: deps.getCapabilities,
          isAdapterValidated: deps.isAdapterValidated,
        });
        if (!res.attempted) {
          decisions.push(TRANSIENT_POLICY_REASONS.has(res.reason)
            ? defer(run, res.reason)
            : { logicalRunId: run.logicalRunId, action: 'skipped', reason: res.reason });
          continue;
        }
        if (TRANSIENT_STATUSES.has(res.reason)) {
          decisions.push(defer(run, res.reason));
          continue;
        }
        deferrals.delete(run.logicalRunId);
        if (res.reason === 'resumed') inFlight += 1;
        decisions.push({ logicalRunId: run.logicalRunId, action: 'attempted', reason: res.reason });
      }
      return { ran: true, decisions };
    } finally {
      ticking = false;
    }
  }

  /**
   * Start the periodic timer (unref'd, so it never keeps the process alive).
   * A failing tick (e.g. a permanently broken store) backs the schedule off
   * exponentially from `intervalMs`, capped at `errorBackoffCapMs`, so the log
   * and the store are not hammered every interval; the first successful tick
   * returns the schedule to `intervalMs`.
   *
   * @param {number} [intervalMs]
   * @returns {() => void} stop function
   */
  function start(intervalMs: number = RECOVERY_SCHEDULER_DEFAULTS.intervalMs): () => void {
    stopped = false;
    const baseMs = positive(intervalMs, RECOVERY_SCHEDULER_DEFAULTS.intervalMs);
    const capMs = Math.max(baseMs, positive(deps.errorBackoffCapMs, RECOVERY_SCHEDULER_DEFAULTS.errorBackoffCapMs));
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (stopped) return;
      const delay = failures === 0 ? baseMs : Math.min(capMs, baseMs * 2 ** failures);
      timer = setTimeout(() => {
        tick().then(
          () => { failures = 0; },
          (error) => {
            failures += 1;
            if (typeof deps.onError === 'function') deps.onError(error);
          }
        ).finally(schedule);
      }, delay);
      timer.unref?.();
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }

  return { tick, start, getDeferral: (id: string) => deferrals.get(id) || null };
}
