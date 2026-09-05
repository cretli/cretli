/**
 * Resolves the optional Qwen Code executable override.
 * The SDK bundles its own CLI; an explicit path is only needed for a custom binary.
 */

import fs from 'fs';
import path from 'path';
import { loadSettings } from '../persist/settings.js';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import { resolveDataPath } from '../runtime-paths.js';

const DEFAULT_CLI_NAME = 'qwen';

/**
 * @returns {string}
 */
export function getQwenCliFromEnv() {
  return (process.env.QWEN_BIN || process.env.QWEN_CODE_PATH || '').trim();
}

/**
 * @returns {string}
 */
export function getQwenCliFromSettings() {
  const settings = loadSettings();
  const bin = settings.qwenBin;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : '';
}

/**
 * Isolated HOME for Qwen Code settings and sessions.
 * @returns {string}
 */
export function resolveQwenHomeDir() {
  return resolveDataPath('qwen-home');
}

/**
 * @returns {string}
 */
export function ensureQwenHomeDir() {
  return ensureWritableDir(resolveQwenHomeDir());
}

/**
 * Path for `pathToQwenExecutable`, or empty to use the SDK-bundled CLI.
 * @returns {string}
 */
export function resolveQwenCli() {
  const fromEnv = getQwenCliFromEnv();
  if (fromEnv) return fromEnv;
  return getQwenCliFromSettings();
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isExecutablePath(candidate) {
  if (!candidate) return false;
  try {
    if (!fs.existsSync(candidate)) return false;
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * True when an explicit CLI override exists as a file or on PATH.
 * Bundled SDK CLI does not need this — ready = SDK + API key.
 * @returns {boolean}
 */
export function isQwenCliFound() {
  const resolved = resolveQwenCli();
  if (!resolved) return false;
  if (path.isAbsolute(resolved)) return isExecutablePath(resolved);
  if (resolved.includes(path.sep) || resolved.includes('/')) {
    return isExecutablePath(path.resolve(resolved));
  }
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (isExecutablePath(path.join(dir, resolved))) return true;
    if (process.platform === 'win32' && isExecutablePath(path.join(dir, `${resolved}.exe`))) {
      return true;
    }
    if (resolved === DEFAULT_CLI_NAME && isExecutablePath(path.join(dir, 'qwen.js'))) {
      return true;
    }
  }
  return false;
}
