/**
 * Declared chat-run adapter capabilities. Live model certification is separate.
 */

import { getChatRunAdapterCapabilities, listChatRunAdapterTransports } from './chat-run-service.js';
import { listHarnesses } from './agent-harness/registry.js';

const DEFAULTS = Object.freeze({
  sdk: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  opencode: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  openrouter: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  codebuddy: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  deepseek: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  qwen: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  codex: {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
  mock: {
    canLookupRequest: true,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  },
});

/**
 * @param {string} transport
 * @param {{ review?: boolean }} [options]
 */
export function resolveDelegationAdapterCapabilities(transport, options = {}) {
  const id = String(transport || '').trim();
  const live = getChatRunAdapterCapabilities(id);
  const fallback = DEFAULTS[id] || {
    canLookupRequest: false,
    canCancel: true,
    canReconstructSession: false,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
  };
  const review = options.review === true;
  return {
    transport: id,
    canLookupRequest: live.canLookupRequest || fallback.canLookupRequest,
    canCancel: live.canCancel && fallback.canCancel,
    canReconstructSession: live.canReconstructSession || fallback.canReconstructSession,
    canReadFiles: fallback.canReadFiles,
    canSearch: fallback.canSearch,
    deniesMutation: review ? true : fallback.deniesMutation,
    reviewReadOnly: review,
    coverage: 'unit',
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
