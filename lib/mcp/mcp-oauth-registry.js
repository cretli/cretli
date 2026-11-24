/**
 * OAuth state for the external `/mcp` endpoint (lib/routes/mcp-oauth-routes.js):
 *
 * - dynamically registered OAuth clients (RFC 7591), persisted in the data dir
 *   with 0600 permissions; capped, oldest dropped first;
 * - pending consent requests (in memory, bound to the Cretli login session that
 *   opened the consent page);
 * - authorization codes (in memory, single use, stored by hash).
 *
 * Grants and tokens live with the other external clients
 * (lib/mcp/mcp-external-clients.js).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const MAX_REGISTERED_CLIENTS = 100;
const MAX_REDIRECT_URIS = 10;
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;
export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 200;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class OAuthRegistryError extends Error {}

function storePath() {
  return resolveDataPath('mcp-oauth-clients.json');
}

/** @returns {Array<Record<string, any>>} */
function readRegisteredClients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(parsed?.clients) ? parsed.clients : [];
  } catch {
    return [];
  }
}

/** @param {Array<Record<string, any>>} clients */
function writeRegisteredClients(clients) {
  const filePath = storePath();
  writeJsonAtomic(filePath, { version: 1, clients });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

/**
 * Native clients redirect to a loopback listener (RFC 8252); anything else
 * must be https. Custom schemes and plain http to other hosts are refused.
 *
 * @param {unknown} uri
 */
export function isAllowedRedirectUri(uri) {
  let parsed;
  try {
    parsed = new URL(String(uri));
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** @param {string} clientId */
export function getRegisteredOAuthClient(clientId) {
  return readRegisteredClients().find((row) => row.client_id === clientId);
}

/**
 * @param {Record<string, any>} metadata Validated by the SDK registration handler; `client_id` is set by it.
 * @returns {Record<string, any>}
 */
export function registerOAuthClient(metadata) {
  const redirectUris = Array.isArray(metadata?.redirect_uris) ? metadata.redirect_uris : [];
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(isAllowedRedirectUri)) {
    throw new OAuthRegistryError('redirect_uris must be https or http on a loopback host (localhost, 127.0.0.1, [::1])');
  }
  const clientName = typeof metadata.client_name === 'string' ? metadata.client_name.trim().slice(0, 64) : '';
  const client = {
    ...metadata,
    client_id: metadata.client_id || randomUUID(),
    client_name: clientName || undefined,
  };
  const clients = [...readRegisteredClients(), client].slice(-MAX_REGISTERED_CLIENTS);
  writeRegisteredClients(clients);
  return client;
}

/** @type {Map<string, { oauthClientId: string, clientName: string, redirectUri: string, codeChallenge: string, state?: string, resource?: string, sessionId: string, expiresAt: number }>} */
const pendingRequests = new Map();

/** @type {Map<string, { oauthClientId: string, grantId: string, redirectUri: string, codeChallenge: string, resource?: string, expiresAt: number }>} */
const authorizationCodes = new Map();

/** @param {number} now */
function prune(now) {
  for (const [id, row] of pendingRequests) if (row.expiresAt <= now) pendingRequests.delete(id);
  for (const [hash, row] of authorizationCodes) if (row.expiresAt <= now) authorizationCodes.delete(hash);
}

/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {{ oauthClientId: string, clientName: string, redirectUri: string, codeChallenge: string, state?: string, resource?: string, sessionId: string }} request
 * @param {{ now?: number }} [options]
 * @returns {string} Opaque request id embedded in the consent form.
 */
export function createPendingAuthorization(request, { now = Date.now() } = {}) {
  prune(now);
  if (pendingRequests.size >= MAX_PENDING) {
    const oldest = pendingRequests.keys().next().value;
    if (oldest) pendingRequests.delete(oldest);
  }
  const id = randomBytes(24).toString('base64url');
  pendingRequests.set(id, { ...request, expiresAt: now + OAUTH_PENDING_TTL_MS });
  return id;
}

/**
 * Removes and returns the pending request, only for the session that opened it.
 *
 * @param {string} id
 * @param {string} sessionId
 * @param {{ now?: number }} [options]
 */
export function takePendingAuthorization(id, sessionId, { now = Date.now() } = {}) {
  prune(now);
  const row = pendingRequests.get(String(id || ''));
  if (!row || !sessionId || row.sessionId !== sessionId) return null;
  pendingRequests.delete(String(id));
  return row;
}

/**
 * @param {{ oauthClientId: string, grantId: string, redirectUri: string, codeChallenge: string, resource?: string }} grant
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function createAuthorizationCode(grant, { now = Date.now() } = {}) {
  prune(now);
  const code = randomBytes(32).toString('base64url');
  authorizationCodes.set(hash(code), { ...grant, expiresAt: now + OAUTH_CODE_TTL_MS });
  return code;
}

/**
 * @param {string} code
 * @param {{ now?: number }} [options]
 */
export function peekAuthorizationCode(code, { now = Date.now() } = {}) {
  prune(now);
  return authorizationCodes.get(hash(String(code || ''))) || null;
}

/**
 * Single use: the code is removed whether or not the caller accepts it.
 *
 * @param {string} code
 * @param {{ now?: number }} [options]
 */
export function consumeAuthorizationCode(code, { now = Date.now() } = {}) {
  prune(now);
  const key = hash(String(code || ''));
  const row = authorizationCodes.get(key) || null;
  authorizationCodes.delete(key);
  return row;
}

/** Test helper. */
export function resetOAuthRegistryMemory() {
  pendingRequests.clear();
  authorizationCodes.clear();
}
