/**
 * Qwen Cloud model catalog (OpenAI-compatible model ids).
 * Token Plan Individual uses a different allowlist than pay-as-you-go DashScope names.
 */

import { loadSettings } from '../persist/settings.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import {
  getEffectiveQwenApiKey,
  resolveQwenBaseUrl,
  resolveQwenEndpoint,
} from './qwen-api-key.js';

const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 10_000;

/** @type {{ at: number, cacheKey: string, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

export const DEFAULT_QWEN_MODEL = 'qwen3.8-max';

/**
 * DashScope / Coding Plan names → Token Plan Individual ids.
 * @type {Readonly<Record<string, string>>}
 */
export const QWEN_TOKEN_PLAN_MODEL_ALIASES = Object.freeze({
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.8-max',
  'qwen3-plus': 'qwen3.7-plus',
  'qwen3-coder-plus': 'qwen3.8-flash',
  'qwen3-coder': 'qwen3.8-flash',
});

/**
 * @param {string} id
 * @param {string} label
 * @param {string} [group]
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function createQwenCatalogEntry(id, label, group = 'Qwen') {
  return {
    value: id,
    label,
    modelId: id,
    group,
    provider: 'qwen',
    contextWindowTokens: 1_000_000,
  };
}

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
const TOKEN_PLAN_MODELS = Object.freeze([
  createQwenCatalogEntry('qwen3.8-max', 'Qwen 3.8 Max'),
  createQwenCatalogEntry('qwen3.8-flash', 'Qwen 3.8 Flash'),
  createQwenCatalogEntry('qwen3.7-max', 'Qwen 3.7 Max'),
  createQwenCatalogEntry('qwen3.7-plus', 'Qwen 3.7 Plus'),
  createQwenCatalogEntry('qwen3.6-flash', 'Qwen 3.6 Flash'),
  createQwenCatalogEntry('glm-5.2', 'GLM 5.2', 'Zhipu'),
  createQwenCatalogEntry('deepseek-v4-pro', 'DeepSeek V4 Pro', 'DeepSeek'),
]);

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
const PAYG_MODELS = Object.freeze([
  createQwenCatalogEntry('qwen3.8-max', 'Qwen 3.8 Max'),
  createQwenCatalogEntry('qwen-plus', 'Qwen Plus'),
  createQwenCatalogEntry('qwen3-coder-plus', 'Qwen3 Coder Plus'),
]);

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
const CODING_PLAN_MODELS = Object.freeze([
  createQwenCatalogEntry('qwen3-coder-plus', 'Qwen3 Coder Plus'),
  createQwenCatalogEntry('qwen-plus', 'Qwen Plus'),
  createQwenCatalogEntry('qwen3.8-max', 'Qwen 3.8 Max'),
]);

/**
 * @param {string} [endpoint]
 * @returns {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>}
 */
export function listFallbackQwenModels(endpoint = resolveQwenEndpoint()) {
  if (endpoint === 'token-plan') return TOKEN_PLAN_MODELS.slice();
  if (endpoint === 'coding-plan') return CODING_PLAN_MODELS.slice();
  return PAYG_MODELS.slice();
}

/**
 * @returns {string}
 */
export function resolveDefaultQwenModel() {
  const fromEnv = (process.env.QWEN_DEFAULT_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_QWEN_MODEL;
}

/**
 * @param {string} [modelId]
 * @param {string} [endpoint]
 * @returns {string}
 */
export function remapQwenModelId(modelId, endpoint = resolveQwenEndpoint()) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  if (endpoint !== 'token-plan') return raw;
  return QWEN_TOKEN_PLAN_MODEL_ALIASES[raw] || raw;
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
 * @param {string} endpoint
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function catalogEntryForQwenId(id, endpoint) {
  const fallbackHit = listFallbackQwenModels(endpoint).find((row) => row.value === id);
  if (fallbackHit) return { ...fallbackHit };
  return createQwenCatalogEntry(id, id);
}

/**
 * @param {unknown} payload
 * @param {string} [endpoint]
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogFromQwenModelsPayload(payload, endpoint = resolveQwenEndpoint()) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const catalog = [];
  for (const row of rows) {
    const rawId = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!rawId) continue;
    const id = remapQwenModelId(rawId, endpoint) || rawId;
    if (seen.has(id)) continue;
    seen.add(id);
    catalog.push(catalogEntryForQwenId(id, endpoint));
  }
  return catalog;
}

export function invalidateQwenModelsCache() {
  liveCatalogCache = null;
}

/**
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveQwenModels() {
  const apiKey = getEffectiveQwenApiKey();
  const baseUrl = resolveQwenBaseUrl();
  if (!apiKey || !baseUrl) return [];
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return catalogFromQwenModelsPayload(payload);
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
export async function listQwenModels(options = {}) {
  const refresh = options.refresh === true;
  const defaultModel = resolveDefaultQwenModel();
  const cacheKey = `${resolveQwenEndpoint()}:${resolveQwenBaseUrl()}`;
  if (refresh) invalidateQwenModelsCache();
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
    const live = await listLiveQwenModels();
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
    console.warn('[qwen-models] live catalog failed:', message);
  }
  const catalog = listFallbackQwenModels();
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
export function getQwenChatEnabledModels() {
  const settings = loadSettings();
  const endpoint = resolveQwenEndpoint();
  const raw = normalizeChatEnabledModels(settings.qwenChatEnabledModels);
  const remapped = raw.map((id) => remapQwenModelId(id, endpoint)).filter(Boolean);
  return [...new Set(remapped)];
}

/**
 * @param {string} [modelId]
 * @param {string} [endpoint]
 * @returns {string}
 */
export function resolveQwenRunModel(modelId, endpoint = resolveQwenEndpoint()) {
  const remapped = remapQwenModelId(modelId, endpoint);
  if (!remapped) return resolveDefaultQwenModel();
  return remapped;
}
