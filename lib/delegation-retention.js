/**
 * Archive finished delegations without dropping idempotency keys or live work.
 *
 * Archiving is lossy: the report is cut to RETENTION_REPORT_MAX characters and
 * the task text is cleared. Rows are never deleted. Only terminal rows whose
 * outbox and parent mailbox are fully delivered qualify; the full text stays
 * in the child and parent chat histories.
 */

import { isActiveDelegationStatus, isDelegationSlotOccupied } from './delegation-status.js';
import { DELEGATION_VERDICTS, parseDelegationVerdict } from './delegation-verdict.js';
import { buildMailboxReplyFingerprint } from './delegation-mailbox.js';
import { loadDelegations, updateDelegationRecordsBatch } from './persist/delegations-persist.js';
import {
  hashMailboxBody,
  loadMailboxMessages,
  trimMailboxBodiesBatch,
  updateMailboxMessagesBatch,
} from './persist/delegation-mailbox-persist.js';
import { listTodos } from './persist/todos-store.js';
import { resolveDataPath } from './runtime-paths.js';
import { groupMailboxByDelegation, describeDelegationMailbox } from './delegation-query.js';

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling: every eligible finished row is archived after this long. */
export const DELEGATION_RETENTION_MS = 30 * DAY_MS;
/** Rows of a `done` leaf, or with no leaf at all, are archived after this long. */
export const DELEGATION_TRIM_AFTER_MS = readTrimAfterMs();
export const DELEGATION_IDEMPOTENCY_TOMBSTONE_MS = 90 * DAY_MS;
// Exported so the review snapshot can detect a retained (possibly trimmed)
// attempt history and settle it as `unknown` instead of guessing (§11).
export const MAX_ATTEMPT_HISTORY = 20;
const MAX_OUTBOX_HISTORY = 40;
/** Must match RETENTION_REPORT_MAX in `todo-review-read.js` (report_trimmed link). */
const RETENTION_REPORT_MAX = 2000;
/** Delivered mailbox bodies keep this many characters after trimming. */
export const MAILBOX_BODY_PREVIEW = 240;

/**
 * @returns {number}
 */
function readTrimAfterMs() {
  const raw = Number(process.env.CRETLI_DELEGATION_TRIM_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3 * DAY_MS;
}

/**
 * @param {Record<string, any>} row
 * @param {Record<string, any>[]} [mailboxRows]
 * @returns {boolean}
 */
function canArchiveDelegation(row, mailboxRows = []) {
  if (isActiveDelegationStatus(row.status)) return false;
  if (isDelegationSlotOccupied(row)) return false;
  if (String(row.runStoppingAt || '').trim()) return false;
  if (String(row.acceptState || '') === 'uncertain') return false;
  // Two-stage delivery: an outbox item is marked delivered once the mailbox row
  // exists; the parent has the report only when that row is delivered too.
  const outbox = Array.isArray(row.outbox) ? row.outbox : [];
  if (outbox.some((item) => !String(item.deliveredAt || '').trim())) return false;
  const mailbox = describeDelegationMailbox(mailboxRows);
  if (mailbox.pendingMailbox || mailbox.failedMailbox || mailbox.retryableDelivery) return false;
  return true;
}

/**
 * Leaf status lookup with one todo read per workspace and pass. The reads go through the async
 * facade up front, so the returned probe stays synchronous for the planner.
 *
 * @param {DelegationRecord[]} delegations rows whose workspaces are probed
 * @returns {Promise<(row: DelegationRecord) => boolean>} true while the row's leaf is still open
 */
async function createOpenLeafProbe(delegations) {
  /** @type {Map<string, Map<string, string>>} */
  const statusByWorkspace = new Map();
  const workspaces = new Set();
  for (const row of delegations) {
    if (String(row?.leafId || '').trim()) workspaces.add(String(row?.workspaceFolder || '').trim());
  }
  workspaces.delete('');
  for (const workspace of workspaces) {
    /** @type {Map<string, string>} */
    const statuses = new Map();
    try {
      for (const item of (await listTodos(resolveDataPath(), workspace)).items || []) {
        statuses.set(String(item.id || ''), String(item.status || ''));
      }
    } catch {
      // Unreadable todos: treat every leaf as open so nothing is trimmed early.
      statuses.set('*', 'open');
    }
    statusByWorkspace.set(workspace, statuses);
  }
  return (row) => {
    const leafId = String(row?.leafId || '').trim();
    const workspace = String(row?.workspaceFolder || '').trim();
    if (!leafId || !workspace) return false;
    const statuses = statusByWorkspace.get(workspace);
    if (!statuses || statuses.has('*')) return true;
    // Only a leaf seen as `done` releases the early trim. A leaf missing from
    // the loaded todos (deleted, or a workspace key mismatch) waits for the
    // 30-day ceiling, like any other open leaf.
    return statuses.get(leafId) !== 'done';
  };
}

/**
 * Patch that archives one row. The verdict is persisted from the FULL report
 * first: it is usually the last line, which the cut would drop.
 *
 * @param {Record<string, any>} row
 * @param {number} now
 * @returns {Record<string, unknown>}
 */
function buildArchivePatch(row, now) {
  const report = String(row.report || '');
  const stored = String(row.reportVerdict || '').trim();
  const parsed = stored ? '' : parseDelegationVerdict(report);
  return {
    planMarkdown: '',
    sourceText: '',
    report: report.slice(0, RETENTION_REPORT_MAX),
    ...(parsed && DELEGATION_VERDICTS.includes(parsed) && parsed !== 'unspecified' ? { reportVerdict: parsed } : {}),
    archivedAt: new Date(now).toISOString(),
  };
}

/**
 * @param {Record<string, any>} row
 * @param {number} now
 * @param {number} afterMs
 * @returns {boolean}
 */
function isOlderThan(row, now, afterMs) {
  const at = Date.parse(String(row.finishedAt || row.lastTransitionAt || row.createdAt || ''));
  return Number.isFinite(at) && now - at >= afterMs;
}

/**
 * @param {Record<string, any>[]} delegations
 * @param {Map<string, Record<string, any>[]>} mailboxById
 * @param {{ now: number, retentionMs: number, trimAfterMs: number, isLeafOpen: (row: DelegationRecord) => boolean }} ctx
 * @returns {{ updates: Array<{ id: string, patch: Record<string, unknown> }>, archived: number, trimmed: number }}
 */
function planDelegationUpdates(delegations, mailboxById, ctx) {
  const updates = [];
  let archived = 0;
  let trimmed = 0;
  for (const row of delegations) {
    if (!canArchiveDelegation(row, mailboxById.get(row.id) || [])) continue;
    const attempts = Array.isArray(row.attempts) ? row.attempts : [];
    const outbox = Array.isArray(row.outbox) ? row.outbox : [];
    const nextAttempts = attempts.slice(-MAX_ATTEMPT_HISTORY);
    const nextOutbox = outbox.filter((item) => String(item.deliveredAt || '').trim()).slice(-MAX_OUTBOX_HISTORY);
    const dueAfter = ctx.isLeafOpen(row) ? ctx.retentionMs : Math.min(ctx.trimAfterMs, ctx.retentionMs);
    const shouldArchive = !String(row.archivedAt || '').trim() && isOlderThan(row, ctx.now, dueAfter);
    if (!shouldArchive && nextAttempts.length === attempts.length && nextOutbox.length === outbox.length) continue;
    const tombstoneUntil = new Date(ctx.now + DELEGATION_IDEMPOTENCY_TOMBSTONE_MS).toISOString();
    updates.push({
      id: row.id,
      patch: {
        attempts: nextAttempts,
        outbox: nextOutbox,
        ...(shouldArchive ? buildArchivePatch(row, ctx.now) : {}),
        tombstoneUntil: row.tombstoneUntil || tombstoneUntil,
      },
    });
    if (shouldArchive) archived += 1;
    else trimmed += 1;
  }
  return { updates, archived, trimmed };
}

/**
 * Delivered bodies older than the trim age, for jobs that are no longer live.
 * The replay fingerprint keeps working through the stored body hash.
 *
 * @param {Record<string, any>[]} mailboxRows
 * @param {Map<string, Record<string, any>>} delegationById
 * @param {{ now: number, trimAfterMs: number }} ctx
 * @returns {Array<{ id: string, body: string, bodyHash: string, bodyLength: number, requestHash?: string }>}
 */
function planMailboxTrims(mailboxRows, delegationById, ctx) {
  const trims = [];
  for (const row of mailboxRows) {
    if (String(row.status || '') !== 'delivered') continue;
    if (String(row.bodyTrimmedAt || '').trim()) continue;
    const at = Date.parse(String(row.deliveredAt || row.createdAt || ''));
    if (!Number.isFinite(at) || ctx.now - at < ctx.trimAfterMs) continue;
    const body = String(row.body || '');
    if (body.trim().length <= MAILBOX_BODY_PREVIEW) continue;
    const job = row.delegationId ? delegationById.get(String(row.delegationId)) : null;
    if (job && (isActiveDelegationStatus(job.status) || isDelegationSlotOccupied(job))) continue;
    const bodyHash = hashMailboxBody(body);
    const preview = `${body.trim().slice(0, MAILBOX_BODY_PREVIEW)}\n\n[Trimmed by retention: ${body.trim().length} characters. The full message is in the recipient chat history.]`;
    const trimmedRow = { ...row, body: preview, bodyHash, bodyTrimmedAt: 'pending' };
    trims.push({
      id: row.id,
      body: preview,
      bodyHash,
      bodyLength: body.trim().length,
      // The old redirect stored the full-body fingerprint here; rewrite it in
      // the digest form in the same write. Empty stays empty.
      ...(String(row.requestHash || '').trim() ? { requestHash: buildMailboxReplyFingerprint(trimmedRow) } : {}),
    });
  }
  return trims;
}

/**
 * Characters a patch removes from the fields it rewrites (dry-run estimate).
 *
 * @param {Record<string, any>} row
 * @param {Record<string, unknown>} patch
 * @returns {number}
 */
function estimateSavedChars(row, patch) {
  let saved = 0;
  for (const key of ['report', 'sourceText', 'planMarkdown', 'body', 'requestHash', 'attempts', 'outbox']) {
    if (patch[key] === undefined) continue;
    saved += JSON.stringify(row[key] ?? '').length - JSON.stringify(patch[key] ?? '').length;
  }
  return Math.max(0, saved);
}

/**
 * @param {{ now?: number, retentionMs?: number, trimAfterMs?: number, isLeafOpen?: (row: DelegationRecord) => boolean, dryRun?: boolean }} [options]
 * @returns {Promise<{ archived: number, trimmed: number, mailboxTrimmed: number, savedChars?: number }>}
 */
export async function applyDelegationRetention(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const retentionMs = Number(options.retentionMs) > 0 ? Number(options.retentionMs) : DELEGATION_RETENTION_MS;
  const trimAfterMs = Number(options.trimAfterMs) > 0 ? Number(options.trimAfterMs) : DELEGATION_TRIM_AFTER_MS;
  const mailboxRows = loadMailboxMessages();
  const delegations = /** @type {DelegationRecord[]} */ (loadDelegations());
  const isLeafOpen = typeof options.isLeafOpen === 'function' ? options.isLeafOpen : await createOpenLeafProbe(delegations);
  const planned = planDelegationUpdates(delegations, groupMailboxByDelegation(mailboxRows), {
    now, retentionMs, trimAfterMs, isLeafOpen,
  });
  const delegationById = new Map(delegations.map((/** @type {Record<string, any>} */ row) => [String(row.id), row]));
  const mailboxTrims = planMailboxTrims(mailboxRows, delegationById, { now, trimAfterMs });
  if (options.dryRun === true) {
    const mailboxById = new Map(mailboxRows.map((/** @type {Record<string, any>} */ row) => [String(row.id), row]));
    const savedChars = planned.updates.reduce((sum, u) => sum + estimateSavedChars(delegationById.get(String(u.id)) || {}, u.patch), 0)
      + mailboxTrims.reduce((sum, u) => sum + estimateSavedChars(mailboxById.get(String(u.id)) || {}, u), 0);
    return { archived: planned.archived, trimmed: planned.trimmed, mailboxTrimmed: mailboxTrims.length, savedChars };
  }
  // One write for every row: a rewrite per row re-serialized the whole store at boot.
  updateDelegationRecordsBatch(planned.updates);
  const mailboxTrimmed = trimMailboxBodiesBatch(mailboxTrims);
  const cleared = mailboxRows.filter((/** @type {Record<string, any>} */ row) => {
    if (String(row.status || '') !== 'delivered') return false;
    const at = Date.parse(String(row.deliveredAt || row.createdAt || ''));
    if (!Number.isFinite(at) || now - at < retentionMs) return false;
    // Already cleared on an earlier pass: do not rewrite the mailbox file again.
    return Boolean(String(row.extraInstructions || '').trim());
  });
  // One write for all rows, like the delegation batch above.
  const extraCleared = updateMailboxMessagesBatch(cleared.map((/** @type {Record<string, any>} */ row) => ({ id: row.id, patch: { extraInstructions: '' } })));
  return { archived: planned.archived, trimmed: planned.trimmed + extraCleared, mailboxTrimmed };
}
