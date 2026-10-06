/**
 * Versioned policy constants for persisted model_pick decisions.
 */

/** Bump when pick semantics or candidate bounds change. */
export const MODEL_PICK_POLICY_VERSION = 'pick-policy-2026-10-06';

/** A pick proposal expires after 30 minutes if no delegation claims a slot. */
export const MODEL_PICK_TTL_MS = 30 * 60 * 1000;

/** Unclaimed pick records are retained for 30 days before purge. */
export const MODEL_PICK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum candidates stored on one pick (bounded set for audit). */
export const MODEL_PICK_MAX_CANDIDATES = 12;

/** Maximum fanout slots per pick (matches model_pick count cap). */
export const MODEL_PICK_MAX_SLOTS = 5;

/**
 * Acceptance policy for cycle metrics. When true, an `accepted-by-review`
 * cycle additionally needs a passed host verify on every review; a missing
 * verify then blocks acceptance. A verify that ran and did not pass always
 * blocks, whatever this flag says.
 */
export const MODEL_PICK_REQUIRE_VERIFY_FOR_ACCEPTANCE = false;

/** Usage events are joined over this window; older events are cut off. */
export const MODEL_PICK_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
