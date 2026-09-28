/**
 * Per-workspace Browser URL policy persistence.
 *
 * Stored next to the other Cretli runtime data as `browser-policy.json`.
 * The default policy is empty: nothing is reachable until the user (or a
 * future settings UI) allows an explicit origin/port for the workspace.
 */

import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { normalizePolicy } from './url-policy.js';

const POLICY_FILE = 'browser-policy.json';

/**
 * @param {unknown} workspaceKey
 * @returns {string}
 */
export function normalizeWorkspaceKey(workspaceKey) {
  const raw = String(workspaceKey ?? '').trim();
  if (!raw) return '';
  return path.resolve(raw);
}

/**
 * @param {string} dataDir
 * @returns {{ v: number, workspaces: Record<string, unknown> }}
 */
export function loadPolicyStore(dataDir) {
  const file = path.join(String(dataDir || ''), POLICY_FILE);
  if (!fs.existsSync(file)) return { v: 1, workspaces: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const workspaces = raw && typeof raw.workspaces === 'object' && raw.workspaces ? raw.workspaces : {};
    return { v: 1, workspaces };
  } catch {
    return { v: 1, workspaces: {} };
  }
}

/**
 * @param {string} dataDir
 * @param {{ v: number, workspaces: Record<string, unknown> }} store
 */
function savePolicyStore(dataDir, store) {
  const dir = String(dataDir || '');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, POLICY_FILE), { v: 1, workspaces: store.workspaces }, 'utf8');
}

/**
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @returns {import('./url-policy.js').BrowserPolicy}
 */
export function getWorkspacePolicy(dataDir, workspaceKey) {
  const key = normalizeWorkspaceKey(workspaceKey);
  if (!key) return normalizePolicy(null);
  const store = loadPolicyStore(dataDir);
  return normalizePolicy(store.workspaces[key]);
}

/**
 * Merges a patch into the workspace policy and persists it.
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {unknown} patch
 * @returns {import('./url-policy.js').BrowserPolicy}
 */
export function setWorkspacePolicy(dataDir, workspaceKey, patch) {
  const key = normalizeWorkspaceKey(workspaceKey);
  if (!key) throw new Error('workspaceKey required');
  const store = loadPolicyStore(dataDir);
  const current = normalizePolicy(store.workspaces[key]);
  const incoming = patch && typeof patch === 'object' ? /** @type {Record<string, unknown>} */ (patch) : {};
  const merged = normalizePolicy({
    allowedOrigins: incoming.allowedOrigins !== undefined ? incoming.allowedOrigins : current.allowedOrigins,
    blockedPorts: incoming.blockedPorts !== undefined ? incoming.blockedPorts : current.blockedPorts,
    unblockedPorts: incoming.unblockedPorts !== undefined ? incoming.unblockedPorts : current.unblockedPorts,
    allowLocalhost: incoming.allowLocalhost !== undefined ? incoming.allowLocalhost : current.allowLocalhost,
    allowPrivateNetwork: incoming.allowPrivateNetwork !== undefined
      ? incoming.allowPrivateNetwork
      : current.allowPrivateNetwork,
    allowSelfOrigin: incoming.allowSelfOrigin !== undefined
      ? incoming.allowSelfOrigin
      : current.allowSelfOrigin,
    allowInsecureTls: incoming.allowInsecureTls !== undefined
      ? incoming.allowInsecureTls
      : current.allowInsecureTls,
  });
  store.workspaces[key] = merged;
  savePolicyStore(dataDir, store);
  return merged;
}
