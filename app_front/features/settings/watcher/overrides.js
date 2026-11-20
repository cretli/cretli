/**
 * Audited workspace-scoped override actions.
 */

import { ws } from './store.js';
import { watcherApi } from './api.js';
import { refreshWorkspaceWatcherSettingsPanel } from './refresh.js';
import { queryField } from './format.js';

/**
 * @param {{ status?: number, json?: any } | null} res
 * @returns {void}
 */
export function applyWorkspaceOverridesResponse(res) {
  if (!res || !res.json || res.json.ok !== true) {
    ws.workspaceOverridesState = {
      overrides: [],
      etag: '',
      error: String(res?.json?.error || ''),
      busy: false,
    };
    return;
  }
  ws.workspaceOverridesState = {
    overrides: Array.isArray(res.json.overrides) ? res.json.overrides : [],
    etag: String(res.json.etag || ''),
    error: '',
    busy: false,
  };
}

/**
 * @param {HTMLElement} root
 * @returns {Promise<void>}
 */
export async function createWorkspaceOverride(root) {
  const field = (name) => queryField(root, `[data-watcher-override-field="${name}"]`);
  const value = (name) => String(field(name)?.value || '').trim();
  const ttlHours = Math.max(1, Math.min(720, Number(value('ttlHours')) || 24));
  const body = {
    action: value('action'),
    targetHarness: value('targetHarness'),
    targetModel: value('targetModel'),
    reason: value('reason'),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
  };
  const res = await watcherApi('/api/workspace-watcher/overrides', {
    method: 'PUT',
    body,
    headers: { 'If-Match': ws.workspaceOverridesState.etag || '*' },
  });
  if (!res.json?.ok) {
    ws.workspaceOverridesState = { ...ws.workspaceOverridesState, error: String(res.json?.error || 'override create failed') };
  }
  await refreshWorkspaceWatcherSettingsPanel();
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function revokeWorkspaceOverride(id) {
  if (!id) return;
  const res = await watcherApi('/api/workspace-watcher/overrides/revoke', {
    method: 'POST',
    body: { id, reason: 'revoked from Workspace Watcher settings' },
    headers: { 'If-Match': ws.workspaceOverridesState.etag || '*' },
  });
  if (!res.json?.ok) {
    ws.workspaceOverridesState = { ...ws.workspaceOverridesState, error: String(res.json?.error || 'override revoke failed') };
  }
  await refreshWorkspaceWatcherSettingsPanel();
}

/**
 * @returns {Promise<void>}
 */
export async function resetWorkspaceOverrides() {
  const res = await watcherApi('/api/workspace-watcher/overrides/reset', {
    method: 'POST',
    body: {},
    headers: { 'If-Match': ws.workspaceOverridesState.etag || '*' },
  });
  if (!res.json?.ok) {
    ws.workspaceOverridesState = { ...ws.workspaceOverridesState, error: String(res.json?.error || 'override reset failed') };
  }
  await refreshWorkspaceWatcherSettingsPanel();
}
