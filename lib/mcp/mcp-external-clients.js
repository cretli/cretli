/**
 * External MCP clients: tools such as Claude Code or Cursor that reach Cretli's
 * built-in MCP tools over Streamable HTTP at `/mcp` (lib/routes/mcp-external-routes.js).
 *
 * Unlike the per-chat integration tokens (mcp-integration-token.js), an
 * external client is created by the user in Settings, bound to one workspace
 * and one mode, expires, and can be revoked. Its token
 * `cmx1.<clientId>.<secret>` is shown once; only sha256(secret) is stored, in
 * the data dir with 0600 permissions. The token is honored by `/mcp` only and
 * never by the `/api/*` session auth.
 *
 * A client can also come from an OAuth authorization (`kind: 'oauth'`,
 * lib/routes/mcp-oauth-routes.js): the user approves a workspace and mode on
 * the consent page and the MCP client gets a short-lived access token
 * (`cmo1.<clientId>.<secret>`) plus a rotating refresh token
 * (`cmr1.<clientId>.<secret>`). Every refresh slides `expiresAt` forward by the
 * idle TTL, up to `absoluteExpiresAt`; presenting an already rotated refresh
 * token outside a short grace window revokes the whole grant (reuse detection).
 * Only hashes are stored, like for the static token.
 *
 * A managed client (`kind: 'oauth'`, `managed: true`) is the one-click
 * "Connect" from Settings: the logged-in user's click is the consent, and
 * Cretli itself keeps a short-lived access token fresh in a 0600 file under
 * the data dir that the local stdio bridge re-reads on every request. No
 * refresh token ever leaves the server, so several client processes sharing
 * the file cannot trip reuse detection. Its expiry slides with actual use.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const EXTERNAL_MCP_TOKEN_PREFIX = 'cmx1';
export const EXTERNAL_MCP_OAUTH_ACCESS_PREFIX = 'cmo1';
export const EXTERNAL_MCP_OAUTH_REFRESH_PREFIX = 'cmr1';
/** Lifetime of one OAuth access token. */
export const EXTERNAL_MCP_OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
/** Hard cap for an OAuth grant, counted from the consent. */
export const EXTERNAL_MCP_OAUTH_MAX_TTL_DAYS = 365;
/** A just-rotated refresh token presented again within this window is refused without revoking the grant (concurrent refresh). */
const OAUTH_REFRESH_REUSE_GRACE_MS = 60 * 1000;
const OAUTH_ACCESS_TOKENS_KEPT = 4;
const OAUTH_PREVIOUS_REFRESH_KEPT = 8;
/**
 * `plan` exposes read-only tools (Plan policy); `agent` exposes everything;
 * `operator` is `agent` plus the operator tools that act for the user
 * (approve a plan, message a chat; lib/mcp/mcp-external-operator-tools.js).
 */
export const EXTERNAL_MCP_MODES = Object.freeze(/** @type {const} */ (['plan', 'agent', 'operator']));
export const EXTERNAL_MCP_DEFAULT_TTL_DAYS = 30;
export const EXTERNAL_MCP_MAX_TTL_DAYS = 365;
/** An OAuth grant not refreshed for this long expires (sliding). */
export const EXTERNAL_MCP_OAUTH_IDLE_TTL_DAYS = EXTERNAL_MCP_DEFAULT_TTL_DAYS;
const NAME_MAX_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `lastUsedAt` is persisted at most this often per client. */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;
/** A managed client's token file is renewed once its token has less than this left. */
export const EXTERNAL_MCP_MANAGED_RENEW_BEFORE_MS = 30 * 60 * 1000;
const MANAGED_TOKEN_DIR = 'mcp-managed-tokens';

/** @typedef {typeof EXTERNAL_MCP_MODES[number]} ExternalMcpMode */

/**
 * @typedef {Record<string, any>} ExternalMcpClient
 * @property {string} id
 * @property {string} name
 * @property {string} workspaceFolder Absolute folder the client's tools are scoped to.
 * @property {ExternalMcpMode} mode
 * @property {string} createdAt ISO time.
 * @property {string} expiresAt ISO time.
 * @property {string | null} revokedAt ISO time.
 * @property {string | null} lastUsedAt ISO time.
 * @property {string} secretHash sha256 hex of the token secret; never leaves this module.
 * @property {'token' | 'oauth'} [kind] Absent on clients created before OAuth: `token`.
 * @property {string} [oauthClientId] OAuth only: the registered (DCR) client that holds the grant.
 * @property {string} [absoluteExpiresAt] OAuth only: hard cap for sliding `expiresAt`.
 * @property {Array<{ hash: string, expiresAt: string }>} [accessTokens] OAuth only.
 * @property {string} [refreshHash] OAuth only: hash of the current refresh token.
 * @property {Array<{ hash: string, rotatedAt: string }>} [previousRefreshHashes] OAuth only.
 */

/** @typedef {Omit<ExternalMcpClient, 'secretHash'>} ExternalMcpClientInfo */

export class ExternalMcpClientError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status the caller should answer with.
   */
  constructor(message, status) {
    super(message);
    this.name = 'ExternalMcpClientError';
    this.status = status;
  }
}

function storePath() {
  return resolveDataPath('mcp-external-clients.json');
}

/** @returns {ExternalMcpClient[]} */
function readClients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(parsed?.clients) ? parsed.clients : [];
  } catch {
    return [];
  }
}

/** @param {ExternalMcpClient[]} clients */
function writeClients(clients) {
  const filePath = storePath();
  writeJsonAtomic(filePath, { version: 1, clients });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

/** @param {string} secret */
function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * @param {ExternalMcpClient} client
 * @returns {ExternalMcpClientInfo}
 */
function toInfo(client) {
  const {
    secretHash: _secretHash,
    accessTokens: _accessTokens,
    refreshHash: _refreshHash,
    previousRefreshHashes: _previousRefreshHashes,
    ...info
  } = client;
  return { ...info, kind: client.kind === 'oauth' ? 'oauth' : 'token' };
}

/** @returns {ExternalMcpClientInfo[]} Newest first, revoked and expired included. */
export function listExternalMcpClients() {
  return readClients().map(toInfo).reverse();
}

/**
 * @param {{ name?: unknown, workspaceFolder?: unknown, mode?: unknown, ttlDays?: unknown }} input
 * @param {{ now?: number }} [options]
 * @returns {{ client: ExternalMcpClientInfo, token: string }} The token is returned only here.
 */
export function createExternalMcpClient(input, { now = Date.now() } = /** @type {any} */ ({})) {
  const { name, workspaceFolder: resolvedFolder, mode } = validateClientInput(input);
  const ttlDays = input?.ttlDays === undefined ? EXTERNAL_MCP_DEFAULT_TTL_DAYS : Number(input.ttlDays);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > EXTERNAL_MCP_MAX_TTL_DAYS) {
    throw new ExternalMcpClientError(`ttlDays must be an integer between 1 and ${EXTERNAL_MCP_MAX_TTL_DAYS}`, 400);
  }

  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  /** @type {ExternalMcpClient} */
  const client = {
    id,
    name,
    workspaceFolder: resolvedFolder,
    mode,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * DAY_MS).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    secretHash: hashSecret(secret),
  };
  writeClients([...readClients(), client]);
  return { client: toInfo(client), token: `${EXTERNAL_MCP_TOKEN_PREFIX}.${id}.${secret}` };
}

/**
 * Shared validation of name, workspace folder and mode (Settings and OAuth consent).
 *
 * @param {{ name?: unknown, workspaceFolder?: unknown, mode?: unknown }} input
 * @returns {{ name: string, workspaceFolder: string, mode: ExternalMcpMode }}
 */
function validateClientInput(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ExternalMcpClientError(`name must be 1-${NAME_MAX_LENGTH} printable characters`, 400);
  }
  const workspaceFolder = typeof input?.workspaceFolder === 'string' ? input.workspaceFolder.trim() : '';
  if (!workspaceFolder || !path.isAbsolute(workspaceFolder)) {
    throw new ExternalMcpClientError('workspaceFolder must be an absolute path', 400);
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(workspaceFolder).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new ExternalMcpClientError('workspaceFolder must be an existing directory', 400);
  const resolvedFolder = path.resolve(workspaceFolder);
  if (path.parse(resolvedFolder).root === resolvedFolder) {
    // A client scoped to `/` would reach the whole filesystem through the tools.
    throw new ExternalMcpClientError('workspaceFolder must not be the filesystem root', 400);
  }
  const mode = input?.mode === undefined ? 'plan' : input.mode;
  if (!EXTERNAL_MCP_MODES.includes(/** @type {ExternalMcpMode} */ (mode))) {
    throw new ExternalMcpClientError(`mode must be one of: ${EXTERNAL_MCP_MODES.join(', ')}`, 400);
  }
  return { name, workspaceFolder: resolvedFolder, mode: /** @type {ExternalMcpMode} */ (mode) };
}

/**
 * @param {string} id
 * @param {{ now?: number }} [options]
 * @returns {boolean} false when no such client exists.
 */
export function revokeExternalMcpClient(id, { now = Date.now() } = /** @type {any} */ ({})) {
  const clients = readClients();
  const client = clients.find((row) => row.id === id);
  if (!client) return false;
  if (!client.revokedAt) {
    client.revokedAt = new Date(now).toISOString();
    writeClients(clients);
  }
  if (client.managed) removeManagedTokenFile(client.id);
  return true;
}

/**
 * Replace the secret of an existing client (same id, workspace, mode and
 * expiry). The old token stops working immediately; the new one is returned
 * only here, like on create.
 *
 * @param {string} id
 * @param {{ now?: number }} [options]
 * @returns {{ client: ExternalMcpClientInfo, token: string } | null} null when no such client exists.
 */
export function rotateExternalMcpClientToken(id, { now = Date.now() } = /** @type {any} */ ({})) {
  const clients = readClients();
  const client = clients.find((row) => row.id === id);
  if (!client) return null;
  if (client.kind === 'oauth') throw new ExternalMcpClientError('OAuth clients renew their tokens themselves; revoke the client instead', 409);
  if (client.revokedAt) throw new ExternalMcpClientError('MCP client token was revoked', 409);
  if (Date.parse(client.expiresAt) <= now) throw new ExternalMcpClientError('MCP client token expired', 409);
  const secret = randomBytes(32).toString('base64url');
  client.secretHash = hashSecret(secret);
  writeClients(clients);
  return { client: toInfo(client), token: `${EXTERNAL_MCP_TOKEN_PREFIX}.${client.id}.${secret}` };
}

/**
 * Change the mode of an existing client; the token stays the same and the new
 * mode applies from its next request (`/mcp` reads the client on every call).
 *
 * @param {string} id
 * @param {unknown} mode
 * @returns {ExternalMcpClientInfo | null} null when no such client exists.
 */
export function updateExternalMcpClientMode(id, mode) {
  if (!EXTERNAL_MCP_MODES.includes(/** @type {ExternalMcpMode} */ (mode))) {
    throw new ExternalMcpClientError(`mode must be one of: ${EXTERNAL_MCP_MODES.join(', ')}`, 400);
  }
  const clients = readClients();
  const client = clients.find((row) => row.id === id);
  if (!client) return null;
  if (client.revokedAt) throw new ExternalMcpClientError('MCP client token was revoked', 409);
  if (client.mode !== mode) {
    client.mode = /** @type {ExternalMcpMode} */ (mode);
    writeClients(clients);
  }
  return toInfo(client);
}

/**
 * @param {unknown} token
 * @returns {boolean}
 */
export function isExternalMcpToken(token) {
  return typeof token === 'string' && token.startsWith(`${EXTERNAL_MCP_TOKEN_PREFIX}.`);
}

/**
 * Authenticate an external client and record its use. Accepts the static
 * Settings token (`cmx1`) and OAuth access tokens (`cmo1`).
 *
 * @param {unknown} token
 * @param {{ now?: number }} [options]
 * @returns {ExternalMcpClientInfo}
 */
export function verifyExternalMcpToken(token, { now = Date.now() } = /** @type {any} */ ({})) {
  const invalid = new ExternalMcpClientError('Invalid MCP client token', 401);
  const parsed = splitToken(token);
  if (!parsed || (parsed.prefix !== EXTERNAL_MCP_TOKEN_PREFIX && parsed.prefix !== EXTERNAL_MCP_OAUTH_ACCESS_PREFIX)) throw invalid;
  const clients = readClients();
  const client = clients.find((row) => row.id === parsed.id);
  if (!client) throw invalid;
  const secretHash = hashSecret(parsed.secret);
  if (parsed.prefix === EXTERNAL_MCP_TOKEN_PREFIX) {
    if (client.kind === 'oauth' || !hashEquals(client.secretHash, secretHash)) throw invalid;
  } else {
    if (client.kind !== 'oauth') throw invalid;
    const access = (client.accessTokens || []).find((row) => hashEquals(row.hash, secretHash));
    if (!access) throw invalid;
    if (!client.revokedAt && Date.parse(access.expiresAt) <= now) throw new ExternalMcpClientError('MCP access token expired', 401);
  }
  if (client.revokedAt) throw new ExternalMcpClientError('MCP client token was revoked', 401);
  if (Date.parse(client.expiresAt) <= now) throw new ExternalMcpClientError('MCP client token expired', 401);

  const lastUsed = client.lastUsedAt ? Date.parse(client.lastUsedAt) : 0;
  if (now - lastUsed >= LAST_USED_WRITE_INTERVAL_MS) {
    client.lastUsedAt = new Date(now).toISOString();
    // A managed client renews nothing itself: use, not the server's renewal, keeps it alive.
    if (client.managed) client.expiresAt = slidingExpiry(client, now);
    writeClients(clients);
  }
  return toInfo(client);
}

/**
 * @param {unknown} token
 * @returns {{ prefix: string, id: string, secret: string } | null}
 */
function splitToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { prefix: parts[0], id: parts[1], secret: parts[2] };
}

/**
 * @param {string | undefined} expectedHex
 * @param {string} actualHex
 */
function hashEquals(expectedHex, actualHex) {
  if (typeof expectedHex !== 'string' || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * OAuth: create the client row for an approved consent. It has no static
 * token; tokens come from `issueExternalMcpOAuthTokens`.
 *
 * @param {{ name?: unknown, workspaceFolder?: unknown, mode?: unknown, oauthClientId: string }} input
 * @param {{ now?: number }} [options]
 * @returns {ExternalMcpClientInfo}
 */
export function createExternalMcpOAuthGrant(input, { now = Date.now() } = /** @type {any} */ ({})) {
  const { name, workspaceFolder, mode } = validateClientInput(input);
  const oauthClientId = String(input?.oauthClientId || '');
  if (!oauthClientId) throw new ExternalMcpClientError('oauthClientId is required', 400);
  const absoluteExpiresAt = now + EXTERNAL_MCP_OAUTH_MAX_TTL_DAYS * DAY_MS;
  /** @type {ExternalMcpClient} */
  const client = {
    id: randomUUID(),
    name,
    workspaceFolder,
    mode,
    kind: 'oauth',
    oauthClientId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + EXTERNAL_MCP_OAUTH_IDLE_TTL_DAYS * DAY_MS, absoluteExpiresAt)).toISOString(),
    absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    secretHash: '',
    accessTokens: [],
    refreshHash: '',
    previousRefreshHashes: [],
  };
  writeClients([...readClients(), client]);
  return toInfo(client);
}

/**
 * @typedef {{ access_token: string, token_type: 'bearer', expires_in: number, refresh_token: string }} ExternalMcpOAuthTokens
 */

/**
 * Mint a new access + refresh token pair on the grant and slide its expiry.
 * The previous refresh token is remembered for reuse detection.
 *
 * @param {ExternalMcpClient} client Mutated in place; the caller writes the list.
 * @param {number} now
 * @returns {ExternalMcpOAuthTokens}
 */
function mintOAuthTokens(client, now) {
  const accessToken = mintAccessToken(client, now);
  const refresh = randomBytes(32).toString('base64url');
  if (client.refreshHash) {
    client.previousRefreshHashes = [
      ...(client.previousRefreshHashes || []),
      { hash: client.refreshHash, rotatedAt: new Date(now).toISOString() },
    ].slice(-OAUTH_PREVIOUS_REFRESH_KEPT);
  }
  client.refreshHash = hashSecret(refresh);
  client.expiresAt = slidingExpiry(client, now);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: Math.floor(EXTERNAL_MCP_OAUTH_ACCESS_TTL_MS / 1000),
    refresh_token: `${EXTERNAL_MCP_OAUTH_REFRESH_PREFIX}.${client.id}.${refresh}`,
  };
}

/**
 * New access token on the grant; keeps the few newest unexpired ones valid.
 *
 * @param {ExternalMcpClient} client Mutated in place; the caller writes the list.
 * @param {number} now
 * @returns {string}
 */
function mintAccessToken(client, now) {
  const access = randomBytes(32).toString('base64url');
  client.accessTokens = [
    ...(client.accessTokens || []).filter((row) => Date.parse(row.expiresAt) > now),
    { hash: hashSecret(access), expiresAt: new Date(now + EXTERNAL_MCP_OAUTH_ACCESS_TTL_MS).toISOString() },
  ].slice(-OAUTH_ACCESS_TOKENS_KEPT);
  return `${EXTERNAL_MCP_OAUTH_ACCESS_PREFIX}.${client.id}.${access}`;
}

/**
 * Idle expiry counted from `now`, never past the grant's absolute cap.
 *
 * @param {ExternalMcpClient} client
 * @param {number} now
 */
function slidingExpiry(client, now) {
  const cap = client.absoluteExpiresAt ? Date.parse(client.absoluteExpiresAt) : Infinity;
  return new Date(Math.min(now + EXTERNAL_MCP_OAUTH_IDLE_TTL_DAYS * DAY_MS, cap)).toISOString();
}

/**
 * @param {ExternalMcpClient | undefined} client
 * @param {string} oauthClientId
 * @param {number} now
 */
function assertUsableGrant(client, oauthClientId, now) {
  // Managed grants have no OAuth client and no refresh token; they are never exchanged.
  if (!client || client.kind !== 'oauth' || client.managed || client.oauthClientId !== oauthClientId) {
    throw new ExternalMcpClientError('Unknown or foreign grant', 400);
  }
  if (client.revokedAt) throw new ExternalMcpClientError('The grant was revoked', 400);
  if (Date.parse(client.expiresAt) <= now) throw new ExternalMcpClientError('The grant expired', 400);
}

/**
 * OAuth: first token pair after an authorization code exchange.
 *
 * @param {string} grantId
 * @param {string} oauthClientId
 * @param {{ now?: number }} [options]
 * @returns {ExternalMcpOAuthTokens}
 */
export function issueExternalMcpOAuthTokens(grantId, oauthClientId, { now = Date.now() } = /** @type {any} */ ({})) {
  const clients = readClients();
  const client = clients.find((row) => row.id === grantId);
  assertUsableGrant(client, oauthClientId, now);
  const tokens = mintOAuthTokens(/** @type {ExternalMcpClient} */ (client), now);
  writeClients(clients);
  return tokens;
}

/**
 * OAuth: exchange a refresh token for a new pair (rotation). A rotated token
 * presented again after the grace window revokes the grant.
 *
 * @param {unknown} refreshToken
 * @param {string} oauthClientId
 * @param {{ now?: number }} [options]
 * @returns {ExternalMcpOAuthTokens}
 */
export function refreshExternalMcpOAuthTokens(refreshToken, oauthClientId, { now = Date.now() } = /** @type {any} */ ({})) {
  const parsed = splitToken(refreshToken);
  if (!parsed || parsed.prefix !== EXTERNAL_MCP_OAUTH_REFRESH_PREFIX) throw new ExternalMcpClientError('Invalid refresh token', 400);
  const clients = readClients();
  const client = clients.find((row) => row.id === parsed.id);
  assertUsableGrant(client, oauthClientId, now);
  const grant = /** @type {ExternalMcpClient} */ (client);
  const hash = hashSecret(parsed.secret);
  if (!hashEquals(grant.refreshHash, hash)) {
    const reused = (grant.previousRefreshHashes || []).find((row) => hashEquals(row.hash, hash));
    if (reused && now - Date.parse(reused.rotatedAt) > OAUTH_REFRESH_REUSE_GRACE_MS) {
      grant.revokedAt = new Date(now).toISOString();
      writeClients(clients);
      throw new ExternalMcpClientError('Refresh token reuse detected; the grant was revoked', 400);
    }
    throw new ExternalMcpClientError('Invalid refresh token', 400);
  }
  const tokens = mintOAuthTokens(grant, now);
  writeClients(clients);
  return tokens;
}

/**
 * OAuth (RFC 7009): a refresh token revokes the whole grant, an access token
 * only itself. Unknown tokens are ignored.
 *
 * @param {unknown} token
 * @param {string} oauthClientId
 * @param {{ now?: number }} [options]
 */
export function revokeExternalMcpOAuthToken(token, oauthClientId, { now = Date.now() } = /** @type {any} */ ({})) {
  const parsed = splitToken(token);
  if (!parsed) return;
  const clients = readClients();
  const client = clients.find((row) => row.id === parsed.id);
  if (!client || client.kind !== 'oauth' || client.oauthClientId !== oauthClientId) return;
  const hash = hashSecret(parsed.secret);
  if (parsed.prefix === EXTERNAL_MCP_OAUTH_REFRESH_PREFIX && hashEquals(client.refreshHash, hash)) {
    if (!client.revokedAt) client.revokedAt = new Date(now).toISOString();
    writeClients(clients);
  } else if (parsed.prefix === EXTERNAL_MCP_OAUTH_ACCESS_PREFIX) {
    const kept = (client.accessTokens || []).filter((row) => !hashEquals(row.hash, hash));
    if (kept.length !== (client.accessTokens || []).length) {
      client.accessTokens = kept;
      writeClients(clients);
    }
  }
}

/**
 * Token file of a managed client (the bridge reads it via CRETLI_MCP_TOKEN_FILE).
 *
 * @param {string} id
 */
export function externalMcpManagedTokenPath(id) {
  return resolveDataPath(MANAGED_TOKEN_DIR, `${id}.token`);
}

/** @param {string} id */
function removeManagedTokenFile(id) {
  fs.rmSync(externalMcpManagedTokenPath(id), { force: true });
}

/**
 * Write a token file atomically, readable by the owner only.
 *
 * @param {string} filePath
 * @param {string} token
 */
function writeTokenFile(filePath, token) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

/**
 * Managed ("Connect" from Settings) client: the click of a logged-in person
 * is the consent. The token file is written right away.
 *
 * @param {{ name?: unknown, workspaceFolder?: unknown, mode?: unknown, installTarget?: string, installFolder?: string }} input
 * @param {{ now?: number }} [options]
 * @returns {{ client: ExternalMcpClientInfo, tokenFile: string }}
 */
export function createExternalMcpManagedClient(input, { now = Date.now() } = /** @type {any} */ ({})) {
  const { name, workspaceFolder, mode } = validateClientInput(input);
  const absoluteExpiresAt = now + EXTERNAL_MCP_OAUTH_MAX_TTL_DAYS * DAY_MS;
  /** @type {ExternalMcpClient} */
  const client = {
    id: randomUUID(),
    name,
    workspaceFolder,
    mode,
    kind: 'oauth',
    managed: true,
    oauthClientId: '',
    installTarget: String(input?.installTarget || ''),
    installFolder: String(input?.installFolder || ''),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + EXTERNAL_MCP_OAUTH_IDLE_TTL_DAYS * DAY_MS, absoluteExpiresAt)).toISOString(),
    absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    secretHash: '',
    accessTokens: [],
    refreshHash: '',
    previousRefreshHashes: [],
    tokenRenewedUntil: null,
  };
  const tokenFile = externalMcpManagedTokenPath(client.id);
  writeTokenFile(tokenFile, mintAccessToken(client, now));
  client.tokenRenewedUntil = new Date(now + EXTERNAL_MCP_OAUTH_ACCESS_TTL_MS).toISOString();
  writeClients([...readClients(), client]);
  return { client: toInfo(client), tokenFile };
}

/**
 * Active managed clients installed for the same target in the same folder;
 * a new "Connect" there replaces them.
 *
 * @param {string} installTarget
 * @param {string} installFolder
 * @param {{ now?: number }} [options]
 * @returns {string[]} ids
 */
export function findExternalMcpManagedClients(installTarget, installFolder, { now = Date.now() } = /** @type {any} */ ({})) {
  return readClients()
    .filter((row) => row.managed && !row.revokedAt && Date.parse(row.expiresAt) > now
      && row.installTarget === installTarget && row.installFolder === installFolder)
    .map((row) => row.id);
}

/**
 * Keep the token files of managed clients fresh: mint a new access token when
 * the current one has less than `EXTERNAL_MCP_MANAGED_RENEW_BEFORE_MS` left
 * (or the file is missing), and delete files of revoked or expired clients.
 *
 * @param {{ now?: number }} [options]
 * @returns {{ renewed: number, removed: number }}
 */
export function renewExternalMcpManagedTokens({ now = Date.now() } = /** @type {any} */ ({})) {
  const clients = readClients();
  let renewed = 0;
  let removed = 0;
  let dirty = false;
  for (const client of clients) {
    if (!client.managed) continue;
    const tokenFile = externalMcpManagedTokenPath(client.id);
    if (client.revokedAt || Date.parse(client.expiresAt) <= now) {
      if (fs.existsSync(tokenFile)) {
        removeManagedTokenFile(client.id);
        removed += 1;
      }
      continue;
    }
    const until = client.tokenRenewedUntil ? Date.parse(client.tokenRenewedUntil) : 0;
    if (until - now > EXTERNAL_MCP_MANAGED_RENEW_BEFORE_MS && fs.existsSync(tokenFile)) continue;
    writeTokenFile(tokenFile, mintAccessToken(client, now));
    client.tokenRenewedUntil = new Date(now + EXTERNAL_MCP_OAUTH_ACCESS_TTL_MS).toISOString();
    renewed += 1;
    dirty = true;
  }
  if (dirty) writeClients(clients);
  return { renewed, removed };
}

/**
 * Remember whether Cretli added the Claude Code tool-permission rule for this
 * managed client (`added`), so revoking it removes only a rule Cretli wrote.
 *
 * @param {string} id
 * @param {'added' | 'existing' | ''} value
 */
export function setExternalMcpClientToolPermission(id, value) {
  const clients = readClients();
  const client = clients.find((row) => row.id === id);
  if (!client) return;
  if (value) client.claudeToolPermission = value;
  else delete client.claudeToolPermission;
  writeClients(clients);
}

/**
 * Store the Claude Code permission grant (profile and the rules Cretli added)
 * of a managed client. Clears the pre-profile `claudeToolPermission` marker,
 * which migrates lazily; `null` clears the grant (the client then needs nothing).
 *
 * @param {string} id
 * @param {Record<string, any> | null} grant
 */
export function setExternalMcpClientPermissionGrant(id, grant) {
  const clients = readClients();
  const client = clients.find((row) => row.id === id);
  if (!client) return;
  delete client.claudeToolPermission;
  if (grant) client.claudePermissionGrant = { profile: grant.profile, addedRules: grant.addedRules, defaultMode: grant.defaultMode };
  else delete client.claudePermissionGrant;
  writeClients(clients);
}

/**
 * Record rules (and `defaultMode` ownership) handed over by a released client
 * on the clients that keep needing them.
 *
 * @param {{ rules: Array<{ clientId: string, rule: string, list: 'allow' | 'ask' | 'deny' }>, defaultMode: { clientId: string, previous: string | null } | null }} transfer
 * @param {(row: Record<string, any>) => Record<string, any>} readGrant converts a row into its effective grant
 */
export function transferExternalMcpClientPermissions(transfer, readGrant) {
  const clients = readClients();
  let dirty = false;
  for (const { clientId, rule, list } of transfer.rules) {
    const client = clients.find((row) => row.id === clientId);
    if (!client) continue;
    const grant = readGrant(client);
    if (!grant.addedRules[list].includes(rule)) grant.addedRules[list].push(rule);
    delete client.claudeToolPermission;
    client.claudePermissionGrant = grant;
    dirty = true;
  }
  if (transfer.defaultMode) {
    const client = clients.find((row) => row.id === transfer.defaultMode?.clientId);
    if (client) {
      const grant = readGrant(client);
      grant.defaultMode = { owned: true, previous: transfer.defaultMode.previous };
      delete client.claudeToolPermission;
      client.claudePermissionGrant = grant;
      dirty = true;
    }
  }
  if (dirty) writeClients(clients);
}

/**
 * Live managed clients of a target/folder with their raw rows, oldest first.
 *
 * @param {string} installTarget
 * @param {string} installFolder
 * @returns {ExternalMcpClientInfo[]}
 */
export function listLiveManagedClients(installTarget, installFolder) {
  const ids = new Set(findExternalMcpManagedClients(installTarget, installFolder));
  return readClients().filter((row) => ids.has(row.id)).map(toInfo).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Remember that Cretli approved the `cretli` project server in the folder's
 * Claude Code settings for this managed client (`added`), so revoking it takes
 * back only an approval Cretli wrote.
 *
 * @param {string} id
 * @param {'added' | ''} value
 */
export function setExternalMcpClientServerApproval(id, value) {
  const clients = readClients();
  const client = clients.find((row) => row.id === id);
  if (!client) return;
  if (value) client.claudeServerApproval = value;
  else delete client.claudeServerApproval;
  writeClients(clients);
}
