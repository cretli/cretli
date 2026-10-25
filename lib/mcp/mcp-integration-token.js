/**
 * Limited MCP integration tokens. Distinct from widget access tokens.
 * Bound to session/workspace/harness; Plan is checked on the Cretli side.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * @returns {string}
 */
function secretsFile() {
  return resolveDataPath('mcp-integration-secret.json');
}

/**
 * @returns {string}
 */
function loadHmacSecret() {
  const filePath = secretsFile();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof parsed?.secret === 'string' && parsed.secret.length >= 32) return parsed.secret;
    } catch {
      // Recreate below.
    }
  }
  const secret = randomBytes(32).toString('hex');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(filePath, { secret });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
  return secret;
}

/**
 * Mint a token. Optional `attemptId` / `delegationId` become immutable signed
 * claims naming the delegation round the bridge was spawned for; they are
 * omitted when empty, and tokens without them (older or non-delegated) keep
 * verifying.
 *
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function mintMcpIntegrationToken(payload) {
  /** @type {Record<string, any>} */
  const body = {
    v: 1,
    sessionId: String(payload.sessionId || '').trim(),
    chatId: String(payload.chatId || '').trim(),
    workspaceId: String(payload.workspaceId || '').trim(),
    workspaceFile: String(payload.workspaceFile || '').trim(),
    workspaceFolder: String(payload.workspaceFolder || '').trim(),
    harness: String(payload.harness || '').trim(),
    scope: payload.scope === 'builtin' ? 'builtin' : 'session',
    incarnation: String(payload.incarnation || payload.inc || '').trim(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const attemptId = String(payload.attemptId || '').trim();
  const delegationId = String(payload.delegationId || '').trim();
  if (attemptId) body.attemptId = attemptId;
  if (delegationId) body.delegationId = delegationId;
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = createHmac('sha256', loadHmacSecret()).update(encoded).digest('base64url');
  return `mcp1.${encoded}.${mac}`;
}

/**
 * @param {unknown} token
 * @returns {Record<string, any>}
 */
export function verifyMcpIntegrationToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'mcp1') {
    throw new Error('Invalid MCP integration token');
  }
  const expected = createHmac('sha256', loadHmacSecret()).update(parts[1]).digest('base64url');
  const actualBuf = Buffer.from(parts[2]);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error('Invalid MCP integration token');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid MCP integration token');
  }
  if (!payload || payload.v !== 1) throw new Error('Invalid MCP integration token');
  if (!String(payload.incarnation || payload.inc || '').trim()) {
    throw new Error('Invalid MCP integration token');
  }
  if (Number(payload.exp) < Date.now()) throw new Error('MCP integration token expired');
  return payload;
}

/**
 * @param {unknown} token
 * @returns {boolean}
 */
export function isMcpIntegrationToken(token) {
  return String(token || '').startsWith('mcp1.');
}
