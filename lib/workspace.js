/**
 * Parsing of .code-workspace files (VS Code / Cursor).
 * Paths in "folders" are relative to the directory holding the workspace file.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { toPosixPath } from './persist/workspace-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reads and parses a workspace file, tolerating // comments in JSON (JSONC).
 * @param {string} workspaceFilePath - absolute path to the .code-workspace file
 * @returns {{ folders: Array<{ name: string, path: string, resolvedPath: string }>, workspaceDir: string } | null}
 */
export function loadWorkspace(workspaceFilePath) {
  const absolutePath = path.resolve(workspaceFilePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  const workspaceDir = path.dirname(absolutePath);
  let raw = fs.readFileSync(absolutePath, 'utf8');
  // Strip // comments, which are common in .code-workspace files
  raw = raw.replace(/\/\/[^\n]*/g, '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const folders = (data.folders || []).map((f) => {
    const rel = f.path || '.';
    const resolvedPath = path.resolve(workspaceDir, rel);
    return {
      name: f.name || path.basename(resolvedPath),
      path: rel,
      resolvedPath,
    };
  });

  return {
    workspaceDir,
    workspaceFilePath: absolutePath,
    folders,
  };
}

/**
 * Looks for a workspace file in the usual locations.
 * @param {string} [cwd] - starting directory (defaults to the Cretli directory)
 * @returns {string | null} - path to the workspace file, or null
 */
export function findWorkspaceFile(cwd = path.resolve(__dirname, '..')) {
  const defaultName = process.env.WORKSPACE_FILE_NAME || 'cretli.code-workspace';
  const candidates = [
    path.join(cwd, defaultName),
    path.join(cwd, '..', defaultName),
    path.join(cwd, '..', '..', defaultName),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return path.resolve(p);
  }
  return null;
}

/**
 * Lists every *.code-workspace file in a directory (that level only).
 * @param {string} dir - directory to scan
 * @returns {string[]} - absolute file paths, sorted by name
 */
export function listWorkspaceFiles(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.code-workspace'))
    .map((e) => path.resolve(dir, e.name))
    .sort();
}

/**
 * Lists *.code-workspace files in a directory and its subdirectories.
 * @param {string} dir - directory to scan
 * @param {number} [maxDepth=4] - maximum depth (0 = dir only)
 * @returns {string[]} - absolute file paths, sorted
 */
export function listWorkspaceFilesRecursive(dir, maxDepth = 4) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || maxDepth < 0) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.resolve(dir, e.name);
    if (e.isFile() && e.name.endsWith('.code-workspace')) {
      results.push(full);
    } else if (e.isDirectory() && !e.name.startsWith('.') && maxDepth > 0) {
      results.push(...listWorkspaceFilesRecursive(full, maxDepth - 1));
    }
  }
  return results.sort();
}

/**
 * Classifies a filesystem path as a .code-workspace file or a bare folder.
 *
 * @param {string} rawPath
 * @returns {{
 *   ok: boolean,
 *   kind?: 'file' | 'folders',
 *   workspaceFile?: string,
 *   folder?: string,
 *   name?: string,
 *   error?: string
 * }}
 */
export function inspectWorkspacePath(rawPath, options = {}) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return { ok: false, error: 'missing' };
  const absolutePath = path.resolve(trimmed);
  if (!fs.existsSync(absolutePath)) return { ok: false, error: 'not_found' };
  const stat = fs.statSync(absolutePath);
  if (stat.isFile() && absolutePath.endsWith('.code-workspace')) {
    return {
      ok: true,
      kind: 'file',
      workspaceFile: toPosixPath(absolutePath),
      name: path.basename(absolutePath, '.code-workspace'),
    };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'invalid' };
  if (options.preferFolders) {
    return {
      ok: true,
      kind: 'folders',
      folder: toPosixPath(absolutePath),
      name: path.basename(absolutePath),
    };
  }
  const files = listWorkspaceFiles(absolutePath);
  if (files.length > 0) {
    const workspaceFile = toPosixPath(files[0]);
    return {
      ok: true,
      kind: 'file',
      workspaceFile,
      name: path.basename(files[0], '.code-workspace'),
    };
  }
  return {
    ok: true,
    kind: 'folders',
    folder: toPosixPath(absolutePath),
    name: path.basename(absolutePath),
  };
}

/**
 * Resolves the working directory for an agent chat: a folder pinned on the chat
 * wins, otherwise the directory is derived from the workspace file.
 *
 * @param {import('./persist/chats-persist.js').ChatEntry | null} chat
 * @param {(workspacePath: string | null) => string} workspaceDirForAgent
 * @returns {string | null}
 */
export function resolveSdkCwdForChat(chat, workspaceDirForAgent) {
  if (!chat) {
    return null;
  }
  if (chat.workspaceFolder && String(chat.workspaceFolder).trim()) {
    return path.resolve(String(chat.workspaceFolder).trim());
  }
  return workspaceDirForAgent(chat.workspaceFile || null);
}
