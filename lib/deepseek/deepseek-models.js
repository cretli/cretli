/**
 * DeepSeek Harness model catalog (official provider routes).
 */

import { loadSettings } from '../persist/settings.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_PROVIDER = 'deepseek-official';

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
export const DEEPSEEK_FALLBACK_MODELS = Object.freeze([
  {
    value: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    modelId: 'deepseek-v4-flash',
    group: 'DeepSeek',
    provider: 'deepseek',
    contextWindowTokens: 1_000_000,
  },
  {
    value: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    modelId: 'deepseek-v4-pro',
    group: 'DeepSeek',
    provider: 'deepseek',
    contextWindowTokens: 1_000_000,
  },
  {
    value: 'deepseek-v4-flash-vision-exp',
    label: 'DeepSeek V4 Flash Vision Exp',
    modelId: 'deepseek-v4-flash-vision-exp',
    group: 'DeepSeek',
    provider: 'deepseek',
    contextWindowTokens: 1_000_000,
  },
]);

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
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'fallback',
 * }>}
 */
export async function listDeepSeekModels() {
  const catalog = listFallbackDeepSeekModels();
  return {
    catalog,
    models: toClientModels(catalog),
    defaultModel: resolveDefaultDeepSeekModel(),
    modelsSource: 'fallback',
  };
}

/**
 * @returns {string[]}
 */
export function getDeepSeekChatEnabledModels() {
  const settings = loadSettings();
  return normalizeChatEnabledModels(settings.deepseekChatEnabledModels);
}
