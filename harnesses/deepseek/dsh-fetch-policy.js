/**
 * Address policy for DeepSeek Harness web_fetch in Cretli.
 * Public, private (RFC1918), and loopback destinations are allowed so a local
 * coding agent can open LAN/dev servers. Link-local and multicast stay blocked
 * (cloud metadata / SSRF).
 */

import { isIP } from 'node:net';

/**
 * @param {string} input
 * @returns {boolean}
 */
export function isAllowedDshFetchIp(input) {
  const address = String(input || '').trim();
  const family = isIP(address);
  if (family === 4) return isAllowedIpv4(address);
  if (family === 6) return isAllowedIpv6(address);
  return false;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isAllowedIpv4(address) {
  const parts = address.split('.').map((octet) => Number(octet));
  if (parts.length !== 4) return false;
  if (parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return false;
  if (a === 169 && b === 254) return false;
  if (a >= 224) return false;
  return true;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
function isAllowedIpv6(address) {
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::') return false;
  const mapped = mappedIpv4(lower);
  if (mapped) return isAllowedIpv4(mapped);
  const first = firstHextet(lower);
  if (first >= 0xff00) return false;
  if (first >= 0xfe80 && first <= 0xfebf) return false;
  return true;
}

/**
 * @param {string} address
 * @returns {string}
 */
function mappedIpv4(address) {
  const prefix = '::ffff:';
  if (!address.startsWith(prefix)) return '';
  const rest = address.slice(prefix.length);
  if (isIP(rest) === 4) return rest;
  return '';
}

/**
 * @param {string} address
 * @returns {number}
 */
function firstHextet(address) {
  const unscoped = address.split('%')[0];
  const head = unscoped.split('::')[0].split(':')[0];
  if (!head) return 0;
  const value = Number.parseInt(head, 16);
  return Number.isInteger(value) ? value : 0xffff;
}
