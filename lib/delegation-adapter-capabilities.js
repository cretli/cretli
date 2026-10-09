/**
 * Declared chat-run adapter capabilities. Live model certification is separate.
 * Event abort is not a pre-exec deny.
 */

import { getChatRunAdapterCapabilities, listChatRunAdapterTransports } from './chat-run-service.js';
import { listHarnesses } from './agent-harness/registry.js';
import { readEnvAlias } from './env-alias.js';

const DEFAULTS = Object.freeze({
  sdk: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: true,
    sandboxReadOnly: false,
  },
  opencode: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: false,
    sandboxReadOnly: false,
  },
  openrouter: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: false,
    sandboxReadOnly: false,
  },
  mistral: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: false,
    sandboxReadOnly: false,
  },
  codebuddy: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: true,
    sandboxReadOnly: false,
  },
  deepseek: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: false,
    abortOnMutation: true,
    sandboxReadOnly: true,
  },
  qwen: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: true,
    sandboxReadOnly: false,
  },
  codex: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: false,
    abortOnMutation: true,
    sandboxReadOnly: false,
  },
  claude: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: true,
    sandboxReadOnly: false,
  },
  mock: {
    canLookupRequest: true,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: true,
    abortOnMutation: false,
    sandboxReadOnly: false,
  },
});

/**
 * Per-harness delegation traits for `model_pick` and the multi-harness skill.
 *
 * `review_can_run_tests` is the **prior** (static declaration) of whether a
 * **review** child can execute the host-owned `node scripts/review-verify.js`
 * runner itself:
 *
 * - `claude` — its review run uses `permissionMode: default` and the read-only
 *   `PreToolUse` hook. `resolvePlanModeToolDecision` with `allowReviewVerify`
 *   lets the catalog runner through, so the prior is `true`.
 * - `openrouter` — its host `run_terminal_command` executor allows the catalog
 *   runner (lib/agent-harness/tool-executor.js).
 * - `opencode` / `codebuddy` / `qwen` / `codex` — native shell passes the
 *   review guard with `allowReviewVerify` (lib/sdk/sdk-plan-guard.js).
 * - `deepseek` — sandbox is read-only (`sandboxReadOnly: true`); whether the
 *   runner survives the dsh temp-dir write is unconfirmed, so the prior is
 *   `false` until observation says otherwise.
 * - `sdk` — review withholds the native `shell` tool via `disallowedTools`
 *   (`SDK_REVIEW_DISALLOWED_TOOLS`).
 *
 * The prior is overridable per harness by observation: `resolveHarnessDelegationTraits`
 * takes `{ positive, negative }` signal counts and flips the trait only when one
 * side has at least `REVIEW_TEST_OBSERVATION_MIN_SIGNALS` and a strict majority.
 * The effective trait carries `review_can_run_tests_source` (`'prior'` or
 * `'observed'`).
 *
 * `known_failure_modes` are short tags for the observed incident classes; they
 * are advisory (the skill still inspects the concrete error), never a scoring
 * penalty.
 *
 * @typedef {{
 *   review_can_run_tests: boolean,
 *   review_can_run_tests_source: 'prior' | 'observed',
 *   known_failure_modes: readonly string[],
 * }} HarnessDelegationTraits
 * @type {Readonly<Record<string, HarnessDelegationTraits>>}
 */
export const HARNESS_DELEGATION_TRAITS = Object.freeze({
  sdk: Object.freeze({ review_can_run_tests: false, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
  openrouter: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
  mistral: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
  opencode: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze(['adapter_incomplete']) }),
  codebuddy: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
  deepseek: Object.freeze({ review_can_run_tests: false, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
  codex: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze(['usage_limit']) }),
  qwen: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze(['slow_read_loop']) }),
  claude: Object.freeze({ review_can_run_tests: true, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
  mock: Object.freeze({ review_can_run_tests: false, review_can_run_tests_source: 'prior', known_failure_modes: Object.freeze([]) }),
});

/** Traits applied to a harness that has no explicit entry (conservative). */
export const DEFAULT_HARNESS_DELEGATION_TRAITS = Object.freeze({
  review_can_run_tests: false,
  review_can_run_tests_source: 'prior',
  known_failure_modes: Object.freeze([]),
});

/**
 * Minimum signals on one side before observation overrides the static prior.
 * Two independent review reports must agree before the declared trait flips.
 */
export const REVIEW_TEST_OBSERVATION_MIN_SIGNALS = 2;

/**
 * @param {unknown} observation
 * @returns {{ positive: number, negative: number }}
 */
function normalizeReviewTestObservation(observation) {
  const src = observation && typeof observation === 'object'
    ? /** @type {{ positive?: unknown, negative?: unknown }} */ (observation)
    : {};
  const positive = Number(src.positive);
  const negative = Number(src.negative);
  return {
    positive: Number.isFinite(positive) && positive > 0 ? Math.floor(positive) : 0,
    negative: Number.isFinite(negative) && negative > 0 ? Math.floor(negative) : 0,
  };
}

/**
 * Effective traits for a harness: the static prior, overridden by observation
 * when one side has at least `REVIEW_TEST_OBSERVATION_MIN_SIGNALS` signals and a
 * strict majority. A tie (or fewer signals) stays on the prior so a noisy mix
 * never silently flips the trait.
 *
 * @param {unknown} transport
 * @param {{ positive?: number, negative?: number }} [observation]
 * @returns {HarnessDelegationTraits}
 */
export function resolveHarnessDelegationTraits(transport, observation) {
  const id = String(transport || '').trim().toLowerCase();
  const base = HARNESS_DELEGATION_TRAITS[id] || DEFAULT_HARNESS_DELEGATION_TRAITS;
  const { positive, negative } = normalizeReviewTestObservation(observation);
  let reviewCanRunTests = base.review_can_run_tests === true;
  /** @type {'prior' | 'observed'} */
  let source = 'prior';
  if (positive >= REVIEW_TEST_OBSERVATION_MIN_SIGNALS && positive > negative) {
    reviewCanRunTests = true;
    source = 'observed';
  } else if (negative >= REVIEW_TEST_OBSERVATION_MIN_SIGNALS && negative > positive) {
    reviewCanRunTests = false;
    source = 'observed';
  }
  return {
    review_can_run_tests: reviewCanRunTests,
    review_can_run_tests_source: source,
    known_failure_modes: base.known_failure_modes,
  };
}

/**
 * @param {string} transport
 * @returns {typeof DEFAULTS[keyof typeof DEFAULTS]}
 */
function fallbackCaps(transport) {
  return DEFAULTS[transport] || {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    preExecDeny: false,
    abortOnMutation: false,
    sandboxReadOnly: false,
  };
}

/**
 * Hard review guarantee: mutation is refused before native exec, or the
 * sandbox is actually read-only. Event abort is not this guarantee.
 *
 * @param {{ preExecDeny?: boolean, sandboxReadOnly?: boolean }} caps
 * @returns {boolean}
 */
export function hasHardReviewGuarantee(caps) {
  return caps?.preExecDeny === true || caps?.sandboxReadOnly === true;
}

/**
 * @returns {boolean}
 */
export function readDelegationReviewAllowUncertified() {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED',
    defaultValue: '0',
  });
  return String(raw).trim() === '1';
}

/**
 * @param {string} transport
 * @param {{ review?: boolean }} [options]
 */
export function resolveDelegationAdapterCapabilities(transport, options = {}) {
  const id = String(transport || '').trim();
  const live = getChatRunAdapterCapabilities(id);
  const fallback = fallbackCaps(id);
  const review = options.review === true;
  const preExecDeny = fallback.preExecDeny === true;
  const abortOnMutation = fallback.abortOnMutation === true;
  const sandboxReadOnly = fallback.sandboxReadOnly === true;
  const hardReviewGuarantee = hasHardReviewGuarantee({ preExecDeny, sandboxReadOnly });
  return {
    transport: id,
    canLookupRequest: live.canLookupRequest || fallback.canLookupRequest,
    canCancel: live.canCancel && fallback.canCancel,
    canReconstructSession: live.canReconstructSession || fallback.canReconstructSession,
    canReadFiles: fallback.canReadFiles,
    canSearch: fallback.canSearch,
    preExecDeny,
    abortOnMutation,
    sandboxReadOnly,
    hardReviewGuarantee,
    deniesMutation: review ? hardReviewGuarantee : fallback.deniesMutation,
    reviewReadOnly: review,
    coverage: 'unit',
  };
}

/**
 * Review that requires a hard write block. Uncertified adapters are excluded
 * unless CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1 (no hard guarantee).
 * The returned `reviewUncertified` flag lets callers surface that the run only
 * happened because of the opt-in.
 *
 * @param {unknown} transport
 * @returns {{ ok: true, capabilities: object, reviewUncertified: boolean } | { ok: false, status: number, code: string, error: string, capabilities: object, reviewUncertified: true }}
 */
export function assertReviewAdapterAllowed(transport) {
  const capabilities = resolveDelegationAdapterCapabilities(transport, { review: true });
  if (capabilities.hardReviewGuarantee) {
    return { ok: true, capabilities, reviewUncertified: false };
  }
  if (readDelegationReviewAllowUncertified()) {
    return { ok: true, capabilities, reviewUncertified: true };
  }
  return {
    ok: false,
    status: 409,
    code: 'review_uncertified',
    error: `Harness ${capabilities.transport || 'unknown'} has no pre-exec or sandbox read-only review guarantee. Event abort is not a write block. Use a certified harness, or ask the user before CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1. Do not retry as assignment=implement unless the user agrees.`,
    capabilities,
    reviewUncertified: true,
  };
}

/**
 * @returns {object[]}
 */
export function listDelegationAdapterCapabilities() {
  const ids = new Set([
    ...listHarnesses().map((row) => row.transport),
    ...listChatRunAdapterTransports(),
  ]);
  return [...ids]
    .filter((id) => id && id !== 'mock')
    .sort()
    .map((id) => resolveDelegationAdapterCapabilities(id));
}
