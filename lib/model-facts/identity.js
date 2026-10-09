/**
 * Exact provider identity for a Cretli `(harness, catalog model, variant)` triple.
 *
 * Stage 1 of the model quality/cost plan (`2584cd05`). This module answers one
 * question only: which external provider endpoint and external model id serves a
 * given Cretli pair, or `unmatched` when no declared alias covers it.
 *
 * ## Exact match, never a join
 * A lookup is a `Map` hit on a composed key. There is deliberately no name
 * parsing, no prefix/substring test, no family expansion and no regex: the
 * family/role policy in `lib/model-alias-policy.js` decides *eligibility*, while
 * this registry decides *identity*. Mixing the two is what once let a model
 * named `resolution` inherit the `sol` family; identity must not repeat that.
 *
 * Key parts are trimmed and lower-cased (`gpt-5.6-sol` and `GPT-5.6-SOL` are the
 * same pair), the variant defaults to the empty string, and the three parts are
 * joined with a NUL separator so `a` + `b|c` can never collide with `a|b` + `c`.
 *
 * ## Variant only where it exists
 * The plan says variant/effort belongs in the key "only where it actually
 * exists". A harness whose provider sends variant/effort as a separate request
 * parameter (Codex `modelReasoningEffort`, for example) does not change the
 * external model id. Those rows declare `variantNeutral: true` and cover every
 * variant of that `(harness, model)` pair. The coverage is declared per row, not
 * inferred: a row without `variantNeutral` matches its literal variant only, so
 * `effort=high` on such a pair stays `unmatched` instead of silently borrowing
 * the base row.
 *
 * ## Conflicts
 * Two declared rows for the same key with different `(provider, endpoint,
 * externalModelId)` are a conflict. A conflicting key resolves to `unmatched`
 * with reason `conflicting-alias`; the caller must treat it as no signal, never
 * pick one mapping. This is what keeps an ambiguous alias from influencing
 * ranking.
 *
 * ## Same model on two harnesses
 * The harness is the first key part, so the same catalog model id reached
 * through two harnesses is two independent pairs. A fact collected for one
 * harness never aliases onto the other.
 *
 * @typedef {{
 *   harness: string,
 *   model: string,
 *   variant?: string,
 *   variantNeutral?: boolean,
 *   provider: string,
 *   endpoint: string,
 *   externalModelId: string,
 *   evidence: string,
 * }} ModelIdentityAliasRow
 *
 * @typedef {{
 *   aliasStatus: 'matched' | 'unmatched',
 *   aliasReason: string,
 *   harness: string,
 *   model: string,
 *   variant: string,
 *   identityKey: string,
 *   provider: string | null,
 *   endpoint: string | null,
 *   externalModelId: string | null,
 *   conflicts: Array<{ provider: string, endpoint: string, externalModelId: string }>,
 * }} ModelIdentityResolution
 */

/** Bump when the key composition or the resolution rules change. */
export const MODEL_IDENTITY_SCHEMA_VERSION = 'model-identity-2026-10-08';

/** Explicit alias status stored on every scoring/usage fact. */
export const ALIAS_STATUSES = Object.freeze(['matched', 'unmatched']);

/**
 * Why an alias did or did not resolve. A reason is for coverage reporting and
 * tests only; it never feeds scoring.
 */
export const ALIAS_REASONS = Object.freeze([
  'exact-match',
  'exact-variant-neutral',
  'no-exact-alias',
  'conflicting-alias',
  'missing-identity',
]);

const ALIAS_STATUS_SET = new Set(ALIAS_STATUSES);

/** NUL separator: a key part can never contain it, so parts cannot bleed. */
const KEY_SEPARATOR = '\u0000';

/**
 * Declared aliases backed by a catalog file in this repository. The external id
 * equals the Codex CLI model id and the endpoint is the OpenAI API base; each
 * row records the file that verifies the id so a future maintainer can re-check
 * it. Stage 3/4 extends this table (OpenRouter endpoint rows, catalog price
 * sources) through {@link buildModelIdentityIndex} rather than by rewriting the
 * schema.
 *
 * `variantNeutral` is true because Codex passes effort through
 * `modelReasoningEffort`, not through the model id (see `lib/codex/codex-models.js`).
 *
 * @type {Readonly<ModelIdentityAliasRow[]>}
 */
export const DEFAULT_MODEL_IDENTITY_ALIASES = Object.freeze([
  Object.freeze({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'gpt-5.6-sol',
    evidence: 'lib/codex/codex-models.js',
  }),
  Object.freeze({
    harness: 'codex',
    model: 'gpt-6.1-sol',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'gpt-6.1-sol',
    evidence: 'lib/codex/codex-models.js',
  }),
  Object.freeze({
    harness: 'codex',
    model: 'gpt-5.6-terra',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'gpt-5.6-terra',
    evidence: 'lib/codex/codex-models.js',
  }),
  Object.freeze({
    harness: 'codex',
    model: 'gpt-5.6-luna',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'gpt-5.6-luna',
    evidence: 'lib/codex/codex-models.js',
  }),
  Object.freeze({
    harness: 'codex',
    model: 'gpt-6-astra',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'gpt-6-astra',
    evidence: 'lib/codex/codex-models.js',
  }),
  Object.freeze({
    harness: 'codex',
    model: 'gpt-5.3-codex',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'gpt-5.3-codex',
    evidence: 'lib/model-catalog.js (gpt-5.3-codex)',
  }),
]);

/**
 * Trimmed, lower-cased key part. `null`/`undefined` become the empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeIdentityPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAliasStatus(value) {
  return ALIAS_STATUS_SET.has(String(value ?? '').trim().toLowerCase());
}

/**
 * Composed key of one exact `(harness, model, variant)` pair.
 *
 * @param {unknown} harness
 * @param {unknown} model
 * @param {unknown} [variant]
 * @returns {string}
 */
export function modelIdentityKey(harness, model, variant = '') {
  return [
    normalizeIdentityPart(harness),
    normalizeIdentityPart(model),
    normalizeIdentityPart(variant),
  ].join(KEY_SEPARATOR);
}

/**
 * Harness+model key used by declared variant-neutral rows.
 *
 * @param {unknown} harness
 * @param {unknown} model
 * @returns {string}
 */
function modelIdentityNeutralKey(harness, model) {
  return [normalizeIdentityPart(harness), normalizeIdentityPart(model)].join(KEY_SEPARATOR);
}

/**
 * @param {unknown} raw
 * @returns {ModelIdentityAliasRow | null}
 */
function normalizeAliasRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const harness = normalizeIdentityPart(row.harness);
  const model = normalizeIdentityPart(row.model);
  const provider = normalizeIdentityPart(row.provider);
  const endpoint = String(row.endpoint ?? '').trim();
  const externalModelId = String(row.externalModelId ?? '').trim();
  if (!harness || !model || !provider || !endpoint || !externalModelId) return null;
  return {
    harness,
    model,
    variant: normalizeIdentityPart(row.variant),
    variantNeutral: row.variantNeutral === true,
    provider,
    endpoint,
    externalModelId,
    evidence: String(row.evidence ?? '').trim(),
  };
}

/**
 * @param {ModelIdentityAliasRow} a
 * @param {ModelIdentityAliasRow} b
 * @returns {boolean}
 */
function sameMapping(a, b) {
  return a.provider === b.provider
    && a.endpoint === b.endpoint
    && a.externalModelId === b.externalModelId;
}

/**
 * @param {Map<string, ModelIdentityAliasRow[]>} map
 * @param {string} key
 * @param {ModelIdentityAliasRow} row
 */
function addMapping(map, key, row) {
  const list = map.get(key);
  if (!list) {
    map.set(key, [row]);
    return;
  }
  if (list.some((existing) => sameMapping(existing, row))) return;
  list.push(row);
}

/**
 * @param {unknown} mappings
 * @returns {Array<{ provider: string, endpoint: string, externalModelId: string }>}
 */
function describeConflicts(mappings) {
  return (Array.isArray(mappings) ? mappings : []).map((row) => ({
    provider: row.provider,
    endpoint: row.endpoint,
    externalModelId: row.externalModelId,
  }));
}

/**
 * One resolution from a key hit.
 *
 * @param {Map<string, ModelIdentityAliasRow[]>} map
 * @param {string} key
 * @returns {ModelIdentityAliasRow | 'conflict' | null}
 */
function lookupMapping(map, key) {
  const list = map.get(key);
  if (!list || list.length === 0) return null;
  if (list.length === 1) return list[0];
  return 'conflict';
}

/**
 * Build a lookup index from declared rows. Rows missing a required field are
 * dropped (an incomplete row grants no identity). Duplicate rows with the same
 * mapping collapse; different mappings for one key stay and surface as a
 * conflict at resolve time.
 *
 * @param {ModelIdentityAliasRow[]} [rows]
 * @returns {{
 *   schemaVersion: string,
 *   rows: ModelIdentityAliasRow[],
 *   resolve: (input?: Record<string, unknown>) => ModelIdentityResolution,
 * }}
 */
export function buildModelIdentityIndex(rows = DEFAULT_MODEL_IDENTITY_ALIASES) {
  /** @type {ModelIdentityAliasRow[]} */
  const normalized = [];
  /** @type {Map<string, ModelIdentityAliasRow[]>} */
  const exact = new Map();
  /** @type {Map<string, ModelIdentityAliasRow[]>} */
  const neutral = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeAliasRow(raw);
    if (!row) continue;
    normalized.push(row);
    addMapping(exact, modelIdentityKey(row.harness, row.model, row.variant), row);
    if (row.variantNeutral) addMapping(neutral, modelIdentityNeutralKey(row.harness, row.model), row);
  }

  /**
   * @param {Record<string, unknown>} [input]
   * @returns {ModelIdentityResolution}
   */
  function resolve(input = {}) {
    const harness = normalizeIdentityPart(input.harness);
    const model = normalizeIdentityPart(input.model);
    const variant = normalizeIdentityPart(input.variant);
    const identityKey = modelIdentityKey(harness, model, variant);
    if (!harness || !model) {
      return {
        aliasStatus: 'unmatched',
        aliasReason: 'missing-identity',
        harness,
        model,
        variant,
        identityKey,
        provider: null,
        endpoint: null,
        externalModelId: null,
        conflicts: [],
      };
    }

    const exactHit = lookupMapping(exact, identityKey);
    if (exactHit === 'conflict') {
      return {
        aliasStatus: 'unmatched',
        aliasReason: 'conflicting-alias',
        harness,
        model,
        variant,
        identityKey,
        provider: null,
        endpoint: null,
        externalModelId: null,
        conflicts: describeConflicts(exact.get(identityKey)),
      };
    }
    if (exactHit) {
      return {
        aliasStatus: 'matched',
        aliasReason: 'exact-match',
        harness,
        model,
        variant,
        identityKey,
        provider: exactHit.provider,
        endpoint: exactHit.endpoint,
        externalModelId: exactHit.externalModelId,
        conflicts: [],
      };
    }

    const neutralKey = modelIdentityNeutralKey(harness, model);
    const neutralHit = lookupMapping(neutral, neutralKey);
    if (neutralHit === 'conflict') {
      return {
        aliasStatus: 'unmatched',
        aliasReason: 'conflicting-alias',
        harness,
        model,
        variant,
        identityKey,
        provider: null,
        endpoint: null,
        externalModelId: null,
        conflicts: describeConflicts(neutral.get(neutralKey)),
      };
    }
    if (neutralHit) {
      return {
        aliasStatus: 'matched',
        aliasReason: 'exact-variant-neutral',
        harness,
        model,
        variant,
        identityKey,
        provider: neutralHit.provider,
        endpoint: neutralHit.endpoint,
        externalModelId: neutralHit.externalModelId,
        conflicts: [],
      };
    }
    return {
      aliasStatus: 'unmatched',
      aliasReason: 'no-exact-alias',
      harness,
      model,
      variant,
      identityKey,
      provider: null,
      endpoint: null,
      externalModelId: null,
      conflicts: [],
    };
  }

  return {
    schemaVersion: MODEL_IDENTITY_SCHEMA_VERSION,
    rows: normalized,
    resolve,
  };
}

/** @type {ReturnType<typeof buildModelIdentityIndex> | null} */
let defaultIndex = null;

/**
 * @returns {ReturnType<typeof buildModelIdentityIndex>}
 */
export function defaultModelIdentityIndex() {
  if (!defaultIndex) defaultIndex = buildModelIdentityIndex(DEFAULT_MODEL_IDENTITY_ALIASES);
  return defaultIndex;
}

/**
 * Resolve one exact pair against declared aliases. `options.aliases` or
 * `options.index` allow a caller (stage 3/4) to supply an extended table; the
 * default table is used otherwise.
 *
 * @param {{
 *   harness?: unknown,
 *   model?: unknown,
 *   variant?: unknown,
 * }} [input]
 * @param {{
 *   aliases?: ModelIdentityAliasRow[],
 *   index?: ReturnType<typeof buildModelIdentityIndex>,
 * }} [options]
 * @returns {ModelIdentityResolution}
 */
export function resolveModelIdentity(input = {}, options = {}) {
  const index = options.index
    || (Array.isArray(options.aliases)
      ? buildModelIdentityIndex(options.aliases)
      : defaultModelIdentityIndex());
  return index.resolve(/** @type {Record<string, unknown>} */ (input));
}
