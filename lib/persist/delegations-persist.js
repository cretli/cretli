/**
 * Durable delegation records (plan execution jobs).
 */

import { randomUUID } from 'crypto';
import { normalizeDelegationAssignment } from '../delegation-request.js';
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

const DATA_FILE = resolveDataPath('delegations.json');
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
 * @returns {{ v: number, items: object[] }}
 */
function loadDocument() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return { v: SCHEMA_VERSION, items: [] };
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
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
  return {
    v: version,
    items,
  };
}

/**
 * @param {object[]} items
 */
function saveItems(items) {
  ensureDelegationOwnerLock();
  ensureDir();
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
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
function withRecordDefaults(row) {
  const attempts = asObjectArray(row.attempts);
  const outbox = asObjectArray(row.outbox);
  const errors = asObjectArray(row.errors);
  return {
    ...row,
    revision: Number(row.revision) > 0 ? Number(row.revision) : 1,
    statusRevision: Number(row.statusRevision) > 0 ? Number(row.statusRevision) : 1,
    eventId: String(row.eventId || '').trim(),
    attempts,
    outbox,
    errors,
    unverified: row.unverified !== false,
    acknowledgedAttemptId: String(row.acknowledgedAttemptId || '').trim(),
  };
}

function isSqliteStore() {
  return getDelegationStoreBackend() === 'sqlite';
}

/**
 * @returns {object[]}
 */
export function loadDelegations() {
  if (isSqliteStore()) {
    return loadDelegationsSqlite(openDelegationSqlite()).map((row) => withRecordDefaults(row));
  }
  return loadDocument().items.map((row) => withRecordDefaults(row));
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
  return loadDelegations().find((row) => row.id === normalized) || null;
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
 * @param {string} parentChatId
 * @returns {object | null}
 */
export function findActiveDelegationForParent(parentChatId) {
  return listDelegationsForParent(parentChatId).find((row) => isDelegationSlotOccupied(row)) || null;
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
    id: randomUUID(),
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
    error: '',
    taskOutcome: 'unspecified',
    runStoppingAt: '',
    finalReportAcceptedAt: '',
    finalReportAttemptId: '',
    finalReportRunId: '',
    reportDeliveryId: '',
    reportDeliveredAt: '',
    historyDeliveredAt: '',
    extraInstructions: String(input.extraInstructions || '').trim(),
    unverified: true,
    acknowledgedAt: '',
    acknowledgedAttemptId: '',
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
  };
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    withDelegationSqliteTransaction(database, () => upsertDelegationSqlite(database, record));
    return record;
  }
  const items = loadDelegations();
  items.push(record);
  saveItems(items);
  return record;
}

const STRING_FIELDS = Object.freeze([
  'childChatId',
  'attemptId',
  'runId',
  'startedAt',
  'runningAt',
  'finishedAt',
  'lastTransitionAt',
  'report',
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
  'runStoppingAt',
  'finalReportAcceptedAt',
  'finalReportAttemptId',
  'finalReportRunId',
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
    return withDelegationSqliteTransaction(database, () => {
      const raw = getDelegationSqliteById(database, id);
      if (!raw) return null;
      const current = withRecordDefaults(raw);
      if (!matchesDelegationCas(current, options)) return null;
      const next = applyDelegationRecordPatch(current, patch);
      upsertDelegationSqlite(database, next);
      return next;
    });
  }
  const items = loadDelegations();
  const idx = items.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  const current = withRecordDefaults(items[idx]);
  if (!matchesDelegationCas(current, options)) return null;
  const next = applyDelegationRecordPatch(current, patch);
  items[idx] = next;
  saveItems(items);
  return next;
}
