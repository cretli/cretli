/**
 * Canonical usage event for the instance-wide cost ledger.
 * Uses Web Crypto so the same module can be imported from the browser.
 */

import { buildUsageContractFields } from './usage-contract.js';

export function createUsageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const USAGE_PROVIDERS = Object.freeze([
  'openai',
  'google',
  'azure',
  'openrouter',
  'cursor',
  'other',
]);

export const USAGE_FEATURES = Object.freeze([
  'voice-live',
  'voice-tts',
  'voice-stt',
  'chat',
  'other',
]);

/** Harnesses (runtimes) that can produce usage, separate from API providers. */
export const USAGE_HARNESSES = Object.freeze([
  'sdk',
  'claude',
  'codex',
  'deepseek',
  'qwen',
  'opencode',
  'codebuddy',
  'openrouter',
  'voice',
  'other',
]);

export const USAGE_ROLES = Object.freeze([
  'chat',
  'plan',
  'implement',
  'review',
  'fix',
]);

/** `delta` carries token deltas; `run` carries one finished run (no token sums). */
export const USAGE_EVENT_TYPES = Object.freeze(['delta', 'run']);

export const USAGE_OUTCOMES = Object.freeze(['ok', 'error', 'limit', 'aborted']);

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function shortCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.replace(/\s+/g, ' ').slice(0, 64);
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function optionalDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed);
}

/**
 * @returns {{
 *   textInput: number,
 *   textOutput: number,
 *   audioInput: number,
 *   audioOutput: number,
 *   cachedInput: number,
 *   cacheWrite: number,
 *   reasoning: number,
 * }}
 */
export function emptyUsageTokens() {
  return {
    textInput: 0,
    textOutput: 0,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

/** Upper bound for a single token counter; anything larger is treated as bogus. */
export const MAX_USAGE_TOKEN_COUNT = 1e10;

/**
 * @param {object} [partial]
 * @returns {object}
 */
export function createUsageEvent(partial = {}) {
  const tokens = emptyUsageTokens();
  const providedTokens = partial.tokens && typeof partial.tokens === 'object' ? partial.tokens : {};
  for (const key of Object.keys(tokens)) {
    const value = Number(providedTokens[key]);
    tokens[key] = Number.isFinite(value) && value > 0
      ? Math.min(value, MAX_USAGE_TOKEN_COUNT)
      : 0;
  }
  const provider = USAGE_PROVIDERS.includes(partial.provider) ? partial.provider : 'other';
  const feature = USAGE_FEATURES.includes(partial.feature) ? partial.feature : 'other';
  const harness = USAGE_HARNESSES.includes(partial.harness) ? partial.harness : undefined;
  const role = USAGE_ROLES.includes(partial.role) ? partial.role : undefined;
  const eventType = partial.eventType === 'run' ? 'run' : 'delta';
  const outcome = USAGE_OUTCOMES.includes(partial.outcome) ? partial.outcome : undefined;
  const billingMode = partial.billingMode === 'subscription' ? 'subscription' : undefined;
  const reportedUsd = Number(partial.reportedUsd);
  // Versioned contract block. It is additive: legacy readers keep working on
  // the pre-existing fields, while new readers get provenance, accounting
  // scope, identity and coverage without re-deriving them from the payload.
  const contract = buildUsageContractFields({ ...partial, tokens, harness, provider });
  return {
    id: String(partial.id || createUsageId()),
    at: String(partial.at || new Date().toISOString()),
    provider,
    feature,
    model: String(partial.model || '').trim(),
    // Child usage carries its own model; never inherit the parent's model here.
    variant: partial.variant ? String(partial.variant).trim() : undefined,
    workspaceFile: partial.workspaceFile ? String(partial.workspaceFile) : undefined,
    chatId: partial.chatId ? String(partial.chatId) : undefined,
    // Workspace Watcher cycle stamp. New orchestrator runs carry the cycle they
    // were started for so usage correlation is a safe join instead of a time
    // window; events without it (legacy or non-watcher) stay undefined.
    cycleId: partial.cycleId ? String(partial.cycleId) : undefined,
    harness,
    role,
    eventType,
    outcome,
    errorCode: shortCode(partial.errorCode),
    latencyMs: optionalDuration(partial.latencyMs),
    ttftMs: optionalDuration(partial.ttftMs),
    delegationId: shortCode(partial.delegationId),
    attemptId: shortCode(partial.attemptId),
    runId: shortCode(partial.runId),
    sourceSessionId: shortCode(partial.sourceSessionId),
    tokens,
    characters: Number.isFinite(Number(partial.characters)) ? Math.max(0, Number(partial.characters)) : 0,
    audioSeconds: Number.isFinite(Number(partial.audioSeconds)) ? Math.max(0, Number(partial.audioSeconds)) : 0,
    usd: null,
    // Actual provider-reported cost (e.g. Claude `total_cost_usd`); `priceUsage`
    // prefers it over the static rate table and marks the event non-estimated.
    reportedUsd: Number.isFinite(reportedUsd) && reportedUsd >= 0
      ? Number(reportedUsd.toFixed(6))
      : undefined,
    // Prepaid plans (e.g. a Claude subscription) have no marginal USD cost.
    billingMode,
    estimated: partial.estimated === true,
    source: partial.source === 'client' ? 'client' : 'server',
    // Contract versions must be present on the first new event. Without them a
    // later semantic change could be mistaken for an unchanged measurement.
    schemaVersion: contract.schemaVersion,
    normalizationVersion: contract.normalizationVersion,
    contractRevision: contract.contractRevision,
    usageShape: contract.usageShape,
    measurementKind: contract.measurementKind,
    granularity: contract.granularity,
    inputIncludesCache: contract.inputIncludesCache,
    reasoningRelation: contract.reasoningRelation,
    contextEpoch: contract.contextEpoch,
    provenance: contract.provenance,
    accountingScope: contract.accountingScope,
    lifecycle: contract.lifecycle,
    completeness: contract.completeness,
    // Coverage inputs are persisted so the UI can explain *why* a run is
    // partial/missing instead of re-deriving the proof from raw events.
    measurementPresent: contract.measurementPresent === true ? true : undefined,
    coverage: partial.coverage && typeof partial.coverage === 'object'
      ? { ...partial.coverage }
      : undefined,
    identityClass: contract.identityClass,
    logicalEventKey: contract.logicalEventKey,
  };
}
