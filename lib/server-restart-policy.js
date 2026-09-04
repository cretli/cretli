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
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @typedef {Object} ServerRestartGateResult
 * @property {boolean} allowed
 * @property {number} status
 * @property {string} [errorKey]
 */

/**
 * Decides whether POST /api/dev-actions may schedule a process restart.
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
  if (input.isRestartScheduled) {
    return { allowed: false, status: 409, errorKey: 'dev.restartInProgress' };
  }
  return { allowed: true, status: 202 };
}
