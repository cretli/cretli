/**
 * Build the client workspace list from the registry and apply add/remove.
 */

import fs from 'fs';
import path from 'path';
import {
  addFolderWorkspace,
  convertFileToFolderWorkspace,
  findWorkspace,
  removeWorkspace,
  sanitizeWorkspaces,
  seedFileWorkspaces,
  toPosixPath,
} from './persist/workspace-registry.js';
import { sanitizeWorkspaceSidebarConfig } from './persist/settings-sidebar.js';
import {
  convertWorkspaceRouteKeys,
  dropWorkspaceRouteKeys,
  sanitizeWorkspaceRouteKeys,
} from './persist/workspace-route-keys.js';
import {
  foldersForWriteback,
  mergeFoldersForClient,
  syncFoldersFromFile,
  writeNewWorkspaceFoldersJsonc,
} from './workspace-folders.js';
import { inspectWorkspacePath, loadWorkspace } from './workspace.js';

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
 * }} params  `loadWorkspaceFn` is an import-time aid only; the stored folder list is
 *   authoritative, so production callers omit it and no file is read per render.
 * @returns {Array<Record<string, any>>}
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
        fileExists: existsSet ? existsSet.has(workspaceFile) : fs.existsSync(workspaceFile),
        name: sidebar.label || entry.label || path.posix.basename(workspaceFile, '.code-workspace'),
        workspaceDir,
        folders,
        ...(entry.importedFrom ? { importedFrom: entry.importedFrom } : {}),
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
      ...(entry.importedFrom ? { importedFrom: entry.importedFrom } : {}),
    };
  });
}

/**
 * Copies folders from a .code-workspace file into the sidebar overlay when it is empty.
 *
 * @param {Record<string, any>} settings
 * @param {(file: string) => { folders?: Array<{ name?: string, resolvedPath?: string }> } | null} loadWorkspaceFn
 * @returns {boolean}
 */
export function seedMissingFileWorkspaceOverlays(settings, loadWorkspaceFn) {
  const loadFn = typeof loadWorkspaceFn === 'function' ? loadWorkspaceFn : loadWorkspace;
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  let changed = false;
  for (const entry of sanitizeWorkspaces(settings.workspaces)) {
    if (entry.kind !== 'file' || !entry.workspaceFile) continue;
    const existing = sidebar[entry.id]?.folders;
    if (existing && Object.keys(existing).length > 0) continue;
    const loaded = loadFn(entry.workspaceFile);
    const folders = syncFoldersFromFile(loaded?.folders || [], existing || {});
    if (Object.keys(folders).length === 0) continue;
    const prev = sidebar[entry.id] || {};
    sidebar[entry.id] = {
      ...prev,
      folders,
      folder: prev.folder || Object.keys(folders)[0],
    };
    changed = true;
  }
  if (changed) settings.workspaceSidebarConfig = sidebar;
  return changed;
}

/**
 * Overlay folder map built from the folders of a parsed `.code-workspace` file.
 *
 * @param {Array<{ name?: string, resolvedPath?: string }>} fileFolders
 * @returns {Record<string, { enabled: boolean, name: string, source: 'cretli' }>}
 */
function overlayFromImportedFolders(fileFolders) {
  /** @type {Record<string, { enabled: boolean, name: string, source: 'cretli' }>} */
  const folders = {};
  for (const folder of Array.isArray(fileFolders) ? fileFolders : []) {
    const key = toPosixPath(folder?.resolvedPath || '');
    if (!key || folders[key]) continue;
    folders[key] = {
      enabled: true,
      name: (typeof folder?.name === 'string' && folder.name.trim()) || path.posix.basename(key),
      // The folders belong to Cretli from the moment of the import.
      source: 'cretli',
    };
  }
  return folders;
}

/**
 * Import a `.code-workspace` file as a Cretli-owned workspace: the file is read once,
 * its folders are copied into the workspace definition, and its path is kept only as
 * `importedFrom` metadata. A second import of the same file is refused with
 * `duplicate_import` (plus the existing id) unless `confirmDuplicate` is set.
 *
 * @param {Record<string, any>} settings
 * @param {string} workspaceFile absolute POSIX path of the file
 * @param {{ label?: string, activate?: boolean, confirmDuplicate?: boolean, loadWorkspaceFn?: Function }} [options]
 * @returns {{ ok: boolean, error?: string, id?: string, kind?: 'folders', existingId?: string }}
 */
export function importWorkspaceFile(settings, workspaceFile, options = {}) {
  const file = toPosixPath(workspaceFile);
  if (!file) return { ok: false, error: 'invalid' };
  const current = sanitizeWorkspaces(settings.workspaces);
  const existing = current.find((entry) => entry.importedFrom === file || (entry.kind === 'file' && entry.id === file));
  if (existing && options.confirmDuplicate !== true) {
    return { ok: false, error: 'duplicate_import', existingId: existing.id };
  }
  const loadWorkspaceFn = typeof options.loadWorkspaceFn === 'function' ? options.loadWorkspaceFn : loadWorkspace;
  const loaded = loadWorkspaceFn(file);
  if (!loaded) return { ok: false, error: 'not_found' };
  const folders = overlayFromImportedFolders(loaded.folders);
  const label = typeof options.label === 'string' ? options.label.trim() : '';
  const next = addFolderWorkspace(current, { label: label || path.posix.basename(file, '.code-workspace') });
  const added = next.find((entry) => !current.some((prev) => prev.id === entry.id)) || next[next.length - 1];
  added.importedFrom = file;
  settings.workspaces = next;
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  const firstFolder = Object.keys(folders)[0] || '';
  sidebar[added.id] = {
    ...(firstFolder ? { folder: firstFolder } : {}),
    ...(Object.keys(folders).length > 0 ? { folders } : {}),
  };
  settings.workspaceSidebarConfig = sidebar;
  if (options.activate !== false) {
    settings.workspaceFile = added.id;
    if (firstFolder) settings.workspaceFolder = firstFolder;
  }
  return { ok: true, id: added.id, kind: 'folders' };
}

/**
 * Explicit "refresh from file": re-read the file a workspace was imported from and
 * add folders the workspace does not know yet. Existing folders keep their name,
 * order and enabled flag; nothing is removed. Never runs automatically.
 *
 * @param {Record<string, any>} settings
 * @param {string} workspaceId registry id (or any former id) of the workspace
 * @param {{ loadWorkspaceFn?: Function }} [options]
 * @returns {{ ok: boolean, error?: string, id?: string, added?: number }}
 */
export function applyWorkspaceRefreshFromFile(settings, workspaceId, options = {}) {
  const entry = findWorkspace(settings.workspaces, workspaceId);
  if (!entry) return { ok: false, error: 'not_found' };
  if (!entry.importedFrom) return { ok: false, error: 'not_imported' };
  const loadWorkspaceFn = typeof options.loadWorkspaceFn === 'function' ? options.loadWorkspaceFn : loadWorkspace;
  const loaded = loadWorkspaceFn(entry.importedFrom);
  if (!loaded) return { ok: false, error: 'file_missing' };
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  const prev = sidebar[entry.id] || {};
  const folders = { ...(prev.folders || {}) };
  let added = 0;
  for (const [key, meta] of Object.entries(overlayFromImportedFolders(loaded.folders))) {
    if (folders[key]) continue;
    folders[key] = meta;
    added += 1;
  }
  sidebar[entry.id] = { ...prev, folders, folder: prev.folder || Object.keys(folders)[0] };
  settings.workspaceSidebarConfig = sidebar;
  return { ok: true, id: entry.id, added };
}

/**
 * Registers a `.code-workspace` file or a folder in the workspace registry.
 *
 * `options.label` overrides the display label stored on the registry row.
 * `options.activate` (default true) also switches the active workspace to the
 * new row; the MCP registry tools pass false so an agent never moves the UI.
 *
 * @param {Record<string, any>} settings
 * @param {string} rawPath
 * @param {{ preferFolders?: boolean, label?: string, activate?: boolean, confirmDuplicate?: boolean, loadWorkspaceFn?: Function }} [options]
 * @returns {{ ok: boolean, error?: string, id?: string, kind?: 'file' | 'folders', existingId?: string }}
 */
export function applyWorkspaceAddPath(settings, rawPath, options = {}) {
  const inspected = inspectWorkspacePath(rawPath, options);
  if (!inspected.ok) return { ok: false, error: inspected.error || 'invalid' };
  const activate = options.activate !== false;
  const label = typeof options.label === 'string' ? options.label.trim() : '';
  const current = sanitizeWorkspaces(settings.workspaces);
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  if (inspected.kind === 'file') {
    return importWorkspaceFile(settings, inspected.workspaceFile, {
      ...options,
      label,
      activate,
    });
  }
  const folder = toPosixPath(inspected.folder || '');
  if (!folder) return { ok: false, error: 'invalid' };
  const next = addFolderWorkspace(current, { label: label || inspected.name });
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
  if (activate) {
    settings.workspaceFile = added.id;
    settings.workspaceFolder = folder;
  }
  return { ok: true, id: added.id, kind: 'folders' };
}

/**
 * Keep the durable view ids in step with a registry mutation. A removed
 * workspace's ids are dropped so an old URL never resolves to a different
 * project (and re-adding the same path mints a fresh id); a converted one carries
 * its folder ids over to the new `cretli:ws:` key.
 *
 * @param {Record<string, any>} settings
 * @param {(store: Record<string, any>) => boolean} mutate
 */
function maintainWorkspaceRouteKeys(settings, mutate) {
  const store = sanitizeWorkspaceRouteKeys(settings.workspaceRouteKeys);
  if (mutate(store)) settings.workspaceRouteKeys = store;
}

/**
 * @param {Record<string, any>} settings
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
  // An explicit empty object (not undefined) so the store clears the section.
  settings.workspaceSidebarConfig = sidebar;
  maintainWorkspaceRouteKeys(settings, (store) => dropWorkspaceRouteKeys(store, key));
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

/**
 * Converts a `.code-workspace` (file) workspace into a self-config folder
 * workspace (`cretli:ws:`). Folders are pulled from the file first (so nothing
 * is lost when the sidebar overlay is empty) and detached from the file
 * (source becomes 'cretli'). Sidebar clones of the old file are dropped.
 *
 * @param {Record<string, any>} settings
 * @param {string} fileId - registry id of the file workspace
 * @param {{ loadWorkspaceFn?: (file: string) => { folders?: Array<{ name?: string, resolvedPath?: string }> } | null }} [options]
 * @returns {{ ok: boolean, error?: string, id?: string }}
 */
export function applyWorkspaceConvertToSelf(settings, fileId, options = {}) {
  const key = toPosixPath(fileId) || String(fileId || '').trim();
  if (!key) return { ok: false, error: 'missing' };
  const loadWorkspaceFn = typeof options?.loadWorkspaceFn === 'function' ? options.loadWorkspaceFn : () => null;

  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  const oldEntry = sidebar[key] || {};
  const { registry, id, found } = convertFileToFolderWorkspace(settings.workspaces, key);
  if (!found || !id) return { ok: false, error: 'not_found' };

  // Pull the current file folders into the overlay so a conversion never loses them.
  let overlayFolders = oldEntry.folders || {};
  if (fs.existsSync(key) && key.endsWith('.code-workspace')) {
    const loaded = loadWorkspaceFn(key);
    const fileFolders = Array.isArray(loaded?.folders) ? loaded.folders : [];
    overlayFolders = syncFoldersFromFile(fileFolders, overlayFolders);
  }

  const folders = {};
  for (const [folderPath, meta] of Object.entries(overlayFolders || {})) {
    const norm = toPosixPath(folderPath);
    if (!norm) continue;
    folders[norm] = {
      enabled: meta?.enabled !== false,
      name: (typeof meta?.name === 'string' && meta.name.trim()) || path.posix.basename(norm),
      source: 'cretli',
    };
  }

  settings.workspaces = registry;
  const nextEntry = { ...oldEntry };
  delete nextEntry.workspaceFile;
  if (Object.keys(folders).length > 0) nextEntry.folders = folders;
  else delete nextEntry.folders;
  for (const cloneKey of Object.keys(sidebar)) {
    if (cloneKey.startsWith(`${key}#clone-`)) delete sidebar[cloneKey];
  }
  sidebar[id] = nextEntry;
  delete sidebar[key];
  // An explicit empty object (not undefined) so the store clears the section.
  settings.workspaceSidebarConfig = sidebar;
  maintainWorkspaceRouteKeys(settings, (store) => convertWorkspaceRouteKeys(store, key, id));

  const activeKey = toPosixPath(settings.workspaceFile || '');
  if (activeKey === key || settings.workspaceFile === key) {
    settings.workspaceFile = id;
    const enabled = Object.keys(folders).filter((folderPath) => folders[folderPath].enabled !== false);
    const currentFolder = settings.workspaceFolder ? toPosixPath(settings.workspaceFolder) : '';
    const nextFolder = (!currentFolder || !enabled.includes(currentFolder))
      ? (enabled[0] || (oldEntry.folder ? toPosixPath(oldEntry.folder) : ''))
      : currentFolder;
    if (nextFolder) settings.workspaceFolder = nextFolder;
    else delete settings.workspaceFolder;
  }
  return { ok: true, id };
}

/**
 * Exports a workspace's enabled folders into a `.code-workspace` file.
 *
 * - file workspace + no target → writes into its own file (explicit write-back),
 * - any workspace + targetFile → writes/creates that file with paths relative
 *   to the file location.
 *
 * @param {Record<string, any>} settings
 * @param {string} workspaceId - registry id (file or folders workspace)
 * @param {{ targetFile?: string }} [options]
 * @returns {{ ok: boolean, error?: string, file?: string }}
 */
export function applyWorkspaceExportToFile(settings, workspaceId, options = {}) {
  const key = toPosixPath(workspaceId) || String(workspaceId || '').trim();
  if (!key) return { ok: false, error: 'missing' };
  const entry = findWorkspace(settings.workspaces, key);
  if (!entry) return { ok: false, error: 'not_found' };

  const targetFile = options?.targetFile ? String(options.targetFile).trim() : '';
  const sourceFile = entry.kind === 'file' ? toPosixPath(entry.workspaceFile || '') : '';
  let filePath = '';
  if (targetFile) {
    filePath = targetFile;
  } else if (sourceFile) {
    filePath = sourceFile;
  } else {
    return { ok: false, error: 'missing_target' };
  }
  if (!filePath.endsWith('.code-workspace')) {
    return { ok: false, error: 'invalid_target' };
  }
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  const overlay = sidebar[key]?.folders || {};
  const baseDir = path.posix.dirname(filePath);
  const folders = foldersForWriteback(overlay, baseDir);
  try {
    writeNewWorkspaceFoldersJsonc(filePath, folders);
  } catch (err) {
    return { ok: false, error: err?.message || 'write_failed' };
  }
  return { ok: true, file: toPosixPath(filePath) };
}
