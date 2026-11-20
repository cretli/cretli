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
import { ensureCodexTermuxLauncher, isTermuxLike } from './codex-termux-net.ts';

const require = createRequire(import.meta.url);

const DEFAULT_CLI_NAME = 'codex';

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

export function getCodexTargetTriple(platform: string = process.platform, arch: string = process.arch): string {
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

export function getCodexPlatformPackageName(platform: string = process.platform, arch: string = process.arch): string {
  const triple = getCodexTargetTriple(platform, arch);
  return triple ? (PLATFORM_PACKAGE_BY_TARGET[triple] || '') : '';
}

export { isTermuxLike };

function getPlatformPackageInstallSpec(pkgName: string): string {
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

export function getCodexCliMissingHint(platform: string = process.platform, arch: string = process.arch, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
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

export function isCodexNativeMissingOutput(text: string): boolean {
  const raw = String(text || '');
  if (/findCodexExecutable/.test(raw)) return true;
  if (/Missing optional dependency @openai\/codex-/.test(raw)) return true;
  return false;
}

export function getCodexCliFromEnv(): string {
  return (process.env.CODEX_BIN || '').trim();
}

export function getCodexCliFromSettings(): string {
  const settings = loadSettings();
  const bin = settings.codexBin;
  return typeof bin === 'string' && bin.trim() ? bin.trim() : '';
}

/**
 * Native vendor binary next to the optional platform package.
 */
export function resolveCodexNativeExecutable(): string {
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
 */
export function resolveBundledCodexCli(): string {
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
 */
export function resolveCodexCli(): string {
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

function isExecutablePath(candidate: string): boolean {
  if (!candidate) return false;
  try {
    if (!fs.existsSync(candidate)) return false;
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isCodexJsWrapper(candidate: string): boolean {
  return path.basename(candidate) === 'codex.js';
}

function isUsableCodexCli(candidate: string): boolean {
  if (!isExecutablePath(candidate)) return false;
  if (isCodexJsWrapper(candidate)) return !!resolveCodexNativeExecutable();
  return true;
}

/**
 * True when the resolved CLI exists as an absolute file or on PATH.
 * A Node wrapper without the native vendor binary does not count.
 */
export function isCodexCliFound(): boolean {
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
