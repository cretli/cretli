/**
 * Provider labels, relative cost tiers, and sorting for model catalog UI.
 * Cursor SDK does not expose pricing — tiers are heuristic estimates for UX only.
 */

/** @typedef {import('./model-catalog.js').ModelCatalogEntry} ModelCatalogEntry */

export const MODEL_PROVIDER_ORDER = Object.freeze([
  'cursor',
  'anthropic',
  'openai',
  'google',
  'xai',
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
  moonshot: 'Moonshot',
  zhipu: 'Zhipu',
  other: 'Other',
});

/** @typedef {'provider' | 'alpha' | 'cost-asc' | 'cost-desc'} ModelCatalogSortMode */

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
 * @param {string} modelId
 * @param {string} [displayName]
 * @returns {string}
 */
export function resolveModelProviderId(modelId, displayName = '') {
  const id = String(modelId || '').trim().toLowerCase();
  const name = String(displayName || '').trim().toLowerCase();
  if (!id || id === 'auto' || id === 'default') return 'cursor';
  if (id.startsWith('claude-') || /\b(opus|sonnet|haiku|fable)\b/.test(name)) return 'anthropic';
  if (id.startsWith('gpt-') || name.startsWith('gpt')) return 'openai';
  if (id.startsWith('gemini-') || name.includes('gemini')) return 'google';
  if (id.startsWith('composer-') || name.includes('composer')) return 'cursor';
  if (id.startsWith('grok-') || name.includes('grok')) return 'xai';
  if (id.startsWith('kimi-')) return 'moonshot';
  if (id.startsWith('glm-')) return 'zhipu';
  return 'other';
}

/**
 * @param {string} providerId
 * @returns {string}
 */
export function getModelProviderLabel(providerId) {
  return MODEL_PROVIDER_LABELS[providerId] || MODEL_PROVIDER_LABELS.other;
}

/**
 * @param {string} modelId
 * @returns {number}
 */
export function resolveBaseCostTier(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id || id === 'auto' || id === 'default') return 0;
  if (/mini|nano|flash|haiku/.test(id)) return 1;
  if (/sonnet|codex|composer|glm|kimi|fable/.test(id)) return 2;
  if (/gpt-5\.[12]|gpt-5\.1|sonnet-4[^-]/.test(id)) return 3;
  if (/pro|opus|gpt-5\.[3-9]|grok|gemini-3/.test(id)) return 4;
  if (/opus-4-[678]|max|terra|sol|luna|5\.6/.test(id)) return 5;
  return 3;
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
 * @param {string} modelId
 * @param {Array<{ id?: string, value?: string }> | undefined} params
 * @returns {number}
 */
export function estimateModelCostTier(modelId, params) {
  return adjustCostTierFromParams(resolveBaseCostTier(modelId), params);
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
  return {
    ...row,
    provider,
    providerLabel: getModelProviderLabel(provider),
    costTier,
    costLabel: formatCostTierDots(costTier),
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
