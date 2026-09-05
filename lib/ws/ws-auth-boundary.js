import { verifyWidgetAccessToken } from '../widget/widget-installations.js';
import {
  getWidgetProtocolIndex,
  hasWidgetProtocol,
  isOwnCretliBrowserOrigin,
  isValidOriginHeader,
  parseWebSocketProtocols,
} from './ws-origin.js';
import { isWidgetChatPath } from './ws-path.js';

/**
 * Resolves widget access from the WebSocket subprotocol token.
 * Cretli iframe chat uses the Cretli origin (direct or CRETLI_PUBLIC_ORIGIN).
 * Extra WS origins are not treated as the Cretli iframe. External embeds must
 * match the token origin. X-Forwarded-* is ignored.
 * @param {import('http').IncomingMessage} req
 * @param {string} token
 * @param {{ useHttps?: boolean, publicOrigin?: string|null }} [options]
 * @returns {object}
 */
export function resolveWidgetAccessToken(req, token, options = {}) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!isValidOriginHeader(origin)) {
    throw new Error('Widget WebSocket requires a valid Origin header');
  }
  if (isOwnCretliBrowserOrigin(req, origin, options)) {
    return verifyWidgetAccessToken(token);
  }
  return verifyWidgetAccessToken(token, { origin });
}

/**
 * @typedef {Object} WidgetHandshakeDecision
 * @property {'allow' | 'reject' | 'none'} action
 * @property {number} [closeCode]
 * @property {string} [closeReason]
 * @property {object|null} [widgetAccess]
 */

/**
 * Evaluates widget protocol usage before session cookie auth.
 * @param {import('http').IncomingMessage} req
 * @param {string} urlPath
 * @param {{ useHttps?: boolean, publicOrigin?: string|null }} [options]
 * @returns {WidgetHandshakeDecision}
 */
export function evaluateWidgetHandshake(req, urlPath, options = {}) {
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

/**
 * Returns whether cookie/session auth is required for this connection.
 * @param {WidgetHandshakeDecision} widgetDecision
 * @returns {boolean}
 */
export function requiresSessionAuth(widgetDecision) {
  return widgetDecision.action !== 'allow';
}
