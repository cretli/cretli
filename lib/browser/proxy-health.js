/**
 * Browser proxy reachability probe.
 *
 * A configured `CRETLI_BROWSER_PROXY_SERVER` URL is only a promise: the process
 * behind it may be down, firewalled or simply wrong. The `required` network
 * boundary must refuse to start a session in that case instead of launching
 * Chromium behind a dead proxy and claiming isolation. This module parses the
 * proxy URL and answers a bounded TCP reachability question; the session manager
 * owns the policy (probe vs. warn vs. never probe) and the caching.
 *
 * The transport is injectable so tests never touch the network.
 */

import net from 'node:net';

/** Default connect budget for one probe. */
export const DEFAULT_PROXY_PROBE_TIMEOUT_MS = 2000;

/** URL schemes Playwright accepts for `proxy.server`. */
const SUPPORTED_PROXY_PROTOCOLS = Object.freeze(['http:', 'https:', 'socks4:', 'socks5:']);

/** Schemes whose port may be omitted (URL default ports apply). */
const DEFAULT_PORT_BY_PROTOCOL = Object.freeze({
  'http:': 80,
  'https:': 443,
});

/**
 * @typedef {Object} ParsedProxyServer
 * @property {string} protocol URL scheme including the trailing colon, e.g. `http:`.
 * @property {string} host Hostname or IP literal without brackets.
 * @property {number} port TCP port.
 */

/**
 * @typedef {Object} ProxyProbeResult
 * @property {boolean} ok
 * @property {'proxy-ok'|'proxy-invalid'|'proxy-unreachable'} code
 * @property {string} reason Human-readable detail suitable for a status surface.
 * @property {number} latencyMs Bounded probe duration in milliseconds.
 */

/**
 * Parses a proxy URL into `{ protocol, host, port }`.
 *
 * Default ports are applied for `http` (80) and `https` (443); `socks4`/`socks5`
 * require an explicit port because the SOCKS URL convention does not define one.
 * Returns `null` for anything else so callers can fail closed.
 * @param {unknown} proxyServer
 * @returns {ParsedProxyServer|null}
 */
export function parseProxyServer(proxyServer) {
  const raw = String(proxyServer ?? '').trim();
  if (!raw) return null;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.includes(parsed.protocol)) return null;
  // `URL.hostname` keeps the brackets on IPv6 literals; TCP wants the bare
  // address, so strip them for the connect target.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  let port;
  if (parsed.port) {
    port = Number(parsed.port);
  } else if (Object.prototype.hasOwnProperty.call(DEFAULT_PORT_BY_PROTOCOL, parsed.protocol)) {
    port = DEFAULT_PORT_BY_PROTOCOL[parsed.protocol];
  } else {
    // socks4/socks5 without an explicit port.
    return null;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { protocol: parsed.protocol, host, port };
}

/**
 * True when the value is a syntactically valid URL whose host is empty (for
 * example `socks5://`). Such a value parses but can never be connected to, so
 * the probe reports it as unreachable rather than as a malformed URL.
 * @param {unknown} proxyServer
 * @returns {boolean}
 */
function hasEmptyProxyHost(proxyServer) {
  try {
    return new URL(String(proxyServer ?? '').trim()).hostname === '';
  } catch {
    return false;
  }
}

/**
 * Opens one TCP connection and settles exactly once, whether the socket
 * connects, errors or times out. The socket is always destroyed on settle.
 * @param {{ host: string, port: number, timeoutMs: number }} target
 * @returns {Promise<void>}
 */
function defaultConnect({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const settle = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle());
    socket.once('timeout', () => settle(new Error(`Timed out connecting to ${host}:${port}`)));
    socket.once('error', (error) => settle(error));
  });
}

/**
 * Probes whether the configured proxy accepts a TCP connection.
 *
 * The injected `connect` contract is intentionally tiny: it is called with
 * `{ host, port, timeoutMs }` and resolves once the connection is established or
 * rejects on failure. When no `connect` is supplied a `node:net` socket is used
 * and destroyed on settle. An outer timer bounds the whole probe even when a
 * custom `connect` never settles.
 * @param {unknown} proxyServer
 * @param {{ timeoutMs?: number, connect?: (target: { host: string, port: number, timeoutMs: number }) => Promise<void> }} [options]
 * @returns {Promise<ProxyProbeResult>}
 */
export async function probeBrowserProxy(proxyServer, options = {}) {
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.floor(requestedTimeout)
    : DEFAULT_PROXY_PROBE_TIMEOUT_MS;

  const parsed = parseProxyServer(proxyServer);
  if (!parsed) {
    if (hasEmptyProxyHost(proxyServer)) {
      return { ok: false, code: 'proxy-unreachable', reason: 'Proxy host is empty', latencyMs: 0 };
    }
    return { ok: false, code: 'proxy-invalid', reason: 'Proxy must be a valid http(s), socks4 or socks5 URL', latencyMs: 0 };
  }

  const connect = typeof options.connect === 'function' ? options.connect : defaultConnect;
  const startedAt = Date.now();
  let timer = null;
  const attempt = Promise.resolve()
    .then(() => connect({ host: parsed.host, port: parsed.port, timeoutMs }))
    .then(() => ({ connected: true }), (error) => ({ connected: false, error }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([attempt, timeout]);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (outcome?.timedOut) {
      return { ok: false, code: 'proxy-unreachable', reason: `Timed out after ${timeoutMs}ms`, latencyMs };
    }
    if (outcome?.connected) {
      return { ok: true, code: 'proxy-ok', reason: 'ok', latencyMs };
    }
    const message = outcome?.error?.message || String(outcome?.error || 'connection failed');
    return { ok: false, code: 'proxy-unreachable', reason: message, latencyMs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
