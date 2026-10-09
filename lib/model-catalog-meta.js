/**
 * Provider labels, relative cost tiers, and sorting for model catalog UI.
 * Cursor SDK does not expose pricing — tiers are frozen heuristics resolved
 * through the verified alias/family policy (`lib/model-alias-policy.js`), never
 * an unanchored id fragment. Never scrape vendor leaderboards.
 *
 * A tier is a 1..5 *relative* heuristic used for ranking only. It is not a
 * price, an invoice, or a subscription claim, and must never be presented as
 * one (`formatCostTierDots` is a dot scale, not a currency).
 */

import { DEFAULT_MODEL_SCORE_ROWS, matchModelScoreRow } from './model-score-heuristics.js';
import {
  MODEL_ALIAS_POLICY_VERSION,
  UNKNOWN_FAMILY_FALLBACK,
  UNKNOWN_MODEL_FAMILY,
  matchesModelAliasName,
  matchesModelFamily,
  normalizeModelNameHaystack,
  resolveModelFamily,
} from './model-alias-policy.js';

/** @typedef {import('./model-score-heuristics.js').ModelScoreRow} ModelScoreRow */

/** @type {ModelScoreRow[] | null} */
let modelScoreRows = null;

/**
 * Apply optional disk heuristics on the Node server. The browser keeps defaults.
 *
 * @param {ModelScoreRow[]} rows
 * @returns {void}
 */
export function setModelScoreRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  modelScoreRows = rows;
}

/**
 * @returns {ModelScoreRow[]}
 */
function getModelScoreRows() {
  return modelScoreRows || DEFAULT_MODEL_SCORE_ROWS;
}

/** @typedef {import('./model-catalog.js').ModelCatalogEntry} ModelCatalogEntry */

export const MODEL_PROVIDER_ORDER = Object.freeze([
  'cursor',
  'anthropic',
  'openai',
  'google',
  'xai',
  'deepseek',
  'mistral',
  'qwen',
  'moonshot',
  'zhipu',
  'other',
]);

/** @type {Readonly<Record<string, string>>} */
export const MODEL_PROVIDER_LABELS = Object.freeze({
  cursor: 'Cursor',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  qwen: 'Qwen',
  moonshot: 'Moonshot',
  zhipu: 'Zhipu',
  other: 'Other',
});

/** @typedef {'provider' | 'alpha' | 'cost-asc' | 'cost-desc'} ModelCatalogSortMode */

/**
 * Revising `lib/model-alias-policy.js` (a family, an alias, or a tier table
 * below) is a catalog-meta policy revision: report this version next to the
 * tiers so a tier cohort stays distinguishable from a weights change.
 */
export const MODEL_CATALOG_META_POLICY_VERSION = MODEL_ALIAS_POLICY_VERSION;

/**
 * Anchored catalog-id prefixes → provider. Only a prefix of the base id counts,
 * so an id fragment inside a word never decides a provider.
 */
const PROVIDER_ID_PREFIXES = Object.freeze([
  Object.freeze(['claude-', 'anthropic']),
  Object.freeze(['gpt-', 'openai']),
  Object.freeze(['chatgpt-', 'openai']),
  Object.freeze(['gemini-', 'google']),
  Object.freeze(['composer-', 'cursor']),
  Object.freeze(['grok-', 'xai']),
  Object.freeze(['kimi-', 'moonshot']),
  Object.freeze(['glm-', 'zhipu']),
  Object.freeze(['deepseek', 'deepseek']),
  Object.freeze(['qwen', 'qwen']),
  Object.freeze(['mistral', 'mistral']),
  Object.freeze(['codestral', 'mistral']),
  Object.freeze(['devstral', 'mistral']),
  Object.freeze(['magistral', 'mistral']),
  Object.freeze(['ministral', 'mistral']),
]);

/**
 * Relative cost tier per verified family, checked from the cheapest level.
 * Heuristic only — never an invoice, a token price, or a subscription fee.
 * `patterns` are the frozen version-shape rules that no family alias covers
 * (`gpt-5.6` is a version, not a name); they demand a name boundary too.
 */
const COST_TIER_LEVELS = Object.freeze([
  Object.freeze({ tier: 1, families: Object.freeze(['mini', 'nano', 'flash', 'haiku']), patterns: Object.freeze([]) }),
  Object.freeze({
    tier: 2,
    families: Object.freeze(['sonnet', 'codex', 'composer', 'glm', 'kimi', 'fable']),
    patterns: Object.freeze([]),
  }),
  Object.freeze({
    tier: 3,
    families: Object.freeze([]),
    patterns: Object.freeze([/^(?:.*[-_./:,])?gpt-5[.-][12](?:$|[-_./:,].*)$/]),
  }),
  Object.freeze({
    tier: 4,
    families: Object.freeze(['pro', 'opus', 'grok']),
    patterns: Object.freeze([
      /^(?:.*[-_./:,])?gpt-5[.-][3-9](?:$|[-_./:,].*)$/,
      /^(?:.*[-_./:,])?gemini-3(?:$|[-_./:,].*)$/,
    ]),
  }),
  Object.freeze({
    tier: 5,
    families: Object.freeze(['terra', 'sol', 'luna', 'astra', 'max']),
    patterns: Object.freeze([]),
  }),
]);

/** Relative quality tier per verified family (1 = weakest, 5 = strongest). */
const QUALITY_TIER_LEVELS = Object.freeze([
  Object.freeze({ tier: 5, families: Object.freeze(['sol', 'luna', 'astra', 'terra', 'opus', 'grok']) }),
  Object.freeze({ tier: 4, families: Object.freeze(['sonnet', 'composer', 'codex']) }),
  Object.freeze({ tier: 2, families: Object.freeze(['flash', 'haiku', 'mini', 'nano', 'fable']) }),
]);

/** Relative speed tier per verified family (1 = slowest, 5 = fastest). */
const SPEED_TIER_LEVELS = Object.freeze([
  Object.freeze({ tier: 5, families: Object.freeze(['flash', 'haiku', 'mini', 'nano']) }),
  Object.freeze({ tier: 4, families: Object.freeze(['composer']) }),
]);

/**
 * @param {string} modelId
 * @param {string} [displayName]
 * @returns {string}
 */
export function resolveModelProviderId(modelId, displayName = '') {
  const id = normalizeModelNameHaystack(modelId);
  const name = normalizeModelNameHaystack(displayName);
  if (!id || id === 'auto' || id === 'default') return 'cursor';
  for (const [prefix, provider] of PROVIDER_ID_PREFIXES) {
    if (id.startsWith(prefix)) return provider;
  }
  // A verified family alias carries its provider; a cross-vendor class such as
  // `flash` deliberately carries none, so it never guesses one.
  for (const haystack of [id, name]) {
    if (!haystack) continue;
    const provider = resolveModelFamily(haystack).provider;
    if (provider) return provider;
  }
  return 'other';
}

/** @type {Readonly<ModelCatalogSortMode[]>} */
export const MODEL_CATALOG_SORT_MODES = Object.freeze([
  'provider',
  'alpha',
  'cost-asc',
  'cost-desc',
]);

/**
 * @param {unknown} value
 * @returns {ModelCatalogSortMode}
 */
export function normalizeModelCatalogSortMode(value) {
  const mode = String(value || '').trim();
  if (MODEL_CATALOG_SORT_MODES.includes(/** @type {ModelCatalogSortMode} */ (mode))) {
    return /** @type {ModelCatalogSortMode} */ (mode);
  }
  return 'provider';
}

/**
 * @param {string} providerId
 * @returns {string}
 */
export function getModelProviderLabel(providerId) {
  return MODEL_PROVIDER_LABELS[providerId] || MODEL_PROVIDER_LABELS.other;
}

/**
 * Relative cost tier (1 = cheapest … 5 = most expensive) for ids the frozen
 * score rows do not cover. Purely a heuristic for ranking: it is not a price,
 * not an invoice, and not a subscription fee. An unknown family keeps the
 * documented neutral fallback.
 *
 * @param {string} modelId
 * @returns {number}
 */
export function resolveBaseCostTier(modelId) {
  const id = normalizeModelNameHaystack(modelId);
  if (!id || id === 'auto' || id === 'default') return 0;
  for (const level of COST_TIER_LEVELS) {
    if (level.families.some((family) => matchesModelFamily(id, family))) return level.tier;
    if (level.patterns.some((pattern) => pattern.test(id))) return level.tier;
  }
  return UNKNOWN_FAMILY_FALLBACK.tier;
}

/**
 * @param {number} baseTier
 * @param {Array<{ id?: string, value?: string }> | undefined} params
 * @returns {number}
 */
export function adjustCostTierFromParams(baseTier, params) {
  let tier = Number.isFinite(baseTier) ? baseTier : 3;
  if (!Array.isArray(params)) return Math.max(0, Math.min(5, Math.round(tier)));
  for (const param of params) {
    const id = String(param?.id || '').trim().toLowerCase();
    const value = String(param?.value || '').trim().toLowerCase();
    if (!id || !value) continue;
    if (id === 'effort') {
      if (value === 'medium') tier += 0.3;
      else if (value === 'high') tier += 0.6;
      else if (value === 'xhigh' || value === 'extra-high') tier += 1;
      else if (value === 'max') tier += 1.2;
    }
    if (id === 'reasoning') {
      if (value === 'medium') tier += 0.2;
      else if (value === 'high') tier += 0.5;
      else if (value === 'extra-high') tier += 0.8;
    }
    if (id === 'thinking' && value === 'true') tier += 0.5;
    if (id === 'context' && value === '1m') tier += 0.4;
  }
  return Math.max(0, Math.min(5, Math.round(tier)));
}

/**
 * Does one name part match the id? Either as a literal alias on name boundaries,
 * or through a declared family's alias set, so the frozen row `glm-5.3-flash`
 * also covers the verified `flashx` alias instead of demanding the exact
 * fragment.
 *
 * @param {string} id
 * @param {string} part
 * @returns {boolean}
 */
function namePartMatches(id, part) {
  return matchesModelAliasName(id, part) || matchesModelFamily(id, part);
}

/**
 * Does one frozen score-row pattern name-match the id? Either the whole pattern
 * on name boundaries, or every separator-split part of it (so `deepseek-flash`
 * still covers `deepseek-v4.1-flash`). An accidental fragment — `astra` inside
 * `astronaut-8b`, `sol` inside `resolution-7b` — never selects a row.
 *
 * @param {string} pattern
 * @param {string} id
 * @returns {boolean}
 */
function scoreRowMatchesName(pattern, id) {
  if (namePartMatches(id, pattern)) return true;
  const parts = String(pattern || '').split(/[-_./]/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => namePartMatches(id, part));
}

/**
 * Frozen score row for an id, with the alias policy deciding what a name match
 * is. When only a whole-id alias carries the name (`gpt-5.6` is the Sol alias),
 * the family's own row is used, so an alias cannot lose its tiers.
 *
 * @param {string} id normalized base id
 * @returns {ModelScoreRow | null}
 */
function matchCatalogScoreRow(id) {
  const rows = getModelScoreRows()
    .filter((row) => scoreRowMatchesName(row.pattern, id));
  if (rows.length > 0) {
    return rows.reduce((best, row) => (row.pattern.length > best.pattern.length ? row : best));
  }
  const family = resolveModelFamily(id).family;
  if (family === UNKNOWN_MODEL_FAMILY) return null;
  const familyRows = getModelScoreRows().filter((row) => row.pattern === family);
  return familyRows.length > 0 ? familyRows[0] : null;
}

/**
 * Relative cost tier plus the param surcharges (effort/reasoning/thinking/
 * context). Params move the *tier*, they never change which family an id
 * belongs to. Not a price.
 *
 * @param {string} modelId
 * @param {Array<{ id?: string, value?: string }> | undefined} params
 * @returns {number}
 */
export function estimateModelCostTier(modelId, params) {
  const id = normalizeModelNameHaystack(modelId);
  const matched = matchCatalogScoreRow(id);
  const base = matched ? matched.cost : resolveBaseCostTier(id);
  return adjustCostTierFromParams(base, params);
}

/**
 * Heuristic quality tier (1–5, higher = stronger). Not vendor benchmarks and not
 * a price — a relative tier for ranking, resolved through verified families. The
 * frozen score rows win when they cover the id; an unknown family keeps the
 * documented neutral fallback.
 *
 * @param {string} modelId
 * @param {Array<{ id?: string, value?: string }> | undefined} [_params]
 * @returns {number}
 */
export function estimateModelQualityTier(modelId, _params) {
  const id = normalizeModelNameHaystack(modelId);
  if (!id || id === 'auto' || id === 'default') return UNKNOWN_FAMILY_FALLBACK.tier;
  const matched = matchCatalogScoreRow(id);
  if (matched) return matched.quality;
  for (const level of QUALITY_TIER_LEVELS) {
    if (level.families.some((family) => matchesModelFamily(id, family))) return level.tier;
  }
  return UNKNOWN_FAMILY_FALLBACK.tier;
}

/**
 * @param {number} baseTier
 * @param {Array<{ id?: string, value?: string }> | undefined} params
 * @returns {number}
 */
export function adjustSpeedTierFromParams(baseTier, params) {
  let tier = Number.isFinite(baseTier) ? baseTier : 3;
  if (!Array.isArray(params)) return Math.max(1, Math.min(5, Math.round(tier)));
  for (const param of params) {
    const id = String(param?.id || '').trim().toLowerCase();
    const value = String(param?.value || '').trim().toLowerCase();
    if (!id || !value) continue;
    if (id === 'fast' && value === 'true') tier += 1;
    if (id === 'effort') {
      if (value === 'medium') tier -= 0.3;
      else if (value === 'high') tier -= 0.6;
      else if (value === 'xhigh' || value === 'extra-high') tier -= 1;
      else if (value === 'max') tier -= 1.2;
    }
    if (id === 'reasoning') {
      if (value === 'medium') tier -= 0.2;
      else if (value === 'high') tier -= 0.5;
      else if (value === 'extra-high') tier -= 0.8;
    }
    if (id === 'thinking' && value === 'true') tier -= 0.5;
  }
  return Math.max(1, Math.min(5, Math.round(tier)));
}

/**
 * Heuristic speed tier (1–5, higher = faster), resolved through verified
 * families. Params can raise it (`fast`) or lower it
 * (effort/reasoning/thinking). Not a benchmark measurement.
 *
 * @param {string} modelId
 * @param {Array<{ id?: string, value?: string }> | undefined} params
 * @returns {number}
 */
export function estimateModelSpeedTier(modelId, params) {
  const id = normalizeModelNameHaystack(modelId);
  if (!id || id === 'auto' || id === 'default') return UNKNOWN_FAMILY_FALLBACK.tier;
  const matched = matchCatalogScoreRow(id);
  let base = UNKNOWN_FAMILY_FALLBACK.tier;
  if (matched) base = matched.speed;
  else {
    for (const level of SPEED_TIER_LEVELS) {
      if (level.families.some((family) => matchesModelFamily(id, family))) {
        base = level.tier;
        break;
      }
    }
  }
  return adjustSpeedTierFromParams(base, params);
}

/**
 * @param {number} tier
 * @returns {string}
 */
export function formatCostTierDots(tier) {
  const level = Math.max(0, Math.min(5, Math.round(Number(tier) || 0)));
  if (level === 0) return '—';
  return '$'.repeat(level);
}

/**
 * @param {ModelCatalogEntry} row
 * @returns {ModelCatalogEntry}
 */
export function enrichCatalogEntryMeta(row) {
  if (!row || typeof row !== 'object') return row;
  const modelId = String(row.modelId || row.value || '').trim();
  const group = String(row.group || row.label || modelId).trim();
  const provider = resolveModelProviderId(modelId, group);
  const costTier = estimateModelCostTier(modelId, row.params);
  const qualityTier = estimateModelQualityTier(modelId, row.params);
  const speedTier = estimateModelSpeedTier(modelId, row.params);
  return {
    ...row,
    provider,
    providerLabel: getModelProviderLabel(provider),
    costTier,
    costLabel: formatCostTierDots(costTier),
    qualityTier,
    speedTier,
  };
}

/**
 * @param {ModelCatalogEntry[]} catalog
 * @returns {ModelCatalogEntry[]}
 */
export function enrichCatalogEntryMetaList(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog.map((row) => enrichCatalogEntryMeta(row));
}

/**
 * @param {ModelCatalogEntry[]} entries
 * @param {ModelCatalogSortMode} sortMode
 * @returns {ModelCatalogEntry[]}
 */
export function sortModelCatalogEntries(entries, sortMode) {
  const mode = normalizeModelCatalogSortMode(sortMode);
  const rows = Array.isArray(entries) ? entries.slice() : [];
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  if (mode === 'alpha') {
    return rows.sort((a, b) => collator.compare(a.label, b.label));
  }
  if (mode === 'cost-asc') {
    return rows.sort((a, b) => {
      const tierDiff = (a.costTier ?? 3) - (b.costTier ?? 3);
      if (tierDiff !== 0) return tierDiff;
      return collator.compare(a.label, b.label);
    });
  }
  if (mode === 'cost-desc') {
    return rows.sort((a, b) => {
      const tierDiff = (b.costTier ?? 3) - (a.costTier ?? 3);
      if (tierDiff !== 0) return tierDiff;
      return collator.compare(a.label, b.label);
    });
  }
  return rows.sort((a, b) => {
    const providerA = MODEL_PROVIDER_ORDER.indexOf(a.provider || 'other');
    const providerB = MODEL_PROVIDER_ORDER.indexOf(b.provider || 'other');
    if (providerA !== providerB) return providerA - providerB;
    const groupDiff = collator.compare(a.group || '', b.group || '');
    if (groupDiff !== 0) return groupDiff;
    const tierDiff = (b.costTier ?? 3) - (a.costTier ?? 3);
    if (tierDiff !== 0) return tierDiff;
    return collator.compare(a.label, b.label);
  });
}

/**
 * @typedef {{
 *   type: 'provider',
 *   provider: string,
 *   providerLabel: string,
 *   models: Array<{ group: string, entries: ModelCatalogEntry[] }>,
 * }} ModelCatalogProviderGroup
 *
 * @typedef {{
 *   type: 'flat',
 *   entries: ModelCatalogEntry[],
 * }} ModelCatalogFlatGroup
 */

/**
 * @param {ModelCatalogEntry[]} entries
 * @param {ModelCatalogSortMode} sortMode
 * @returns {Array<ModelCatalogProviderGroup | ModelCatalogFlatGroup>}
 */
export function groupModelCatalogForSettings(entries, sortMode) {
  const sorted = sortModelCatalogEntries(entries, sortMode);
  const mode = normalizeModelCatalogSortMode(sortMode);
  if (mode !== 'provider') {
    return [{ type: 'flat', entries: sorted }];
  }
  /** @type {ModelCatalogProviderGroup[]} */
  const providers = [];
  /** @type {Map<string, ModelCatalogProviderGroup>} */
  const providerMap = new Map();
  for (const entry of sorted) {
    const provider = entry.provider || 'other';
    if (!providerMap.has(provider)) {
      /** @type {ModelCatalogProviderGroup} */
      const block = {
        type: 'provider',
        provider,
        providerLabel: entry.providerLabel || getModelProviderLabel(provider),
        models: [],
      };
      providerMap.set(provider, block);
      providers.push(block);
    }
    const block = providerMap.get(provider);
    if (!block) continue;
    const group = entry.group || entry.modelId || entry.label;
    let modelGroup = block.models.find((item) => item.group === group);
    if (!modelGroup) {
      modelGroup = { group, entries: [] };
      block.models.push(modelGroup);
    }
    modelGroup.entries.push(entry);
  }
  return providers;
}
