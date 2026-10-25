/**
 * Durable inter-chat mailbox for delegated tasks and replies.
 */

import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureDelegationOwnerLock } from '../delegation-owner-lock.js';
import {
  MAILBOX_JSON_SCHEMA_VERSION,
  assertMailboxJsonSchemaVersion,
  UnsupportedDelegationSchemaError,
} from './delegation-schema.js';
import { getDelegationStoreBackend } from './delegation-store-backend.js';
import {
  loadMailboxSqlite,
  openDelegationSqlite,
  replaceMailboxSqlite,
  upsertMailboxSqlite,
  withDelegationSqliteTransaction,
  getMailboxSqliteById,
  queryMailboxSqlite,
} from './delegation-sqlite.js';

const DATA_FILE = resolveDataPath('delegation-mailbox.json');
const SCHEMA_VERSION = MAILBOX_JSON_SCHEMA_VERSION;

/**
 * Parsed mailbox document. A write drops it. Callers receive copies of the
 * rows so an in-memory edit does not dirty the cached list.
 *
 * @type {{ signature: string, doc: { v: number, items: Record<string, any>[] } } | null}
 */
let mailboxCache = null;

/**
 * @param {string} filePath
 * @returns {string}
 */
function readMailboxSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

export class MailboxIoError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause) {
    super(message);
    this.name = 'MailboxIoError';
    this.code = 'MAILBOX_IO';
    this.cause = cause;
  }
}

export const MAILBOX_STATUSES = Object.freeze([
  'queued',
  'dispatching',
  'delivered',
  'failed',
  'uncertain',
]);
export const MAILBOX_KINDS = Object.freeze(['task', 'reply']);
export const MAILBOX_REPLY_KINDS = Object.freeze(['progress', 'question', 'final_report']);

export class MailboxCorruptError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'MailboxCorruptError';
    this.code = 'MAILBOX_CORRUPT';
  }
}

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  return MAILBOX_STATUSES.includes(raw) ? raw : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  return MAILBOX_KINDS.includes(raw) ? raw : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeReplyKind(value) {
  const raw = String(value || '').trim().toLowerCase();
  return MAILBOX_REPLY_KINDS.includes(raw) ? raw : '';
}

/**
 * @returns {string}
 */
export function getMailboxDataPath() {
  return DATA_FILE;
}

/**
 * @param {(row: Record<string, any>) => boolean} [keep] applied to cached rows BEFORE they
 *   are copied, so a narrow read never clones the whole mailbox
 * @returns {{ v: number, items: Record<string, any>[] }}
 */
function loadDocument(keep) {
  ensureDir();
  const signature = readMailboxSignature(DATA_FILE);
  if (!signature) return { v: SCHEMA_VERSION, items: [] };
  if (mailboxCache && mailboxCache.signature === signature) {
    return { v: mailboxCache.doc.v, items: copyRows(mailboxCache.doc.items, keep) };
  }
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    throw new MailboxIoError(
      `Could not read mailbox store (${err instanceof Error ? err.message : String(err)})`,
      err,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MailboxCorruptError(
      `Mailbox file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MailboxCorruptError('Mailbox file is not an object');
  }
  if (String(parsed.backend || '').trim() === 'sqlite') {
    throw new MailboxCorruptError('Mailbox JSON was migrated to SQLite; refusing to rewrite it');
  }
  try {
    assertMailboxJsonSchemaVersion(parsed.v);
  } catch (err) {
    if (err instanceof UnsupportedDelegationSchemaError) throw err;
    throw err;
  }
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((row) => row && typeof row === 'object')
    : [];
  const doc = { v: SCHEMA_VERSION, items };
  mailboxCache = { signature, doc };
  return { v: doc.v, items: copyRows(items, keep) };
}

/**
 * Copies the rows so callers cannot mutate the cached document. The optional
 * `keep` filter runs before the copy, so a narrow read never clones the whole
 * mailbox.
 *
 * @param {Record<string, any>[]} items
 * @param {(row: Record<string, any>) => boolean} [keep]
 * @returns {Record<string, any>[]}
 */
function copyRows(items, keep) {
  const out = [];
  for (const row of items) if (!keep || keep(row)) out.push({ ...row });
  return out;
}

/**
 * @param {Record<string, any>[]} items
 */
function saveItems(items) {
  if (isSqliteStore()) {
    replaceMailboxSqlite(openDelegationSqlite(), items);
    return;
  }
  ensureDelegationOwnerLock();
  ensureDir();
  mailboxCache = null;
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
  // Re-seed so the next read skips a full re-parse; rows are copied so the
  // caller's objects stay independent of the cache.
  const signature = readMailboxSignature(DATA_FILE);
  if (!signature) return;
  const cachedItems = items.filter((row) => row && typeof row === 'object').map((row) => ({ ...row }));
  mailboxCache = { signature, doc: { v: SCHEMA_VERSION, items: cachedItems } };
}

function persistMailboxRow(row) {
  if (!isSqliteStore()) return;
  const database = openDelegationSqlite();
  withDelegationSqliteTransaction(database, () => upsertMailboxSqlite(database, row));
}

function isSqliteStore() {
  return getDelegationStoreBackend() === 'sqlite';
}

/**
 * @returns {Record<string, any>[]}
 */
export function loadMailboxMessages() {
  if (isSqliteStore()) return loadMailboxSqlite(openDelegationSqlite());
  return loadDocument().items;
}

/**
 * Rows matching `predicate`. SQLite narrows by an indexed column first; the
 * predicate stays the single source of truth for both backends.
 *
 * @param {string} where indexed SQLite prefilter
 * @param {unknown[]} params
 * @param {(row: Record<string, any>) => boolean} predicate
 * @returns {Record<string, any>[]}
 */
function selectMailbox(where, params, predicate) {
  const rows = isSqliteStore()
    ? queryMailboxSqlite(openDelegationSqlite(), where, params)
    : loadMailboxMessages();
  return rows.filter(predicate);
}

/**
 * Rows in one of the given statuses (the runtime tick only needs queued and
 * dispatching records, not the whole delivered history).
 *
 * @param {string[]} statuses
 * @returns {Record<string, any>[]}
 */
export function listMailboxByStatus(statuses) {
  const wanted = [...new Set((Array.isArray(statuses) ? statuses : []).map((s) => String(s || '')))];
  if (!wanted.length) return [];
  const matches = (row) => wanted.includes(String(row.status || ''));
  if (!isSqliteStore()) return loadDocument(matches).items;
  return selectMailbox(`status IN (${wanted.map(() => '?').join(', ')})`, wanted, matches);
}

/**
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
export function getMailboxMessageById(id) {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
  if (isSqliteStore()) {
    return getMailboxSqliteById(openDelegationSqlite(), normalized);
  }
  return loadMailboxMessages().find((row) => row.id === normalized) || null;
}

/**
 * @param {string} idempotencyKey
 * @returns {Record<string, any> | null}
 */
export function findMailboxByIdempotencyKey(idempotencyKey) {
  const normalized = String(idempotencyKey || '').trim();
  if (!normalized) return null;
  return selectMailbox('idempotency_key = ?', [normalized], (row) => row.idempotencyKey === normalized)[0] || null;
}

/**
 * @param {string} chatId
 * @returns {Record<string, any>[]}
 */
export function listMailboxForChat(chatId) {
  const normalized = String(chatId || '').trim();
  if (!normalized) return [];
  return selectMailbox('to_chat_id = ? OR from_chat_id = ?', [normalized, normalized], (row) => {
    return row.toChatId === normalized || row.fromChatId === normalized;
  });
}

/**
 * @param {string} chatId
 * @returns {Record<string, any>[]}
 */
export function listQueuedMailboxForRecipient(chatId) {
  const normalized = String(chatId || '').trim();
  if (!normalized) return [];
  return selectMailbox('to_chat_id = ? AND status = ?', [normalized, 'queued'], (row) => row.toChatId === normalized && row.status === 'queued')
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

/**
 * First reply for a job. Prefer attempt-aware helpers for reports.
 *
 * @param {string} delegationId
 * @returns {Record<string, any> | null}
 */
export function findMailboxReplyForDelegation(delegationId) {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  return selectMailbox('delegation_id = ?', [id], (row) => {
    return normalizeKind(row.kind) === 'reply' && String(row.delegationId || '').trim() === id;
  })[0] || null;
}

/**
 * Final report for one attempt. Legacy rows without attempt id are not bound
 * to a later retry.
 *
 * @param {string} delegationId
 * @param {string} attemptId
 * @returns {Record<string, any> | null}
 */
export function findMailboxFinalReplyForAttempt(delegationId, attemptId) {
  const id = String(delegationId || '').trim();
  const attempt = String(attemptId || '').trim();
  if (!id || !attempt) return null;
  const rows = selectMailbox('delegation_id = ?', [id], (row) => isFinalReplyForAttempt(row, id, attempt));
  // A child-sent report outranks the server's auto placeholder written when the
  // run finished before the reply arrived.
  return rows.find((row) => !isAutoParentReplyKey(row.idempotencyKey)) || rows[0] || null;
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isAutoParentReplyKey(key) {
  return String(key || '').startsWith('delegation-auto-reply:');
}

/**
 * @param {Record<string, any>} row
 * @param {string} delegationId
 * @param {string} attemptId
 * @returns {boolean}
 */
function isFinalReplyForAttempt(row, delegationId, attemptId) {
  if (normalizeKind(row.kind) !== 'reply') return false;
  if (String(row.delegationId || '').trim() !== delegationId) return false;
  if (normalizeReplyKind(row.replyKind) !== 'final_report') return false;
  return String(row.delegationAttemptId || '').trim() === attemptId;
}

/**
 * Any final report for this job, including rows with an empty attempt id.
 *
 * @param {string} delegationId
 * @returns {Record<string, any> | null}
 */
export function findMailboxFinalReplyForDelegation(delegationId) {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  return selectMailbox('delegation_id = ?', [id], (row) => {
    if (normalizeKind(row.kind) !== 'reply') return false;
    if (String(row.delegationId || '').trim() !== id) return false;
    return normalizeReplyKind(row.replyKind) === 'final_report';
  })[0] || null;
}

/**
 * Any mailbox row for this job attempt, including progress.
 *
 * @param {string} delegationId
 * @param {string} attemptId
 * @returns {Record<string, any>[]}
 */
export function listMailboxForDelegationAttempt(delegationId, attemptId) {
  const id = String(delegationId || '').trim();
  const attempt = String(attemptId || '').trim();
  if (!id || !attempt) return [];
  return selectMailbox('delegation_id = ?', [id], (row) => {
    if (String(row.delegationId || '').trim() !== id) return false;
    return String(row.delegationAttemptId || '').trim() === attempt;
  });
}

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
export function createMailboxMessage(input) {
  const now = new Date().toISOString();
  const kind = normalizeKind(input.kind) || 'reply';
  // SQLite inserts one row; only the JSON file needs every row to rewrite it.
  const items = isSqliteStore() ? [] : loadMailboxMessages();
  const delegationId = String(input.delegationId || '').trim();
  const delegationAttemptId = String(input.delegationAttemptId || '').trim();
  const replyKind = kind === 'reply'
    ? (normalizeReplyKind(input.replyKind) || 'progress')
    : '';
  if (kind === 'reply' && replyKind === 'final_report' && delegationId && delegationAttemptId) {
    const existing = isSqliteStore()
      ? findMailboxFinalReplyForAttempt(delegationId, delegationAttemptId)
      : items.find((row) => isFinalReplyForAttempt(row, delegationId, delegationAttemptId));
    if (existing) return existing;
  }
  const sourceMessageRef = input.sourceMessageRef && typeof input.sourceMessageRef === 'object'
    ? {
      chatId: String(input.sourceMessageRef.chatId || input.fromChatId || '').trim(),
      historySeq: Number(input.sourceMessageRef.historySeq) > 0
        ? Number(input.sourceMessageRef.historySeq)
        : 0,
      contentHash: String(input.sourceMessageRef.contentHash || '').trim(),
    }
    : null;
  const record = {
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    fromChatId: String(input.fromChatId || '').trim(),
    toChatId: String(input.toChatId || '').trim(),
    delegationId: String(input.delegationId || '').trim(),
    delegationAttemptId,
    replyKind,
    kind,
    body: String(input.body || ''),
    sourceHistorySeq: Number(input.sourceHistorySeq) > 0 ? Number(input.sourceHistorySeq) : 0,
    sourceMessageRef,
    sourceHash: String(input.sourceHash || '').trim(),
    requestHash: String(input.requestHash || '').trim(),
    extraInstructions: String(input.extraInstructions || '').trim(),
    taskOutcome: String(input.taskOutcome || '').trim() || 'unspecified',
    attemptId: String(input.attemptId || randomUUID()).trim(),
    status: normalizeStatus(input.status) || 'queued',
    delivery: String(input.delivery || '').trim(),
    deliveryRequestId: String(input.deliveryRequestId || '').trim(),
    recipientRunId: String(input.recipientRunId || '').trim(),
    idempotencyKey: String(input.idempotencyKey || '').trim(),
    historyDeliveredAt: '',
    createdAt: now,
    deliveredAt: '',
    error: '',
  };
  items.push(record);
  if (isSqliteStore()) persistMailboxRow(record);
  else saveItems(items);
  return record;
}

/**
 * @param {Record<string, any>} current
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, any>}
 */
function applyMailboxPatch(current, patch) {
  const next = { ...current };
  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    if (status) next.status = status;
  }
  const assignable = [
    'toChatId',
    'delivery',
    'historyDeliveredAt',
    'deliveredAt',
    'error',
    'runId',
    'attemptId',
    'deliveryRequestId',
    'recipientRunId',
    'sourceHash',
    'requestHash',
    'extraInstructions',
    'delegationAttemptId',
    'replyKind',
    'taskOutcome',
    'dispatchingAt',
    'leaseOwner',
    'leaseRevision',
  ];
  for (const key of assignable) {
    if (patch[key] === undefined) continue;
    next[key] = patch[key] == null ? '' : String(patch[key]);
  }
  next.revision = (Number(current.revision) || 1) + 1;
  return next;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {{ expectedRevision?: number }} [options]
 * @returns {Record<string, any> | null}
 */
export function updateMailboxMessage(id, patch, options = {}) {
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    return withDelegationSqliteTransaction(database, () => {
      const current = getMailboxSqliteById(database, id);
      if (!current) return null;
      if (options.expectedRevision != null && Number(current.revision || 1) !== Number(options.expectedRevision)) {
        return null;
      }
      const next = applyMailboxPatch(current, patch);
      upsertMailboxSqlite(database, next);
      return next;
    });
  }
  const items = loadMailboxMessages();
  const idx = items.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  const current = items[idx];
  if (options.expectedRevision != null && Number(current.revision || 1) !== Number(options.expectedRevision)) {
    return null;
  }
  const next = applyMailboxPatch(current, patch);
  items[idx] = next;
  saveItems(items);
  return next;
}

/**
 * Digest of a mailbox body under the same normalization the replay
 * fingerprint has always used (`String(body || '').trim()`), so a trimmed row
 * still answers "is this the same body?" exactly.
 *
 * @param {unknown} body
 * @returns {string}
 */
export function hashMailboxBody(body) {
  return createHash('sha256').update(String(body || '').trim()).digest('hex');
}

/**
 * Replaces long delivered bodies with a preview in ONE write (JSON) or one
 * transaction (SQLite). The body hash, original length and trim stamp land in
 * the same write as the shorter body; a row whose body no longer matches the
 * hash (changed since it was selected) or that is already trimmed is skipped.
 *
 * @param {Array<{ id: string, body: string, bodyHash: string, bodyLength: number, requestHash?: string }>} updates
 * @param {string} [trimmedAt]
 * @returns {number} rows trimmed
 */
export function trimMailboxBodiesBatch(updates, trimmedAt = new Date().toISOString()) {
  const wanted = new Map((Array.isArray(updates) ? updates : [])
    .filter((u) => u && String(u.id || '').trim() && String(u.bodyHash || '').trim())
    .map((u) => [String(u.id), u]));
  if (wanted.size === 0) return 0;
  const apply = (current) => {
    const update = wanted.get(String(current?.id || ''));
    if (!update || String(current.bodyTrimmedAt || '').trim()) return null;
    if (hashMailboxBody(current.body) !== update.bodyHash) return null;
    return {
      ...current,
      body: String(update.body || ''),
      bodyHash: update.bodyHash,
      bodyLength: Math.max(0, Math.floor(Number(update.bodyLength) || 0)),
      bodyTrimmedAt: trimmedAt,
      ...(update.requestHash !== undefined ? { requestHash: String(update.requestHash || '') } : {}),
      revision: (Number(current.revision) || 1) + 1,
    };
  };
  let trimmed = 0;
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    withDelegationSqliteTransaction(database, () => {
      for (const id of wanted.keys()) {
        const next = apply(getMailboxSqliteById(database, id));
        if (!next) continue;
        upsertMailboxSqlite(database, next);
        trimmed += 1;
      }
    });
    return trimmed;
  }
  const items = loadMailboxMessages().map((row) => {
    const next = apply(row);
    if (!next) return row;
    trimmed += 1;
    return next;
  });
  if (trimmed > 0) saveItems(items);
  return trimmed;
}

/**
 * Applies many mailbox patches with ONE write (JSON) or one transaction
 * (SQLite), through the same field rules as `updateMailboxMessage`.
 *
 * @param {Array<{ id: string, patch: Record<string, unknown> }>} updates
 * @returns {number} rows updated
 */
export function updateMailboxMessagesBatch(updates) {
  const wanted = new Map((Array.isArray(updates) ? updates : [])
    .filter((u) => u && String(u.id || '').trim() && u.patch && typeof u.patch === 'object')
    .map((u) => [String(u.id), u.patch]));
  if (wanted.size === 0) return 0;
  let updated = 0;
  if (isSqliteStore()) {
    const database = openDelegationSqlite();
    withDelegationSqliteTransaction(database, () => {
      for (const [id, patch] of wanted) {
        const current = getMailboxSqliteById(database, id);
        if (!current) continue;
        upsertMailboxSqlite(database, applyMailboxPatch(current, patch));
        updated += 1;
      }
    });
    return updated;
  }
  const items = loadMailboxMessages().map((row) => {
    const patch = wanted.get(String(row?.id || ''));
    if (!patch) return row;
    updated += 1;
    return applyMailboxPatch(row, patch);
  });
  if (updated > 0) saveItems(items);
  return updated;
}
