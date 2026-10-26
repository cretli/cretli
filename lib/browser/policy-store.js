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
import { normalizeOrigin, normalizePolicy } from './url-policy.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';

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
 * Maps a runtime scope key onto the key its policy is stored under.
 *
 * A chat that only carries a folder (Watcher cycles, folder-scoped chats) has
 * no `.code-workspace` key of its own, while the Settings panel usually edits
 * the registry workspace that folder belongs to. The folder key keeps priority
 * when it has its own entry; otherwise the policy of the registry workspace
 * containing that folder is used, but only when exactly one such workspace has
 * a stored policy (several candidates are never guessed, so nothing widens).
 *
 * @param {string} dataDir
 * @param {unknown} workspaceKey workspace file/id or folder path
 * @param {Record<string, any> | null | undefined} settings app settings with the workspace registry
 * @returns {string} the key to read/write, or '' when none was given
 */
export function resolveBrowserPolicyKey(dataDir, workspaceKey, settings) {
  const raw = String(workspaceKey ?? '').trim();
  const key = normalizeWorkspaceKey(raw);
  if (!key) return '';
  const store = loadPolicyStore(dataDir);
  if (store.workspaces[key]) return raw;
  const withPolicy = listRegisteredWorkspacesForFolder(settings || {}, key)
    .filter((entry) => store.workspaces[normalizeWorkspaceKey(entry.id)]);
  return withPolicy.length === 1 ? withPolicy[0].id : raw;
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
    recordHar: incoming.recordHar !== undefined
      ? incoming.recordHar
      : current.recordHar,
  });
  store.workspaces[key] = merged;
  savePolicyStore(dataDir, store);
  return merged;
}

/**
 * Adds one origin to a workspace allowlist (idempotent) and persists it.
 * Used by the navigation consent prompt's "always allow" answer.
 * @param {string} dataDir
 * @param {unknown} workspaceKey workspace file/id or folder path
 * @param {string} origin
 * @param {Record<string, any> | null | undefined} [settings]
 * @returns {import('./url-policy.js').BrowserPolicy}
 */
export function addAllowedOrigin(dataDir, workspaceKey, origin, settings) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) throw new Error('origin required');
  const key = resolveBrowserPolicyKey(dataDir, workspaceKey, settings);
  const current = getWorkspacePolicy(dataDir, key);
  if (current.allowedOrigins.includes(normalized)) return current;
  return setWorkspacePolicy(dataDir, key, { allowedOrigins: [...current.allowedOrigins, normalized] });
}
