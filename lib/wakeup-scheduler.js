/**
 * Generic wake-up scheduler. It owns the tick loop, the state machine on the
 * durable store and the outcome classification, and nothing else: it never
 * knows what a chat or a delegation is. A kind plugs in through the registry:
 *
 *   {
 *     kind, getSettings(), normalize(row), resolveDueAt(record, settings),
 *     selectCandidates({ records, now, settings }) -> [{ record, dueAt }],
 *     prepare(record, ctx) -> inputs        // read-only preflight + I/O inputs
 *     decide({ record, now, dueAt, settings, prepared })
 *       -> { action: resume|defer|expire|block|skip|cancel, reason }
 *     buildRequestId(record, attempt),      // optional
 *     execute(record, ctx) -> { outcome: resumed|refund|blocked|ambiguous, reason }
 *     resolveCrash(record, ctx) -> { outcome: resumed|refund|blocked, reason }
 *   }
 *
 * Tick order: resolve `resuming` rows, then per due `armed` row prepare ->
 * decide (no writes) -> persist `resuming` BEFORE execute -> execute ->
 * classify -> notify. `defer`/`skip` never consume an attempt.
 */

import { patchWakeup, loadWakeups } from './persist/wakeups-persist.js';

export const WAKEUP_TICK_MS = 60_000;

/** States that change what the operator sees: each is announced once to the chat and the notifier. */
const ANNOUNCED_STATES = new Set(['resumed', 'blocked', 'expired']);

const TERMINAL_DECISIONS = Object.freeze({ expire: 'expired', block: 'blocked', cancel: 'cancelled' });

/**
 * @param {{
 *   dataDir?: string,
 *   now?: () => number,
 *   store?: { list: () => Record<string, any>[], patch: (id: string, fields: Record<string, any>, now: number, expectState?: string) => Record<string, any>|null },
 *   notify?: Function,
 *   announceChat?: Function,
 *   log?: Function,
 *   intervalMs?: number,
 * }} [deps]
 */
export function createWakeupScheduler(deps = {}) {
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const store = deps.store || {
    list: () => loadWakeups({ dataDir: deps.dataDir }),
    patch: (id, fields, now, expectState) => patchWakeup(id, fields, /** @type {{ dataDir?: string, now?: number }} */ ({ dataDir: deps.dataDir, now, expectState })),
  };
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  /** @type {Map<string, Record<string, any>>} */
  const kinds = new Map();
  let timer = null;
  let generation = 0;
  let tickInFlight = false;
  let lastTickAt = null;
  let activeTickMs = null;

  function registerKind(kind) {
    if (!kind?.kind) throw new Error('A wake-up kind needs a non-empty `kind`.');
    kinds.set(kind.kind, kind);
  }

  function listKinds() {
    return [...kinds.keys()];
  }

  function listKindDefinitions() {
    return [...kinds.values()];
  }

  /**
   * Display metadata of one stored row via the kind's optional pure
   * `describeRow` hook; a kind without it, or a failing hook, yields a null due time.
   *
   * @param {Record<string, any>} row stored wake-up row
   * @returns {{ dueAt: string|null, details: Record<string, any>|null }} `details` is an optional kind-defined display object
   */
  function describeRow(row) {
    const kind = kinds.get(row?.kind);
    if (!kind || typeof kind.describeRow !== 'function') return { dueAt: null, details: null };
    try {
      const record = typeof kind.normalize === 'function' ? kind.normalize(row) : row;
      const described = record ? kind.describeRow(record, { now: clock(), settings: kind.getSettings(), deps }) : null;
      return {
        dueAt: described?.dueAt || null,
        details: described?.details && typeof described.details === 'object' ? described.details : null,
      };
    } catch {
      return { dueAt: null, details: null };
    }
  }

  async function emit(hook, payload) {
    const fn = deps[hook];
    if (typeof fn !== 'function') {
      log(`wakeup-${hook}`, payload);
      return;
    }
    try {
      await fn(payload);
    } catch (err) {
      log(`wakeup-${hook}-failed`, { id: payload.record?.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** One notify per state change; `announceChat` only for operator-visible states. */
  async function settle(event, record, reason) {
    await emit('notify', { event, record, reason });
    if (ANNOUNCED_STATES.has(record.state)) await emit('announceChat', { event, record, reason });
  }

  function persist(id, fields, now) {
    return store.patch(id, fields, now);
  }

  /** Applies a resolved outcome (`execute` or `resolveCrash`) to the store. */
  function applyOutcome(record, result, now) {
    const attempts = Number(record.attempts) || 0;
    const pending = Number(record.pendingAttempt) || 0;
    const reason = String(result.reason || '');
    if (result.outcome === 'resumed') {
      return persist(record.id, {
        state: 'resumed', reason: '', attempts: Math.max(attempts, pending), pendingAttempt: 0,
        lastResumeAt: new Date(now).toISOString(),
      }, now);
    }
    if (result.outcome === 'refund') {
      return persist(record.id, {
        state: 'armed', reason: '', attempts: Math.max(0, attempts - 1), pendingAttempt: 0, resumeRequestId: '',
      }, now);
    }
    if (result.outcome === 'blocked') {
      return persist(record.id, { state: 'blocked', reason, pendingAttempt: 0 }, now);
    }
    return null;
  }

  async function resolveResuming(kind, record, ctx) {
    let result;
    try {
      result = await kind.resolveCrash(record, ctx);
    } catch (err) {
      // No answer is not "not accepted": leave the row for the next tick.
      log('wakeup-resolve-failed', { id: record.id, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const updated = applyOutcome(record, result || {}, ctx.now);
    if (updated) await settle(`crash_${result.outcome}`, updated, result.reason || '');
  }

  async function processCandidate(kind, candidate, ctx) {
    const { record, dueAt } = candidate;
    const prepared = await kind.prepare(record, ctx);
    const decision = kind.decide({ record, now: ctx.now, dueAt, settings: ctx.settings, prepared });
    if (decision.action === 'resume') return { resume: true, record, decision };
    const state = TERMINAL_DECISIONS[decision.action];
    if (state) {
      const updated = persist(record.id, { state, reason: decision.reason, pendingAttempt: 0 }, ctx.now);
      if (updated) await settle(state, updated, decision.reason);
    }
    return { resume: false, decision };
  }

  /** Fresh read of one row: candidates come from a snapshot that may be stale. */
  function reloadArmed(kind, id) {
    const row = store.list().find((entry) => entry.id === id && entry.kind === kind.kind);
    const record = row ? kind.normalize(row) : null;
    return record && record.state === 'armed' ? record : null;
  }

  async function executeResume(kind, snapshot, ctx) {
    // A pause cancelled while an earlier candidate ran must not be resurrected.
    const record = reloadArmed(kind, snapshot.id);
    if (!record) return false;
    const attempt = (Number(record.attempts) || 0) + 1;
    const requestId = typeof kind.buildRequestId === 'function'
      ? kind.buildRequestId(record, attempt)
      : `${kind.kind}:${record.id}:${attempt}`;
    // Persist-before-call: a crash after this write is resolved, never re-sent.
    // `persist` takes three parameters, so the trailing 'armed' guard is not forwarded (type-only cast).
    const resuming = /** @type {(...args: unknown[]) => Record<string, any>|null} */ (persist)(record.id, {
      state: 'resuming', reason: '', attempts: attempt, pendingAttempt: attempt, resumeRequestId: requestId,
    }, ctx.now, 'armed');
    if (!resuming || resuming.state !== 'resuming') return false;
    let result;
    try {
      result = await kind.execute(resuming, ctx);
    } catch (err) {
      result = { outcome: 'ambiguous', reason: err instanceof Error ? err.message : 'execute_failed' };
    }
    const updated = applyOutcome(resuming, result || {}, ctx.now);
    // `ambiguous` (or an unknown outcome) stays `resuming` for crash resolution.
    if (updated) await settle(result.outcome, updated, result.reason || '');
    return true;
  }

  /**
   * One pass over the store. Safe to call directly with an injected clock.
   *
   * @param {{ now?: number }} [options]
   * @returns {Promise<{ resumed: number }>} resume attempts started this tick
   */
  async function tick(options = {}) {
    const now = Number.isFinite(options.now) ? options.now : clock();
    let total = 0;
    for (const kind of kinds.values()) {
      // The budget is per kind: one busy kind must not starve another.
      let started = 0;
      const settings = kind.getSettings();
      const ctx = { now, settings, deps };
      const rows = store.list().filter((row) => row.kind === kind.kind);
      const records = rows.map((row) => kind.normalize(row)).filter(Boolean);
      for (const record of records.filter((r) => r.state === 'resuming')) {
        await resolveResuming(kind, record, ctx);
      }
      const maxPerTick = Math.max(1, Number(settings.maxPerTick) || 1);
      // Candidates come from the pre-resolution snapshot: a row refunded by crash
      // resolution waits for the next tick instead of re-sending in this one.
      for (const candidate of kind.selectCandidates({ records, now, settings })) {
        if (started >= maxPerTick) break;
        try {
          const step = await processCandidate(kind, candidate, ctx);
          if (!step.resume) continue;
          if (!(await executeResume(kind, step.record, ctx))) continue;
          started += 1;
          total += 1;
        } catch (err) {
          log('wakeup-candidate-failed', { id: candidate.record.id, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    lastTickAt = new Date(clock()).toISOString();
    return { resumed: total };
  }

  /**
   * Evaluates one armed row immediately, exactly as a tick would: `prepare` +
   * `decide`, then the persist-before-call path on `resume`. It never skips
   * `decide`, so a row whose condition does not hold changes nothing.
   *
   * @param {string} id wake-up row id
   * @returns {Promise<{ ok: false, code: string } | { ok: true, action: string, reason: string, started: boolean }>}
   */
  async function runNow(id) {
    const row = store.list().find((entry) => entry.id === String(id || ''));
    if (!row) return { ok: false, code: 'not_found' };
    const kind = kinds.get(row.kind);
    if (!kind) return { ok: false, code: 'unknown_kind' };
    const record = kind.normalize(row);
    if (!record || record.state !== 'armed') return { ok: false, code: 'not_armed' };
    const ctx = { now: clock(), settings: kind.getSettings(), deps };
    const dueAt = typeof kind.resolveDueAt === 'function' ? kind.resolveDueAt(record, ctx.settings) : null;
    try {
      const step = await processCandidate(kind, { record, dueAt }, ctx);
      if (!step.resume) return { ok: true, action: step.decision.action, reason: String(step.decision.reason || ''), started: false };
      const started = await executeResume(kind, step.record, ctx);
      return { ok: true, action: 'resume', reason: '', started };
    } catch (err) {
      log('wakeup-run-now-failed', { id, message: err instanceof Error ? err.message : String(err) });
      return { ok: true, action: 'defer', reason: 'run_now_failed', started: false };
    }
  }

  async function runScheduledTick(expectedGeneration) {
    if (expectedGeneration !== generation || tickInFlight) return;
    tickInFlight = true;
    try {
      await tick();
    } catch (err) {
      log('wakeup-tick-failed', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      tickInFlight = false;
    }
  }

  function start(options = {}) {
    if (timer) clearInterval(timer);
    generation += 1;
    const current = generation;
    const intervalMs = Number(options.intervalMs ?? deps.intervalMs) > 0
      ? Number(options.intervalMs ?? deps.intervalMs)
      : WAKEUP_TICK_MS;
    activeTickMs = intervalMs;
    timer = setInterval(() => { void runScheduledTick(current); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    generation += 1;
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    lastTickAt = null;
  }

  /**
   * Read-only scheduler snapshot for `GET /api/wakeups/status`.
   */
  function getStatus() {
    return {
      running: Boolean(timer),
      tickMs: activeTickMs || (Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : WAKEUP_TICK_MS),
      lastTickAt,
      kinds: [...kinds.values()].map((kind) => {
        let settings = {};
        try {
          settings = kind.getSettings?.() || {};
        } catch {
          // A failing settings read reports the default limit instead of breaking the status.
        }
        // Same derivation as tick().
        return { kind: kind.kind, maxPerTick: Math.max(1, Number(settings.maxPerTick) || 1) };
      }),
    };
  }

  return { registerKind, listKinds, listKindDefinitions, describeRow, getStatus, tick, runNow, start, stop };
}
