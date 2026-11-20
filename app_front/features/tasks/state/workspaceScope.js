/** Workspace scope of the Tasks panel: runs are stamped with, and filtered by, the header workspace. */

export function normalizeScopePath(pathValue) {
  if (typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

export function readCurrentWorkspaceScope() {
  if (typeof document === 'undefined') {
    return { workspaceFile: '', workspaceFolder: '' };
  }
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFile: normalizeScopePath(trigger?.dataset?.workspaceFile || ''),
    workspaceFolder: normalizeScopePath(trigger?.dataset?.workspaceFolder || ''),
  };
}

export function getTasksScopeCacheKey() {
  const scope = readCurrentWorkspaceScope();
  return `${scope.workspaceFile}::${scope.workspaceFolder}`;
}

export function stampRunWorkspaceScope(run) {
  if (!run || typeof run !== 'object') return;
  const scope = readCurrentWorkspaceScope();
  run.workspaceFile = scope.workspaceFile;
  run.workspaceFolder = scope.workspaceFolder;
}

export function isRunInWorkspaceScope(run, scope = readCurrentWorkspaceScope()) {
  if (!run || !scope.workspaceFile) return false;
  const runWorkspaceFile = normalizeScopePath(run.workspaceFile || '');
  if (!runWorkspaceFile || runWorkspaceFile !== scope.workspaceFile) return false;

  const scopeFolder = normalizeScopePath(scope.workspaceFolder || '');
  if (!scopeFolder) return true;

  const runWorkspaceFolder = normalizeScopePath(run.workspaceFolder || '');
  return !!runWorkspaceFolder && runWorkspaceFolder === scopeFolder;
}
