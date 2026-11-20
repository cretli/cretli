/**
 * Cached/fallback harness and model catalogs for MCP and HTTP.
 * Does not start harness processes or call vendor networks.
 */

import {
  catalogEntriesFromModelIds,
  decodeModelValue,
  mergeModelCatalogEntries,
  normalizeChatEnabledModels,
} from './model-catalog.js';
import {
  describeEmptyDelegationFavorites,
  isDelegationModelAvailable,
  readDelegationEmptyFavoritesPolicy,
  resolveDelegationModel,
} from './delegation-executor.js';
import { hasChatRunAdapter } from './chat-run-service.js';
import { describeReviewCertification } from './delegation-adapter-capabilities.js';
import { isHarnessEnabled } from './harness-enabled.js';
import { getDisabledOptionalHarness } from './agent-harness/disabled-optional-harness.ts';
import { getHarnessStatus } from './harness-status.js';
import { parseKnownAgentTransport } from './agent-transport.js';
import { getBuiltinHarnessBackend } from './agent-harness/builtin-harness-backends.ts';
import { listHarnesses } from './agent-harness/registry.ts';
import { listLocalHarnessProviders } from './agent-harness/harness-snapshot-registry.ts';
import {
  estimateModelCostTier,
  estimateModelQualityTier,
  estimateModelSpeedTier,
} from './model-catalog-meta.js';
import { listRolesForModel, loadModelRoleProfiles } from './model-role-profiles.js';
import { loadSettings } from './persist/settings.js';
import { resolveDelegationEnv } from './delegation-settings.js';
import { getHarnessUsageLimit } from './harness-usage-limits.js';
import { readHarnessModelsSnapshotEntry } from './harness-models-snapshot.js';

function enabledIds(settings, harness, role = '') {
  const backend = getBuiltinHarnessBackend(harness);
  const scoped = settings.delegationRoleFavorites?.[harness];
  const raw = role && scoped && Object.prototype.hasOwnProperty.call(scoped, role)
    ? scoped[role]
    : (backend ? settings[backend.enabledModelsKey] : []);
  const ids = normalizeChatEnabledModels(raw);
  return backend?.normalizeEnabledModels ? backend.normalizeEnabledModels(ids) : ids;
}

function catalogIds(settings, harness) {
  const scoped = settings.delegationRoleFavorites?.[harness];
  const roleIds = scoped && typeof scoped === 'object'
    ? Object.values(scoped).flatMap((value) => normalizeChatEnabledModels(value))
    : [];
  return normalizeChatEnabledModels([...enabledIds(settings, harness), ...roleIds]);
}

export function hasRoleFavoriteOverride(settings, harness, role) {
  const scoped = settings.delegationRoleFavorites?.[harness];
  return Boolean(role && scoped && Object.prototype.hasOwnProperty.call(scoped, role));
}

/**
 * Raw Settings favorites of one harness (normalized like the catalog does),
 * without the catalog merge. Empty when none are configured.
 *
 * @param {unknown} harness
 * @returns {string[]}
 */
export function readHarnessEnabledModelIds(harness, role = '') {
  const id = parseKnownAgentTransport(harness);
  if (!id) return [];
  return enabledIds(loadSettings(), id, role);
}

/**
 * A catalog row is enabled when a Settings favorite equals it or is a variant
 * of the same canonical model (same rule the start validation applies).
 *
 * @param {string} harness
 * @param {string[]} enabled
 * @param {string} id
 * @param {Record<string, any>} settings
 * @returns {boolean}
 */
function isEnabledCatalogId(harness, enabled, id, settings) {
  if (enabled.includes(id)) return true;
  if (getBuiltinHarnessBackend(harness)?.favoritesMatchVariants !== true) return false;
  return resolveDelegationModel({ transport: harness, model: id, settings }) !== '';
}

function toRows(entries, harness, settings, delegationEnv = process.env, role = '') {
  const enabled = enabledIds(settings, harness, role);
  const explicitRoleList = hasRoleFavoriteOverride(settings, harness, role);
  const backend = getBuiltinHarnessBackend(harness);
  const roleSettings = backend
    ? { ...settings, [backend.enabledModelsKey]: enabled, delegationRoleFavorites: {} }
    : settings;
  const profiles = loadModelRoleProfiles();
  return entries.map((row) => {
    const id = String(row.value || row.id || row.modelId || '').trim();
    if (!id) return null;
    const decoded = decodeModelValue(id);
    const params = decoded.params || row.params;
    const usageLimit = getHarnessUsageLimit({ harness, model: id });
    return {
      id,
      label: String(row.label || row.name || id),
      // `favorite` is the exact Settings favorite; `enabled` also covers a
      // variant the start gate would resolve to.
      favorite: enabled.includes(id),
      enabled: enabled.length > 0
        ? isEnabledCatalogId(harness, enabled, id, roleSettings)
        : !explicitRoleList && readDelegationEmptyFavoritesPolicy(delegationEnv) === 'all',
      available: usageLimit
        ? false
        : isDelegationModelAvailable({ transport: harness, model: id, settings }),
      ...(usageLimit ? { usage_limited: true, usage_limit: usageLimit } : {}),
      cost_tier: estimateModelCostTier(decoded.modelId || id, params),
      quality_tier: estimateModelQualityTier(decoded.modelId || id, params),
      speed_tier: estimateModelSpeedTier(decoded.modelId || id, params),
      roles: listRolesForModel(id, profiles),
    };
  }).filter(Boolean);
}

/**
 * Best-effort sync delegatable row for start-time hard gates. Exposes
 * `listHarnessCatalog()`'s `enabled` / `ready` / `can_delegate` shape without
 * awaiting SDK probes. `ready` is the credential/CLI probe OR a registered run
 * adapter (see the fallback below), so it never reports `false` for an enabled,
 * delegatable harness just because the sync probe cannot see test/mock
 * credentials.
 *
 * @param {unknown} harness
 * @returns {{ enabled: boolean, ready: boolean, can_delegate: boolean } | null}
 */
export function readSyncHarnessDelegatableRow(harness) {
  const id = parseKnownAgentTransport(harness);
  if (!id) return null;
  const settings = loadSettings();
  const enabled = isHarnessEnabled(id, settings.enabledHarnesses) && !getDisabledOptionalHarness(id);
  const can_delegate = hasChatRunAdapter(id);
  // Best-effort sync credential/CLI probe, mirroring the backend half of
  // `getHarnessStatus()` without awaiting the async SDK availability checks.
  const credentialsReady = getBuiltinHarnessBackend(id)?.credentialsReadySync() === true;
  // A registered run adapter is the concrete server-side execution path, so it
  // is sufficient readiness for this sync start gate even when the credential
  // probe is empty: a test/mock adapter is registered INSTEAD of the vendor
  // adapter and legitimately has no credentials to probe. Harnesses without an
  // adapter (`can_delegate === false`) and disabled harnesses still fail the
  // shared validator, while the async `listHarnessCatalog()` keeps enforcing
  // the stricter credential-based `ready` for the picker/Watcher orchestrator.
  return { enabled, ready: can_delegate || credentialsReady, can_delegate };
}

/**
 * Harness catalog rows: the built-in transports exactly as before, plus any
 * local plugins discoverable through the server-controlled plugin root.
 *
 * Local rows are read-only metadata (never imported) and are appended after
 * the built-ins. When no plugin root is configured the result is byte-for-byte
 * the same eight built-in rows as before this slice. Discovery is memoized and
 * never throws, so a broken plugin root cannot remove or mask a built-in.
 *
 * @returns {Promise<Record<string, any>[]>}
 */
export async function listHarnessCatalog() {
  const settings = loadSettings();
  const status = await getHarnessStatus();
  const builtins = listHarnesses().map((meta) => {
    const id = meta.transport;
    const backend = status?.[id] || { available: false, configured: false };
    // Global env layer only; per-workspace overrides are shown in Settings.
    const cert = describeReviewCertification(id);
    return {
      id,
      label: meta.label,
      enabled: isHarnessEnabled(id, settings.enabledHarnesses) && !getDisabledOptionalHarness(id),
      ready: backend.configured === true,
      available: backend.available === true,
      can_delegate: hasChatRunAdapter(id),
      usage_limit: getHarnessUsageLimit({ harness: id }),
      review_certified: cert.certified,
      review_certification_reason: cert.reason,
      review_uncertified: cert.reviewUncertified,
      review_can_run_tests: cert.reviewCanRunTests,
    };
  });
  const locals = await listLocalHarnessProviders({ settings });
  return [...builtins, ...locals];
}

/**
 * @param {unknown} raw
 * @returns {import('./agent-transport.js').AgentTransport}
 */
export function requireKnownHarness(raw) {
  const harness = parseKnownAgentTransport(raw);
  if (harness) return harness;
  const err = /** @type {Error & { code?: string }} */ (new Error(String(raw || '').trim() ? `Unknown harness "${raw}"` : 'harness is required'));
  err.code = 'VALIDATION';
  throw err;
}

/**
 * @param {{ harness?: unknown, query?: unknown, enabledOnly?: boolean, workspaceFolder?: string, role?: string }} input
 */
export function listHarnessModels(input = {}) {
  const harness = requireKnownHarness(input.harness);
  const settings = loadSettings();
  const enabled = catalogIds(settings, harness);
  const role = String(input.role || '').trim().toLowerCase();
  const roleEnabled = enabledIds(settings, harness, role);
  const needle = String(input.query || '').trim().toLowerCase();
  const enabledOnly = input.enabledOnly === true;
  let entries = [];
  let source = 'fallback';
  let warning = '';
  const offline = getBuiltinHarnessBackend(harness)?.offlineCatalog?.(enabled);
  if (offline) {
    entries = /** @type {any[]} */ (offline.entries);
    source = offline.source;
    warning = offline.warning || '';
  } else if (enabled.length > 0) {
    entries = enabled.map((id) => ({ value: id, label: id }));
    source = 'settings';
    warning = `Using Settings enabled-model list for ${harness}; live vendor catalog was not fetched.`;
  } else {
    warning = `No cached catalog for ${harness}. Set enabled models in Settings or pass a known model id.`;
  }
  const snapshotEntry = readHarnessModelsSnapshotEntry(harness);
  if (snapshotEntry && snapshotEntry.entries.length > 0) {
    entries = snapshotEntry.entries;
    source = snapshotEntry.source || source;
    if (snapshotEntry.warning) warning = snapshotEntry.warning;
    // A live snapshot only knows vendor ids; Settings favorites may be aliases
    // or effort variants that it lacks. Keep them listed so model_list agrees
    // with the start-time validation (one source of truth: Settings favorites).
    if (enabled.length > 0) {
      entries = mergeModelCatalogEntries(entries, catalogEntriesFromModelIds(enabled));
    }
  }
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const delegationEnv = workspaceFolder ? resolveDelegationEnv(workspaceFolder) : process.env;
  const rows = toRows(entries, harness, settings, delegationEnv, role).filter((row) => {
    if (enabledOnly && row.enabled === false) return false;
    if (!needle) return true;
    return `${row.id} ${row.label}`.toLowerCase().includes(needle);
  });
  const favoritesConfigured = roleEnabled.length > 0;
  if (
    enabledOnly
    && !favoritesConfigured
    && readDelegationEmptyFavoritesPolicy(delegationEnv) === 'deny'
  ) {
    const emptyHint = describeEmptyDelegationFavorites(harness);
    warning = warning ? `${warning} ${emptyHint}` : emptyHint;
  }
  return {
    items: rows,
    source,
    warning,
    favorites_configured: favoritesConfigured,
    stale: snapshotEntry?.stale === true,
    lastAttemptAt: snapshotEntry?.lastAttemptAt ?? null,
    lastSuccessAt: snapshotEntry?.lastSuccessAt ?? null,
  };
}

/**
 * Async model catalog entry point used by HTTP/MCP. Built-in behavior stays on
 * the existing synchronous implementation; local providers are resolved from
 * the memoized manifest snapshot and never import plugin code.
 *
 * @param {{ harness?: unknown, query?: unknown, enabledOnly?: boolean, workspaceFolder?: string, role?: string }} input
 * @returns {Promise<{items: Record<string, any>[], source: string, warning: string, favorites_configured: boolean}>}
 */
export async function listHarnessModelsIncludingLocal(input = {}) {
  const builtin = parseKnownAgentTransport(input.harness);
  if (builtin) return listHarnessModels({ ...input, harness: builtin });

  const rawHarness = typeof input.harness === 'string' ? input.harness.trim() : '';
  if (!rawHarness) return listHarnessModels(input); // Preserve the existing required/unknown validation.
  const harness = rawHarness.toLowerCase();
  const settings = loadSettings();
  const localProviders = /** @type {Record<string, any>[]} */ (await listLocalHarnessProviders({ settings }));
  const provider = localProviders.find((row) => row.id === harness);
  if (!provider) return listHarnessModels(input); // Keep unknown ids as the established validation error.

  const enabledOnly = input.enabledOnly === true;
  const needle = String(input.query || '').trim().toLowerCase();
  if (!provider.enabled) {
    return {
      items: [],
      source: 'unavailable',
      warning: 'Local harness is disabled.',
      favorites_configured: false,
    };
  }
  if (provider.capabilities?.models !== true) {
    return {
      items: [],
      source: 'unavailable',
      warning: 'Local harness does not provide models.',
      favorites_configured: false,
    };
  }
  const manifestModels = Array.isArray(provider.models) ? provider.models : [];
  if (manifestModels.length === 0) {
    return {
      items: [],
      source: 'manifest',
      warning: 'No models are declared for this local harness.',
      favorites_configured: false,
    };
  }
  if (enabledOnly) {
    return {
      items: [],
      source: 'manifest',
      warning: 'Local harness model favorites are not configured.',
      favorites_configured: false,
    };
  }
  const items = manifestModels
    .map((model) => ({
      id: model.id,
      label: model.label || model.id,
      enabled: false,
      available: false,
    }))
    .filter((model) => !needle || `${model.id} ${model.label}`.toLowerCase().includes(needle));
  return {
    items,
    source: 'manifest',
    warning: '',
    favorites_configured: false,
  };
}
