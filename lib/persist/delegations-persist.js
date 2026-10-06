/**
 * Durable delegation records (plan execution jobs).
 */

import { randomUUID } from 'crypto';
import { normalizeDelegationAssignment } from '../delegation-request.js';
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
  loadDelegationsSqlite,
  openDelegationSqlite,
  upsertDelegationSqlite,
  withDelegationSqliteTransaction,
  getDelegationSqliteById,
} from './delegation-sqlite.js';
import {
  isActiveDelegationStatus,
  isDelegationSlotOccupied,
  normalizeDelegationStatus,
} from '../delegation-status.js';
import { markAgentPresenceDirty } from '../agent-presence-hooks.js';
import { normalizeDelegationWorkspaceKey } from '../delegation-workspace-guard.js';
import { DELEGATION_VERDICTS } from '../delegation-verdict.js';
import { normalizeWorkspaceFolder } from './workspace-watchers-persist.js';
import { normalizeTodoRefId } from '../todo-ref.js';

const DATA_FILE = resolveDataPath('delegations.json');

/**
 * Parsed delegation documents keyed by absolute path. A write through
 * `saveItems` drops the entry; an external rewrite misses on inode/size/mtime.
 *
 * @type {Map<string, { signature: string, doc: { v: number, items: object[] } }>}
 */
const documentCache = new Map();

/**
 * Chat and workspace indexes built from one document parse. Dropped with the
 * document cache on write. Rows are the defaulted objects; hot readers must
 * not mutate them.
 *
 * @type {Map<string, { signature: string, byChat: Map<string, object[]>, byWorkspace: Map<string, object[]>, active: object[] }>}
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
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function resolveDelegationsJsonPath(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  const dir = configured || resolveDataPath();
  return path.join(dir, 'delegations.json');
}

function notifyDelegationPresence(row) {
  if (!row) return;
  const ids = [row.parentChatId, row.childChatId]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
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
 * @returns {{ v: number, items: object[] }}
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
 * @param {object[]} items
 */
function saveItems(items) {
  ensureDelegationOwnerLock();
  ensureDir();
  rowIndexCache = null;
  documentCache.delete(DATA_FILE);
  delegationIndexCache.delete(DATA_FILE);
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
}

/**
 * Hot paths (per streamed harness event) look up one record by id. Parsing
 * the whole store for each lookup blocks the event loop, so rows are indexed
 * as JSON strings and re-parsed per call to keep callers' copies independent.
 *
 * @type {{ signature: string, rows: Map<string, string> } | null}
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
      if (typeof row.id === 'string' && !rows.has(row.id)) rows.set(row.id, JSON.stringify(row));
    }
    rowIndexCache = { signature, rows };
  }
  return rowIndexCache.rows.get(id) || null;
}

/**
 * @param {unknown} value
 * @returns {object[]}
 */
function asObjectArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

/**
 * @param {object} row
 * @returns {object}
 */
/**
 * @param {unknown} input
 * @returns {string}
 */
function normalizeDelegationRecordLeafId(input) {
  if (!input || typeof input !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (input);
  const raw = row.leafId ?? row.leaf_id ?? row.todoId ?? row.todo_id ?? '';
  return normalizeTodoRefId(raw);
}

function withRecordDefaults(row) {
  const attempts = asObjectArray(row.attempts);
  const outbox = asObjectArray(row.outbox);
  const errors = asObjectArray(row.errors);
  return {
    ...row,
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
    pickId: String(row.pickId || '').trim(),
    pickOrigin: String(row.pickOrigin || '').trim().toLowerCase(),
    pickOriginDetail: String(row.pickOriginDetail || '').trim(),
    pickLinkStatus: String(row.pickLinkStatus || '').trim(),
    pickRole: String(row.pickRole || '').trim().toLowerCase(),
    acknowledgedAttemptId: String(row.acknowledgedAttemptId || '').trim(),
    acknowledgedReason: String(row.acknowledgedReason || '').trim().toLowerCase(),
    interruptCode: String(row.interruptCode || '').trim(),
    interruptContinuedAt: String(row.interruptContinuedAt || '').trim(),
    // Legacy rows predate per-run metrics; default to the all-null shape so the
    // API and aggregation never read `undefined`. All fields stay nullable.
    metrics: normalizeMetrics(row.metrics),
    verifyResult: normalizeVerifyResult(row.verifyResult),
    // Parsed verdict persisted at finalization so `delegation_show` and the
    // workflow do not have to re-parse the report text. Legacy rows default to
    // empty and readers fall back to parsing.
    reportVerdict: DELEGATION_VERDICTS.includes(String(row.reportVerdict || '').trim())
      ? String(row.reportVerdict || '').trim()
      : '',
    reportDegraded: row.reportDegraded === true,
    reportSummary: String(row.reportSummary || '').trim(),
    // Spurious terminal repeats (second `sdkRunFinished` for the same attempt)
    // are counted for diagnostics and never appended to `errors[]`.
    afterTerminalCount: Number(row.afterTerminalCount) > 0
      ? Math.floor(Number(row.afterTerminalCount))
      : 0,
  };
}

function normalizeVerifyResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value.status === 'passed' || value.status === 'failed' ? value.status : '';
  if (!status) return null;
  return {
    status,
    exitCode: status === 'passed' ? 0 : 1,
    dataDir: String(value.dataDir || '').trim(),
    recordedAt: String(value.recordedAt || '').trim(),
    attemptId: String(value.attemptId || '').trim(),
  };
}

function isSqliteStore() {
  return getDelegationStoreBackend() === 'sqlite';
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function loadDelegations(options = {}) {
  if (isSqliteStore()) {
    return loadDelegationsSqlite(openDelegationSqlite()).map((row) => withRecordDefaults(row));
  }
  return loadDocument(options).items.map((row) => withRecordDefaults(row));
}

/**
 * Same key the watcher uses to match a delegation to a workspace folder.
 *
 * @param {unknown} folder
 * @returns {string}
 */
function workspaceIndexKey(folder) {
  const canonical = normalizeDelegationWorkspaceKey(folder);
  if (!canonical) return normalizeWorkspaceFolder(folder);
  return normalizeWorkspaceFolder(canonical);
}

/**
 * Rows the runtime tick still has to visit: an active status, a stop marker
 * that may still hold the parent slot, or an undelivered outbox item.
 *
 * @param {object} row
 * @returns {boolean}
 */
function isTickRelevantDelegation(row) {
  if (isActiveDelegationStatus(row?.status)) return true;
  if (String(row?.runStoppingAt || '').trim()) return true;
  return Array.isArray(row?.outbox) && row.outbox.some((item) => !String(item?.deliveredAt || '').trim());
}

/**
 * @param {object[]} items
 * @returns {{ byChat: Map<string, object[]>, byWorkspace: Map<string, object[]>, active: object[] }}
 */
function buildDelegationIndexes(items) {
  const byChat = new Map();
  const byWorkspace = new Map();
  const active = [];
  for (const raw of items) {
    const row = withRecordDefaults(raw);
    if (isTickRelevantDelegation(row)) active.push(row);
    for (const chatId of [row.parentChatId, row.childChatId]) {
      const key = String(chatId || '').trim();
      if (!key) continue;
      const list = byChat.get(key);
      if (list) list.push(row);
      else byChat.set(key, [row]);
    }
    const workspace = workspaceIndexKey(row.workspaceFolder);
    if (!workspace) continue;
    const list = byWorkspace.get(workspace);
    if (list) list.push(row);
    else byWorkspace.set(workspace, [row]);
  }
  return { byChat, byWorkspace, active };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {{ byChat: Map<string, object[]>, byWorkspace: Map<string, object[]>, active: object[] }}
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
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function listDelegationsForChatIds(chatIds, options = {}) {
  const ids = [...new Set((Array.isArray(chatIds) ? chatIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (ids.length === 0) return [];
  if (isSqliteStore()) {
    const wanted = new Set(ids);
    return loadDelegations(options).filter((row) => wanted.has(row.parentChatId) || wanted.has(row.childChatId));
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
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function listActiveDelegations(options = {}) {
  if (isSqliteStore()) return loadDelegations(options).filter((row) => isTickRelevantDelegation(row));
  return readDelegationIndexes(options).active;
}

/**
 * Defaulted rows for one workspace. Empty when the folder does not normalize.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {object[]}
 */
export function listDelegationsForWorkspace(workspaceFolder, options = {}) {
  const key = workspaceIndexKey(workspaceFolder);
  if (!key) return [];
  if (isSqliteStore()) {
    return loadDelegations(options).filter((row) => workspaceIndexKey(row.workspaceFolder) === key);
  }
  return readDelegationIndexes(options).byWorkspace.get(key) || [];
}

/**
 * @param {string} id
 * @returns {object | null}
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
 * @param {string} parentChatId
 * @returns {object[]}
 */
export function listDelegationsForParent(parentChatId) {
  const normalized = String(parentChatId || '').trim();
  if (!normalized) return [];
  return loadDelegations().filter((row) => row.parentChatId === normalized);
}

/**
 * Jobs where the chat is the communication parent or the executor child.
 *
 * @param {string} chatId
 * @returns {object[]}
 */
export function listDelegationsForChat(chatId) {
  const normalized = String(chatId || '').trim();
  if (!normalized) return [];
  return loadDelegations().filter((row) => {
    return row.parentChatId === normalized || row.childChatId === normalized;
  });
}

/**
 * @param {string} childChatId
 * @returns {object | null}
 */
export function findDelegationByChildChatId(childChatId) {
  const normalized = String(childChatId || '').trim();
  if (!normalized) return null;
  const rows = loadDelegations().filter((row) => row.childChatId === normalized);
  if (rows.length === 0) return null;
  const active = rows.find((row) => isDelegationSlotOccupied(row) || isActiveDelegationStatus(row.status));
  return active || rows[rows.length - 1];
}

/**
 * Jobs whose parent slot is still occupied (active, stopping, or otherwise held).
 *
 * @param {string} parentChatId
 * @returns {object[]}
 */
export function listActiveDelegationsForParent(parentChatId) {
  return listDelegationsForParent(parentChatId).filter((row) => isDelegationSlotOccupied(row));
}

/**
 * @param {string} parentChatId
 * @returns {object | null}
 */
export function findActiveDelegationForParent(parentChatId) {
  return listActiveDelegationsForParent(parentChatId)[0] || null;
}

/**
 * @param {string} idempotencyKey
 * @returns {object | null}
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
  return loadDelegations().find((row) => row.idempotencyKey === normalized) || null;
}

/**
 * @param {object} input
 * @returns {object}
 */
export function createDelegationRecord(input) {
  const now = new Date().toISOString();
  const attemptId = String(input.attemptId || randomUUID()).trim();
  const record = {
    // Callers that must reserve a resource for the id before the row exists
    // (pick slots) may pre-allocate it.
    id: String(input.id || '').trim() || randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    statusRevision: 1,
    eventId: randomUUID(),
    parentChatId: String(input.parentChatId || '').trim(),
    childChatId: String(input.childChatId || '').trim(),
    workspaceFolder: String(input.workspaceFolder || '').trim(),
    planRevision: Number(input.planRevision) || 0,
    planHash: String(input.planHash || '').trim(),
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
    // Optional justification of the model_pick that chose this executor.
    // Backward compatible: legacy records and callers simply leave it empty.
    pickReason: String(input.pickReason || '').trim(),
    pickId: String(input.pickId || '').trim(),
    pickOrigin: String(input.pickOrigin || '').trim().toLowerCase(),
    pickOriginDetail: String(input.pickOriginDetail || '').trim(),
    pickLinkStatus: String(input.pickLinkStatus || '').trim(),
    pickRole: String(input.pickRole || '').trim().toLowerCase(),
    // Per-run efficiency metrics, filled at close for a completed run. Nullable
    // shape so the field is always present.
    metrics: emptyMetrics(),
    verifyResult: null,
    unverified: true,
    acknowledgedAt: '',
    acknowledgedAttemptId: '',
    acknowledgedReason: '',
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
  };
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    withDelegationSqliteTransaction(database, () => upsertDelegationSqlite(database, record));
    notifyDelegationPresence(record);
    return record;
  }
  const items = loadDelegations();
  items.push(record);
  saveItems(items);
  notifyDelegationPresence(record);
  return record;
}

const STRING_FIELDS = Object.freeze([
  'leafId',
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
  'acknowledgedAt',
  'acknowledgedAttemptId',
  'acknowledgedReason',
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
]);

/**
 * @param {object} current
 * @param {Record<string, unknown>} patch
 * @returns {object}
 */
function applyDelegationRecordPatch(current, patch) {
  const next = { ...current };
  const previousStatus = next.status;
  if (patch.status !== undefined) {
    const status = normalizeDelegationStatus(patch.status);
    if (status) next.status = status;
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
  next.revision = (Number(next.revision) || 0) + 1;
  return next;
}

/**
 * @param {object[]} outbox
 * @param {object} itemPatch
 * @returns {object[]}
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
 * @param {object} current
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
 * @returns {object | null}
 */
export function updateDelegationRecord(id, patch, options = {}) {
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    /** @type {object | null} */
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
  saveItems(items);
  notifyDelegationPresence(next);
  void import('../workspace-watcher-nudge.js').then(({ maybeScheduleWorkspaceWatcherAfterDelegationUpdate }) => {
    maybeScheduleWorkspaceWatcherAfterDelegationUpdate(current, next, String(options.dataDir ?? '').trim());
  }).catch(() => {});
  return next;
}
