/**
 * Durable delegation records (plan execution jobs).
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  isActiveDelegationStatus,
  normalizeDelegationStatus,
} from '../delegation-status.js';

const DATA_FILE = resolveDataPath('delegations.json');
const SCHEMA_VERSION = 1;

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * @returns {{ v: number, items: object[] }}
 */
function loadDocument() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return { v: SCHEMA_VERSION, items: [] };
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const items = Array.isArray(data?.items) ? data.items.filter((row) => row && typeof row === 'object') : [];
    return { v: SCHEMA_VERSION, items };
  } catch {
    return { v: SCHEMA_VERSION, items: [] };
  }
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
export function loadDelegations() {
  return loadDocument().items;
}

/**
 * @param {string} id
 * @returns {object | null}
 */
export function getDelegationById(id) {
  const normalized = String(id || '').trim();
  if (!normalized) return null;
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
  const active = rows.find((row) => isActiveDelegationStatus(row.status));
  return active || rows[rows.length - 1];
}

/**
 * @param {string} parentChatId
 * @returns {object | null}
 */
export function findActiveDelegationForParent(parentChatId) {
  return listDelegationsForParent(parentChatId).find((row) => isActiveDelegationStatus(row.status)) || null;
}

/**
 * @param {string} idempotencyKey
 * @returns {object | null}
 */
export function findDelegationByIdempotencyKey(idempotencyKey) {
  const normalized = String(idempotencyKey || '').trim();
  if (!normalized) return null;
  return loadDelegations().find((row) => row.idempotencyKey === normalized) || null;
}

/**
 * @param {object} input
 * @returns {object}
 */
export function createDelegationRecord(input) {
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    parentChatId: String(input.parentChatId || '').trim(),
    childChatId: String(input.childChatId || '').trim(),
    workspaceFolder: String(input.workspaceFolder || '').trim(),
    planRevision: Number(input.planRevision) || 0,
    planHash: String(input.planHash || '').trim(),
    planMarkdown: String(input.planMarkdown || ''),
    executor: input.executor && typeof input.executor === 'object' ? { ...input.executor } : {},
    status: normalizeDelegationStatus(input.status) || 'queued',
    attemptId: String(input.attemptId || randomUUID()).trim(),
    runId: String(input.runId || '').trim(),
    idempotencyKey: String(input.idempotencyKey || '').trim(),
    createdAt: now,
    startedAt: '',
    finishedAt: '',
    report: '',
    error: '',
    reportDeliveryId: '',
    reportDeliveredAt: '',
    historyDeliveredAt: '',
    extraInstructions: String(input.extraInstructions || '').trim(),
    unverified: true,
    acknowledgedAt: '',
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
  };
  const items = loadDelegations();
  items.push(record);
  saveItems(items);
  return record;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {object | null}
 */
export function updateDelegationRecord(id, patch) {
  const items = loadDelegations();
  const idx = items.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  const next = { ...items[idx] };
  const previousStatus = next.status;
  if (patch.status !== undefined) {
    const status = normalizeDelegationStatus(patch.status);
    if (status) next.status = status;
  }
  if (previousStatus !== next.status && patch.acknowledgedAt === undefined) {
    next.acknowledgedAt = '';
  }
  const assignable = [
    'childChatId',
    'attemptId',
    'runId',
    'startedAt',
    'finishedAt',
    'report',
    'error',
    'reportDeliveryId',
    'reportDeliveredAt',
    'historyDeliveredAt',
    'lastPublishedStatus',
    'lastPublishedEvent',
    'workspaceFolder',
    'acknowledgedAt',
    'sourceHash',
    'requestHash',
    'executionMode',
  ];
  for (const key of assignable) {
    if (patch[key] === undefined) continue;
    next[key] = patch[key] == null ? '' : String(patch[key]);
  }
  if (patch.unverified === false) next.unverified = false;
  if (patch.unverified === true) next.unverified = true;
  items[idx] = next;
  saveItems(items);
  return next;
}
