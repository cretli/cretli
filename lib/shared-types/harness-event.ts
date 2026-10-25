/**
 * Normalized event emitted by an agent harness into a room (see
 * lib/agent-harness/*). Types only: erasable syntax, no runtime code. The event
 * set is open (plugins add their own `type` values), so the base shape is a
 * discriminant plus an index signature and the known events are narrowings.
 */

export type HarnessEvent = {
  type: string;
  [key: string]: unknown;
};

/** Token usage delta recorded into the usage ledger. */
export type HarnessUsageEvent = HarnessEvent & {
  type: 'usage';
  usage?: Record<string, unknown>;
};

/** Context-window sample recorded by lib/usage/harness-context-telemetry. */
export type HarnessContextUsageEvent = HarnessEvent & {
  type: 'context_usage';
};
