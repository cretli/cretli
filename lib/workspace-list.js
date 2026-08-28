/**
 * Build the client workspace list from the registry and apply add/remove.
 */

import path from 'path';
import {
  addFileWorkspace,
  addFolderWorkspace,
  removeWorkspace,
  sanitizeWorkspaces,
  seedFileWorkspaces,
  toPosixPath,
} from './persist/workspace-registry.js';
import { sanitizeWorkspaceSidebarConfig } from './persist/settings-sidebar.js';
import { mergeFoldersForClient, syncFoldersFromFile } from './workspace-folders.js';
import { inspectWorkspacePath } from './workspace.js';

/**
 * @param {unknown} registry
 * @param {unknown} scannedFiles
 * @param {unknown} extraFiles
 * @returns {{ registry: ReturnType<typeof sanitizeWorkspaces>, seeded: boolean }}
 */
export function maybeSeedRegistry(registry, scannedFiles, extraFiles) {
  const existing = sanitizeWorkspaces(registry);
  if (existing.length > 0) return { registry: existing, seeded: false };
  const files = [...(Array.isArray(extraFiles) ? extraFiles : []), ...(Array.isArray(scannedFiles) ? scannedFiles : [])];
  const seeded = seedFileWorkspaces(files);
  return { registry: seeded, seeded: seeded.length > 0 };
}

/**
 * @param {{
 *   registry: unknown,
 *   sidebarConfig?: unknown,
 *   loadWorkspaceFn?: (file: string) => { workspaceDir?: string, folders?: Array<{ name: string, path: string, resolvedPath: string }> } | null,
 *   existsSet?: Set<string>
 * }} params
 * @returns {Array<object>}
 */
export function buildWorkspacesList(params) {
  const registry = sanitizeWorkspaces(params?.registry);
  const sidebarConfig = sanitizeWorkspaceSidebarConfig(params?.sidebarConfig);
  const loadWorkspaceFn = typeof params?.loadWorkspaceFn === 'function' ? params.loadWorkspaceFn : () => null;
  const existsSet = params?.existsSet instanceof Set ? params.existsSet : undefined;
  return registry.map((entry) => {
    const sidebar = sidebarConfig[entry.id] || {};
    if (entry.kind === 'file') {
      const loaded = loadWorkspaceFn(entry.workspaceFile || entry.id);
      const fileFolders = loaded?.folders || [];
      const overlay = sidebar.folders && Object.keys(sidebar.folders).length > 0
        ? sidebar.folders
        : syncFoldersFromFile(fileFolders, {});
      const folders = mergeFoldersForClient({ fileFolders, overlayFolders: overlay, existsSet });
      const workspaceFile = entry.workspaceFile || entry.id;
      const workspaceDir = toPosixPath(loaded?.workspaceDir || path.posix.dirname(workspaceFile));
      return {
        id: entry.id,
        kind: 'file',
        workspaceFile,
        name: sidebar.label || entry.label || path.posix.basename(workspaceFile, '.code-workspace'),
        workspaceDir,
        folders,
      };
    }
    const folders = mergeFoldersForClient({
      fileFolders: [],
      overlayFolders: sidebar.folders,
      existsSet,
    });
    const first = folders.find((folder) => folder.enabled) || folders[0];
    return {
      id: entry.id,
      kind: 'folders',
      workspaceFile: entry.id,
      name: sidebar.label || entry.label || first?.name || 'Workspace',
      workspaceDir: first?.resolvedPath || '',
      folders,
    };
  });
}

/**
 * @param {object} settings
 * @param {string} rawPath
 * @returns {{ ok: boolean, error?: string }}
 */
export function applyWorkspaceAddPath(settings, rawPath, options = {}) {
  const inspected = inspectWorkspacePath(rawPath, options);
  if (!inspected.ok) return { ok: false, error: inspected.error || 'invalid' };
  const current = sanitizeWorkspaces(settings.workspaces);
  const wasEmpty = current.length === 0;
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  if (inspected.kind === 'file') {
    settings.workspaces = addFileWorkspace(current, inspected.workspaceFile);
    if (wasEmpty) {
      settings.workspaceFile = inspected.workspaceFile;
      if (!settings.workspaceFolder) {
        settings.workspaceFolder = path.posix.dirname(inspected.workspaceFile);
      }
    }
    return { ok: true };
  }
  const folder = toPosixPath(inspected.folder || '');
  if (!folder) return { ok: false, error: 'invalid' };
  const next = addFolderWorkspace(current, { label: inspected.name });
  const added = next.find((entry) => !current.some((prev) => prev.id === entry.id)) || next[next.length - 1];
  settings.workspaces = next;
  const prevEntry = sidebar[added.id] || {};
  sidebar[added.id] = {
    ...prevEntry,
    folder,
    folders: {
      ...(prevEntry.folders || {}),
      [folder]: {
        enabled: true,
        name: inspected.name || path.posix.basename(folder),
        source: 'cretli',
      },
    },
  };
  settings.workspaceSidebarConfig = sidebar;
  if (wasEmpty) {
    settings.workspaceFile = added.id;
    settings.workspaceFolder = folder;
  }
  return { ok: true };
}

/**
 * @param {object} settings
 * @param {string} id
 * @returns {{ ok: boolean, error?: string }}
 */
export function applyWorkspaceRemoveId(settings, id) {
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: 'missing' };
  settings.workspaces = removeWorkspace(settings.workspaces, key);
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  delete sidebar[key];
  for (const cloneKey of Object.keys(sidebar)) {
    if (cloneKey.startsWith(`${key}#clone-`)) delete sidebar[cloneKey];
  }
  settings.workspaceSidebarConfig = Object.keys(sidebar).length > 0 ? sidebar : undefined;
  if (toPosixPath(settings.workspaceFile || '') === toPosixPath(key) || settings.workspaceFile === key) {
    const fallback = settings.workspaces[0];
    if (fallback) {
      settings.workspaceFile = fallback.id;
      const fallbackFolder = sidebar?.[fallback.id]?.folder;
      if (fallbackFolder) settings.workspaceFolder = fallbackFolder;
      else if (fallback.kind === 'file') settings.workspaceFolder = path.posix.dirname(fallback.workspaceFile || fallback.id);
    } else {
      delete settings.workspaceFile;
      delete settings.workspaceFolder;
    }
  }
  return { ok: true };
}
