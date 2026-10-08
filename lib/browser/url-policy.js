/**
 * Browser URL / SSRF policy.
 *
 * A single policy evaluated for every main-frame navigation *and* every
 * subresource/redirect request by the session manager. Default-deny: an origin
 * must be present in the per-workspace allowlist. Link-local and cloud metadata
 * addresses are always rejected, while loopback and RFC1918/ULA are separate
 * opt-ins (`allowLocalhost` vs `allowPrivateNetwork`); a public hostname that
 * resolves to a loopback/private address is rejected as DNS rebinding. Cretli's
 * own origin(s) are always rejected (`selfOrigins`), even when allowlisted.
 *
 * DNS pinning is *not* a Playwright API: Chromium always resolves a hostname
 * inside its own network stack, so Node's check and Chromium's connection are
 * two separate resolutions. `buildHostResolverRules` maps allowlisted hostnames
 * to the IPv4 addresses validated here and appends a catch-all `MAP * ~NOTFOUND`
 * rule. On current Chromium that catch-all also blocks IP-literal connects, so
 * the resolver deny is stricter than hostname-only documentation once implied;
 * it is still defense in depth, not a hard IP guarantee. A configured upstream
 * proxy and page-initiated WebSockets on non-allowlisted ports (after a hostname
 * pin) stay outside `context.route()`. TCP/TURN WebRTC relays are a separate
 * residual (see SECURITY.md). The route-level policy (which re-checks every
 * redirect hop) is the enforced boundary.
 */

import dns from 'dns';

/** Schemes that are never allowed as a Browser target. */
export const BLOCKED_SCHEMES = Object.freeze([
  'file:',
  'data:',
  'javascript:',
  'chrome:',
  'devtools:',
  'blob:',
  'about:',
  'view-source:',
  'ftp:',
  'ws:',
  'wss:',
]);

const BLOCKED_SCHEME_SET = new Set(BLOCKED_SCHEMES);

/**
 * Cloud metadata / platform endpoints that must never be reachable, even when a
 * workspace allowlists the origin or opts into private networks.
 */
export const ALWAYS_BLOCKED_ADDRESSES = Object.freeze(new Set([
  '168.63.129.16', // Azure platform virtual IP (wire server / IMDS)
  '100.100.100.200', // Alibaba Cloud metadata
  '169.254.170.2', // AWS ECS/Fargate task metadata (also link-local, kept explicit)
  '169.254.169.254', // AWS/GCP/Azure IMDS (also link-local, kept explicit)
  'fd00:ec2::254', // AWS IMDS over IPv6 (ULA, so it needs an explicit block)
  'fd00:ec2::23', // AWS EKS Pod Identity over IPv6
]));

/**
 * Chromium `--host-resolver-rules` catch-all: any hostname without an explicit
 * `MAP` entry fails with ERR_NAME_NOT_RESOLVED instead of being resolved by
 * Chromium. This is the default-deny half of the DNS defense in depth.
 */
export const HOST_RESOLVER_DENY_RULE = 'MAP * ~NOTFOUND';


/**
 * Userinfo (`user:pass@`) is a credential leak vector; the URL is rejected
 * instead of silently stripped so a misconfigured policy cannot be bypassed.
 * @param {URL} parsed
 * @returns {boolean}
 */
function hasUserInfo(parsed) {
  return Boolean(parsed.username || parsed.password);
}

/**
 * Normalizes a hostname: lowercases, strips IPv6 brackets, a zone id and a
 * single trailing dot (`localhost.` and `example.com.` are the same host).
 * @param {unknown} hostname
 * @returns {string}
 */
export function normalizeHostname(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  host = host.replace(/^\[|\]$/g, '');
  const zoneIndex = host.indexOf('%');
  if (zoneIndex !== -1) host = host.slice(0, zoneIndex);
  if (host.length > 1 && host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (hasUserInfo(parsed)) return '';
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @param {unknown} rawUrl
 * @returns {{ origin: string, hostname: string, protocol: string, port: string, href: string, hasUserInfo: boolean } | null}
 */
export function parseHttpUrl(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  const hostname = normalizeHostname(parsed.hostname);
  const port = parsed.port || (protocol === 'https:' ? '443' : '80');
  return {
    origin: `${protocol}//${parsed.host}`.toLowerCase(),
    hostname,
    protocol,
    port,
    href: parsed.href,
    hasUserInfo: hasUserInfo(parsed),
  };
}

/**
 * Normalizes a caller-typed navigation target into the one absolute string that
 * both the policy check and `page.goto` must use. A bare host (`example.com`,
 * `127.0.0.1:3011/path`) gets the same implicit `https://` scheme that
 * `normalizeOrigin` already assumes for the allowlist; without it the policy
 * would judge `https://example.com` while Chromium was handed a scheme-less
 * `example.com`, which `goto` rejects outright.
 *
 * Anything that already carries a `scheme://` is passed through so the policy
 * keeps answering with its precise code (`blocked-scheme` for `file://…`), and a
 * target that cannot be parsed at all is returned as written for the policy to
 * reject rather than silently rewritten.
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function normalizeNavigationUrl(rawUrl) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return '';
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  const parsed = parseHttpUrl(candidate);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return candidate;
  return parsed.href;
}

/**
 * True for loopback only (`localhost`, `*.localhost`, 127.0.0.0/8, ::1).
 * Kept separate from RFC1918/ULA so `allowLocalhost` cannot silently open a
 * private network.
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return classifyIp(host).scope === 'loopback';
}

/**
 * True for RFC1918 / CGNAT / ULA private addresses (never loopback).
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isPrivateHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  return classifyIp(host).scope === 'private';
}

/**
 * True for loopback or private addresses (legacy helper).
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isLocalHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const kind = classifyIp(host);
  return kind.scope === 'loopback' || kind.scope === 'private';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIpLiteral(value) {
  const host = normalizeHostname(value);
  if (!host) return false;
  return isIpv4(host) || host.includes(':');
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isIpv4(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * @param {string} ip
 * @returns {number|null}
 */
function ipv4ToInt(ip) {
  if (!isIpv4(ip)) return null;
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

/**
 * @param {number} value
 * @returns {string}
 */
function ipv4FromInt(value) {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

/**
 * @param {number} value
 * @param {number} base
 * @param {number} bits
 * @returns {boolean}
 */
function inIpv4Range(value, base, bits) {
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return (value & mask) === (base & mask);
}

/**
 * Expands an IPv6 literal (including `::` and an embedded dotted-quad) into
 * eight 16-bit groups. Returns null for anything that is not a valid literal.
 * @param {string} raw
 * @returns {number[]|null}
 */
function expandIpv6(raw) {
  let ip = String(raw || '').toLowerCase();
  if (!ip.includes(':')) return null;
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = ip.slice(lastColon + 1);
    if (!isIpv4(v4)) return null;
    const n = ipv4ToInt(v4);
    ip = `${ip.slice(0, lastColon)}:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((part) => part !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((part) => part !== '') : [];
  let groups;
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

/**
 * @param {number} value
 * @returns {{ scope: 'loopback'|'private'|'link-local'|'special'|'public', alwaysBlocked: boolean }}
 */
function classifyIpv4Int(value) {
  if (inIpv4Range(value, ipv4ToInt('127.0.0.0'), 8)) return { scope: 'loopback', alwaysBlocked: false };
  if (value === ipv4ToInt('0.0.0.0')) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('169.254.0.0'), 16)) return { scope: 'link-local', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('10.0.0.0'), 8)) return { scope: 'private', alwaysBlocked: false };
  if (inIpv4Range(value, ipv4ToInt('172.16.0.0'), 12)) return { scope: 'private', alwaysBlocked: false };
  if (inIpv4Range(value, ipv4ToInt('192.168.0.0'), 16)) return { scope: 'private', alwaysBlocked: false };
  if (inIpv4Range(value, ipv4ToInt('100.64.0.0'), 10)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('192.0.0.0'), 24)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('192.0.2.0'), 24)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('198.18.0.0'), 15)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('198.51.100.0'), 24)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('203.0.113.0'), 24)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('224.0.0.0'), 4)) return { scope: 'special', alwaysBlocked: true };
  if (inIpv4Range(value, ipv4ToInt('240.0.0.0'), 4)) return { scope: 'special', alwaysBlocked: true };
  return { scope: 'public', alwaysBlocked: false };
}

/**
 * Classifies an IP address into a scope used by the policy.
 * - "link-local"/"special": always blocked (includes cloud metadata).
 * - "loopback"/"private": only reachable through an explicit allowlist entry.
 * - "public": allowed when the origin is allowlisted.
 *
 * IPv4-mapped/compatible IPv6 addresses are judged as the embedded IPv4
 * address, including the hex form Chromium normalizes them to
 * (e.g. `::ffff:a9fe:a9fe` === 169.254.169.254). NAT64 (`64:ff9b::/96`),
 * 6to4 (`2002::/16`) and Teredo (`2001::/32`) are decoded the same way so a
 * metadata address cannot be smuggled in through a transition prefix.
 * @param {unknown} rawIp
 * @returns {{ scope: 'loopback'|'private'|'link-local'|'special'|'public', alwaysBlocked: boolean }}
 */
export function classifyIp(rawIp) {
  const ip = normalizeHostname(rawIp);
  if (!ip) return { scope: 'special', alwaysBlocked: true };
  if (ALWAYS_BLOCKED_ADDRESSES.has(ip)) return { scope: 'special', alwaysBlocked: true };

  if (isIpv4(ip)) {
    const value = ipv4ToInt(ip);
    if (value == null) return { scope: 'special', alwaysBlocked: true };
    return classifyIpv4Int(value);
  }

  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (!groups) return { scope: 'special', alwaysBlocked: true };
    if (groups.every((group) => group === 0)) return { scope: 'special', alwaysBlocked: true };
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
      return { scope: 'loopback', alwaysBlocked: false };
    }
    // ::ffff:0:0/96 (mapped) and ::/96 (deprecated compatible) embed an IPv4.
    const mapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0
      && groups[3] === 0 && groups[4] === 0 && (groups[5] === 0xffff || groups[5] === 0);
    if (mapped) {
      const value = (((groups[6] << 16) | groups[7]) >>> 0);
      const embedded = ipv4FromInt(value);
      if (ALWAYS_BLOCKED_ADDRESSES.has(embedded)) return { scope: 'special', alwaysBlocked: true };
      if (value !== 0) return classifyIpv4Int(value);
    }
    // 6to4 (2002::/16) embeds the destination IPv4 in groups 1-2.
    if (groups[0] === 0x2002) {
      const value = (((groups[1] << 16) | groups[2]) >>> 0);
      const kind = classifyIpv4Int(value);
      if (kind.alwaysBlocked || kind.scope === 'loopback' || kind.scope === 'private') {
        return { scope: 'special', alwaysBlocked: true };
      }
      return kind;
    }
    // NAT64 well-known prefix (64:ff9b::/96) embeds the IPv4 in groups 6-7.
    if (groups[0] === 0x0064 && groups[1] === 0xff9b
      && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      const value = (((groups[6] << 16) | groups[7]) >>> 0);
      const kind = classifyIpv4Int(value);
      if (kind.alwaysBlocked || kind.scope === 'loopback' || kind.scope === 'private') {
        return { scope: 'special', alwaysBlocked: true };
      }
      return kind;
    }
    // NAT64 local-use (64:ff9b:1::/48) and Teredo (2001::/32) can embed an
    // arbitrary IPv4; block them wholesale rather than reason about the tunnel.
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
      return { scope: 'special', alwaysBlocked: true };
    }
    if (groups[0] === 0x2001 && groups[1] === 0x0000) {
      return { scope: 'special', alwaysBlocked: true };
    }
    if ((groups[0] & 0xfe00) === 0xfc00) return { scope: 'private', alwaysBlocked: false }; // fc00::/7 ULA
    if ((groups[0] & 0xffc0) === 0xfe80) return { scope: 'link-local', alwaysBlocked: true }; // fe80::/10
    if ((groups[0] & 0xffc0) === 0xfec0) return { scope: 'special', alwaysBlocked: true }; // fec0::/10 site-local
    if ((groups[0] & 0xff00) === 0xff00) return { scope: 'special', alwaysBlocked: true }; // ff00::/8 multicast
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return { scope: 'special', alwaysBlocked: true }; // doc
    return { scope: 'public', alwaysBlocked: false };
  }

  return { scope: 'special', alwaysBlocked: true };
}

/**
 * @typedef {Object} BrowserPolicy
 * @property {string[]} allowedOrigins Exact `protocol//host` entries.
 * @property {number[]} blockedPorts Ports always blocked unless in unblockedPorts.
 * @property {number[]} unblockedPorts Explicit workspace opt-in for internal ports.
 * @property {boolean} allowLocalhost Convenience opt-in for loopback origins.
 * @property {boolean} allowPrivateNetwork Convenience opt-in for RFC1918/ULA origins.
 * @property {boolean} allowSelfOrigin Explicit debug opt-in for Cretli's own origin.
 * @property {boolean} allowInsecureTls Explicit debug opt-in for invalid HTTPS certificates.
 */

/**
 * Normalizes an untrusted policy object into a safe shape.
 * @param {unknown} input
 * @returns {BrowserPolicy}
 */
export function normalizePolicy(input) {
  const raw = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  const origins = Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins : [];
  const allowedOrigins = [];
  for (const entry of origins.slice(0, 100)) {
    const origin = normalizeOrigin(entry);
    if (origin && !allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }
  const toPorts = (value) => {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const entry of list.slice(0, 100)) {
      const port = Number.parseInt(String(entry), 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && !out.includes(port)) out.push(port);
    }
    return out;
  };
  return {
    allowedOrigins,
    blockedPorts: toPorts(raw.blockedPorts),
    unblockedPorts: toPorts(raw.unblockedPorts),
    allowLocalhost: raw.allowLocalhost === true,
    allowPrivateNetwork: raw.allowPrivateNetwork === true,
    allowSelfOrigin: raw.allowSelfOrigin === true,
    allowInsecureTls: raw.allowInsecureTls === true,
  };
}

/**
 * @typedef {Object} UrlPolicyResult
 * @property {boolean} allowed
 * @property {string} code Machine-readable decision code.
 * @property {string} reason Human-readable reason.
 * @property {string} origin
 * @property {string} hostname
 * @property {string[]} resolvedIps
 */

/**
 * @param {string} code
 * @param {string} reason
 * @param {{ origin?: string, hostname?: string, resolvedIps?: string[] }} [info]
 * @returns {UrlPolicyResult}
 */
function deny(code, reason, info = {}) {
  return {
    allowed: false,
    code,
    reason,
    origin: info.origin || '',
    hostname: info.hostname || '',
    resolvedIps: info.resolvedIps || [],
  };
}

/**
 * @param {string} hostname
 * @param {number} port
 * @param {BrowserPolicy} policy
 * @returns {boolean}
 */
function isPortBlocked(port, policy) {
  if (policy.blockedPorts.includes(port)) return true;
  return false;
}

/**
 * Evaluates the URL policy. `lookup` is injectable for tests (defaults to dns.promises.lookup).
 * @param {{
 *   url: unknown,
 *   policy?: unknown,
 *   blockedPorts?: number[],
 *   blockedOrigins?: string[],
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 *   pinnedAddresses?: string[],
 * }} options
 * @returns {Promise<UrlPolicyResult>}
 */
export async function evaluateUrlPolicy(options) {
  const policy = normalizePolicy(options?.policy);
  const parsed = parseHttpUrl(options?.url);
  if (!parsed) return deny('invalid-url', 'Invalid or unsupported URL');
  const { origin, hostname, protocol, port, href } = parsed;

  if (BLOCKED_SCHEME_SET.has(protocol)) {
    return deny('blocked-scheme', `Scheme ${protocol} is not allowed`, { origin, hostname });
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return deny('blocked-scheme', `Scheme ${protocol} is not allowed`, { origin, hostname });
  }
  if (parsed.hasUserInfo) {
    // Never let embedded credentials reach the browser or a log line.
    return deny('userinfo-not-allowed', 'URLs with userinfo (user:pass@) are not allowed', { origin, hostname });
  }

  // Cretli's own origin(s) are always denied, even when allowlisted, so the
  // Browser cannot be used as a control-plane SSRF proxy (including behind a
  // TLS-terminating reverse proxy whose origin is configured explicitly).
  const blockedOrigins = Array.isArray(options?.blockedOrigins)
    ? options.blockedOrigins.map((entry) => normalizeOrigin(entry)).filter(Boolean)
    : [];
  const selfOrigin = blockedOrigins.includes(origin);
  if (selfOrigin && !policy.allowSelfOrigin) {
    return deny('self-origin', 'Cretli\'s own origin is never reachable from Browser', { origin, hostname });
  }

  const allowlisted = policy.allowedOrigins.includes(origin);
  const loopbackHost = isLoopbackHostname(hostname);
  const privateHost = isPrivateHostname(hostname);
  if (!allowlisted) {
    if (selfOrigin && policy.allowSelfOrigin) {
      // Explicit debug opt-in also covers Cretli's reserved port.
    } else if (loopbackHost && policy.allowLocalhost) {
      // Explicit workspace opt-in for loopback only (never RFC1918).
    } else if (privateHost && policy.allowPrivateNetwork) {
      // Explicit workspace opt-in for RFC1918/ULA literals only.
    } else {
      return deny('origin-not-allowed', 'Origin is not on the workspace allowlist', { origin, hostname });
    }
  }

  const portNumber = Number.parseInt(port, 10);
  const extraBlocked = Array.isArray(options?.blockedPorts) ? options.blockedPorts : [];
  const isInternal = extraBlocked.includes(portNumber) || isPortBlocked(portNumber, policy);
  if (isInternal && !selfOrigin && !policy.unblockedPorts.includes(portNumber)) {
    return deny('blocked-port', `Port ${portNumber} is reserved for an internal service`, { origin, hostname });
  }

  let addresses = [];
  if (isIpLiteral(hostname)) {
    addresses = [normalizeHostname(hostname)];
  } else {
    const lookup = typeof options?.lookup === 'function' ? options.lookup : defaultLookup;
    try {
      const records = await lookup(hostname, { all: true, verbatim: true });
      addresses = (Array.isArray(records) ? records : [])
        .map((record) => (typeof record === 'string' ? record : record?.address))
        .filter((address) => typeof address === 'string' && address);
    } catch {
      return deny('dns-failed', `Could not resolve ${hostname}`, { origin, hostname });
    }
    if (addresses.length === 0) {
      return deny('dns-failed', `Could not resolve ${hostname}`, { origin, hostname });
    }
  }

  const pinned = Array.isArray(options?.pinnedAddresses)
    ? options.pinnedAddresses.map((address) => normalizeHostname(address)).filter(Boolean)
    : [];

  for (const address of addresses) {
    const kind = classifyIp(address);
    if (kind.alwaysBlocked) {
      return deny('blocked-address', `Address ${address} is never allowed`, { origin, hostname, resolvedIps: addresses });
    }
    if (kind.scope === 'loopback' || kind.scope === 'private') {
      // A name that is not itself a loopback/private literal or a `.localhost`
      // name must never resolve into the local network, even when the origin is
      // allowlisted: that is DNS rebinding.
      if (!loopbackHost && !privateHost) {
        return deny('dns-rebinding', `${hostname} resolves to the local address ${address}`, {
          origin,
          hostname,
          resolvedIps: addresses,
        });
      }
      const localOptIn = allowlisted
        || (kind.scope === 'loopback' && policy.allowLocalhost)
        || (kind.scope === 'private' && policy.allowPrivateNetwork);
      if (!localOptIn) {
        return deny('local-not-allowed', 'Local/private addresses require an explicit allowlist entry', {
          origin,
          hostname,
          resolvedIps: addresses,
        });
      }
    }
    if (pinned.length > 0 && !pinned.includes(normalizeHostname(address))) {
      // The hostname changed its answer after the session pinned it: never
      // connect to an address that was not validated.
      return deny('dns-rebinding', `${hostname} now resolves to the unpinned address ${address}`, {
        origin,
        hostname,
        resolvedIps: addresses,
      });
    }
  }

  return {
    allowed: true,
    code: 'allowed',
    reason: 'allowed',
    origin,
    hostname,
    resolvedIps: addresses,
    href,
  };
}

/**
 * @param {string} hostname
 * @param {object} [options]
 * @returns {Promise<Array<{ address: string }>>}
 */
function defaultLookup(hostname, options) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { ...(options || {}), all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/**
 * Builds `--host-resolver-rules` entries for Chromium.
 *
 * Defense in depth, not a hard IP guarantee: Chromium resolves hostnames in its
 * own network stack, so the policy check and the connection are two separate
 * resolutions. The rules (a) map allowlisted hostnames to validated IPv4
 * addresses and (b) append `MAP * ~NOTFOUND`. On current Chromium the catch-all
 * also blocks IP-literal connects. IP-literal allowlist entries still get no
 * per-literal MAP pin from this builder (pinnedHosts 0). Upstream proxies and
 * WebSocket handshakes to a non-allowlisted port on a pinned hostname are not
 * covered by route policy; see SECURITY.md for WebRTC/TURN residuals. The
 * route-level policy that re-checks every request/redirect hop is the enforced
 * boundary.
 *
 * Only IPv4 answers are pinned (the rule syntax for literals is stable for IPv4
 * and ambiguous for IPv6); an IPv6-only host stays blocked by the catch-all.
 *
 * @param {{
 *   policy?: unknown,
 *   blockedOrigins?: string[],
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 * }} options
 * @returns {Promise<{ rules: string[], pinnedHosts: number, pins: Record<string, string[]>, defaultDeny: boolean }>}
 */
export async function buildHostResolverRules(options = {}) {
  const policy = normalizePolicy(options.policy);
  const lookup = typeof options.lookup === 'function' ? options.lookup : defaultLookup;
  const blockedOrigins = Array.isArray(options.blockedOrigins)
    ? options.blockedOrigins.map((entry) => normalizeOrigin(entry)).filter(Boolean)
    : [];
  /** @type {Map<string, string[]>} */
  const byHost = new Map();
  for (const origin of policy.allowedOrigins) {
    if (blockedOrigins.includes(origin)) continue;
    const parsed = parseHttpUrl(origin);
    if (!parsed || isIpLiteral(parsed.hostname)) continue;
    const host = parsed.hostname;
    if (byHost.has(host)) continue;
    let addresses = [];
    try {
      const records = await lookup(host, { all: true, verbatim: true });
      addresses = (Array.isArray(records) ? records : [])
        .map((record) => (typeof record === 'string' ? record : record?.address))
        .filter((address) => typeof address === 'string' && address);
    } catch {
      addresses = [];
    }
    const safe = addresses.filter((address) => {
      const kind = classifyIp(address);
      return !kind.alwaysBlocked && isIpv4(normalizeHostname(address));
    });
    // `localhost` must stay resolvable when the workspace opts into loopback.
    if (safe.length === 0 && isLoopbackHostname(host)) safe.push('127.0.0.1');
    if (safe.length > 0) byHost.set(host, [...new Set(safe.map((address) => normalizeHostname(address)))]);
  }
  if (policy.allowLocalhost && !byHost.has('localhost')) {
    byHost.set('localhost', ['127.0.0.1']);
  }
  const rules = [];
  /** @type {Record<string, string[]>} */
  const pins = {};
  for (const [host, addresses] of byHost) {
    pins[host] = addresses;
    for (const address of addresses) rules.push(`MAP ${host} ${address}`);
  }
  // Default-deny DNS: everything not mapped above becomes ~NOTFOUND.
  rules.push(HOST_RESOLVER_DENY_RULE);
  return { rules, pinnedHosts: byHost.size, pins, defaultDeny: true };
}

/**
 * Returns the request origin for a Playwright request/route URL, or ''.
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function requestOrigin(rawUrl) {
  return parseHttpUrl(rawUrl)?.origin || '';
}
