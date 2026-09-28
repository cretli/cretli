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
 *
 * @param {unknown} transport
 * @returns {{ ok: true, capabilities: object } | { ok: false, status: number, code: string, error: string, capabilities: object }}
 */
export function assertReviewAdapterAllowed(transport) {
  const capabilities = resolveDelegationAdapterCapabilities(transport, { review: true });
  if (capabilities.hardReviewGuarantee) {
    return { ok: true, capabilities };
  }
  if (readDelegationReviewAllowUncertified()) {
    return { ok: true, capabilities };
  }
  return {
    ok: false,
    status: 409,
    code: 'review_uncertified',
    error: `Harness ${capabilities.transport || 'unknown'} has no pre-exec or sandbox read-only review guarantee. Event abort is not a write block. Use a certified harness, or ask the user before CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1. Do not retry as assignment=implement unless the user agrees.`,
    capabilities,
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
