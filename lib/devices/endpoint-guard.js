/**
 * Network guard for device endpoints. A device host must be loopback or a
 * private (RFC1918 / ULA) address. Link-local, cloud metadata, other special
 * ranges (including CGNAT 100.64.0.0/10) and public addresses are always refused.
 *
 * Classification is shared with the browser policy (lib/browser/url-policy.js).
 * A hostname is resolved once and the caller must connect to the returned
 * address, so there is no second lookup an attacker could re-point.
 */

import dns from 'node:dns';
import { classifyIp, isIpLiteral } from '../browser/url-policy.js';

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^[0-9A-Fa-f:]{2,45}$/;
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** @param {unknown} host */
export function isValidHostSyntax(host) {
  const value = String(host ?? '').trim();
  return value.length > 0 && value.length <= 253 && HOST_RE.test(value);
}

/** @param {unknown} port */
export function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** @param {unknown} serial */
export function isValidSerial(serial) {
  return SERIAL_RE.test(String(serial ?? ''));
}

/**
 * @param {{ host: unknown, port?: unknown, lookup?: (host: string) => Promise<string> }} input
 * @returns {Promise<{ ok: true, address: string, scope: string } | { ok: false, code: string, message: string }>}
 */
export async function checkEndpoint({ host, port, lookup = defaultLookup }) {
  const name = String(host ?? '').trim();
  if (!isValidHostSyntax(name)) return { ok: false, code: 'invalid-host', message: 'Host contains characters that are not allowed.' };
  if (port !== undefined && !isValidPort(port)) return { ok: false, code: 'invalid-port', message: 'Port must be an integer from 1 to 65535.' };
  let address = name.replace(/^\[|\]$/g, '');
  if (!isIpLiteral(address)) {
    try {
      address = String(await lookup(name) || '');
    } catch {
      return { ok: false, code: 'host-unresolved', message: 'Host name did not resolve.' };
    }
    if (!address) return { ok: false, code: 'host-unresolved', message: 'Host name did not resolve.' };
  }
  const { scope, alwaysBlocked } = classifyIp(address);
  if (alwaysBlocked || (scope !== 'loopback' && scope !== 'private')) {
    return { ok: false, code: 'endpoint-not-private', message: `Address is ${scope}; only loopback and private network addresses are allowed.` };
  }
  return { ok: true, address, scope };
}

async function defaultLookup(host) {
  const res = await dns.promises.lookup(host);
  return res.address;
}
