/**
 * DeepSeek Harness model catalog (official provider routes).
 * Prefers live GET /models; falls back to the current official ids.
 */

import { loadSettings } from '../persist/settings.js';
import { getEffectiveDeepSeekApiKey } from './deepseek-api-key.js';
import {
  createDeepSeekCatalogEntry,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_MODELS_URL,
  DEEPSEEK_PROVIDER,
  isDeepSeekVisionModel,
  normalizeDeepSeekChatEnabledModels,
  remapDeepSeekModelId,
} from './deepseek-model-ids.js';

export {
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_PROVIDER,
  isDeepSeekVisionModel,
  normalizeDeepSeekChatEnabledModels,
  remapDeepSeekModelId,
};

const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 10_000;

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
export const DEEPSEEK_FALLBACK_MODELS = Object.freeze([
  createDeepSeekCatalogEntry('deepseek-flash'),
  createDeepSeekCatalogEntry('deepseek-v4-pro'),
]);

/** @type {{ at: number, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

/**
 * @returns {string}
 */
export function resolveDefaultDeepSeekModel() {
  const fromEnv = (process.env.DEEPSEEK_DEFAULT_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_DEEPSEEK_MODEL;
}

/**
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function listFallbackDeepSeekModels() {
  return DEEPSEEK_FALLBACK_MODELS.slice();
}

export function invalidateDeepSeekModelsCache() {
  liveCatalogCache = null;
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
 * @param {unknown} payload
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogFromDeepSeekModelsPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const catalog = [];
  for (const row of rows) {
    const rawId = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!rawId) continue;
    const id = remapDeepSeekModelId(rawId) || rawId;
    if (seen.has(id)) continue;
    seen.add(id);
    catalog.push(createDeepSeekCatalogEntry(id));
  }
  return catalog;
}

/**
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveDeepSeekModels() {
  const apiKey = getEffectiveDeepSeekApiKey();
  if (!apiKey) return [];
  const response = await fetch(DEEPSEEK_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return catalogFromDeepSeekModelsPayload(payload);
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
export async function listDeepSeekModels(options = {}) {
  const refresh = options.refresh === true;
  const defaultModel = resolveDefaultDeepSeekModel();
  if (refresh) invalidateDeepSeekModelsCache();
  if (!refresh && liveCatalogCache && Date.now() - liveCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS) {
    return {
      catalog: liveCatalogCache.catalog,
      models: toClientModels(liveCatalogCache.catalog),
      defaultModel,
      modelsSource: 'live',
    };
  }
  try {
    const live = await listLiveDeepSeekModels();
    if (live.length > 0) {
      liveCatalogCache = { at: Date.now(), catalog: live };
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
    console.warn('[deepseek-models] live catalog failed:', message);
  }
  const catalog = listFallbackDeepSeekModels();
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
export function getDeepSeekChatEnabledModels() {
  const settings = loadSettings();
  return normalizeDeepSeekChatEnabledModels(settings.deepseekChatEnabledModels);
}
