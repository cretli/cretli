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
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const EXTERNAL_MCP_TOKEN_PREFIX = 'cmx1';
/**
 * `plan` exposes read-only tools (Plan policy); `agent` exposes everything;
 * `operator` is `agent` plus the operator tools that act for the user
 * (approve a plan, message a chat; lib/mcp/mcp-external-operator-tools.js).
 */
export const EXTERNAL_MCP_MODES = Object.freeze(/** @type {const} */ (['plan', 'agent', 'operator']));
export const EXTERNAL_MCP_DEFAULT_TTL_DAYS = 30;
export const EXTERNAL_MCP_MAX_TTL_DAYS = 365;
const NAME_MAX_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `lastUsedAt` is persisted at most this often per client. */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

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
  const { secretHash: _secretHash, ...info } = client;
  return info;
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
    mode: /** @type {ExternalMcpMode} */ (mode),
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
 * Authenticate an external client and record its use.
 *
 * @param {unknown} token
 * @param {{ now?: number }} [options]
 * @returns {ExternalMcpClientInfo}
 */
export function verifyExternalMcpToken(token, { now = Date.now() } = /** @type {any} */ ({})) {
  const invalid = new ExternalMcpClientError('Invalid MCP client token', 401);
  if (!isExternalMcpToken(token)) throw invalid;
  const parts = String(token).split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw invalid;
  const clients = readClients();
  const client = clients.find((row) => row.id === parts[1]);
  if (!client) throw invalid;
  const expected = Buffer.from(client.secretHash, 'hex');
  const actual = Buffer.from(hashSecret(parts[2]), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid;
  if (client.revokedAt) throw new ExternalMcpClientError('MCP client token was revoked', 401);
  if (Date.parse(client.expiresAt) <= now) throw new ExternalMcpClientError('MCP client token expired', 401);

  const lastUsed = client.lastUsedAt ? Date.parse(client.lastUsedAt) : 0;
  if (now - lastUsed >= LAST_USED_WRITE_INTERVAL_MS) {
    client.lastUsedAt = new Date(now).toISOString();
    writeClients(clients);
  }
  return toInfo(client);
}
