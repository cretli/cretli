/**
 * Local harness plugin discovery + controlled lazy loading.
 *
 * This module is a separable building block: it is NOT wired into transports,
 * the harness registry, HTTP routes, settings, or the UI. It performs no
 * network access, no remote install, no npm/URL execution, and no filesystem
 * reads or writes per HTTP/WS event. Callers run discovery at startup (or on an
 * explicit admin action) and import a plugin only through the controlled
 * `loadHarnessPlugins` function.
 *
 * Safety contract:
 *  - The root is one explicit, admin-supplied absolute directory passed by the
 *    host. It is never derived from an HTTP request, a WS message, a saved
 *    chat, or any other client-controlled value.
 *  - Discovery reads only `<root>/<plugin-dir>/harness-plugin.json` and the
 *    relative entry declared there. Manifests are validated with the shared
 *    {@link validateHarnessPluginManifest} contract and de-duplicated with
 *    {@link validateHarnessPluginSet}.
 *  - The root, each plugin directory, and each entry file must be real
 *    (non-symlink) filesystem objects. Every resolved entry is canonicalized
 *    with `realpath` and must stay inside both the plugin directory and the
 *    root, so intermediate symlinks and `..` traversal cannot escape.
 *  - Malformed, missing, unreadable, invalid, colliding, or escaping plugins
 *    become per-plugin entries in the result. Discovery never throws and never
 *    aborts host startup.
 *  - Locals are opt-in: `loadHarnessPlugins` imports only the ids explicitly
 *    listed in `enabledIds`. An omitted or empty list imports nothing; there is
 *    no auto-enable path.
 *  - A catalog is never trusted as an authority — not on paths and not on
 *    manifest content. `loadHarnessPlugins` canonicalizes `catalog.root` again
 *    through {@link resolveHarnessPluginRoot}, derives each plugin directory
 *    from the validated `plugin.dir` name (a safe direct child of the root,
 *    re-checked with `lstat`/`realpath`), rejects a caller-supplied `dirPath`
 *    that disagrees with `dir`, and ignores `plugin.entryPath`. The catalog
 *    manifest is used only as an id index hint: for every enabled id the real
 *    `harness-plugin.json` is re-read from the derived directory, validated
 *    with {@link validateHarnessPluginManifest}, and its `id` must equal the
 *    requested enabled id with a local origin. Only the disk manifest's
 *    `entry` and `hostMin` are used, so a forged catalog cannot make one
 *    plugin id import another plugin's entry or smuggle weaker metadata.
 *  - Catalog entries whose claimed id appears more than once are ambiguous and
 *    are refused (`id_collision`) instead of resolved last-wins, matching the
 *    duplicate semantics of {@link validateHarnessPluginSet}.
 *  - `hostMin` is compared against the running host version with the installed
 *    `semver` package when it can be resolved. When it cannot, the comparison is
 *    deferred (reason documented) and loading proceeds; an unknown host range
 *    is never guessed with a partial comparator.
 *  - Discovered manifests are host-internal (they contain the relative `entry`
 *    path). Use {@link buildHarnessProviderMetadata} from the contract before
 *    exposing anything to a client; the loader itself never emits client
 *    metadata and never reads secrets or environment configuration.
 */

import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  validateHarnessPluginManifest,
  validateHarnessPluginSet,
} from './harness-plugin-contract.js';

/** Manifest filename expected inside every discovered plugin directory. */
export const HARNESS_PLUGIN_MANIFEST_FILENAME = 'harness-plugin.json';

/**
 * Cached optional `semver` module (or `null` when it is not installed). The
 * package is only an opportunistic dependency: it is present transitively in
 * this repo today, but the loader must keep working without it.
 *
 * @type {Promise<object | null> | null}
 */
let semverModulePromise = null;

/**
 * @returns {Promise<object | null>}
 */
function getSemverModule() {
  if (!semverModulePromise) {
    semverModulePromise = import('semver')
      .then((mod) => (mod && (mod.default || mod)) || null)
      .catch(() => null);
  }
  return semverModulePromise;
}

/**
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
function isContained(base, target) {
  if (!base || !target) return false;
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Allowed plugin directory names: a single safe path segment. Must start with an
 * alphanumeric, may then contain letters, digits, dot, underscore, and hyphen,
 * and is capped at 64 characters. This rules out `.`/`..`, dot-prefixed hidden
 * directories, absolute paths, separators, and backslashes by construction.
 */
export const HARNESS_PLUGIN_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Decide whether a catalog-supplied `dir` may be joined onto the canonical root.
 * Kept deliberately strict: this is the only name the loader derives paths from,
 * so it must never be able to escape its parent through traversal or a separator.
 *
 * @param {unknown} raw
 * @returns {string | null} an explanation, or `null` when the name is safe
 */
function unsafePluginDirReason(raw) {
  if (typeof raw !== 'string') return 'plugin dir must be a string';
  const dir = raw.trim();
  if (!dir) return 'plugin dir is required';
  if (dir.includes('\0')) return 'plugin dir must not contain a NUL byte';
  if (path.basename(dir) !== dir) return 'plugin dir must be a direct child name, not a path';
  if (!HARNESS_PLUGIN_DIR_PATTERN.test(dir)) {
    return 'plugin dir must be a safe directory name (start alphanumeric, then letters, digits, dot, underscore, hyphen)';
  }
  return null;
}

/**
 * Locate one plugin directory under a canonical root without trusting the
 * caller's path. The name must be a safe direct child, the target must be a
 * real non-symlink directory, and its canonical path must stay inside the root.
 *
 * `skip: true` marks an entry that is simply not a directory; discovery ignores
 * those while loading must reject them, so both outcomes carry a code.
 *
 * @param {string} rootPath canonical plugin root
 * @param {unknown} rawDirName catalog `dir` value (untrusted)
 * @returns {Promise<
 *   | { ok: true, dir: string, dirPath: string }
 *   | { ok: false, skip: true, code: string, error: string }
 *   | { ok: false, code: string, error: string }
 * >}
 */
async function resolvePluginDirectory(rootPath, rawDirName) {
  const reason = unsafePluginDirReason(rawDirName);
  if (reason) {
    return { ok: false, code: 'dir_unsafe', error: reason };
  }
  const dir = /** @type {string} */ (rawDirName).trim();
  const candidate = path.resolve(rootPath, dir);
  if (!isContained(rootPath, candidate)) {
    return { ok: false, code: 'dir_unsafe', error: `plugin directory escapes the root: ${dir}` };
  }

  let stat;
  try {
    stat = await lstat(candidate);
  } catch {
    return { ok: false, code: 'plugin_unreadable', error: 'plugin directory is not readable' };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, code: 'plugin_symlink', error: 'plugin directory must not be a symbolic link' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, skip: true, code: 'plugin_not_directory', error: 'plugin entry is not a directory' };
  }

  let dirPath;
  try {
    dirPath = await realpath(candidate);
  } catch {
    return { ok: false, code: 'plugin_unreadable', error: 'plugin directory is not readable' };
  }
  if (!isContained(rootPath, dirPath)) {
    return { ok: false, code: 'plugin_escape', error: 'plugin directory resolves outside the root' };
  }
  return { ok: true, dir, dirPath };
}

/**
 * @param {string} dir
 * @param {string} file
 * @param {string} code
 * @param {string} error
 * @param {string} [field]
 * @returns {{ dir: string, file: string, code: string, error: string, field?: string }}
 */
function pluginError(dir, file, code, error, field = '') {
  return { dir, file, code, error, ...(field ? { field } : {}) };
}

/**
 * Resolve the admin-supplied root into a canonical, non-symlink directory.
 * This is the only entry point that touches the filesystem for the root; it
 * deliberately rejects relative paths, URLs, and symlinked roots.
 *
 * @param {unknown} rawRoot
 * @returns {Promise<{ ok: true, root: string } | { ok: false, code: string, error: string }>}
 */
export async function resolveHarnessPluginRoot(rawRoot) {
  if (typeof rawRoot !== 'string') {
    return { ok: false, code: 'root_invalid', error: 'plugin root must be a filesystem path string' };
  }
  const root = rawRoot.trim();
  if (!root) {
    return { ok: false, code: 'root_invalid', error: 'plugin root is required' };
  }
  if (root.includes('\0')) {
    return { ok: false, code: 'root_invalid', error: 'plugin root must not contain a NUL byte' };
  }
  if (root.includes('://')) {
    return { ok: false, code: 'root_invalid', error: 'plugin root must be a filesystem path, not a URL' };
  }
  if (!path.isAbsolute(root)) {
    return { ok: false, code: 'root_invalid', error: 'plugin root must be an absolute path' };
  }

  let stat;
  try {
    stat = await lstat(root);
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      ok: false,
      code: missing ? 'root_missing' : 'root_unreadable',
      error: missing ? `plugin root does not exist: ${root}` : `plugin root is not readable: ${root}`,
    };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, code: 'root_symlink', error: 'plugin root must not be a symbolic link' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'root_invalid', error: 'plugin root must be a directory' };
  }

  let canonical;
  try {
    canonical = await realpath(root);
  } catch {
    return { ok: false, code: 'root_unreadable', error: `plugin root is not readable: ${root}` };
  }
  return { ok: true, root: canonical };
}

/**
 * Resolve and containment-check one entry file. The entry string is already
 * constrained by the manifest contract (relative, no `..`, no backslash), so
 * this adds the filesystem guarantees: a real file, not a symlink, whose
 * canonical path stays inside the plugin directory and the root.
 *
 * @param {string} dirPath canonical plugin directory
 * @param {string} entry relative entry path from the manifest
 * @param {string} rootPath canonical plugin root
 * @returns {Promise<{ ok: true, entryPath: string } | { ok: false, code: string, error: string }>}
 */
async function resolveEntryFile(dirPath, entry, rootPath) {
  const candidate = path.resolve(dirPath, entry);
  if (!isContained(dirPath, candidate) || !isContained(rootPath, candidate)) {
    return { ok: false, code: 'entry_unsafe', error: `entry escapes the plugin root: ${entry}` };
  }

  let stat;
  try {
    stat = await lstat(candidate);
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      ok: false,
      code: missing ? 'entry_missing' : 'entry_unreadable',
      error: missing ? `entry file is missing: ${entry}` : `entry file is not readable: ${entry}`,
    };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, code: 'entry_symlink', error: `entry file must not be a symbolic link: ${entry}` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'entry_not_file', error: `entry must be a regular file: ${entry}` };
  }

  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    return { ok: false, code: 'entry_unreadable', error: `entry file is not readable: ${entry}` };
  }
  if (!isContained(dirPath, canonical) || !isContained(rootPath, canonical)) {
    return { ok: false, code: 'entry_escape', error: `entry resolves outside the plugin root: ${entry}` };
  }
  return { ok: true, entryPath: canonical };
}

/**
 * Read, parse, validate, and containment-check a single plugin directory.
 *
 * @param {string} rootPath canonical plugin root
 * @param {string} dirName directory name (plugin folder)
 * @param {readonly string[] | undefined} reservedIds
 * @returns {Promise<
 *   | { plugin: { manifest: object, dir: string, dirPath: string, entryPath: string } }
 *   | { skipped: true, code: string, error: string }
 *   | { error: { dir: string, file: string, code: string, error: string, field?: string } }
 * >}
 */
async function readPluginDirectory(rootPath, dirName, reservedIds) {
  const located = await resolvePluginDirectory(rootPath, dirName);
  if (!located.ok) {
    if (located.skip) return { skipped: true, code: located.code, error: located.error };
    return { error: pluginError(dirName, '', located.code, located.error) };
  }
  const { dir, dirPath } = located;

  const manifestPath = path.join(dirPath, HARNESS_PLUGIN_MANIFEST_FILENAME);
  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        missing ? 'manifest_missing' : 'manifest_unreadable',
        missing ? `${HARNESS_PLUGIN_MANIFEST_FILENAME} is missing` : `${HARNESS_PLUGIN_MANIFEST_FILENAME} is not readable`,
      ),
    };
  }
  if (manifestStat.isSymbolicLink()) {
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        'manifest_symlink',
        `${HARNESS_PLUGIN_MANIFEST_FILENAME} must not be a symbolic link`,
      ),
    };
  }
  if (!manifestStat.isFile()) {
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        'manifest_missing',
        `${HARNESS_PLUGIN_MANIFEST_FILENAME} is not a regular file`,
      ),
    };
  }

  let text;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch {
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        'manifest_unreadable',
        `${HARNESS_PLUGIN_MANIFEST_FILENAME} is not readable`,
      ),
    };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        'manifest_malformed',
        `${HARNESS_PLUGIN_MANIFEST_FILENAME} is not valid JSON`,
      ),
    };
  }

  const validated = validateHarnessPluginManifest(raw, { reservedIds });
  if (!validated.ok) {
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        validated.code,
        validated.error,
        validated.field,
      ),
    };
  }
  const { manifest } = validated;
  if (manifest.origin !== 'local') {
    return {
      error: pluginError(
        dirName,
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        'origin_not_local',
        'a local discovery root may only contain local-origin plugins',
        'origin',
      ),
    };
  }

  const entry = await resolveEntryFile(dirPath, manifest.entry, rootPath);
  if (!entry.ok) {
    return { error: pluginError(dirName, manifest.entry, entry.code, entry.error, 'entry') };
  }

  return {
    plugin: {
      manifest,
      dir,
      dirPath,
      entryPath: entry.entryPath,
    },
  };
}

/**
 * Discover and validate local plugins under one explicit admin-supplied root.
 *
 * Never throws. Root problems return `{ ok: false, plugins: [] }` with a
 * `root_*` error. Per-plugin problems (missing/malformed/invalid manifest,
 * symlinks, missing/escaping entry, id collision, non-local origin) are
 * collected in `errors` while valid sibling plugins are still returned.
 *
 * @param {{
 *   root?: unknown,
 *   reservedIds?: readonly string[],
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   root: string,
 *   plugins: Array<{ manifest: object, dir: string, dirPath: string, entryPath: string }>,
 *   errors: Array<{ dir: string, file: string, code: string, error: string, field?: string }>,
 *   duplicateIds: string[],
 * }>}
 */
export async function discoverHarnessPlugins(options = {}) {
  const rootResult = await resolveHarnessPluginRoot(options.root);
  if (!rootResult.ok) {
    return {
      ok: false,
      root: '',
      plugins: [],
      errors: [pluginError('', '', rootResult.code, rootResult.error)],
      duplicateIds: [],
    };
  }
  const root = rootResult.root;

  let names;
  try {
    names = await readdir(root);
  } catch {
    return {
      ok: false,
      root,
      plugins: [],
      errors: [pluginError('', '', 'root_unreadable', 'plugin root is not readable')],
      duplicateIds: [],
    };
  }

  const ordered = names
    .filter((name) => typeof name === 'string' && name && !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  /** @type {Array<{ manifest: object, dir: string, dirPath: string, entryPath: string }>} */
  const plugins = [];
  /** @type {Array<{ dir: string, file: string, code: string, error: string, field?: string }>} */
  const errors = [];

  for (const name of ordered) {
    const outcome = await readPluginDirectory(root, name, options.reservedIds);
    // Plain files / non-directories are simply not plugins; discovery skips
    // them even though the outcome carries the rejection code for loading.
    if (outcome.skipped) continue;
    if (outcome.plugin) {
      plugins.push(outcome.plugin);
    } else if (outcome.error) {
      errors.push(outcome.error);
    }
  }

  // De-duplicate through the shared contract validator so collision semantics
  // stay identical to the rest of the plugin system. Only collisions can fire
  // here because every manifest already passed validateHarnessPluginManifest.
  const setResult = validateHarnessPluginSet(
    plugins.map((plugin) => plugin.manifest),
    { reservedIds: options.reservedIds },
  );
  const collided = new Set();
  for (const error of setResult.errors) {
    collided.add(error.index);
    const owner = plugins[error.index];
    errors.push(
      pluginError(
        owner ? owner.dir : '',
        HARNESS_PLUGIN_MANIFEST_FILENAME,
        error.code,
        error.error,
        error.field,
      ),
    );
  }

  return {
    ok: errors.length === 0,
    root,
    plugins: plugins.filter((_, index) => !collided.has(index)),
    errors,
    duplicateIds: setResult.duplicateIds,
  };
}

/**
 * Evaluate a manifest `hostMin` against the running host version.
 *
 * Uses the installed `semver` package when it can be resolved (or an injected
 * module from `options.semver`). When no usable comparator is available the
 * result is explicitly deferred (`evaluated: false`, `deferred: true`) rather
 * than guessed, so the caller can choose to load anyway. This function never
 * throws.
 *
 * @param {unknown} hostMin
 * @param {unknown} hostVersion
 * @param {{ semver?: object | null }} [options] pass `{ semver: null }` to force deferral
 * @returns {Promise<{
 *   evaluated: boolean,
 *   compatible: boolean | null,
 *   deferred: boolean,
 *   reason: string,
 * }>}
 */
export async function evaluateHostMinCompatibility(hostMin, hostVersion, options = {}) {
  const injected = Object.prototype.hasOwnProperty.call(options, 'semver');
  const semver = injected ? options.semver : await getSemverModule();

  if (!semver || typeof semver.valid !== 'function' || typeof semver.gte !== 'function') {
    return {
      evaluated: false,
      compatible: null,
      deferred: true,
      reason: 'semver_unavailable',
    };
  }

  const current = semver.valid(String(hostVersion ?? '').trim());
  const required = semver.valid(String(hostMin ?? '').trim());
  if (!current || !required) {
    return {
      evaluated: false,
      compatible: null,
      deferred: true,
      reason: 'version_unparseable',
    };
  }

  const compatible = semver.gte(current, required);
  return {
    evaluated: true,
    compatible,
    deferred: false,
    reason: compatible ? 'compatible' : 'host_too_old',
  };
}

/**
 * @param {unknown} raw
 * @returns {string[]} trimmed, de-duplicated ids in first-seen order
 */
function normalizePluginIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Default ESM importer. Kept in one place so tests can inject a fake importer
 * and so the loader never gains a hidden static dependency on plugin code.
 *
 * @param {string} specifier
 * @returns {Promise<unknown>}
 */
function defaultImporter(specifier) {
  return import(specifier);
}

/**
 * Lazily import only the explicitly enabled local plugin ids from a catalog
 * produced by {@link discoverHarnessPlugins}.
 *
 * The function is inert for disabled plugins: they are never imported, never
 * touched on disk again, and produce no result row. An omitted or empty
 * `enabledIds` imports nothing (no auto-enable). Every failure becomes a
 * per-plugin result row instead of a thrown error.
 *
 * The catalog is treated as untrusted input: `catalog.root` is canonicalized
 * again through {@link resolveHarnessPluginRoot}, each plugin directory is
 * derived from `plugin.dir` alone (validated as a safe direct child name and
 * re-checked with `lstat`/`realpath` under the canonical root), a
 * `plugin.dirPath` that disagrees with `plugin.dir` is rejected, and
 * `plugin.entryPath` is ignored. The catalog `manifest` is only an id index
 * hint — never a source of truth. For every enabled id the loader re-reads
 * the real `harness-plugin.json` from the derived directory, validates it
 * with {@link validateHarnessPluginManifest}, requires its `id` to equal the
 * requested enabled id with a local origin, and then uses the disk manifest's
 * `entry` and `hostMin`. A catalog that lists two entries under the same id is
 * ambiguous and those ids are refused (`id_collision`) instead of resolved by
 * position, matching {@link validateHarnessPluginSet} duplicate semantics.
 *
 * @param {{
 *   root?: string,
 *   plugins?: Array<{ manifest: { id?: unknown }, dir: string, dirPath?: string, entryPath?: string }>,
 * }} catalog
 * @param {{
 *   enabledIds?: readonly string[],
 *   importer?: (specifier: string) => Promise<unknown>,
 *   hostVersion?: unknown,
 *   semver?: object | null,
 *   reservedIds?: readonly string[],
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   loadedIds: string[],
 *   modules: Record<string, unknown>,
 *   results: Array<{
 *     id: string,
 *     dir: string,
 *     ok: boolean,
 *     code?: string,
 *     error?: string,
 *     field?: string,
 *     module?: unknown,
 *     source?: string,
 *     hostMinDeferred?: boolean,
 *     hostMinReason?: string,
 *   }>,
 * }>}
 */
export async function loadHarnessPlugins(catalog, options = {}) {
  /** @type {Array<{ id: string, dir: string, ok: boolean, code?: string, error?: string, field?: string, module?: unknown, source?: string, hostMinDeferred?: boolean, hostMinReason?: string }>} */
  const results = [];
  const modules = {};
  const loadedIds = [];

  /**
   * @param {{ id: string, dir: string, code: string, error: string, field?: string }} row
   */
  const pushError = (row) => {
    results.push({ ok: false, ...row });
  };

  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.plugins) || typeof catalog.root !== 'string' || !catalog.root) {
    pushError({
      id: '',
      dir: '',
      code: 'catalog_invalid',
      error: 'loadHarnessPlugins requires a catalog returned by discoverHarnessPlugins',
    });
    return { ok: false, loadedIds, modules, results };
  }

  const rootResult = await resolveHarnessPluginRoot(catalog.root);
  if (!rootResult.ok) {
    pushError({
      id: '',
      dir: '',
      code: rootResult.code,
      error: rootResult.error,
      field: 'root',
    });
    return { ok: false, loadedIds, modules, results };
  }
  const rootPath = rootResult.root;

  const enabledIds = normalizePluginIds(options.enabledIds);
  const importer = typeof options.importer === 'function' ? options.importer : defaultImporter;
  const hasSemverOption = Object.prototype.hasOwnProperty.call(options, 'semver');
  const hostVersion = options.hostVersion;

  // Index catalog entries by their claimed id. The claimed id is only a lookup
  // hint: it is confirmed against the disk manifest below. An id claimed by
  // more than one entry is ambiguous and is refused instead of resolved
  // last-wins, matching the duplicate semantics of validateHarnessPluginSet.
  const byId = new Map();
  const ambiguousIds = new Set();
  for (const plugin of catalog.plugins) {
    if (!plugin || !plugin.manifest || typeof plugin.manifest.id !== 'string') continue;
    const id = plugin.manifest.id.trim();
    if (!id) continue;
    if (byId.has(id)) {
      ambiguousIds.add(id);
    } else {
      byId.set(id, plugin);
    }
  }

  for (const id of enabledIds) {
    if (ambiguousIds.has(id)) {
      pushError({
        id,
        dir: '',
        code: 'id_collision',
        error: `Catalog contains duplicate entries for harness plugin id "${id}"`,
        field: 'id',
      });
      continue;
    }

    const plugin = byId.get(id);
    if (!plugin) {
      pushError({ id, dir: '', code: 'plugin_not_found', error: `No local harness plugin "${id}"` });
      continue;
    }

    const located = await resolvePluginDirectory(rootPath, plugin.dir);
    if (!located.ok) {
      pushError({
        id,
        dir: typeof plugin.dir === 'string' ? plugin.dir.trim() : '',
        code: located.code,
        error: located.error,
        field: 'dir',
      });
      continue;
    }
    const dir = located.dir;

    // `dirPath` is only a consistency assertion made by the caller; the derived
    // path is what gets used. A disagreement means the catalog was edited (or a
    // stale root was moved) and is refused instead of silently re-pointed.
    if (typeof plugin.dirPath === 'string' && plugin.dirPath.trim()) {
      const claimed = path.resolve(plugin.dirPath);
      if (claimed !== located.dirPath && claimed !== path.resolve(rootPath, dir)) {
        pushError({
          id,
          dir,
          code: 'dir_mismatch',
          error: `catalog dirPath does not match plugin directory "${dir}"`,
          field: 'dirPath',
        });
        continue;
      }
    }

    // The catalog manifest is never trusted: re-read the real manifest from the
    // derived directory (lstat regular non-symlink, read, JSON parse), validate
    // it through the shared contract, and require a local origin. Everything
    // security-relevant below comes from this disk manifest.
    const disk = await readPluginDirectory(rootPath, dir, options.reservedIds);
    if (disk.skipped) {
      pushError({
        id,
        dir,
        code: disk.code || 'plugin_not_directory',
        error: disk.error || 'plugin entry is not a directory',
        field: 'dir',
      });
      continue;
    }
    if (disk.error) {
      pushError({
        id,
        dir,
        code: disk.error.code,
        error: disk.error.error,
        field: disk.error.field,
      });
      continue;
    }
    const diskManifest = disk.plugin.manifest;
    if (diskManifest.id !== id) {
      pushError({
        id,
        dir,
        code: 'id_mismatch',
        error: `plugin directory "${dir}" contains harness plugin "${diskManifest.id}", not "${id}"`,
        field: 'id',
      });
      continue;
    }

    const compatibility = await evaluateHostMinCompatibility(
      diskManifest.hostMin,
      hostVersion,
      hasSemverOption ? { semver: options.semver } : {},
    );
    if (compatibility.evaluated && compatibility.compatible === false) {
      pushError({
        id,
        dir,
        code: 'host_incompatible',
        error: `plugin requires host >= ${diskManifest.hostMin}`,
        field: 'hostMin',
      });
      continue;
    }

    // entryPath comes from the disk manifest (resolved and containment-checked
    // by readPluginDirectory); the catalog entryPath is ignored entirely.
    const source = pathToFileURL(disk.plugin.entryPath).href;
    try {
      const module = await importer(source);
      modules[id] = module;
      loadedIds.push(id);
      results.push({
        id,
        dir,
        ok: true,
        module,
        source,
        hostMinDeferred: compatibility.deferred === true,
        hostMinReason: compatibility.reason,
      });
    } catch (err) {
      pushError({
        id,
        dir,
        code: 'load_failed',
        error: err && err.message ? String(err.message) : 'plugin import failed',
      });
    }
  }

  return { ok: results.every((row) => row.ok), loadedIds, modules, results };
}
