/**
 * Passwordless login for the built-in Browser only.
 *
 * LAN clients forwarded onto 127.0.0.1 (for example via socat) look like
 * loopback to Node, so the socket address alone is not a proof of locality.
 * The server-side Browser sends an in-memory token, but only on requests whose
 * target origin is one of Cretli's own origins — never to a third-party origin
 * the Browser is allowed to open. The token is never written to disk or
 * returned by the API.
 */

import { randomBytes, timingSafeEqual } from 'crypto';

export const LOCAL_LOGIN_HEADER = 'x-cretli-local-login';

const LOCAL_LOGIN_TOKEN = randomBytes(24).toString('hex');

/**
 * Marks requests that come from a page an agent Browser session controls. It is
 * not a credential: it only downgrades the login session the request carries to
 * a preview session, so a Cretli page opened by an agent (for example in an
 * external Chrome profile that is already signed in) can never become the owner
 * of the very Browser session the agent is driving.
 */
export const BROWSER_AGENT_PAGE_HEADER = 'x-cretli-browser-agent-page';

const BROWSER_AGENT_PAGE_TOKEN = randomBytes(24).toString('hex');

/** @returns {string} */
export function getBrowserAgentPageToken() {
  return BROWSER_AGENT_PAGE_TOKEN;
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isBrowserAgentPageRequest(req) {
  const header = req?.headers?.[BROWSER_AGENT_PAGE_HEADER];
  const provided = String(Array.isArray(header) ? header[0] : (header || '')).trim();
  if (!provided) return false;
  const expected = Buffer.from(BROWSER_AGENT_PAGE_TOKEN);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * @returns {string}
 */
export function getLocalLoginToken() {
  return LOCAL_LOGIN_TOKEN;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  const remote = String(address || '');
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * Direct loopback request that presents the in-memory Browser token.
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLocalLoginRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const header = req?.headers?.[LOCAL_LOGIN_HEADER];
  const provided = String(Array.isArray(header) ? header[0] : (header || '')).trim();
  if (!provided) return false;
  const expected = Buffer.from(LOCAL_LOGIN_TOKEN);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
