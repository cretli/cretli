import { readEnvAlias } from '../env-alias.js';
import {
  isPageBridgePath,
  isWidgetChatPath,
} from './ws-path.js';

const WIDGET_PROTOCOLS = new Set(['cretli-widget', 'cursor-remote-widget']);

/**
 * @param {string} value
 * @returns {string[]}
 */
export function parseExtraWsOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Uses the direct Host header only. Reverse-proxy forwarded headers are ignored
 * unless their origin is explicitly listed in CRETLI_EXTRA_WS_ORIGINS.
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function getDirectRequestHost(req) {
  return String(req?.headers?.host || '').trim().toLowerCase();
}

/** @deprecated Use getDirectRequestHost. Kept for existing imports. */
export function getRequestHost(req) {
  return getDirectRequestHost(req);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string[]}
 */
export function parseWebSocketProtocols(req) {
  return String(req?.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * @param {string[]} protocols
 * @returns {boolean}
 */
export function hasWidgetProtocol(protocols) {
  return protocols.some((protocol) => WIDGET_PROTOCOLS.has(protocol));
}

/**
 * @param {string[]} protocols
 * @returns {number}
 */
export function getWidgetProtocolIndex(protocols) {
  const cretliIndex = protocols.indexOf('cretli-widget');
  const legacyIndex = protocols.indexOf('cursor-remote-widget');
  return Math.max(cretliIndex, legacyIndex);
}

/**
 * @param {string} origin
 * @returns {string|null}
 */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) return null;
  let url;
  try {
    url = new URL(origin.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

/**
 * @param {string} origin
 * @returns {string}
 */
export function originHost(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * @param {string} origin
 * @returns {boolean}
 */
export function isValidOriginHeader(origin) {
  if (typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  return normalizeOrigin(trimmed) !== null;
}

/**
 * Direct connection scheme from the Node TLS socket or the server transport flag.
 * Reverse-proxy headers (X-Forwarded-Proto) are ignored.
 * @param {import('http').IncomingMessage} req
 * @param {{ useHttps?: boolean }} [options]
 * @returns {'http:' | 'https:'}
 */
export function getDirectConnectionProtocol(req, options = {}) {
  if (options.useHttps === true) return 'https:';
  if (options.useHttps === false) return 'http:';
  if (req?.socket?.encrypted) return 'https:';
  return 'http:';
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {string} origin
 * @param {{ useHttps?: boolean }} [options]
 * @returns {boolean}
 */
export function isSameHostOrigin(req, origin, options = {}) {
  const host = getDirectRequestHost(req);
  if (!host || !isValidOriginHeader(origin)) return false;
  const protocol = getDirectConnectionProtocol(req, options);
  const expected = normalizeOrigin(`${protocol}//${host}`);
  const actual = normalizeOrigin(origin);
  return !!expected && expected === actual;
}

/**
 * Widget embeds and page-bridge sockets come from the host page origin, not Cretli.
 * Protocol name alone must never bypass origin checks.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} urlPath
 * @returns {boolean}
 * @deprecated Use path-specific checks in isWsOriginAllowed instead.
 */
export function isWidgetOrPageBridgeRequest(req, urlPath) {
  if (isPageBridgePath(urlPath)) return true;
  return hasWidgetProtocol(parseWebSocketProtocols(req)) && isWidgetChatPath(urlPath);
}

/**
 * @param {string} origin
 * @param {string[]} extras
 * @returns {boolean}
 */
export function isOriginInExtraAllowlist(origin, extras) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  return extras.some((allowed) => normalizeOrigin(allowed) === normalizedOrigin);
}

/**
 * Public browser origin of this Cretli instance (TLS-terminated proxy).
 * Invalid values are ignored. X-Forwarded-* is never read here.
 * @param {string} [value]
 * @returns {string|null}
 */
export function readCretliPublicOrigin(value) {
  const raw = value === undefined
    ? readEnvAlias({ current: 'CRETLI_PUBLIC_ORIGIN' })
    : String(value || '');
  return normalizeOrigin(raw.trim());
}

/**
 * @param {string} origin
 * @param {string|null|undefined} publicOrigin
 * @returns {boolean}
 */
export function isCretliPublicOrigin(origin, publicOrigin) {
  const actual = normalizeOrigin(origin);
  const expected = normalizeOrigin(publicOrigin || '');
  return !!actual && !!expected && actual === expected;
}

/**
 * Own Cretli UI (direct same-host or configured public origin). Extra WS
 * origins are not treated as the Cretli iframe.
 * @param {import('http').IncomingMessage} req
 * @param {string} origin
 * @param {{ useHttps?: boolean, publicOrigin?: string|null }} [options]
 * @returns {boolean}
 */
export function isOwnCretliBrowserOrigin(req, origin, options = {}) {
  if (isSameHostOrigin(req, origin, options)) return true;
  return isCretliPublicOrigin(origin, options.publicOrigin);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {string} urlPath
 * @param {{ extraOrigins?: string[], useHttps?: boolean, publicOrigin?: string|null }} [options]
 * @returns {boolean}
 */
export function isWsOriginAllowed(req, urlPath, options = {}) {
  const origin = String(req?.headers?.origin || '').trim();
  const protocols = parseWebSocketProtocols(req);
  const widgetProtocol = hasWidgetProtocol(protocols);
  if (widgetProtocol && !isWidgetChatPath(urlPath)) return false;
  if (isPageBridgePath(urlPath)) return isValidOriginHeader(origin);
  if (isWidgetChatPath(urlPath) && widgetProtocol) return isValidOriginHeader(origin);
  if (!origin) return true;
  if (!isValidOriginHeader(origin)) return false;
  if (isOwnCretliBrowserOrigin(req, origin, options)) return true;
  const extras = Array.isArray(options.extraOrigins)
    ? options.extraOrigins
    : parseExtraWsOrigins(readEnvAlias({
      current: 'CRETLI_EXTRA_WS_ORIGINS',
      legacy: 'CURSOR_REMOTE_EXTRA_WS_ORIGINS',
    }));
  return isOriginInExtraAllowlist(origin, extras);
}
