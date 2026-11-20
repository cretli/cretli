/** Shared constants of the internal operator (durable state, stage 2a). */

/** pickPurpose of chats created for operator runs (rows are created in stage 2b/2c). */
export const OPERATOR_RUN_PICK_PURPOSE = 'operator_run';

/** Synthetic kind used by tests to trigger a run; has no producer. */
export const OPERATOR_TEST_KIND = 'operator_test';

/** Event kinds that may appear in operator_events. */
export const OPERATOR_EVENT_KINDS = Object.freeze([
  'restart',
  'review_failed',
  'needs_rescope',
  'needs_human',
  'blocked',
  'integration_ready',
  'watcher_stopped',
  'watcher_stop_cleared',
  OPERATOR_TEST_KIND,
]);

export const OPERATOR_QUEUE_STATES = Object.freeze(['pending', 'claimed', 'acked', 'parked']);
export const OPERATOR_QUEUE_MAX_PENDING = 200;
export const OPERATOR_COALESCE_WINDOW_MS = 60_000;
export const OPERATOR_RUN_LEASE_MS = 90_000;
/** A claimed event interrupted this many times is parked instead of requeued. */
export const OPERATOR_MAX_REQUEUES = 1;
export const OPERATOR_AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const OPERATOR_AUDIT_MAX_ROWS = 50_000;
