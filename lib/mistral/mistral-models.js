/**
 * Mistral model catalog. Prefers live models.list(); falls back to the
 * current "-latest" aliases when there is no key, SDK, or network.
 */

import { loadSettings } from '../persist/settings.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getEffectiveMistralApiKey, getMistralServerUrl } from './mistral-api-key.js';
import { loadMistralSdk } from './mistral-sdk.js';

export const MISTRAL_PROVIDER = 'mistral';
export const DEFAULT_MISTRAL_MODEL = 'mistral-medium-latest';

const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** @type {Readonly<Record<string, string>>} */
const MISTRAL_MODEL_LABELS = Object.freeze({
  'mistral-medium-latest': 'Mistral Medium',
  'mistral-large-latest': 'Mistral Large',
  'mistral-small-latest': 'Mistral Small',
  'codestral-latest': 'Codestral',
  'ministral-8b-latest': 'Ministral 8B',
  'ministral-3b-latest': 'Ministral 3B',
});

/**
 * @param {string} id
 * @param {number} [contextWindowTokens]
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function createMistralCatalogEntry(id, contextWindowTokens) {
  const modelId = String(id || '').trim();
  return {
    value: modelId,
    label: MISTRAL_MODEL_LABELS[modelId] || modelId,
    modelId,
    group: 'Mistral',
    provider: MISTRAL_PROVIDER,
    contextWindowTokens: contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
export const MISTRAL_FALLBACK_MODELS = Object.freeze(
  Object.keys(MISTRAL_MODEL_LABELS).map((id) => createMistralCatalogEntry(id)),
);

/** @type {{ at: number, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

/**
 * @returns {string}
 */
export function resolveDefaultMistralModel() {
  const fromEnv = (process.env.MISTRAL_DEFAULT_MODEL || '').trim();
  return fromEnv || DEFAULT_MISTRAL_MODEL;
}

/**
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function listFallbackMistralModels() {
  return MISTRAL_FALLBACK_MODELS.slice();
}

export function invalidateMistralModelsCache() {
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
 * Accepts a models.list() payload (`{ data: [...] }`) or a bare array.
 * Models that explicitly lack chat-completion capability are skipped.
 * @param {unknown} payload
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogFromMistralModelsPayload(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const catalog = [];
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const caps = row?.capabilities;
    const chatCapable = caps?.completionChat ?? caps?.completion_chat;
    if (chatCapable === false) continue;
    seen.add(id);
    const ctx = Number(row?.maxContextLength ?? row?.max_context_length);
    catalog.push(createMistralCatalogEntry(id, Number.isFinite(ctx) && ctx > 0 ? ctx : undefined));
  }
  return catalog;
}

/**
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveMistralModels() {
  const apiKey = getEffectiveMistralApiKey();
  if (!apiKey) return [];
  const sdk = await loadMistralSdk();
  const serverURL = getMistralServerUrl();
  const client = new sdk.Mistral({ apiKey, ...(serverURL ? { serverURL } : {}) });
  const payload = await client.models.list({
    fetchOptions: { signal: AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS) },
  });
  return catalogFromMistralModelsPayload(payload);
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
export async function listMistralModels(options = {}) {
  const refresh = options.refresh === true;
  const defaultModel = resolveDefaultMistralModel();
  if (refresh) invalidateMistralModelsCache();
  if (!refresh && liveCatalogCache && Date.now() - liveCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS) {
    const { catalog } = liveCatalogCache;
    return { catalog, models: toClientModels(catalog), defaultModel, modelsSource: 'live' };
  }
  try {
    const live = await listLiveMistralModels();
    if (live.length > 0) {
      liveCatalogCache = { at: Date.now(), catalog: live };
      return { catalog: live, models: toClientModels(live), defaultModel, modelsSource: 'live' };
    }
  } catch (err) {
    console.warn('[mistral-models] live catalog failed:', err?.message || String(err));
  }
  const catalog = listFallbackMistralModels();
  return { catalog, models: toClientModels(catalog), defaultModel, modelsSource: 'fallback' };
}

/**
 * @returns {string[]}
 */
export function getMistralChatEnabledModels() {
  return normalizeChatEnabledModels(loadSettings().mistralChatEnabledModels);
}
