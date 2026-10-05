/**
 * Sidebar Workspace Watcher toggles.
 *
 * Two quick controls live in the sidebar "Workspace" section:
 *   - one master switch in the section header for the server-wide start gate
 *     (`startsEnabled`), i.e. "off for every workspace";
 *   - one switch per pinned workspace that flips that workspace's watcher mode
 *     between `autopilot` (on) and `off` (disabled).
 *
 * The store is tiny and synchronous so `sidebarView.js` can read it while
 * building HTML; the fetch/PATCH actions reconcile it and are shared with the
 * settings panel's runtime-control endpoint. `off` + pinned rows stay in the
 * presence payload (see `lib/workspace-watcher-live.js`) so a disabled workspace
 * remains listed and can be switched back on.
 */

import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getCurrentLang } from '../../i18n/index.js';

const RUNTIME_CONTROL_PATH = '/api/workspace-watcher/runtime-control';
const WATCHER_PATH = '/api/workspace-watcher';

/** @type {{ startsEnabled: boolean, statusUnavailable: boolean, known: boolean }} */
let runtimeControl = { startsEnabled: true, statusUnavailable: false, known: false };
let revision = 0;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthyFlag(value) {
  return value === true;
}

/**
 * Merge one runtime-control payload from the REST API or a PATCH response.
 *
 * @param {{ startsEnabled?: boolean, statusUnavailable?: boolean, controlError?: boolean } | null | undefined} next
 * @returns {boolean} true when the stored state changed
 */
export function applyWorkspaceWatcherRuntimeControl(next) {
  const startsEnabled = next?.startsEnabled === false
    ? false
    : (next?.startsEnabled === true ? true : runtimeControl.startsEnabled);
  const statusUnavailable = next?.statusUnavailable === true
    || next?.controlError === true;
  const changed = !runtimeControl.known
    || runtimeControl.startsEnabled !== startsEnabled
    || runtimeControl.statusUnavailable !== statusUnavailable;
  runtimeControl = { startsEnabled, statusUnavailable, known: true };
  if (changed) revision += 1;
  return changed;
}

/**
 * @returns {{ startsEnabled: boolean, statusUnavailable: boolean, known: boolean }}
 */
export function getWorkspaceWatcherRuntimeControl() {
  return { ...runtimeControl };
}

/**
 * @returns {boolean} true when watcher cycles/scans may start server-wide
 */
export function isWorkspaceWatcherStartsEnabled() {
  return runtimeControl.startsEnabled === true && runtimeControl.statusUnavailable !== true;
}

/**
 * Monotonic revision folded into the sidebar render signature.
 *
 * @returns {number}
 */
export function workspaceWatcherRuntimeRevision() {
  return revision;
}

/**
 * @param {Response} res
 * @returns {Promise<object>}
 */
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Pull the server-wide start gate. Read-only; never throws.
 *
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function refreshWorkspaceWatcherRuntimeControl(fetchImpl = cretliApiFetch) {
  try {
    const res = await fetchImpl(RUNTIME_CONTROL_PATH, {
      headers: { Accept: 'application/json', 'Accept-Language': getCurrentLang() },
    });
    const json = await readJson(res);
    if (!res.ok || json?.ok === false) return false;
    applyWorkspaceWatcherRuntimeControl(json.runtimeControl || {});
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ ok: boolean, json: object }>}
 */
async function patchJson(fetchImpl, path, body) {
  const res = await fetchImpl(path, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': getCurrentLang(),
    },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  return { ok: res.ok && json?.ok !== false, json };
}

/**
 * Turn the watcher start gate on/off for every workspace.
 *
 * @param {boolean} enabled
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error: string }>}
 */
export async function setWorkspaceWatcherStartsEnabled(enabled, fetchImpl = cretliApiFetch) {
  const startsEnabled = isTruthyFlag(enabled);
  try {
    const { ok, json } = await patchJson(fetchImpl, RUNTIME_CONTROL_PATH, { startsEnabled });
    if (!ok) return { ok: false, error: String(json?.error || '') };
    // Keep the local store authoritative even when the response omits the view.
    applyWorkspaceWatcherRuntimeControl(json.runtimeControl || { startsEnabled });
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || '') };
  }
}

/**
 * Enable/disable the watcher for one workspace (`autopilot` ↔ `off`).
 *
 * @param {string} workspaceFolder
 * @param {boolean} enabled
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, error: string }>}
 */
export async function setWorkspaceWatcherEnabled(workspaceFolder, enabled, fetchImpl = cretliApiFetch) {
  const folder = String(workspaceFolder || '').trim();
  if (!folder) return { ok: false, error: 'missing workspace folder' };
  const mode = isTruthyFlag(enabled) ? 'autopilot' : 'off';
  try {
    const { ok, json } = await patchJson(fetchImpl, WATCHER_PATH, { workspaceFolder: folder, mode });
    if (!ok) return { ok: false, error: String(json?.error || '') };
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || '') };
  }
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetWorkspaceWatcherToggleForTest() {
  runtimeControl = { startsEnabled: true, statusUnavailable: false, known: false };
  revision = 0;
}
