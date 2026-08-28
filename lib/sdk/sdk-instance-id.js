/**
 * Stable Node instance identifier for multi-instance SDK routing.
 */

import { randomUUID } from 'node:crypto';
import { readEnvAlias } from '../env-alias.js';

let serverInstanceId = '';

/**
 * @returns {string}
 */
export function getServerInstanceId() {
  if (!serverInstanceId) {
    serverInstanceId = readEnvAlias({
      current: 'CRETLI_INSTANCE_ID',
      legacy: 'CURSOR_REMOTE_INSTANCE_ID',
    }).trim() || randomUUID();
  }
  return serverInstanceId;
}

/**
 * Resets cached id (tests only).
 */
export function resetServerInstanceIdForTests() {
  serverInstanceId = '';
}
