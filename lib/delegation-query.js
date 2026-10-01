/**
 * Compact list/detail paging for delegations. History bodies stay on extra pages.
 */

import { countDelegationAttempts, listDelegationAttempts } from './delegation-attempt.js';
import { isActiveDelegationStatus, isDelegationSlotOccupied } from './delegation-status.js';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;
const REPORT_PAGE_CHARS = 4000;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function readLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

/**
 * @param {object} row
 * @returns {string}
 */
export function encodeDelegationCursor(row) {
  return Buffer.from(JSON.stringify({
    t: String(row?.createdAt || row?.at || ''),
    id: String(row?.id || ''),
  }), 'utf8').toString('base64url');
}

/**
 * @param {unknown} cursor
 * @returns {{ t: string, id: string } | null}
 */
export function decodeDelegationCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { t: String(parsed.t || ''), id: String(parsed.id || '') };
  } catch {
    return null;
  }
}

/**
 * @param {object} row
 * @returns {boolean}
 */
function hasPendingOutbox(row) {
  const items = Array.isArray(row?.outbox) ? row.outbox : [];
  return items.some((item) => !String(item?.deliveredAt || '').trim());
}

/**
 * @param {object[]} messages
 * @returns {Map<string, object[]>}
 */
export function groupMailboxByDelegation(messages) {
  const map = new Map();
  for (const row of Array.isArray(messages) ? messages : []) {
    const id = String(row?.delegationId || '').trim();
    if (!id) continue;
    const list = map.get(id);
    if (list) list.push(row);
    else map.set(id, [row]);
  }
  return map;
}

/**
 * @param {object[]} messages
 * @returns {{ pendingMailbox: boolean, retryableDelivery: boolean }}
 */
export function describeDelegationMailbox(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  let pendingMailbox = false;
  let failedMailbox = false;
  let retryableDelivery = false;
  let retryableMailboxId = '';
  let retryableMailboxCount = 0;
  for (const row of rows) {
    const status = String(row?.status || '');
    if (status === 'queued' || status === 'dispatching' || status === 'uncertain') {
      pendingMailbox = true;
    }
    if (status === 'failed') failedMailbox = true;
    if (status === 'failed' || status === 'uncertain') {
      retryableDelivery = true;
      retryableMailboxCount += 1;
      if (!retryableMailboxId) retryableMailboxId = String(row?.id || '');
    }
  }
  return { pendingMailbox, failedMailbox, retryableDelivery, retryableMailboxId, retryableMailboxCount };
}

/**
 * @param {object} row
 * @param {{ mailbox?: object[] }} [extras]
 * @returns {object}
 */
export function summarizeDelegation(row, extras = {}) {
  const executor = row?.executor && typeof row.executor === 'object' ? row.executor : {};
  const mailbox = describeDelegationMailbox(extras.mailbox);
  const pendingOutbox = hasPendingOutbox(row);
  const uncertainAccept = String(row?.acceptState || '') === 'uncertain';
  return {
    id: String(row?.id || ''),
    status: String(row?.status || ''),
    parentChatId: String(row?.parentChatId || ''),
    childChatId: String(row?.childChatId || ''),
    workspaceFolder: String(row?.workspaceFolder || ''),
    attemptId: String(row?.attemptId || ''),
    runId: String(row?.runId || ''),
    acceptState: String(row?.acceptState || ''),
    acceptRequestId: String(row?.acceptRequestId || ''),
    createdAt: String(row?.createdAt || ''),
    startedAt: String(row?.startedAt || ''),
    finishedAt: String(row?.finishedAt || ''),
    lastTransitionAt: String(row?.lastTransitionAt || ''),
    unverified: row?.unverified !== false,
    acknowledgedAt: String(row?.acknowledgedAt || ''),
    sourceKind: String(row?.sourceKind || ''),
    assignment: String(row?.assignment || ''),
    executionMode: String(row?.executionMode || ''),
    pickReason: String(row?.pickReason || '').trim(),
    error: String(row?.error || '').slice(0, 240),
    interruptCode: String(row?.interruptCode || ''),
    executor: {
      transport: String(executor.transport || ''),
      model: String(executor.model || ''),
    },
    attemptCount: countDelegationAttempts(row),
    pendingOutbox,
    pendingMailbox: mailbox.pendingMailbox,
    failedMailbox: mailbox.failedMailbox,
    retryableDelivery: pendingOutbox || uncertainAccept || mailbox.retryableDelivery,
    retryableMailboxId: mailbox.retryableMailboxId,
    retryableMailboxCount: mailbox.retryableMailboxCount,
    runStopping: Boolean(String(row?.runStoppingAt || '').trim()),
    taskOutcome: String(row?.taskOutcome || 'unspecified'),
    slotOccupied: isDelegationSlotOccupied(row),
    active: isActiveDelegationStatus(row?.status),
  };
}

/**
 * @param {object[]} rows
 * @param {{ cursor?: string, limit?: number, newestFirst?: boolean }} [options]
 */
export function pageDelegationRows(rows, options = {}) {
  const newestFirst = options.newestFirst !== false;
  const sorted = [...rows].sort((left, right) => {
    const byTime = String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
    if (byTime) return newestFirst ? byTime : -byTime;
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
  const cursor = decodeDelegationCursor(options.cursor);
  const start = cursor
    ? sorted.findIndex((row) => {
      const cmp = String(row.createdAt || '').localeCompare(cursor.t);
      if (newestFirst) {
        if (cmp < 0) return true;
        if (cmp > 0) return false;
        return String(row.id || '') < cursor.id;
      }
      if (cmp > 0) return true;
      if (cmp < 0) return false;
      return String(row.id || '') > cursor.id;
    })
    : 0;
  const from = start < 0 ? sorted.length : start;
  const limit = readLimit(options.limit);
  const slice = sorted.slice(from, from + limit);
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: slice.length === limit && last ? encodeDelegationCursor(last) : '',
  };
}

/**
 * @param {object} row
 * @param {{ cursor?: string, limit?: number }} [options]
 */
export function pageDelegationAttempts(row, options = {}) {
  const attempts = listDelegationAttempts(row).map((item, index) => ({
    ...item,
    id: String(item.attemptId || index),
    createdAt: String(item.startedAt || item.finishedAt || row.createdAt || ''),
  }));
  const page = pageDelegationRows(attempts, { ...options, newestFirst: true });
  return {
    attempts: page.items,
    nextCursor: page.nextCursor,
  };
}

/**
 * @param {object} row
 * @param {{ cursor?: number, limit?: number, field?: 'report' | 'plan' }} [options]
 */
export function pageDelegationText(row, options = {}) {
  const field = options.field === 'plan' ? 'planMarkdown' : 'report';
  const text = String(row?.[field] || '');
  const offset = Number(options.cursor) > 0 ? Math.floor(Number(options.cursor)) : 0;
  const limit = readLimit(options.limit, 20) * 200;
  const size = Math.min(REPORT_PAGE_CHARS, limit);
  const slice = text.slice(offset, offset + size);
  const next = offset + slice.length;
  return {
    field: field === 'planMarkdown' ? 'plan' : 'report',
    text: slice,
    offset,
    nextCursor: next < text.length ? String(next) : '',
    totalChars: text.length,
  };
}

/**
 * @param {object} row
 * @param {{ cursor?: string, limit?: number }} [options]
 */
export function pageDelegationOutbox(row, options = {}) {
  const items = (Array.isArray(row?.outbox) ? row.outbox : []).map((item) => ({
    id: String(item.id || ''),
    type: String(item.type || ''),
    event: String(item.event || ''),
    attemptId: String(item.attemptId || ''),
    deliveredAt: String(item.deliveredAt || ''),
    nextAttemptAt: String(item.nextAttemptAt || ''),
    tryCount: Number(item.tryCount) || 0,
    createdAt: String(item.createdAt || item.nextAttemptAt || row.createdAt || ''),
    error: String(item.error || ''),
  }));
  const page = pageDelegationRows(items, options);
  return {
    outbox: page.items,
    nextCursor: page.nextCursor,
  };
}

/**
 * @param {object} row
 * @param {{ mailbox?: object[] }} [extras]
 * @returns {'active' | 'needs_input' | 'failed' | 'uncertain' | 'pending_delivery' | 'done'}
 */
export function classifyDelegationAttention(row, extras = {}) {
  const status = String(row?.status || '');
  const mailbox = describeDelegationMailbox(extras.mailbox);
  if (status === 'waiting_for_input') return 'needs_input';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted' || String(row?.acceptState || '') === 'uncertain') return 'uncertain';
  if (hasPendingOutbox(row) || mailbox.pendingMailbox || mailbox.failedMailbox) return 'pending_delivery';
  if (isActiveDelegationStatus(status)) return 'active';
  return 'done';
}
