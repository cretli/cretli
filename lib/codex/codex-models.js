/**
 * Codex SDK model catalog.
 * ChatGPT sessions refresh `CODEX_HOME/models_cache.json`; use that as the
 * picker when present. API-key mode keeps the documented fallback list.
 * Pass `{ refresh: true }` to delete the cache and probe `codex exec` so CLI
 * rewrites the catalog (same idea as GET /api/codex/models?refresh=1).
 * ThreadOptions still take `model` + `modelReasoningEffort` (no models.list).
 */

import fs from 'fs';
import path from 'path';
import { loadSettings } from '../persist/settings.js';
import { enrichCatalogEntryMetaList } from '../model-catalog-meta.js';
import {
  expandSdkModelRow,
  normalizeChatEnabledModels,
} from '../model-catalog.js';
import { getCodexAuthMode } from './codex-auth-mode.js';
import { getCodexChatGptAuthMetaForClient } from './codex-chatgpt-auth.js';
import { resolveCodexHomeDir } from './codex-home.js';
import {
  fingerprintCodexCatalog,
  refreshLiveCodexCatalog,
  shouldHintCodexCatalogRelogin,
} from './codex-models-refresh.js';

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
 * Per-model effort ladders from Codex CLI docs (learn.chatgpt.com/docs/models)
 * plus OpenAI API reasoning.effort. The exec SDK has no models.list — keep this
 * in sync with Codex recommended / other models. `gpt-5.6` is the Sol alias.
 * Availability still depends on ChatGPT plan, rollout, and sign-in method.
 * @type {ReadonlyArray<{
 *   id: string,
 *   displayName: string,
 *   defaultEffort: string,
 *   efforts: string[],
 * }>}
 */
const CODEX_MODEL_SPECS = Object.freeze([
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
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
    id: 'gpt-5.3-codex-spark',
    displayName: 'GPT-5.3 Codex Spark',
    defaultEffort: 'low',
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-5.6',
    displayName: 'GPT-5.6',
    defaultEffort: 'low',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    defaultEffort: 'medium',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    defaultEffort: 'medium',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    defaultEffort: 'medium',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
]);

const EFFORT_ALLOWED = new Set(CODEX_REASONING_EFFORTS);
const CODEX_MODEL_SPEC_BY_ID = new Map(CODEX_MODEL_SPECS.map((spec) => [spec.id, spec]));

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
 * @param {unknown} row
 * @returns {{ id: string, displayName: string, defaultEffort: string, efforts: string[] } | null}
 */
function specFromCacheRow(row) {
  if (!row || typeof row !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (row);
  if (String(rec.visibility || '').trim() === 'hide') return null;
  const id = String(rec.slug || '').trim();
  if (!id) return null;
  const known = CODEX_MODEL_SPEC_BY_ID.get(id);
  const levels = Array.isArray(rec.supported_reasoning_levels) ? rec.supported_reasoning_levels : [];
  const efforts = [];
  for (const level of levels) {
    if (!level || typeof level !== 'object') continue;
    const effort = /** @type {Record<string, unknown>} */ (level).effort;
    if (!isCodexReasoningEffort(effort) || efforts.includes(effort)) continue;
    efforts.push(effort);
  }
  const rawDefault = rec.default_reasoning_level;
  const defaultEffort = isCodexReasoningEffort(rawDefault)
    ? rawDefault
    : (efforts.includes('medium') ? 'medium' : (efforts[0] || known?.defaultEffort || 'medium'));
  return {
    id,
    displayName: known?.displayName || String(rec.display_name || id).replace(/-/g, ' '),
    defaultEffort: efforts.includes(defaultEffort) ? defaultEffort : (efforts[0] || 'medium'),
    efforts: efforts.length > 0 ? efforts : (known?.efforts || ['medium']),
  };
}

/**
 * Visible ChatGPT/Codex account models from `models_cache.json`.
 *
 * @param {unknown} payload
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogFromCodexModelsCache(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const models = /** @type {Record<string, unknown>} */ (payload).models;
  if (!Array.isArray(models)) return [];
  const specs = [];
  for (const row of models) {
    const spec = specFromCacheRow(row);
    if (spec) specs.push(spec);
  }
  if (specs.length === 0) return [];
  return specs.flatMap((spec) => expandSdkModelRow(toSdkModelRow(spec)));
}

/**
 * @param {import('../model-catalog.js').ModelCatalogEntry[]} catalog
 * @returns {string}
 */
function resolveDefaultCodexModelFromCatalog(catalog) {
  const fromEnv = (process.env.CODEX_DEFAULT_MODEL || '').trim();
  const ids = new Set(catalog.map((row) => row.modelId).filter(Boolean));
  if (fromEnv && ids.has(fromEnv)) return fromEnv;
  if (ids.has(DEFAULT_CODEX_MODEL)) return DEFAULT_CODEX_MODEL;
  const first = catalog.find((row) => row.modelId)?.modelId;
  return first || DEFAULT_CODEX_MODEL;
}

/**
 * @param {string} [homeDir]
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
function readLiveCodexModels(homeDir = resolveCodexHomeDir()) {
  const file = path.join(homeDir, 'models_cache.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    return catalogFromCodexModelsCache(JSON.parse(raw));
  } catch {
    return [];
  }
}

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
 * @param {{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   defaultModel: string,
 *   modelsSource: 'live' | 'fallback',
 *   reloginHint?: boolean,
 * }} listed
 * @returns {{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'live' | 'fallback',
 *   reloginHint: boolean,
 * }}
 */
function toListedCodexModels(listed) {
  return {
    catalog: listed.catalog,
    models: toClientModels(listed.catalog),
    defaultModel: listed.defaultModel,
    modelsSource: listed.modelsSource,
    reloginHint: listed.reloginHint === true,
  };
}

/**
 * @param {{
 *   refresh?: boolean,
 *   authMode?: string,
 *   homeDir?: string,
 *   runProbe?: (opts: { homeDir: string }) => Promise<unknown>,
 * }} [options]
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'live' | 'fallback',
 *   reloginHint: boolean,
 * }>}
 */
export async function listCodexModels(options = {}) {
  const refresh = options.refresh === true;
  const authMode = options.authMode || getCodexAuthMode();
  const homeDir = options.homeDir || resolveCodexHomeDir();
  if (authMode !== 'chatgpt') {
    const catalog = enrichCatalogEntryMetaList(listFallbackCodexModels());
    return toListedCodexModels({
      catalog,
      defaultModel: resolveDefaultCodexModel(),
      modelsSource: 'fallback',
    });
  }
  const beforeFingerprint = fingerprintCodexCatalog(readLiveCodexModels(homeDir));
  const beforePlan = getCodexChatGptAuthMetaForClient(homeDir).chatgptPlanType || '';
  if (refresh) {
    await refreshLiveCodexCatalog({
      homeDir,
      runProbe: options.runProbe,
    });
  }
  const live = readLiveCodexModels(homeDir);
  const afterPlan = getCodexChatGptAuthMetaForClient(homeDir).chatgptPlanType || '';
  const catalogUnchanged = fingerprintCodexCatalog(live) === beforeFingerprint
    || live.length === 0;
  const reloginHint = shouldHintCodexCatalogRelogin({
    refresh,
    catalogUnchanged,
    planTypeUnchanged: afterPlan === beforePlan,
  });
  if (live.length > 0) {
    const catalog = enrichCatalogEntryMetaList(live);
    return toListedCodexModels({
      catalog,
      defaultModel: resolveDefaultCodexModelFromCatalog(catalog),
      modelsSource: 'live',
      reloginHint,
    });
  }
  const catalog = enrichCatalogEntryMetaList(listFallbackCodexModels());
  return toListedCodexModels({
    catalog,
    defaultModel: resolveDefaultCodexModel(),
    modelsSource: 'fallback',
    reloginHint,
  });
}

/**
 * @returns {string[]}
 */
export function getCodexChatEnabledModels() {
  const settings = loadSettings();
  return normalizeChatEnabledModels(settings.codexChatEnabledModels);
}
