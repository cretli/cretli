/**
 * Model catalog helpers: SDK rows → selectable entries (with variants/modes),
 * encoding for chat.model, and filtering by user-enabled keys.
 */

/** @typedef {{ id: string, value: string }} ModelParameterValue */

/** @typedef {{
 *   id: string,
 *   displayName: string,
 *   description?: string,
 *   parameters?: Array<{ id: string, displayName?: string, values?: Array<{ value: string, displayName?: string }> }>,
 *   variants?: Array<{ params?: ModelParameterValue[], displayName?: string, description?: string, isDefault?: boolean }>
 * }} SdkModelRow */

/** @typedef {{
 *   value: string,
 *   label: string,
 *   modelId: string,
 *   params?: ModelParameterValue[],
 *   variantLabel?: string,
 *   group?: string,
 *   isDefault?: boolean,
 *   provider?: string,
 *   providerLabel?: string,
 *   costTier?: number,
 *   costLabel?: string,
 *   contextWindowTokens?: number | null,
 * }} ModelCatalogEntry */

export const MODEL_VALUE_SEPARATOR = '::';

export const FALLBACK_AGENT_MODELS = Object.freeze([
  { value: 'auto', label: 'Auto', modelId: 'auto' },
  { value: 'composer-2.5', label: 'Composer 2.5', modelId: 'composer-2.5', group: 'Composer 2.5' },
  { value: 'composer-2', label: 'Composer 2', modelId: 'composer-2', group: 'Composer 2' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8', modelId: 'claude-opus-4-8', group: 'Claude Opus 4.8' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', modelId: 'claude-opus-4-6', group: 'Claude Opus 4.6' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5', modelId: 'claude-opus-4-5', group: 'Claude Opus 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', modelId: 'claude-sonnet-4-6', group: 'Claude Sonnet 4.6' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', modelId: 'claude-sonnet-4-5', group: 'Claude Sonnet 4.5' },
  { value: 'gpt-5.5', label: 'GPT-5.5', modelId: 'gpt-5.5', group: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4', modelId: 'gpt-5.4', group: 'GPT-5.4' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', modelId: 'gpt-5.3-codex', group: 'GPT-5.3 Codex' },
  { value: 'gpt-5.2', label: 'GPT-5.2', modelId: 'gpt-5.2', group: 'GPT-5.2' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini', modelId: 'gpt-5-mini', group: 'GPT-5 Mini' },
  { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', group: 'Gemini 3.1 Pro' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', modelId: 'gemini-3.5-flash', group: 'Gemini 3.5 Flash' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', modelId: 'gemini-2.5-flash', group: 'Gemini 2.5 Flash' },
  { value: 'kimi-k2.5', label: 'Kimi K2.5', modelId: 'kimi-k2.5', group: 'Kimi K2.5' },
]);

const LEGACY_SDK_MODEL_ID_MAP = Object.freeze({
  'opus-4.6-thinking': 'claude-opus-4-6',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.5-thinking': 'claude-opus-4-5',
  'opus-4.5': 'claude-opus-4-5',
  'sonnet-4.6-thinking': 'claude-sonnet-4-6',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'sonnet-4.5-thinking': 'claude-sonnet-4-5',
  'sonnet-4.5': 'claude-sonnet-4-5',
  'gpt-5.2-high': 'gpt-5.2',
  'gemini-3-pro': 'gemini-3.1-pro',
  'composer-1.5': 'composer-2',
  'composer-1': 'composer-2',
});

const DEFAULT_SDK_MODEL_ID = 'composer-2';

/**
 * @param {unknown} row
 * @returns {number | null}
 */
function readCatalogContextWindowTokens(row) {
  if (!row || typeof row !== 'object') return null;
  const numeric = Number(
    row.contextWindowTokens ?? row.contextWindow ?? row.contextLimitTokens ?? row.context_length
  );
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

const VARIANT_PARAM_LABEL_ORDER = Object.freeze([
  'context',
  'effort',
  'reasoning',
  'fast',
  'thinking',
  'cyber',
]);

/**
 * @param {unknown} token
 * @returns {string}
 */
function humanizeCatalogToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * @param {SdkModelRow['parameters']} parametersMeta
 * @param {string} paramId
 * @param {string} paramValue
 * @returns {string}
 */
function resolveParamValueDisplayName(parametersMeta, paramId, paramValue) {
  const def = Array.isArray(parametersMeta)
    ? parametersMeta.find((row) => row?.id === paramId)
    : null;
  const raw = String(paramValue ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'false') return '';
  if (lower === 'true') {
    return normalizeCatalogModelLabel(def?.displayName || humanizeCatalogToken(paramId), paramId);
  }
  const hit = def?.values?.find((row) => String(row?.value ?? '').trim() === raw);
  if (hit?.displayName) return normalizeCatalogModelLabel(hit.displayName, raw);
  return humanizeCatalogToken(raw);
}

/**
 * Build a human-readable variant label from SDK params when variant.displayName
 * repeats the parent model name (common for Cursor API catalog rows).
 *
 * @param {ModelParameterValue[]} params
 * @param {SdkModelRow['parameters']} parametersMeta
 * @returns {string}
 */
export function buildVariantLabelFromParams(params, parametersMeta) {
  if (!Array.isArray(params) || params.length === 0) return '';
  const sorted = params
    .slice()
    .sort((a, b) => {
      const ai = VARIANT_PARAM_LABEL_ORDER.indexOf(String(a.id));
      const bi = VARIANT_PARAM_LABEL_ORDER.indexOf(String(b.id));
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  /** @type {string[]} */
  const parts = [];
  for (const param of sorted) {
    const id = normalizeCatalogModelValue(param?.id);
    const value = normalizeCatalogModelValue(param?.value);
    if (!id || !value) continue;
    const part = resolveParamValueDisplayName(parametersMeta, id, value);
    if (part) parts.push(part);
  }
  if (parts.length > 0) return parts.join(' · ');
  return 'Standard';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCatalogModelValue(value) {
  const v = value == null ? '' : String(value).trim();
  if (!v) return '';
  return v.slice(0, 160);
}

/**
 * @param {unknown} label
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeCatalogModelLabel(label, fallback) {
  const s = label == null ? '' : String(label).trim();
  if (!s) return fallback;
  return s.slice(0, 200);
}

/**
 * @param {unknown} modelId
 * @returns {string}
 */
export function resolveLegacyModelId(modelId) {
  const raw = normalizeCatalogModelValue(modelId);
  if (!raw) return '';
  const lower = raw.toLowerCase();
  return LEGACY_SDK_MODEL_ID_MAP[lower] || raw;
}

/**
 * @param {ModelParameterValue[] | undefined} params
 * @returns {string}
 */
function serializeModelParams(params) {
  if (!Array.isArray(params) || params.length === 0) return '';
  return params
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((row) => `${String(row.id).trim()}=${String(row.value).trim()}`)
    .filter((part) => part !== '=' && !part.startsWith('='))
    .join(',');
}

/**
 * @param {string} modelId
 * @param {ModelParameterValue[] | undefined} params
 * @returns {string}
 */
export function encodeModelValue(modelId, params) {
  const id = resolveLegacyModelId(modelId);
  if (!id || id.toLowerCase() === 'auto') return 'auto';
  const serialized = serializeModelParams(params);
  if (!serialized) return id;
  return `${id}${MODEL_VALUE_SEPARATOR}${serialized}`;
}

/**
 * @param {unknown} storedValue
 * @returns {{ modelId: string, params?: ModelParameterValue[] }}
 */
export function decodeModelValue(storedValue) {
  const raw = normalizeCatalogModelValue(storedValue);
  if (!raw || raw.toLowerCase() === 'auto') {
    return { modelId: 'auto' };
  }
  const sep = raw.indexOf(MODEL_VALUE_SEPARATOR);
  if (sep === -1) {
    return { modelId: resolveLegacyModelId(raw) };
  }
  const modelId = resolveLegacyModelId(raw.slice(0, sep));
  const paramPart = raw.slice(sep + MODEL_VALUE_SEPARATOR.length);
  if (!paramPart) return { modelId };
  /** @type {ModelParameterValue[]} */
  const params = [];
  for (const pair of paramPart.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const id = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!id || !value) continue;
    params.push({ id, value });
  }
  if (params.length === 0) return { modelId };
  return { modelId, params };
}

/**
 * @param {unknown} storedValue
 * @param {string} [defaultModelId]
 * @returns {{ id: string, params?: ModelParameterValue[] }}
 */
export function resolveModelSelection(storedValue, defaultModelId = DEFAULT_SDK_MODEL_ID) {
  const decoded = decodeModelValue(storedValue);
  if (!decoded.modelId || decoded.modelId.toLowerCase() === 'auto') {
    const fallback = normalizeCatalogModelValue(defaultModelId) || DEFAULT_SDK_MODEL_ID;
    return { id: fallback };
  }
  if (decoded.params && decoded.params.length > 0) {
    return { id: decoded.modelId, params: decoded.params };
  }
  return { id: decoded.modelId };
}

/**
 * @param {SdkModelRow} row
 * @returns {ModelCatalogEntry[]}
 */
export function expandSdkModelRow(row) {
  if (!row || typeof row !== 'object') return [];
  const modelId = normalizeCatalogModelValue(row.id);
  if (!modelId) return [];
  const displayName = normalizeCatalogModelLabel(row.displayName, modelId);
  const contextWindowTokens = readCatalogContextWindowTokens(row);
  const parametersMeta = Array.isArray(row.parameters) ? row.parameters : [];
  const variants = Array.isArray(row.variants) ? row.variants : [];
  if (variants.length === 0) {
    return [{
      value: modelId,
      label: displayName,
      modelId,
      group: displayName,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
    }];
  }
  /** @type {ModelCatalogEntry[]} */
  const entries = [];
  for (const variant of variants) {
    const params = Array.isArray(variant?.params)
      ? variant.params
          .map((item) => ({
            id: normalizeCatalogModelValue(item?.id),
            value: normalizeCatalogModelValue(item?.value),
          }))
          .filter((item) => item.id && item.value)
      : [];
    const paramsLabel = buildVariantLabelFromParams(params, parametersMeta);
    let variantLabel = normalizeCatalogModelLabel(variant?.displayName, paramsLabel);
    if (!variantLabel || variantLabel === displayName) {
      variantLabel = normalizeCatalogModelLabel(paramsLabel, modelId);
    }
    const value = encodeModelValue(modelId, params);
    const label = variantLabel && variantLabel !== displayName
      ? `${displayName} — ${variantLabel}`
      : displayName;
    entries.push({
      value,
      label,
      modelId,
      params: params.length > 0 ? params : undefined,
      variantLabel,
      group: displayName,
      isDefault: variant?.isDefault === true,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
    });
  }
  return entries;
}

/**
 * @param {unknown[]} sdkRows
 * @returns {ModelCatalogEntry[]}
 */
export function expandSdkModelsToCatalog(sdkRows) {
  /** @type {ModelCatalogEntry[]} */
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(sdkRows) ? sdkRows : []) {
    for (const entry of expandSdkModelRow(/** @type {SdkModelRow} */ (row))) {
      if (!entry.value || seen.has(entry.value)) continue;
      out.push(entry);
      seen.add(entry.value);
    }
  }
  return out;
}

/**
 * @param {ModelCatalogEntry[]} base
 * @param {unknown[]} extra
 * @returns {ModelCatalogEntry[]}
 */
export function mergeModelCatalogEntries(base, extra) {
  /** @type {ModelCatalogEntry[]} */
  const out = [];
  const seen = new Set();
  const pushEntry = (row) => {
    if (!row || typeof row !== 'object') return;
    const value = normalizeCatalogModelValue(row.value ?? row.modelId ?? row.id);
    if (!value || seen.has(value)) return;
    const modelId = normalizeCatalogModelValue(row.modelId ?? value);
    const label = normalizeCatalogModelLabel(row.label ?? row.displayName, value);
    /** @type {ModelCatalogEntry} */
    const entry = {
      value,
      label,
      modelId: modelId || value,
      group: normalizeCatalogModelLabel(row.group ?? row.displayName, label),
    };
    if (Array.isArray(row.params) && row.params.length > 0) {
      entry.params = row.params
        .map((item) => ({
          id: normalizeCatalogModelValue(item?.id),
          value: normalizeCatalogModelValue(item?.value),
        }))
        .filter((item) => item.id && item.value);
    }
    if (row.variantLabel) entry.variantLabel = normalizeCatalogModelLabel(row.variantLabel, '');
    if (row.isDefault === true) entry.isDefault = true;
    const contextWindowTokens = readCatalogContextWindowTokens(row);
    if (contextWindowTokens != null) entry.contextWindowTokens = contextWindowTokens;
    out.push(entry);
    seen.add(value);
  };
  for (const row of Array.isArray(base) ? base : []) pushEntry(row);
  for (const row of Array.isArray(extra) ? extra : []) pushEntry(row);
  return out;
}

/**
 * Build unified model catalog from /api/agent-sdk payload.
 * Prefers non-empty `catalog`; otherwise maps legacy `models`.
 * Always merges FALLBACK_AGENT_MODELS, optional defaultModel, and Auto first.
 *
 * @param {unknown} payload
 * @returns {ModelCatalogEntry[]}
 */
export function buildCatalogFromSdkStatusPayload(payload) {
  const catalogRows = Array.isArray(payload?.catalog) ? payload.catalog : [];
  const legacyRows = Array.isArray(payload?.models) ? payload.models : [];
  /** @type {ModelCatalogEntry[]} */
  let nextCatalog = [];
  if (catalogRows.length > 0) {
    nextCatalog = mergeModelCatalogEntries(catalogRows, []);
  } else if (legacyRows.length > 0) {
    nextCatalog = mergeModelCatalogEntries(
      legacyRows.map((row) => ({
        value: row?.value,
        label: row?.label,
        modelId: row?.value,
      })),
      [],
    );
  }
  nextCatalog = mergeModelCatalogEntries(nextCatalog, FALLBACK_AGENT_MODELS);
  const defaultModel = normalizeCatalogModelValue(payload?.defaultModel);
  if (defaultModel) {
    nextCatalog = mergeModelCatalogEntries(nextCatalog, [{
      value: defaultModel,
      label: defaultModel,
      modelId: defaultModel,
      group: defaultModel,
    }]);
  }
  const catalog = mergeModelCatalogEntries([{
    value: 'auto',
    label: 'Auto',
    modelId: 'auto',
    group: 'Auto',
  }], nextCatalog);
  return enrichCatalogEntryLabels(catalog);
}

/**
 * Rebuild variant labels from encoded values when rows repeat the model group name
 * (e.g. stale /api/agent-sdk responses served before param-based labeling).
 *
 * @param {ModelCatalogEntry[]} catalog
 * @returns {ModelCatalogEntry[]}
 */
export function enrichCatalogEntryLabels(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const value = normalizeCatalogModelValue(row.value);
    const decoded = decodeModelValue(value);
    if (!decoded.params || decoded.params.length === 0) return row;
    const displayName = normalizeCatalogModelLabel(row.group ?? row.label, decoded.modelId);
    const currentLabel = normalizeCatalogModelLabel(row.label, displayName);
    const currentVariant = normalizeCatalogModelLabel(row.variantLabel, '');
    const needsRelabel = currentLabel === displayName
      || currentLabel === decoded.modelId
      || currentVariant === displayName;
    if (!needsRelabel) return row;
    const paramsLabel = buildVariantLabelFromParams(decoded.params, []);
    if (!paramsLabel) return row;
    const label = `${displayName} — ${paramsLabel}`;
    return {
      ...row,
      label,
      variantLabel: paramsLabel,
      group: displayName,
      modelId: decoded.modelId || row.modelId,
      params: decoded.params,
    };
  });
}

/**
 * Flat { value, label } list for legacy consumers.
 *
 * @param {ModelCatalogEntry[]} catalog
 * @returns {Array<{ value: string, label: string }>}
 */
export function toLegacyModelOptions(catalog) {
  return (Array.isArray(catalog) ? catalog : []).map((row) => ({
    value: row.value,
    label: row.label,
  }));
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeChatEnabledModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const value = normalizeCatalogModelValue(item);
    if (!value || seen.has(value)) continue;
    out.push(value);
    seen.add(value);
  }
  return out;
}

/**
 * When enabled list is empty, all catalog entries remain visible (backward compatible).
 * Otherwise only exact checkbox values are offered — not sibling variants or stale ids.
 *
 * @param {ModelCatalogEntry[]} catalog
 * @param {string[]} enabledKeys
 * @returns {ModelCatalogEntry[]}
 */
export function filterCatalogByEnabled(catalog, enabledKeys) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const enabled = new Set(normalizeChatEnabledModels(enabledKeys));
  if (enabled.size === 0) return rows.slice();
  return rows.filter((row) => {
    const value = normalizeCatalogModelValue(row?.value);
    return Boolean(value && enabled.has(value));
  });
}

/**
 * @param {unknown} payload
 * @returns {ModelCatalogEntry[]}
 */
export function catalogFromModelsPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.catalog) && payload.catalog.length > 0) {
    return payload.catalog.filter((row) => row && typeof row === 'object' && normalizeCatalogModelValue(row.value || row.modelId));
  }
  if (!Array.isArray(payload.models)) return [];
  return payload.models
    .map((row) => {
      if (typeof row === 'string') {
        const value = normalizeCatalogModelValue(row);
        return value ? { value, label: value, modelId: value } : null;
      }
      if (!row || typeof row !== 'object') return null;
      const value = normalizeCatalogModelValue(row.value || row.id);
      if (!value) return null;
      return {
        value,
        label: String(row.label || row.name || value).trim() || value,
        modelId: normalizeCatalogModelValue(row.modelId || row.id) || value,
      };
    })
    .filter(Boolean);
}

/**
 * Checked catalog rows vs catalog size. Counts the same boxes as Settings
 * (exact `value` only). Stale keys and bare model ids do not add extra rows.
 * An empty enabled list means every catalog row is offered.
 *
 * @param {unknown} catalog
 * @param {unknown} enabledKeys
 * @returns {{ enabled: number, total: number }}
 */
export function countCatalogEnabledModels(catalog, enabledKeys) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const total = rows.length;
  const enabled = new Set(normalizeChatEnabledModels(enabledKeys));
  if (enabled.size === 0) return { enabled: total, total };
  let checked = 0;
  for (const row of rows) {
    const value = normalizeCatalogModelValue(row?.value);
    if (value && enabled.has(value)) checked += 1;
  }
  return { enabled: checked, total };
}

/**
 * @param {ModelCatalogEntry[]} catalog
 * @param {string} value
 * @returns {ModelCatalogEntry | undefined}
 */
export function findCatalogEntry(catalog, value) {
  const key = normalizeCatalogModelValue(value);
  if (!key) return undefined;
  return (Array.isArray(catalog) ? catalog : []).find((row) => row.value === key);
}

/**
 * @param {ModelCatalogEntry[]} catalog
 * @param {string} value
 * @returns {string}
 */
export function getCatalogEntryLabel(catalog, value) {
  const hit = findCatalogEntry(catalog, value);
  if (hit?.label) return hit.label;
  const key = normalizeCatalogModelValue(value);
  return key || 'auto';
}
