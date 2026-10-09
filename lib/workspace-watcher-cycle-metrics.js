/**
 * Failure-isolated façade over the durable Workspace Watcher cycle-metrics
 * store (`persist/workspace-watcher-cycle-metrics-persist.js`).
 *
 * Telemetry is observational: a broken/unwritable metrics file must never abort
 * a cycle start, roll back a claim, or interrupt a close. Every writer here
 * swallows the IO error, records it as a durable limitation (`errors` in the
 * metrics document) and emits one event-log line, so the cycle outcome is
 * unchanged while the failure stays visible to a later API/Settings leaf.
 *
 * Tests can inject `deps.cycleMetricsStore` to simulate a failing store and
 * prove the caller still completes.
 */

import { logDelegationEvent } from './delegation-log.js';
import * as defaultStore from './persist/workspace-watcher-cycle-metrics-persist.js';
import { readUsageEvents } from './persist/usage-persist.js';
import { loadDelegations } from './persist/delegations-persist.js';
import {
  correlateWorkspaceWatcherCycleUsage,
  normalizeWorkspaceWatcherCycleUsage,
  resolveWorkspaceWatcherCycleUsagePhase,
} from './workspace-watcher-cycle-usage.js';

export {
  getWorkspaceWatcherCycleMetricsDataPath,
  WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS,
  WORKSPACE_WATCHER_CYCLE_METRICS_MAX_RECORDS,
  WORKSPACE_WATCHER_CYCLE_CLOSE_SOURCES,
  WORKSPACE_WATCHER_CYCLE_REQUEST_SOURCES,
  WORKSPACE_WATCHER_TODO_OUTCOMES,
  WORKSPACE_WATCHER_CYCLE_BLOCKED_REASON_CODES,
} from './persist/workspace-watcher-cycle-metrics-persist.js';

export {
  WORKSPACE_WATCHER_CYCLE_USAGE_SCHEMA_VERSION,
  WORKSPACE_WATCHER_CYCLE_USAGE_GRACE_MS,
  WORKSPACE_WATCHER_CYCLE_USAGE_RETENTION_MS,
  WORKSPACE_WATCHER_CYCLE_USAGE_PHASES,
  WORKSPACE_WATCHER_CYCLE_USAGE_COST_KINDS,
  correlateWorkspaceWatcherCycleUsage,
  normalizeWorkspaceWatcherCycleUsage,
  resolveWorkspaceWatcherCycleUsagePhase,
  classifyCycleUsageCost,
  mergeCycleUsageBuckets,
  buildCycleUsageMembership,
  classifyCycleUsageEvent,
} from './workspace-watcher-cycle-usage.js';

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
function describeError(error) {
  if (error && typeof error === 'object') {
    const code = String(/** @type {{ code?: unknown }} */ (error).code || '').trim();
    return { code: code || 'WORKSPACE_WATCHER_CYCLE_METRICS', message: error instanceof Error ? error.message : String(error) };
  }
  return { code: 'WORKSPACE_WATCHER_CYCLE_METRICS', message: String(error ?? 'unknown error') };
}

/**
 * Resolve the metrics store. Production uses the default persist module; a test
 * may inject an object with the same method names to force a failure.
 *
 * @param {object} [deps]
 * @returns {object}
 */
function resolveStore(deps) {
  const injected = deps && typeof deps === 'object' ? deps.cycleMetricsStore : null;
  return injected && typeof injected === 'object' ? injected : defaultStore;
}

/**
 * Run one metrics write, never throwing. On failure: record the limitation (best
 * effort) and log an event line. Returns `{ ok: false, error }` on failure so a
 * caller that wants to inspect the outcome can; callers that ignore it are still
 * safe.
 *
 * @param {string} operation
 * @param {object} input
 * @param {object} deps
 * @param {(store: object) => object} work
 * @returns {object}
 */
function writeSafely(operation, input, deps, work) {
  const store = resolveStore(deps);
  try {
    return work(store);
  } catch (error) {
    const described = describeError(error);
    try {
      if (typeof store.recordWorkspaceWatcherCycleMetricsError === 'function') {
        store.recordWorkspaceWatcherCycleMetricsError({ ...input, operation, ...described });
      }
    } catch {
      // The limitation marker is best-effort; its own failure must not escalate.
    }
    try {
      logDelegationEvent('workspace-watcher-cycle-metrics-failed', {}, {
        operation,
        workspaceFolder: String(input?.workspaceFolder ?? '').trim(),
        cycleId: String(input?.cycleId ?? '').trim(),
        ...described,
      });
    } catch {
      // Logging must never break a cycle.
    }
    return { ok: false, error: described };
  }
}

/**
 * Create the per-cycle record at reservation time.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {object}
 */
export function beginWorkspaceWatcherCycleMetric(input, deps) {
  return writeSafely('begin', input, deps, (store) => (
    typeof store.beginWorkspaceWatcherCycleMetric === 'function'
      ? store.beginWorkspaceWatcherCycleMetric(input)
      : { ok: true, created: false, record: null }
  ));
}

/**
 * Stamp the requested orchestrator pair once `model_pick` resolves.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {object}
 */
export function stampWorkspaceWatcherCycleMetricRequest(input, deps) {
  return writeSafely('request', input, deps, (store) => (
    typeof store.stampWorkspaceWatcherCycleMetricRequest === 'function'
      ? store.stampWorkspaceWatcherCycleMetricRequest(input)
      : { ok: true, updated: false, record: null }
  ));
}

/**
 * Record that the orchestrator run actually started.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {object}
 */
export function markWorkspaceWatcherCycleMetricRunning(input, deps) {
  return writeSafely('running', input, deps, (store) => (
    typeof store.markWorkspaceWatcherCycleMetricRunning === 'function'
      ? store.markWorkspaceWatcherCycleMetricRunning(input)
      : { ok: true, updated: false, record: null }
  ));
}

/**
 * Close one cycle metric (idempotent by `cycleId`).
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {object}
 */
export function finalizeWorkspaceWatcherCycleMetric(input, deps) {
  return writeSafely('finalize', input, deps, (store) => (
    typeof store.finalizeWorkspaceWatcherCycleMetric === 'function'
      ? store.finalizeWorkspaceWatcherCycleMetric(input)
      : { ok: true, created: false, replay: false, record: null }
  ));
}

/**
 * Read the store status for a later API/UI leaf. A read failure degrades to an
 * empty status with a `readError` marker instead of throwing.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {object}
 */
export function readWorkspaceWatcherCycleMetricsStatus(options = {}) {
  try {
    return defaultStore.getWorkspaceWatcherCycleMetricsStatus(options);
  } catch (error) {
    return {
      collectionStartedAt: '',
      updatedAt: '',
      recordCount: 0,
      openCount: 0,
      oldestStartedAt: '',
      newestStartedAt: '',
      retention: {
        ms: defaultStore.WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS,
        maxRecords: defaultStore.WORKSPACE_WATCHER_CYCLE_METRICS_MAX_RECORDS,
      },
      lastError: null,
      readError: describeError(error),
    };
  }
}

/**
 * Read every normalized cycle metric (oldest first). A read failure returns [].
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function loadWorkspaceWatcherCycleMetrics(options = {}) {
  try {
    return defaultStore.loadWorkspaceWatcherCycleMetrics(options).records;
  } catch {
    return [];
  }
}

/**
 * Load one cycle record through the (possibly injected) metrics store. Returns
 * null when the record is missing or the store read fails.
 *
 * @param {string} cycleId
 * @param {{ dataDir?: string }} options
 * @param {object} [deps]
 * @returns {object | null}
 */
function loadCycleRecord(cycleId, options, deps) {
  const store = resolveStore(deps);
  try {
    if (typeof store.getWorkspaceWatcherCycleMetric === 'function') {
      return store.getWorkspaceWatcherCycleMetric(cycleId, options);
    }
    return defaultStore.getWorkspaceWatcherCycleMetric(cycleId, options);
  } catch {
    return null;
  }
}

/**
 * Read the ledger events and delegation rows a cycle correlation needs. The
 * window is wide enough to cover the ledger retention and is never the join
 * key; membership is decided by `cycleId`/chat/run ids in the pure model.
 *
 * @param {object} record
 * @param {{ now: number, dataDir?: string, events?: object[], delegations?: object[] }} options
 * @param {object} [deps]
 * @returns {{ events: object[], delegations: object[], readError: object | null }}
 */
function collectCycleUsageSources(record, options, deps) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const retentionMs = defaultStore.WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS;
  const startedMs = Date.parse(String(record?.startedAt || record?.closedAt || ''));
  // A small buffer before the start keeps an event whose `at` precedes the
  // recorded start from being missed; it is not used for membership.
  const fromMs = Number.isFinite(startedMs) ? startedMs - 60_000 : now - retentionMs;
  const readUsage = deps && typeof deps.readUsageEvents === 'function' ? deps.readUsageEvents : readUsageEvents;
  const readDelegations = deps && typeof deps.loadDelegations === 'function'
    ? deps.loadDelegations
    : loadDelegations;
  let events = Array.isArray(options.events) ? options.events : null;
  let readError = null;
  if (!events) {
    try {
      events = readUsage({
        from: new Date(Math.max(0, Math.min(fromMs, now))).toISOString(),
        to: new Date(now).toISOString(),
        dataDir: options.dataDir,
      });
    } catch (error) {
      // A transient ledger read failure must never be mistaken for "no usage":
      // finalizing zero over it would freeze a wrong sum. Signal the failure so
      // the caller can retry on the next sweep.
      readError = describeError(error);
      events = [];
    }
  }
  let delegations = Array.isArray(options.delegations) ? options.delegations : null;
  if (!delegations) {
    try {
      delegations = readDelegations({ dataDir: options.dataDir });
    } catch (error) {
      if (!readError) readError = describeError(error);
      delegations = [];
    }
  }
  return {
    events: Array.isArray(events) ? events : [],
    delegations: Array.isArray(delegations) ? delegations : [],
    readError,
  };
}

/**
 * Read the usage summary for one cycle without writing anything.
 *
 * A finalized/expired record returns its stored summary; an open or provisional
 * cycle is correlated live from the ledger so late usage inside the grace is
 * visible. A missing cycle returns null.
 *
 * @param {string} cycleId
 * @param {{
 *   dataDir?: string,
 *   now?: number,
 *   events?: object[],
 *   delegations?: object[],
 *   graceMs?: number,
 *   retentionMs?: number,
 * }} [options]
 * @param {object} [deps]
 * @returns {object | null}
 */
export function readWorkspaceWatcherCycleUsage(cycleId, options = {}, deps) {
  const id = String(cycleId ?? '').trim();
  if (!id) return null;
  const record = loadCycleRecord(id, { dataDir: options.dataDir }, deps);
  if (!record) return null;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  if (record.usageExpired) {
    return {
      cycleId: id,
      phase: 'expired',
      provisional: false,
      expired: true,
      finalized: false,
      finalizedAt: '',
      stored: true,
      usage: null,
      error: record.usage ? null : 'usage_ledger_retention_expired',
    };
  }
  if (record.usageFinalizedAt || record.usageFinalized) {
    return {
      cycleId: id,
      phase: 'final',
      provisional: false,
      expired: false,
      finalized: true,
      finalizedAt: record.usageFinalizedAt || '',
      stored: true,
      usage: record.usage ? normalizeWorkspaceWatcherCycleUsage(record.usage) : null,
    };
  }
  const sources = collectCycleUsageSources(record, { ...options, now }, deps);
  if (sources.readError) {
    // Never present a zero summary built from a failed read as if it were real.
    const phase = resolveWorkspaceWatcherCycleUsagePhase(record, {
      now,
      graceMs: options.graceMs,
      retentionMs: options.retentionMs,
    });
    return {
      cycleId: id,
      phase: phase.phase,
      provisional: phase.provisional,
      expired: phase.expired,
      finalized: false,
      finalizedAt: '',
      stored: false,
      usage: null,
      readError: sources.readError,
    };
  }
  const usage = correlateWorkspaceWatcherCycleUsage(record, {
    events: sources.events,
    delegations: sources.delegations,
    now,
    graceMs: options.graceMs,
    retentionMs: options.retentionMs,
  });
  return {
    cycleId: id,
    phase: usage.phase,
    provisional: usage.provisional,
    expired: usage.expired,
    finalized: false,
    finalizedAt: '',
    stored: false,
    usage,
  };
}

/**
 * Finalize one closed cycle's usage once it is past the 24 h grace.
 *
 * Idempotent: an already finalized/expired record replays untouched. A cycle
 * that is still open or inside the grace is refused with
 * `usage_provisional`; a missing cycle with `cycle_not_found`. A past-retention
 * cycle without a finalization is written as an explicit `expired` marker
 * instead of a fabricated sum.
 *
 * @param {{
 *   cycleId?: string,
 *   dataDir?: string,
 *   now?: number,
 *   events?: object[],
 *   delegations?: object[],
 *   graceMs?: number,
 *   retentionMs?: number,
 * }} input
 * @param {object} [deps]
 * @returns {object}
 */
export function finalizeWorkspaceWatcherCycleUsage(input = {}, deps) {
  const cycleId = String(input.cycleId ?? '').trim();
  if (!cycleId) return { ok: false, reason: 'cycle_id_required', replay: false, record: null };
  try {
    const store = resolveStore(deps);
    const write = typeof store.persistWorkspaceWatcherCycleUsage === 'function'
      ? store.persistWorkspaceWatcherCycleUsage
      : defaultStore.persistWorkspaceWatcherCycleUsage;
    const record = loadCycleRecord(cycleId, { dataDir: input.dataDir }, deps);
    if (!record) return { ok: false, reason: 'cycle_not_found', replay: false, record: null };
    if (record.usageFinalizedAt || record.usageExpired) {
      return { ok: true, reason: 'already_finalized', replay: true, record };
    }
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const phase = resolveWorkspaceWatcherCycleUsagePhase(record, {
      now,
      graceMs: input.graceMs,
      retentionMs: input.retentionMs,
    });
    if (phase.phase === 'open' || phase.phase === 'provisional') {
      return { ok: false, reason: 'usage_provisional', replay: false, record, phase: phase.phase };
    }
    if (phase.phase === 'expired') {
      const written = write({
        cycleId,
        dataDir: input.dataDir,
        now,
        expired: true,
        finalized: false,
      });
      return { ok: true, reason: 'usage_expired', replay: written.replay === true, record: written.record };
    }
    const sources = collectCycleUsageSources(record, { ...input, now }, deps);
    if (sources.readError) {
      // Refuse to freeze a wrong sum over a transient read failure; the next
      // sweep retries. The cycle stays unfinalized.
      return {
        ok: false,
        reason: 'usage_ledger_read_failed',
        replay: false,
        record,
        error: sources.readError,
      };
    }
    const usage = correlateWorkspaceWatcherCycleUsage(record, {
      events: sources.events,
      delegations: sources.delegations,
      now,
      graceMs: input.graceMs,
      retentionMs: input.retentionMs,
    });
    const written = write({
      cycleId,
      dataDir: input.dataDir,
      now,
      usage,
      finalized: true,
      finalizedAt: new Date(now).toISOString(),
    });
    logDelegationEvent('workspace-watcher-cycle-usage-finalized', {}, {
      cycleId,
      workspaceFolder: String(record.workspaceFolder || ''),
      finalized: written.persisted === true,
      replay: written.replay === true,
    });
    return {
      ok: true,
      reason: written.replay ? 'already_finalized' : 'usage_finalized',
      replay: written.replay === true,
      record: written.record,
      usage,
    };
  } catch (error) {
    return { ok: false, reason: 'usage_finalize_failed', replay: false, record: null, error: describeError(error) };
  }
}

/**
 * Finalize every closed cycle whose usage is due (past the grace but inside the
 * retention window) or past retention. Safe to call repeatedly; each cycle is
 * one-shot and a failure of one cycle never stops the sweep.
 *
 * @param {{ dataDir?: string, now?: number, events?: object[], delegations?: object[], graceMs?: number, retentionMs?: number }} [options]
 * @param {object} [deps]
 * @returns {{ considered: number, finalized: number, expired: number, provisional: number, replayed: number, failed: number }}
 */
export function finalizeDueWorkspaceWatcherCycleUsage(options = {}, deps) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const results = { considered: 0, finalized: 0, expired: 0, provisional: 0, replayed: 0, failed: 0 };
  let records = [];
  try {
    records = defaultStore.loadWorkspaceWatcherCycleMetrics({ dataDir: options.dataDir }).records;
  } catch {
    return { ...results, failed: 1 };
  }
  for (const record of records) {
    if (!record?.closedAt) continue;
    if (record.usageFinalizedAt || record.usageExpired) continue;
    results.considered += 1;
    const outcome = finalizeWorkspaceWatcherCycleUsage({
      cycleId: record.cycleId,
      dataDir: options.dataDir,
      now,
      events: options.events,
      delegations: options.delegations,
      graceMs: options.graceMs,
      retentionMs: options.retentionMs,
    }, deps);
    if (!outcome.ok) {
      if (outcome.reason === 'usage_provisional') results.provisional += 1;
      else results.failed += 1;
      continue;
    }
    if (outcome.reason === 'usage_expired') results.expired += 1;
    else if (outcome.replay) results.replayed += 1;
    else results.finalized += 1;
  }
  return results;
}
