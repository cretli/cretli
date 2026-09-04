/**
 * Resolve the OpenCode CLI and a PATH that Node can search.
 *
 * When Cretli drops privileges but inherits a Cursor-remote PATH, later entries
 * under /root are not searchable. libuv then fails the whole spawn with EACCES
 * instead of continuing to the next directory.
 */

import { accessSync, constants, statSync } from 'fs';
import { homedir, userInfo } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const OPENCODE_PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Home directory from the passwd database (ignores a misleading HOME=/root).
 *
 * @returns {string}
 */
export function resolveOpenCodeUserHome() {
  try {
    const fromPasswd = userInfo().homedir;
    if (fromPasswd) return fromPasswd;
  } catch {
    // userInfo() can throw in restricted environments
  }
  return homedir() || '';
}

/**
 * @param {string} dirPath
 * @returns {boolean}
 */
export function isSearchablePathDirectory(dirPath) {
  const dir = String(dirPath || '').trim();
  if (!dir) return false;
  try {
    accessSync(dir, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExecutableFile(filePath) {
  const candidate = String(filePath || '').trim();
  if (!candidate) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Drop PATH entries the current uid cannot search (avoids spawn EACCES).
 *
 * @param {string} pathEnv
 * @param {{ canSearchDir?: (dir: string) => boolean, delimiter?: string }} [options]
 * @returns {string}
 */
export function sanitizeSpawnPath(pathEnv, options = {}) {
  const canSearch = options.canSearchDir || isSearchablePathDirectory;
  const delimiter = options.delimiter || path.delimiter;
  const kept = [];
  const seen = new Set();
  for (const dir of String(pathEnv || '').split(delimiter)) {
    if (!dir || seen.has(dir)) continue;
    if (!canSearch(dir)) continue;
    seen.add(dir);
    kept.push(dir);
  }
  return kept.join(delimiter);
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function bundledOpenCodePath(projectRoot) {
  const root = String(projectRoot || '').trim();
  if (!root) return '';
  const platform = process.platform;
  const arch = process.arch;
  let packageName = '';
  if (platform === 'linux' && arch === 'x64') packageName = 'opencode-linux-x64';
  else if (platform === 'linux' && arch === 'arm64') packageName = 'opencode-linux-arm64';
  else if (platform === 'darwin' && arch === 'arm64') packageName = 'opencode-darwin-arm64';
  else if (platform === 'darwin' && arch === 'x64') packageName = 'opencode-darwin-x64';
  else if (platform === 'win32' && arch === 'x64') packageName = 'opencode-windows-x64';
  else if (platform === 'win32' && arch === 'arm64') packageName = 'opencode-windows-arm64';
  if (!packageName) return '';
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  return path.join(root, 'node_modules', packageName, 'bin', binaryName);
}

/**
 * @param {{
 *   configuredBin?: string,
 *   homeDirs?: string[],
 *   projectRoot?: string,
 *   isExecutable?: (filePath: string) => boolean,
 * }} [options]
 * @returns {string}
 */
export function resolveOpenCodeExecutable(options = {}) {
  const isExecutable = options.isExecutable || isExecutableFile;
  const configuredBin = String(options.configuredBin || '').trim();
  const homeDirs = Array.isArray(options.homeDirs) ? options.homeDirs : [];
  const projectRoot = String(options.projectRoot || '').trim();
  const candidates = [];
  if (configuredBin.includes('/') || configuredBin.includes('\\')) {
    candidates.push(configuredBin);
  }
  if (projectRoot) {
    candidates.push(bundledOpenCodePath(projectRoot));
    candidates.push(path.join(projectRoot, 'node_modules', '.bin', 'opencode'));
  }
  for (const home of homeDirs) {
    const normalized = String(home || '').trim();
    if (!normalized) continue;
    candidates.push(path.join(normalized, '.opencode', 'bin', 'opencode'));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isExecutable(candidate)) return candidate;
  }
  return '';
}

/**
 * @param {{
 *   pathEnv?: string,
 *   executablePath?: string,
 *   canSearchDir?: (dir: string) => boolean,
 *   delimiter?: string,
 * }} [options]
 * @returns {string}
 */
export function buildOpenCodeSpawnPath(options = {}) {
  const delimiter = options.delimiter || path.delimiter;
  const sanitized = sanitizeSpawnPath(options.pathEnv || '', {
    canSearchDir: options.canSearchDir,
    delimiter,
  });
  const executablePath = String(options.executablePath || '').trim();
  if (!executablePath) return sanitized;
  const binDir = path.dirname(executablePath);
  if (!binDir || binDir === '.') return sanitized;
  const rest = sanitized.split(delimiter).filter((dir) => dir && dir !== binDir);
  return [binDir, ...rest].join(delimiter);
}

/**
 * Mutates process.env.PATH so `@opencode-ai/sdk` can spawn `opencode`.
 *
 * @param {{
 *   configuredBin?: string,
 *   homeDirs?: string[],
 *   projectRoot?: string,
 * }} [options]
 * @returns {string} resolved executable path, or empty when none found
 */
export function applyOpenCodeSpawnPath(options = {}) {
  const executablePath = resolveOpenCodeExecutable({
    configuredBin: options.configuredBin,
    homeDirs: options.homeDirs,
    projectRoot: options.projectRoot ?? OPENCODE_PROJECT_ROOT,
  });
  process.env.PATH = buildOpenCodeSpawnPath({
    pathEnv: process.env.PATH || '',
    executablePath,
  });
  return executablePath;
}
