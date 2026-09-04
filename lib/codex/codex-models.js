/**
 * Codex SDK model catalog.
 * The exec runtime has no models.list API; variants come from ThreadOptions
 * (`model` + `modelReasoningEffort`) documented by the Codex SDK / OpenAI.
 */

import { loadSettings } from '../persist/settings.js';
import { enrichCatalogEntryMetaList } from '../model-catalog-meta.js';
import {
  expandSdkModelRow,
  normalizeChatEnabledModels,
} from '../model-catalog.js';

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

/** Values accepted by @openai/codex-sdk ThreadOptions.modelReasoningEffort. */
export const CODEX_REASONING_EFFORTS = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
]);

const CODEX_EFFORT_VALUES = Object.freeze([
  { value: 'minimal', displayName: 'Minimal' },
  { value: 'low', displayName: 'Low' },
  { value: 'medium', displayName: 'Medium' },
  { value: 'high', displayName: 'High' },
  { value: 'xhigh', displayName: 'Extra High' },
  { value: 'max', displayName: 'Max' },
  { value: 'ultra', displayName: 'Ultra' },
  { value: 'persistent', displayName: 'Persistent' },
]);

/**
 * Per-model effort ladders from Codex SDK + OpenAI GPT-5.6 / Codex docs.
 * `gpt-5.6` is the documented alias of Sol.
 * @type {ReadonlyArray<{
 *   id: string,
 *   displayName: string,
 *   defaultEffort: string,
 *   efforts: string[],
 * }>}
 */
const CODEX_MODEL_SPECS = Object.freeze([
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    defaultEffort: 'low',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.6',
    displayName: 'GPT-5.6',
    defaultEffort: 'low',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    defaultEffort: 'medium',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
]);

const EFFORT_ALLOWED = new Set(CODEX_REASONING_EFFORTS);

/**
 * @param {unknown} value
 * @returns {value is typeof CODEX_REASONING_EFFORTS[number]}
 */
export function isCodexReasoningEffort(value) {
  return typeof value === 'string' && EFFORT_ALLOWED.has(value);
}

/**
 * @param {{ id: string, displayName: string, defaultEffort: string, efforts: string[] }} spec
 * @returns {import('../model-catalog.js').SdkModelRow}
 */
function toSdkModelRow(spec) {
  return {
    id: spec.id,
    displayName: spec.displayName,
    parameters: [{
      id: 'effort',
      displayName: 'Effort',
      values: CODEX_EFFORT_VALUES.filter((row) => spec.efforts.includes(row.value)),
    }],
    variants: spec.efforts.map((effort) => ({
      displayName: spec.displayName,
      params: [{ id: 'effort', value: effort }],
      isDefault: effort === spec.defaultEffort,
    })),
  };
}

/** @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} */
export const CODEX_FALLBACK_MODELS = Object.freeze(
  CODEX_MODEL_SPECS.flatMap((spec) => expandSdkModelRow(toSdkModelRow(spec))),
);

/**
 * @returns {string}
 */
export function resolveDefaultCodexModel() {
  const fromEnv = (process.env.CODEX_DEFAULT_MODEL || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_CODEX_MODEL;
}

/**
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function listFallbackCodexModels() {
  return CODEX_FALLBACK_MODELS.slice();
}

/**
 * Split a stored picker value (`gpt-5.6-luna::effort=high`) into Codex SDK fields.
 *
 * @param {unknown} storedValue
 * @returns {{ model: string, modelReasoningEffort?: string }}
 */
export function resolveCodexModelSelection(storedValue) {
  const raw = storedValue == null ? '' : String(storedValue).trim();
  if (!raw) return { model: resolveDefaultCodexModel() };
  const sep = raw.indexOf('::');
  const modelId = (sep === -1 ? raw : raw.slice(0, sep)).trim() || resolveDefaultCodexModel();
  if (sep === -1) return { model: modelId };
  /** @type {string | undefined} */
  let modelReasoningEffort;
  for (const pair of raw.slice(sep + 2).split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const id = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (id !== 'effort' || !isCodexReasoningEffort(value)) continue;
    modelReasoningEffort = value;
  }
  if (!modelReasoningEffort) return { model: modelId };
  return { model: modelId, modelReasoningEffort };
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
export async function listCodexModels() {
  const catalog = enrichCatalogEntryMetaList(listFallbackCodexModels());
  return {
    catalog,
    models: toClientModels(catalog),
    defaultModel: resolveDefaultCodexModel(),
    modelsSource: 'fallback',
  };
}

/**
 * @returns {string[]}
 */
export function getCodexChatEnabledModels() {
  const settings = loadSettings();
  return normalizeChatEnabledModels(settings.codexChatEnabledModels);
}
