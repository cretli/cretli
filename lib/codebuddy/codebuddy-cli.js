/**
 * Resolves the CodeBuddy CLI executable used by @tencent-ai/agent-sdk.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { loadSettings } from '../persist/settings.js';
import { resolveDataPath } from '../runtime-paths.js';

const require = createRequire(import.meta.url);

const DEFAULT_CLI_NAME = 'codebuddy';

/**
 * @returns {string}
 */
export function getCodeBuddyCliFromEnv() {
  return (process.env.CODEBUDDY_CODE_PATH || '').trim();
}

/**
 * @returns {string}
 */
export function getCodeBuddyCliFromSettings() {
  const settings = loadSettings();
  const bin = settings.codebuddyBin;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : '';
}

/**
 * CLI bundled inside optional @tencent-ai/agent-sdk.
 * @returns {string}
 */
export function resolveBundledCodeBuddyCli() {
  try {
    const sdkEntry = require.resolve('@tencent-ai/agent-sdk');
    const pkgRoot = path.resolve(path.dirname(sdkEntry), '..');
    const candidate = path.join(pkgRoot, 'cli', 'bin', 'codebuddy');
    if (isExecutablePath(candidate)) return candidate;
  } catch {
    return '';
  }
  return '';
}

/**
 * Path or command name to pass as pathToCodebuddyCode.
 * @returns {string}
 */
export function resolveCodeBuddyCli() {
  const fromEnv = getCodeBuddyCliFromEnv();
  if (fromEnv) return fromEnv;
  const fromSettings = getCodeBuddyCliFromSettings();
  if (fromSettings) return fromSettings;
  const bundled = resolveBundledCodeBuddyCli();
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
export function isCodeBuddyCliFound() {
  const resolved = resolveCodeBuddyCli();
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
  }
  return false;
}

const MIN_CODEBUDDY_NODE_MAJOR = 18;

/**
 * Writable HOME for the CodeBuddy CLI. The server often runs as root / under a
 * Node binary that cannot write ~/.codebuddy (EACCES on /root/.codebuddy).
 * @returns {string}
 */
export function resolveCodeBuddyHomeDir() {
  return resolveDataPath('codebuddy-home');
}

/**
 * @returns {string}
 */
export function ensureCodeBuddyHomeDir() {
  const dir = resolveCodeBuddyHomeDir();
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  return dir;
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} cli
 * @returns {string}
 */
function resolveAbsoluteCliPath(cli) {
  if (!cli) return '';
  if (path.isAbsolute(cli)) return isExecutablePath(cli) ? cli : '';
  if (cli.includes(path.sep) || cli.includes('/')) {
    const absolute = path.resolve(cli);
    return isExecutablePath(absolute) ? absolute : '';
  }
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cli);
    if (isExecutablePath(candidate)) return candidate;
    if (process.platform === 'win32' && isExecutablePath(path.join(dir, `${cli}.exe`))) {
      return path.join(dir, `${cli}.exe`);
    }
  }
  return '';
}

/**
 * Node binary used to spawn the CodeBuddy CLI (needs >= 18).
 * @returns {string}
 */
export function resolveCodeBuddyNodePath() {
  const fromEnv = (process.env.CODEBUDDY_NODE_PATH || '').trim();
  if (fromEnv && isExecutablePath(fromEnv)) return fromEnv;
  const currentMajor = Number(String(process.versions.node || '0').split('.')[0]);
  if (Number.isFinite(currentMajor) && currentMajor >= MIN_CODEBUDDY_NODE_MAJOR) {
    return process.execPath;
  }
  const cached = findCachedNpxNodeBinary();
  if (cached) return cached;
  return process.execPath;
}

/**
 * @returns {string}
 */
function findCachedNpxNodeBinary() {
  const roots = [resolveDataPath('npm-cache', '_npx')];
  const npmCache = (process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || '').trim();
  if (npmCache) roots.push(path.join(npmCache, '_npx'));
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const candidate = path.join(root, name, 'node_modules', 'node', 'bin', 'node');
      if (isExecutablePath(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * Wrapper so the SDK spawn uses Node >= 18, not `env node` 17.
 * @returns {string}
 */
export function resolveCodeBuddyCliForSpawn() {
  const cli = resolveCodeBuddyCli();
  const absolute = resolveAbsoluteCliPath(cli);
  if (!absolute) return cli;
  const home = ensureCodeBuddyHomeDir();
  const launcher = path.join(home, 'codebuddy-launcher.sh');
  const nodePath = resolveCodeBuddyNodePath();
  const body = `#!/usr/bin/env bash\nexec ${quoteShellArg(nodePath)} ${quoteShellArg(absolute)} "$@"\n`;
  let previous = '';
  try {
    previous = fs.readFileSync(launcher, 'utf8');
  } catch {
    previous = '';
  }
  if (previous !== body) {
    fs.writeFileSync(launcher, body, { mode: 0o755 });
  }
  try {
    fs.chmodSync(launcher, 0o755);
  } catch {
    // ignore chmod failures on odd filesystems
  }
  return launcher;
}
