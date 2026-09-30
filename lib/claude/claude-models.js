/**
 * Anthropic Claude model catalog for the Claude Agent SDK harness.
 *
 * Source priority:
 * 1. `session` — `query.supportedModels()` (`ModelInfo[]`) cached when a
 *    streaming session starts. It is the preferred source because it reflects
 *    the models supported by the active SDK session.
 * 2. `live` — `GET /v1/models` with an API key (skipped for Bedrock/Vertex/
 *    Foundry).
 * 3. `fallback` — Claude Code CLI aliases.
 */

import { loadSettings } from '../persist/settings.js';
import { decodeModelValue, encodeModelValue, normalizeChatEnabledModels } from '../model-catalog.js';
import {
  getEffectiveClaudeApiKey,
  isClaudeThirdPartyProviderConfigured,
} from './claude-api-key.js';

const LIVE_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 10_000;
const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/** @type {{ at: number, cacheKey: string, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let liveCatalogCache = null;

/** @type {{ at: number, catalog: import('../model-catalog.js').ModelCatalogEntry[] } | null} */
let sessionCatalogCache = null;

/**
 * Claude Code CLI accepts aliases that always resolve to the current model.
 * Numbered ids are intentionally not hard-coded here: they change often and
 * are delivered through `query.supportedModels()` / `/v1/models`.
 */
export const DEFAULT_CLAUDE_MODEL = 'sonnet';

/**
 * @param {string} id
 * @param {string} label
 * @param {number | null} [contextWindowTokens]
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function createClaudeCatalogEntry(id, label, contextWindowTokens = null) {
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
  createClaudeCatalogEntry('default', 'Default (Claude Code)'),
  createClaudeCatalogEntry('opus', 'Opus'),
  createClaudeCatalogEntry('sonnet', 'Sonnet'),
  createClaudeCatalogEntry('haiku', 'Haiku'),
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
 * @param {unknown} value
 * @returns {number | null}
 */
function readContextWindowTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (value);
  for (const key of ['contextWindowTokens', 'contextWindow', 'context_window', 'context_window_tokens']) {
    const parsed = Number(rec[key]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
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

const CLAUDE_EFFORT_CHOICES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

function expandClaudeEffortCatalog(catalog) {
  return (Array.isArray(catalog) ? catalog : []).flatMap((row) =>
    CLAUDE_EFFORT_CHOICES.map((effort) => ({
      ...row,
      value: encodeModelValue(row.modelId || row.value, [{ id: 'effort', value: effort }]),
      modelId: row.modelId || row.value,
      params: [{ id: 'effort', value: effort }],
      variantLabel: effort.toUpperCase(),
      label: `${row.label} — ${effort.toUpperCase()}`,
      isDefault: effort === 'medium',
    })),
  );
}

function buildClaudeCatalogResult(catalog, defaultModel, modelsSource) {
  const expanded = expandClaudeEffortCatalog(catalog);
  return {
    catalog: expanded,
    models: toClientModels(catalog),
    defaultModel,
    modelsSource,
  };
}

/**
 * @param {string} id
 * @returns {import('../model-catalog.js').ModelCatalogEntry}
 */
function catalogEntryForClaudeId(id) {
  const fallbackHit = FALLBACK_CLAUDE_MODELS.find((row) => row.value === id);
  if (fallbackHit) return { ...fallbackHit };
  return createClaudeCatalogEntry(id, id, null);
}

/**
 * Maps `query.supportedModels()` (`ModelInfo[]`) onto the catalog shape.
 *
 * @param {unknown} models
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
export function catalogFromClaudeModelInfo(models) {
  const rows = Array.isArray(models) ? models : [];
  const seen = new Set();
  /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
  const catalog = [];
  for (const row of rows) {
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const displayName = typeof row?.displayName === 'string' ? row.displayName.trim() : '';
    const entry = createClaudeCatalogEntry(
      value,
      displayName || value,
      readContextWindowTokens(row),
    );
    catalog.push(entry);
  }
  return catalog;
}

/**
 * Stores the `query.supportedModels()` catalog for `listClaudeModels()`.
 *
 * @param {unknown} models
 * @returns {boolean} true when a non-empty catalog was stored.
 */
export function setClaudeSessionModelCatalog(models) {
  const catalog = catalogFromClaudeModelInfo(models);
  if (catalog.length === 0) return false;
  sessionCatalogCache = { at: Date.now(), catalog };
  return true;
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
    const contextWindowTokens = readContextWindowTokens(row);
    if (contextWindowTokens) entry.contextWindowTokens = contextWindowTokens;
    catalog.push(entry);
  }
  return catalog;
}

export function invalidateClaudeModelsCache() {
  liveCatalogCache = null;
  sessionCatalogCache = null;
}

/**
 * True while the `query.supportedModels()` catalog is within its TTL.
 *
 * @returns {boolean}
 */
export function isClaudeSessionModelCatalogFresh() {
  return Boolean(
    sessionCatalogCache
    && Date.now() - sessionCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS,
  );
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveClaudeApiBaseUrl(_env = process.env) {
  return ANTHROPIC_API_BASE_URL;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<import('../model-catalog.js').ModelCatalogEntry[]>}
 */
async function listLiveClaudeModels(env = process.env) {
  // Bedrock/Vertex/Foundry have no Anthropic Models API with an x-api-key.
  if (isClaudeThirdPartyProviderConfigured(env)) return [];
  const apiKey = getEffectiveClaudeApiKey();
  if (!apiKey) return [];
  const baseUrl = resolveClaudeApiBaseUrl(env);
  const response = await fetch(`${baseUrl}/v1/models?limit=100`, {
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
 * @param {{ refresh?: boolean, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{
 *   catalog: import('../model-catalog.js').ModelCatalogEntry[],
 *   models: Array<{ id: string, name: string, contextWindowTokens: number | null }>,
 *   defaultModel: string,
 *   modelsSource: 'live' | 'session' | 'fallback',
 * }>}
 */
export async function listClaudeModels(options = {}) {
  const refresh = options.refresh === true;
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const defaultModel = resolveDefaultClaudeModel();
  const cacheKey = `anthropic:${!!getEffectiveClaudeApiKey()}`;
  if (refresh) invalidateClaudeModelsCache();
  if (!refresh && sessionCatalogCache && Date.now() - sessionCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS) {
    return buildClaudeCatalogResult(sessionCatalogCache.catalog, defaultModel, 'session');
  }
  if (
    !refresh
    && liveCatalogCache
    && liveCatalogCache.cacheKey === cacheKey
    && Date.now() - liveCatalogCache.at < LIVE_CATALOG_CACHE_TTL_MS
  ) {
    return buildClaudeCatalogResult(liveCatalogCache.catalog, defaultModel, 'live');
  }
  try {
    const live = await listLiveClaudeModels(env);
    if (live.length > 0) {
      liveCatalogCache = { at: Date.now(), cacheKey, catalog: live };
      return buildClaudeCatalogResult(live, defaultModel, 'live');
    }
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err
      ? String(err.message)
      : String(err);
    console.warn('[claude-models] live catalog failed:', message);
  }
  const catalog = listFallbackClaudeModels();
  return buildClaudeCatalogResult(catalog, defaultModel, 'fallback');
}

/**
 * @returns {string[]}
 */
export function getClaudeChatEnabledModels() {
  const settings = loadSettings();
  return normalizeChatEnabledModels(settings.claudeChatEnabledModels);
}

/**
 * Existing chats may have a persisted concrete model id; pass any non-empty
 * id through unchanged so they keep working after the alias switch.
 *
 * @param {string} [modelId]
 * @returns {string}
 */
export function resolveClaudeRunModel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return resolveDefaultClaudeModel();
  return decodeModelValue(raw).modelId || raw;
}

/** @param {unknown} modelId @returns {string} */
export function resolveClaudeRunEffort(modelId) {
  const raw = String(modelId || '').trim();
  const effort = decodeModelValue(raw).params?.find((param) => param.id === 'effort')?.value || '';
  return CLAUDE_EFFORT_CHOICES.includes(effort) ? effort : '';
}
