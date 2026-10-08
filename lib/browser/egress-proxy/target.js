/**
 * Single choke point for egress target validation (DNS + IP + allowlist + ports).
 * Upstream sockets must connect only to the validated address (pinning).
 */

import {
  evaluateUrlPolicy,
  normalizeHostname,
  parseHttpUrl,
} from '../url-policy.js';

/**
 * @typedef {Object} TargetAllowResult
 * @property {true} allowed
 * @property {string} address Pinned IP to connect to.
 * @property {number} port
 * @property {string} hostname
 * @property {string} origin
 */

/**
 * @typedef {Object} TargetDenyResult
 * @property {false} allowed
 * @property {string} code
 * @property {string} reason
 */

/**
 * @param {'http'|'https'|'ws'|'wss'} schemeKind
 * @param {string} hostname
 * @param {number} port
 * @returns {string}
 */
function policyUrlForAuthority(schemeKind, hostname, port) {
  const hostPart = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  if (schemeKind === 'https' || schemeKind === 'wss') {
    return `https://${hostPart}:${port}`;
  }
  return `http://${hostPart}:${port}`;
}

/**
 * @param {unknown} rawUrl
 * @returns {'http'|'https'|'ws'|'wss'|null}
 */
function schemeKindFromUrl(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    try {
      const u = new URL(String(rawUrl));
      const p = u.protocol.toLowerCase();
      if (p === 'ws:' || p === 'wss:') return p === 'wss:' ? 'wss' : 'ws';
    } catch {
      return null;
    }
    return null;
  }
  if (parsed.protocol === 'https:') return 'https';
  return 'http';
}

/**
 * Validates a CONNECT authority (host + port).
 * @param {{
 *   hostname: string,
 *   port: number,
 *   tls?: boolean,
 *   policy: import('../url-policy.js').BrowserPolicy,
 *   blockedOrigins?: string[],
 *   blockedPorts?: number[],
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 * }} options
 * @returns {Promise<TargetAllowResult|TargetDenyResult>}
 */
export async function validateConnectAuthority(options) {
  const hostname = normalizeHostname(options.hostname);
  const port = Number(options.port);
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { allowed: false, code: 'invalid-authority', reason: 'Invalid CONNECT authority' };
  }
  // CONNECT always targets a TLS endpoint; policy must match https origin (not http on :8443).
  const url = policyUrlForAuthority('https', hostname, port);
  return validatePolicyUrl({
    url,
    policy: options.policy,
    blockedOrigins: options.blockedOrigins,
    blockedPorts: options.blockedPorts,
    lookup: options.lookup,
  });
}

/**
 * Validates an absolute proxy URL (http/https/ws/wss).
 * @param {{
 *   url: string,
 *   policy: import('../url-policy.js').BrowserPolicy,
 *   blockedOrigins?: string[],
 *   blockedPorts?: number[],
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 *   pinnedAddresses?: string[],
 * }} options
 * @returns {Promise<TargetAllowResult|TargetDenyResult>}
 */
export async function validatePolicyUrl(options) {
  let raw = String(options.url ?? '').trim();
  if (!raw) {
    return { allowed: false, code: 'invalid-url', reason: 'Missing URL' };
  }
  let schemeKind = schemeKindFromUrl(raw);
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
    schemeKind = raw.startsWith('wss://') ? 'wss' : 'ws';
    const parsedWs = new URL(raw);
    raw = policyUrlForAuthority(
      schemeKind,
      normalizeHostname(parsedWs.hostname),
      Number.parseInt(parsedWs.port || (schemeKind === 'wss' ? '443' : '80'), 10),
    );
  }
  const result = await evaluateUrlPolicy({
    url: raw,
    policy: options.policy,
    blockedOrigins: options.blockedOrigins,
    blockedPorts: options.blockedPorts,
    lookup: options.lookup,
    pinnedAddresses: options.pinnedAddresses,
  });
  if (!result.allowed) {
    return { allowed: false, code: result.code, reason: result.reason };
  }
  const parsed = parseHttpUrl(raw);
  if (!parsed) {
    return { allowed: false, code: 'invalid-url', reason: 'Invalid URL after policy' };
  }
  const port = Number.parseInt(parsed.port, 10);
  const ips = result.resolvedIps || [];
  const address = ips.length > 0 ? normalizeHostname(ips[0]) : normalizeHostname(parsed.hostname);
  if (!address) {
    return { allowed: false, code: 'dns-failed', reason: 'No address to connect' };
  }
  return {
    allowed: true,
    address,
    port,
    hostname: parsed.hostname,
    origin: result.origin,
  };
}

/**
 * Resolves a redirect Location against a base URL and validates the hop.
 * @param {{
 *   location: string,
 *   baseUrl: string,
 *   policy: import('../url-policy.js').BrowserPolicy,
 *   blockedOrigins?: string[],
 *   blockedPorts?: number[],
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 *   pinnedAddresses?: string[],
 * }} options
 * @returns {Promise<TargetAllowResult|TargetDenyResult>}
 */
export async function validateRedirectHop(options) {
  const location = String(options.location ?? '').trim();
  if (!location) {
    return { allowed: false, code: 'invalid-url', reason: 'Empty redirect Location' };
  }
  let resolved;
  try {
    resolved = new URL(location, options.baseUrl).href;
  } catch {
    return { allowed: false, code: 'invalid-url', reason: 'Unparseable redirect Location' };
  }
  return validatePolicyUrl({
    url: resolved,
    policy: options.policy,
    blockedOrigins: options.blockedOrigins,
    blockedPorts: options.blockedPorts,
    lookup: options.lookup,
    pinnedAddresses: options.pinnedAddresses,
  });
}
