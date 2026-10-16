/**
 * Acceptance actor vocabulary (`docs/todo-review-contract.md` §7.2).
 *
 * The actor is a *channel* signal derived server-side, never a client-supplied
 * identity: an authenticated browser session on the delegation card is `human`,
 * an MCP connection or a widget token is `agent`, an internal reconciliation is
 * `system`, and anything else (including the in-process MCP client) is
 * `unknown`. A connection that is not a plain authenticated browser session must
 * never yield `human`.
 */

/** Allowed actors on `acknowledge`. */
export const DELEGATION_ACK_ACTORS = Object.freeze([
  'human',
  'agent',
  'system',
  'unknown',
]);

/** @type {Set<string>} */
const DELEGATION_ACK_ACTOR_SET = new Set(DELEGATION_ACK_ACTORS);

/**
 * Normalize a stored/derived actor. An empty or unrecognized value collapses to
 * `''` so a never-acknowledged record does not claim an actor; callers that need
 * an explicit fallback pass `unknown`.
 *
 * @param {unknown} value
 * @returns {'human' | 'agent' | 'system' | 'unknown' | ''}
 */
export function normalizeDelegationAckActor(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return DELEGATION_ACK_ACTOR_SET.has(raw) ? /** @type {any} */ (raw) : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDelegationAckActor(value) {
  return DELEGATION_ACK_ACTOR_SET.has(String(value ?? '').trim().toLowerCase());
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHumanDelegationAckActor(value) {
  return String(value ?? '').trim().toLowerCase() === 'human';
}

let agentSessionDetector = () => false;

/**
 * Server-side hook: `lib/auth.js` registers its persisted agent-session lookup
 * here. This module is reachable from the browser bundle, so it must not import
 * server-only modules directly.
 *
 * @param {(req: object) => boolean} detector
 */
export function registerAgentSessionDetector(detector) {
  agentSessionDetector = typeof detector === 'function' ? detector : () => false;
}

/**
 * Derive the acceptance actor from an authenticated HTTP request.
 *
 * Trust boundary: this is the transport the server already authenticated, not a
 * verified person. A widget token or an MCP integration token is always
 * `agent` (never `human`), even on the card endpoint. The two acknowledgement
 * routes behind a session cookie with neither marker are the human channel.
 *
 * @param {object | null | undefined} req
 * @param {{ remoteMcp?: boolean, system?: boolean, authenticated?: boolean }} [options]
 * @returns {'human' | 'agent' | 'system' | 'unknown'}
 */
export function resolveDelegationAckActorFromRequest(req, options = {}) {
  if (options.system === true) return 'system';
  if (!req || typeof req !== 'object') return 'unknown';
  if (agentSessionDetector(req) || req.headers?.['x-cretli-agent'] === '1') return 'agent';
  if (req.widgetAccess) return 'agent';
  if (req.mcpIntegration) return 'agent';
  if (options.remoteMcp === true) return 'agent';
  if (options.authenticated === false) return 'unknown';
  // /api/* is gated by requireAuth: a request without a bearer/integration
  // marker carries the authenticated browser session.
  return 'human';
}
