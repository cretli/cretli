/** TODO requests must follow the client workspace, not the server's shared cwd. */
export function getTodoWorkspaceFolder() {
  if (typeof document === 'undefined') return '';
  return String(document.getElementById('header-workspace-trigger')?.dataset?.workspaceFolder || '').trim();
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
