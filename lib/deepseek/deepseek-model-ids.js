/**
 * DeepSeek official model ids, labels, and vision routing.
 * Kept free of persist/settings so the DSH child plugin can import it.
 */

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_PROVIDER = 'deepseek-official';
export const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models';

const LEGACY_FLASH_IDS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]);

/** @type {Readonly<Record<string, string>>} */
export const DEEPSEEK_MODEL_LABELS = Object.freeze({
  'deepseek-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4.1 Flash',
});

/**
 * Retired Flash ids temporarily route to V4.1 Flash on the DeepSeek API.
 * @param {unknown} modelId
 * @returns {string}
 */
export function remapDeepSeekModelId(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  if (LEGACY_FLASH_IDS.has(raw.toLowerCase())) return DEFAULT_DEEPSEEK_MODEL;
  return raw;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDeepSeekChatEnabledModels(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const id = remapDeepSeekModelId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * V4.1 Flash has native vision; legacy vision-exp ids still contain "vision".
 * @param {unknown} modelId
 * @returns {boolean}
 */
export function isDeepSeekVisionModel(modelId) {
  const remapped = remapDeepSeekModelId(modelId).toLowerCase();
  if (!remapped) return false;
  if (remapped.includes('vision')) return true;
  return remapped === DEFAULT_DEEPSEEK_MODEL;
}

/** Official + legacy Flash ids registered on the DSH llm-deepseek route. */
export const DEEPSEEK_DSH_CATALOG_MODEL_IDS = Object.freeze([
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]);

/**
 * Advisory DSH catalog: unlisted ids are text-only even when the API has vision.
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   contextWindow: number,
 *   inputModalities: ReadonlyArray<'text' | 'image'>,
 * }>}
 */
export function listDeepSeekDshCatalogModels() {
  return DEEPSEEK_DSH_CATALOG_MODEL_IDS.map((id) => {
    const vision = isDeepSeekVisionModel(id);
    return {
      id,
      name: DEEPSEEK_MODEL_LABELS[id] || id,
      contextWindow: 1_000_000,
      inputModalities: vision ? Object.freeze(['text', 'image']) : Object.freeze(['text']),
    };
  });
}

/**
 * @param {string} id
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
export function createDeepSeekCatalogEntry(id) {
  const modelId = String(id || '').trim();
  const label = DEEPSEEK_MODEL_LABELS[modelId] || modelId;
  return {
    value: modelId,
    label,
    modelId,
    group: 'DeepSeek',
    provider: 'deepseek',
    contextWindowTokens: 1_000_000,
  };
}
