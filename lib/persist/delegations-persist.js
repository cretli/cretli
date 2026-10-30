import { notifyDecisionGateChange } from '../decisions/gate-changes.js';
/**
 * Durable delegation records (plan execution jobs).
 */

import { normalizeSessionResumeRecord } from '../delegation-session-resume-record.js';
import { normalizeSessionContinuity } from '../delegation-session-continuity-normalize.js';
import { normalizeReviewerPolicySnapshot } from '../reviewer-policy-snapshot.js';
import { resolveRecordTreeFields } from '../delegation-tree.js';
import { readRowWorkRole } from '../delegation-work-role.js';
import { randomUUID } from 'crypto';
import {
  normalizeDelegationAssignment,
  normalizeDelegationReviewSubject,
  normalizeDelegationReviewSubjectSource,
} from '../delegation-request.js';
import { normalizeDelegationAckActor } from '../delegation-ack-actor.js';
import { normalizeDelegationCodeReviewMode } from '../delegation-code-review-phase.js';
import { normalizeComplexity } from '../model-pick-complexity.js';
import { emptyMetrics, normalizeMetrics } from '../delegation-metrics.js';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureDelegationOwnerLock } from '../delegation-owner-lock.js';
import {
  DELEGATIONS_JSON_SCHEMA_VERSION,
  assertDelegationsJsonSchemaVersion,
} from './delegation-schema.js';
import { getDelegationStoreBackend } from './delegation-store-backend.js';
import {
  loadDelegationsSqliteCached,
  openDelegationSqlite,
  upsertDelegationSqlite,
  withDelegationSqliteTransaction,
  getDelegationSqliteById,
  queryDelegationsSqlite,
} from './delegation-sqlite.js';
import { isTickRelevantDelegation, workspaceIndexKey } from './delegation-index-fields.js';
import {
  isActiveDelegationStatus,
  isDelegationSlotOccupied,
  normalizeDelegationStatus,
} from '../delegation-status.js';
import {
  DELEGATION_SLOT_HELD_BY_RUNNING,
  normalizeDelegationSlotHeldBy,
} from '../delegation-status.js';
import { normalizeDelegationStopProof } from '../delegation-slot-stop.js';
import { markAgentPresenceDirty } from '../agent-presence-hooks.js';
import { notifyDelegationChange } from '../delegation-change-signal.js';
import { delegationController } from '../delegation-control.js';
import { DELEGATION_VERDICTS } from '../delegation-verdict.js';
import { normalizeTodoRefId } from '../todo-ref.js';

/** @typedef {import('../shared-types/persist-records.js').DelegationRecord} DelegationRecord */
import { normalizePlanPaceSnapshot as normalizeSharedPlanPaceSnapshot } from '../model-pick-plan-window.js';

const DATA_FILE = resolveDataPath('delegations.json');


/**
 * @param {any} value
 * @returns {string}
 */
function normalizeWorkRole(value) {
  return readRowWorkRole({ workRole: value });
}

/**
 * Settings decision recorded on each start: which switch applied, whether it
 * was on, and the scope/source at that moment. Null when never evaluated.
 *
 * @param {any} raw
 * @returns {{ field: string, enabled: boolean, source: string, scope: string, reason: string } | null}
 */
function normalizeContinuationPolicySnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    field: String(raw.field || '').trim(),
    enabled: raw.enabled === true,
    source: String(raw.source || '').trim(),
    scope: String(raw.scope || '').trim(),
    reason: String(raw.reason || '').trim(),
  };
}

/**
 * Parsed delegation documents keyed by absolute path. A write through
 * `saveItems` drops the entry; an external rewrite misses on inode/size/mtime.
 *
 * @type {Map<string, { signature: string, doc: { v: number, items: Record<string, any>[] } }>}
 */
const documentCache = new Map();

/**
 * Chat and workspace indexes built from one document parse. Dropped with the
 * document cache on write. Rows are the defaulted objects; hot readers must
 * not mutate them.
 *
 * @type {Map<string, { signature: string, byChat: Map<string, Record<string, any>[]>, byWorkspace: Map<string, Record<string, any>[]>, active: Record<string, any>[] }>}
 */
const delegationIndexCache = new Map();

/**
 * @param {string} filePath
 * @returns {string}
 */
function readFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveDelegationsJsonPath(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  const dir = configured || resolveDataPath();
  return path.join(dir, 'delegations.json');
}

function notifyDelegationPresence(row) {
  if (!row) return;
  notifyDecisionGateChange(row.workspaceFolder);
  const ids = [...new Set([delegationController(row), row.parentChatId, row.childChatId]
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (ids.length === 0) return;
  markAgentPresenceDirty(ids);
}

const SCHEMA_VERSION = DELEGATIONS_JSON_SCHEMA_VERSION;

export class DelegationsCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'DelegationsCorruptError';
    this.code = 'DELEGATIONS_CORRUPT';
  }
}

export class DelegationsIoError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause) {
    super(message);
    this.name = 'DelegationsIoError';
    this.code = 'DELEGATIONS_IO';
    this.cause = cause;
  }
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @returns {string}
 */
export function getDelegationsDataPath() {
  return DATA_FILE;
}

/**
 * Keep the original file and copy a diagnostic snapshot for operators.
 *
 * @param {string} reason
 */
function preserveCorruptCopy(reason) {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = `${DATA_FILE}.corrupt-${stamp}`;
    fs.copyFileSync(DATA_FILE, dest);
    fs.writeFileSync(`${dest}.reason.txt`, String(reason || 'corrupt'), 'utf8');
  } catch {
    // The original file must stay untouched even if the snapshot fails.
  }
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {{ v: number, items: Record<string, any>[] }}
 */
function loadDocument(options = {}) {
  const dataFile = String(options.dataDir ?? '').trim()
    ? resolveDelegationsJsonPath(options)
    : DATA_FILE;
  const dir = path.dirname(dataFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dataFile)) return { v: SCHEMA_VERSION, items: [] };
  const signature = readFileSignature(dataFile);
  const cached = signature ? documentCache.get(dataFile) : null;
  if (cached && cached.signature === signature) return cached.doc;
  let raw;
  try {
    raw = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new DelegationsIoError(
      `Could not read delegations store (${err instanceof Error ? err.message : String(err)})`,
      err,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    preserveCorruptCopy(err instanceof Error ? err.message : String(err));
    throw new DelegationsCorruptError(
      `Delegations file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    preserveCorruptCopy('not-an-object');
    throw new DelegationsCorruptError('Delegations file is not an object');
  }
  if (String(parsed.backend || '').trim() === 'sqlite') {
    throw new DelegationsCorruptError('Delegations JSON was migrated to SQLite; refusing to rewrite it');
  }
  if (parsed.items != null && !Array.isArray(parsed.items)) {
    preserveCorruptCopy('items-not-array');
    throw new DelegationsCorruptError('Delegations file items must be an array');
  }
  const version = assertDelegationsJsonSchemaVersion(parsed.v);
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    : [];
  const doc = {
    v: version,
    items,
  };
  if (signature) documentCache.set(dataFile, { signature, doc });
  return doc;
}

/**
 * Writes the whole file, then re-seeds the document cache with the rows just
 * written so the next read does not re-parse tens of MB. The cached array is a
 * copy and rows the caller keeps (returned records) are cloned, so callers can
 * not mutate cached state.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>[]} [sharedRows] rows also handed back to the caller
 */
function saveItems(items, sharedRows = []) {
  ensureDelegationOwnerLock();
  ensureDir();
  rowIndexCache = null;
  documentCache.delete(DATA_FILE);
  delegationIndexCache.delete(DATA_FILE);
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
  const signature = readFileSignature(DATA_FILE);
  if (!signature) return;
  const shared = new Set(sharedRows);
  const cachedItems = items
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => (shared.has(row) ? structuredClone(row) : row));
  documentCache.set(DATA_FILE, { signature, doc: { v: SCHEMA_VERSION, items: cachedItems } });
}

/**
 * Hot paths (per streamed harness event) look up one record by id. Parsing
 * the whole store for each lookup blocks the event loop, so rows are indexed
 * by id and serialized per call to keep callers' copies independent.
 *
 * @type {{ signature: string, rows: Map<string, Record<string, any>> } | null}
 */
let rowIndexCache = null;

/**
 * @returns {string}
 */
function readDataFileSignature() {
  try {
    const stat = fs.statSync(DATA_FILE);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * @param {string} id
 * @returns {string | null}
 */
function findCachedRowJson(id) {
  const signature = readDataFileSignature();
  if (!signature) return null;
  if (rowIndexCache?.signature !== signature) {
    const rows = new Map();
    for (const row of loadDocument().items) {
      if (typeof row.id === 'string' && !rows.has(row.id)) rows.set(row.id, row);
    }
    rowIndexCache = { signature, rows };
  }
  const row = rowIndexCache.rows.get(id);
  return row ? JSON.stringify(row) : null;
}

/**
 * @param {any} value
 * @returns {Record<string, any>[]}
 */
function asObjectArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

/**
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
/**
 * @param {any} input
 * @returns {string}
 */
function normalizeDelegationRecordLeafId(input) {
  if (!input || typeof input !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (input);
  const raw = row.leafId ?? row.leaf_id ?? row.todoId ?? row.todo_id ?? '';
  return normalizeTodoRefId(raw);
}

/**
 * A delivered outbox item is never replayed: the flush only visits undelivered
 * items, and the parent reply it produced lives in the mailbox row. Its
 * snapshot (a full report copy) is dropped down to the ids diagnostics use, so
 * every whole-file write stops re-serializing a second copy of each report.
 *
 * @param {Record<string, any>} item
 * @returns {Record<string, any>}
 */
function slimDeliveredOutboxItem(item) {
  if (!String(item.deliveredAt || '').trim()) return item;
  const snapshot = item.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return item;
  const keys = Object.keys(snapshot);
  if (keys.every((key) => key === 'attemptId' || key === 'eventId')) return item;
  return {
    ...item,
    snapshot: {
      attemptId: String(snapshot.attemptId || '').trim(),
      eventId: String(snapshot.eventId || '').trim(),
    },
  };
}

function withRecordDefaults(row) {
  const attempts = asObjectArray(row.attempts);
  const outbox = asObjectArray(row.outbox).map(slimDeliveredOutboxItem);
  const errors = asObjectArray(row.errors);
  return {
    ...row,
    // Idempotent, non-destructive backfill: legacy rows are depth 1 with the
    // direct parent as root.
    ...resolveRecordTreeFields(row),
    leafId: normalizeDelegationRecordLeafId(row),
    revision: Number(row.revision) > 0 ? Number(row.revision) : 1,
    statusRevision: Number(row.statusRevision) > 0 ? Number(row.statusRevision) : 1,
    eventId: String(row.eventId || '').trim(),
    attempts,
    outbox,
    errors,
    unverified: row.unverified !== false,
    // Legacy rows predate the field; default it so the API and card never
    // read `undefined`.
    pickReason: String(row.pickReason || '').trim(),
    // Explicit, default-off permission for this child to delegate further.
    allowChildDelegations: row.allowChildDelegations === true,
    pickId: String(row.pickId || '').trim(),
    pickOrigin: String(row.pickOrigin || '').trim().toLowerCase(),
    pickOriginDetail: String(row.pickOriginDetail || '').trim(),
    pickLinkStatus: String(row.pickLinkStatus || '').trim(),
    pickRole: String(row.pickRole || '').trim().toLowerCase(),
    startContext: String(row.startContext || '').trim(),
    startContextSource: String(row.startContextSource || '').trim(),
    continuationOf: String(row.continuationOf || '').trim(),
    uiActionProof: row.uiActionProof === true,
    pickFallbackFrom: String(row.pickFallbackFrom || '').trim(),
    // Attempt-level fallback proof: the failed predecessor attempt and the
    // replacement attempt it was issued for (a retry mints a new attemptId).
    pickFallbackFromAttemptId: String(row.pickFallbackFromAttemptId || '').trim(),
    pickFallbackAttemptId: String(row.pickFallbackAttemptId || '').trim(),
    fallbackFailureClass: String(row.fallbackFailureClass || '').trim(),
    // Legacy rows predate the runner/workspace split; empty means the logical
    // workspace is the runner cwd.
    executionFolder: String(row.executionFolder || '').trim(),
    acknowledgedAttemptId: String(row.acknowledgedAttemptId || '').trim(),
    acknowledgedReason: String(row.acknowledgedReason || '').trim().toLowerCase(),
    acknowledgedExpectedTodoRevision: String(row.acknowledgedExpectedTodoRevision || '').trim(),
    interruptCode: String(row.interruptCode || '').trim(),
    interruptContinuedAt: String(row.interruptContinuedAt || '').trim(),
    // Legacy rows predate per-run metrics; default to the all-null shape so the
    // API and aggregation never read `undefined`. All fields stay nullable.
    metrics: normalizeMetrics(row.metrics),
    // Bounded startup-retry bookkeeping. `null` (never retried / cleared) is
    // the default so the API and tests never read `undefined`.
    startupRetry: row.startupRetry && typeof row.startupRetry === 'object' && !Array.isArray(row.startupRetry)
      ? {
        used: Math.max(0, Math.floor(Number(row.startupRetry.used) || 0)),
        lastError: String(row.startupRetry.lastError || '').trim(),
        scheduledAt: String(row.startupRetry.scheduledAt || '').trim(),
      }
      : null,
    verifyResult: normalizeVerifyResult(row.verifyResult),
    verifyPending: normalizeVerifyPending(row.verifyPending),
    // Host-verify policy captured at start: a review whose executor cannot run
    // the review-verify runner itself needs a parent `delegation_verify` before
    // the cycle can be accepted. Legacy rows leave both false/null.
    verifyRequired: row.verifyRequired === true,
    reviewCanRunTests: row.reviewCanRunTests === true,
    reviewCanRunTestsSource: String(row.reviewCanRunTestsSource || '').trim(),
    // Parsed verdict persisted at finalization so `delegation_show` and the
    // workflow do not have to re-parse the report text. Legacy rows default to
    // empty and readers fall back to parsing.
    reportVerdict: DELEGATION_VERDICTS.includes(String(row.reportVerdict || '').trim())
      ? String(row.reportVerdict || '').trim()
      : '',
    reportDegraded: row.reportDegraded === true,
    reportSummary: String(row.reportSummary || '').trim(),
    // Explicit review subject (`docs/todo-review-contract.md` §3). A record that
    // predates the field is never defaulted to `code`: it reads as `other` with
    // an `unknown` source.
    reviewSubject: normalizeDelegationReviewSubject(row.reviewSubject) || 'other',
    reviewSubjectSource: normalizeDelegationReviewSubjectSource(row.reviewSubjectSource) || 'unknown',
    // Empty on legacy rows and on non-plan reviews.
    todoPlanRevisionKey: String(row.todoPlanRevisionKey || '').trim(),
    // Content-only plan key and leaf material revision at review start (recheck
    // gate); empty on legacy rows.
    todoPlanContentKey: String(row.todoPlanContentKey || '').trim(),
    reviewedMaterialRevision: String(row.reviewedMaterialRevision || '').trim(),
    reviewMode: normalizeDelegationCodeReviewMode(row.reviewMode),
    // Compact parsed-findings summary of a code review report (null when absent).
    reviewFindings: normalizeReviewFindingsSummary(row.reviewFindings),
    // Review lessons shown in this run's prompt (always an array; empty when none).
    injectedLessonIds: normalizeInjectedLessonIds(row.injectedLessonIds),
    lessonsInjectedAt: String(row.lessonsInjectedAt || '').trim(),
    planReviewerSessionId: String(row.planReviewerSessionId || '').trim(),
    // Server session-resume decision; null only on legacy rows or starts whose
    // role has no continuation policy.
    sessionResume: normalizeSessionResumeRecord(row.sessionResume),
    sessionContinuity: normalizeSessionContinuity(row.sessionContinuity),
    sessionContinuityConfirmed: row.sessionContinuityConfirmed === true,
    // Server-classified work role (plan / implement / fix / review_*); empty on
    // legacy rows, which are never eligible reuse sources for work roles.
    workRole: normalizeWorkRole(row.workRole),
    continuationPolicy: normalizeContinuationPolicySnapshot(row.continuationPolicy),
    // Reviewer policy in force at start + reuse decision; null on legacy rows.
    reviewerPolicy: normalizeReviewerPolicySnapshot(row.reviewerPolicy),
    // Prompt-prefix fingerprint and cache generation seen at the last prompt
    // build; input for lib/usage/cache-regression.ts. Empty on legacy rows.
    promptPrefixFingerprint: String(row.promptPrefixFingerprint || '').trim(),
    promptCacheGeneration: Math.max(0, Number(row.promptCacheGeneration) || 0),
    reviewUncertified: normalizeReviewUncertified(row.reviewUncertified),
    planReviewerPhase: String(row.planReviewerPhase || '').trim() || 'independent',
    exchangeOfDelegationId: String(
      row.exchangeOfDelegationId || row.originDelegationId || '',
    ).trim(),
    // Queue time captured at creation/retry. Legacy rows fall back to `createdAt`
    // so pre-start chronology still has a stable anchor.
    queuedAt: String(row.queuedAt || row.createdAt || '').trim(),
    // Acceptance actor (`docs/todo-review-contract.md` §7.2). Empty until an
    // acknowledgement records one; an unrecognized stored actor reads as empty.
    acknowledgedActor: normalizeDelegationAckActor(row.acknowledgedActor),
    // Spurious terminal repeats (second `sdkRunFinished` for the same attempt)
    // are counted for diagnostics and never appended to `errors[]`.
    afterTerminalCount: Number(row.afterTerminalCount) > 0
      ? Math.floor(Number(row.afterTerminalCount))
      : 0,
    slotHeldBy: normalizeDelegationSlotHeldBy(row.slotHeldBy),
    stopProof: normalizeDelegationStopProof(row.stopProof),
    cancelEscalatedAt: String(row.cancelEscalatedAt || '').trim(),
    runDeadlineAt: String(row.runDeadlineAt || '').trim(),
    runDefaultLimitActive: row.runDefaultLimitActive === true,
    runDeadlineCancelKey: String(row.runDeadlineCancelKey || '').trim(),
    cancelCause: String(row.cancelCause || '').trim(),
  };
}

function normalizeVerifyResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value.status === 'passed' || value.status === 'failed' ? value.status : '';
  if (!status) return null;
  const rawVerdict = String(value.verdict || '').trim();
  const verdict = DELEGATION_VERDICTS.includes(rawVerdict) ? rawVerdict : '';
  const exitCode = Number.isFinite(Number(value.exitCode))
    ? Math.floor(Number(value.exitCode))
    : status === 'passed' ? 0 : 1;
  return {
    status,
    exitCode,
    verdict,
    source: String(value.source || '').trim(),
    dataDir: String(value.dataDir || '').trim(),
    recordedAt: String(value.recordedAt || '').trim(),
    attemptId: String(value.attemptId || '').trim(),
    materialRevision: String(value.materialRevision || '').trim(),
    ids: Array.isArray(value.ids)
      ? value.ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 200)
      : [],
    outputTail: String(value.outputTail || '').slice(-VERIFY_OUTPUT_TAIL_MAX),
    implementDelegationId: String(value.implementDelegationId || '').trim(),
    stale: value.stale === true,
    ...normalizeVerifyManifest(value),
    ...normalizeManifestEvidence(value),
    ...normalizeVerifyClassification(value),
  };
}

/**
 * Optional informational classification of the manifest evidence.
 *
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function normalizeManifestEvidence(value) {
  const e = value.manifestEvidence;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return { manifestEvidence: { usable: e.usable === true, reason: String(e.reason || '').slice(0, 40) } };
}

/**
 * Optional required-test manifest (additive; legacy records carry none).
 *
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function normalizeVerifyManifest(value) {
  const m = value.manifest;
  if (!m || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.entries)) return {};
  return {
    manifest: {
      schemaVersion: 1,
      attemptId: String(m.attemptId || '').trim(),
      materialRevision: String(m.materialRevision || '').trim(),
      envKey: String(m.envKey || '').trim(),
      testSetKey: String(m.testSetKey || '').trim(),
      entries: m.entries.slice(0, 200).map((e) => ({
        id: String(e?.id || '').trim(),
        path: String(e?.path || '').trim(),
        sha256: String(e?.sha256 || '').trim(),
        origin: e?.origin === 'curated' ? 'curated' : 'audited',
      })).filter((e) => e.id),
    },
  };
}

/**
 * Optional baseline classification fields; legacy records carry none.
 *
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function normalizeVerifyClassification(value) {
  if (!value.baseline || typeof value.baseline !== 'object') return {};
  const idList = (list) => (Array.isArray(list)
    ? list.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 200)
    : []);
  const baseline = /** @type {Record<string, unknown>} */ (value.baseline);
  return {
    rawOk: value.rawOk === true,
    newFailures: idList(value.newFailures),
    preexistingFailures: idList(value.preexistingFailures),
    flakyFailures: idList(value.flakyFailures),
    baseline: {
      source: String(baseline.source || '').trim(),
      baseCommit: String(baseline.baseCommit || '').trim(),
      reason: String(baseline.reason || '').slice(0, 300),
    },
    // Passing checks keep no output: dozens of 4 KB tails per row made
    // verifyResult the largest field of recent records.
    results: (Array.isArray(value.results) ? value.results : []).slice(0, 200).map((row) => ({
      id: String(row?.id || '').trim(),
      ok: row?.ok === true,
      durationMs: Number(row?.durationMs) || 0,
      outputTail: row?.ok === true ? '' : String(row?.outputTail || '').slice(-VERIFY_OUTPUT_TAIL_MAX),
    })),
  };
}

const VERIFY_OUTPUT_TAIL_MAX = 4096;

/**
 * Marker written with the terminal update of an implement/fix while the
 * automatic host verify is still running.
 *
 * @param {any} value
 * @returns {{ since: string, revision: string } | null}
 */
function normalizeVerifyPending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const since = String(value.since || '').trim();
  if (!since) return null;
  return { since, revision: String(value.revision || '').trim() };
}

function isSqliteStore() {
  return getDelegationStoreBackend() === 'sqlite';
}

/**
 * Defaulted copies of every record: fresh top-level objects that callers may edit. Nested elements
 * (attempts, outbox, ...) are still shared with the store cache, so mutate only top-level fields or replace
 * nested values. Every call normalizes and copies every row, so read-only hot paths should use `loadDelegationsReadonly()`.
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>[]}
 */
export function loadDelegations(options = {}) {
  const source = isSqliteStore()
    ? loadDelegationsSqliteCached(openDelegationSqlite())
    : loadDocument(options).items;
  return source.map((row) => withRecordDefaults(row));
}

/**
 * Deep-frozen normalized form per cached source row. Cached rows are replaced (never mutated) on every
 * write, so a row identity is a valid key and the entry dies with the row.
 *
 * @type {WeakMap<object, Record<string, any>>}
 */
const frozenRowMemo = new WeakMap();

/**
 * Last read-only snapshot per store (json file path or `sqlite`): the source rows it was built from and
 * the frozen array handed out.
 *
 * @type {Map<string, { source: Record<string, any>[], rows: Record<string, any>[] }>}
 */
const readonlySnapshots = new Map();

/** Counters for tests and profiling: rows normalized, snapshots rebuilt, and snapshots served as-is. */
export const delegationLoadStats = { rowsNormalized: 0, snapshotBuilds: 0, snapshotHits: 0 };

/**
 * Deep clone of JSON-shaped data (delegation rows come from JSON, so only plain arrays/objects occur).
 *
 * @param {any} value
 * @returns {any}
 */
function cloneJsonValue(value) {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneJsonValue(value[key]);
    return out;
  }
  return value;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Shared, deep-frozen snapshot of all records with the same normalization as `loadDelegations()` but no
 * per-call copying. The same array is returned while the store is unchanged; any write (in process, or an
 * external rewrite detected by the document cache signature / SQLite row revisions) yields a new snapshot
 * that re-normalizes only the rows that changed. Rows are frozen: mutating one throws in strict mode, so a
 * caller can never poison what other readers see. Use `loadDelegations()` when you need to edit rows.
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>[]} typed mutable so mutable-typed callers keep compiling; the array and every row are deep-frozen, never mutate them
 */
export function loadDelegationsReadonly(options = {}) {
  const sqlite = isSqliteStore();
  const source = sqlite
    ? loadDelegationsSqliteCached(openDelegationSqlite())
    : loadDocument(options).items;
  const storeKey = sqlite ? 'sqlite' : resolveDelegationsJsonPath(options);
  const previous = readonlySnapshots.get(storeKey);
  if (
    previous
    && (previous.source === source
      || (previous.source.length === source.length && previous.source.every((row, i) => row === source[i])))
  ) {
    delegationLoadStats.snapshotHits += 1;
    return previous.rows;
  }
  const rows = Object.freeze(source.map((row) => {
    let frozen = frozenRowMemo.get(row);
    if (!frozen) {
      // Freeze a private clone: normalized rows share nested elements with the cached source row,
      // which loadDelegations() callers are allowed to mutate.
      frozen = deepFreeze(cloneJsonValue(withRecordDefaults(row)));
      frozenRowMemo.set(row, frozen);
      delegationLoadStats.rowsNormalized += 1;
    }
    return frozen;
  }));
  delegationLoadStats.snapshotBuilds += 1;
  readonlySnapshots.set(storeKey, { source: sqlite ? source : source.slice(), rows });
  return rows;
}

/**
 * @typedef {{
 *   byChat: Map<string, DelegationRecord[]>,
 *   byWorkspace: Map<string, DelegationRecord[]>,
 *   byRootChat: Map<string, DelegationRecord[]>,
 *   byTreeRoot: Map<string, DelegationRecord[]>,
 *   byIdempotencyKey: Map<string, DelegationRecord>,
 *   active: DelegationRecord[],
 * }} DelegationIndexes
 */

/**
 * @param {Map<string, Record<string, any>[]>} map
 * @param {string} key
 * @param {Record<string, any>} row
 */
function pushIndexed(map, key, row) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

/**
 * @param {Record<string, any>[]} items
 * @returns {DelegationIndexes}
 */
function buildDelegationIndexes(items) {
  const byChat = new Map();
  const byWorkspace = new Map();
  const byRootChat = new Map();
  const byTreeRoot = new Map();
  const byIdempotencyKey = new Map();
  const active = [];
  for (const raw of items) {
    const row = withRecordDefaults(raw);
    if (isTickRelevantDelegation(row)) active.push(row);
    const indexedChatIds = new Set([delegationController(row), row.parentChatId, row.childChatId]
      .map((chatId) => String(chatId || '').trim())
      .filter(Boolean));
    for (const key of indexedChatIds) pushIndexed(byChat, key, row);
    pushIndexed(byWorkspace, workspaceIndexKey(row.workspaceFolder), row);
    const tree = resolveRecordTreeFields(row);
    pushIndexed(byRootChat, tree.rootChatId, row);
    pushIndexed(byTreeRoot, tree.rootDelegationId, row);
    // First match wins, like the `find` this index replaces.
    if (row.idempotencyKey && !byIdempotencyKey.has(row.idempotencyKey)) byIdempotencyKey.set(row.idempotencyKey, row);
  }
  return { byChat, byWorkspace, byRootChat, byTreeRoot, byIdempotencyKey, active };
}

/**
 * Indexed rows are shared with the cache; accessors added on top of the
 * index hand out shallow copies, matching what `loadDelegations()` returns.
 *
 * @param {Record<string, any>[] | undefined} rows
 * @returns {Record<string, any>[]}
 */
function copyIndexedRows(rows) {
  return (rows || []).map((row) => ({ ...row }));
}

/**
 * @param {Record<string, any>} [options]
 * @returns {DelegationIndexes}
 */
function readDelegationIndexes(options = {}) {
  const dataFile = resolveDelegationsJsonPath(options);
  const signature = readFileSignature(dataFile);
  const cached = delegationIndexCache.get(dataFile);
  if (cached && signature && cached.signature === signature) return cached;
  const built = buildDelegationIndexes(loadDocument(options).items);
  if (signature) delegationIndexCache.set(dataFile, { signature, ...built });
  return built;
}

/**
 * Defaulted rows whose parent or child chat is in `chatIds`. One row is
 * returned once even when both ends match. SQLite still scans its JSON blobs.
 *
 * @param {string[]} chatIds
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>[]}
 */
export function listDelegationsForChatIds(chatIds, options = {}) {
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (ids.length === 0) return [];
  if (isSqliteStore()) {
    // One JSON parameter instead of one bind variable per id: with every chat id three times in the
    // clause, ~11k chats exceeded SQLITE_MAX_VARIABLE_NUMBER ("too many SQL variables") and the
    // presence flush broke every WebSocket attach.
    const idsJson = JSON.stringify(ids);
    const idSet = 'SELECT value FROM json_each(?)';
    return queryDelegationsSqlite(
      openDelegationSqlite(options),
      `controller_chat_id IN (${idSet}) OR parent_chat_id IN (${idSet}) OR child_chat_id IN (${idSet})`,
      [idsJson, idsJson, idsJson],
    ).map((row) => withRecordDefaults(row));
  }
  const { byChat } = readDelegationIndexes(options);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const rows = byChat.get(id);
    if (!rows) continue;
    for (const row of rows) {
      const key = String(row.id || '');
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(row);
    }
  }
  return out;
}

/**
 * Defaulted rows the runtime tick still has to visit. Finished rows with no
 * stop marker and no pending outbox are omitted. SQLite still scans blobs.
 *
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>[]}
 */
export function listActiveDelegations(options = {}) {
  if (isSqliteStore()) {
    // The column is a prefilter written with the row; re-check the live rule.
    return queryDelegationsSqlite(openDelegationSqlite(options), 'tick_relevant = 1')
      .map((row) => withRecordDefaults(row))
      .filter((row) => isTickRelevantDelegation(row));
  }
  return readDelegationIndexes(options).active;
}

/**
 * Defaulted form per parsed SQLite row. The parsed-row cache replaces a row object on every write, so the
 * row identity is a valid key and the entry dies with the row.
 *
 * @type {WeakMap<object, Record<string, any>>}
 */
const sqliteDefaultedRowMemo = new WeakMap();

/** @type {{ source: Record<string, any>[], byWorkspace: Map<string, Record<string, any>[]> } | null} */
let sqliteWorkspaceIndex = null;

/**
 * Workspace index over the parsed SQLite rows, rebuilt only when a row was added, replaced or removed.
 * Rows and arrays are shared between callers, like the JSON store's `byWorkspace` index.
 *
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {Map<string, Record<string, any>[]>}
 */
function readSqliteWorkspaceIndex(database) {
  const source = loadDelegationsSqliteCached(database);
  const previous = sqliteWorkspaceIndex;
  if (previous && previous.source.length === source.length && previous.source.every((row, i) => row === source[i])) {
    return previous.byWorkspace;
  }
  const byWorkspace = new Map();
  for (const raw of source) {
    let row = sqliteDefaultedRowMemo.get(raw);
    if (!row) {
      row = withRecordDefaults(raw);
      sqliteDefaultedRowMemo.set(raw, row);
    }
    pushIndexed(byWorkspace, workspaceIndexKey(row.workspaceFolder), row);
  }
  sqliteWorkspaceIndex = { source, byWorkspace };
  return byWorkspace;
}

/**
 * Defaulted rows for one workspace. Empty when the folder does not normalize.
 *
 * @param {any} workspaceFolder
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>[]}
 */
export function listDelegationsForWorkspace(workspaceFolder, options = {}) {
  const key = workspaceIndexKey(workspaceFolder);
  if (!key) return [];
  if (isSqliteStore()) return readSqliteWorkspaceIndex(openDelegationSqlite(options)).get(key) || [];
  return readDelegationIndexes(options).byWorkspace.get(key) || [];
}

/**
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
export function getDelegationById(id) {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  if (isSqliteStore()) {
    const row = openDelegationSqlite().prepare('SELECT json FROM delegations WHERE id = ?').get(normalized);
    return row ? withRecordDefaults(JSON.parse(String(row.json))) : null;
  }
  const rowJson = findCachedRowJson(normalized);
  return rowJson ? withRecordDefaults(JSON.parse(rowJson)) : null;
}

/**
 * Jobs controlled by the chat (`controllerChatId`, falling back to the
 * historical `parentChatId`).
 *
 * @param {string} controllerChatId
 * @returns {Record<string, any>[]}
 */
export function listDelegationsForController(controllerChatId) {
  const normalized = String(controllerChatId || '').trim();
  if (!normalized) return [];
  if (isSqliteStore()) {
    return queryDelegationsSqlite(openDelegationSqlite(), 'controller_chat_id = ?', [normalized])
      .map((row) => withRecordDefaults(row));
  }
  return copyIndexedRows(readDelegationIndexes().byChat.get(normalized))
    .filter((row) => delegationController(row) === normalized);
}

/** Reassign matching controller/root fields with one durable store write. */
export function reassignDelegationController(ids, toChatId) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean));
  const controller = String(toChatId || '').trim();
  if (!wanted.size || !controller) return 0;
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    const moved = [];
    const changed = withDelegationSqliteTransaction(database, () => {
      let changed = 0;
      for (const id of wanted) {
        const raw = getDelegationSqliteById(database, id);
        if (!raw) continue;
        const row = withRecordDefaults(raw);
        if (delegationController(row) === controller) continue;
        upsertDelegationSqlite(database, applyDelegationRecordPatch(row, { controllerChatId: controller, rootChatId: controller }));
        moved.push(id);
        changed += 1;
      }
      return changed;
    });
    for (const id of moved) {
      notifyDelegationPresence(getDelegationById(id));
      notifyDelegationChange(id);
    }
    return changed;
  }
  const items = loadDelegations();
  let changed = 0;
  const next = items.map((raw) => {
    if (!wanted.has(String(raw.id || '')) || delegationController(raw) === controller) return raw;
    changed += 1;
    return applyDelegationRecordPatch(withRecordDefaults(raw), { controllerChatId: controller, rootChatId: controller });
  });
  if (changed) saveItems(next, next.filter((row) => wanted.has(String(row.id || ''))));
  if (changed) {
    for (const row of next) {
      if (!wanted.has(String(row.id || '')) || delegationController(row) !== controller) continue;
      notifyDelegationPresence(row);
      notifyDelegationChange(row.id);
    }
  }
  return changed;
}

/**
 * Jobs where the chat is the controller, the historical parent or the executor child.
 *
 * @param {string} chatId
 * @returns {Record<string, any>[]}
 */
export function listDelegationsForChat(chatId) {
  const normalized = String(chatId || '').trim();
  if (!normalized) return [];
  if (isSqliteStore()) {
    return queryDelegationsSqlite(
      openDelegationSqlite(),
      'controller_chat_id = ? OR parent_chat_id = ? OR child_chat_id = ?',
      [normalized, normalized, normalized],
    ).map((row) => withRecordDefaults(row));
  }
  // The chat index holds exactly the rows whose controller, parent or child is this chat.
  return copyIndexedRows(readDelegationIndexes().byChat.get(normalized));
}

/**
 * Every job of one delegation tree by the recorded root chat (children,
 * grandchildren, retries and review fan-out). Legacy rows without tree fields
 * fall back to their direct parent as root, like the tree budget does.
 *
 * @param {string} rootChatId
 * @returns {Record<string, any>[]}
 */
export function listDelegationsForRootChat(rootChatId) {
  const normalized = String(rootChatId || '').trim();
  if (!normalized) return [];
  if (isSqliteStore()) {
    return queryDelegationsSqlite(openDelegationSqlite(), 'root_chat_id = ?', [normalized])
      .map((row) => withRecordDefaults(row));
  }
  return copyIndexedRows(readDelegationIndexes().byRootChat.get(normalized));
}

/**
 * Every job sharing one `rootDelegationId` (the slot-accounting tree).
 *
 * @param {string} rootDelegationId
 * @returns {Record<string, any>[]}
 */
export function listDelegationsForTreeRoot(rootDelegationId) {
  const normalized = String(rootDelegationId || '').trim();
  if (!normalized) return [];
  if (isSqliteStore()) {
    return queryDelegationsSqlite(openDelegationSqlite(), 'root_delegation_id = ?', [normalized])
      .map((row) => withRecordDefaults(row));
  }
  return copyIndexedRows(readDelegationIndexes().byTreeRoot.get(normalized));
}

/**
 * @param {string} childChatId
 * @returns {Record<string, any> | null}
 */
export function findDelegationByChildChatId(childChatId) {
  const normalized = String(childChatId || '').trim();
  if (!normalized) return null;
  const rows = isSqliteStore()
    ? queryDelegationsSqlite(openDelegationSqlite(), 'child_chat_id = ?', [normalized]).map((row) => withRecordDefaults(row))
    : copyIndexedRows(readDelegationIndexes().byChat.get(normalized)).filter((row) => row.childChatId === normalized);
  if (rows.length === 0) return null;
  const active = rows.find((row) => isDelegationSlotOccupied(row) || isActiveDelegationStatus(row.status));
  return active || rows[rows.length - 1];
}

/**
 * Jobs whose controller slot is still occupied (active, stopping, or otherwise held).
 *
 * @param {string} controllerChatId
 * @returns {Record<string, any>[]}
 */
export function listActiveDelegationsForController(controllerChatId) {
  return listDelegationsForController(controllerChatId).filter((row) => isDelegationSlotOccupied(row));
}

/**
 * @param {string} controllerChatId
 * @returns {Record<string, any> | null}
 */
export function findActiveDelegationForController(controllerChatId) {
  return listActiveDelegationsForController(controllerChatId)[0] || null;
}

/**
 * @param {string} idempotencyKey
 * @returns {Record<string, any> | null}
 */
export function findDelegationByIdempotencyKey(idempotencyKey) {
  const normalized = String(idempotencyKey || '').trim();
  if (!normalized) return null;
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    const live = database.prepare('SELECT json FROM delegations WHERE idempotency_key = ?').get(normalized);
    if (live) return withRecordDefaults(JSON.parse(String(live.json)));
    const tomb = database.prepare('SELECT delegation_id, until_at FROM idempotency_tombstones WHERE key = ?').get(normalized);
    if (tomb && Date.parse(String(tomb.until_at || '')) > Date.now()) {
      return getDelegationById(String(tomb.delegation_id || ''));
    }
    return null;
  }
  const row = readDelegationIndexes().byIdempotencyKey.get(normalized);
  return row ? { ...row } : null;
}

/**
 * Bounded copy of a plan-window headroom snapshot; `null` when absent or malformed.
 *
 * @param {any} value
 * @returns {{ level: number, hardFreePercent: number, observedAt: string, windows: { type: string, utilization: number, resetsAt: string }[] } | null}
 */
function normalizePlanHeadroomSnapshot(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.windows)) return null;
  const windows = value.windows.slice(0, 6)
    .filter((w) => w && typeof w === 'object' && Number.isFinite(Number(w.utilization)))
    .map((w) => ({
      type: String(w.type || '').slice(0, 40),
      utilization: Number(w.utilization),
      resetsAt: String(w.resetsAt || '').slice(0, 40),
    }));
  if (!windows.length) return null;
  const level = Number(value.level);
  const hard = Number(value.hardFreePercent);
  return {
    level: Number.isFinite(level) ? Math.min(3, Math.max(0, Math.round(level))) : 1,
    hardFreePercent: Number.isFinite(hard) ? hard : 5,
    observedAt: String(value.observedAt || '').slice(0, 40),
    windows,
  };
}

/**
 * Bounded copy of a plan-window pace snapshot; `null` when absent or malformed.
 * The shared normalizer keeps the measurement fields (measurement time,
 * measured/estimated basis, slack) and a known window whose reading is
 * unusable, while bounding the level to -1..1 and the cost factor to 0.5..2.
 *
 * @param {any} value
 * @returns {{
 *   level: number, costFactor: number, observedAt: string,
 *   windows: {
 *     type: string, limitId: string, resetsAt: string,
 *     utilization: number | null, measuredUtilization: number | null,
 *     estimatedPp: number, elapsedPct: number | null, slackPct: number | null,
 *     eligible: boolean, reason: string, readingObservedAt: string,
 *   }[],
 * } | null}
 */
function normalizePlanPaceSnapshot(value) {
  return normalizeSharedPlanPaceSnapshot(value);
}

/**
 * @param {any} input
 * @returns {{ selectedSkillIds?: string[] }}
 */
function selectedSkillIdsField(input) {
  const ids = Array.isArray(input?.selectedSkillIds) ? input.selectedSkillIds.map(String) : [];
  return ids.length ? { selectedSkillIds: ids } : {};
}

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function createDelegationRecord(input) {
  const now = new Date().toISOString();
  const attemptId = String(input.attemptId || randomUUID()).trim();
  // Shadow-only complexity level the pick resolved for this job. Stored only
  // when known; legacy rows simply have no field.
  const complexity = normalizeComplexity(input.complexity);
  const record = {
    // Callers that must reserve a resource for the id before the row exists
    // (pick slots) may pre-allocate it.
    id: String(input.id || '').trim() || randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    statusRevision: 1,
    eventId: randomUUID(),
    parentChatId: String(input.parentChatId || '').trim(),
    // Optional: only a record whose control was moved carries it; every other
    // row falls back to `parentChatId` (lib/delegation-control.js).
    ...(String(input.controllerChatId || '').trim()
      ? { controllerChatId: String(input.controllerChatId).trim() }
      : {}),
    childChatId: String(input.childChatId || '').trim(),
    ...resolveRecordTreeFields({
      depth: input.depth,
      rootChatId: input.rootChatId,
      rootDelegationId: input.rootDelegationId,
      parentChatId: input.parentChatId,
      id: input.id,
    }),
    workspaceFolder: String(input.workspaceFolder || '').trim(),
    // Frozen runner cwd. Empty means the logical workspace is used; a retry
    // reuses the recorded value instead of re-resolving it.
    executionFolder: String(input.executionFolder || '').trim(),
    planRevision: Number(input.planRevision) || 0,
    planHash: String(input.planHash || '').trim(),
    // Todo plan revision key reviewed by a plan-subject review (recheck gate).
    todoPlanRevisionKey: String(input.todoPlanRevisionKey || '').trim(),
    todoPlanContentKey: String(input.todoPlanContentKey || '').trim(),
    reviewedMaterialRevision: String(input.reviewedMaterialRevision || '').trim(),
    planMarkdown: String(input.planMarkdown || ''),
    executor: input.executor && typeof input.executor === 'object' ? { ...input.executor } : {},
    status: normalizeDelegationStatus(input.status) || 'queued',
    attemptId,
    runId: String(input.runId || '').trim(),
    idempotencyKey: String(input.idempotencyKey || '').trim(),
    createdAt: now,
    startedAt: '',
    runningAt: '',
    finishedAt: '',
    lastTransitionAt: now,
    report: '',
    reportVerdict: '',
    reportDegraded: false,
    reportSummary: '',
    error: '',
    taskOutcome: 'unspecified',
    interruptCode: '',
    interruptContinuedAt: '',
    runStoppingAt: '',
    idleObservedAt: '',
    slotHeldBy: DELEGATION_SLOT_HELD_BY_RUNNING,
    stopProof: null,
    cancelEscalatedAt: '',
    runDeadlineAt: String(input.runDeadlineAt || '').trim(),
    runDefaultLimitActive: input.runDefaultLimitActive === true,
    runDeadlineCancelKey: String(input.runDeadlineCancelKey || '').trim(),
    cancelCause: String(input.cancelCause || '').trim(),
    finalReportAcceptedAt: '',
    finalReportAttemptId: '',
    finalReportRunId: '',
    afterTerminalCount: 0,
    lastAfterTerminalAt: '',
    lastAfterTerminalCode: '',
    reportDeliveryId: '',
    reportDeliveredAt: '',
    historyDeliveredAt: '',
    extraInstructions: String(input.extraInstructions || '').trim(),
    // Explicit skill IDs the child run activates (stage 04). IDs only; the child
    // resolves them in its own scope, and task text never activates a skill.
    ...selectedSkillIdsField(input),
    // Optional justification of the model_pick that chose this executor.
    // Backward compatible: legacy records and callers simply leave it empty.
    pickReason: String(input.pickReason || '').trim(),
    // Audit flag: the caller explicitly REQUESTED the review recheck override.
    // This records the request, not that the override was used (it is stored
    // for non-review starts too).
    allowRecheck: input.allowRecheck === true,
    // Audit flag: the caller explicitly REQUESTED the verify-failed-before-review
    // override. Persisted so a queued start keeps it when it is drained/resumed.
    allowVerifyFailedReview: input.allowVerifyFailedReview === true,
    // Plan-window headroom snapshot taken at start (D9); null when absent.
    planHeadroomSnapshot: normalizePlanHeadroomSnapshot(input.planHeadroomSnapshot),
    // Weekly pace snapshot taken at start (D9); null when absent.
    planPaceSnapshot: normalizePlanPaceSnapshot(input.planPaceSnapshot),
    allowChildDelegations: input.allowChildDelegations === true,
    pickId: String(input.pickId || '').trim(),
    pickOrigin: String(input.pickOrigin || '').trim().toLowerCase(),
    pickOriginDetail: String(input.pickOriginDetail || '').trim(),
    pickLinkStatus: String(input.pickLinkStatus || '').trim(),
    pickRole: String(input.pickRole || '').trim().toLowerCase(),
    startContext: String(input.startContext || '').trim(),
    startContextSource: String(input.startContextSource || '').trim(),
    continuationOf: String(input.continuationOf || '').trim(),
    uiActionProof: input.uiActionProof === true,
    pickFallbackFrom: String(input.pickFallbackFrom || '').trim(),
    pickFallbackFromAttemptId: String(input.pickFallbackFrom ? input.pickFallbackFromAttemptId || '' : '').trim(),
    pickFallbackAttemptId: String(input.pickFallbackFrom ? attemptId : '').trim(),
    fallbackFailureClass: String(input.fallbackFailureClass || '').trim(),
    // Shadow-only complexity level resolved by the pick, when one is known.
    // Absent on unknown/legacy rows so `withRecordDefaults` is unaffected.
    ...(complexity ? { complexity } : {}),
    // Per-run efficiency metrics, filled at close for a completed run. Nullable
    // shape so the field is always present.
    metrics: emptyMetrics(),
    verifyResult: null,
    verifyPending: null,
    // Filled by the start gate for review jobs (host-verify policy). Kept as
    // plain fields so the workflow gate reads one durable flag, not a re-pick.
    verifyRequired: input.verifyRequired === true,
    reviewCanRunTests: input.reviewCanRunTests === true,
    reviewCanRunTestsSource: String(input.reviewCanRunTestsSource || '').trim(),
    // Explicit review subject + how it was determined (`docs/todo-review-contract.md` §3).
    reviewSubject: normalizeDelegationReviewSubject(input.reviewSubject) || 'other',
    reviewSubjectSource: normalizeDelegationReviewSubjectSource(input.reviewSubjectSource) || 'default',
    reviewMode: normalizeDelegationCodeReviewMode(input.reviewMode),
    reviewFindings: normalizeReviewFindingsSummary(input.reviewFindings),
    injectedLessonIds: normalizeInjectedLessonIds(input.injectedLessonIds),
    lessonsInjectedAt: String(input.lessonsInjectedAt || '').trim(),
    // Captured at queue time; pre-start chronology uses it before `startedAt` exists.
    queuedAt: String(input.queuedAt || now).trim() || now,
    unverified: true,
    acknowledgedAt: '',
    acknowledgedAttemptId: '',
    acknowledgedReason: '',
    acknowledgedActor: '',
    acknowledgedExpectedTodoRevision: '',
    sourceKind: String(input.sourceKind || '').trim() === 'message'
      ? 'message'
      : String(input.sourceKind || '').trim() === 'text'
        ? 'text'
        : 'plan',
    sourceChatId: String(input.sourceChatId || input.parentChatId || '').trim(),
    sourceHistorySeq: Number(input.sourceHistorySeq) > 0 ? Number(input.sourceHistorySeq) : 0,
    sourceCreatedAt: String(input.sourceCreatedAt || '').trim(),
    sourceText: String(input.sourceText || '').trim(),
    sourceHash: String(input.sourceHash || '').trim(),
    requestHash: String(input.requestHash || '').trim(),
    executionMode: String(input.executionMode || '').trim() === 'plan' ? 'plan' : 'agent',
    assignment: normalizeDelegationAssignment(input.assignment, input.executionMode),
    attempts: [],
    outbox: Array.isArray(input.outbox) ? asObjectArray(input.outbox) : [],
    errors: [],
    leafId: normalizeDelegationRecordLeafId(input),
    planReviewerSessionId: String(input.planReviewerSessionId || '').trim(),
    sessionResume: normalizeSessionResumeRecord(input.sessionResume),
    sessionContinuity: normalizeSessionContinuity(input.sessionContinuity),
    sessionContinuityConfirmed: false,
    workRole: normalizeWorkRole(input.workRole),
    continuationPolicy: normalizeContinuationPolicySnapshot(input.continuationPolicy),
    reviewerPolicy: normalizeReviewerPolicySnapshot(input.reviewerPolicy),
    promptPrefixFingerprint: '',
    promptCacheGeneration: 0,
    reviewUncertified: normalizeReviewUncertified(input.reviewUncertified),
    planReviewerPhase: String(input.planReviewerPhase || '').trim() || 'independent',
    exchangeOfDelegationId: String(
      input.exchangeOfDelegationId
      ?? input.exchange_of_delegation_id
      ?? input.originDelegationId
      ?? input.origin_delegation_id
      ?? '',
    ).trim(),
  };
  if (!String(input.rootDelegationId || '').trim()) record.rootDelegationId = record.id;
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    withDelegationSqliteTransaction(database, () => upsertDelegationSqlite(database, record));
    notifyDelegationPresence(record);
    notifyDelegationChange(record.id);
    return record;
  }
  const items = loadDelegations();
  items.push(record);
  saveItems(items, [record]);
  notifyDelegationPresence(record);
  notifyDelegationChange(record.id);
  return record;
}

/**
 * Three-valued first-start certification flag: `true|false` for reviews,
 * `null` for legacy rows and non-review assignments.
 * @param {any} value
 * @returns {boolean|null}
 */
function normalizeReviewUncertified(value) {
  return value === true || value === false ? value : null;
}

/**
 * @param {any} value
 * @returns {Record<string, number>}
 */
function normalizeFindingCountMap(value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, count] of Object.entries(value)) {
    const k = String(key || '').trim().slice(0, 40);
    const n = Math.floor(Number(count));
    if (k && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/**
 * @param {any} value
 * @returns {string[]} de-duplicated lesson ids in injection order
 */
export function normalizeInjectedLessonIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const raw of value) {
    const id = String(raw || '').trim().slice(0, 80);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= 20) break;
  }
  return ids;
}

/**
 * Parsed review-findings summary stored on the delegation record. Per-finding
 * detail lives in the server ledger; this is only the compact roll-up.
 *
 * @param {any} value
 * @returns {{ source: string, total: number, byPriority: Record<string, number>, byCategory: Record<string, number>, byStatus: Record<string, number>, confidence: string, parsedAt: string } | null}
 */
export function normalizeReviewFindingsSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = String(value.source || '').trim();
  if (source !== 'json' && source !== 'prose' && source !== 'none') return null;
  const total = Math.floor(Number(value.total));
  return {
    source,
    total: Number.isFinite(total) && total > 0 ? total : 0,
    byPriority: normalizeFindingCountMap(value.byPriority),
    byCategory: normalizeFindingCountMap(value.byCategory),
    byStatus: normalizeFindingCountMap(value.byStatus),
    confidence: ['high', 'low', 'none'].includes(String(value.confidence)) ? String(value.confidence) : 'none',
    parsedAt: String(value.parsedAt || '').trim(),
  };
}

const STRING_FIELDS = Object.freeze([
  'leafId',
  'controllerChatId',
  'rootChatId',
  'childChatId',
  'attemptId',
  'runId',
  'startedAt',
  'runningAt',
  'finishedAt',
  'lastTransitionAt',
  'report',
  'reportVerdict',
  'reportSummary',
  'error',
  'planMarkdown',
  'sourceText',
  'reportDeliveryId',
  'reportDeliveredAt',
  'historyDeliveredAt',
  'lastPublishedStatus',
  'lastPublishedEvent',
  'lastPublishedEventId',
  'workspaceFolder',
  'executionFolder',
  'acknowledgedAt',
  'acknowledgedAttemptId',
  'acknowledgedReason',
  'acknowledgedExpectedTodoRevision',
  'sourceHash',
  'requestHash',
  'executionMode',
  'assignment',
  'eventId',
  'acceptRequestId',
  'acceptState',
  'archivedAt',
  'tombstoneUntil',
  'taskOutcome',
  'interruptCode',
  'interruptContinuedAt',
  'runStoppingAt',
  'idleObservedAt',
  'finalReportAcceptedAt',
  'finalReportAttemptId',
  'finalReportRunId',
  'lastAfterTerminalAt',
  'lastAfterTerminalCode',
  'slotHeldBy',
  'cancelEscalatedAt',
  'runDeadlineAt',
  'runDeadlineCancelKey',
  'cancelCause',
]);

/**
 * @param {Record<string, any>} current
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, any>}
 */
function applyDelegationRecordPatch(current, patch) {
  const next = { ...current };
  const previousStatus = next.status;
  if (patch.status !== undefined) {
    const status = normalizeDelegationStatus(patch.status);
    if (status) next.status = status;
  }
  if (patch.promptPrefixFingerprint !== undefined) {
    next.promptPrefixFingerprint = String(patch.promptPrefixFingerprint || '').trim();
    next.promptCacheGeneration = Math.max(0, Number(patch.promptCacheGeneration) || 0);
  }
  if (previousStatus !== next.status) {
    next.statusRevision = (Number(next.statusRevision) || 0) + 1;
    next.eventId = randomUUID();
    next.lastTransitionAt = new Date().toISOString();
    if (patch.acknowledgedAt === undefined) next.acknowledgedAt = '';
  }
  for (const key of STRING_FIELDS) {
    if (patch[key] === undefined) continue;
    next[key] = patch[key] == null ? '' : String(patch[key]);
  }
  if (patch.unverified === false) next.unverified = false;
  if (patch.unverified === true) next.unverified = true;
  if (patch.reportDegraded === true) next.reportDegraded = true;
  if (patch.reportDegraded === false) next.reportDegraded = false;
  if (patch.afterTerminalCount !== undefined) {
    next.afterTerminalCount = Number(patch.afterTerminalCount) > 0
      ? Math.floor(Number(patch.afterTerminalCount))
      : 0;
  }
  if (Array.isArray(patch.attempts)) next.attempts = asObjectArray(patch.attempts);
  if (Array.isArray(patch.outbox)) next.outbox = asObjectArray(patch.outbox);
  if (Array.isArray(patch.errors)) next.errors = asObjectArray(patch.errors);
  if (Array.isArray(patch.outboxAppend) && patch.outboxAppend.length > 0) {
    next.outbox = [...asObjectArray(next.outbox), ...asObjectArray(patch.outboxAppend)];
  }
  if (patch.outboxItemPatch && typeof patch.outboxItemPatch === 'object' && !Array.isArray(patch.outboxItemPatch)) {
    next.outbox = patchOutboxItem(next.outbox, patch.outboxItemPatch);
  }
  if (Array.isArray(patch.errorAppend) && patch.errorAppend.length > 0) {
    next.errors = [...asObjectArray(next.errors), ...asObjectArray(patch.errorAppend)].slice(-20);
  }
  if (patch.executor && typeof patch.executor === 'object') {
    next.executor = { ...(next.executor || {}), ...patch.executor };
  }
  if (patch.metrics && typeof patch.metrics === 'object') {
    next.metrics = normalizeMetrics({ ...(next.metrics || {}), ...patch.metrics });
  }
  if (patch.verifyResult === null) next.verifyResult = null;
  else if (patch.verifyResult && typeof patch.verifyResult === 'object' && !Array.isArray(patch.verifyResult)) {
    next.verifyResult = normalizeVerifyResult(patch.verifyResult);
  }
  if (patch.verifyPending === null) next.verifyPending = null;
  else if (patch.verifyPending && typeof patch.verifyPending === 'object') {
    next.verifyPending = normalizeVerifyPending(patch.verifyPending);
  }
  if (patch.stopProof === null) next.stopProof = null;
  else if (patch.stopProof && typeof patch.stopProof === 'object' && !Array.isArray(patch.stopProof)) {
    next.stopProof = normalizeDelegationStopProof(patch.stopProof);
  }
  if (patch.slotHeldBy !== undefined) {
    next.slotHeldBy = normalizeDelegationSlotHeldBy(patch.slotHeldBy);
  }
  if (patch.verifyRequired === true || patch.verifyRequired === false) {
    next.verifyRequired = patch.verifyRequired === true;
  }
  if (patch.runDefaultLimitActive === true || patch.runDefaultLimitActive === false) {
    next.runDefaultLimitActive = patch.runDefaultLimitActive === true;
  }
  if (patch.reviewCanRunTests === true || patch.reviewCanRunTests === false) {
    next.reviewCanRunTests = patch.reviewCanRunTests === true;
  }
  if (patch.reviewCanRunTestsSource !== undefined) {
    next.reviewCanRunTestsSource = String(patch.reviewCanRunTestsSource || '').trim();
  }
  // A retry re-records the queue time for the new attempt; the previous value
  // is preserved on the archived attempt snapshot.
  if (patch.queuedAt !== undefined) {
    next.queuedAt = String(patch.queuedAt || '').trim() || next.queuedAt || next.createdAt || '';
  }
  // A garbage review subject is never persisted as a valid one: it collapses to
  // `other`, matching the legacy/unknown reader (`docs/todo-review-contract.md` §3.2).
  if (patch.reviewSubject !== undefined) {
    next.reviewSubject = normalizeDelegationReviewSubject(patch.reviewSubject) || 'other';
  }
  if (patch.reviewSubjectSource !== undefined) {
    next.reviewSubjectSource = normalizeDelegationReviewSubjectSource(patch.reviewSubjectSource) || 'unknown';
  }
  if (patch.reviewMode !== undefined) {
    next.reviewMode = normalizeDelegationCodeReviewMode(patch.reviewMode);
  }
  if (patch.injectedLessonIds !== undefined) {
    next.injectedLessonIds = normalizeInjectedLessonIds(patch.injectedLessonIds);
  }
  if (patch.lessonsInjectedAt !== undefined) {
    next.lessonsInjectedAt = String(patch.lessonsInjectedAt || '').trim();
  }
  if (patch.reviewFindings !== undefined) {
    next.reviewFindings = normalizeReviewFindingsSummary(patch.reviewFindings);
  }
  if (patch.planReviewerSessionId !== undefined) {
    next.planReviewerSessionId = String(patch.planReviewerSessionId || '').trim();
  }
  if (patch.sessionContinuityConfirmed !== undefined) {
    next.sessionContinuityConfirmed = patch.sessionContinuityConfirmed === true;
  }
  if (patch.sessionContinuity !== undefined) {
    next.sessionContinuity = normalizeSessionContinuity(patch.sessionContinuity);
  }
  if (patch.planReviewerPhase !== undefined) {
    next.planReviewerPhase = String(patch.planReviewerPhase || '').trim() || 'independent';
  }
  if (patch.exchangeOfDelegationId !== undefined || patch.originDelegationId !== undefined) {
    next.exchangeOfDelegationId = String(
      patch.exchangeOfDelegationId ?? patch.originDelegationId ?? '',
    ).trim();
  }
  if (patch.acknowledgedActor !== undefined) {
    next.acknowledgedActor = normalizeDelegationAckActor(patch.acknowledgedActor);
  }
  // Bounded startup-retry bookkeeping: `used` survives the async gap between a
  // transient startup failure and the retried attempt, `lastError` feeds the
  // retry prompt. A successful attempt clears the field.
  if (patch.startupRetry === null) {
    next.startupRetry = null;
  } else if (patch.startupRetry && typeof patch.startupRetry === 'object' && !Array.isArray(patch.startupRetry)) {
    next.startupRetry = {
      used: Math.max(0, Math.floor(Number(patch.startupRetry.used) || 0)),
      lastError: String(patch.startupRetry.lastError || '').trim(),
      scheduledAt: String(patch.startupRetry.scheduledAt || '').trim(),
    };
  }
  next.revision = (Number(next.revision) || 0) + 1;
  return next;
}

/**
 * @param {Record<string, any>[]} outbox
 * @param {Record<string, any>} itemPatch
 * @returns {Record<string, any>[]}
 */
function patchOutboxItem(outbox, itemPatch) {
  const itemId = String(itemPatch.id || '').trim();
  const expectedItemAttempt = String(itemPatch.expectedAttemptId || '').trim();
  const itemPatchRaw = itemPatch.patch;
  const fields = itemPatchRaw && typeof itemPatchRaw === 'object' && !Array.isArray(itemPatchRaw)
    ? { ...itemPatchRaw }
    : {};
  delete fields.id;
  if (!itemId) return asObjectArray(outbox);
  return asObjectArray(outbox).map((row) => {
    if (String(row.id || '') !== itemId) return row;
    if (expectedItemAttempt && String(row.attemptId || '') !== expectedItemAttempt) return row;
    return { ...row, ...fields };
  });
}

/**
 * @param {Record<string, any>} current
 * @param {{ expectedRevision?: number, expectedAttemptId?: string }} options
 * @returns {boolean}
 */
function matchesDelegationCas(current, options) {
  if (options.expectedRevision != null && Number(current.revision) !== Number(options.expectedRevision)) {
    return false;
  }
  const expectedAttempt = String(options.expectedAttemptId || '').trim();
  if (expectedAttempt && String(current.attemptId || '') !== expectedAttempt) {
    return false;
  }
  return true;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {{ expectedRevision?: number, expectedAttemptId?: string }} [options]
 * @returns {Record<string, any> | null}
 */
export function updateDelegationRecord(id, patch, options = {}) {
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    /** @type {Record<string, any> | null} */
    let previous = null;
    const next = withDelegationSqliteTransaction(database, () => {
      const raw = getDelegationSqliteById(database, id);
      if (!raw) return null;
      const current = withRecordDefaults(raw);
      if (!matchesDelegationCas(current, options)) return null;
      previous = current;
      const patched = applyDelegationRecordPatch(current, patch);
      upsertDelegationSqlite(database, patched);
      return patched;
    });
    notifyDelegationPresence(next);
    if (next) {
      notifyDelegationChange(id);
      void import('../workspace-watcher-nudge.js').then(({ maybeScheduleWorkspaceWatcherAfterDelegationUpdate }) => {
        maybeScheduleWorkspaceWatcherAfterDelegationUpdate(previous, next, String(options.dataDir ?? '').trim());
      }).catch(() => {});
    }
    return next;
  }
  const items = loadDelegations();
  const idx = items.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  const current = withRecordDefaults(items[idx]);
  if (!matchesDelegationCas(current, options)) return null;
  const next = applyDelegationRecordPatch(current, patch);
  items[idx] = next;
  saveItems(items, [next]);
  notifyDelegationPresence(next);
  notifyDelegationChange(id);
  void import('../workspace-watcher-nudge.js').then(({ maybeScheduleWorkspaceWatcherAfterDelegationUpdate }) => {
    maybeScheduleWorkspaceWatcherAfterDelegationUpdate(current, next, String(options.dataDir ?? '').trim());
  }).catch(() => {});
  return next;
}

/**
 * Applies many patches with ONE whole-file write (JSON) or one transaction
 * (SQLite). Maintenance passes use it instead of a rewrite per row.
 *
 * @param {Array<{ id: string, patch: Record<string, unknown> }>} updates
 * @returns {number} rows actually updated
 */
export function updateDelegationRecordsBatch(updates) {
  const wanted = (Array.isArray(updates) ? updates : []).filter((u) => u && String(u.id || '').trim());
  if (wanted.length === 0) return 0;
  /** @type {string[]} */
  const changedIds = [];
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    withDelegationSqliteTransaction(database, () => {
      for (const { id, patch } of wanted) {
        const raw = getDelegationSqliteById(database, id);
        if (!raw) continue;
        upsertDelegationSqlite(database, applyDelegationRecordPatch(withRecordDefaults(raw), patch));
        changedIds.push(id);
      }
    });
  } else {
    const items = loadDelegations();
    const indexById = new Map(items.map((row, idx) => [row.id, idx]));
    for (const { id, patch } of wanted) {
      const idx = indexById.get(id);
      if (idx === undefined) continue;
      items[idx] = applyDelegationRecordPatch(withRecordDefaults(items[idx]), patch);
      changedIds.push(id);
    }
    if (changedIds.length > 0) saveItems(items, changedIds.map((id) => items[indexById.get(id)]));
  }
  for (const id of changedIds) {
    notifyDelegationPresence(getDelegationById(id));
    notifyDelegationChange(id);
  }
  return changedIds.length;
}
