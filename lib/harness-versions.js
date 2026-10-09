/**
 * Read-only inventory of the CLI/SDK versions every harness actually runs.
 *
 * Versions come from the `package.json` files inside Cretli's own npm trees, so
 * a normal install needs no network and no subprocess. A subprocess is only
 * spawned when the harness's existing binary resolver picks a binary that lives
 * outside those trees (`CODEX_BIN`, `DSH_BIN`, `CODEBUDDY_CODE_PATH`, a setting
 * or a bare PATH name): the node_modules version is then not the running one.
 * Such probes run `<bin> --version` with a deadline and a cache, and a failure
 * degrades to `unknown` instead of throwing or hanging the caller.
 *
 * `getHarnessStatus()` is deliberately not used here: it reports availability,
 * not installation (OpenCode answers `available: true` without checking any
 * binary), which would make it a false proof of a version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { getHarnessMeta } from './agent-harness/registry.js';
import { ensureWritableDir } from './ensure-writable-dir.js';
import { resolveDataPath, resolveProjectPath } from './runtime-paths.js';
import { loadSettings } from './persist/settings.js';
import {
  resolveOpenCodeExecutable,
  resolveOpenCodeHomeDirs,
} from './opencode/opencode-spawn-path.js';
import {
  getCodexCliFromEnv,
  getCodexCliFromSettings,
  getCodexPlatformPackageName,
  isCodexCliFound,
  resolveBundledCodexCli,
  resolveCodexCli,
  resolveCodexNativeExecutable,
} from './codex/codex-cli.js';
import {
  getDeepSeekCliFromEnv,
  getDeepSeekCliFromSettings,
  isDeepSeekCliFound,
  resolveBundledDeepSeekCli,
  resolveDeepSeekCli,
} from './deepseek/deepseek-cli.js';
import {
  getCodeBuddyCliFromEnv,
  getCodeBuddyCliFromSettings,
  isCodeBuddyCliFound,
  resolveBundledCodeBuddyCli,
  resolveCodeBuddyCli,
} from './codebuddy/codebuddy-cli.js';
import {
  getQwenCliFromEnv,
  getQwenCliFromSettings,
  resolveQwenCli,
} from './qwen/qwen-cli.js';

/** Where a version number came from. */
export const VERSION_SOURCES = Object.freeze([
  'bundled',
  'env',
  'settings',
  'path',
  'missing',
  'unknown',
]);

/** How much Cretli knows about a package, and whether it owns its updates. */
export const PACKAGE_STATUSES = Object.freeze([
  'missing',
  'unknown',
  'external',
  'managed',
  'n/a',
]);

/** Snapshot file name under the data directory (resolved through resolveDataPath). */
export const SNAPSHOT_FILE_NAME = 'harness-versions.json';

/**
 * Resolutions whose binary lives outside Cretli's own npm trees, so its version
 * must come from `<bin> --version` and never from node_modules.
 */
const EXTERNAL_CLI_SOURCES = Object.freeze(['env', 'settings', 'path']);

const VERSION_TIMEOUT_MS = 4000;
const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_VERSION_LENGTH = 80;
const SEMVER_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * One row per source package of a harness. `cli: true` marks the package that
 * provides the executable the harness really spawns, so its version follows the
 * binary resolver instead of the copy sitting in node_modules.
 *
 * `@openai/codex` and the Codex platform package are transitive dependencies of
 * `@openai/codex-sdk` (npm platform aliases): they are reported as related and
 * are never updatable on their own.
 */
const HARNESS_PACKAGES = Object.freeze([
  {
    harness: 'sdk',
    channel: 'npm',
    packages: [
      { name: '@cursor/sdk', role: 'sdk' },
    ],
  },
  {
    harness: 'openrouter',
    channel: 'api',
    apiOnly: true,
    packages: [],
  },
  {
    harness: 'mistral',
    channel: 'npm',
    packages: [
      { name: '@mistralai/mistralai', role: 'sdk' },
    ],
  },
  {
    harness: 'opencode',
    channel: 'npm',
    packages: [
      { name: '@opencode-ai/sdk', role: 'sdk' },
      { name: 'opencode-ai', role: 'cli', cli: true, bin: 'opencode' },
    ],
  },
  {
    harness: 'codebuddy',
    channel: 'npm',
    packages: [
      { name: '@tencent-ai/agent-sdk', role: 'sdk+cli', cli: true, bin: 'codebuddy' },
    ],
  },
  {
    harness: 'deepseek',
    channel: 'npm',
    packages: [
      { name: '@deepseek-ai/dsh-sdk-client', role: 'sdk' },
      { name: '@deepseek-ai/dsh', role: 'cli', cli: true, bin: 'dsh' },
    ],
  },
  {
    harness: 'codex',
    channel: 'npm',
    packages: [
      { name: '@openai/codex-sdk', role: 'sdk' },
      { name: '@openai/codex', role: 'cli', cli: true, bin: 'codex', requiredBy: '@openai/codex-sdk' },
    ],
    extraPackages: (targetPackage) => (targetPackage
      ? [{ name: targetPackage, role: 'native', requiredBy: '@openai/codex' }]
      : []),
  },
  {
    harness: 'qwen',
    channel: 'npm',
    packages: [
      { name: '@qwen-code/sdk', role: 'sdk+cli', cli: true, bin: 'qwen' },
    ],
  },
  {
    harness: 'claude',
    channel: 'npm-prefix',
    installPrefix: path.join('optional-packages', 'claude-agent-sdk'),
    packages: [
      { name: '@anthropic-ai/claude-agent-sdk', role: 'sdk+cli', cli: true, bin: 'claude' },
      { name: '@anthropic-ai/sdk', role: 'sdk' },
    ],
  },
]);

/**
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown> | null} manifest
 * @param {string} name
 * @returns {string} declared range/spec, or '' when the manifest does not list it
 */
function declaredSpec(manifest, name) {
  if (!manifest) return '';
  for (const field of ['dependencies', 'optionalDependencies']) {
    const block = manifest[field];
    if (!block || typeof block !== 'object') continue;
    const spec = block[name];
    if (typeof spec === 'string' && spec.trim()) return spec.trim();
  }
  return '';
}

/**
 * Reads the installed version of one package out of an npm tree root. Package
 * names come from the frozen table above, so a plain split on the npm scope
 * separator is enough (`@scope/name` -> `node_modules/@scope/name`).
 *
 * @param {string} nodeModulesRoot
 * @param {string} name
 * @returns {{ version: string, present: boolean }}
 */
function readInstalledPackage(nodeModulesRoot, name) {
  const segments = String(name || '').split('/').filter((part) => part && part !== '..');
  const dir = path.join(nodeModulesRoot, ...segments);
  const present = fs.existsSync(dir);
  if (!present) return { version: '', present: false };
  const manifest = readJsonFile(path.join(dir, 'package.json'));
  const version = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
  return { version, present: true };
}

/**
 * Splits a command string such as `codex-cli 0.160.0` into a version token.
 * Falls back to the first output line so unusual formats still surface something.
 *
 * @param {string} raw
 * @returns {string} '' when nothing usable was printed
 */
export function parseVersionOutput(raw) {
  const text = String(raw || '');
  const semantic = SEMVER_PATTERN.exec(text);
  if (semantic) return semantic[0];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, MAX_VERSION_LENGTH);
  }
  return '';
}

/**
 * `bin/codex.js` and `lib/bin.js` are Node wrappers: they only run through a
 * Node binary, and spawning them directly would report a shell error instead.
 *
 * @param {string} bin
 * @param {{ execPath?: string }} [options]
 * @returns {{ file: string, args: string[] }}
 */
export function buildVersionSpawnArgs(bin, options = {}) {
  const execPath = options.execPath || process.execPath;
  const target = String(bin || '').trim();
  if (/\.js$/i.test(target)) return { file: execPath, args: [target, '--version'] };
  return { file: target, args: ['--version'] };
}

/**
 * Runs `<bin> --version` with a hard deadline. Never throws: a missing binary,
 * a non-zero exit or a process that ignores the kill all resolve to ''.
 *
 * @param {string} bin
 * @param {{
 *   timeoutMs?: number,
 *   spawnFactory?: Function,
 *   execPath?: string,
 * }} [options]
 * @returns {Promise<string>} '' when the version could not be read
 */
export function readVersionFromBinary(bin, options = {}) {
  const target = String(bin || '').trim();
  if (!target) return Promise.resolve('');
  const timeoutMs = Number(options.timeoutMs);
  const spawnFactory = options.spawnFactory || spawn;
  const { file, args } = buildVersionSpawnArgs(target, options);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : VERSION_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child = null;
    const timer = setTimeout(() => {
      try {
        child?.kill?.('SIGKILL');
      } catch {
        // A process that cannot be killed is not worth throwing over.
      }
      finish('');
    }, deadline);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    try {
      child = spawnFactory(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      finish('');
      return;
    }
    if (!child || typeof child.on !== 'function') {
      finish('');
      return;
    }
    child.stdout?.on?.('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(0, MAX_VERSION_LENGTH * 4);
    });
    child.stderr?.on?.('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, MAX_VERSION_LENGTH * 4);
    });
    child.on('error', () => finish(''));
    child.on('close', (code) => {
      if (code !== 0) {
        finish('');
        return;
      }
      finish(parseVersionOutput(`${stdout}\n${stderr}`));
    });
  });
}

/** Cache of `<bin> --version` results, shared across requests. */
const binaryVersionCache = new Map();

/**
 * @param {string} bin
 * @param {object} options
 * @returns {Promise<string>} '' when the version is unknown
 */
async function readVersionFromBinaryCached(bin, options) {
  const target = String(bin || '').trim();
  if (!target) return '';
  const { file, args } = buildVersionSpawnArgs(target, options);
  const cache = options.cache || binaryVersionCache;
  const now = typeof options.now === 'function' ? options.now : (() => Date.now());
  const key = `${file}\u0000${args.join('\u0000')}`;
  const cached = cache.get(key);
  const ttl = Number(options.cacheTtlMs) > 0 ? Number(options.cacheTtlMs) : VERSION_CACHE_TTL_MS;
  if (cached && now() - cached.at < ttl) return cached.version;
  const version = await readVersionFromBinary(target, options);
  cache.set(key, { version, at: now() });
  return version;
}

/**
 * Which executable the Codex harness really spawns, reusing its resolver.
 *
 * @returns {{ source: string, bin: string }}
 */
function resolveCodexCliSource() {
  if (getCodexCliFromEnv()) return { source: 'env', bin: resolveCodexCli() };
  if (getCodexCliFromSettings()) return { source: 'settings', bin: resolveCodexCli() };
  const native = resolveCodexNativeExecutable();
  if (native) return { source: 'bundled', bin: native };
  const wrapper = resolveBundledCodexCli();
  if (wrapper) return { source: 'bundled', bin: wrapper };
  if (isCodexCliFound()) return { source: 'path', bin: resolveCodexCli() };
  return { source: 'missing', bin: '' };
}

/**
 * @returns {{ source: string, bin: string }}
 */
function resolveDeepSeekCliSource() {
  if (getDeepSeekCliFromEnv()) return { source: 'env', bin: resolveDeepSeekCli() };
  if (getDeepSeekCliFromSettings()) return { source: 'settings', bin: resolveDeepSeekCli() };
  if (resolveBundledDeepSeekCli()) return { source: 'bundled', bin: resolveDeepSeekCli() };
  if (isDeepSeekCliFound()) return { source: 'path', bin: resolveDeepSeekCli() };
  return { source: 'missing', bin: '' };
}

/**
 * @returns {{ source: string, bin: string }}
 */
function resolveCodeBuddyCliSource() {
  if (getCodeBuddyCliFromEnv()) return { source: 'env', bin: resolveCodeBuddyCli() };
  if (getCodeBuddyCliFromSettings()) return { source: 'settings', bin: resolveCodeBuddyCli() };
  if (resolveBundledCodeBuddyCli()) return { source: 'bundled', bin: resolveCodeBuddyCli() };
  if (isCodeBuddyCliFound()) return { source: 'path', bin: resolveCodeBuddyCli() };
  return { source: 'missing', bin: '' };
}

/**
 * The Qwen SDK ships its own CLI, so an installed package is the bundled case;
 * only an explicit override points at a binary Cretli does not own.
 *
 * @returns {{ source: string, bin: string }}
 */
function resolveQwenCliSource() {
  if (getQwenCliFromEnv()) return { source: 'env', bin: resolveQwenCli() };
  if (getQwenCliFromSettings()) return { source: 'settings', bin: resolveQwenCli() };
  return { source: 'bundled', bin: '' };
}

/**
 * OpenCode resolves an executable path (project node_modules, ~/.opencode/bin or
 * a configured binary). A path inside Cretli's own tree stays bundled.
 *
 * @param {object} context
 * @returns {{ source: string, bin: string }}
 */
function resolveOpenCodeCliSource(context) {
  const configuredBin = typeof context.settings?.opencodeBin === 'string'
    ? context.settings.opencodeBin.trim()
    : '';
  const homeDirs = Array.isArray(context.homeDirs)
    ? context.homeDirs
    : resolveOpenCodeHomeDirs(context.openCodeHomeDirs || {});
  const executable = resolveOpenCodeExecutable({
    configuredBin,
    homeDirs,
    projectRoot: context.projectRoot,
  });
  if (!executable) return { source: 'missing', bin: '' };
  if (configuredBin && path.resolve(executable) === path.resolve(configuredBin)) {
    return { source: 'settings', bin: executable };
  }
  if (isInsideDirectory(executable, path.join(context.projectRoot, 'node_modules'))) {
    return { source: 'bundled', bin: executable };
  }
  return { source: 'path', bin: executable };
}

/**
 * Claude lives in its own npm prefix installed with
 * `npm ci --ignore-scripts --prefix optional-packages/claude-agent-sdk`, and its
 * CLI is bundled inside the SDK, so no external binary is consulted.
 *
 * @returns {{ source: string, bin: string }}
 */
function resolveClaudeCliSource() {
  return { source: 'bundled', bin: '' };
}

const CLI_SOURCES = Object.freeze({
  codex: resolveCodexCliSource,
  deepseek: resolveDeepSeekCliSource,
  codebuddy: resolveCodeBuddyCliSource,
  qwen: resolveQwenCliSource,
  opencode: resolveOpenCodeCliSource,
  claude: resolveClaudeCliSource,
});

/**
 * @param {string} target
 * @param {string} directory
 * @returns {boolean}
 */
function isInsideDirectory(target, directory) {
  const relative = path.relative(directory, path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * @param {{ name: string, role: string, cli?: boolean, requiredBy?: string }} packageSpec
 * @param {{ version: string, present: boolean }} installed
 * @param {string} owningSpec
 * @param {{ source: string, bin: string }|null} cliSource
 * @param {string} probedVersion
 * @returns {object}
 */
function buildPackageRow(packageSpec, installed, owningSpec, cliSource, probedVersion) {
  const row = {
    name: packageSpec.name,
    role: packageSpec.role,
    installed: installed.version || null,
    source: 'unknown',
    status: 'unknown',
    canUpdate: false,
    declared: Boolean(owningSpec),
    ...(owningSpec ? { declaredSpec: owningSpec } : {}),
    ...(packageSpec.requiredBy ? { requiredBy: packageSpec.requiredBy } : {}),
  };

  // Version provenance first, then the running-binary override below.
  if (installed.present && installed.version) {
    row.source = 'bundled';
    row.status = 'managed';
    // A package Cretli declares is updatable by bumping that manifest; a
    // transitive one (no entry in any Cretli manifest) never is.
    row.canUpdate = Boolean(owningSpec);
  } else if (!installed.present) {
    row.source = 'missing';
    row.status = 'missing';
  }

  const externalSource = cliSource && EXTERNAL_CLI_SOURCES.includes(cliSource.source)
    ? cliSource.source
    : '';
  if (packageSpec.cli && cliSource?.source === 'missing') {
    row.source = 'missing';
    row.status = 'missing';
    row.canUpdate = false;
    return row;
  }
  if (externalSource) {
    // The binary that runs is not the copy in node_modules, so the bundled
    // number is dropped even when the package is installed: keeping it would
    // claim a version Cretli never executes.
    row.source = externalSource;
    row.installed = probedVersion || null;
    row.status = probedVersion ? 'external' : 'unknown';
    row.canUpdate = false;
  }
  return row;
}

/**
 * Harness-level rollup of the package rows, so a caller can sort without
 * walking the array. A harness that has nothing installed is `missing`; one
 * that runs a binary Cretli does not own is `external`.
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function rollupHarnessStatus(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const statuses = all.map((row) => row.status);
  if (!statuses.length) return 'unknown';
  if (statuses.every((status) => status === 'missing')) return 'missing';
  if (statuses.includes('missing')) return 'missing';
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('external')) return 'external';
  // Transitive native platform rows can pull the rollup down when missing but
  // cannot alone justify `managed`.
  const primary = all.filter((row) => !(row.requiredBy && row.role === 'native'));
  if (primary.map((row) => row.status).includes('managed')) return 'managed';
  return 'unknown';
}

/**
 * @param {object} spec
 * @param {string} projectRoot
 * @returns {string}
 */
function nodeModulesRootFor(spec, projectRoot) {
  if (!spec.installPrefix) return path.join(projectRoot, 'node_modules');
  return path.join(projectRoot, spec.installPrefix, 'node_modules');
}

/**
 * @param {object} spec
 * @returns {object[]}
 */
function packageSpecsFor(spec) {
  const base = spec.packages.slice();
  if (typeof spec.extraPackages !== 'function') return base;
  return base.concat(spec.extraPackages(getCodexPlatformPackageName()));
}

/**
 * @param {object} spec
 * @param {{
 *   settings: object,
 *   projectRoot: string,
 *   spawnFactory?: Function,
 *   timeoutMs?: number,
 *   cache?: Map<string, {version: string, at: number}>,
 *   now?: () => number,
 *   execPath?: string,
 * }} context
 * @returns {Promise<object>}
 */
async function buildHarnessEntry(spec, context) {
  const meta = getHarnessMeta(spec.harness);
  const checkedAt = context.checkedAt;
  const base = {
    harness: spec.harness,
    label: meta?.label || spec.harness,
    channel: spec.channel,
    ...(spec.installPrefix ? { installPrefix: spec.installPrefix } : {}),
    packages: [],
    status: 'n/a',
    canUpdate: false,
    checkedAt,
  };
  if (spec.apiOnly) return base;

  const nodeModulesRoot = nodeModulesRootFor(spec, context.projectRoot);
  const owningManifest = readJsonFile(path.join(
    spec.installPrefix ? path.join(context.projectRoot, spec.installPrefix) : context.projectRoot,
    'package.json',
  ));
  const cliResolver = CLI_SOURCES[spec.harness];
  const cliSource = typeof cliResolver === 'function' ? cliResolver(context) : null;

  const specs = packageSpecsFor(spec);
  const rows = await Promise.all(specs.map(async (packageSpec) => {
    const installed = readInstalledPackage(nodeModulesRoot, packageSpec.name);
    const usesCli = Boolean(packageSpec.cli) && cliSource;
    const needsProbe = usesCli && EXTERNAL_CLI_SOURCES.includes(cliSource.source);
    const probedVersion = needsProbe
      ? await readVersionFromBinaryCached(cliSource.bin, context)
      : '';
    return buildPackageRow(
      packageSpec,
      installed,
      declaredSpec(owningManifest, packageSpec.name),
      usesCli ? cliSource : null,
      probedVersion,
    );
  }));

  return {
    ...base,
    packages: rows,
    status: rollupHarnessStatus(rows),
    canUpdate: rows.some((row) => row.canUpdate === true),
  };
}

/**
 * Collects the version inventory for every harness. Read-only: no vendor
 * network call, and at most one short-lived subprocess per externally resolved
 * binary (cached afterwards).
 *
 * @param {{
 *   projectRoot?: string,
 *   homeDirs?: string[],
 *   openCodeHomeDirs?: { envHome?: string, passwdHome?: string },
 *   spawnFactory?: Function,
 *   timeoutMs?: number,
 *   cache?: Map<string, {version: string, at: number}>,
 *   cacheTtlMs?: number,
 *   execPath?: string,
 *   checkedAt?: string,
 * }} [options]
 * @returns {Promise<{ checkedAt: string, harnesses: object[] }>}
 */
export async function collectHarnessVersions(options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  const context = {
    settings: loadSettings(),
    projectRoot: options.projectRoot || resolveProjectPath(),
    homeDirs: options.homeDirs,
    openCodeHomeDirs: options.openCodeHomeDirs,
    spawnFactory: options.spawnFactory,
    timeoutMs: options.timeoutMs,
    cache: options.cache,
    cacheTtlMs: options.cacheTtlMs,
    execPath: options.execPath,
    checkedAt,
  };
  const harnesses = await Promise.all(HARNESS_PACKAGES.map((spec) => buildHarnessEntry(spec, context)));
  return { checkedAt, harnesses };
}

/**
 * @param {object} result
 * @param {{ snapshotPath?: string }} [options]
 * @returns {string} path written
 */
export function writeHarnessVersionsSnapshot(result, options = {}) {
  const filePath = options.snapshotPath || resolveDataPath(SNAPSHOT_FILE_NAME);
  ensureWritableDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

/**
 * Last persisted snapshot, or null when it does not exist or cannot be parsed.
 *
 * @param {{ snapshotPath?: string }} [options]
 * @returns {object|null}
 */
export function readHarnessVersionsSnapshot(options = {}) {
  const filePath = options.snapshotPath || resolveDataPath(SNAPSHOT_FILE_NAME);
  return readJsonFile(filePath);
}

/**
 * Inventory plus the persisted snapshot used by later leaves (update checks,
 * UI card). A failed snapshot write is reported, never fatal for the request.
 *
 * @param {{ persist?: boolean, snapshotPath?: string } & object} [options]
 * @returns {Promise<{ checkedAt: string, harnesses: object[], snapshotPath?: string, snapshotError?: string }>}
 */
export async function getHarnessVersionInventory(options = {}) {
  const result = await collectHarnessVersions(options);
  if (options.persist === false) return result;
  try {
    const snapshotPath = writeHarnessVersionsSnapshot(result, { snapshotPath: options.snapshotPath });
    return { ...result, snapshotPath };
  } catch (err) {
    return { ...result, snapshotError: err instanceof Error ? err.message : String(err) };
  }
}
