/**
 * Typed refusals of the async chat-history adapter (stage 2a). Callers branch
 * on `code`, never on message text; `details` never carries conversation text.
 */

export const HISTORY_ADAPTER_ERROR_CODES = Object.freeze([
  'history_invalid_chat_id',
  'history_unnamespaced_input',
  'history_load_too_large',
  'history_pending_full',
  'history_pending_entry_too_large',
  'history_commit_unknown',
  'history_generation_mismatch',
  'history_backend_mismatch',
  'history_backend_marker_invalid',
  'history_backend_marker_missing',
  'history_store_missing',
  'history_store_unbound',
  'history_record_too_large',
  'history_batch_too_large',
  'history_batch_incomplete',
  'history_batch_unknown',
  'history_batch_mismatch',
  'history_pending_corrupt',
  'history_producer_counter_corrupt',
  'history_committed_readback_failed',
  'history_seq_missing',
  'history_readback_no_progress',
  'history_cleanup_uncertain',
  'history_backend_transition_refused',
  'history_rollback_read_only',
  'history_rollback_not_verified',
  'history_adapter_closed',
  'history_read_unstable',
  'history_record_unserializable',
  'history_stale_client_identity',
  'history_recovery_unresolved',
]);

export class ChatHistoryAdapterError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChatHistoryAdapterError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
export function refuseHistory(code, message, details) {
  throw new ChatHistoryAdapterError(code, message, details);
}
