/**
 * Resolves the DeepSeek Harness (`dsh`) executable used by @deepseek-ai/dsh-sdk-client.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { loadSettings } from '../persist/settings.js';

const require = createRequire(import.meta.url);

const DEFAULT_CLI_NAME = 'dsh';

/**
 * @returns {string}
 */
export function getDeepSeekCliFromEnv() {
  return (process.env.DSH_BIN || '').trim();
}

/**
 * @returns {string}
 */
export function getDeepSeekCliFromSettings() {
  const settings = loadSettings();
  const bin = settings.deepseekBin;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : '';
}

/**
 * CLI bundled inside optional @deepseek-ai/dsh.
 * @returns {string}
 */
export function resolveBundledDeepSeekCli() {
  try {
    const pkgJson = require.resolve('@deepseek-ai/dsh/package.json');
    const pkgRoot = path.dirname(pkgJson);
    const candidates = [
      path.join(pkgRoot, 'lib', 'bin.js'),
      path.join(pkgRoot, 'bin', 'dsh'),
      path.join(pkgRoot, 'bin', 'dsh.js'),
    ];
    for (const candidate of candidates) {
      if (isExecutablePath(candidate)) return candidate;
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Path or command name to pass as dshBin.
 * @returns {string}
 */
export function resolveDeepSeekCli() {
  const fromEnv = getDeepSeekCliFromEnv();
  if (fromEnv) return fromEnv;
  const fromSettings = getDeepSeekCliFromSettings();
  if (fromSettings) return fromSettings;
  const bundled = resolveBundledDeepSeekCli();
  if (bundled) return bundled;
  return DEFAULT_CLI_NAME;
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isExecutablePath(candidate) {
  if (!candidate) return false;
  try {
    if (!fs.existsSync(candidate)) return false;
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * True when the resolved CLI exists as an absolute file or on PATH.
 * @returns {boolean}
 */
export function isDeepSeekCliFound() {
  const resolved = resolveDeepSeekCli();
  if (path.isAbsolute(resolved)) return isExecutablePath(resolved);
  if (resolved.includes(path.sep) || resolved.includes('/')) {
    return isExecutablePath(path.resolve(resolved));
  }
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    if (isExecutablePath(path.join(dir, resolved))) return true;
    if (process.platform === 'win32' && isExecutablePath(path.join(dir, `${resolved}.exe`))) {
      return true;
    }
    if (resolved === DEFAULT_CLI_NAME && isExecutablePath(path.join(dir, 'dsh.js'))) {
      return true;
    }
  }
  return resolveBundledDeepSeekCli() !== '';
}
