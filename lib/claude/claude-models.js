/**
 * Anthropic Claude model catalog for the Claude Agent SDK harness.
 * Falls back to a static list when the live Models API is unavailable.
 */

import { loadSettings } from '../persist/settings.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getEffectiveClaudeApiKey } from './claude-api-key.js';

const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 10_000;
const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** @type {{ at: number, cacheKey: string, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * @param {string} id
 * @param {string} label
 * @param {number} [contextWindowTokens]
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function createClaudeCatalogEntry(id, label, contextWindowTokens = 200_000) {
  return {
    value: id,
    label,
    modelId: id,
    group: label,
    provider: 'anthropic',
    contextWindowTokens,
  };
}

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
const FALLBACK_CLAUDE_MODELS = Object.freeze([
  createClaudeCatalogEntry('claude-opus-4-8', 'Claude Opus 4.8'),
  createClaudeCatalogEntry('claude-opus-4-6', 'Claude Opus 4.6'),
  createClaudeCatalogEntry('claude-opus-4-5', 'Claude Opus 4.5'),
  createClaudeCatalogEntry('claude-sonnet-4-6', 'Claude Sonnet 4.6'),
  createClaudeCatalogEntry('claude-sonnet-4-5', 'Claude Sonnet 4.5'),
  createClaudeCatalogEntry('claude-haiku-4', 'Claude Haiku 4'),
]);

/**
 * @returns {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>}
 */
export function listFallbackClaudeModels() {
  return FALLBACK_CLAUDE_MODELS.slice();
}

/**
 * @returns {string}
 */
export function resolveDefaultClaudeModel() {
  const fromEnv = (process.env.CLAUDE_DEFAULT_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_CLAUDE_MODEL;
}

/**
 * @param {import('../model-catalog.js').ModelCatalogEntry[]} catalog
 * @returns {Array<{ id: string, name: string, contextWindowTokens: number | null }>}
 */
function toClientModels(catalog) {
  return catalog.map((row) => ({
    id: row.value,
    name: row.label,
    contextWindowTokens: row.contextWindowTokens || null,
  }));
}

/**
 * @param {string} id
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function catalogEntryForClaudeId(id) {
  const fallbackHit = FALLBACK_CLAUDE_MODELS.find((row) => row.value === id);
  if (fallbackHit) return { ...fallbackHit };
  return createClaudeCatalogEntry(id, id);
}

/**
 * @param {unknown} payload Anthropic `GET /v1/models` response.
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogFromClaudeModelsPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const catalog = [];
  for (const row of rows) {
    const rawId = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    const entry = catalogEntryForClaudeId(rawId);
    const displayName = typeof row?.display_name === 'string' ? row.display_name.trim() : '';
    if (displayName) entry.label = displayName;
    catalog.push(entry);
  }
  return catalog;
}

export function invalidateClaudeModelsCache() {
  liveCatalogCache = null;
}

/**
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveClaudeModels() {
  const apiKey = getEffectiveClaudeApiKey();
  if (!apiKey) return [];
  const response = await fetch(`${ANTHROPIC_API_BASE_URL}/v1/models?limit=100`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    signal: AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return catalogFromClaudeModelsPayload(payload);
}

/**
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'live' | 'fallback',
 * }>}
 */
export async function listClaudeModels(options = {}) {
  const refresh = options.refresh === true;
  const defaultModel = resolveDefaultClaudeModel();
  const cacheKey = `anthropic:${!!getEffectiveClaudeApiKey()}`;
  if (refresh) invalidateClaudeModelsCache();
  if (
    !refresh
    && liveCatalogCache
    && liveCatalogCache.cacheKey === cacheKey
    && Date.now() - liveCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS
  ) {
    return {
      catalog: liveCatalogCache.catalog,
      models: toClientModels(liveCatalogCache.catalog),
      defaultModel,
      modelsSource: 'live',
    };
  }
  try {
    const live = await listLiveClaudeModels();
    if (live.length > 0) {
      liveCatalogCache = { at: Date.now(), cacheKey, catalog: live };
      return {
        catalog: live,
        models: toClientModels(live),
        defaultModel,
        modelsSource: 'live',
      };
    }
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err
      ? String(err.message)
      : String(err);
    console.warn('[claude-models] live catalog failed:', message);
  }
  const catalog = listFallbackClaudeModels();
  return {
    catalog,
    models: toClientModels(catalog),
    defaultModel,
    modelsSource: 'fallback',
  };
}

/**
 * @returns {string[]}
 */
export function getClaudeChatEnabledModels() {
  const settings = loadSettings();
  return normalizeChatEnabledModels(settings.claudeChatEnabledModels);
}

/**
 * @param {string} [modelId]
 * @returns {string}
 */
export function resolveClaudeRunModel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return resolveDefaultClaudeModel();
  return raw;
}
