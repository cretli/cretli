import net from 'node:net';
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
 * Splits a CRETLI_BIND value into unique addresses. A single address (or
 * 0.0.0.0) yields a one-element list, so existing configs behave as before.
 *
 * @param {string} [value]
 * @returns {string[]}
 */
export function parseBindHosts(value = resolveBindHost()) {
  const hosts = [];
  for (const part of String(value || '').split(',')) {
    const host = part.trim();
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.length ? hosts : [DEFAULT_BIND_HOST];
}

/** @returns {string[]} Every address the server should listen on. */
export function resolveBindHosts() {
  return parseBindHosts(resolveBindHost());
}

/**
 * @param {string} host A single address.
 * @returns {boolean}
 */
export function isLoopbackBindHost(host) {
  const normalized = String(host || '').trim();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * Addresses that need a reachability probe: configured, not loopback and not a
 * wildcard (0.0.0.0 / :: have no single address to connect to).
 *
 * @param {string[]} [hosts]
 * @returns {string[]}
 */
export function probeableLanHosts(hosts = resolveBindHosts()) {
  return hosts.filter((host) => !isLoopbackBindHost(host) && host !== '0.0.0.0' && host !== '::');
}

/**
 * True when any configured address is beyond localhost. Accepts a single
 * address or a comma-separated list.
 *
 * @param {string} [host]
 * @returns {boolean}
 */
export function isLanBindHost(host = resolveBindHost()) {
  return parseBindHosts(host).some((entry) => !isLoopbackBindHost(entry));
}

/**
 * Listen on the first address with `server.listen` and on every further one
 * with a plain TCP listener that hands each socket to the same server, so HTTP,
 * TLS and WebSocket upgrades share one handler chain. A failed extra bind is
 * reported through `onError` and the address is marked not listening.
 *
 * @param {import('node:http').Server} server
 * @param {{ hosts: string[], port: number, onListening?: () => void, onError?: (host: string, err: Error) => void }} options
 * @returns {{ states: Map<string, boolean>, close: () => void }}
 */
export function listenOnHosts(server, options) {
  const { hosts, port } = options;
  /** @type {Map<string, boolean>} */
  const states = new Map(hosts.map((host) => [host, false]));
  /** @type {import('node:net').Server[]} */
  const extras = [];
  server.listen(port, hosts[0], () => {
    states.set(hosts[0], true);
    options.onListening?.();
  });
  for (const host of hosts.slice(1)) {
    const extra = net.createServer((socket) => { server.emit('connection', socket); });
    extra.on('listening', () => states.set(host, true));
    extra.on('close', () => states.set(host, false));
    extra.on('error', (err) => {
      states.set(host, false);
      options.onError?.(host, err);
    });
    extra.listen(port, host);
    extras.push(extra);
  }
  return { states, close: () => { for (const extra of extras) extra.close(); } };
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
