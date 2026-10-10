/**
 * Frozen fixture for the stage-9 acceptance/conformance suite.
 *
 * One cutoff anchors every scenario so the report can compare all ten
 * mandatory scenarios on the same frozen data. Nothing here reads the clock,
 * the network or the real `data/` directory.
 */

/** Single acceptance cutoff for the whole conformance suite. */
export const ACCEPTANCE_CUTOFF = '2026-10-10T12:00:00.000Z';
export const ACCEPTANCE_CUTOFF_MS = Date.parse(ACCEPTANCE_CUTOFF);
/** The cutoff's calendar day (UTC). */
export const ACCEPTANCE_DAY = '2026-10-10';
/** IANA zone used by the window/DST scenario. */
export const ACCEPTANCE_TIME_ZONE = 'Europe/Warsaw';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Frozen provider payloads used to pin the adapter boundary. Each one is the
 * exact shape the production normalizer receives, no conversation content.
 */
export const PROVIDER_PAYLOADS = Object.freeze({
  // Claude reaches the room already resolved to camelCase.
  claude: Object.freeze({
    usage: Object.freeze({
      inputTokens: 1050,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    }),
    identity: Object.freeze({ requestId: 'req-claude-1', messageId: 'msg-claude-1' }),
  }),
  // CodeBuddy stays raw snake_case at the same boundary.
  codebuddy: Object.freeze({
    usage: Object.freeze({
      input_tokens: 900,
      output_tokens: 20,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
    }),
    identity: Object.freeze({ requestId: 'req-codebuddy-1', messageId: 'msg-codebuddy-1' }),
  }),
  // OpenRouter prompt_tokens already contains cached_tokens.
  openrouter: Object.freeze({
    usage: Object.freeze({
      prompt_tokens: 1000,
      completion_tokens: 20,
      prompt_tokens_details: Object.freeze({ cached_tokens: 400 }),
    }),
    identity: Object.freeze({ providerEventId: 'or-event-1' }),
  }),
  // DeepSeek DSH shape: input and cache read are already disjoint.
  deepseek: Object.freeze({
    usage: Object.freeze({
      inputTokens: 900,
      outputTokens: 50,
      cacheReadTokens: 100,
      reasoningTokens: 20,
    }),
    identity: Object.freeze({ messageId: 'ds-message-1' }),
  }),
});

/** Expected disjoint bags for the payloads above (derived by the contract). */
export const EXPECTED_DISJOINT = Object.freeze({
  claude: Object.freeze({ textInput: 100, textOutput: 20, cachedInput: 900, cacheWrite: 50, reasoning: 0 }),
  codebuddy: Object.freeze({ textInput: 900, textOutput: 20, cachedInput: 400, cacheWrite: 50, reasoning: 0 }),
  openrouter: Object.freeze({ textInput: 600, textOutput: 20, cachedInput: 400, cacheWrite: 0, reasoning: 0 }),
  deepseek: Object.freeze({ textInput: 900, textOutput: 50, cachedInput: 100, cacheWrite: 0, reasoning: 20 }),
});

/**
 * Frozen delegation rows for the cycle/acceptance scenarios. Timestamps are
 * relative to the cutoff so the fixture has one time origin.
 */
export const DELEGATION_ROWS = Object.freeze({
  acceptedCycle: Object.freeze([
    Object.freeze({
      id: 'job-impl-ok',
      status: 'completed',
      role: 'implement',
      assignment: 'implement',
      parentChatId: 'parent-accept',
      leafId: 'leaf-accept',
      createdAt: '2026-10-10T09:00:00.000Z',
      startedAt: '2026-10-10T09:00:00.000Z',
      finishedAt: '2026-10-10T09:10:00.000Z',
      taskOutcome: 'success',
      report: 'done\n\nTASK: implement\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'job-review-a',
      status: 'completed',
      role: 'review',
      assignment: 'review',
      parentChatId: 'parent-accept',
      leafId: 'leaf-accept',
      createdAt: '2026-10-10T09:10:00.000Z',
      startedAt: '2026-10-10T09:10:00.000Z',
      finishedAt: '2026-10-10T09:15:00.000Z',
      report: 'ok\n\nVERDICT: PASS',
    }),
  ]),
  rejectedCycle: Object.freeze([
    Object.freeze({
      id: 'job-impl-bad',
      status: 'completed',
      role: 'implement',
      assignment: 'implement',
      parentChatId: 'parent-reject',
      leafId: 'leaf-reject',
      createdAt: '2026-10-10T10:00:00.000Z',
      startedAt: '2026-10-10T10:00:00.000Z',
      finishedAt: '2026-10-10T10:05:00.000Z',
      report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'job-review-b',
      status: 'completed',
      role: 'review',
      assignment: 'review',
      parentChatId: 'parent-reject',
      leafId: 'leaf-reject',
      createdAt: '2026-10-10T10:05:00.000Z',
      startedAt: '2026-10-10T10:05:00.000Z',
      finishedAt: '2026-10-10T10:08:00.000Z',
      // A real review FAIL is a quality signal, never reviewer infra.
      report: 'found a bug\n\nVERDICT: FAIL',
    }),
  ]),
});

/**
 * Injected usage events for the cycle-cost scenario. They resolve against the
 * delegation ids above; `billingClass` separates metered from unknown.
 */
export const CYCLE_USAGE_EVENTS = Object.freeze([
  Object.freeze({
    eventType: 'delta',
    delegationId: 'job-impl-ok',
    chatId: 'child-impl-ok',
    at: '2026-10-10T09:05:00.000Z',
    usd: 1.0,
    billingClass: 'api_metered',
    tokens: Object.freeze({ textInput: 100, textOutput: 10 }),
    model: 'gpt-5.6-sol',
    harness: 'codex',
  }),
  Object.freeze({
    eventType: 'delta',
    delegationId: 'job-review-a',
    chatId: 'child-review-a',
    at: '2026-10-10T09:12:00.000Z',
    usd: 0.5,
    billingClass: 'api_metered',
    tokens: Object.freeze({ textInput: 40, textOutput: 5 }),
    model: 'gpt-6.1-sol',
    harness: 'codex',
  }),
  Object.freeze({
    eventType: 'delta',
    delegationId: 'job-impl-bad',
    chatId: 'child-impl-bad',
    at: '2026-10-10T10:02:00.000Z',
    usd: 2.0,
    billingClass: 'api_metered',
    tokens: Object.freeze({ textInput: 200, textOutput: 20 }),
    model: 'gpt-5.6-sol',
    harness: 'codex',
  }),
]);

/** Offset helpers so fixture rows stay relative to the single cutoff. */
export function cutoffMinus(ms) {
  return new Date(ACCEPTANCE_CUTOFF_MS - ms).toISOString();
}

export function cutoffPlus(ms) {
  return new Date(ACCEPTANCE_CUTOFF_MS + ms).toISOString();
}

export { DAY_MS };
