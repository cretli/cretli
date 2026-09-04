/**
 * Qwen Cloud model catalog (OpenAI-compatible model ids).
 * Token Plan Individual uses a different allowlist than pay-as-you-go DashScope names.
 */

import { loadSettings } from '../persist/settings.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { resolveQwenEndpoint } from './qwen-api-key.js';

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
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'fallback',
 * }>}
 */
export async function listQwenModels() {
  const catalog = listFallbackQwenModels();
  return {
    catalog,
    models: toClientModels(catalog),
    defaultModel: resolveDefaultQwenModel(),
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
