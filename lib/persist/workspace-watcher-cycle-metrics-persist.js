/**
 * Durable per-cycle metrics for the Workspace Watcher orchestrator.
 *
 * `data/workspace-watcher-cycles.json` is a separate store from the watcher row
 * (`workspace-watchers.json`). The dashboard-facing `cycleChats` list on the row
 * is a bounded window (20 entries) and only contains cycles that *closed*; it is
 * enough to render a Gantt, not enough to compare orchestrator models. This
 * store keeps one record per `cycleId` for the whole retention window and also
 * keeps starts that never reached `running` (aborted reservations), because the
 * record is created at reservation time.
 *
 * Shape (v1):
 *   {
 *     v: 1,
 *     collectionStartedAt: ISO,
 *     updatedAt: ISO,
 *     retention: { ms, maxRecords },
 *     errors: { count, lastAt, lastCode, lastMessage, lastOperation } | null,
 *     records: { "<cycleId>": record }
 *   }
 *
 * Record fields are intentionally explicit about "unknown": a legacy cycle that
 * never stored a model keeps `requestedModel: null` instead of guessing it from
 * the current configuration. The confirmed `model` stays null until a later
 * usage-correlation leaf fills it from telemetry.
 *
 * Writers serialize on the same cross-process lock as the watcher row
 * (`withWorkspaceWatchersFileLock`) so a metrics write can never interleave with
 * a watcher read-modify-write and lose the loser's record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { withWorkspaceWatchersFileLock, WORKSPACE_WATCHER_CYCLE_REQUEST_SOURCES } from './workspace-watchers-persist.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeWorkspaceWatcherCycleUsage } from '../workspace-watcher-cycle-usage.js';

export const WORKSPACE_WATCHER_CYCLE_METRICS_SCHEMA_VERSION = 1;

/** How long a closed cycle record is kept. Aligns with the 30-day usage ledger. */
export const WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard size ceiling so a misbehaving writer can never grow the file without bound. */
export const WORKSPACE_WATCHER_CYCLE_METRICS_MAX_RECORDS = 2000;

/** How a cycle was closed. `abort` covers every reservation rolled back before running. */
export const WORKSPACE_WATCHER_CYCLE_CLOSE_SOURCES = Object.freeze(['report', 'reconcile', 'abort']);

/**
 * Verified per-leaf outcomes snapshotted from the workspace TODO state at close.
 * `attempted` means the leaf was claimed/reported and still in progress,
 * `completed` means the cycle's deliverable (a `done` todo, or a saved plan for
 * a plan-only cycle) was confirmed from workspace state, `blocked` means the
 * leaf was released without completion, and `unknown` covers a missing todo or
 * an unreadable todo store — never a success.
 */
export const WORKSPACE_WATCHER_TODO_OUTCOMES = Object.freeze(['attempted', 'completed', 'blocked', 'unknown']);

/**
 * Closed vocabulary of structured blocked-reason codes. Derived only from
 * structured fields (`planOnly`, the close decision reason, the watcher stop
 * reason, and per-leaf resolutions) — never from the free-text report message.
 */
export const WORKSPACE_WATCHER_CYCLE_BLOCKED_REASON_CODES = Object.freeze([
  'plan_not_saved',
  'missing_report',
  'cycle_incomplete',
  'cycle_room_gone',
  'todo_missing',
  'todo_read_error',
  'watcher_stopped',
  'orchestrator_error',
  'reported_blocked',
  'unknown',
]);

export { WORKSPACE_WATCHER_CYCLE_REQUEST_SOURCES };

/** Lifecycle phases recorded for a cycle metric. */
export const WORKSPACE_WATCHER_CYCLE_METRIC_PHASES = Object.freeze(['starting', 'running', 'closed']);

const CYCLE_OUTCOMES = Object.freeze(['success', 'blocked', 'failure']);

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function stringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => String(value ?? '').trim()).filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {string | null}
 */
function optionalEnum(value, allowed) {
  const text = String(value ?? '').trim().toLowerCase();
  return allowed.includes(text) ? text : null;
}

/**
 * A safe epoch ms for ordering/pruning. An unparseable timestamp sorts oldest.
 *
 * @param {object} record
 * @returns {number}
 */
function recordSortMs(record) {
  const ms = Date.parse(String(record?.closedAt || record?.startedAt || ''));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Normalize one per-leaf outcome snapshot. The id is the key, so a blank id is
 * dropped. An unrecognized outcome degrades to `unknown` rather than inventing a
 * completion.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeTodoOutcome(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const todoId = String(source.todoId ?? '').trim();
  if (!todoId) return null;
  const outcome = optionalEnum(source.outcome, WORKSPACE_WATCHER_TODO_OUTCOMES);
  return {
    todoId,
    claimed: source.claimed === true,
    reported: source.reported === true,
    planTarget: source.planTarget === true,
    outcome: outcome || 'unknown',
    status: optionalString(source.status) || 'unknown',
    planSaved: source.planSaved === true,
    readError: optionalString(source.readError),
  };
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeTodoOutcomes(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {object[]} */
  const out = [];
  for (const item of raw) {
    const normalized = normalizeTodoOutcome(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Normalize one stored cycle metric. Returns null when there is no `cycleId`
 * (the idempotency key), so an empty/placeholder object never creates a record.
 *
 * Unknown values stay `null`; they are never derived from the current watcher
 * configuration, which may have changed since the cycle ran.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeWorkspaceWatcherCycleMetric(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const cycleId = String(source.cycleId ?? '').trim();
  if (!cycleId) return null;
  const modeRaw = String(source.mode ?? '').trim().toLowerCase();
  const startedAt = String(source.startedAt ?? '').trim();
  const closedAt = optionalString(source.closedAt);
  const phaseRaw = String(source.phase ?? '').trim().toLowerCase();
  const phase = WORKSPACE_WATCHER_CYCLE_METRIC_PHASES.includes(phaseRaw)
    ? phaseRaw
    : closedAt
      ? 'closed'
      : optionalString(source.orchestratorRunId)
        ? 'running'
        : 'starting';
  return {
    cycleId,
    workspaceFolder: String(source.workspaceFolder ?? '').trim(),
    mode: modeRaw === 'plan' || modeRaw === 'implement' ? modeRaw : null,
    orchestratorChatId: optionalString(source.orchestratorChatId),
    orchestratorRunId: optionalString(source.orchestratorRunId),
    todoIds: stringList(source.todoIds),
    // Claimed ids come from the watcher claim; reported ids only from a report
    // and only after workspace validation. They are deliberately separate so a
    // foreign/unknown reported id can never masquerade as claimed work.
    claimedTodoIds: Array.isArray(source.claimedTodoIds)
      ? stringList(source.claimedTodoIds)
      : stringList(source.todoIds),
    reportedTodoIds: stringList(source.reportedTodoIds),
    unknownReportedTodoIds: stringList(source.unknownReportedTodoIds),
    completedTodoIds: stringList(source.completedTodoIds),
    // Per-leaf snapshot taken from workspace TODO state at close.
    todoOutcomes: normalizeTodoOutcomes(source.todoOutcomes),
    // Plan-only cycles are a separate population: their verified success is a
    // saved plan, not a `done` todo, so time/cost must never be pooled with
    // implementation cycles. Authoritative `mode` is the fallback for a legacy
    // record written before `planOnly` existed.
    planOnly: source.planOnly === true || modeRaw === 'plan',
    planSaved: source.planSaved === true,
    blockedReasonCode: optionalEnum(source.blockedReasonCode, WORKSPACE_WATCHER_CYCLE_BLOCKED_REASON_CODES),
    // The pair the watcher asked for. `policy` means an explicit policy pair,
    // `implement_pick` the automatic model pick. Unknown stays null.
    requestedHarness: optionalString(source.requestedHarness),
    requestedModel: optionalString(source.requestedModel),
    requestedSource: optionalEnum(source.requestedSource, WORKSPACE_WATCHER_CYCLE_REQUEST_SOURCES),
    // The harness that actually started. Kept separate from `requestedHarness`
    // because a policy harness can still be replaced by a pick fallback later.
    harness: optionalString(source.harness),
    // Confirmed model from usage telemetry. Deliberately null until the
    // usage-correlation leaf writes it; never inferred from configuration.
    model: optionalString(source.model),
    // Correlated usage/cost summary. `null` until the cycle's usage was either
    // read live or finalized; a live read is never persisted, only the final
    // (and the explicit `expired` marker) are. `usageFinalizedAt` is the
    // one-shot idempotency key: once set, the persisted sums never change.
    usage: normalizeWorkspaceWatcherCycleUsage(source.usage),
    usageProvisional: source.usageProvisional === true,
    usageFinalized: source.usageFinalized === true,
    usageFinalizedAt: optionalString(source.usageFinalizedAt),
    usageExpired: source.usageExpired === true,
    startedAt,
    closedAt,
    closeSource: optionalEnum(source.closeSource, WORKSPACE_WATCHER_CYCLE_CLOSE_SOURCES),
    closeReason: optionalString(source.closeReason),
    reportedOutcome: optionalEnum(source.reportedOutcome, CYCLE_OUTCOMES),
    closeOutcome: optionalEnum(source.closeOutcome, CYCLE_OUTCOMES),
    todoStatusAtClose: optionalString(source.todoStatusAtClose),
    // A cycle only provably reached `running` through the explicit marker (set by
    // `markWorkspaceWatcherCycleMetricRunning`) or a non-empty run id. A closed
    // phase alone is NOT proof: an aborted reservation also ends `closed`.
    reachedRunning: source.reachedRunning === true
      || Boolean(optionalString(source.orchestratorRunId))
      || phase === 'running',
    phase,
    createdAt: String(source.createdAt ?? '').trim(),
    updatedAt: String(source.updatedAt ?? '').trim(),
  };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function getWorkspaceWatcherCycleMetricsDataPath(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  const dir = configured || resolveDataPath();
  return path.join(dir, 'workspace-watcher-cycles.json');
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
function emptyDocument() {
  return {
    v: WORKSPACE_WATCHER_CYCLE_METRICS_SCHEMA_VERSION,
    collectionStartedAt: '',
    updatedAt: '',
    retention: {
      ms: WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS,
      maxRecords: WORKSPACE_WATCHER_CYCLE_METRICS_MAX_RECORDS,
    },
    errors: null,
    records: {},
  };
}

/**
 * @param {string} file
 * @returns {object}
 */
function readDocument(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDocument();
    const records = parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)
      ? parsed.records
      : {};
    return {
      v: WORKSPACE_WATCHER_CYCLE_METRICS_SCHEMA_VERSION,
      collectionStartedAt: String(parsed.collectionStartedAt ?? '').trim(),
      updatedAt: String(parsed.updatedAt ?? '').trim(),
      retention: {
        ms: Number(parsed.retention?.ms) > 0
          ? Number(parsed.retention.ms)
          : WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS,
        maxRecords: Number(parsed.retention?.maxRecords) > 0
          ? Math.floor(Number(parsed.retention.maxRecords))
          : WORKSPACE_WATCHER_CYCLE_METRICS_MAX_RECORDS,
      },
      errors: parsed.errors && typeof parsed.errors === 'object' && !Array.isArray(parsed.errors)
        ? parsed.errors
        : null,
      records,
    };
  } catch {
    return emptyDocument();
  }
}

/**
 * Drop records past the retention window and cap the file size. Live records
 * (no `closedAt`) are never dropped by the size cap: they are bounded by
 * `maxParallel` and dropping one would lose an in-flight cycle.
 *
 * @param {Record<string, object>} records
 * @param {{ now?: number, retentionMs?: number, maxRecords?: number }} [options]
 * @returns {Record<string, object>}
 */
export function pruneWorkspaceWatcherCycleMetrics(records, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const retentionMs = Number(options.retentionMs) > 0
    ? Number(options.retentionMs)
    : WORKSPACE_WATCHER_CYCLE_METRICS_RETENTION_MS;
  const maxRecords = Number(options.maxRecords) > 0
    ? Math.floor(Number(options.maxRecords))
    : WORKSPACE_WATCHER_CYCLE_METRICS_MAX_RECORDS;
  const cutoff = now - retentionMs;
  /** @type {object[]} */
  const live = [];
  /** @type {object[]} */
  const settled = [];
  for (const value of Object.values(records || {})) {
    const record = normalizeWorkspaceWatcherCycleMetric(value);
    if (!record) continue;
    const stamp = recordSortMs(record);
    if (stamp && stamp < cutoff) continue;
    if (record.closedAt) settled.push(record);
    else live.push(record);
  }
  settled.sort((a, b) => recordSortMs(b) - recordSortMs(a));
  const settledCap = Math.max(0, maxRecords - live.length);
  /** @type {Record<string, object>} */
  const out = {};
  for (const record of [...live, ...settled.slice(0, settledCap)]) out[record.cycleId] = record;
  return out;
}

/**
 * Read the store. A corrupt/unreadable file degrades to an empty document so a
 * damaged metrics file can never take down a caller; callers that need to
 * surface the failure read the document through the safe wrapper instead.
 *
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {{ collectionStartedAt: string, updatedAt: string, retention: { ms: number, maxRecords: number }, errors: object | null, records: object[] }}
 */
export function loadWorkspaceWatcherCycleMetrics(options = {}) {
  const file = getWorkspaceWatcherCycleMetricsDataPath(options);
  const doc = readDocument(file);
  /** @type {object[]} */
  const records = [];
  for (const value of Object.values(doc.records)) {
    const record = normalizeWorkspaceWatcherCycleMetric(value);
    if (record) records.push(record);
  }
  records.sort((a, b) => recordSortMs(a) - recordSortMs(b));
  return {
    collectionStartedAt: doc.collectionStartedAt,
    updatedAt: doc.updatedAt,
    retention: doc.retention,
    errors: doc.errors,
    records,
  };
}

/**
 * @param {string} cycleId
 * @param {{ dataDir?: string }} [options]
 * @returns {object | null}
 */
export function getWorkspaceWatcherCycleMetric(cycleId, options = {}) {
  const id = String(cycleId ?? '').trim();
  if (!id) return null;
  const doc = readDocument(getWorkspaceWatcherCycleMetricsDataPath(options));
  return normalizeWorkspaceWatcherCycleMetric(doc.records[id]);
}

/**
 * A small, prompt-free status used by the API/UI leaves to surface the store
 * range and an explicit telemetry limitation.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {object}
 */
export function getWorkspaceWatcherCycleMetricsStatus(options = {}) {
  const loaded = loadWorkspaceWatcherCycleMetrics(options);
  const started = loaded.records
    .map((record) => String(record.startedAt || '').trim())
    .filter(Boolean)
    .sort();
  return {
    collectionStartedAt: loaded.collectionStartedAt,
    updatedAt: loaded.updatedAt,
    recordCount: loaded.records.length,
    openCount: loaded.records.filter((record) => !record.closedAt).length,
    oldestStartedAt: started[0] || '',
    newestStartedAt: started.at(-1) || '',
    retention: loaded.retention,
    lastError: loaded.errors || null,
  };
}

/**
 * Read-modify-write under the shared watcher lock. `mutate` returns the next
 * document or `null`/`false` to leave it unchanged.
 *
 * @param {{ dataDir?: string, now?: number }} options
 * @param {(doc: object) => object | null | false | undefined} mutate
 * @returns {object}
 */
function mutateDocument(options, mutate) {
  const file = getWorkspaceWatcherCycleMetricsDataPath(options);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const at = new Date(now).toISOString();
  return withWorkspaceWatchersFileLock(() => {
    const doc = readDocument(file);
    const next = mutate(doc);
    if (!next) return doc;
    next.v = WORKSPACE_WATCHER_CYCLE_METRICS_SCHEMA_VERSION;
    next.updatedAt = at;
    if (!String(next.collectionStartedAt || '').trim()) next.collectionStartedAt = at;
    next.records = pruneWorkspaceWatcherCycleMetrics(next.records || {}, {
      now,
      retentionMs: next.retention?.ms,
      maxRecords: next.retention?.maxRecords,
    });
    writeJsonAtomic(file, next);
    return next;
  }, { dataDir: options.dataDir });
}

/**
 * Create the record for a reservation if it does not exist yet. Called at slot
 * reservation, so a start that never reaches `running` still lands in the store.
 *
 * @param {{
 *   cycleId?: string,
 *   workspaceFolder?: string,
 *   mode?: string,
 *   planOnly?: boolean,
 *   orchestratorChatId?: string,
 *   todoIds?: string[],
 *   startedAt?: string,
 *   phase?: string,
 *   dataDir?: string,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, created: boolean, record: object | null }}
 */
export function beginWorkspaceWatcherCycleMetric(input = {}) {
  const cycleId = String(input.cycleId ?? '').trim();
  if (!cycleId) return { ok: false, created: false, record: null };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  let created = false;
  const doc = mutateDocument({ dataDir: input.dataDir, now }, (current) => {
    const existing = normalizeWorkspaceWatcherCycleMetric(current.records[cycleId]);
    if (existing) return null;
    created = true;
    current.records[cycleId] = normalizeWorkspaceWatcherCycleMetric({
      cycleId,
      workspaceFolder: input.workspaceFolder,
      mode: input.mode,
      planOnly: input.planOnly === true,
      orchestratorChatId: input.orchestratorChatId,
      todoIds: input.todoIds,
      startedAt: String(input.startedAt ?? '').trim() || at,
      phase: input.phase || 'starting',
      createdAt: at,
      updatedAt: at,
    });
    return current;
  });
  return { ok: true, created, record: normalizeWorkspaceWatcherCycleMetric(doc.records[cycleId]) };
}

/**
 * Stamp the requested orchestrator pair right after `model_pick` resolves.
 * No-op (replay) when the record is already closed, so a late writer cannot
 * rewrite history.
 *
 * @param {{
 *   cycleId?: string,
 *   requestedHarness?: string | null,
 *   requestedModel?: string | null,
 *   requestedSource?: string | null,
 *   dataDir?: string,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, updated: boolean, record: object | null }}
 */
export function stampWorkspaceWatcherCycleMetricRequest(input = {}) {
  const cycleId = String(input.cycleId ?? '').trim();
  if (!cycleId) return { ok: false, updated: false, record: null };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  let updated = false;
  const doc = mutateDocument({ dataDir: input.dataDir, now }, (current) => {
    const existing = normalizeWorkspaceWatcherCycleMetric(current.records[cycleId]);
    if (!existing || existing.closedAt) return null;
    current.records[cycleId] = normalizeWorkspaceWatcherCycleMetric({
      ...existing,
      requestedHarness: input.requestedHarness ?? existing.requestedHarness,
      requestedModel: input.requestedModel ?? existing.requestedModel,
      requestedSource: input.requestedSource ?? existing.requestedSource,
      updatedAt: at,
    });
    updated = true;
    return current;
  });
  return { ok: true, updated, record: normalizeWorkspaceWatcherCycleMetric(doc.records[cycleId]) };
}

/**
 * Record that the orchestrator run actually started.
 *
 * @param {{
 *   cycleId?: string,
 *   orchestratorRunId?: string | null,
 *   harness?: string | null,
 *   dataDir?: string,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, updated: boolean, record: object | null }}
 */
export function markWorkspaceWatcherCycleMetricRunning(input = {}) {
  const cycleId = String(input.cycleId ?? '').trim();
  if (!cycleId) return { ok: false, updated: false, record: null };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  let updated = false;
  const doc = mutateDocument({ dataDir: input.dataDir, now }, (current) => {
    const existing = normalizeWorkspaceWatcherCycleMetric(current.records[cycleId]);
    if (!existing || existing.closedAt) return null;
    current.records[cycleId] = normalizeWorkspaceWatcherCycleMetric({
      ...existing,
      orchestratorRunId: input.orchestratorRunId ?? existing.orchestratorRunId,
      harness: input.harness ?? existing.harness,
      phase: 'running',
      reachedRunning: true,
      updatedAt: at,
    });
    updated = true;
    return current;
  });
  return { ok: true, updated, record: normalizeWorkspaceWatcherCycleMetric(doc.records[cycleId]) };
}

/**
 * Close one cycle metric. Idempotent by `cycleId`: a duplicate close returns the
 * first record untouched and never creates a second metric. A close for a cycle
 * with no prior `begin` (a legacy slot from before this store existed) creates a
 * record from the supplied identity, with unknown fields left null.
 *
 * @param {{
 *   cycleId?: string,
 *   workspaceFolder?: string,
 *   mode?: string | null,
 *   orchestratorChatId?: string | null,
 *   orchestratorRunId?: string | null,
 *   harness?: string | null,
 *   todoIds?: string[],
 *   claimedTodoIds?: string[],
 *   reportedTodoIds?: string[],
 *   unknownReportedTodoIds?: string[],
 *   completedTodoIds?: string[],
 *   todoOutcomes?: object[],
 *   planOnly?: boolean,
 *   planSaved?: boolean,
 *   blockedReasonCode?: string | null,
 *   startedAt?: string,
 *   closedAt?: string,
 *   closeSource?: string,
 *   closeReason?: string,
 *   reportedOutcome?: string | null,
 *   closeOutcome?: string | null,
 *   todoStatusAtClose?: string | null,
 *   reachedRunning?: boolean,
 *   dataDir?: string,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, created: boolean, replay: boolean, record: object | null }}
 */
export function finalizeWorkspaceWatcherCycleMetric(input = {}) {
  const cycleId = String(input.cycleId ?? '').trim();
  if (!cycleId) return { ok: false, created: false, replay: false, record: null };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  const closedAt = String(input.closedAt ?? '').trim() || at;
  let created = false;
  let replay = false;
  const doc = mutateDocument({ dataDir: input.dataDir, now }, (current) => {
    const existing = normalizeWorkspaceWatcherCycleMetric(current.records[cycleId]);
    if (existing?.closedAt) {
      replay = true;
      return null;
    }
    if (!existing) created = true;
    current.records[cycleId] = normalizeWorkspaceWatcherCycleMetric({
      ...(existing || {}),
      cycleId,
      workspaceFolder: input.workspaceFolder ?? existing?.workspaceFolder,
      mode: input.mode ?? existing?.mode ?? null,
      orchestratorChatId: input.orchestratorChatId ?? existing?.orchestratorChatId ?? null,
      orchestratorRunId: input.orchestratorRunId ?? existing?.orchestratorRunId ?? null,
      harness: input.harness ?? existing?.harness ?? null,
      todoIds: Array.isArray(input.todoIds) && input.todoIds.length ? input.todoIds : existing?.todoIds,
      claimedTodoIds: Array.isArray(input.claimedTodoIds) && input.claimedTodoIds.length
        ? input.claimedTodoIds
        : existing?.claimedTodoIds,
      reportedTodoIds: Array.isArray(input.reportedTodoIds) ? input.reportedTodoIds : existing?.reportedTodoIds,
      unknownReportedTodoIds: Array.isArray(input.unknownReportedTodoIds)
        ? input.unknownReportedTodoIds
        : existing?.unknownReportedTodoIds,
      completedTodoIds: Array.isArray(input.completedTodoIds)
        ? input.completedTodoIds
        : existing?.completedTodoIds,
      todoOutcomes: Array.isArray(input.todoOutcomes) && input.todoOutcomes.length
        ? input.todoOutcomes
        : existing?.todoOutcomes,
      planOnly: input.planOnly === true || existing?.planOnly === true,
      planSaved: input.planSaved === true || existing?.planSaved === true,
      blockedReasonCode: input.blockedReasonCode ?? existing?.blockedReasonCode ?? null,
      startedAt: String(input.startedAt ?? '').trim() || existing?.startedAt || closedAt,
      closedAt,
      closeSource: input.closeSource ?? 'reconcile',
      closeReason: input.closeReason ?? existing?.closeReason ?? null,
      reportedOutcome: input.reportedOutcome ?? existing?.reportedOutcome ?? null,
      closeOutcome: input.closeOutcome ?? existing?.closeOutcome ?? null,
      todoStatusAtClose: input.todoStatusAtClose ?? existing?.todoStatusAtClose ?? null,
      reachedRunning: input.reachedRunning === true || existing?.reachedRunning === true,
      phase: 'closed',
      createdAt: existing?.createdAt || at,
      updatedAt: at,
    });
    return current;
  });
  return { ok: true, created, replay, record: normalizeWorkspaceWatcherCycleMetric(doc.records[cycleId]) };
}

/**
 * Idempotently persist the correlated usage summary on a closed cycle.
 *
 * This is a one-shot write: once `usageFinalizedAt` (or the `usageExpired`
 * marker) is set, the stored record is returned untouched and the sums never
 * change. The write goes through the same locked read-modify-write and atomic
 * rename as every other record, so a process restart during finalization either
 * leaves the previous record (a retry writes the final sums) or the completely
 * written one (a retry replays) — never a partially written sum.
 *
 * @param {{
 *   cycleId?: string,
 *   usage?: object | null,
 *   finalized?: boolean,
 *   expired?: boolean,
 *   finalizedAt?: string,
 *   dataDir?: string,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, persisted: boolean, replay: boolean, record: object | null }}
 */
export function persistWorkspaceWatcherCycleUsage(input = {}) {
  const cycleId = String(input.cycleId ?? '').trim();
  if (!cycleId) return { ok: false, persisted: false, replay: false, record: null };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  const finalizedAt = String(input.finalizedAt ?? '').trim() || at;
  let persisted = false;
  let replay = false;
  const doc = mutateDocument({ dataDir: input.dataDir, now }, (current) => {
    const existing = normalizeWorkspaceWatcherCycleMetric(current.records[cycleId]);
    // Only a known cycle can be finalized: a foreign/typo id must never create
    // a usage-only record with no identity.
    if (!existing) return null;
    if (existing.usageFinalizedAt || existing.usageExpired) {
      replay = true;
      return null;
    }
    const expired = input.expired === true;
    const finalized = !expired && input.finalized === true;
    current.records[cycleId] = normalizeWorkspaceWatcherCycleMetric({
      ...existing,
      usage: expired ? null : normalizeWorkspaceWatcherCycleUsage(input.usage),
      usageFinalized: finalized,
      usageFinalizedAt: finalized ? finalizedAt : null,
      usageProvisional: false,
      usageExpired: expired,
      updatedAt: at,
    });
    persisted = true;
    return current;
  });
  return {
    ok: true,
    persisted,
    replay,
    record: normalizeWorkspaceWatcherCycleMetric(doc.records[cycleId]),
  };
}

/**
 * Persist a telemetry limitation so a later API/UI leaf can surface it. This is
 * the only function a failing caller calls back into; it swallows its own IO
 * failure because it is already the failure path.
 *
 * @param {{
 *   dataDir?: string,
 *   now?: number,
 *   operation?: string,
 *   code?: string,
 *   message?: string,
 * }} input
 * @returns {{ ok: boolean, errors: object | null }}
 */
export function recordWorkspaceWatcherCycleMetricsError(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  try {
    const doc = mutateDocument({ dataDir: input.dataDir, now }, (current) => {
      const previous = current.errors && typeof current.errors === 'object' ? current.errors : {};
      current.errors = {
        count: Math.max(0, Math.floor(Number(previous.count) || 0)) + 1,
        lastAt: at,
        lastCode: String(input.code ?? '').trim().slice(0, 80) || 'WORKSPACE_WATCHER_CYCLE_METRICS',
        lastMessage: String(input.message ?? '').trim().slice(0, 300),
        lastOperation: String(input.operation ?? '').trim().slice(0, 40),
      };
      return current;
    });
    return { ok: true, errors: doc.errors || null };
  } catch {
    return { ok: false, errors: null };
  }
}
