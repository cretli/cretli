/**
 * Durable inter-chat mailbox for delegated tasks and replies.
 */

import { randomUUID } from 'crypto';
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
} from './delegation-sqlite.js';

const DATA_FILE = resolveDataPath('delegation-mailbox.json');
const SCHEMA_VERSION = MAILBOX_JSON_SCHEMA_VERSION;

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
 * @returns {{ v: number, items: object[] }}
 */
function loadDocument() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return { v: SCHEMA_VERSION, items: [] };
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
  return { v: SCHEMA_VERSION, items };
}

/**
 * @param {object[]} items
 */
function saveItems(items) {
  if (isSqliteStore()) {
    replaceMailboxSqlite(openDelegationSqlite(), items);
    return;
  }
  ensureDelegationOwnerLock();
  ensureDir();
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
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
 * @returns {object[]}
 */
export function loadMailboxMessages() {
  if (isSqliteStore()) return loadMailboxSqlite(openDelegationSqlite());
  return loadDocument().items;
}

/**
 * @param {string} id
 * @returns {object | null}
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
 * @returns {object | null}
 */
export function findMailboxByIdempotencyKey(idempotencyKey) {
  const normalized = String(idempotencyKey || '').trim();
  if (!normalized) return null;
  return loadMailboxMessages().find((row) => row.idempotencyKey === normalized) || null;
}

/**
 * @param {string} chatId
 * @returns {object[]}
 */
export function listMailboxForChat(chatId) {
  const normalized = String(chatId || '').trim();
  if (!normalized) return [];
  return loadMailboxMessages().filter((row) => {
    return row.toChatId === normalized || row.fromChatId === normalized;
  });
}

/**
 * @param {string} chatId
 * @returns {object[]}
 */
export function listQueuedMailboxForRecipient(chatId) {
  const normalized = String(chatId || '').trim();
  if (!normalized) return [];
  return loadMailboxMessages()
    .filter((row) => row.toChatId === normalized && row.status === 'queued')
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

/**
 * First reply for a job. Prefer attempt-aware helpers for reports.
 *
 * @param {string} delegationId
 * @returns {object | null}
 */
export function findMailboxReplyForDelegation(delegationId) {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  return loadMailboxMessages().find((row) => {
    return normalizeKind(row.kind) === 'reply' && String(row.delegationId || '').trim() === id;
  }) || null;
}

/**
 * Final report for one attempt. Legacy rows without attempt id are not bound
 * to a later retry.
 *
 * @param {string} delegationId
 * @param {string} attemptId
 * @returns {object | null}
 */
export function findMailboxFinalReplyForAttempt(delegationId, attemptId) {
  const id = String(delegationId || '').trim();
  const attempt = String(attemptId || '').trim();
  if (!id || !attempt) return null;
  return loadMailboxMessages().find((row) => {
    if (normalizeKind(row.kind) !== 'reply') return false;
    if (String(row.delegationId || '').trim() !== id) return false;
    if (normalizeReplyKind(row.replyKind) !== 'final_report') return false;
    return String(row.delegationAttemptId || '').trim() === attempt;
  }) || null;
}

/**
 * Any final report for this job, including rows with an empty attempt id.
 *
 * @param {string} delegationId
 * @returns {object | null}
 */
export function findMailboxFinalReplyForDelegation(delegationId) {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  return loadMailboxMessages().find((row) => {
    if (normalizeKind(row.kind) !== 'reply') return false;
    if (String(row.delegationId || '').trim() !== id) return false;
    return normalizeReplyKind(row.replyKind) === 'final_report';
  }) || null;
}

/**
 * Any mailbox row for this job attempt, including progress.
 *
 * @param {string} delegationId
 * @param {string} attemptId
 * @returns {object[]}
 */
export function listMailboxForDelegationAttempt(delegationId, attemptId) {
  const id = String(delegationId || '').trim();
  const attempt = String(attemptId || '').trim();
  if (!id || !attempt) return [];
  return loadMailboxMessages().filter((row) => {
    if (String(row.delegationId || '').trim() !== id) return false;
    return String(row.delegationAttemptId || '').trim() === attempt;
  });
}

/**
 * @param {object} input
 * @returns {object}
 */
export function createMailboxMessage(input) {
  const now = new Date().toISOString();
  const kind = normalizeKind(input.kind) || 'reply';
  const items = loadMailboxMessages();
  const delegationId = String(input.delegationId || '').trim();
  const delegationAttemptId = String(input.delegationAttemptId || '').trim();
  const replyKind = kind === 'reply'
    ? (normalizeReplyKind(input.replyKind) || 'progress')
    : '';
  if (kind === 'reply' && replyKind === 'final_report' && delegationId && delegationAttemptId) {
    const existing = items.find((row) => {
      if (normalizeKind(row.kind) !== 'reply') return false;
      if (String(row.delegationId || '').trim() !== delegationId) return false;
      if (normalizeReplyKind(row.replyKind) !== 'final_report') return false;
      return String(row.delegationAttemptId || '').trim() === delegationAttemptId;
    });
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
 * @param {object} current
 * @param {Record<string, unknown>} patch
 * @returns {object}
 */
function applyMailboxPatch(current, patch) {
  const next = { ...current };
  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    if (status) next.status = status;
  }
  const assignable = [
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
 * @returns {object | null}
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
