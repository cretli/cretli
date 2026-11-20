import {
  getViewContextRuntimeScope,
  getViewContextState,
} from '../../app/appShell/viewContextBridge.js';

/** TODO requests must follow the client workspace, not the server's shared cwd. */
export function getTodoWorkspaceFolder() {
  const fromStore = String(getViewContextState()?.runtime?.workspaceFolder || '').trim();
  if (fromStore) return fromStore;
  return getViewContextRuntimeScope().workspaceFolder || '';
}

/** The registered workspace (its `.code-workspace` id) the list belongs to; empty for a bare folder. */
export function getTodoWorkspaceFile() {
  const fromStore = String(/** @type {any} */ (getViewContextState())?.runtime?.workspaceFile || '').trim();
  if (fromStore) return fromStore;
  return getViewContextRuntimeScope().workspaceFile || '';
}

/**
 * Storage key suffix for per-list UI state: the workspace, falling back to the
 * folder only outside a registered workspace.
 */
export function todoListScopeKey() {
  return getTodoWorkspaceFile() || getTodoWorkspaceFolder() || 'default';
}

export function normalizeTodoWorkspaceFolder(folder) {
  const value = String(folder || '').trim().replace(/\\/g, '/');
  return value.replace(/\/+$/, '') || (value ? '/' : '');
}

export function todoWorkspaceMatches(folder, activeFolder = getTodoWorkspaceFolder()) {
  return normalizeTodoWorkspaceFolder(folder) === normalizeTodoWorkspaceFolder(activeFolder);
}

export function todoWorkspaceQuery(folder = getTodoWorkspaceFolder()) {
  const file = getTodoWorkspaceFile();
  const parts = [];
  if (folder) parts.push(`workspaceFolder=${encodeURIComponent(folder)}`);
  if (file) parts.push(`workspaceFile=${encodeURIComponent(file)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function scopeTodoPayload(payload = {}) {
  const workspaceFolder = String(payload?.workspaceFolder || getTodoWorkspaceFolder()).trim();
  const workspaceFile = String(payload?.workspaceFile || getTodoWorkspaceFile()).trim();
  const scoped = workspaceFolder ? { ...payload, workspaceFolder } : { ...payload };
  if (workspaceFile) /** @type {any} */ (scoped).workspaceFile = workspaceFile;
  return scoped;
}
