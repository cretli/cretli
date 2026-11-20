import type { IncomingMessage } from 'node:http';
import { verifyWidgetAccessToken } from '../widget/widget-installations.ts';
import type { WidgetAccessTokenPayload } from '../widget/widget-installations.ts';
import {
  getWidgetProtocolIndex,
  hasWidgetProtocol,
  isOwnCretliBrowserOrigin,
  isValidOriginHeader,
  parseWebSocketProtocols,
} from './ws-origin.ts';
import { isWidgetChatPath } from './ws-path.ts';

/**
 * Resolves widget access from the WebSocket subprotocol token.
 * Cretli iframe chat uses the Cretli origin (direct or CRETLI_PUBLIC_ORIGIN).
 * Extra WS origins are not treated as the Cretli iframe. External embeds must
 * match the token origin. X-Forwarded-* is ignored.
 */
export function resolveWidgetAccessToken(req: IncomingMessage, token: string, options: { useHttps?: boolean, publicOrigin?: string | null } = {}): WidgetAccessTokenPayload {
  const origin = String(req?.headers?.origin || '').trim();
  if (!isValidOriginHeader(origin)) {
    throw new Error('Widget WebSocket requires a valid Origin header');
  }
  if (isOwnCretliBrowserOrigin(req, origin, options)) {
    return verifyWidgetAccessToken(token);
  }
  return verifyWidgetAccessToken(token, { origin });
}

export type WidgetHandshakeDecision = {
  action: 'allow' | 'reject' | 'none',
  closeCode?: number,
  closeReason?: string,
  widgetAccess?: WidgetAccessTokenPayload | null,
};

/** Evaluates widget protocol usage before session cookie auth. */
export function evaluateWidgetHandshake(req: IncomingMessage, urlPath: string, options: { useHttps?: boolean, publicOrigin?: string | null } = {}): WidgetHandshakeDecision {
  const protocols = parseWebSocketProtocols(req);
  if (!hasWidgetProtocol(protocols)) {
    return { action: 'none', widgetAccess: null };
  }
  if (!isWidgetChatPath(urlPath)) {
    return {
      action: 'reject',
      closeCode: 4403,
      closeReason: 'widget protocol not allowed on this path',
      widgetAccess: null,
    };
  }
  const widgetProtocolIndex = getWidgetProtocolIndex(protocols);
  const token = protocols[widgetProtocolIndex + 1] || '';
  try {
    const widgetAccess = resolveWidgetAccessToken(req, token, options);
    return { action: 'allow', widgetAccess };
  } catch {
    return {
      action: 'reject',
      closeCode: 4403,
      closeReason: 'invalid widget session',
      widgetAccess: null,
    };
  }
}

/** Returns whether cookie/session auth is required for this connection. */
export function requiresSessionAuth(widgetDecision: WidgetHandshakeDecision): boolean {
  return widgetDecision.action !== 'allow';
}
