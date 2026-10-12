/**
 * Durable route ids for workspace view URLs (RouteState v1 context).
 *
 * A view URL must never contain a filesystem path, a hash or a slug, so the
 * server mints opaque UUIDs for a workspace and for each of its folders/clones
 * and keeps them in `data/config.json` (`workspaceRouteKeys`).
 *
 * Identity rules the navigation plan depends on:
 * - a folders-kind workspace already has a durable id (`cretli:ws:<uuid>`), so it
 *   is reused as the workspace route key instead of minting a second one;
 * - a `.code-workspace` file keeps its legacy registry id (the file path), and
 *   gets an additional route UUID, so old APIs, saved chats and the sidebar keep
 *   working;
 * - a removed id is dropped and never re-points at another project: re-adding the
 *   same path mints a fresh id;
 * - converting a `.code-workspace` into a Cretli workspace carries its folder ids
 *   over to the new key, and a label or clone-row rename changes no id, because a
 *   folder key hangs off (workspace route key, folder path) — never off a name.
 */

import { randomUUID } from 'node:crypto';
import { isFolderWorkspaceId, sanitizeWorkspaces, toPosixPath } from './workspace-registry.js';

export const WORKSPACE_ROUTE_KEYS_VERSION = 1;

const ROUTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {{
 *   version: number,
 *   workspaces: Record<string, string>,
 *   folders: Record<string, Record<string, string>>
 * }} WorkspaceRouteKeys
 */

/**
 * @returns {string}
 */
export function createWorkspaceRouteId() {
  return randomUUID();
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isWorkspaceRouteId(id) {
  return typeof id === 'string' && ROUTE_ID_PATTERN.test(id.trim());
}

/**
 * @param {unknown} raw
 * @returns {WorkspaceRouteKeys}
 */
export function sanitizeWorkspaceRouteKeys(raw) {
  const next = { version: WORKSPACE_ROUTE_KEYS_VERSION, workspaces: {}, folders: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next;
  const workspaces = raw.workspaces;
  if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    const used = new Set();
    for (const [rawId, rawKey] of Object.entries(workspaces)) {
      const id = toPosixPath(rawId) || String(rawId || '').trim();
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (!id || !isWorkspaceRouteId(key) || used.has(key)) continue;
      used.add(key);
      // A folders-kind workspace uses its own durable registry id as the route
      // key, so a stored mapping for one is stale by definition.
      if (isFolderWorkspaceId(id)) continue;
      next.workspaces[id] = key;
    }
  }
  const folders = raw.folders;
  if (folders && typeof folders === 'object' && !Array.isArray(folders)) {
    for (const [rawWorkspaceKey, rawMap] of Object.entries(folders)) {
      const workspaceKey = String(rawWorkspaceKey || '').trim();
      if (!workspaceKey || !rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) continue;
      const used = new Set();
      /** @type {Record<string, string>} */
      const map = {};
      for (const [rawPath, rawKey] of Object.entries(rawMap)) {
        const folderPath = toPosixPath(rawPath);
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (!folderPath || !isWorkspaceRouteId(key) || used.has(key)) continue;
        used.add(key);
        map[folderPath] = key;
      }
      if (Object.keys(map).length > 0) next.folders[workspaceKey] = map;
    }
  }
  return next;
}

/**
 * Route key of a workspace row: the existing `cretli:ws:<uuid>` id for a folders
 * workspace, the stored (or freshly minted) UUID for a `.code-workspace` file.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {{ id?: string, kind?: string }} entry
 * @param {{ create?: (id: string) => string }} [options]
 * @returns {string}
 */
export function workspaceRouteKey(store, entry, options = {}) {
  const id = String(entry?.id || '').trim();
  if (!id) return '';
  if (entry.kind === 'folders' || isFolderWorkspaceId(id)) return id;
  const existing = store?.workspaces?.[id] || '';
  if (existing) return existing;
  if (options.create === false) return '';
  const created = typeof options.create === 'function'
    ? options.create(id)
    : createWorkspaceRouteId();
  if (!isWorkspaceRouteId(created)) return '';
  store.workspaces[id] = created;
  return created;
}

/**
 * Route key of one folder (or clone folder) inside a workspace.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {string} workspaceKey
 * @param {string} folderPath
 * @param {{ create?: (folderPath: string) => string }} [options]
 * @returns {string}
 */
export function folderRouteKey(store, workspaceKey, folderPath, options = {}) {
  const key = String(workspaceKey || '').trim();
  const path = toPosixPath(folderPath);
  if (!key || !path) return '';
  const map = store.folders[key] || (store.folders[key] = {});
  const existing = map[path];
  if (existing) return existing;
  if (options.create === false) return '';
  const created = typeof options.create === 'function'
    ? options.create(path)
    : createWorkspaceRouteId();
  if (!isWorkspaceRouteId(created)) return '';
  map[path] = created;
  return created;
}

/**
 * Reverse lookup: the legacy registry id a workspace route key points at.
 * Folders-kind workspaces answer with their own id, so the caller must still
 * check the registry — an id that is no longer registered resolves to null and
 * is never re-pointed at a similar project.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {unknown} registry
 * @param {unknown} workspaceKey
 * @returns {{ id: string, kind: 'file' | 'folders', workspaceFile: string } | null}
 */
export function findWorkspaceByRouteKey(store, registry, workspaceKey) {
  const key = typeof workspaceKey === 'string' ? workspaceKey.trim() : '';
  if (!key) return null;
  const registryList = sanitizeWorkspaces(registry);
  if (isFolderWorkspaceId(key)) {
    const entry = registryList.find((item) => item.id === key);
    if (!entry) return null;
    return { id: entry.id, kind: 'folders', workspaceFile: entry.id };
  }
  if (!isWorkspaceRouteId(key)) return null;
  for (const entry of registryList) {
    if (entry.kind !== 'file') continue;
    if ((store?.workspaces || {})[entry.id] === key) {
      return { id: entry.id, kind: 'file', workspaceFile: entry.workspaceFile || entry.id };
    }
  }
  return null;
}

/**
 * Reverse lookup of a folder route key inside a resolved workspace. Returns null
 * when the key belongs to another workspace or to a removed folder, so a stale
 * `folder=` can never select a directory of a different project.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {string} workspaceKey
 * @param {unknown} folderKey
 * @param {string[]} candidatePaths folder paths the workspace actually offers
 * @returns {string}
 */
export function findFolderByRouteKey(store, workspaceKey, folderKey, candidatePaths) {
  const key = String(workspaceKey || '').trim();
  const wanted = typeof folderKey === 'string' ? folderKey.trim() : '';
  if (!key || !wanted || !isWorkspaceRouteId(wanted)) return '';
  const map = store?.folders?.[key] || {};
  const paths = Array.isArray(candidatePaths) ? candidatePaths : [];
  for (const rawPath of paths) {
    const folderPath = toPosixPath(rawPath);
    if (!folderPath) continue;
    if (map[folderPath] === wanted) return folderPath;
  }
  return '';
}

/**
 * Drop everything a removed workspace owned. A route key that was removed is
 * never handed to another project.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {string} legacyId
 * @returns {boolean} whether the store changed
 */
export function dropWorkspaceRouteKeys(store, legacyId) {
  const id = toPosixPath(legacyId) || String(legacyId || '').trim();
  if (!id) return false;
  const workspaceKey = store.workspaces[id];
  const hadMapping = Object.prototype.hasOwnProperty.call(store.workspaces, id);
  const hadFileFolderMap = Boolean(workspaceKey)
    && Object.prototype.hasOwnProperty.call(store.folders, workspaceKey);
  // A folders workspace owns its folder map under its own registry id.
  const hadOwnFolderMap = Object.prototype.hasOwnProperty.call(store.folders, id);
  if (!hadMapping && !hadFileFolderMap && !hadOwnFolderMap) return false;
  if (hadMapping) delete store.workspaces[id];
  if (workspaceKey) delete store.folders[workspaceKey];
  delete store.folders[id];
  return true;
}

/**
 * A `.code-workspace` converted into a Cretli (folders) workspace keeps its
 * folders: the folder map moves from the file's route UUID to the new
 * `cretli:ws:<uuid>` key and the file's UUID is retired.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {string} fileWorkspaceId
 * @param {string} foldersWorkspaceId
 * @returns {boolean}
 */
export function convertWorkspaceRouteKeys(store, fileWorkspaceId, foldersWorkspaceId) {
  const fileId = toPosixPath(fileWorkspaceId) || String(fileWorkspaceId || '').trim();
  const nextId = String(foldersWorkspaceId || '').trim();
  if (!fileId || !isFolderWorkspaceId(nextId)) return false;
  const oldKey = store.workspaces[fileId];
  let changed = false;
  if (oldKey) {
    delete store.workspaces[fileId];
    changed = true;
  }
  const map = oldKey ? store.folders[oldKey] : undefined;
  if (map) {
    delete store.folders[oldKey];
    store.folders[nextId] = map;
    changed = true;
  }
  return changed;
}

/**
 * Forget workspaces and folders that are no longer registered, so a config that
 * was edited or a workspace removed elsewhere cannot leave a resolvable id.
 *
 * @param {WorkspaceRouteKeys} store
 * @param {unknown} registry
 * @param {(workspaceKey: string, folderPath: string) => boolean} isFolderPresent
 * @returns {boolean}
 */
export function pruneWorkspaceRouteKeys(store, registry, isFolderPresent = null) {
  const registryIds = new Set(sanitizeWorkspaces(registry).map((entry) => entry.id));
  let changed = false;
  for (const id of Object.keys(store.workspaces)) {
    if (registryIds.has(id)) continue;
    const key = store.workspaces[id];
    delete store.workspaces[id];
    if (store.folders[key]) {
      delete store.folders[key];
      changed = true;
    }
    changed = true;
  }
  for (const workspaceKey of Object.keys(store.folders)) {
    const known = isFolderWorkspaceId(workspaceKey)
      ? registryIds.has(workspaceKey)
      : Object.values(store.workspaces).includes(workspaceKey);
    if (!known) {
      delete store.folders[workspaceKey];
      changed = true;
      continue;
    }
    if (typeof isFolderPresent !== 'function') continue;
    const map = store.folders[workspaceKey];
    for (const folderPath of Object.keys(map)) {
      if (isFolderPresent(workspaceKey, folderPath)) continue;
      delete map[folderPath];
      changed = true;
    }
    if (Object.keys(map).length === 0) {
      delete store.folders[workspaceKey];
      changed = true;
    }
  }
  return changed;
}
