import type { IncomingMessage } from 'node:http';
import { readEnvAlias } from '../env-alias.js';
import {
  isPageBridgePath,
  isWidgetChatPath,
} from './ws-path.ts';

const WIDGET_PROTOCOLS = new Set(['cretli-widget', 'cursor-remote-widget']);

export function parseExtraWsOrigins(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Uses the direct Host header only. Reverse-proxy forwarded headers are ignored
 * unless their origin is explicitly listed in CRETLI_EXTRA_WS_ORIGINS.
 */
export function getDirectRequestHost(req: IncomingMessage): string {
  return String(req?.headers?.host || '').trim().toLowerCase();
}

/**
 * @deprecated Use getDirectRequestHost. Kept for existing imports.
 */
export function getRequestHost(req: IncomingMessage): string {
  return getDirectRequestHost(req);
}

export function parseWebSocketProtocols(req: IncomingMessage): string[] {
  return String(req?.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasWidgetProtocol(protocols: string[]): boolean {
  return protocols.some((protocol) => WIDGET_PROTOCOLS.has(protocol));
}

export function getWidgetProtocolIndex(protocols: string[]): number {
  const cretliIndex = protocols.indexOf('cretli-widget');
  const legacyIndex = protocols.indexOf('cursor-remote-widget');
  return Math.max(cretliIndex, legacyIndex);
}

export function normalizeOrigin(origin: string): string | null {
  if (typeof origin !== 'string' || !origin.trim()) return null;
  let url: URL;
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

export function originHost(origin: string): string {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return '';
  }
}

export function isValidOriginHeader(origin: string): boolean {
  if (typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  return normalizeOrigin(trimmed) !== null;
}

/**
 * Direct connection scheme from the Node TLS socket or the server transport flag.
 * Reverse-proxy headers (X-Forwarded-Proto) are ignored.
 */
export function getDirectConnectionProtocol(req: IncomingMessage, options: { useHttps?: boolean } = {}): 'http:' | 'https:' {
  if (options.useHttps === true) return 'https:';
  if (options.useHttps === false) return 'http:';
  if ((req?.socket as { encrypted?: boolean } | undefined)?.encrypted) return 'https:';
  return 'http:';
}

export function isSameHostOrigin(req: IncomingMessage, origin: string, options: { useHttps?: boolean } = {}): boolean {
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
 * @deprecated Use path-specific checks in isWsOriginAllowed instead.
 */
export function isWidgetOrPageBridgeRequest(req: IncomingMessage, urlPath: string): boolean {
  if (isPageBridgePath(urlPath)) return true;
  return hasWidgetProtocol(parseWebSocketProtocols(req)) && isWidgetChatPath(urlPath);
}

export function isOriginInExtraAllowlist(origin: string, extras: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;
  return extras.some((allowed) => normalizeOrigin(allowed) === normalizedOrigin);
}

/**
 * Public browser origin of this Cretli instance (TLS-terminated proxy).
 * Invalid values are ignored. X-Forwarded-* is never read here.
 */
export function readCretliPublicOrigin(value?: string): string | null {
  const raw = value === undefined
    ? readEnvAlias({ current: 'CRETLI_PUBLIC_ORIGIN' })
    : String(value || '');
  return normalizeOrigin(raw.trim());
}

export function isCretliPublicOrigin(origin: string, publicOrigin: string | null | undefined): boolean {
  const actual = normalizeOrigin(origin);
  const expected = normalizeOrigin(publicOrigin || '');
  return !!actual && !!expected && actual === expected;
}

/**
 * Own Cretli UI (direct same-host or configured public origin). Extra WS
 * origins are not treated as the Cretli iframe.
 */
export function isOwnCretliBrowserOrigin(req: IncomingMessage, origin: string, options: { useHttps?: boolean, publicOrigin?: string | null } = {}): boolean {
  if (isSameHostOrigin(req, origin, options)) return true;
  return isCretliPublicOrigin(origin, options.publicOrigin);
}

export function isWsOriginAllowed(req: IncomingMessage, urlPath: string, options: { extraOrigins?: string[], useHttps?: boolean, publicOrigin?: string | null } = {}): boolean {
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
