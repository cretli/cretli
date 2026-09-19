/**
 * Archive finished delegations without dropping idempotency keys or live work.
 */

import { isActiveDelegationStatus } from './delegation-status.js';
import { loadDelegations, updateDelegationRecord } from './persist/delegations-persist.js';
import { loadMailboxMessages, updateMailboxMessage } from './persist/delegation-mailbox-persist.js';
import { groupMailboxByDelegation, describeDelegationMailbox } from './delegation-query.js';

export const DELEGATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DELEGATION_IDEMPOTENCY_TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPT_HISTORY = 20;
const MAX_OUTBOX_HISTORY = 40;

/**
 * @param {object} row
 * @returns {boolean}
 */
function canArchiveDelegation(row, mailboxRows = []) {
  if (isActiveDelegationStatus(row.status)) return false;
  if (String(row.runStoppingAt || '').trim()) return false;
  if (String(row.acceptState || '') === 'uncertain') return false;
  const outbox = Array.isArray(row.outbox) ? row.outbox : [];
  if (outbox.some((item) => !String(item.deliveredAt || '').trim())) return false;
  const mailbox = describeDelegationMailbox(mailboxRows);
  if (mailbox.pendingMailbox || mailbox.failedMailbox || mailbox.retryableDelivery) return false;
  return true;
}

/**
 * @param {{ now?: number, retentionMs?: number }} [options]
 * @returns {{ archived: number, trimmed: number }}
 */
export function applyDelegationRetention(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const retentionMs = Number(options.retentionMs) > 0 ? Number(options.retentionMs) : DELEGATION_RETENTION_MS;
  let archived = 0;
  let trimmed = 0;
  const mailboxById = groupMailboxByDelegation(loadMailboxMessages());
  for (const row of loadDelegations()) {
    if (!canArchiveDelegation(row, mailboxById.get(row.id) || [])) continue;
    const finished = Date.parse(String(row.finishedAt || row.lastTransitionAt || row.createdAt || ''));
    const age = Number.isFinite(finished) ? now - finished : 0;
    const attempts = Array.isArray(row.attempts) ? row.attempts : [];
    const outbox = Array.isArray(row.outbox) ? row.outbox : [];
    const nextAttempts = attempts.slice(-MAX_ATTEMPT_HISTORY);
    const nextOutbox = outbox.filter((item) => String(item.deliveredAt || '').trim()).slice(-MAX_OUTBOX_HISTORY);
    const shouldArchive = age >= retentionMs && !String(row.archivedAt || '').trim();
    if (!shouldArchive && nextAttempts.length === attempts.length && nextOutbox.length === outbox.length) {
      continue;
    }
    const tombstoneUntil = new Date(now + DELEGATION_IDEMPOTENCY_TOMBSTONE_MS).toISOString();
    updateDelegationRecord(row.id, {
      attempts: nextAttempts,
      outbox: nextOutbox,
      planMarkdown: shouldArchive ? '' : row.planMarkdown,
      sourceText: shouldArchive ? '' : row.sourceText,
      report: shouldArchive ? String(row.report || '').slice(0, 2000) : row.report,
      archivedAt: shouldArchive ? new Date(now).toISOString() : row.archivedAt,
      tombstoneUntil: row.tombstoneUntil || tombstoneUntil,
    });
    if (shouldArchive) archived += 1;
    else trimmed += 1;
  }
  for (const row of loadMailboxMessages()) {
    const status = String(row.status || '');
    if (status !== 'delivered') continue;
    const at = Date.parse(String(row.deliveredAt || row.createdAt || ''));
    if (!Number.isFinite(at) || now - at < retentionMs) continue;
    if (String(row.body || '').length <= 240) continue;
    updateMailboxMessage(row.id, {
      extraInstructions: '',
    });
    trimmed += 1;
  }
  return { archived, trimmed };
}
