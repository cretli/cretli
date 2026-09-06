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
import { isDelegationModelAvailable } from './delegation-executor.js';
import { hasChatRunAdapter } from './chat-run-service.js';
import { isHarnessEnabled } from './harness-enabled.js';
import { getHarnessStatus } from './harness-status.js';
import { listHarnesses } from './agent-harness/registry.js';
import { parseKnownAgentTransport } from './agent-transport.js';
import { loadSettings } from './persist/settings.js';
import { listFallbackQwenModels } from './qwen/qwen-models.js';
import { listFallbackDeepSeekModels } from './deepseek/deepseek-models.js';
import { listFallbackCodeBuddyModels } from './codebuddy/codebuddy-models.js';
import { listFallbackCodexModels, catalogFromCodexModelsCache } from './codex/codex-models.js';
import { resolveCodexHomeDir } from './codex/codex-home.js';
import fs from 'fs';
import path from 'path';

const ENABLED_MODEL_KEYS = Object.freeze({
  sdk: 'chatEnabledModels',
  openrouter: 'openrouterChatEnabledModels',
  opencode: 'opencodeChatEnabledModels',
  codebuddy: 'codebuddyChatEnabledModels',
  deepseek: 'deepseekChatEnabledModels',
  qwen: 'qwenChatEnabledModels',
  codex: 'codexChatEnabledModels',
});

function enabledIds(settings, harness) {
  const key = ENABLED_MODEL_KEYS[harness];
  return normalizeChatEnabledModels(key ? settings[key] : []);
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
  return entries.map((row) => {
    const id = String(row.value || row.id || row.modelId || '').trim();
    return {
      id,
      label: String(row.label || row.name || id),
      enabled: enabled.length === 0 || enabled.includes(id),
      available: isDelegationModelAvailable({ transport: harness, model: id, settings }),
    };
  }).filter((row) => row.id);
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
 * @returns {Promise<object[]>}
 */
export async function listHarnessCatalog() {
  const settings = loadSettings();
  const status = await getHarnessStatus();
  return listHarnesses().map((meta) => {
    const id = meta.transport;
    const backend = status?.[id] || { available: false, configured: false };
    return {
      id,
      label: meta.label,
      enabled: isHarnessEnabled(id, settings.enabledHarnesses),
      ready: backend.configured === true,
      available: backend.available === true,
      can_delegate: hasChatRunAdapter(id),
    };
  });
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
  return { items: rows, source, warning };
}
