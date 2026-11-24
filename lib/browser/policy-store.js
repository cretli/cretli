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
import { listRegisteredWorkspacesForFolder, resolveWorkspaceForFolder } from '../workspace-registry-service.js';
import { FOLDER_WORKSPACE_PREFIX, findWorkspace, sanitizeWorkspaces } from '../persist/workspace-registry.js';
import { normalizeWorkspaceKey } from './scope-key.js';
export { browserScopeKey, normalizeWorkspaceKey } from './scope-key.js';
import { loadWorkspace } from '../workspace.js';
import { workspaceRouteFolderPaths } from '../workspace-route-context.js';

const POLICY_FILE = 'browser-policy.json';

/**
 * @typedef {{ v: number, workspaces: Record<string, unknown>, legacyKeys: Record<string, unknown> }} PolicyStore
 */

/**
 * Loads the stored policies. `legacyKeys` holds quarantined entries that no
 * registered workspace owns; it is preserved on save and never applied.
 * @param {string} dataDir
 * @returns {PolicyStore}
 */
export function loadPolicyStore(dataDir) {
  const file = path.join(String(dataDir || ''), POLICY_FILE);
  const empty = () => ({ v: 1, workspaces: {}, legacyKeys: {} });
  if (!fs.existsSync(file)) return empty();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const workspaces = raw && typeof raw.workspaces === 'object' && raw.workspaces ? raw.workspaces : {};
    const legacyKeys = raw && typeof raw.legacyKeys === 'object' && raw.legacyKeys ? raw.legacyKeys : {};
    return { v: 1, workspaces, legacyKeys };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EACCES' && !(error instanceof SyntaxError)) throw error;
    return empty();
  }
}

/**
 * Extracts `cretli:ws:<uuid>` from a key that an older server joined onto its
 * working directory (`<cwd>/cretli:ws:<uuid>`). Plain ids and real folders
 * whose name merely looks similar yield ''.
 * @param {string} key
 * @returns {string}
 */
function legacyOpaqueWorkspaceId(key) {
  if (!path.isAbsolute(key)) return '';
  const id = path.basename(key);
  if (!id.startsWith(FOLDER_WORKSPACE_PREFIX)) return '';
  const suffix = id.slice(FOLDER_WORKSPACE_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix)
    ? id
    : '';
}

/**
 * Idempotent migration of keys mangled by `path.resolve` on a `cretli:ws:` id.
 * A mangled key whose id is registered moves to the plain id (an existing plain
 * entry wins); an unregistered one is quarantined under `legacyKeys`. Folder
 * entries are never merged into workspace entries.
 *
 * @param {string} dataDir
 * @param {Record<string, any> | null | undefined} settings app settings with the workspace registry
 * @returns {boolean} whether the file was rewritten
 */
export function migratePolicyStore(dataDir, settings) {
  const store = loadPolicyStore(dataDir);
  // Without a registry nothing can be classified; quarantining would park live entries for good.
  if (!Array.isArray(settings?.workspaces)) return false;
  const registered = new Set(sanitizeWorkspaces(settings.workspaces).map((entry) => entry.id));
  let changed = false;
  for (const [key, policy] of Object.entries(store.workspaces)) {
    const id = legacyOpaqueWorkspaceId(key);
    if (!id) continue;
    delete store.workspaces[key];
    changed = true;
    if (registered.has(id)) {
      store.workspaces[id] = mergePolicies(policy, store.workspaces[id]);
    } else {
      store.legacyKeys[key] = policy;
    }
  }
  if (changed) savePolicyStore(dataDir, store);
  return changed;
}

/** @param {unknown} left @param {unknown} right */
function mergePolicies(left, right) {
  const a = left && typeof left === 'object' ? left : {};
  const b = right && typeof right === 'object' ? right : {};
  return { ...a, ...b };
}

/**
 * @param {string} dataDir
 * @param {PolicyStore} store
 */
function savePolicyStore(dataDir, store) {
  const dir = String(dataDir || '');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = { v: 1, workspaces: store.workspaces };
  if (store.legacyKeys && Object.keys(store.legacyKeys).length) body.legacyKeys = store.legacyKeys;
  writeJsonAtomic(path.join(dir, POLICY_FILE), body, 'utf8');
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
  migratePolicyStore(dataDir, settings);
  const store = loadPolicyStore(dataDir);
  if (store.workspaces[key]) return raw;
  const withPolicy = listRegisteredWorkspacesForFolder(settings || {}, key)
    .filter((entry) => store.workspaces[normalizeWorkspaceKey(entry.id)]);
  return withPolicy.length === 1 ? withPolicy[0].id : raw;
}

/**
 * Resolve the runtime policy while allowing folder scopes to inherit consent to
 * the user's browser only from their single registered workspace. Ambiguous
 * registry membership never grants access to the user's Chrome profile; all
 * other fields retain the existing whole-entry policy priority.
 *
 * @param {string} dataDir
 * @param {unknown} workspaceKey
 * @param {Record<string, any> | null | undefined} settings
 * @returns {import('./url-policy.js').BrowserPolicy}
 */
export function resolveBrowserPolicy(dataDir, workspaceKey, settings) {
  const key = normalizeWorkspaceKey(workspaceKey);
  const policy = getWorkspacePolicy(dataDir, resolveBrowserPolicyKey(dataDir, workspaceKey, settings));
  if (!key) return policy;
  const registered = sanitizeWorkspaces(settings?.workspaces);
  if (registered.some((entry) => normalizeWorkspaceKey(entry.id) === key)) return policy;
  const workspace = resolveWorkspaceForFolder(settings || {}, key);
  const own = getWorkspacePolicy(dataDir, key);
  const parent = workspace ? getWorkspacePolicy(dataDir, workspace.id) : null;
  return {
    ...policy,
    allowExternalBrowser: own.allowExternalBrowser === true || parent?.allowExternalBrowser === true,
    allowClaudeChrome: own.allowClaudeChrome === true || parent?.allowClaudeChrome === true,
    allowCretliChromeExtension: own.allowCretliChromeExtension === true || parent?.allowCretliChromeExtension === true,
  };
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
    allowExternalBrowser: incoming.allowExternalBrowser !== undefined
      ? incoming.allowExternalBrowser
      : current.allowExternalBrowser,
    allowClaudeChrome: incoming.allowClaudeChrome !== undefined
      ? incoming.allowClaudeChrome
      : current.allowClaudeChrome,
    allowCretliChromeExtension: incoming.allowCretliChromeExtension !== undefined
      ? incoming.allowCretliChromeExtension
      : current.allowCretliChromeExtension,
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

/**
 * Folders of a registry workspace that carry a policy entry of their own;
 * those apply to folder-only chats and are shown in the panel.
 *
 * @param {string} dataDir
 * @param {string} workspaceId registry id of the workspace
 * @param {Record<string, any> | null | undefined} settings
 * @returns {string[]}
 */
export function listFolderOverrides(dataDir, workspaceId, settings) {
  if (!findWorkspace(settings?.workspaces, workspaceId)) return [];
  const store = loadPolicyStore(dataDir);
  return workspaceRouteFolderPaths(settings || {}, workspaceId, { loadWorkspaceFn: loadWorkspace })
    .map((folder) => path.resolve(folder))
    .filter((folder, index, all) => all.indexOf(folder) === index && store.workspaces[folder]);
}

/**
 * Removes the own policy entry of one folder.
 * @param {string} dataDir
 * @param {unknown} folder
 * @returns {boolean} whether an entry existed
 */
export function removeFolderPolicy(dataDir, folder) {
  const key = normalizeWorkspaceKey(folder);
  if (!key) return false;
  const store = loadPolicyStore(dataDir);
  if (!store.workspaces[key]) return false;
  delete store.workspaces[key];
  savePolicyStore(dataDir, store);
  return true;
}
