/**
 * Current workspace selection, CWD, and task-run scope for the HTTP/WS server.
 */

import { existsSync, statSync } from 'fs';
import path from 'path';
import { loadWorkspace, expandUserPath } from './workspace.js';
import { isFolderWorkspaceId, findWorkspace } from './persist/workspace-registry.js';
import { mergeFoldersForClient, resolveWorkspaceCwd } from './workspace-folders.js';
import { loadSettings } from './persist/settings.js';
import { loadTasksFromDirectories } from './tasks.js';

/**
 * @param {string} [pathValue]
 * @returns {string}
 */
export function normalizeWorkspaceScopePath(pathValue) {
  const raw = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!raw) return '';
  return path.resolve(raw);
}

/**
 * @param {{ workspaceFile?: string, cwd?: string } | null} run
 * @param {{ workspaceFile?: string, cwd?: string } | null} scope
 * @returns {boolean}
 */
export function isTaskRunInScope(run, scope) {
  if (!run || !scope) return false;
  const runWorkspaceFile = normalizeWorkspaceScopePath(run.workspaceFile || '');
  const runCwd = normalizeWorkspaceScopePath(run.cwd || '');
  if (runWorkspaceFile !== normalizeWorkspaceScopePath(scope.workspaceFile || '')) return false;
  return runCwd === normalizeWorkspaceScopePath(scope.cwd || '');
}

/**
 * @param {{ defaultWorkspaceFile?: string | null }} [options]
 */
export function createWorkspaceContext(options = {}) {
  const defaultWorkspaceFile = options.defaultWorkspaceFile || null;

  function getCurrentWorkspaceFile() {
    const settings = loadSettings();
    const file = settings.workspaceFile && settings.workspaceFile.trim()
      ? settings.workspaceFile.trim()
      : defaultWorkspaceFile;
    return file || null;
  }

  function getConfiguredWorkspaceSelection(settings = null) {
    const cfg = settings || loadSettings();
    const workspaceFile = cfg.workspaceFile && String(cfg.workspaceFile).trim()
      ? String(cfg.workspaceFile).trim()
      : (defaultWorkspaceFile || '');
    const workspaceFolder = cfg.workspaceFolder && String(cfg.workspaceFolder).trim()
      ? String(cfg.workspaceFolder).trim()
      : '';
    return { workspaceFile, workspaceFolder };
  }

  function getCurrentWorkspace() {
    const file = getCurrentWorkspaceFile();
    if (!file) return null;
    if (isFolderWorkspaceId(file)) {
      const settings = loadSettings();
      const sidebar = settings.workspaceSidebarConfig?.[file];
      const folders = mergeFoldersForClient({
        fileFolders: [],
        overlayFolders: sidebar?.folders,
      }).filter((folder) => folder.enabled);
      if (folders.length === 0) return null;
      return {
        workspaceDir: folders[0].resolvedPath,
        workspaceFilePath: file,
        folders: folders.map((folder) => ({
          name: folder.name,
          path: folder.path,
          resolvedPath: folder.resolvedPath,
        })),
      };
    }
    return loadWorkspace(file) || null;
  }

  function getCurrentWorkspaceFolder() {
    const settings = loadSettings();
    const folder = settings.workspaceFolder && settings.workspaceFolder.trim();
    if (!folder) return null;
    const resolved = path.resolve(expandUserPath(folder));
    if (existsSync(resolved) && statSync(resolved).isDirectory()) return resolved;
    const workspace = getCurrentWorkspace();
    if (!workspace) return null;
    const byName = (workspace.folders || []).find(
      (entry) => entry.name === folder
        || (entry.resolvedPath && path.basename(entry.resolvedPath) === folder),
    );
    if (byName?.resolvedPath && existsSync(byName.resolvedPath)) return byName.resolvedPath;
    const fromRel = path.join(workspace.workspaceDir, folder);
    if (existsSync(fromRel) && statSync(fromRel).isDirectory()) return fromRel;
    return null;
  }

  function getCurrentCwd() {
    const folder = getCurrentWorkspaceFolder();
    if (folder) return folder;
    const workspace = getCurrentWorkspace();
    return workspace ? workspace.workspaceDir : process.cwd();
  }

  function buildTaskRunScopeSnapshot() {
    return {
      workspaceFile: normalizeWorkspaceScopePath(getCurrentWorkspaceFile() || ''),
      cwd: normalizeWorkspaceScopePath(getCurrentCwd()),
    };
  }

  function resolveTasksWorkspaceFile(requestedFile) {
    const fallback = getCurrentWorkspaceFile();
    const requested = String(requestedFile || '').trim();
    if (!requested) return fallback;
    const entry = findWorkspace(loadSettings().workspaces, requested);
    return entry ? (entry.workspaceFile || entry.id) : fallback;
  }

  function loadCurrentTasks(requestedFile) {
    const file = resolveTasksWorkspaceFile(requestedFile);
    if (!file) return null;
    const settings = loadSettings();
    const overlay = settings.workspaceSidebarConfig?.[file]?.folders;
    const directories = [];
    if (overlay && typeof overlay === 'object') {
      for (const [resolvedPath, meta] of Object.entries(overlay)) {
        if (meta?.enabled === false) continue;
        directories.push(resolvedPath);
      }
    }
    if (!isFolderWorkspaceId(file)) {
      const loaded = loadWorkspace(file);
      for (const folder of loaded?.folders || []) {
        directories.push(folder.resolvedPath);
      }
    }
    return loadTasksFromDirectories(directories);
  }

  function loadTasksForWorkspace(input = {}) {
    const file = String(input.workspaceFile || '').trim();
    const folder = String(input.workspaceFolder || '').trim();
    const directories = [];
    if (file && !isFolderWorkspaceId(file)) {
      const loaded = loadWorkspace(file);
      for (const entry of loaded?.folders || []) {
        if (entry?.resolvedPath) directories.push(entry.resolvedPath);
      }
    }
    if (folder) directories.push(folder);
    if (directories.length === 0) return null;
    return loadTasksFromDirectories(directories);
  }

  function workspaceDirForAgent(workspacePath) {
    if (!workspacePath) return getCurrentCwd();
    const settings = loadSettings();
    return resolveWorkspaceCwd({
      workspaceId: workspacePath,
      workspaceFolder: settings.workspaceFolder,
      registry: settings.workspaces,
      sidebarConfig: settings.workspaceSidebarConfig,
      fallbackCwd: path.extname(workspacePath) === '.code-workspace'
        ? path.dirname(workspacePath)
        : workspacePath,
    });
  }

  return {
    getCurrentWorkspaceFile,
    getConfiguredWorkspaceSelection,
    getCurrentWorkspace,
    getCurrentWorkspaceFolder,
    getCurrentCwd,
    buildTaskRunScopeSnapshot,
    resolveTasksWorkspaceFile,
    loadCurrentTasks,
    loadTasksForWorkspace,
    workspaceDirForAgent,
  };
}
