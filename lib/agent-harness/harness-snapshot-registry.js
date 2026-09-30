/**
 * Read-only harness provider snapshot: built-in transports plus discovered
 * local plugins.
 *
 * This is the read-only half of TODO a14c7b94. It only *reads* an
 * admin-configured plugin root and turns valid local manifests into safe catalog
 * rows. The catalog path never imports plugin code or resolves `hostMin`; the
 * runtime (`local-harness-runtime.js`) owns discovery memoization and lazy
 * loading, and this module delegates the cache to it so a request/event never
 * triggers a directory scan.
 *
 * Safety contract:
 *  - The plugin root comes exclusively from the server-controlled
 *    `CRETLI_HARNESS_PLUGIN_ROOT` environment variable. No request, saved chat,
 *    or other client value can select it.
 *  - When the variable is unset/empty the local section is empty, so
 *    `listHarnessCatalog()` returns exactly the built-in rows it does today.
 *  - Discovery is memoized per root by {@link getLocalHarnessPluginCatalog}, so
 *    an HTTP request or WS event never triggers a directory scan.
 *    `invalidateHarnessDiscoveryCache()` forces a fresh scan on the next call
 *    without touching loaded modules or live session pins;
 *    `invalidateHarnessModuleCache()` drops loaded plugin modules only; and
 *    `invalidateHarnessSnapshotCache()` does both (admin reload / test
 *    isolation). None of them drop a live session pin.
 *  - Discovery failures are swallowed: a broken plugin root or malformed
 *    plugin can never remove, mask, or outrank the built-in rows.
 *  - Local rows expose only `buildHarnessProviderMetadata()` output, i.e. no
 *    `entry`, no absolute root, and no filesystem error text. A row always
 *    reports `available: false` and `state: 'not_loaded'` because the catalog is
 *    read-only: loading happens only on an explicit create/WebSocket request
 *    through `loadLocalChatHarness` / `dispatchLocalHarnessWebSocket`.
 *  - `enabled` for a local row is explicit only. It derives exclusively from
 *    `settings.enabledLocalHarnesses` through
 *    {@link normalizeEnabledLocalHarnesses}; the built-in `enabledHarnesses`
 *    list and its "missing/empty/full list" invariant never turn a local
 *    plugin on, and a missing local list always means "off".
 */

import {
  HARNESS_BUILTIN_IDS,
  buildHarnessProviderMetadata,
} from './harness-plugin-contract.js';
import {
  HARNESS_PLUGIN_ROOT_ENV,
  getLocalHarnessPluginCatalog,
  invalidateLocalHarnessDiscoveryCache,
  invalidateLocalHarnessModuleCache,
  readHarnessPluginRoot,
} from './local-harness-runtime.js';
import { normalizeEnabledLocalHarnesses } from './enabled-local-harnesses.js';

export { HARNESS_PLUGIN_ROOT_ENV, readHarnessPluginRoot };

/** State reported for a discovered local provider that is not loaded yet. */
export const LOCAL_PROVIDER_STATE = 'not_loaded';

/**
 * Drop only the memoized discovery snapshot so the next snapshot re-scans the
 * plugin root. Loaded modules and live session pins are untouched. Exposed for
 * the explicit settings PATCH before membership validation.
 *
 * @returns {void}
 */
export function invalidateHarnessDiscoveryCache() {
  invalidateLocalHarnessDiscoveryCache();
}

/**
 * Drop only the loaded plugin/module cache so the next load re-imports. Live
 * session pins keep their exact module. Exposed for the explicit settings PATCH
 * after a successful update.
 *
 * @returns {void}
 */
export function invalidateHarnessModuleCache() {
  invalidateLocalHarnessModuleCache();
}

/**
 * Drop the memoized discovery and the loaded module cache so the next snapshot
 * performs a fresh scan and the next load re-imports. Live session pins are
 * deliberately preserved. Exposed for an explicit admin reload and for test
 * isolation; a full reset (including pins) stays in the runtime module.
 *
 * @returns {void}
 */
export function invalidateHarnessSnapshotCache() {
  invalidateHarnessDiscoveryCache();
  invalidateHarnessModuleCache();
}

/**
 * Discover plugins once per root. The runtime owns the memoization and never
 * throws, but the catch keeps a future regression from breaking the built-in
 * catalog.
 *
 * @param {NodeJS.ProcessEnv | Record<string, unknown> | undefined} env
 * @returns {Promise<object | null>}
 */
function discoverOnce(env) {
  return getLocalHarnessPluginCatalog({ env }).catch(() => null);
}

/**
 * Convert one validated local manifest into a client-safe catalog row. Returns
 * `null` for anything that is not a usable local manifest so malformed disk
 * state is dropped instead of reflected to a client.
 *
 * @param {{ manifest?: unknown } | null | undefined} plugin
 * @param {ReadonlySet<string>} enabledLocalIds
 * @returns {object | null}
 */
function toLocalProviderRow(plugin, enabledLocalIds) {
  if (!plugin || typeof plugin !== 'object') return null;
  const built = buildHarnessProviderMetadata(plugin.manifest);
  if (!built.ok) return null;
  const metadata = built.metadata;
  if (metadata.origin !== 'local') return null;
  // Built-ins stay authoritative; a local row must never shadow one.
  if (HARNESS_BUILTIN_IDS.includes(metadata.id)) return null;
  return {
    id: metadata.id,
    label: metadata.label,
    description: metadata.description,
    origin: metadata.origin,
    version: metadata.version,
    hostMin: metadata.hostMin,
    apiVersion: metadata.apiVersion,
    capabilities: metadata.capabilities,
    ...(metadata.models !== undefined ? { models: metadata.models } : {}),
    enabled: enabledLocalIds.has(metadata.id),
    ready: false,
    available: false,
    can_delegate: false,
    state: LOCAL_PROVIDER_STATE,
    usage_limit: null,
  };
}

/**
 * Safe local-provider rows for the configured root. Returns `[]` when no root
 * is configured, when discovery fails, or when no plugin validates.
 *
 * @param {{
 *   settings?: { enabledLocalHarnesses?: readonly string[] | null } | null,
 *   env?: NodeJS.ProcessEnv | Record<string, unknown>,
 * }} [options]
 * @returns {Promise<object[]>}
 */
export async function listLocalHarnessProviders(options = {}) {
  const root = readHarnessPluginRoot(options.env);
  if (!root) return [];
  try {
    const catalog = await discoverOnce(options.env);
    if (!catalog || !Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
      return [];
    }
    const enabledLocalIds = new Set(normalizeEnabledLocalHarnesses(
      options.settings ? options.settings.enabledLocalHarnesses : null,
    ));
    const rows = [];
    for (const plugin of catalog.plugins) {
      const row = toLocalProviderRow(plugin, enabledLocalIds);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    // Discovery/mapping problems must never remove the built-in catalog.
    return [];
  }
}
