/**
 * HTTP/MCP mapping of typed history adapter errors (stage 2b). Callers branch on `code`,
 * never on message text; the body carries only identifiers and counters (no conversation
 * text), so it is safe to return to a browser or an MCP client.
 */
import { ChatHistoryAdapterError } from './chat-history-errors.js';
import { StorageError } from '../storage/errors.js';

/** Details that may be echoed to a client. */
const ECHOED_DETAILS = Object.freeze([
  'commitState', 'resumable', 'retryToken', 'batchId', 'committedChunks', 'committedEvents', 'totalChunks', 'acceptedSeqs',
  'headSeq', 'cause', 'conflictKind', 'cleanup', 'refusedWith', 'maxBytes', 'bytes', 'missingSeqs', 'selected', 'attempts',
]);

/** @param {string} code @param {Record<string, any>} details @returns {number} */
function statusFor(code, details) {
  if (code === 'history_invalid_chat_id') return 400;
  if (code === 'history_record_too_large' || code === 'history_batch_too_large' || code === 'history_load_too_large') return 413;
  if (code === 'history_unnamespaced_input' || code === 'history_stale_client_identity' || code === 'history_batch_mismatch'
    || code === 'history_batch_unknown' || CLIENT_IDENTITY_CONFLICTS.has(details.conflictKind)) return 409;
  if (code === 'history_rollback_read_only') return 409;
  return 503;
}

/** Store refusals that mean "this client's view of the chat is out of date or no longer allowed to write". */
const CLIENT_IDENTITY_CONFLICTS = new Set(['history_stale_epoch', 'history_producer_fenced', 'history_revision_mismatch']);

/**
 * @param {unknown} error
 * @returns {{ status: number, body: Record<string, unknown> } | null} null for an error that is not a typed history/storage refusal
 */
export function describeHistoryError(error) {
  if (error instanceof StorageError) {
    // A raw store refusal that reached the caller (the adapter does not translate definitive refusals): the public
    // message and whitelisted details only, the storage code as `code`, a stale identity as its own stable code.
    const details = /** @type {Record<string, any>} */ (error.details || {});
    const conflict = typeof details.conflictKind === 'string' ? details.conflictKind : '';
    const body = { ok: false, error: error.message, code: CLIENT_IDENTITY_CONFLICTS.has(conflict) ? 'history_stale_client_identity' : (conflict || error.code) };
    if (details.commitState !== undefined) body.commitState = details.commitState;
    if (conflict) body.conflictKind = conflict;
    const status = CLIENT_IDENTITY_CONFLICTS.has(conflict) ? 409 : (error.code === 'conflict' ? 409 : 503);
    return { status, body };
  }
  if (!(error instanceof ChatHistoryAdapterError)) return null;
  const details = /** @type {Record<string, any>} */ (error.details || {});
  const body = { ok: false, error: error.message, code: error.code };
  for (const key of ECHOED_DETAILS) {
    if (details[key] !== undefined) body[key] = details[key];
  }
  if (CLIENT_IDENTITY_CONFLICTS.has(details.conflictKind)) body.code = 'history_stale_client_identity';
  return { status: statusFor(error.code, details), body };
}

/**
 * Send the typed refusal, or `fallback` (default 500 with the message) for any other error.
 * @param {import('express').Response} res @param {unknown} error
 * @param {(error: unknown) => void} [fallback]
 */
export function sendHistoryError(res, error, fallback) {
  const described = describeHistoryError(error);
  if (described) return res.status(described.status).json(described.body);
  if (fallback) return fallback(error);
  return res.status(500).json({ ok: false, error: /** @type {any} */ (error)?.message || String(error) });
}
