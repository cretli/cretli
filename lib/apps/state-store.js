/**
 * Runtime state of registered apps, kept in `data/apps-state.json`
 * (store.apps-state in docs/storage-registry.json).
 *
 * Shape: `{ schemaVersion, workspaces: { [workspaceDir]: { [appId]: AppRuntimeState } } }`.
 * The `runId` mapping is what ties an app to the one task run Cretli started for it;
 * stop/restart act on that run only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const APPS_STATE_FILE = 'apps-state.json';
export const APPS_STATE_SCHEMA_VERSION = 1;
export const MAX_ERROR_HISTORY = 20;

/**
 * @typedef {{
 *   runId: string|null,
 *   pid: number|null,
 *   status: 'stopped'|'starting'|'running'|'exited'|'failed',
 *   lastChangeAt: string|null,
 *   errors: Array<{ at: string, message: string }>,
 * }} AppRuntimeState
 */

/** @returns {AppRuntimeState} */
export function emptyAppState() {
  return { runId: null, pid: null, status: 'stopped', lastChangeAt: null, errors: [] };
}

/**
 * @param {{ file?: string }} [options]
 */
export function createAppsStateStore(options = {}) {
  const file = options.file || resolveDataPath(APPS_STATE_FILE);
  /** @type {Record<string, Record<string, AppRuntimeState>> | null} */
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = {};
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && typeof doc.workspaces === 'object' && doc.workspaces) {
        for (const [dir, apps] of Object.entries(doc.workspaces)) {
          if (!apps || typeof apps !== 'object') continue;
          cache[dir] = {};
          for (const [id, s] of Object.entries(apps)) {
            if (s && typeof s === 'object') {
              cache[dir][id] = { ...emptyAppState(), ...s, errors: Array.isArray(s.errors) ? s.errors.slice(-MAX_ERROR_HISTORY) : [] };
            }
          }
        }
      }
    } catch { /* A missing or corrupt state file starts empty; it is only a cache of runtime facts. */ }
    return cache;
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, { schemaVersion: APPS_STATE_SCHEMA_VERSION, workspaces: load() });
    } catch { /* State loss must never break app control. */ }
  }

  const key = (dir) => path.resolve(String(dir));

  return {
    /** @returns {AppRuntimeState} */
    get(workspaceDir, appId) {
      return { ...emptyAppState(), ...(load()[key(workspaceDir)]?.[appId] || {}) };
    },
    /** @param {Partial<AppRuntimeState>} patch */
    patch(workspaceDir, appId, patch) {
      const all = load();
      const dir = key(workspaceDir);
      all[dir] = all[dir] || {};
      all[dir][appId] = { ...emptyAppState(), ...(all[dir][appId] || {}), ...patch };
      persist();
      return { ...all[dir][appId] };
    },
    addError(workspaceDir, appId, message, at = new Date().toISOString()) {
      const current = this.get(workspaceDir, appId);
      const errors = [...current.errors, { at, message: String(message).slice(0, 500) }].slice(-MAX_ERROR_HISTORY);
      return this.patch(workspaceDir, appId, { errors });
    },
    /** Workspaces that hold state, so the monitor can follow runs after a workspace switch. */
    workspaces() {
      return Object.keys(load());
    },
    remove(workspaceDir, appId) {
      const all = load();
      const dir = key(workspaceDir);
      if (all[dir]?.[appId]) {
        delete all[dir][appId];
        persist();
      }
    },
  };
}
