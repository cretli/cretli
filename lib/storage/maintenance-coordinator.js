/**
 * Shared maintenance coordinator (online backup now, migration next).
 *
 * One barrier protocol, in this fixed order (docs/storage-contract.md "Maintenance and recovery control"):
 *
 *   1. external pause / certification check      (refuse before touching anything)
 *   2. external lease                            (control directory, shared with the offline tools)
 *   3. close every participant gate              (HTTP, WS, background, subprocess, run launch, GC)
 *   4. drain in-flight mutations                 (provider work that cannot drain => deferred, not forced)
 *   5. flush buffers                             (failed buffers stay retained; a failed flush aborts)
 *   6. store locks in the registry's fixed order (lockOrderRank, then id; never registration order)
 *   7. journal / fence validation
 *   8. bounded staging callback                  (byte, time and event-loop budgets)
 *   9. release locks and gates, then the lease   (always, in `finally`) -- BEFORE any compression
 *
 * A participant is any writer (or writer group) of one or more registry stores:
 *
 * @typedef {Object} MaintenanceParticipant
 * @property {string} id unique writer id
 * @property {'mutation' | 'background' | 'subprocess' | 'run-launch' | 'gc'} kind
 * @property {string[]} covers registry store ids (or `gap.*` ids) this writer is responsible for
 * @property {boolean} certified true only after the writer's snapshot capability was certified
 * @property {() => void} close refuse new work (typed retryable error); must not throw
 * @property {() => void} open accept work again; must be idempotent
 * @property {(deadlineMs: number) => Promise<{ drained: boolean, active?: number, deferrable?: boolean, reason?: string }>} drain
 * @property {() => Promise<{ ok: boolean, failed?: number }>} [flush] must keep failed buffers for retry
 * @property {{ acquire: (timeoutMs: number) => Promise<void>, release: () => void }} [lock] store lock
 * @property {() => Promise<{ ok: boolean, pending?: number }>} [validate] unresolved journal/transaction check
 */

import { acquireLease, isRestorePaused, readControlState } from '../backup/offline/control-dir.js';
import { getStorageRegistry } from './store-registry.js';

/**
 * Frozen barrier budgets. A1 owns the numbers; every consumer overrides them only through
 * `createMaintenanceCoordinator({ budgets })` (tests, measured deployments).
 */
export const MAINTENANCE_BUDGETS = Object.freeze({
  /** Whole barrier: first gate closed -> last gate opened. Writers are refused (retryable) for at most this long. */
  maxBarrierMs: 20000,
  /** Waiting for in-flight mutations after the gates closed. */
  drainTimeoutMs: 8000,
  /** Flushing buffers (all participants, sequential). */
  flushTimeoutMs: 8000,
  /** Acquiring one store lock. */
  lockTimeoutMs: 3000,
  /** Largest tolerated gap between event-loop turns while staging. */
  maxEventLoopLagMs: 250,
  /** Staging copy size cap; larger datasets must stay offline (B4). */
  maxStageBytes: 1024 * 1024 * 1024,
});

export class MaintenanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MaintenanceError';
    this.code = code;
    this.details = details;
    /** True when retrying later is the right reaction (busy provider run, lease held, pause). */
    this.deferred = code === 'MAINTENANCE_DEFERRED' || code === 'MAINTENANCE_BUSY' || code === 'LEASE_HELD';
  }
}

/**
 * A mutation gate for one writer: wrap each unit of work in `run`. While closed, new work is refused
 * with a retryable `MAINTENANCE_ACTIVE`; `drain` waits only for work that already started, so a closed
 * gate cannot be starved by new arrivals and cannot deadlock the barrier.
 *
 * @param {{ id: string, kind?: MaintenanceParticipant['kind'], covers: string[], certified?: boolean,
 *   deferOnActive?: boolean, flush?: MaintenanceParticipant['flush'], lock?: MaintenanceParticipant['lock'],
 *   validate?: MaintenanceParticipant['validate'] }} options
 *   `deferOnActive` marks provider-like work that must not be waited for: an active unit defers the barrier.
 * @returns {MaintenanceParticipant & { run: <T>(fn: () => Promise<T> | T) => Promise<T>, enter: () => () => void, activeCount: () => number, isClosed: () => boolean }}
 */
export function createMutationGate(options) {
  let closed = false;
  let active = 0;
  /** @type {Array<() => void>} */
  let waiters = [];
  const settle = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };
  return {
    id: options.id,
    kind: options.kind || 'mutation',
    covers: options.covers,
    certified: options.certified !== false,
    flush: options.flush,
    lock: options.lock,
    validate: options.validate,
    close() { closed = true; },
    open() { closed = false; },
    isClosed: () => closed,
    activeCount: () => active,
    /** Enter synchronously; returns the exit function. Throws a retryable error while closed. */
    enter() {
      if (closed) throw new MaintenanceError('MAINTENANCE_ACTIVE', `writer ${options.id} is paused for maintenance; retry shortly`, { writer: options.id });
      active += 1;
      let exited = false;
      return () => {
        if (exited) return;
        exited = true;
        active -= 1;
        if (active === 0) settle();
      };
    },
    async run(fn) {
      const exit = this.enter();
      try {
        return await fn();
      } finally {
        exit();
      }
    },
    drain(deadlineMs) {
      if (active === 0) return Promise.resolve({ drained: true, active: 0 });
      if (options.deferOnActive) {
        return Promise.resolve({ drained: false, active, deferrable: true, reason: 'provider-work-active' });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== done);
          resolve({ drained: false, active });
        }, Math.max(0, deadlineMs - Date.now()));
        const done = () => { clearTimeout(timer); resolve({ drained: true, active: 0 }); };
        waiters.push(done);
      });
    },
  };
}

/**
 * Run a unit of work that spans several writers: every gate is entered up front, all-or-nothing, so the
 * barrier can never close a gate in the middle of a multi-store transaction (which would leave it half
 * applied). Refused with `MAINTENANCE_ACTIVE` before any side effect when any gate is closed.
 *
 * @template T
 * @param {Array<{ enter: () => () => void }>} gateList
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function runAcrossGates(gateList, fn) {
  /** @type {Array<() => void>} */
  const exits = [];
  try {
    for (const g of gateList) exits.push(g.enter());
  } catch (err) {
    for (const exit of exits.reverse()) exit();
    throw err;
  }
  try {
    return await fn();
  } finally {
    for (const exit of exits.reverse()) exit();
  }
}

/**
 * Every id a certified participant must cover before online mode may run: each store, each registry
 * `unknownGaps` entry (`<storeId>#unknown-gap:<index>`) and each inventory gap that blocks a consistent snapshot.
 *
 * @param {Record<string, any>} registry
 * @returns {{ id: string, code: string }[]}
 */
export function requiredCoverage(registry) {
  /** @type {{ id: string, code: string }[]} */
  const out = [];
  for (const store of /** @type {any[]} */ (/** @type {any} */ (registry).stores)) {
    out.push({ id: store.id, code: 'WRITER' });
    (store.writers?.unknownGaps || []).forEach((_, i) => out.push({ id: `${store.id}#unknown-gap:${i}`, code: 'UNKNOWN_WRITER' }));
  }
  for (const gap of /** @type {any[]} */ (/** @type {any} */ (registry).inventoryGaps || [])) {
    if (gap.blocksConsistentSnapshot === true) out.push({ id: gap.id, code: 'UNKNOWN_WRITER' });
  }
  return out;
}

/**
 * Which required ids lack a certified participant. Online mode is enabled only when none do.
 *
 * @param {Record<string, any>} registry
 * @param {MaintenanceParticipant[]} participants
 * @returns {{ enabled: boolean, reasons: { code: string, id: string }[] }}
 */
export function evaluateOnlineCapability(registry, participants) {
  const covered = new Set();
  const uncertified = new Set();
  for (const p of participants) {
    for (const id of p.covers || []) {
      if (p.certified === true) covered.add(id); else uncertified.add(id);
    }
  }
  const reasons = [];
  for (const req of requiredCoverage(registry)) {
    if (covered.has(req.id)) continue;
    const code = req.code === 'WRITER' ? (uncertified.has(req.id) ? 'WRITER_NOT_CERTIFIED' : 'WRITER_NOT_REGISTERED') : req.code;
    reasons.push({ code, id: req.id });
  }
  return { enabled: reasons.length === 0, reasons };
}

/**
 * Participants sorted by the registry's fixed lock order (lowest covered `lockOrderRank`, then id).
 *
 * @param {Record<string, any>} registry
 * @param {MaintenanceParticipant[]} participants
 * @returns {MaintenanceParticipant[]}
 */
export function orderByRegistry(registry, participants) {
  const rank = new Map();
  for (const store of /** @type {any[]} */ (/** @type {any} */ (registry).stores)) rank.set(store.id, Number(store.lockOrderRank) || 0);
  const key = (p) => {
    const ranks = (p.covers || []).map((id) => rank.get(id)).filter((n) => typeof n === 'number');
    return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
  };
  return [...participants].sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => Error} onTimeout
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {{
 *   controlDir: string,
 *   registry?: object,
 *   participants?: MaintenanceParticipant[] | (() => MaintenanceParticipant[]),
 *   budgets?: Partial<typeof MAINTENANCE_BUDGETS>,
 *   now?: () => number,
 *   acquireLease?: typeof acquireLease,
 * }} options
 */
export function createMaintenanceCoordinator(options) {
  const budgets = { ...MAINTENANCE_BUDGETS, ...(options.budgets || {}) };
  const now = options.now || Date.now;
  const lease = options.acquireLease || acquireLease;
  const listParticipants = () => (typeof options.participants === 'function' ? options.participants() : (options.participants || []));
  const registryOf = () => options.registry || getStorageRegistry();
  let running = false;

  /** @returns {ReturnType<typeof evaluateOnlineCapability>} */
  function capability() {
    return evaluateOnlineCapability(registryOf(), listParticipants());
  }

  /**
   * Run `stage` inside the barrier. The returned value is whatever `stage` returned; by then every
   * gate, lock and the lease are already released, so the caller may compress/encrypt freely.
   *
   * @template T
   * @param {{ purpose: string }} spec
   * @param {(ctx: { leaseToken: string, assertWithinBudget: () => void, budgets: typeof MAINTENANCE_BUDGETS,
   *   noteLag: (ms: number) => void, deadline: number }) => Promise<T>} stage
   * @returns {Promise<{ value: T, metrics: { barrierMs: number, maxLagMs: number, order: string[], drainMs: number, flushMs: number } }>}
   */
  async function runBarrier(spec, stage) {
    if (running) throw new MaintenanceError('MAINTENANCE_BUSY', 'a maintenance barrier is already running in this process');
    const cap = capability();
    if (!cap.enabled) {
      throw new MaintenanceError('ONLINE_NOT_CERTIFIED', 'online maintenance is disabled: not every writer has a certified snapshot capability', { reasons: cap.reasons });
    }
    if (isRestorePaused(options.controlDir)) {
      throw new MaintenanceError('MAINTENANCE_DEFERRED', 'automatic work is paused (restore pause); online maintenance is deferred', { reason: 'external-pause' });
    }
    running = true;
    /** @type {{ token: string, release: () => void } | null} */
    let held = null;
    const participants = orderByRegistry(registryOf(), listParticipants());
    /** @type {MaintenanceParticipant[]} */
    const closed = [];
    /** @type {MaintenanceParticipant[]} */
    const locked = [];
    const order = [];
    let maxLagMs = 0;
    let startedAt = 0;
    let drainMs = 0;
    let flushMs = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    let sampler = null;
    try {
      try {
        held = lease(options.controlDir, spec.purpose);
      } catch (err) {
        throw new MaintenanceError('LEASE_HELD', 'another process holds the external maintenance lease', { cause: /** @type {any} */ (err)?.code });
      }
      const stateBefore = readControlState(options.controlDir);
      startedAt = now();
      // Event-loop impact: a timer that fires late means something blocked the loop for that long.
      const SAMPLE_MS = 10;
      let lastTick = performance.now();
      sampler = setInterval(() => {
        const t = performance.now();
        const lag = t - lastTick - SAMPLE_MS;
        lastTick = t;
        if (lag > maxLagMs) maxLagMs = lag;
      }, SAMPLE_MS);
      sampler.unref?.();
      const deadline = startedAt + budgets.maxBarrierMs;
      const assertWithinBudget = () => {
        if (now() > deadline) throw new MaintenanceError('BARRIER_BUDGET_EXCEEDED', `barrier exceeded ${budgets.maxBarrierMs} ms`, { maxBarrierMs: budgets.maxBarrierMs });
        if (maxLagMs > budgets.maxEventLoopLagMs) {
          throw new MaintenanceError('BARRIER_BUDGET_EXCEEDED', `event-loop lag ${Math.round(maxLagMs)} ms exceeds ${budgets.maxEventLoopLagMs} ms`, { maxEventLoopLagMs: budgets.maxEventLoopLagMs });
        }
      };

      // 3. gates first: no new mutation can start once these returned.
      for (const p of participants) {
        closed.push(p);
        p.close();
      }

      // 4. drain, one shared deadline.
      const drainStart = now();
      const drainDeadline = drainStart + budgets.drainTimeoutMs;
      const drains = await Promise.all(participants.map(async (p) => ({ p, r: await p.drain(drainDeadline) })));
      drainMs = now() - drainStart;
      const stuck = drains.filter((d) => !d.r.drained);
      if (stuck.length) {
        const deferrable = stuck.every((d) => d.r.deferrable === true);
        throw new MaintenanceError(deferrable ? 'MAINTENANCE_DEFERRED' : 'DRAIN_TIMEOUT',
          deferrable ? 'provider work is active and cannot be drained safely; backup deferred' : 'in-flight mutations did not drain in time',
          { writers: stuck.map((d) => ({ id: d.p.id, active: d.r.active ?? null, reason: d.r.reason || null })) });
      }
      assertWithinBudget();

      // 5. flush. Participants keep failed buffers; any failure aborts the whole backup.
      const flushStart = now();
      for (const p of participants) {
        if (!p.flush) continue;
        let result;
        try {
          result = await withTimeout(p.flush(), budgets.flushTimeoutMs, () => new MaintenanceError('FLUSH_FAILED', `flush of ${p.id} timed out`, { writer: p.id }));
        } catch (err) {
          if (err instanceof MaintenanceError) throw err;
          throw new MaintenanceError('FLUSH_FAILED', `flush of ${p.id} failed`, { writer: p.id });
        }
        if (!result || result.ok !== true) {
          throw new MaintenanceError('FLUSH_FAILED', `flush of ${p.id} left unsaved buffers`, { writer: p.id, failed: result?.failed ?? null });
        }
      }
      flushMs = now() - flushStart;
      assertWithinBudget();

      // 6. store locks in the fixed registry order; a timeout releases what is held (see `finally`).
      for (const p of participants) {
        if (!p.lock) continue;
        try {
          await withTimeout(p.lock.acquire(budgets.lockTimeoutMs), budgets.lockTimeoutMs, () => new MaintenanceError('LOCK_TIMEOUT', `store lock of ${p.id} timed out`, { writer: p.id }));
        } catch (err) {
          if (err instanceof MaintenanceError) throw err;
          throw new MaintenanceError('LOCK_TIMEOUT', `store lock of ${p.id} failed`, { writer: p.id });
        }
        locked.push(p);
        order.push(p.id);
        assertWithinBudget();
      }

      // 7. journals / fence.
      for (const p of participants) {
        if (!p.validate) continue;
        const v = await p.validate();
        if (!v || v.ok !== true) throw new MaintenanceError('JOURNAL_UNRESOLVED', `unresolved journal or transaction in ${p.id}`, { writer: p.id, pending: v?.pending ?? null });
      }
      const verifyFence = () => {
        const s = readControlState(options.controlDir);
        if (s.fence !== stateBefore.fence || s.datasetGeneration !== stateBefore.datasetGeneration || s.paused) {
          throw new MaintenanceError('FENCE_CHANGED', 'dataset generation, fence or pause changed during the barrier');
        }
      };
      verifyFence();

      // 8. bounded staging.
      const value = await stage({
        leaseToken: held.token,
        assertWithinBudget,
        budgets,
        noteLag: (ms) => { if (ms > maxLagMs) maxLagMs = ms; },
        deadline,
      });
      verifyFence();
      assertWithinBudget();
      return { value, metrics: { barrierMs: 0, maxLagMs, order, drainMs, flushMs } };
    } finally {
      if (sampler) clearInterval(sampler);
      // 9. always release: store locks (reverse order), gates, lease. A failing release must not skip the rest.
      for (const p of [...locked].reverse()) {
        try { p.lock?.release(); } catch { /* keep releasing */ }
      }
      for (const p of [...closed].reverse()) {
        try { p.open(); } catch { /* keep releasing */ }
      }
      try { held?.release(); } catch { /* lease file already gone */ }
      running = false;
    }
  }

  /**
   * Same as {@link runBarrier}, with the measured barrier duration filled in.
   * @template T
   * @param {{ purpose: string }} spec
   * @param {(ctx: any) => Promise<T>} stage
   */
  async function run(spec, stage) {
    const t0 = now();
    const out = await runBarrier(spec, stage);
    out.metrics.barrierMs = now() - t0;
    return out;
  }

  return Object.freeze({ run, capability, budgets, isRunning: () => running });
}

/**
 * Reject a write that presents a fence other than the control directory's current one. Called before a
 * command is dispatched, so a stale writer changes nothing in the database.
 *
 * @param {string} controlDir
 * @param {number} presentedFence
 */
export function assertFence(controlDir, presentedFence) {
  const current = readControlState(controlDir).fence;
  if (!Number.isInteger(presentedFence) || presentedFence !== current) {
    throw new MaintenanceError('FENCE_STALE', 'write presented a stale or missing fence', { presented: presentedFence ?? null, current });
  }
}

/**
 * Writers allowed to write, each bound to a registry store. A writer that is not registered cannot write,
 * and a store with `unknownGaps` (writers nobody has inventoried) cannot start a writer at all.
 */
export class WriteGateRegistry {
  /** @param {{ registry?: Record<string, any> }} [options] storage registry; defaults to the canonical one */
  constructor(options = {}) {
    this.registryOverride = options.registry || null;
    /** @type {Map<string, string>} writerId -> storeId */
    this.writers = new Map();
  }

  /** @returns {Record<string, any>} */
  storageRegistry() {
    return this.registryOverride || getStorageRegistry();
  }

  /**
   * Register and start a writer. Refuses with `UNKNOWN_WRITER_GAPS` while the store lists unknownGaps.
   *
   * @param {string} writerId
   * @param {string} storeId
   */
  startWriter(writerId, storeId) {
    const store = /** @type {any[]} */ (this.storageRegistry().stores).find((s) => s.id === storeId);
    if (!store) throw new MaintenanceError('UNKNOWN_STORE', `store ${storeId} is not in the storage registry`, { storeId });
    const gaps = store.writers?.unknownGaps || [];
    if (gaps.length > 0) {
      throw new MaintenanceError('UNKNOWN_WRITER_GAPS', `store ${storeId} has ${gaps.length} unknown writer gap(s); writer cannot start`, { storeId, unknownGaps: gaps.length });
    }
    this.writers.set(writerId, storeId);
  }

  /** @param {string} writerId */
  isRegistered(writerId) {
    return this.writers.has(writerId);
  }

  /** @param {string} writerId */
  assertRegistered(writerId) {
    if (!this.writers.has(writerId)) {
      throw new MaintenanceError('WRITER_NOT_REGISTERED', `writer ${writerId} is not registered in the write gate registry`, { writer: writerId });
    }
  }
}

/**
 * Explicit exemption for isolated storage tests that exercise receipt or batching semantics without a
 * production control directory. Production callers must provide a real registered write gate.
 */
export const WRITE_GATE_TEST_EXEMPTION = Symbol('storage-write-gate-test-exemption');

/**
 * Full pre-dispatch check of one command write: restore pause, registered writer, current fence.
 * Everything runs before the command reaches the worker, so a refusal leaves the database untouched.
 *
 * @param {{ controlDir: string, registry: WriteGateRegistry, writerId: string, fence: number } | typeof WRITE_GATE_TEST_EXEMPTION | undefined} gate
 */
export function assertWriteAllowed(gate) {
  if (gate === WRITE_GATE_TEST_EXEMPTION) return;
  if (!gate || typeof gate !== 'object' || typeof gate.controlDir !== 'string'
    || !gate.registry || typeof gate.registry.assertRegistered !== 'function') {
    throw new MaintenanceError('WRITE_GATE_REQUIRED', 'storage command writes require a configured write gate');
  }
  if (isRestorePaused(gate.controlDir)) {
    throw new MaintenanceError('RESTORE_PAUSED', 'writes are held while a restore leaves the dataset paused');
  }
  gate.registry.assertRegistered(gate.writerId);
  assertFence(gate.controlDir, gate.fence);
}
