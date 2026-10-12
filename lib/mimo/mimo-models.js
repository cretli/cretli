/**
 * Xiaomi MiMo model catalog.
 * Prefers live GET /models from the OpenAI-compatible endpoint; falls back to
 * the current official MiMo platform ids.
 */

import { getEffectiveMimoApiKey, getEffectiveMimoBaseUrl } from './mimo-api-key.js';

const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 10_000;

/** @returns {string} */
function resolveMimoModelsUrl() {
  const base = getEffectiveMimoBaseUrl().replace(/\/+$/, '');
  return `${base}/models`;
}

/**
 * @param {string} id
 * @param {number | null} [contextWindowTokens]
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function createMimoCatalogEntry(id, contextWindowTokens = null) {
  return {
    value: id,
    label: id,
    modelId: id,
    group: 'MiMo',
    provider: 'mimo',
    contextWindowTokens,
  };
}

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
export const MIMO_FALLBACK_MODELS = Object.freeze([
  createMimoCatalogEntry('mimo-v2.6-pro', 262144),
  createMimoCatalogEntry('mimo-v2.6-flash', 262144),
]);

/** @type {{ at: number, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

/** @returns {string} */
export function resolveDefaultMimoModel() {
  const fromEnv = (process.env.MIMO_DEFAULT_MODEL || '').trim();
  return fromEnv || 'mimo-v2.6-pro';
}

/** @returns {import('../model-catalog.js').ModelCatalogEntry[]} */
export function listFallbackMimoModels() {
  return MIMO_FALLBACK_MODELS.slice();
}

/** @returns {void} */
export function invalidateMimoModelsCache() {
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
export function catalogFromMimoModelsPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const catalog = [];
  for (const row of rows) {
    const rawId = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!rawId || seen.has(rawId)) continue;
    seen.add(rawId);
    // Skip companion TTS/ASR service models from the chat harness picker.
    if (/^mimo-v[\d.]+-(tts|asr)/i.test(rawId)) continue;
    const fallback = MIMO_FALLBACK_MODELS.find((entry) => entry.value === rawId);
    catalog.push(createMimoCatalogEntry(rawId, fallback?.contextWindowTokens || null));
  }
  return catalog;
}

/**
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveMimoModels() {
  const apiKey = getEffectiveMimoApiKey();
  if (!apiKey) return [];
  const response = await fetch(resolveMimoModelsUrl(), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return catalogFromMimoModelsPayload(payload);
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
export async function listMimoModels(options = {}) {
  const refresh = options.refresh === true;
  const defaultModel = resolveDefaultMimoModel();
  if (refresh) invalidateMimoModelsCache();
  if (!refresh && liveCatalogCache && Date.now() - liveCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS) {
    return {
      catalog: liveCatalogCache.catalog,
      models: toClientModels(liveCatalogCache.catalog),
      defaultModel,
      modelsSource: 'live',
    };
  }
  try {
    const live = await listLiveMimoModels();
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
    console.warn('[mimo-models] live catalog failed:', message);
  }
  const catalog = listFallbackMimoModels();
  return {
    catalog,
    models: toClientModels(catalog),
    defaultModel,
    modelsSource: 'fallback',
  };
}
