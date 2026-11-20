/**
 * `store.workspaces`: Cretli-owned workspace definitions in SQLite (`workspaces.sqlite`).
 *
 * The workspace registry (`settings.workspaces`), the sidebar overlay
 * (`settings.workspaceSidebarConfig`: default folder, folder list with order and
 * enabled flags), the durable route ids (`settings.workspaceRouteKeys`) and
 * `settings.additionalCursorContextDirs` used to live in `data/config.json`, and
 * `.code-workspace` entries re-read their folder list from the file on every render.
 * Now SQL is the only source for them. A `.code-workspace` file is read exactly
 * once, by an explicit import (or by the one-time config.json migration), and its
 * path is kept as `imported_from` metadata.
 *
 * The rest of the app keeps its settings-shaped API: `readSettingsView()` builds the
 * four sections from SQL and `replaceFromSettings()` writes them back, so
 * `loadSettings` / `saveSettings` stay the single entry point (see settings.js).
 * Todos, chats and delegations stay keyed by the working directory (default folder).
 *
 * The handle is synchronous (small tables, WAL) like the delegation store; it is not
 * part of the worker-owned consolidated store because settings are read synchronously.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, WORKSPACE_MIGRATIONS } from '../storage/migrations.js';
import { sanitizeWorkspaces, toPosixPath } from './workspace-registry.js';
import { sanitizeWorkspaceSidebarConfig } from './settings-sidebar.js';
import { sanitizeWorkspaceRouteKeys, WORKSPACE_ROUTE_KEYS_VERSION } from './workspace-route-keys.js';
import { mergeFoldersForClient } from '../workspace-folders.js';

export const WORKSPACES_DB_FILENAME = 'workspaces.sqlite';
const BUSY_TIMEOUT_MS = 8000;
/** Temporary legacy id while rows are renamed inside one transaction (never persisted). */
const PARKED_PREFIX = '~parked:';
const META_MIGRATED_AT = 'config_migrated_at';
const META_CONTEXT_DIRS = 'additional_cursor_context_dirs';

/** The four settings keys that now live in SQL instead of config.json. */
export const WORKSPACE_SETTINGS_KEYS = Object.freeze([
  'workspaces',
  'workspaceSidebarConfig',
  'workspaceRouteKeys',
  'additionalCursorContextDirs',
]);

/**
 * @typedef {{
 *   db: DatabaseSync,
 *   path: string,
 *   view: Record<string, any> | null,
 *   dataVersion: number,
 * }} StoreHandle
 */

/** @type {Map<string, StoreHandle>} */
const handles = new Map();

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function workspacesDbPath(dataDir) {
  return path.join(dataDir, WORKSPACES_DB_FILENAME);
}

/**
 * Open (or reuse) the store of a data directory, applying pending migrations.
 *
 * @param {string} dataDir
 * @returns {StoreHandle}
 */
function openHandle(dataDir) {
  const file = workspacesDbPath(path.resolve(dataDir));
  const cached = handles.get(file);
  if (cached) {
    if (fs.existsSync(file)) return cached;
    closeHandle(cached);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    applyMigrations(db, { migrations: WORKSPACE_MIGRATIONS });
  } catch (err) {
    try { db.close(); } catch { /* the original failure is what matters */ }
    throw err;
  }
  /** @type {StoreHandle} */
  const handle = { db, path: file, view: null, dataVersion: -1 };
  handles.set(file, handle);
  return handle;
}

/** @param {StoreHandle} handle */
function closeHandle(handle) {
  handles.delete(handle.path);
  try { handle.db.close(); } catch { /* already closed */ }
}

/**
 * Close every open store handle (tests, shutdown).
 */
export function closeAllWorkspacesStores() {
  for (const handle of [...handles.values()]) closeHandle(handle);
}

/**
 * @param {StoreHandle} handle
 * @returns {number}
 */
function currentDataVersion(handle) {
  return Number(handle.db.prepare('PRAGMA data_version').get()?.data_version ?? 0);
}

/**
 * @param {StoreHandle} handle
 * @param {string} key
 * @returns {string | null}
 */
function readMeta(handle, key) {
  const row = handle.db.prepare('SELECT value FROM workspace_store_meta WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

/**
 * @param {StoreHandle} handle
 * @param {string} key
 * @param {string} value
 */
function writeMeta(handle, key, value) {
  handle.db.prepare('INSERT INTO workspace_store_meta (key, value) VALUES (?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * @param {string} dataDir
 * @returns {boolean} true once the config.json sections were taken over by SQL
 */
export function isWorkspacesStoreMigrated(dataDir) {
  // Never create the database just to answer "no": an install without workspaces
  // stays free of the file until the first workspace is saved.
  if (!handles.has(workspacesDbPath(path.resolve(dataDir))) && !fs.existsSync(workspacesDbPath(path.resolve(dataDir)))) {
    return false;
  }
  return readMeta(openHandle(dataDir), META_MIGRATED_AT) !== null;
}

/**
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
export function hasWorkspaceSections(settings) {
  if (!settings || typeof settings !== 'object') return false;
  return WORKSPACE_SETTINGS_KEYS.some((key) => settings[key] !== undefined && settings[key] !== null);
}

/**
 * Settings-shaped overlay entry of a workspace row.
 *
 * @param {Record<string, any>} row
 * @param {Array<Record<string, any>>} folders ordered folder rows
 * @returns {Record<string, any>}
 */
function sidebarEntryFromRow(row, folders) {
  /** @type {Record<string, any>} */
  const entry = {};
  if (row.enabled !== null && row.enabled !== undefined) entry.enabled = Number(row.enabled) === 1;
  if (row.default_folder) entry.folder = String(row.default_folder);
  if (row.sidebar_workspace_file) entry.workspaceFile = String(row.sidebar_workspace_file);
  if (row.sidebar_label) entry.label = String(row.sidebar_label);
  if (folders.length > 0) {
    /** @type {Record<string, any>} */
    const overlay = {};
    for (const folder of folders) {
      /** @type {Record<string, any>} */
      const meta = {};
      if (Number(folder.enabled_set) === 1) meta.enabled = Number(folder.enabled) === 1;
      if (folder.name) meta.name = String(folder.name);
      if (folder.source) meta.source = String(folder.source);
      overlay[String(folder.path)] = meta;
    }
    entry.folders = overlay;
  }
  return entry;
}

/**
 * @param {StoreHandle} handle
 * @returns {Record<string, any>}
 */
function buildView(handle) {
  const { db } = handle;
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY sort_order, created_at, id').all();
  const folderRows = db.prepare('SELECT * FROM workspace_folders ORDER BY workspace_id, sort_order').all();
  /** @type {Map<string, Array<Record<string, any>>>} */
  const foldersByWorkspace = new Map();
  for (const folder of folderRows) {
    const list = foldersByWorkspace.get(String(folder.workspace_id)) || [];
    list.push(folder);
    foldersByWorkspace.set(String(folder.workspace_id), list);
  }
  const workspaces = [];
  /** @type {Record<string, any>} */
  const sidebar = {};
  for (const row of rows) {
    const legacyId = String(row.legacy_id);
    /** @type {Record<string, any>} */
    const entry = { id: legacyId, kind: String(row.kind) };
    if (row.kind === 'file') entry.workspaceFile = legacyId;
    if (row.name) entry.label = String(row.name);
    if (row.imported_from) entry.importedFrom = String(row.imported_from);
    workspaces.push(entry);
    const overlay = sidebarEntryFromRow(row, foldersByWorkspace.get(String(row.id)) || []);
    if (Object.keys(overlay).length > 0) sidebar[legacyId] = overlay;
  }
  for (const row of db.prepare('SELECT key, json FROM workspace_overlays ORDER BY sort_order').all()) {
    try {
      sidebar[String(row.key)] = JSON.parse(String(row.json));
    } catch {
      // A malformed overlay row is skipped; the registry itself stays intact.
    }
  }
  const routeRows = db.prepare('SELECT workspace_key, folder_path, route_id FROM workspace_route_keys').all();
  /** @type {Record<string, any>} */
  const routeKeys = { version: WORKSPACE_ROUTE_KEYS_VERSION, workspaces: {}, folders: {} };
  for (const row of routeRows) {
    const key = String(row.workspace_key);
    if (row.folder_path === '') {
      routeKeys.workspaces[key] = String(row.route_id);
    } else {
      routeKeys.folders[key] = routeKeys.folders[key] || {};
      routeKeys.folders[key][String(row.folder_path)] = String(row.route_id);
    }
  }
  let dirs = [];
  try {
    const parsed = JSON.parse(readMeta(handle, META_CONTEXT_DIRS) || '[]');
    dirs = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item.trim()) : [];
  } catch {
    dirs = [];
  }
  return { workspaces, workspaceSidebarConfig: sidebar, workspaceRouteKeys: routeKeys, additionalCursorContextDirs: dirs };
}

/**
 * Settings sections read from SQL. Empty sections are omitted so an untouched
 * install keeps an empty settings object.
 *
 * @param {string} dataDir
 * @returns {Record<string, any>}
 */
export function readWorkspaceSettingsView(dataDir) {
  const handle = openHandle(dataDir);
  const version = currentDataVersion(handle);
  if (!handle.view || handle.dataVersion !== version) {
    handle.view = buildView(handle);
    handle.dataVersion = version;
  }
  const view = structuredClone(handle.view);
  /** @type {Record<string, any>} */
  const out = {};
  if (view.workspaces.length > 0) out.workspaces = view.workspaces;
  if (Object.keys(view.workspaceSidebarConfig).length > 0) out.workspaceSidebarConfig = view.workspaceSidebarConfig;
  const routeKeys = view.workspaceRouteKeys;
  if (Object.keys(routeKeys.workspaces).length > 0 || Object.keys(routeKeys.folders).length > 0) {
    out.workspaceRouteKeys = routeKeys;
  }
  if (view.additionalCursorContextDirs.length > 0) out.additionalCursorContextDirs = view.additionalCursorContextDirs;
  return out;
}

/**
 * Keep an existing row (UUID, import metadata, aliases) across a registry id change:
 * match by legacy id first, then by `importedFrom` (a converted file workspace).
 *
 * @param {Array<Record<string, any>>} existing
 * @param {Array<Record<string, any>>} registry
 * @returns {Map<string, Record<string, any>>} registry id -> existing row
 */
function matchExistingRows(existing, registry) {
  /** @type {Map<string, Record<string, any>>} */
  const matched = new Map();
  const used = new Set();
  const byLegacy = new Map(existing.map((row) => [String(row.legacy_id), row]));
  for (const entry of registry) {
    const row = byLegacy.get(entry.id);
    if (row) {
      matched.set(entry.id, row);
      used.add(String(row.id));
    }
  }
  for (const entry of registry) {
    if (matched.has(entry.id) || !entry.importedFrom) continue;
    const row = existing.find((candidate) => !used.has(String(candidate.id))
      && candidate.imported_from === entry.importedFrom);
    if (row) {
      matched.set(entry.id, row);
      used.add(String(row.id));
    }
  }
  return matched;
}

/**
 * @param {StoreHandle} handle
 * @param {Record<string, any>} settings
 * @param {{ now?: number, importedFromFallback?: Map<string, string> }} [options]
 */
function writeSections(handle, settings, options = {}) {
  const { db } = handle;
  const now = Math.trunc(options.now ?? Date.now());
  const registry = sanitizeWorkspaces(settings.workspaces);
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  const routeKeys = sanitizeWorkspaceRouteKeys(settings.workspaceRouteKeys);
  const existing = db.prepare('SELECT * FROM workspaces').all();
  const matched = matchExistingRows(existing, registry);
  const keepIds = new Set([...matched.values()].map((row) => String(row.id)));

  for (const row of existing) {
    if (!keepIds.has(String(row.id))) db.prepare('DELETE FROM workspaces WHERE id = ?').run(row.id);
  }
  const upsert = db.prepare(`
    INSERT INTO workspaces (id, legacy_id, kind, name, sidebar_label, default_folder, sort_order, enabled,
      sidebar_workspace_file, imported_from, imported_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET legacy_id = excluded.legacy_id, kind = excluded.kind, name = excluded.name,
      sidebar_label = excluded.sidebar_label, default_folder = excluded.default_folder,
      sort_order = excluded.sort_order, enabled = excluded.enabled,
      sidebar_workspace_file = excluded.sidebar_workspace_file, imported_from = excluded.imported_from,
      imported_at = excluded.imported_at`);
  const insertAlias = db.prepare('INSERT OR IGNORE INTO workspace_aliases (alias, workspace_id) VALUES (?, ?)');
  const deleteFolders = db.prepare('DELETE FROM workspace_folders WHERE workspace_id = ?');
  const insertFolder = db.prepare(`
    INSERT INTO workspace_folders (workspace_id, path, name, enabled, enabled_set, source, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // Legacy ids are UNIQUE: park every kept row first so a swap/rename never collides.
  for (const row of matched.values()) {
    db.prepare('UPDATE workspaces SET legacy_id = ? WHERE id = ?').run(`${PARKED_PREFIX}${row.id}`, row.id);
  }
  registry.forEach((entry, index) => {
    const prev = matched.get(entry.id);
    const id = prev ? String(prev.id) : randomUUID();
    const overlay = sidebar[entry.id] || {};
    const importedFrom = entry.importedFrom || '';
    const importedAt = importedFrom
      ? (prev && prev.imported_from === importedFrom ? Number(prev.imported_at) || now : now)
      : 0;
    upsert.run(
      id,
      entry.id,
      entry.kind,
      entry.label || '',
      overlay.label || '',
      overlay.folder || '',
      index,
      typeof overlay.enabled === 'boolean' ? (overlay.enabled ? 1 : 0) : null,
      overlay.workspaceFile || '',
      importedFrom,
      importedAt,
      prev ? Number(prev.created_at) : now,
    );
    insertAlias.run(entry.id, id);
    if (prev && String(prev.legacy_id) !== entry.id && !String(prev.legacy_id).startsWith(PARKED_PREFIX)) {
      insertAlias.run(String(prev.legacy_id), id);
    }
    deleteFolders.run(id);
    Object.entries(overlay.folders || {}).forEach(([folderPath, meta], folderIndex) => {
      insertFolder.run(
        id,
        folderPath,
        meta.name || '',
        meta.enabled === false ? 0 : 1,
        typeof meta.enabled === 'boolean' ? 1 : 0,
        meta.source || '',
        folderIndex,
      );
    });
  });
  // Aliases survive a registry id change (the former legacy id is already recorded
  // above); a plain removal cascades through the foreign key.
  const registryIds = new Set(registry.map((entry) => entry.id));
  db.exec('DELETE FROM workspace_overlays');
  const insertOverlay = db.prepare('INSERT INTO workspace_overlays (key, json, sort_order) VALUES (?, ?, ?)');
  Object.entries(sidebar).filter(([key]) => !registryIds.has(key)).forEach(([key, value], index) => {
    insertOverlay.run(key, JSON.stringify(value), index);
  });
  db.exec('DELETE FROM workspace_route_keys');
  const insertRoute = db.prepare('INSERT INTO workspace_route_keys (workspace_key, folder_path, route_id) VALUES (?, ?, ?)');
  for (const [workspaceId, routeId] of Object.entries(routeKeys.workspaces)) insertRoute.run(workspaceId, '', routeId);
  for (const [workspaceKey, map] of Object.entries(routeKeys.folders)) {
    for (const [folderPath, routeId] of Object.entries(map)) insertRoute.run(workspaceKey, folderPath, routeId);
  }
  const dirs = Array.isArray(settings.additionalCursorContextDirs)
    ? settings.additionalCursorContextDirs.filter((item) => typeof item === 'string' && item.trim())
    : [];
  writeMeta(handle, META_CONTEXT_DIRS, JSON.stringify(dirs));
  handle.view = null;
}

/**
 * @param {StoreHandle} handle
 * @param {() => void} body
 */
function inTransaction(handle, body) {
  handle.db.exec('BEGIN IMMEDIATE');
  try {
    body();
    handle.db.exec('COMMIT');
  } catch (err) {
    try { handle.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    handle.view = null;
    throw err;
  }
}

/**
 * Order-sensitive digest of the normalized sections, to skip no-op writes.
 *
 * @param {Record<string, any>} settings
 * @returns {string}
 */
function sectionsFingerprint(settings) {
  const dirs = Array.isArray(settings.additionalCursorContextDirs)
    ? settings.additionalCursorContextDirs.filter((item) => typeof item === 'string' && item.trim())
    : [];
  return JSON.stringify([
    sanitizeWorkspaces(settings.workspaces),
    sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig),
    sanitizeWorkspaceRouteKeys(settings.workspaceRouteKeys),
    dirs,
  ]);
}

/**
 * Replace the workspace sections present in `settings` (absent keys keep their stored
 * data; explicit empty values clear that section) and mark the
 * store as the source of truth. Rows are matched by legacy id (or `importedFrom`
 * after a convert) so UUIDs, aliases and import metadata survive.
 *
 * @param {string} dataDir
 * @param {Record<string, any>} settings
 */
export function replaceWorkspaceSettings(dataDir, settings) {
  const handle = openHandle(dataDir);
  const migrated = readMeta(handle, META_MIGRATED_AT) !== null;
  // Partial replace: a section whose key is absent (`undefined`) keeps its stored data;
  // only keys that are present, including explicit empty values, are written.
  const current = migrated ? readWorkspaceSettingsView(dataDir) : {};
  /** @type {Record<string, any>} */
  const merged = { ...current };
  for (const key of WORKSPACE_SETTINGS_KEYS) {
    if (settings[key] !== undefined) merged[key] = settings[key];
  }
  if (migrated && sectionsFingerprint(merged) === sectionsFingerprint(current)) {
    return; // unrelated settings save: nothing to rewrite
  }
  inTransaction(handle, () => {
    writeSections(handle, merged);
    if (readMeta(handle, META_MIGRATED_AT) === null) writeMeta(handle, META_MIGRATED_AT, String(Date.now()));
  });
}

/**
 * Snapshot the folders of `.code-workspace` registry entries into the overlay so no
 * file read is needed afterwards: the effective list the client used to see (overlay
 * order first, then file folders that the overlay did not know) becomes the stored
 * list. A missing or unreadable file contributes nothing.
 *
 * @param {Record<string, any>} settings mutated in place
 * @param {(file: string) => { folders?: Array<{ name?: string, resolvedPath?: string, path?: string }> } | null} loadWorkspaceFn
 */
export function snapshotFileWorkspaceFolders(settings, loadWorkspaceFn) {
  const registry = sanitizeWorkspaces(settings.workspaces);
  const sidebar = sanitizeWorkspaceSidebarConfig(settings.workspaceSidebarConfig);
  let changed = false;
  for (const entry of registry) {
    if (entry.kind !== 'file' || !entry.workspaceFile || entry.importedFrom) continue;
    let loaded = null;
    try {
      loaded = typeof loadWorkspaceFn === 'function' ? loadWorkspaceFn(entry.workspaceFile) : null;
    } catch {
      loaded = null;
    }
    const fileFolders = Array.isArray(loaded?.folders) ? loaded.folders : [];
    const prev = sidebar[entry.id] || {};
    const overlayKeys = new Set(Object.keys(prev.folders || {}).map((key) => toPosixPath(key)));
    const everyKey = new Set([...overlayKeys, ...fileFolders.map((folder) => toPosixPath(folder?.resolvedPath || ''))]);
    everyKey.delete('');
    const merged = mergeFoldersForClient({ fileFolders, overlayFolders: prev.folders, existsSet: everyKey });
    if (merged.length === 0) continue;
    /** @type {Record<string, any>} */
    const folders = {};
    for (const folder of merged) {
      folders[folder.resolvedPath] = { enabled: folder.enabled, name: folder.name, source: folder.source };
    }
    sidebar[entry.id] = { ...prev, folders };
    changed = true;
  }
  if (changed) settings.workspaceSidebarConfig = sidebar;
  // Every file entry remembers its source path as plain metadata.
  settings.workspaces = registry.map((entry) => (entry.kind === 'file' && entry.workspaceFile && !entry.importedFrom
    ? { ...entry, importedFrom: entry.workspaceFile }
    : entry));
}

/**
 * One-time takeover of the config.json sections. Runs only while the store is not
 * yet marked migrated, and only when the settings really contain workspace data.
 *
 * @param {string} dataDir
 * @param {Record<string, any>} settings parsed config.json (not mutated)
 * @param {{ loadWorkspaceFn?: Function }} [options]
 * @returns {boolean} true when the migration ran
 */
export function migrateWorkspaceSettingsFromConfig(dataDir, settings, options = {}) {
  const handle = openHandle(dataDir);
  if (readMeta(handle, META_MIGRATED_AT) !== null) return false;
  if (!hasWorkspaceSections(settings)) return false;
  const copy = structuredClone(
    Object.fromEntries(WORKSPACE_SETTINGS_KEYS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])),
  );
  snapshotFileWorkspaceFolders(copy, /** @type {any} */ (options.loadWorkspaceFn));
  replaceWorkspaceSettings(dataDir, copy);
  return true;
}

/**
 * Resolve any id a workspace is known by (UUID, current id, former ids such as a
 * `.code-workspace` path) to its current registry id.
 *
 * @param {string} dataDir
 * @param {string} ref
 * @returns {{ uuid: string, id: string, kind: string, importedFrom: string } | null}
 */
export function resolveWorkspaceRef(dataDir, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const handle = openHandle(dataDir);
  const candidates = [raw, toPosixPath(raw)].filter(Boolean);
  for (const candidate of candidates) {
    const row = handle.db.prepare(`
      SELECT w.id, w.legacy_id, w.kind, w.imported_from FROM workspaces w
      WHERE w.id = ? OR w.legacy_id = ?
         OR w.id = (SELECT workspace_id FROM workspace_aliases WHERE alias = ?)`).get(candidate, candidate, candidate);
    if (row) {
      return { uuid: String(row.id), id: String(row.legacy_id), kind: String(row.kind), importedFrom: String(row.imported_from) };
    }
  }
  return null;
}

/**
 * Import metadata per registry id (the UI duplicate warning and refresh action).
 *
 * @param {string} dataDir
 * @returns {Array<{ uuid: string, id: string, importedFrom: string, importedAt: number }>}
 */
export function listWorkspaceStoreMeta(dataDir) {
  const handle = openHandle(dataDir);
  return handle.db.prepare('SELECT id, legacy_id, imported_from, imported_at FROM workspaces ORDER BY sort_order').all()
    .map((row) => ({
      uuid: String(row.id),
      id: String(row.legacy_id),
      importedFrom: String(row.imported_from),
      importedAt: Number(row.imported_at),
    }));
}

/**
 * Rollback / backup export (B1): the SQL registry in the exact shape config.json
 * carried before this store existed. `config` is copied; its workspace sections are
 * replaced by the SQL state. `importedFrom` is dropped (old builds do not know it).
 *
 * @param {string} dataDir
 * @param {Record<string, any>} [config]
 * @param {{ keepImportedFrom?: boolean }} [options] keep import metadata (settings backup documents)
 * @returns {Record<string, any>}
 */
export function exportWorkspaceSettingsToConfigShape(dataDir, config = {}, options = {}) {
  const out = { ...(config && typeof config === 'object' ? config : {}) };
  for (const key of WORKSPACE_SETTINGS_KEYS) delete out[key];
  const view = readWorkspaceSettingsView(dataDir);
  if (view.workspaces) {
    out.workspaces = options.keepImportedFrom === true
      ? view.workspaces
      : view.workspaces.map((entry) => {
        const { importedFrom, ...rest } = entry;
        void importedFrom;
        return rest;
      });
  }
  for (const key of WORKSPACE_SETTINGS_KEYS.slice(1)) {
    if (view[key] !== undefined) out[key] = view[key];
  }
  return out;
}
