/**
 * Shared pre-flight gate for managed executor launches.
 *
 * Every PTY run (terminal, task, agent, dev build, one-shot title agent) and
 * every harness/tool child spawned through `child_process.spawn` is an executor:
 * it starts a new Node/CLI process on the same host. When MemAvailable is
 * already critical, or the headroom above the critical line is smaller than the
 * executor reserve, starting another one makes a kernel OOM kill more likely.
 *
 * The gate is deliberately injectable: the library default is disabled so
 * importing it never changes process behaviour. `server.js` activates it at boot
 * from `CRETLI_EXECUTOR_MEMORY_GUARD` (on by default), and tests replace the
 * host reader + thresholds to prove the runtime boundary refuses a spawn.
 *
 * Unknown memory state (no `/proc/meminfo`, non-Linux, unreadable values) is
 * never blocking: absence of evidence must not stop work.
 */

import {
  DEFAULT_MEMORY_GUARD_CONFIG,
  evaluateMemoryGuard,
  readEffectiveHostMemory,
  preflightExecutorStart,
} from './oom-diagnostics.js';

/** Error thrown from a launch boundary when the pre-flight refuses to start. */
export class ExecutorLaunchDeniedError extends Error {
  /** @param {object} decision */
  constructor(decision = {}) {
    const level = String(decision.level || 'unknown');
    const reason = String(decision.reason || 'memory guard denied the launch');
    const type = String(decision.type || 'executor');
    const label = String(decision.label || '').trim();
    super(`Executor launch refused (${level}): ${reason} [${type}${label ? `: ${label}` : ''}]`);
    this.name = 'ExecutorLaunchDeniedError';
    this.code = 'EXECUTOR_LAUNCH_DENIED';
    this.decision = decision;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function readNumberEnv(env, key, fallback, bounds = {}) {
  const raw = env?.[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.isFinite(bounds.min) ? bounds.min : 0;
  const max = Number.isFinite(bounds.max) ? bounds.max : Number.POSITIVE_INFINITY;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ enabled: boolean, warnAvailableRatio: number, criticalAvailableRatio: number, executorReserveBytes: number }}
 */
export function resolveExecutorLaunchGateConfig(env = process.env) {
  const raw = String(env?.CRETLI_EXECUTOR_MEMORY_GUARD ?? '').trim().toLowerCase();
  const enabled = !['0', 'false', 'off', 'no'].includes(raw);
  const warnAvailableRatio = readNumberEnv(
    env,
    'CRETLI_MEMORY_GUARD_WARN_RATIO',
    DEFAULT_MEMORY_GUARD_CONFIG.warnAvailableRatio,
    { min: 0, max: 1 },
  );
  const criticalAvailableRatio = readNumberEnv(
    env,
    'CRETLI_MEMORY_GUARD_CRITICAL_RATIO',
    DEFAULT_MEMORY_GUARD_CONFIG.criticalAvailableRatio,
    { min: 0, max: 1 },
  );
  return {
    enabled,
    warnAvailableRatio,
    criticalAvailableRatio,
    executorReserveBytes: readNumberEnv(
      env,
      'CRETLI_MEMORY_GUARD_RESERVE_MB',
      DEFAULT_MEMORY_GUARD_CONFIG.executorReserveBytes / (1024 ** 2),
      { min: 0 },
    ) * (1024 ** 2),
  };
}

/**
 * @typedef {{
 *   enabled?: boolean,
 *   env?: Record<string, string | undefined>,
 *   config?: Record<string, number>,
 *   readHostMemory?: () => { totalBytes?: number | null, availableBytes?: number | null },
 *   onDecision?: (decision: object) => void,
 * }} ExecutorLaunchGateOptions
 */

/**
 * Create an injectable gate. `check` is side-effect-free apart from the optional
 * decision hook; `assert` throws `ExecutorLaunchDeniedError` when launch is
 * refused.
 *
 * @param {ExecutorLaunchGateOptions} [options]
 */
export function createExecutorLaunchGate(options = {}) {
  const envConfig = resolveExecutorLaunchGateConfig(options.env || process.env);
  const enabled = options.enabled !== undefined ? options.enabled === true : envConfig.enabled;
  const config = {
    warnAvailableRatio: envConfig.warnAvailableRatio,
    criticalAvailableRatio: envConfig.criticalAvailableRatio,
    executorReserveBytes: envConfig.executorReserveBytes,
    ...(options.config || {}),
  };
  const readHost = typeof options.readHostMemory === 'function' ? options.readHostMemory : readEffectiveHostMemory;

  /** @param {{ type?: string, label?: string }} [meta] */
  function check(meta = {}) {
    if (!enabled) {
      return { allowed: true, level: 'disabled', reason: 'executor memory guard is disabled', ...meta };
    }
    let host = { totalBytes: null, availableBytes: null };
    try {
      const observed = readHost();
      host = {
        totalBytes: Number.isFinite(observed?.totalBytes) ? observed.totalBytes : null,
        availableBytes: Number.isFinite(observed?.availableBytes) ? observed.availableBytes : null,
      };
    } catch {
      // Unknown state stays non-blocking.
    }
    const decision = {
      ...preflightExecutorStart({
        hostTotalBytes: host.totalBytes,
        hostAvailableBytes: host.availableBytes,
      }, config),
      hostTotalBytes: host.totalBytes,
      hostAvailableBytes: host.availableBytes,
      ...meta,
    };
    if (typeof options.onDecision === 'function') {
      try {
        options.onDecision(decision);
      } catch {
        // Observability must never break a launch decision.
      }
    }
    return decision;
  }

  /** @param {{ type?: string, label?: string }} [meta] */
  function assert(meta = {}) {
    const decision = check(meta);
    if (!decision.allowed) throw new ExecutorLaunchDeniedError(decision);
    return decision;
  }

  return { enabled, config, check, assert, evaluate: (host) => evaluateMemoryGuard(host, config) };
}

/** @type {ReturnType<typeof createExecutorLaunchGate> | null} */
let activeGate = null;

/** @returns {ReturnType<typeof createExecutorLaunchGate>} */
function getActiveGate() {
  if (!activeGate) activeGate = createExecutorLaunchGate({ enabled: false });
  return activeGate;
}

/** Activate the process-wide gate (called once from server boot). */
export function configureExecutorLaunchGate(options = {}) {
  activeGate = createExecutorLaunchGate(options);
  return activeGate;
}

/** Process-wide pre-flight used by the launch boundaries. */
export function checkExecutorLaunch(meta = {}) {
  return getActiveGate().check(meta);
}

/**
 * Refuse a managed executor launch when the process-wide gate says no.
 * @param {{ type?: string, label?: string }} [meta]
 */
export function assertExecutorLaunchAllowed(meta = {}) {
  return getActiveGate().assert(meta);
}

/** True when the process-wide gate is active; useful for logs. */
export function isExecutorLaunchGateEnabled() {
  return getActiveGate().enabled;
}

/** Test-only: replace the gate and restore the disabled default afterwards. */
export function resetExecutorLaunchGateForTest(options = {}) {
  activeGate = createExecutorLaunchGate({ enabled: false, ...options });
  return activeGate;
}
