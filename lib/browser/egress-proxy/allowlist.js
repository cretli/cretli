/**
 * Resolves a proxy session token to workspace policy for egress decisions.
 * Unknown or missing credentials fail closed (deny).
 */

import fs from 'node:fs';
import { getWorkspacePolicy } from '../policy-store.js';
import { normalizePolicy } from '../url-policy.js';

/**
 * @typedef {Object} EgressSessionContext
 * @property {string} workspaceKey
 * @property {import('../url-policy.js').BrowserPolicy} policy
 * @property {string} token
 */

/**
 * @param {string} policyFile
 * @returns {{ v: number, sessions: Record<string, { workspaceKey?: string, policy?: unknown }> }}
 */
function loadPolicyFile(policyFile) {
  if (!policyFile || !fs.existsSync(policyFile)) {
    return { v: 1, sessions: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    const sessions = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {};
    return { v: 1, sessions };
  } catch {
    return { v: 1, sessions: {} };
  }
}

/**
 * @param {{
 *   dataDir: string,
 *   policyFile?: string,
 *   policyFileCache?: { v: number, sessions: Record<string, unknown> },
 * }} options
 */
export function createSessionResolver(options) {
  const dataDir = String(options.dataDir || '');
  const policyFile = String(options.policyFile || '').trim();
  /** @type {{ v: number, sessions: Record<string, { workspaceKey?: string, policy?: unknown }> } | null} */
  let fileStore = options.policyFileCache ?? null;

  const reloadFile = () => {
    if (!policyFile) {
      fileStore = { v: 1, sessions: {} };
      return;
    }
    fileStore = loadPolicyFile(policyFile);
  };
  if (!fileStore) reloadFile();

  /**
   * Parses Proxy-Authorization (Basic) or Playwright-style credentials.
   * @param {string|undefined} authorizationHeader
   * @param {{ username?: string, password?: string }} [playwrightCreds]
   * @returns {string}
   */
  function extractToken(authorizationHeader, playwrightCreds) {
    const header = String(authorizationHeader ?? '').trim();
    if (header.toLowerCase().startsWith('basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon === -1) return decoded.trim();
        const user = decoded.slice(0, colon).trim();
        const pass = decoded.slice(colon + 1).trim();
        return pass || user;
      } catch {
        return '';
      }
    }
    if (playwrightCreds?.password) return String(playwrightCreds.password).trim();
    if (playwrightCreds?.username) return String(playwrightCreds.username).trim();
    return '';
  }

  /**
   * @param {string|undefined} authorizationHeader
   * @param {{ username?: string, password?: string }} [playwrightCreds]
   * @returns {EgressSessionContext|null}
   */
  function resolveSession(authorizationHeader, playwrightCreds) {
    const token = extractToken(authorizationHeader, playwrightCreds);
    if (!token) return null;
    if (policyFile) reloadFile();
    const entry = fileStore?.sessions?.[token];
    if (entry && typeof entry === 'object') {
      const workspaceKey = String(entry.workspaceKey ?? '').trim();
      if (entry.policy !== undefined) {
        return {
          token,
          workspaceKey,
          policy: normalizePolicy(entry.policy),
        };
      }
      if (workspaceKey && dataDir) {
        return {
          token,
          workspaceKey,
          policy: getWorkspacePolicy(dataDir, workspaceKey),
        };
      }
    }
    return null;
  }

  return { resolveSession, reloadFile };
}
