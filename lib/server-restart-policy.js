import { isUpdateOperationActive } from './update-gate.js';

export const SERVER_RESTART_ACTION = 'restart-server';

/**
 * In-process restart helper is for local `npm start` only.
 * Production/container users should restart the process or container.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function canRestartServer(env = process.env) {
  return env.NODE_ENV !== 'production';
}

/**
 * @typedef {Object} ServerRestartGateInput
 * @property {unknown} action
 * @property {boolean} [isRestartScheduled]
 * @property {number} [activeDelegations]
 * @property {boolean} [activeDelegationsUnknown]
 * @property {boolean} [force]
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {Object} ServerRestartGateResult
 * @property {boolean} allowed
 * @property {number} status
 * @property {string} [errorKey]
 * @property {number} [activeDelegations]
 * @property {boolean} [canForce]
 */

/**
 * Decides whether POST /api/dev-actions may schedule a process restart.
 *
 * A restart SIGTERMs every harness child from the first shutdown phase, so a
 * restart under active delegations would end them as `interrupted`. The gate
 * refuses that by default (409, `dev.restartActiveDelegations`); an explicit
 * `force: true` overrides it — the shutdown flush then records every active
 * job as `interrupted` / `server_restart`, which is retryable exactly once.
 *
 * @param {ServerRestartGateInput} input
 * @returns {ServerRestartGateResult}
 */
export function resolveServerRestartGate(input) {
  const action = input?.action;
  if (action !== SERVER_RESTART_ACTION) {
    return { allowed: false, status: 400, errorKey: 'generic.invalidAction' };
  }
  if (!canRestartServer(input.env || process.env)) {
    return { allowed: false, status: 403, errorKey: 'dev.restartDisabled' };
  }
  // Mutual exclusion with the shared update/install slot: restarting while an
  // install owns the files would kill the update mid-flight.
  if (isUpdateOperationActive()) {
    return { allowed: false, status: 409, errorKey: 'dev.restartInProgress' };
  }
  if (input.isRestartScheduled) {
    return { allowed: false, status: 409, errorKey: 'dev.restartInProgress' };
  }
  // Fail closed: a store read failure must not let a restart through under
  // possibly-live delegations (same rule as the update gate's unknown count).
  if (input.activeDelegationsUnknown === true) {
    return { allowed: false, status: 409, errorKey: 'dev.restartActiveDelegationsUnknown' };
  }
  const activeDelegations = Math.max(0, Math.floor(Number(input.activeDelegations) || 0));
  if (activeDelegations > 0 && input.force !== true) {
    return {
      allowed: false,
      status: 409,
      errorKey: 'dev.restartActiveDelegations',
      activeDelegations,
      canForce: true,
    };
  }
  return { allowed: true, status: 202, activeDelegations };
}
