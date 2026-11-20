/**
 * Boot loader for repo-shipped harness plugins (`builtin-optional` origin).
 *
 * Unlike local plugins (harness-plugin-loader.js: admin-supplied root, chat
 * only), these live in the repository under `harnesses/<id>/`, are trusted like
 * the rest of the code and fill the same four registries as a built-in harness:
 * providers (heavy entry), backends and MCP adapters (light entry) and the
 * front-end settings panels (static import map in the browser bundle).
 *
 * Which plugins load: when `CRETLI_OPTIONAL_HARNESSES` is SET (even to an empty
 * string) exactly the listed ids are imported; when it is UNSET, every plugin
 * whose manifest has `defaultEnabled: true` loads (so a harness that left the
 * core keeps working on existing installs). A plugin that is not selected is
 * never imported. Discovery never throws; a broken plugin becomes an entry in
 * `errors` and the host keeps booting.
 *
 * This module imports the providers module, so it belongs to the heavy side:
 * light composition roots must never import it.
 */

import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateHarnessPluginManifest } from './harness-plugin-contract.ts';
import type { HarnessPluginManifest } from './harness-plugin-contract.ts';
import type { BuiltinHarnessProvider } from './builtin-harness-providers.ts';
import type { AgentTransport } from '../agent-transport.js';
import { defineBuiltinProvider, getBuiltinHarnessProvider, registerOptionalHarnessProvider } from './builtin-harness-providers.ts';
import { hasHarnessBackend, registerOptionalHarnessBackend } from './builtin-harness-backends.ts';
import { hasHarnessMcpAdapter, registerOptionalHarnessMcpAdapter } from '../mcp/adapters/index.js';
import { hasTitleProviderAdapter, registerOptionalTitleProvider } from '../chat-title-providers.js';
import { hasHarnessVersionsRow, registerOptionalHarnessVersions } from '../harness-versions.js';
import {
  hasOptionalHarnessHooks,
  registerCreditLedgerContribution,
  registerHarnessBillingCredentialSource,
  registerHarnessLimitBinding,
} from './optional-harness-hooks.ts';
import { hasHarnessMeta, registerOptionalHarnessMeta } from './registry.ts';
import { resolveProjectPath } from '../runtime-paths.js';
import { setLoadedOptionalHarnessIds } from './optional-harness-state.ts';
import {
  OPTIONAL_HARNESSES_ENV,
  isOptionalHarnessSelectionExplicit,
  orderByDependencies,
  readEnabledOptionalHarnessIds,
} from './optional-harness-selection.ts';
import { registerProcessLifecycle } from './builtin-process-lifecycles.ts';

export { OPTIONAL_HARNESSES_ENV, isOptionalHarnessSelectionExplicit, readEnabledOptionalHarnessIds };

const MANIFEST_FILENAME = 'harness-plugin.json';
const DIR_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface OptionalPluginError {
  dir: string;
  code: string;
  error: string;
}

type OptionalPluginRead = {
  plugin?: { manifest: HarnessPluginManifest; dirPath: string; files: Record<string, string> };
  error?: OptionalPluginError;
};

type RegistrationOutcome = { ok: true } | { ok: false; code: string; error: string };

/**
 * @returns Canonical file path, or null when unsafe/missing.
 */
async function resolveContainedFile(dirPath: string, rootPath: string, relative: string): Promise<string | null> {
  try {
    const target = path.join(dirPath, relative);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const real = await realpath(target);
    const realDir = await realpath(dirPath);
    const realRoot = await realpath(rootPath);
    const inside = (base: string, file: string): boolean => file === base || file.startsWith(base + path.sep);
    return inside(realDir, real) && inside(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Read and validate one plugin directory.
 */
async function readOptionalPlugin(rootPath: string, dir: string): Promise<OptionalPluginRead> {
  const fail = (code: string, error: string): OptionalPluginRead => ({ error: { dir, code, error } });
  if (!DIR_PATTERN.test(dir)) return fail('dir_invalid', 'plugin directory name is not a valid harness id');
  const dirPath = path.join(rootPath, dir);
  try {
    const info = await lstat(dirPath);
    if (info.isSymbolicLink() || !info.isDirectory()) return fail('dir_invalid', 'plugin directory must be a real directory');
  } catch {
    return fail('dir_invalid', 'plugin directory is not readable');
  }
  const manifestPath = await resolveContainedFile(dirPath, rootPath, MANIFEST_FILENAME);
  if (!manifestPath) return fail('manifest_missing', `${MANIFEST_FILENAME} is missing or not a regular file`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return fail('manifest_malformed', `${MANIFEST_FILENAME} is not valid JSON`);
  }
  const validated = validateHarnessPluginManifest(raw);
  if (!validated.ok) {
    const failed = validated as { code: string; error: string };
    return fail(failed.code, failed.error);
  }
  const { manifest } = validated;
  if (manifest.origin !== 'builtin-optional') {
    return fail('origin_not_optional', 'a repo plugin directory may only contain builtin-optional plugins');
  }
  if (manifest.id !== dir) return fail('id_mismatch', 'manifest id must equal the directory name');
  const files: Record<string, string> = {};
  for (const [kind, relative] of Object.entries(manifest.entries || {})) {
    const resolved = await resolveContainedFile(dirPath, rootPath, relative as string);
    if (!resolved) return fail('entry_unsafe', `entries.${kind} is missing, a symlink or escapes the plugin directory`);
    files[kind] = resolved;
  }
  return { plugin: { manifest, dirPath, files } };
}

/**
 * Validate a light-entry module and register its backend, MCP adapter, optional
 * title provider (`titleProvider`), optional version row (`versions`) and the
 * optional host hooks `limitBinding`, `billingCredential` and `creditLedger`
 * (optional-harness-hooks.js).
 * Callers run {@link checkCollisions} first, so the registrations below cannot
 * be refused half-way.
 */
function registerLight(id: string, mod: any): RegistrationOutcome {
  const light = mod?.default;
  if (!light || typeof light !== 'object') return { ok: false, code: 'light_invalid', error: 'light entry must default-export an object' };
  // Shape-check everything first; only then write to the registries.
  if (light.backend && (light.backend.id !== id || typeof light.backend.status !== 'function')) {
    return { ok: false, code: 'light_invalid', error: 'light.backend must carry the plugin id and a status() function' };
  }
  if (light.mcpAdapter && light.mcpAdapter.harness !== id) {
    return { ok: false, code: 'light_invalid', error: 'light.mcpAdapter.harness must equal the plugin id' };
  }
  if (light.titleProvider && light.titleProvider.id !== id) {
    return { ok: false, code: 'light_invalid', error: 'light.titleProvider.id must equal the plugin id' };
  }
  if (light.versions && light.versions.spec?.harness !== id) {
    return { ok: false, code: 'light_invalid', error: 'light.versions.spec.harness must equal the plugin id' };
  }
  if (light.limitBinding !== undefined && typeof light.limitBinding !== 'function') {
    return { ok: false, code: 'light_invalid', error: 'light.limitBinding must be a function' };
  }
  if (light.billingCredential && typeof light.billingCredential.credential !== 'function') {
    return { ok: false, code: 'light_invalid', error: 'light.billingCredential.credential must be a function' };
  }
  if (light.backend) {
    const result = registerOptionalHarnessBackend(light.backend);
    if (!result.ok) return result;
  }
  if (light.mcpAdapter) {
    const result = registerOptionalHarnessMcpAdapter(light.mcpAdapter);
    if (!result.ok) return result;
  }
  if (light.titleProvider) {
    const result = registerOptionalTitleProvider(light.titleProvider);
    if (!result.ok) return result;
  }
  if (light.versions) {
    const result = registerOptionalHarnessVersions(light.versions);
    if (!result.ok) return result;
  }
  if (light.limitBinding) registerHarnessLimitBinding(id, light.limitBinding);
  if (light.billingCredential) registerHarnessBillingCredentialSource(id, light.billingCredential);
  if (light.creditLedger) registerCreditLedgerContribution(id, light.creditLedger);
  return { ok: true };
}

/**
 * Side-effect-free pre-check of every registry the plugin will write to, so a
 * collision in the last one cannot leave entries installed in the others.
 */
function checkCollisions(id: string, lightMod: any, hasProvider: boolean): RegistrationOutcome {
  const light = lightMod?.default;
  const taken: string[] = [];
  if (light && typeof light === 'object') {
    if (light.backend && hasHarnessBackend(id)) taken.push('backend');
    if (light.mcpAdapter && hasHarnessMcpAdapter(id)) taken.push('MCP adapter');
    if (light.titleProvider && hasTitleProviderAdapter(id)) taken.push('title provider');
    if (light.versions && hasHarnessVersionsRow(id)) taken.push('version row');
    if ((light.limitBinding || light.billingCredential || light.creditLedger) && hasOptionalHarnessHooks(id)) taken.push('host hooks');
  }
  if (hasProvider && getBuiltinHarnessProvider(id)) taken.push('provider');
  if (hasHarnessMeta(id)) taken.push('metadata');
  if (taken.length === 0) return { ok: true };
  return { ok: false, code: 'id_collision', error: `Harness "${id}" is already registered (${taken.join(', ')})` };
}

/**
 * Validate a heavy-entry module and build (not register) its provider.
 *
 * @param lifecycleMod Optional `lifecycle` entry; its hook becomes `provider.processLifecycle`.
 */
function buildHeavyProvider(
  manifest: HarnessPluginManifest,
  mod: any,
  lifecycleMod?: any,
): { ok: true; provider: BuiltinHarnessProvider } | { ok: false; code: string; error: string } {
  const spec = mod?.default?.provider;
  const required = ['handler', 'registerRoutes', 'checkCreateReady'];
  if (!spec || typeof spec !== 'object' || required.some((key) => typeof spec[key] !== 'function')
    || !spec.room || typeof spec.room !== 'object') {
    return { ok: false, code: 'heavy_invalid', error: 'heavy entry must default-export { provider } with handler, registerRoutes, room and checkCreateReady' };
  }
  const provider = defineBuiltinProvider(manifest.id, {
    fallbackLabel: manifest.label,
    fallbackDescription: manifest.description,
    capabilities: { ...manifest.capabilities },
    handlerLabel: `${manifest.label} agent handler`,
    chatTitlePrefix: manifest.label,
    historyStatusTail: false,
    ...(lifecycleMod?.default?.processLifecycle ? { processLifecycle: lifecycleMod.default.processLifecycle } : {}),
    ...spec,
  }, 'builtin-optional');
  return { ok: true, provider };
}

export interface LoadOptionalHarnessPluginsOptions {
  enabledIds?: readonly string[];
  env?: Record<string, string | undefined>;
  root?: string;
  importer?: (fileUrl: string) => Promise<unknown>;
}

export interface LoadOptionalHarnessPluginsResult {
  loaded: string[];
  errors: OptionalPluginError[];
}

/**
 * Discover repo plugins, then import and register the enabled ones.
 */
export async function loadOptionalHarnessPlugins(options: LoadOptionalHarnessPluginsOptions = {}): Promise<LoadOptionalHarnessPluginsResult> {
  const result = await discoverAndRegister(options);
  // One commit per boot load, whatever path the load took.
  setLoadedOptionalHarnessIds(result.loaded);
  return result;
}

async function discoverAndRegister(options: LoadOptionalHarnessPluginsOptions = {}): Promise<LoadOptionalHarnessPluginsResult> {
  const env = options.env || process.env;
  const explicit = options.enabledIds !== undefined || isOptionalHarnessSelectionExplicit(env);
  const requested = options.enabledIds !== undefined ? [...new Set(options.enabledIds)] : readEnabledOptionalHarnessIds(env);
  const errors: OptionalPluginError[] = [];
  const loaded: string[] = [];
  // An explicit empty selection means "no optional harness", with no disk access at all.
  if (explicit && requested.length === 0) return { loaded, errors };
  const rootPath = options.root || resolveProjectPath('harnesses');
  const importer = options.importer || ((url: string) => import(url));
  // The root must be a real directory: a symlinked `harnesses` would make
  // realpath(root) point at its target and pull outside files past containment.
  try {
    const rootInfo = await lstat(rootPath);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      for (const id of requested) {
        errors.push({ dir: id, code: 'root_invalid', error: 'the harnesses root must be a real directory, not a symlink' });
      }
      return { loaded, errors };
    }
  } catch {
    // Missing root: reported as plugin_not_found below.
  }
  let dirs: string[];
  try {
    dirs = (await readdir(rootPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    for (const id of requested) errors.push({ dir: id, code: 'plugin_not_found', error: 'no harnesses directory' });
    return { loaded, errors };
  }
  const reads = new Map<string, OptionalPluginRead>();
  const readOnce = async (dir: string): Promise<OptionalPluginRead> => {
    if (!reads.has(dir)) reads.set(dir, await readOptionalPlugin(rootPath, dir));
    return reads.get(dir) as OptionalPluginRead;
  };
  let ids: string[];
  if (explicit) {
    ids = requested;
  } else {
    // Unset variable: select the plugins that declare defaultEnabled.
    ids = [];
    for (const dir of [...dirs].sort()) {
      const read = await readOnce(dir);
      if (!read.plugin) {
        errors.push(read.error as OptionalPluginError);
      } else if (read.plugin.manifest.defaultEnabled === true) {
        ids.push(dir);
      }
    }
  }
  // A plugin loads after the plugins it depends on, whatever the selection order.
  for (const id of ids) if (dirs.includes(id)) await readOnce(id);
  ids = orderByDependencies(ids, (id) => {
    const found = reads.get(id)?.plugin?.manifest.dependsOn;
    return found || [];
  });
  for (const id of ids) {
    if (!dirs.includes(id)) {
      errors.push({ dir: id, code: 'plugin_not_found', error: `no plugin directory for "${id}"` });
      continue;
    }
    const read = await readOnce(id);
    if (!read.plugin) {
      if (explicit) errors.push(read.error as OptionalPluginError);
      continue;
    }
    const { manifest, files } = read.plugin;
    const missing = (manifest.dependsOn || []).filter((dep) => !loaded.includes(dep));
    if (missing.length > 0) {
      // Not registered anywhere: the id stays a known-but-disabled plugin, so its chats open read-only.
      errors.push({
        dir: id,
        code: 'dependency_missing',
        error: `Harness "${id}" needs the ${missing.map((dep) => `"${dep}"`).join(', ')} plugin to be enabled first (CRETLI_OPTIONAL_HARNESSES=${[...missing, id].join(',')})`,
      });
      continue;
    }
    try {
      // Import and shape-check both entries before registering either, so a
      // broken heavy entry cannot leave a half-registered plugin behind.
      const lightMod = files.light ? await importer(pathToFileURL(files.light).href) : null;
      const heavyMod = files.heavy ? await importer(pathToFileURL(files.heavy).href) : null;
      const lifecycleMod = files.lifecycle ? await importer(pathToFileURL(files.lifecycle).href) : null;
      const heavy = heavyMod ? buildHeavyProvider(manifest, heavyMod, lifecycleMod) : null;
      if (heavy && !heavy.ok) {
        const failed = heavy as { error: string; code: string };
        throw Object.assign(new Error(failed.error), { code: failed.code });
      }
      const collision = checkCollisions(id, lightMod, Boolean(heavy));
      if (!collision.ok) {
        const failed = collision as { error: string; code: string };
        throw Object.assign(new Error(failed.error), { code: failed.code });
      }
      if (lightMod) {
        const result = registerLight(id, lightMod);
        if (!result.ok) {
          const failed = result as { error: string; code: string };
          throw Object.assign(new Error(failed.error), { code: failed.code });
        }
      }
      if (heavy && heavy.ok) {
        const result = registerOptionalHarnessProvider(heavy.provider);
        if (!result.ok) {
          const failed = result as { error: string; code: string };
          throw Object.assign(new Error(failed.error), { code: failed.code });
        }
      }
      if (lifecycleMod?.default?.processLifecycle) registerProcessLifecycle(lifecycleMod.default.processLifecycle);
      registerOptionalHarnessMeta({ transport: id as AgentTransport, label: manifest.label, description: manifest.description });
      loaded.push(id);
    } catch (err) {
      errors.push({ dir: id, code: (err as any)?.code || 'import_failed', error: String((err as any)?.message || err) });
    }
  }
  return { loaded, errors };
}
