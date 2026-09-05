/**
 * Parsing of .code-workspace files (VS Code / Cursor).
 * Folder paths may be relative to the workspace file, POSIX/Windows absolute, ~, or file:// URIs.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { fileURLToPath } from 'url';
import { toPosixPath } from './persist/workspace-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Converts a file:// URI to a filesystem path (POSIX or Windows).
 *
 * @param {string} value
 * @returns {string}
 */
function fileUrlToPath(value) {
  if (!/^file:/i.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return '';
    const pathname = decodeURIComponent(url.pathname || '');
    const windowsFromUnix = pathname.match(/^\/([A-Za-z]:\/.*)$/);
    if (windowsFromUnix) return windowsFromUnix[1];
    return pathname;
  } catch {
    return '';
  }
}

/**
 * Maps a Windows drive path to a WSL mount when running on Linux.
 *
 * @param {string} value
 * @returns {string}
 */
function windowsDriveToWslPath(value) {
  if (process.platform === 'win32') return '';
  const match = value.replace(/\\/g, '/').match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return '';
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/**
 * Resolves a .code-workspace folder specifier against the file's directory.
 *
 * @param {string} workspaceDir
 * @param {string} folderPath
 * @returns {string}
 */
export function resolveWorkspaceFolderPath(workspaceDir, folderPath) {
  const trimmed = String(folderPath || '').trim() || '.';
  const fromUrl = fileUrlToPath(trimmed);
  const raw = expandUserPath(fromUrl || trimmed);
  const asWsl = windowsDriveToWslPath(raw);
  if (asWsl) return path.resolve(asWsl);
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(workspaceDir, raw);
}

/**
 * Reads and parses a workspace file, tolerating JSONC comments and trailing commas.
 * @param {string} workspaceFilePath - absolute path to the .code-workspace file
 * @returns {{ folders: Array<{ name: string, path: string, resolvedPath: string }>, workspaceDir: string } | null}
 */
export function loadWorkspace(workspaceFilePath) {
  const absolutePath = path.resolve(workspaceFilePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  const workspaceDir = path.dirname(absolutePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const data = parseJsonc(raw, [], { allowTrailingComma: true });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const folders = (Array.isArray(data.folders) ? data.folders : []).map((folder) => {
    const item = folder && typeof folder === 'object' ? folder : {};
    const specifier = String(item.path || item.uri || '.').trim() || '.';
    const resolvedPath = resolveWorkspaceFolderPath(workspaceDir, specifier);
    return {
      name: item.name || path.basename(resolvedPath),
      path: item.path || specifier,
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
 * Expands a leading `~` to the process home directory (Node does not do this).
 *
 * @param {string} rawPath
 * @returns {string}
 */
export function expandUserPath(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
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
  const trimmed = expandUserPath(rawPath);
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
