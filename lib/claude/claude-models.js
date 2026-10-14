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
 *
 * Every source is overlaid with `CLAUDE_KNOWN_MODELS` so a model released
 * after the bundled Claude Code CLI still appears (see the constant).
 */

import { loadSettings } from '../persist/settings.js';
import {
  decodeModelValue,
  encodeModelValue,
  normalizeChatEnabledModels,
} from '../model-catalog.js';
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
 * Numbered ids stay out of the alias list: they change often and are delivered
 * through `query.supportedModels()` / `/v1/models` (see `CLAUDE_KNOWN_MODELS`
 * for the short-lived exception when the bundled CLI lags a release).
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
 * Numbered ids that the session (`query.supportedModels()`) and alias sources
 * may not list, so they would vanish whenever the catalog falls back to one of
 * them. The Anthropic API accepts these concrete ids. Every source is overlaid
 * with them; a live/session row with the same `value` wins, so updating the SDK
 * makes this list redundant rather than conflicting.
 *
 * @type {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>}
 */
const CLAUDE_KNOWN_MODELS = Object.freeze([
  createClaudeCatalogEntry('claude-haiku-5-5', 'Claude Haiku 5.5'),
  createClaudeCatalogEntry('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
  createClaudeCatalogEntry('claude-opus-5-5', 'Claude Opus 5.5'),
]);

/**
 * @returns {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>}
 */
export function listFallbackClaudeModels() {
  return [...FALLBACK_CLAUDE_MODELS, ...CLAUDE_KNOWN_MODELS];
}

/**
 * Parse `claude-<family>-<major>-<minor>` into its family and numeric version.
 *
 * @param {string} id
 * @returns {{ family: string, version: number[] } | null}
 */
function parseNumberedClaudeId(id) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(String(id || '').trim().toLowerCase());
  if (!match) return null;
  return { family: match[1], version: match[2].split('-').map(Number) };
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Canonical (model-only, no params) Claude id: a moving alias such as `sonnet`
 * maps to the newest numbered id of its family known to the catalog (fallback,
 * known, session and live caches), so `sonnet` and `claude-sonnet-5-5` compare
 * equal. Derived from the catalog, never hardcoded; ids that are not a moving
 * alias are returned lower-cased unchanged.
 *
 * @param {string} modelId
 * @returns {string}
 */
export function canonicalizeClaudeModelId(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id || parseNumberedClaudeId(id)) return id;
  const known = [
    ...listFallbackClaudeModels(),
    ...(sessionCatalogCache?.catalog || []),
    ...(liveCatalogCache?.catalog || []),
  ];
  let best = null;
  for (const row of known) {
    const parsed = parseNumberedClaudeId(row.modelId || row.value);
    if (!parsed || parsed.family !== id) continue;
    if (!best || compareVersions(parsed.version, best.version) > 0) {
      best = { version: parsed.version, id: String(row.modelId || row.value).toLowerCase() };
    }
  }
  return best ? best.id : id;
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

/**
 * Append `CLAUDE_KNOWN_MODELS` rows that the source does not already list.
 * Existing rows keep every field (provider, context window, live label); the
 * overlay only fills a gap, it never rewrites a catalog row.
 *
 * @param {ReadonlyArray<import('../model-catalog.js').ModelCatalogEntry>} catalog
 * @returns {import('../model-catalog.js').ModelCatalogEntry[]}
 */
function withKnownClaudeModels(catalog) {
  const rows = Array.isArray(catalog) ? catalog.slice() : [];
  const seen = new Set(rows.map((row) => String(row?.value || '').trim()));
  for (const known of CLAUDE_KNOWN_MODELS) {
    if (!seen.has(known.value)) rows.push({ ...known });
  }
  return rows;
}

function buildClaudeCatalogResult(catalog, defaultModel, modelsSource) {
  const merged = withKnownClaudeModels(catalog);
  const expanded = expandClaudeEffortCatalog(merged);
  return {
    catalog: expanded,
    models: toClientModels(merged),
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

/**
 * Context windows the SDK reported in `result.modelUsage`, keyed by concrete
 * model id. Learned at run time because the window depends on the account
 * (200K or 1M for the same id); process-wide so a new chat on a known model has
 * the right window before its own first run reports.
 * @type {Map<string, number>}
 */
const reportedContextWindows = new Map();

/**
 * @param {unknown} modelUsage SDK `result.modelUsage`.
 */
export function noteClaudeReportedContextWindows(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return;
  for (const [model, row] of Object.entries(modelUsage)) {
    const windowTokens = readContextWindowTokens(row);
    if (model && windowTokens) reportedContextWindows.set(model, Math.round(windowTokens));
  }
}

/**
 * @param {unknown} model concrete model id of an API call
 * @returns {number | null}
 */
export function getClaudeReportedContextWindow(model) {
  const key = typeof model === 'string' ? model.trim() : '';
  return (key && reportedContextWindows.get(key)) || null;
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
