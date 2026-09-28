/**
 * Delegation runtime lifecycle: initializing / ready / degraded / shutting_down.
 * Accepting new jobs requires ready. Diagnostics stay available in every state.
 */

/** @typedef {'initializing' | 'ready' | 'degraded' | 'shutting_down'} DelegationLifecycleState */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveProjectPath } from './runtime-paths.js';

const PACKAGE_JSON_PATH = resolveProjectPath('package.json');

/**
 * @returns {string}
 */
function readPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return String(parsed?.version || '').trim();
  } catch {
    return '';
  }
}

/** @type {DelegationLifecycleState} */
let state = 'ready';
let ownerToken = randomUUID();
let startedAt = '';
let serverStartedAt = Date.now();
let lastError = /** @type {{ code: string, message: string, at: string } | null} */ (null);

/**
 * @returns {void}
 */
export function resetDelegationLifecycleForTest() {
  state = 'ready';
  ownerToken = randomUUID();
  startedAt = '';
  serverStartedAt = Date.now();
  lastError = null;
}

/**
 * @param {number} [at]
 */
export function markDelegationRuntimeProcessStart(at = Date.now()) {
  serverStartedAt = Number.isFinite(at) ? at : Date.now();
  if (!startedAt) startedAt = new Date(serverStartedAt).toISOString();
}

/**
 * @param {DelegationLifecycleState} next
 * @param {{ code?: string, message?: string }} [error]
 */
export function setDelegationLifecycleState(next, error = {}) {
  const allowed = new Set(['initializing', 'ready', 'degraded', 'shutting_down']);
  if (!allowed.has(next)) return;
  state = next;
  if (next === 'degraded') {
    lastError = {
      code: String(error.code || 'DELEGATION_RUNTIME'),
      message: String(error.message || 'Delegation runtime is degraded.'),
      at: new Date().toISOString(),
    };
    return;
  }
  if (next === 'ready') lastError = null;
}

/**
 * @returns {DelegationLifecycleState}
 */
export function getDelegationLifecycleState() {
  return state;
}

/**
 * @returns {boolean}
 */
export function isDelegationRuntimeAcceptingWork() {
  return state === 'ready';
}

/**
 * @returns {boolean}
 */
export function isDelegationRuntimeShuttingDown() {
  return state === 'shutting_down';
}

/**
 * Token bound to this process. Late adapter replies from a previous owner
 * must not confirm work reserved after restart.
 *
 * @returns {string}
 */
export function getDelegationRuntimeOwnerToken() {
  return ownerToken;
}

export function rotateDelegationRuntimeOwnerToken() {
  ownerToken = randomUUID();
  return ownerToken;
}

/**
 * @returns {{
 *   state: DelegationLifecycleState,
 *   acceptingWork: boolean,
 *   startedAt: string,
 *   serverStartedAt: number,
 *   version: string,
 *   ownerToken: string,
 *   error: { code: string, message: string, at: string } | null,
 * }}
 */
export function getDelegationLifecycleSnapshot() {
  if (!startedAt) startedAt = new Date(serverStartedAt).toISOString();
  return {
    state,
    acceptingWork: isDelegationRuntimeAcceptingWork(),
    startedAt,
    serverStartedAt,
    version: readPackageVersion(),
    ownerToken,
    error: lastError ? { ...lastError } : null,
  };
}
