/**
 * Shared update/install operation gate.
 *
 * Single source of truth for "one self-update or install is in progress" and
 * for whether new runs may be admitted. The in-process self-updater, the dev
 * restart action, and any future apply path consult this module instead of
 * keeping private busy flags, so a restart cannot race an install and a run
 * cannot start while files are being replaced.
 *
 * The active-run count and the scheduled-restart flag are injected by the
 * process wiring (`registerDevAndUpdateRoutes`) to keep this module free of
 * store imports and trivially testable.
 */

import { randomUUID } from 'node:crypto';
import { resumePendingPromptQueues } from './agent-harness/pending-prompt-resume.js';

/**
 * @typedef {Object} UpdateGateInput
 * @property {boolean} [isRepo]
 * @property {boolean} [busy]
 * @property {number | null} [activeRuns]
 * @property {boolean} [activeRunsUnknown]
 * @property {boolean} [restartScheduled]
 * @property {boolean} [updateOperationActive]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {Object} UpdateGateResult
 * @property {boolean} allowed
 * @property {number} status
 * @property {string} [errorKey]
 * @property {string} [operationId]
 */

/** @type {{ kind: string, reason: string, startedAt: string, operationId: string } | null} */
let activeOperation = null;

/**
 * Set by the first shutdown phase. Unlike `activeOperation`, nothing clears it:
 * once the process is shutting down, no new run may be admitted until exit.
 */
let serverShuttingDown = false;

/** @type {() => number} */
let activeRunCountProvider = () => 0;

/** @type {() => boolean} */
let restartScheduledProvider = () => false;

/**
 * Install the provider that counts active runs (delegations and other
 * long-running jobs). The real provider is wired at route registration.
 *
 * @param {unknown} fn
 */
export function setActiveRunCountProvider(fn) {
  activeRunCountProvider = typeof fn === 'function' ? fn : () => 0;
}

/**
 * Install the provider for the pending server-restart flag, so the update
 * gate can refuse an update while a restart is scheduled.
 *
 * @param {unknown} fn
 */
export function setRestartScheduledProvider(fn) {
  restartScheduledProvider = typeof fn === 'function' ? fn : () => false;
}

/**
 * Live active-run count for the update gate. Returns `null` when the provider
 * fails or returns a non-finite value (fail-closed callers treat null as deny).
 *
 * @returns {number | null}
 */
export function resolveActiveRunCount() {
  try {
    const count = Number(activeRunCountProvider());
    if (!Number.isFinite(count) || count < 0) return null;
    return Math.floor(count);
  } catch {
    return null;
  }
}

/**
 * @returns {boolean}
 */
export function resolveRestartScheduled() {
  try {
    return restartScheduledProvider() === true;
  } catch {
    return false;
  }
}

/**
 * True while one self-update/install owns the update slot.
 *
 * @returns {boolean}
 */
export function isUpdateOperationActive() {
  return activeOperation !== null;
}

/**
 * @returns {{ kind: string, reason: string, startedAt: string, operationId: string } | null}
 */
export function getUpdateOperation() {
  return activeOperation ? { ...activeOperation } : null;
}

/**
 * New runs must not start while an update/install replaces files or while the
 * process is shutting down.
 *
 * @returns {boolean}
 */
export function canAcceptNewRun() {
  return activeOperation === null && !serverShuttingDown;
}

/**
 * First shutdown phase: refuse every new run from this moment on. Synchronous
 * and idempotent, so it can be called without `await` at the top of the
 * shutdown handler and from every fatal path that terminates the process.
 *
 * @returns {void}
 */
export function beginServerShutdown() {
  serverShuttingDown = true;
}

/**
 * @returns {boolean}
 */
export function isServerShuttingDown() {
  return serverShuttingDown;
}

/**
 * @returns {Error}
 */
export function createUpdateInProgressError() {
  const error = new Error('An update or install is in progress. New runs are not accepted until it finishes.');
  error.code = 'update_in_progress';
  return error;
}

/**
 * @returns {Error}
 */
export function createServerShuttingDownError() {
  const error = new Error('The server is shutting down. New runs are not accepted.');
  error.code = 'server_shutting_down';
  return error;
}

/**
 * @throws {Error & { code: string }}
 */
export function assertCanAcceptNewRun() {
  if (serverShuttingDown) throw createServerShuttingDownError();
  if (!canAcceptNewRun()) {
    throw createUpdateInProgressError();
  }
}

/**
 * Shared decision for self-update, install and future apply paths.
 *
 * Order matches the historical self-update semantics: a non-git install is a
 * plain 400, an in-flight update is 409, then active runs and a scheduled
 * restart are 409.
 *
 * @param {UpdateGateInput} input
 * @returns {UpdateGateResult}
 */
export function resolveUpdateGate(input) {
  if (!input?.isRepo) {
    return { allowed: false, status: 400, errorKey: 'update.noRepo' };
  }
  if (input.busy || input.updateOperationActive) {
    return { allowed: false, status: 409, errorKey: 'update.busy' };
  }
  const activeRuns = input.activeRuns;
  if (
    input.activeRunsUnknown === true
    || activeRuns === null
    || activeRuns === undefined
    || (typeof activeRuns === 'number' && !Number.isFinite(activeRuns))
  ) {
    return { allowed: false, status: 409, errorKey: 'update.activeRunsUnknown' };
  }
  if (Number(activeRuns) > 0) {
    return { allowed: false, status: 409, errorKey: 'update.activeRuns' };
  }
  if (input.restartScheduled) {
    return { allowed: false, status: 409, errorKey: 'update.restartInProgress' };
  }
  return { allowed: true, status: 202 };
}

/**
 * Atomically claim the update slot after re-reading active runs and the
 * restart flag. Returns 409 `update.busy` when another operation owns it.
 *
 * @param {{ kind?: string, reason?: string, env?: NodeJS.ProcessEnv }} [input]
 * @returns {UpdateGateResult}
 */
export function beginUpdateOperation({ kind = 'update', reason = '', env } = {}) {
  if (activeOperation) {
    return { allowed: false, status: 409, errorKey: 'update.busy' };
  }
  const activeRuns = resolveActiveRunCount();
  const gate = resolveUpdateGate({
    isRepo: true,
    busy: false,
    activeRuns,
    activeRunsUnknown: activeRuns === null,
    restartScheduled: resolveRestartScheduled(),
    updateOperationActive: false,
    env,
  });
  if (!gate.allowed) return gate;
  const operationId = randomUUID();
  activeOperation = {
    kind: String(kind || 'update'),
    reason: String(reason || ''),
    startedAt: new Date().toISOString(),
    operationId,
  };
  return { allowed: true, status: 202, operationId };
}

/**
 * Release the update slot after the child process settles. When `operationId`
 * is passed, the slot is cleared only when it matches the active operation.
 *
 * @param {string} [operationId]
 */
export function endUpdateOperation(operationId) {
  if (!activeOperation) return;
  if (operationId != null && String(operationId) !== activeOperation.operationId) return;
  activeOperation = null;
  setImmediate(() => {
    resumePendingPromptQueues();
  });
}

/**
 * Test helper: clear in-memory state and restore the default providers.
 */
export function resetUpdateGateForTest() {
  activeOperation = null;
  serverShuttingDown = false;
  activeRunCountProvider = () => 0;
  restartScheduledProvider = () => false;
}
