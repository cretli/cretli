/**
 * Resolves the Codex CLI executable used by @openai/codex-sdk.
 *
 * `@openai/codex/bin/codex.js` is only a Node wrapper. The native binary lives
 * in an optional platform package (e.g. `@openai/codex-linux-arm64`). Termux
 * reports `process.platform === 'android'`, so npm skips that linux-only
 * optional dep and login dies inside findCodexExecutable.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { loadSettings } from '../persist/settings.js';
import { ensureCodexTermuxLauncher, isTermuxLike } from './codex-termux-net.js';

const require = createRequire(import.meta.url);

const DEFAULT_CLI_NAME = 'codex';

const PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function getCodexTargetTriple(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
    return '';
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    return '';
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    return '';
  }
  return '';
}

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function getCodexPlatformPackageName(platform = process.platform, arch = process.arch) {
  const triple = getCodexTargetTriple(platform, arch);
  return triple ? (PLATFORM_PACKAGE_BY_TARGET[triple] || '') : '';
}

export { isTermuxLike };

/**
 * @param {string} pkgName
 * @returns {string}
 */
function getPlatformPackageInstallSpec(pkgName) {
  if (!pkgName) return '';
  try {
    const pkgJsonPath = require.resolve('@openai/codex/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const spec = pkg?.optionalDependencies?.[pkgName];
    if (typeof spec === 'string' && spec.trim()) return `${pkgName}@${spec.trim()}`;
  } catch {
    /* wrapper package not installed */
  }
  return pkgName;
}

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function getCodexCliMissingHint(platform = process.platform, arch = process.arch, env = process.env) {
  const pkg = getCodexPlatformPackageName(platform, arch);
  if (!pkg) {
    return `Codex CLI has no native binary for ${platform} (${arch}).`;
  }
  const installSpec = getPlatformPackageInstallSpec(pkg);
  if (isTermuxLike(platform, env)) {
    return `Codex native CLI is missing. Termux/Android skips the linux optional package. In the Cretli folder run: npm install ${installSpec} --force`;
  }
  return `Codex native CLI is missing (optional ${pkg}). In the Cretli folder run: npm install ${installSpec}`;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isCodexNativeMissingOutput(text) {
  const raw = String(text || '');
  if (/findCodexExecutable/.test(raw)) return true;
  if (/Missing optional dependency @openai\/codex-/.test(raw)) return true;
  return false;
}

/**
 * @returns {string}
 */
export function getCodexCliFromEnv() {
  return (process.env.CODEX_BIN || '').trim();
}

/**
 * @returns {string}
 */
export function getCodexCliFromSettings() {
  const settings = loadSettings();
  const bin = settings.codexBin;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : '';
}

/**
 * Native vendor binary next to the optional platform package.
 *
 * @returns {string}
 */
export function resolveCodexNativeExecutable() {
  const triple = getCodexTargetTriple();
  const platformPackage = getCodexPlatformPackageName();
  if (!triple || !platformPackage) return '';
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [];
  try {
    const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
    const vendorRoot = path.join(path.dirname(packageJsonPath), 'vendor');
    candidates.push(path.join(vendorRoot, triple, 'bin', exeName));
  } catch {
    /* optional platform package not installed */
  }
  try {
    const wrapperJson = require.resolve('@openai/codex/package.json');
    const wrapperRoot = path.dirname(wrapperJson);
    candidates.push(path.join(wrapperRoot, 'vendor', triple, 'bin', exeName));
  } catch {
    /* wrapper package not installed */
  }
  for (const candidate of candidates) {
    if (isExecutablePath(candidate)) return candidate;
  }
  return '';
}

/**
 * CLI bundled inside optional @openai/codex (Node wrapper).
 * @returns {string}
 */
export function resolveBundledCodexCli() {
  try {
    const pkgJson = require.resolve('@openai/codex/package.json');
    const pkgRoot = path.dirname(pkgJson);
    const candidates = [
      path.join(pkgRoot, 'bin', 'codex.js'),
      path.join(pkgRoot, 'bin', 'codex'),
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
 * Path or command name to pass as codexPathOverride.
 * Prefers the native binary so login/exec skip the JS wrapper.
 * @returns {string}
 */
export function resolveCodexCli() {
  const fromEnv = getCodexCliFromEnv();
  if (fromEnv) return ensureCodexTermuxLauncher(fromEnv) || fromEnv;
  const fromSettings = getCodexCliFromSettings();
  if (fromSettings) return ensureCodexTermuxLauncher(fromSettings) || fromSettings;
  const native = resolveCodexNativeExecutable();
  if (native) return ensureCodexTermuxLauncher(native) || native;
  const bundled = resolveBundledCodexCli();
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
 * @param {string} candidate
 * @returns {boolean}
 */
function isCodexJsWrapper(candidate) {
  return path.basename(candidate) === 'codex.js';
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isUsableCodexCli(candidate) {
  if (!isExecutablePath(candidate)) return false;
  if (isCodexJsWrapper(candidate)) return !!resolveCodexNativeExecutable();
  return true;
}

/**
 * True when the resolved CLI exists as an absolute file or on PATH.
 * A Node wrapper without the native vendor binary does not count.
 * @returns {boolean}
 */
export function isCodexCliFound() {
  const resolved = resolveCodexCli();
  if (path.isAbsolute(resolved)) return isUsableCodexCli(resolved);
  if (resolved.includes(path.sep) || resolved.includes('/')) {
    return isUsableCodexCli(path.resolve(resolved));
  }
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const asName = path.join(dir, resolved);
    if (isUsableCodexCli(asName)) return true;
    if (process.platform === 'win32' && isUsableCodexCli(path.join(dir, `${resolved}.exe`))) {
      return true;
    }
    if (resolved === DEFAULT_CLI_NAME && isUsableCodexCli(path.join(dir, 'codex.js'))) {
      return true;
    }
  }
  return !!resolveCodexNativeExecutable();
}
