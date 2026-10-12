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

export function normalizeTodoWorkspaceFolder(folder) {
  const value = String(folder || '').trim().replace(/\\/g, '/');
  return value.replace(/\/+$/, '') || (value ? '/' : '');
}

export function todoWorkspaceMatches(folder, activeFolder = getTodoWorkspaceFolder()) {
  return normalizeTodoWorkspaceFolder(folder) === normalizeTodoWorkspaceFolder(activeFolder);
}

export function todoWorkspaceQuery(folder = getTodoWorkspaceFolder()) {
  return folder ? `?workspaceFolder=${encodeURIComponent(folder)}` : '';
}

export function scopeTodoPayload(payload = {}) {
  const workspaceFolder = String(payload?.workspaceFolder || getTodoWorkspaceFolder()).trim();
  return workspaceFolder ? { ...payload, workspaceFolder } : payload;
}
