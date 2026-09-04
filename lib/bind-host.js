import { readEnvAlias } from './env-alias.js';

export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Bind host from CRETLI_BIND (legacy CURSOR_REMOTE_BIND / BIND_HOST).
 * Defaults to localhost so a first `npm start` is not reachable on LAN.
 *
 * @returns {string}
 */
export function resolveBindHost() {
  const host = readEnvAlias({
    current: 'CRETLI_BIND',
    legacy: 'CURSOR_REMOTE_BIND',
    defaultValue: process.env.BIND_HOST || DEFAULT_BIND_HOST,
  }).trim();
  return host || DEFAULT_BIND_HOST;
}

/**
 * @param {string} [host]
 * @returns {boolean}
 */
export function isLanBindHost(host = resolveBindHost()) {
  const normalized = String(host || '').trim();
  return normalized !== '127.0.0.1' && normalized !== 'localhost' && normalized !== '::1';
}

/**
 * @returns {string}
 */
export function readSetupToken() {
  return readEnvAlias({
    current: 'CRETLI_SETUP_TOKEN',
    legacy: 'CURSOR_REMOTE_SETUP_TOKEN',
  }).trim();
}

/**
 * LAN bind without a password is only allowed when CRETLI_SETUP_TOKEN is set,
 * so a neighbor cannot claim first-run setup.
 *
 * @param {{ authConfigured: boolean, setupToken?: string, lanExposed?: boolean }} options
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function assertLanSetupGuard(options) {
  const lanExposed = options.lanExposed ?? isLanBindHost();
  if (!lanExposed) return { ok: true };
  if (options.authConfigured) return { ok: true };
  const setupToken = typeof options.setupToken === 'string'
    ? options.setupToken.trim()
    : readSetupToken();
  if (setupToken) return { ok: true };
  return {
    ok: false,
    message:
      'Refusing to bind beyond localhost without a password or CRETLI_SETUP_TOKEN. '
      + 'Use CRETLI_BIND=127.0.0.1, set a password via localhost first, or export CRETLI_SETUP_TOKEN.',
  };
}
