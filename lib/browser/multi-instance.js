/**
 * Browser sessions are process-local and cannot be migrated or recreated on
 * another Node instance. When Redis-backed multi-instance routing is enabled,
 * new Browser sessions are rejected unless the operator opts in explicitly.
 */

import { readEnvAlias } from '../env-alias.js';
import { BrowserError } from './errors.js';

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function readBrowserRedisUrl(env = process.env) {
  return readEnvAlias({
    current: 'CRETLI_REDIS_URL',
    legacy: 'CURSOR_REMOTE_REDIS_URL',
    env,
  }).trim();
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isBrowserMultiInstanceUnsupported(env = process.env) {
  const redisUrl = readBrowserRedisUrl(env);
  if (!redisUrl) return false;
  return String(env.CRETLI_BROWSER_ALLOW_MULTI_INSTANCE || '').trim() !== '1';
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
export function assertBrowserSingleInstance(env = process.env) {
  if (!isBrowserMultiInstanceUnsupported(env)) return;
  throw new BrowserError(
    'browser-multi-instance-unsupported',
    'Browser sessions are bound to a single Cretli Node process and cannot be shared or fail over across instances. '
      + 'Sticky routing only sends requests to the same instance; it does not replicate in-memory Browser state. '
      + 'Run Browser on one Node, or set CRETLI_BROWSER_ALLOW_MULTI_INSTANCE=1 to accept process-local sessions without failover.',
    503,
  );
}
