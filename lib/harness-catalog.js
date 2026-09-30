/**
 * Cached/fallback harness and model catalogs for MCP and HTTP.
 * Does not start harness processes or call vendor networks.
 */

import {
  decodeModelValue,
  enrichCatalogEntryLabels,
  FALLBACK_AGENT_MODELS,
  mergeModelCatalogEntries,
  normalizeChatEnabledModels,
} from './model-catalog.js';
import {
  describeEmptyDelegationFavorites,
  isDelegationModelAvailable,
  readDelegationEmptyFavoritesPolicy,
} from './delegation-executor.js';
import { hasChatRunAdapter } from './chat-run-service.js';
import { isHarnessEnabled } from './harness-enabled.js';
import { getHarnessStatus } from './harness-status.js';
import { listHarnesses } from './agent-harness/registry.js';
import { listLocalHarnessProviders } from './agent-harness/harness-snapshot-registry.js';
import { parseKnownAgentTransport } from './agent-transport.js';
import {
  estimateModelCostTier,
  estimateModelQualityTier,
  estimateModelSpeedTier,
} from './model-catalog-meta.js';
import { listRolesForModel, loadModelRoleProfiles } from './model-role-profiles.js';
import { loadSettings } from './persist/settings.js';
import { listFallbackQwenModels } from './qwen/qwen-models.js';
import { listFallbackClaudeModels } from './claude/claude-models.js';
import { listFallbackDeepSeekModels } from './deepseek/deepseek-models.js';
import { normalizeDeepSeekChatEnabledModels } from './deepseek/deepseek-model-ids.js';
import { listFallbackCodeBuddyModels, resolveCodeBuddyEnabledModels } from './codebuddy/codebuddy-models.js';
import { listFallbackCodexModels, catalogFromCodexModelsCache } from './codex/codex-models.js';
import { resolveCodexHomeDir } from './codex/codex-home.js';
import fs from 'fs';
import path from 'path';
import { getHarnessUsageLimit } from './harness-usage-limits.js';

const ENABLED_MODEL_KEYS = Object.freeze({
  sdk: 'chatEnabledModels',
  openrouter: 'openrouterChatEnabledModels',
  opencode: 'opencodeChatEnabledModels',
  codebuddy: 'codebuddyChatEnabledModels',
  deepseek: 'deepseekChatEnabledModels',
  qwen: 'qwenChatEnabledModels',
  codex: 'codexChatEnabledModels',
  claude: 'claudeChatEnabledModels',
});

function enabledIds(settings, harness) {
  const key = ENABLED_MODEL_KEYS[harness];
  const ids = normalizeChatEnabledModels(key ? settings[key] : []);
  if (harness === 'deepseek') return normalizeDeepSeekChatEnabledModels(ids);
  if (harness === 'codebuddy') return resolveCodeBuddyEnabledModels(ids);
  return ids;
}

/**
 * Settings-only rows so MCP can list enabled SDK variants without a live Cursor catalog.
 *
 * @param {string[]} ids
 * @returns {import('./model-catalog.js').ModelCatalogEntry[]}
 */
function catalogEntriesFromEnabledIds(ids) {
  return enrichCatalogEntryLabels(ids.map((id) => {
    const decoded = decodeModelValue(id);
    return {
      value: id,
      label: id,
      modelId: decoded.modelId,
      params: decoded.params,
      group: decoded.modelId,
    };
  }));
}

function toRows(entries, harness, settings) {
  const enabled = enabledIds(settings, harness);
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
      enabled: enabled.length > 0
        ? enabled.includes(id)
        : readDelegationEmptyFavoritesPolicy() === 'all',
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

function readCachedCodexCatalog() {
  const file = path.join(resolveCodexHomeDir(), 'models_cache.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return catalogFromCodexModelsCache(JSON.parse(raw));
  } catch {
    return [];
  }
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
 * @returns {Promise<object[]>}
 */
export async function listHarnessCatalog() {
  const settings = loadSettings();
  const status = await getHarnessStatus();
  const builtins = listHarnesses().map((meta) => {
    const id = meta.transport;
    const backend = status?.[id] || { available: false, configured: false };
    return {
      id,
      label: meta.label,
      enabled: isHarnessEnabled(id, settings.enabledHarnesses),
      ready: backend.configured === true,
      available: backend.available === true,
      can_delegate: hasChatRunAdapter(id),
      usage_limit: getHarnessUsageLimit({ harness: id }),
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
  const err = new Error(String(raw || '').trim() ? `Unknown harness "${raw}"` : 'harness is required');
  err.code = 'VALIDATION';
  throw err;
}

/**
 * @param {{ harness?: unknown, query?: unknown, enabledOnly?: boolean }} input
 */
export function listHarnessModels(input = {}) {
  const harness = requireKnownHarness(input.harness);
  const settings = loadSettings();
  const enabled = enabledIds(settings, harness);
  const needle = String(input.query || '').trim().toLowerCase();
  const enabledOnly = input.enabledOnly === true;
  let entries = [];
  let source = 'fallback';
  let warning = '';
  if (harness === 'sdk') {
    const extra = catalogEntriesFromEnabledIds(enabled);
    entries = mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, extra);
    source = extra.length > 0 ? 'settings' : 'fallback';
    warning = 'Live Cursor catalog was not fetched.';
  } else if (harness === 'qwen') {
    entries = listFallbackQwenModels();
    source = 'fallback';
  } else if (harness === 'claude') {
    // Settings may contain concrete live/session model ids (including effort
    // variants) that are not represented by the legacy Claude Code aliases.
    // Include those exact ids so model_list(enabled_only=true) exposes the
    // same choices the chat model picker lets the user enable. This stays
    // settings-only: catalog reads do not fetch from Anthropic.
    entries = mergeModelCatalogEntries(
      listFallbackClaudeModels(),
      catalogEntriesFromEnabledIds(enabled),
    );
    source = enabled.length > 0 ? 'settings' : 'fallback';
  } else if (harness === 'deepseek') {
    entries = listFallbackDeepSeekModels();
    source = 'fallback';
  } else if (harness === 'codebuddy') {
    entries = listFallbackCodeBuddyModels();
    source = 'fallback';
  } else if (harness === 'codex') {
    const cached = readCachedCodexCatalog();
    if (cached.length > 0) {
      entries = cached;
      source = 'cache';
    } else {
      entries = listFallbackCodexModels();
      source = 'fallback';
      warning = 'Codex models_cache.json was not present.';
    }
  } else if (enabled.length > 0) {
    entries = enabled.map((id) => ({ value: id, label: id }));
    source = 'settings';
    warning = `Using Settings enabled-model list for ${harness}; live vendor catalog was not fetched.`;
  } else {
    warning = `No cached catalog for ${harness}. Set enabled models in Settings or pass a known model id.`;
  }
  const rows = toRows(entries, harness, settings).filter((row) => {
    if (enabledOnly && row.enabled === false) return false;
    if (!needle) return true;
    return `${row.id} ${row.label}`.toLowerCase().includes(needle);
  });
  const favoritesConfigured = enabled.length > 0;
  if (
    enabledOnly
    && !favoritesConfigured
    && readDelegationEmptyFavoritesPolicy() === 'deny'
  ) {
    const emptyHint = describeEmptyDelegationFavorites(harness);
    warning = warning ? `${warning} ${emptyHint}` : emptyHint;
  }
  return {
    items: rows,
    source,
    warning,
    favorites_configured: favoritesConfigured,
  };
}

/**
 * Async model catalog entry point used by HTTP/MCP. Built-in behavior stays on
 * the existing synchronous implementation; local providers are resolved from
 * the memoized manifest snapshot and never import plugin code.
 *
 * @param {{ harness?: unknown, query?: unknown, enabledOnly?: boolean }} input
 * @returns {Promise<{items: object[], source: string, warning: string, favorites_configured: boolean}>}
 */
export async function listHarnessModelsIncludingLocal(input = {}) {
  const builtin = parseKnownAgentTransport(input.harness);
  if (builtin) return listHarnessModels({ ...input, harness: builtin });

  const rawHarness = typeof input.harness === 'string' ? input.harness.trim() : '';
  if (!rawHarness) return listHarnessModels(input); // Preserve the existing required/unknown validation.
  const harness = rawHarness.toLowerCase();
  const settings = loadSettings();
  const localProviders = await listLocalHarnessProviders({ settings });
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
