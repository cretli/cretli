/**
 * Versioned usage contract: adapter shapes, disjoint token buckets and the
 * coverage/provenance/identity vocabulary shared by every harness.
 *
 * This module is the single source of truth for the eight Cretli harnesses
 * (sdk, claude, codex, deepseek, qwen, opencode, codebuddy, openrouter).
 * `docs/usage-contract.md` documents the matrix; the values here are the
 * machine-readable contract and MUST stay in sync with that document.
 *
 * Scope boundary: this module only *describes* payload semantics and derives
 * canonical views. It never changes a harness normalizer on its own. Stage 2
 * (TODO bbedab87) applies the numeric fixes under the version recorded here.
 */

/** Bumped whenever the persisted event shape gains/changes a field. */
export const USAGE_SCHEMA_VERSION = 2;
/**
 * Bumped whenever normalization semantics change for an existing field.
 * Version 1 = first versioned contract (cache-write bucket and reasoning
 * relation are declared, but per-harness output is not rewritten yet).
 * Version 2 = stage 2: the stored token bag gains a first-class `cacheWrite`
 * bucket, Claude resolved camelCase is no longer re-normalized through the raw
 * snake_case resolver (cache read/write survive), and OpenRouter cache is
 * treated as included in `prompt_tokens` per the OpenAI-compatible contract.
 * The disjoint-bucket derivations in this module are unchanged.
 */
export const USAGE_NORMALIZATION_VERSION = 2;
/** Human-readable revision of the matrix/contract document. */
export const USAGE_CONTRACT_REVISION = '2026-10-06.2';

/**
 * A run that ended may still receive its final usage report (a provider may
 * flush it asynchronously). Coverage may be corrected inside this window; the
 * run *count* never changes because of a late measurement.
 */
export const USAGE_FINAL_USAGE_GRACE_MS = 24 * 60 * 60 * 1000;

export const USAGE_SHAPES = Object.freeze(['raw', 'resolved']);

export const USAGE_MEASUREMENT_KINDS = Object.freeze(['delta', 'snapshot', 'cumulative']);

export const USAGE_GRANULARITIES = Object.freeze([
  'request',
  'message',
  'turn',
  'run',
  'session',
]);

export const USAGE_REASONING_RELATIONS = Object.freeze([
  'subset_of_output',
  'separate',
  'unknown',
]);

export const USAGE_PROVENANCE = Object.freeze(['reported', 'estimated', 'unknown']);

export const USAGE_ACCOUNTING_SCOPES = Object.freeze(['own', 'consolidated']);

export const USAGE_IDENTITY_CLASSES = Object.freeze(['provider', 'durable_sequence', 'none']);

export const USAGE_LIFECYCLES = Object.freeze(['running', 'ended']);

export const USAGE_COMPLETENESS = Object.freeze(['complete', 'partial', 'missing', 'unsupported']);

/** Harnesses that must appear in the matrix (acceptance for TODO b390f96e). */
export const USAGE_MATRIX_HARNESSES = Object.freeze([
  'sdk',
  'claude',
  'codex',
  'deepseek',
  'qwen',
  'opencode',
  'codebuddy',
  'openrouter',
]);

/** Legacy providers map to a harness when no explicit harness is present. */
export const PROVIDER_HARNESS_FALLBACK = Object.freeze({
  cursor: 'sdk',
  openrouter: 'openrouter',
  openai: 'voice',
  google: 'voice',
  azure: 'voice',
});

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Frozen matrix entry factory so every harness is described with the same keys.
 *
 * - `usageShape`: shape at the adapter boundary, `raw` (snake_case/provider
 *   wire) or `resolved` (already normalized by the adapter).
 * - `measurementKind`: `delta` (counts only new work), `snapshot` (cumulative
 *   counter that must be diffed) or `cumulative` (cumulative with no reliable
 *   per-step diff).
 * - `granularity`: scope a single measurement covers.
 * - `payloadInputIncludesCache`: does the *raw payload* input counter already
 *   contain cache reads/writes?
 * - `bagInputIncludesCache`: transitional truth about the *stored* canonical
 *   bag. `true` means `tokens.textInput` still contains cache and the contract
 *   layer must subtract it while deriving buckets. Stage 2 flips these to
 *   `false` as adapters start emitting disjoint input.
 * - `reasoningRelation`: `subset_of_output` (subtract from output),
 *   `separate` (additive) or `unknown` (diagnostic only, never additive).
 * - `defaultIdentityClass`: strongest identity the harness can normally offer.
 * - `source`: file + symbol that owns the mapping.
 * - `example`: safe payload with no conversation content.
 *
 * @param {object} entry
 * @returns {object}
 */
function defineContract(entry) {
  return Object.freeze({
    supported: true,
    usageShape: 'resolved',
    measurementKind: 'delta',
    granularity: 'run',
    payloadInputIncludesCache: null,
    bagInputIncludesCache: false,
    reasoningRelation: 'unknown',
    reasoningReported: false,
    cacheRead: false,
    cacheWrite: false,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze([]),
    explicitContextEpoch: false,
    ...entry,
  });
}

/**
 * The eight-harness matrix. Values describe the *current* adapter boundary and
 * flag the transitional bag state so derived buckets stay correct today.
 */
export const USAGE_HARNESS_MATRIX = Object.freeze({
  sdk: defineContract({
    harness: 'sdk',
    usageShape: 'resolved',
    measurementKind: 'snapshot',
    granularity: 'turn',
    payloadInputIncludesCache: true,
    bagInputIncludesCache: true,
    reasoningRelation: 'subset_of_output',
    reasoningReported: true,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['runId', 'sourceSessionId', 'turnId']),
    explicitContextEpoch: true,
    source: 'lib/usage/usage-normalize.js#fromSdkUsage',
    example: Object.freeze({
      type: 'usage',
      usage: Object.freeze({
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 900,
        cacheWriteTokens: 50,
        reasoningTokens: 20,
        totalTokens: 1280,
      }),
    }),
  }),
  claude: defineContract({
    harness: 'claude',
    usageShape: 'resolved',
    measurementKind: 'snapshot',
    granularity: 'run',
    payloadInputIncludesCache: true,
    bagInputIncludesCache: false,
    reasoningRelation: 'subset_of_output',
    reasoningReported: false,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['sourceSessionId', 'requestId']),
    explicitContextEpoch: true,
    source: 'lib/agent-harness/claude-event-normalizer.js#resolveClaudeResultUsage',
    example: Object.freeze({
      usage: Object.freeze({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      }),
      total_cost_usd: 0.01,
    }),
  }),
  codex: defineContract({
    harness: 'codex',
    usageShape: 'raw',
    measurementKind: 'delta',
    granularity: 'turn',
    payloadInputIncludesCache: true,
    bagInputIncludesCache: false,
    reasoningRelation: 'subset_of_output',
    reasoningReported: true,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['threadId', 'turnId']),
    explicitContextEpoch: true,
    source: 'lib/usage/usage-normalize.js#fromCodexUsage',
    example: Object.freeze({
      input_tokens: 1000,
      cached_input_tokens: 400,
      cache_write_input_tokens: 50,
      output_tokens: 250,
      reasoning_output_tokens: 30,
    }),
  }),
  deepseek: defineContract({
    harness: 'deepseek',
    usageShape: 'resolved',
    measurementKind: 'delta',
    granularity: 'message',
    payloadInputIncludesCache: false,
    bagInputIncludesCache: false,
    reasoningRelation: 'subset_of_output',
    reasoningReported: true,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['sourceSessionId', 'messageId']),
    explicitContextEpoch: true,
    source: 'lib/usage/usage-normalize.js#fromDeepSeekUsage',
    // DSH camelCase is disjoint; a raw DeepSeek wire payload is also accepted
    // and the adapter subtracts cache hits before it reaches the bag.
    example: Object.freeze({
      inputTokens: 900,
      outputTokens: 50,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: 20,
    }),
  }),
  qwen: defineContract({
    harness: 'qwen',
    usageShape: 'raw',
    measurementKind: 'delta',
    granularity: 'run',
    payloadInputIncludesCache: true,
    bagInputIncludesCache: false,
    reasoningRelation: 'unknown',
    reasoningReported: false,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['sourceSessionId', 'requestId']),
    source: 'lib/usage/usage-normalize.js#fromQwenUsage',
    example: Object.freeze({
      input_tokens: 1000,
      output_tokens: 120,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
    }),
  }),
  opencode: defineContract({
    harness: 'opencode',
    usageShape: 'raw',
    measurementKind: 'snapshot',
    granularity: 'message',
    payloadInputIncludesCache: false,
    bagInputIncludesCache: false,
    reasoningRelation: 'separate',
    reasoningReported: true,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['sourceSessionId', 'messageId']),
    explicitContextEpoch: true,
    source: 'lib/opencode/opencode-usage.js#readOpenCodeTokenSnapshot',
    example: Object.freeze({
      input: 500,
      output: 20,
      reasoning: 5,
      cache: Object.freeze({ read: 300, write: 40 }),
    }),
  }),
  codebuddy: defineContract({
    harness: 'codebuddy',
    usageShape: 'raw',
    measurementKind: 'delta',
    granularity: 'message',
    payloadInputIncludesCache: true,
    bagInputIncludesCache: false,
    reasoningRelation: 'unknown',
    reasoningReported: false,
    cacheRead: true,
    cacheWrite: true,
    defaultIdentityClass: 'durable_sequence',
    identityFields: Object.freeze(['sourceSessionId', 'messageId']),
    source: 'lib/usage/usage-normalize.js#fromClaudeUsage (CodeBuddy raw snake_case)',
    example: Object.freeze({
      input_tokens: 400,
      output_tokens: 50,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    }),
  }),
  openrouter: defineContract({
    harness: 'openrouter',
    usageShape: 'raw',
    measurementKind: 'delta',
    granularity: 'request',
    // OpenRouter is OpenAI-compatible: `prompt_tokens` already contains
    // `prompt_tokens_details.cached_tokens` (the cached subset of the prompt),
    // verified in stage 2. The adapter subtracts it before it reaches the bag,
    // which is why the verified `bagInputIncludesCache` is false while the raw
    // payload remains inclusive.
    payloadInputIncludesCache: true,
    bagInputIncludesCache: false,
    reasoningRelation: 'unknown',
    reasoningReported: false,
    cacheRead: true,
    cacheWrite: false,
    defaultIdentityClass: 'provider',
    identityFields: Object.freeze(['providerEventId']),
    source: 'lib/usage/usage-normalize.js#fromOpenRouterUsage',
    example: Object.freeze({
      prompt_tokens: 40,
      completion_tokens: 12,
      prompt_tokens_details: Object.freeze({ cached_tokens: 0 }),
    }),
  }),
  // Not one of the eight required harnesses, but voice events share the ledger.
  voice: defineContract({
    harness: 'voice',
    usageShape: 'raw',
    measurementKind: 'delta',
    granularity: 'request',
    payloadInputIncludesCache: true,
    bagInputIncludesCache: false,
    reasoningRelation: 'separate',
    reasoningReported: false,
    cacheRead: true,
    cacheWrite: false,
    defaultIdentityClass: 'provider',
    identityFields: Object.freeze(['providerEventId']),
    source: 'lib/usage/usage-normalize.js#fromOpenAiRealtimeUsage',
    example: Object.freeze({
      input_token_details: Object.freeze({ text_tokens: 10, audio_tokens: 400, cached_tokens: 20 }),
      output_token_details: Object.freeze({ text_tokens: 5, audio_tokens: 30 }),
    }),
  }),
});

const UNKNOWN_CONTRACT = Object.freeze({
  harness: '',
  supported: false,
  usageShape: null,
  measurementKind: null,
  granularity: null,
  payloadInputIncludesCache: null,
  bagInputIncludesCache: null,
  reasoningRelation: 'unknown',
  reasoningReported: false,
  cacheRead: false,
  cacheWrite: false,
  defaultIdentityClass: 'none',
  identityFields: Object.freeze([]),
  explicitContextEpoch: false,
  source: null,
  example: null,
});

/**
 * Resolves the contract for a harness id, falling back to a provider mapping
 * when only a provider is known.
 *
 * @param {unknown} harness
 * @param {unknown} [provider]
 * @returns {object}
 */
export function resolveUsageContract(harness, provider) {
  const id = text(harness).toLowerCase();
  if (id && USAGE_HARNESS_MATRIX[id]) return USAGE_HARNESS_MATRIX[id];
  const fallback = PROVIDER_HARNESS_FALLBACK[text(provider).toLowerCase()];
  if (fallback && USAGE_HARNESS_MATRIX[fallback]) return USAGE_HARNESS_MATRIX[fallback];
  return UNKNOWN_CONTRACT;
}

/**
 * @param {unknown} value
 * @returns {object}
 */
function descriptorFrom(value) {
  if (value && typeof value === 'object' && value.harness !== undefined) return value;
  return resolveUsageContract(value);
}

/**
 * Whether the stored input counter still contains cache reads/writes.
 *
 * @param {object} contract
 * @returns {boolean}
 */
function bagInputIncludesCache(contract) {
  if (contract.bagInputIncludesCache != null) return contract.bagInputIncludesCache === true;
  return contract.payloadInputIncludesCache === true;
}

/**
 * Canonical disjoint buckets derived from the stored token bag.
 *
 * The canonical invariant is: `textInput` excludes cache, `textOutput`
 * excludes reasoning when the relation is a subset. `reasoningDiagnostic`
 * marks the reasoning counter as a non-additive diagnostic subcounter.
 *
 * @param {object} [tokens]
 * @param {object|string} [contractOrHarness]
 * @returns {{
 *   inputWithoutCache: number,
 *   cacheRead: number,
 *   cacheWrite: number,
 *   outputWithoutReasoning: number,
 *   reasoning: number,
 *   reasoningDiagnostic: boolean,
 *   audioInput: number,
 *   audioOutput: number,
 * }}
 */
export function partitionUsageTokens(tokens = {}, contractOrHarness) {
  const contract = descriptorFrom(contractOrHarness);
  const rawInput = toCount(tokens?.textInput);
  const cacheRead = Math.max(
    toCount(tokens?.cachedInput),
    toCount(tokens?.cacheRead),
    toCount(tokens?.cacheReadTokens)
  );
  const cacheWrite = Math.max(toCount(tokens?.cacheWrite), toCount(tokens?.cacheWriteTokens));
  const rawOutput = toCount(tokens?.textOutput);
  const reasoning = Math.max(toCount(tokens?.reasoning), toCount(tokens?.reasoningTokens));
  const inputWithoutCache = bagInputIncludesCache(contract)
    ? Math.max(0, rawInput - cacheRead - cacheWrite)
    : rawInput;
  let outputWithoutReasoning = rawOutput;
  let reasoningDiagnostic = false;
  if (contract.reasoningRelation === 'subset_of_output') {
    outputWithoutReasoning = Math.max(0, rawOutput - reasoning);
  } else if (contract.reasoningRelation === 'unknown') {
    reasoningDiagnostic = true;
  }
  return {
    inputWithoutCache,
    cacheRead,
    cacheWrite,
    outputWithoutReasoning,
    reasoning,
    reasoningDiagnostic,
    audioInput: toCount(tokens?.audioInput),
    audioOutput: toCount(tokens?.audioOutput),
  };
}

/**
 * Additive token total. Diagnostic reasoning is excluded unless the contract
 * says reasoning is separate from output.
 *
 * @param {ReturnType<typeof partitionUsageTokens>} buckets
 * @returns {number}
 */
export function additiveTokenTotal(buckets) {
  const reasoning = buckets?.reasoningDiagnostic ? 0 : toCount(buckets?.reasoning);
  return (
    toCount(buckets?.inputWithoutCache) +
    toCount(buckets?.cacheRead) +
    toCount(buckets?.cacheWrite) +
    toCount(buckets?.outputWithoutReasoning) +
    reasoning +
    toCount(buckets?.audioInput) +
    toCount(buckets?.audioOutput)
  );
}

/**
 * Billing derivative: every disjoint billable bucket, diagnostic reasoning
 * excluded. Distinct from `promptTokensForWindow`.
 *
 * @param {object} [tokens]
 * @param {object|string} [contractOrHarness]
 * @returns {number}
 */
export function billedTotalTokens(tokens = {}, contractOrHarness) {
  return additiveTokenTotal(partitionUsageTokens(tokens, contractOrHarness));
}

/**
 * Context-window derivative: cache still occupies the window, so it is added
 * to the uncached input. Never derived from output/reasoning/billed totals.
 *
 * Returns `null` when the harness does not report usage or the input/cache
 * relation is unknown — callers must not show a certain percentage then.
 *
 * @param {object} [tokens]
 * @param {object|string} [contractOrHarness]
 * @returns {number|null}
 */
export function promptTokensForWindow(tokens = {}, contractOrHarness) {
  const contract = descriptorFrom(contractOrHarness);
  if (contract.supported !== true) return null;
  if (contract.payloadInputIncludesCache == null && contract.bagInputIncludesCache == null) {
    return null;
  }
  const buckets = partitionUsageTokens(tokens, contract);
  return buckets.inputWithoutCache + buckets.cacheRead + buckets.cacheWrite;
}

/**
 * How a harness accounts for cache when measuring the window.
 *
 * @param {object|string} [contractOrHarness]
 * @returns {'disjoint'|'inclusive'|'unknown'}
 */
export function resolveWindowSemantics(contractOrHarness) {
  const contract = descriptorFrom(contractOrHarness);
  if (contract.supported !== true) return 'unknown';
  if (contract.bagInputIncludesCache === true || contract.payloadInputIncludesCache === true) {
    return 'inclusive';
  }
  if (contract.bagInputIncludesCache === false || contract.payloadInputIncludesCache === false) {
    return 'disjoint';
  }
  return 'unknown';
}

/**
 * Does the token bag contain any measurement at all (including reported zero)?
 *
 * @param {unknown} tokens
 * @returns {boolean}
 */
export function hasTokenMeasurement(tokens) {
  if (!tokens || typeof tokens !== 'object') return false;
  return Object.values(tokens).some((value) => Number.isFinite(Number(value)) && Number(value) >= 0)
    && Object.keys(tokens).length > 0;
}

/**
 * @param {object} [partial]
 * @returns {'reported'|'estimated'|'unknown'}
 */
export function resolveUsageProvenance(partial = {}) {
  if (USAGE_PROVENANCE.includes(partial.provenance)) return partial.provenance;
  if (partial.estimated === true) return 'estimated';
  const reportedUsd = Number(partial.reportedUsd);
  if (Number.isFinite(reportedUsd) && reportedUsd >= 0) return 'reported';
  if (partial.reported === true) return 'reported';
  if (partial.tokens && typeof partial.tokens === 'object') {
    return Object.values(partial.tokens).some((value) => Number(value) > 0)
      ? 'reported'
      : 'unknown';
  }
  return 'unknown';
}

/**
 * @param {object} [partial]
 * @returns {'own'|'consolidated'}
 */
export function resolveAccountingScope(partial = {}) {
  const scope = partial.accountingScope ?? partial.scope;
  return scope === 'consolidated' ? 'consolidated' : 'own';
}

/**
 * A run event (or an explicit `ended`) ends the lifecycle; token deltas keep
 * the run running. Lifecycle is independent from completeness.
 *
 * @param {object} [partial]
 * @returns {'running'|'ended'}
 */
export function resolveUsageLifecycle(partial = {}) {
  if (partial.lifecycle === 'ended' || partial.ended === true) return 'ended';
  if (partial.lifecycle === 'running' || partial.ended === false) return 'running';
  return partial.eventType === 'run' ? 'ended' : 'running';
}

/**
 * Coverage/lifecycle API.
 *
 * `complete` requires an ended lifecycle, a present measurement and a coverage
 * proof that every request/turn (and every child when consolidating) was
 * accounted for. A single usage event is therefore never `complete`.
 *
 * @param {{
 *   supported?: boolean,
 *   lifecycle?: 'running'|'ended',
 *   measurementPresent?: boolean,
 *   coverage?: {
 *     proof?: boolean,
 *     expectedRequests?: number,
 *     coveredRequests?: number,
 *     expectedChildren?: number,
 *     coveredChildren?: number,
 *     scope?: 'own'|'consolidated',
 *   },
 * }} [input]
 * @returns {'complete'|'partial'|'missing'|'unsupported'}
 */
export function resolveUsageCompleteness(input = {}) {
  const supported = input.supported !== false;
  if (!supported) return 'unsupported';
  const lifecycle = input.lifecycle === 'ended' ? 'ended' : 'running';
  if (lifecycle !== 'ended') return 'partial';
  if (input.measurementPresent !== true) return 'missing';
  const coverage = input.coverage && typeof input.coverage === 'object' ? input.coverage : {};
  if (coverage.proof !== true) return 'partial';
  const expected = Number(coverage.expectedRequests);
  const covered = Number(coverage.coveredRequests);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(covered) || covered < expected) {
    return 'partial';
  }
  const scope = coverage.scope === 'consolidated' ? 'consolidated' : 'own';
  if (scope === 'consolidated') {
    const expectedChildren = Number(coverage.expectedChildren);
    const coveredChildren = Number(coverage.coveredChildren);
    if (
      !Number.isFinite(expectedChildren)
      || expectedChildren < 0
      || !Number.isFinite(coveredChildren)
      || coveredChildren < expectedChildren
    ) {
      return 'partial';
    }
  }
  return 'complete';
}

/**
 * Logical event identity.
 *
 * `provider` = a provider-issued event id. `durable_sequence` = a durable
 * run/attempt/session mapping plus a *source* request/message/turn/event id.
 * `none` = nothing dedupable. A sequence ordinal assigned when an event is
 * re-received is not durable and must not be passed as `durableSequence`.
 * Token counts, timestamps and token hashes are never identity.
 *
 * @param {object} [partial]
 * @returns {{ identityClass: 'provider'|'durable_sequence'|'none', logicalEventKey: string|null }}
 */
export function buildLogicalUsageIdentity(partial = {}) {
  const measurementType = text(partial.measurementType) || text(partial.eventType) || 'usage';
  const providerEventId = text(partial.providerEventId ?? partial.providerId);
  if (providerEventId) {
    return {
      identityClass: 'provider',
      logicalEventKey: JSON.stringify(['provider', text(partial.harness), providerEventId, measurementType]),
    };
  }
  const runId = text(partial.runId);
  const attemptId = text(partial.attemptId);
  const sourceSessionId = text(partial.sourceSessionId);
  const sourceEventId = text(partial.requestId)
    || text(partial.messageId)
    || text(partial.turnId)
    || text(partial.eventId);
  const durableSequence =
    partial.durableSequence === true
    || (partial.durableSequence !== false && Boolean(sourceSessionId) && Boolean(sourceEventId));
  const hasDurableRun = Boolean(runId) || Boolean(attemptId) || Boolean(sourceSessionId);
  if (durableSequence && hasDurableRun && sourceEventId) {
    return {
      identityClass: 'durable_sequence',
      logicalEventKey: JSON.stringify([
        'durable_sequence',
        text(partial.harness),
        runId,
        attemptId,
        sourceSessionId,
        sourceEventId,
        measurementType,
      ]),
    };
  }
  return { identityClass: 'none', logicalEventKey: null };
}

/**
 * Child usage must carry its own model. Falling back to the parent model would
 * silently misattribute the child's tokens.
 *
 * @param {{ model?: unknown, parentModel?: unknown }} [partial]
 * @returns {string}
 */
export function resolveChildUsageModel(partial = {}) {
  const payloadModel = text(partial.model);
  return payloadModel || '';
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function normalizeContextEpoch(value) {
  if (value == null || value === '') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  const label = text(value);
  return label || undefined;
}

/**
 * Combined contract block attached to every new usage event.
 *
 * @param {object} [partial]
 * @returns {object}
 */
export function buildUsageContractFields(partial = {}) {
  const harness = text(partial.harness);
  const contract = resolveUsageContract(harness, partial.provider);
  const identity = buildLogicalUsageIdentity({ ...partial, harness });
  const lifecycle = resolveUsageLifecycle(partial);
  const measurementPresent =
    partial.measurementPresent === true
    || (partial.eventType === 'delta' && Object.values(partial.tokens || {}).some((v) => Number(v) > 0));
  const completeness = resolveUsageCompleteness({
    supported: contract.supported,
    lifecycle,
    measurementPresent,
    coverage: partial.coverage,
  });
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    normalizationVersion: USAGE_NORMALIZATION_VERSION,
    contractRevision: USAGE_CONTRACT_REVISION,
    usageShape: partial.usageShape ?? contract.usageShape ?? undefined,
    measurementKind: partial.measurementKind ?? contract.measurementKind ?? undefined,
    granularity: partial.granularity ?? contract.granularity ?? undefined,
    inputIncludesCache:
      partial.inputIncludesCache ?? contract.payloadInputIncludesCache ?? null,
    reasoningRelation: partial.reasoningRelation ?? contract.reasoningRelation ?? 'unknown',
    contextEpoch: normalizeContextEpoch(partial.contextEpoch),
    provenance: resolveUsageProvenance(partial),
    accountingScope: resolveAccountingScope(partial),
    lifecycle,
    completeness,
    measurementPresent,
    identityClass: identity.identityClass,
    logicalEventKey: identity.logicalEventKey,
  };
}

/**
 * Group sums by accounting scope. `own` and `consolidated` are never added
 * together; `mixed` tells the caller the entries must be shown separately.
 *
 * @param {Array<{ scope?: 'own'|'consolidated', tokens?: object, contract?: object|string }>} entries
 * @returns {{ own: object, consolidated: object, mixed: boolean }}
 */
export function aggregateAccountingScopes(entries) {
  const sum = (rows) =>
    rows.reduce(
      (acc, row) => {
        const buckets = partitionUsageTokens(row?.tokens || {}, row?.contract || row?.harness);
        for (const key of Object.keys(acc)) acc[key] += toCount(buckets[key]);
        return acc;
      },
      {
        inputWithoutCache: 0,
        cacheRead: 0,
        cacheWrite: 0,
        outputWithoutReasoning: 0,
        reasoning: 0,
        audioInput: 0,
        audioOutput: 0,
      }
    );
  const list = Array.isArray(entries) ? entries : [];
  const own = list.filter((row) => resolveAccountingScope(row) === 'own');
  const consolidated = list.filter((row) => resolveAccountingScope(row) === 'consolidated');
  return {
    own: sum(own),
    consolidated: sum(consolidated),
    mixed: own.length > 0 && consolidated.length > 0,
  };
}

/**
 * @param {{ endedAt?: unknown, now?: number }} [input]
 * @returns {boolean}
 */
export function canAwaitFinalUsage(input = {}) {
  const endedAt = new Date(String(input.endedAt || '')).getTime();
  if (!Number.isFinite(endedAt)) return true;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  return now - endedAt <= USAGE_FINAL_USAGE_GRACE_MS;
}

/**
 * A late but credible measurement may improve coverage; it never changes the
 * number of runs.
 *
 * @param {{
 *   runCount: number,
 *   previous?: { completeness?: string, coveredRequests?: number },
 *   correction?: { completeness?: string, coveredRequests?: number },
 * }} [input]
 * @returns {{ runCount: number, completeness: string, coveredRequests: number, corrected: boolean }}
 */
export function applyUsageCoverageCorrection(input = {}) {
  const runCount = Math.max(0, Number(input.runCount) || 0);
  const previous = input.previous || {};
  const correction = input.correction || {};
  const coveredRequests = Math.max(
    Number(previous.coveredRequests) || 0,
    Number(correction.coveredRequests) || 0
  );
  const rank = { unsupported: 0, missing: 1, partial: 2, complete: 3 };
  const previousCompleteness = USAGE_COMPLETENESS.includes(previous.completeness)
    ? previous.completeness
    : 'partial';
  const correctionCompleteness = USAGE_COMPLETENESS.includes(correction.completeness)
    ? correction.completeness
    : 'partial';
  const completeness =
    (rank[correctionCompleteness] || 0) > (rank[previousCompleteness] || 0)
      ? correctionCompleteness
      : previousCompleteness;
  return {
    runCount,
    completeness,
    coveredRequests,
    corrected: completeness !== previousCompleteness || coveredRequests > (Number(previous.coveredRequests) || 0),
  };
}

/**
 * Guards the "safe example payload" promise: no conversation content may leak
 * into the matrix examples.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {boolean}
 */
export function containsConversationContent(value, depth = 0) {
  if (depth > 12 || value == null) return false;
  if (typeof value === 'string') return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((row) => containsConversationContent(row, depth + 1));
  const forbidden = new Set([
    'content',
    'messages',
    'text',
    'prompt',
    'transcript',
    'history',
    'reply',
    'completion',
    'system',
  ]);
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.has(String(key).toLowerCase())) return true;
    if (containsConversationContent(nested, depth + 1)) return true;
  }
  return false;
}

/**
 * Human-readable contract summary for diagnostics/UI.
 *
 * @param {object} [event]
 * @returns {object}
 */
export function describeUsageContract(event = {}) {
  const harness = text(event.harness);
  const contract = resolveUsageContract(harness, event.provider);
  const buckets = partitionUsageTokens(event.tokens || {}, contract);
  return {
    harness: contract.harness || harness || 'unknown',
    model: text(event.model),
    variant: text(event.variant),
    schemaVersion: event.schemaVersion ?? USAGE_SCHEMA_VERSION,
    normalizationVersion: event.normalizationVersion ?? USAGE_NORMALIZATION_VERSION,
    usageShape: event.usageShape ?? contract.usageShape,
    measurementKind: event.measurementKind ?? contract.measurementKind,
    granularity: event.granularity ?? contract.granularity,
    inputIncludesCache: event.inputIncludesCache ?? contract.payloadInputIncludesCache,
    windowSemantics: resolveWindowSemantics(contract),
    reasoningRelation: event.reasoningRelation ?? contract.reasoningRelation,
    provenance: event.provenance ?? resolveUsageProvenance(event),
    accountingScope: event.accountingScope ?? resolveAccountingScope(event),
    lifecycle: event.lifecycle ?? resolveUsageLifecycle(event),
    completeness: event.completeness ?? 'partial',
    identityClass: event.identityClass ?? 'none',
    buckets,
    promptTokensForWindow: promptTokensForWindow(event.tokens || {}, contract),
    billedTotalTokens: billedTotalTokens(event.tokens || {}, contract),
  };
}
