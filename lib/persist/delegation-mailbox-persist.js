/**
 * Durable inter-chat mailbox for delegated tasks and replies.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const DATA_FILE = resolveDataPath('delegation-mailbox.json');
const SCHEMA_VERSION = 1;

export const MAILBOX_STATUSES = Object.freeze([
  'queued',
  'dispatching',
  'delivered',
  'failed',
  'uncertain',
]);
export const MAILBOX_KINDS = Object.freeze(['task', 'reply']);

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
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    throw new MailboxCorruptError(
      `Mailbox file is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MailboxCorruptError('Mailbox file is not an object');
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
  ensureDir();
  writeJsonAtomic(DATA_FILE, { v: SCHEMA_VERSION, items });
}

/**
 * @returns {object[]}
 */
export function loadMailboxMessages() {
  return loadDocument().items;
}

/**
 * @param {string} id
 * @returns {object | null}
 */
export function getMailboxMessageById(id) {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
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
 * @param {object} input
 * @returns {object}
 */
export function createMailboxMessage(input) {
  const now = new Date().toISOString();
  const kind = normalizeKind(input.kind) || 'reply';
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
    fromChatId: String(input.fromChatId || '').trim(),
    toChatId: String(input.toChatId || '').trim(),
    delegationId: String(input.delegationId || '').trim(),
    kind,
    body: String(input.body || ''),
    sourceHistorySeq: Number(input.sourceHistorySeq) > 0 ? Number(input.sourceHistorySeq) : 0,
    sourceMessageRef,
    sourceHash: String(input.sourceHash || '').trim(),
    requestHash: String(input.requestHash || '').trim(),
    extraInstructions: String(input.extraInstructions || '').trim(),
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
  const items = loadMailboxMessages();
  items.push(record);
  saveItems(items);
  return record;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {object | null}
 */
export function updateMailboxMessage(id, patch) {
  const items = loadMailboxMessages();
  const idx = items.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  const next = { ...items[idx] };
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
  ];
  for (const key of assignable) {
    if (patch[key] === undefined) continue;
    next[key] = patch[key] == null ? '' : String(patch[key]);
  }
  items[idx] = next;
  saveItems(items);
  return next;
}
