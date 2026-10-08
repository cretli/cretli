/**
 * Verified model alias/family policy — the single source of truth for reading a
 * model *name* out of a catalog id.
 *
 * Why this exists: role eligibility and catalog tiers used to be decided by raw
 * substrings (`hay.includes('sol')`, `/astra|sol|terra|opus|grok/`,
 * `/opus-4-[678]|max|terra|sol|luna|5\.6/`). A name fragment therefore granted
 * roles and tiers to any id that merely contained it, while a documented alias
 * written without that fragment (`gpt-5.6` **is** the Sol alias —
 * lib/codex/codex-models.js) matched nothing. Families are declared once here,
 * each alias pointing at the catalog row that verified it, and every consumer
 * (lib/model-role-profiles.js, lib/model-catalog-meta.js) resolves through it.
 *
 * ## Name boundaries
 * The haystack is the **base model id**: `::`-params are stripped first, so
 * `gpt-6-sol::effort=low` and `gpt-6-sol::effort=high` share one family and an
 * effort value can never smuggle a name match. Whitespace is folded to `-` and
 * everything is lower-cased. Separators are `-`, `_`, `.`, `/`, `:` and `,`. An
 * alias matches only when it starts on a separator boundary and is not followed
 * by a letter:
 *
 * - `sol` matches `gpt-5.6-sol`, `cretli/sol`, `sol-8b`; it never matches
 *   `resolution`, `solar`, `gpt-6-solomon`.
 * - `qwen` matches `qwen3.8-max` (a version digit is a legal right boundary).
 * - `flash` matches `glm-5.3-flash`; `glm-5.3-flashx` matches through the
 *   verified `flashx` alias instead, never by truncation.
 * - Multi-part aliases keep their own separators flexible, so `mimo-v2.6-pro`
 *   matches `cretli-mimo/mimo-v2.6-pro`.
 *
 * ## Whole-id aliases
 * An alias may be a full catalog id (`gpt-5.6`). Those are declared
 * `{ alias, mode: 'exact' }` and match the whole base id only, so `gpt-5.6`
 * resolves to Sol while `gpt-5.6-luna` still resolves to Luna.
 *
 * ## Operator override grammar (documented, stable)
 * A matcher pattern (built-in or `data/model-role-profiles.json`) accepts:
 *
 * | Form | Meaning |
 * | --- | --- |
 * | `sol` | verified family/alias with name boundaries (default) |
 * | `alias:sol` | the same, spelled out |
 * | `sub:sol` | explicit legacy substring — the operator asserts the fragment |
 * | `exact:gpt-5.6-sol` | the whole base id must equal this |
 * | `re:^gpt-6\\.` | explicit anchored regex (escape hatch) |
 * | `!sol` or `{ deny: true }` | revoke: a match removes the role, wins over any allow |
 *
 * Operator rules are honoured as written (that is the override), but the
 * **built-in** tables may only reference families marked `verified` here — an
 * unverified name never grants a role on its own.
 *
 * ## Variant and effort
 * Rules may narrow a match with `{ effort: ['low','medium'] }` (the decoded
 * `effort` / `reasoning_effort` param) and `{ variant: ['preview','pro'] }`
 * (a variant token in the name). Neither is required; unconstrained rules match
 * every variant, which is what the previous tables implied.
 *
 * ## Unknown-family fallback (documented)
 * An id whose family is not declared here gets `UNKNOWN_FAMILY_FALLBACK`: no
 * role from the alias policy (so it can never be picked autonomously), neutral
 * tier `3` for cost/quality/speed, and the rejection reason `unknown-family`.
 * It is a *neutral* fallback on purpose: neither a penalty nor a claim that the
 * model is weak. Grant eligibility with an operator rule or a new verified
 * family row (and bump `MODEL_ALIAS_POLICY_VERSION`).
 */

import { decodeModelValue } from './model-catalog.js';

/** Bump when a family, an alias or the fallback below changes. */
export const MODEL_ALIAS_POLICY_VERSION = 'alias-policy-2026-10-08';

/**
 * `automatic` is a machine choice (`model_pick`, Watcher, Scout) and applies the
 * full eligibility policy. `named` is a model the user named themselves: the
 * autonomous-only filters are lifted, while the adapter guarantees (review read
 * only / certification) keep applying at start time.
 */
export const MODEL_PICK_MODES = Object.freeze(['automatic', 'named']);

/** Family key reported for an id that no declared alias matches. */
export const UNKNOWN_MODEL_FAMILY = 'unknown';

/**
 * Documented fallback for an unknown family (see the header). `tier` is the
 * neutral 1..5 heuristic tier, never a price.
 */
export const UNKNOWN_FAMILY_FALLBACK = Object.freeze({
  family: UNKNOWN_MODEL_FAMILY,
  verified: false,
  roles: Object.freeze([]),
  tier: 3,
  reason: 'unknown-family',
});

/** Characters that start or end a name segment inside a catalog id. */
const SEPARATOR_CLASS = '\\-_.:/,';
const SEPARATOR_RUN = `[${SEPARATOR_CLASS}]+`;

/** Rule prefixes accepted by {@link compileModelNameRule}. */
const RULE_MODES = Object.freeze(['alias', 'sub', 'exact', 're']);

/**
 * @typedef {{ alias: string, mode?: 'alias' | 'exact' }} ModelAliasSpec
 * @typedef {{
 *   family: string,
 *   kind: 'family' | 'class',
 *   verified: boolean,
 *   provider: string | null,
 *   evidence: string,
 *   aliases: Array<string | ModelAliasSpec>,
 *   note?: string,
 * }} ModelAliasFamily
 * @typedef {{
 *   pattern: string,
 *   mode: 'alias' | 'sub' | 'exact' | 're',
 *   deny: boolean,
 *   priority: number,
 *   effort: string[],
 *   variant: string[],
 *   families: string[],
 *   declared: string | null,
 *   verified: boolean,
 *   operator: boolean,
 *   raw: string,
 * }} ModelNameRule
 */

/**
 * Declared families. `kind: 'family'` is a model line (Sol, Opus, GLM);
 * `kind: 'class'` is a cross-vendor tier token (flash, mini, max) that never
 * owns a provider. `verified` means the aliases below exist in a catalog this
 * repository ships or refreshes, so the family may grant a role.
 *
 * @type {Readonly<ModelAliasFamily[]>}
 */
export const MODEL_ALIAS_FAMILIES = Object.freeze([
  Object.freeze({
    family: 'sol',
    kind: 'family',
    verified: true,
    provider: 'openai',
    evidence: 'lib/codex/codex-models.js (gpt-5.6-sol, gpt-6.1-sol; the comment there states `gpt-5.6` is the Sol alias)',
    aliases: Object.freeze(['sol', Object.freeze({ alias: 'gpt-5.6', mode: 'exact' })]),
  }),
  Object.freeze({
    family: 'luna',
    kind: 'family',
    verified: true,
    provider: 'openai',
    evidence: 'lib/codex/codex-models.js (gpt-5.6-luna, also the Codex catalog probe model)',
    aliases: Object.freeze(['luna']),
  }),
  Object.freeze({
    family: 'astra',
    kind: 'family',
    verified: true,
    provider: 'openai',
    evidence: 'lib/codex/codex-models.js (gpt-6-astra)',
    aliases: Object.freeze(['astra']),
  }),
  Object.freeze({
    family: 'terra',
    kind: 'family',
    verified: true,
    provider: 'openai',
    evidence: 'lib/codex/codex-models.js (gpt-5.6-terra)',
    aliases: Object.freeze(['terra']),
  }),
  Object.freeze({
    family: 'codex',
    kind: 'family',
    verified: true,
    provider: 'openai',
    evidence: 'lib/model-catalog.js (gpt-5.3-codex), lib/codex/codex-models.js (gpt-5.3-codex-spark)',
    aliases: Object.freeze(['codex', 'gpt-5.3-codex']),
  }),
  Object.freeze({
    family: 'opus',
    kind: 'family',
    verified: true,
    provider: 'anthropic',
    evidence: 'lib/model-catalog.js (claude-opus-4-5/4-6/4-8)',
    aliases: Object.freeze(['opus']),
  }),
  Object.freeze({
    family: 'sonnet',
    kind: 'family',
    verified: true,
    provider: 'anthropic',
    evidence: 'lib/model-catalog.js (claude-sonnet-4-5/4-6)',
    aliases: Object.freeze(['sonnet']),
  }),
  Object.freeze({
    family: 'grok',
    kind: 'family',
    verified: true,
    provider: 'xai',
    evidence: 'lib/sdk/sdk-context-advisory.js (grok-4.6, grok-4.5), lib/model-catalog.js',
    aliases: Object.freeze(['grok']),
  }),
  Object.freeze({
    family: 'composer',
    kind: 'family',
    verified: true,
    provider: 'cursor',
    evidence: 'lib/model-catalog.js (composer-2, composer-2.5)',
    aliases: Object.freeze(['composer']),
  }),
  Object.freeze({
    family: 'glm',
    kind: 'family',
    verified: true,
    provider: 'zhipu',
    evidence: 'lib/opencode/opencode-model-resolve.js (glm-5.3-flashx)',
    aliases: Object.freeze(['glm']),
  }),
  Object.freeze({
    family: 'kimi',
    kind: 'family',
    verified: true,
    provider: 'moonshot',
    evidence: 'lib/model-catalog.js (kimi-k2.5)',
    aliases: Object.freeze(['kimi']),
  }),
  Object.freeze({
    family: 'qwen',
    kind: 'family',
    verified: true,
    provider: 'qwen',
    evidence: 'lib/qwen/qwen-models.js (qwen3.8-flash, qwen3.6-flash)',
    aliases: Object.freeze(['qwen']),
  }),
  Object.freeze({
    family: 'deepseek',
    kind: 'family',
    verified: true,
    provider: 'deepseek',
    evidence: 'lib/deepseek/deepseek-model-ids.js (deepseek-flash)',
    aliases: Object.freeze(['deepseek']),
  }),
  Object.freeze({
    family: 'mimo-pro',
    kind: 'family',
    verified: true,
    provider: 'other',
    evidence: 'lib/opencode/opencode-mimo-api-key.js (mimo-v2.6-pro)',
    aliases: Object.freeze(['mimo-v2.6-pro']),
  }),
  Object.freeze({
    family: 'hy3',
    kind: 'family',
    verified: true,
    provider: 'other',
    evidence: 'lib/codebuddy/codebuddy-models.js (hy3)',
    aliases: Object.freeze(['hy3']),
  }),
  Object.freeze({
    family: 'hy4',
    kind: 'family',
    verified: true,
    provider: 'other',
    evidence: 'lib/codebuddy/codebuddy-models.js (hy4-preview-f)',
    aliases: Object.freeze(['hy4']),
  }),
  Object.freeze({
    family: 'flash',
    kind: 'class',
    verified: true,
    provider: null,
    evidence: 'lib/model-catalog.js (gemini-*-flash), lib/qwen/qwen-models.js, lib/opencode/opencode-model-resolve.js (glm-5.3-flashx)',
    aliases: Object.freeze(['flash', 'flashx']),
    note: 'Short-lived fast tier: autonomous review skips it (quiet-stop / first-event timeout).',
  }),
  Object.freeze({
    family: 'mini',
    kind: 'class',
    verified: true,
    provider: null,
    evidence: 'lib/model-catalog.js (gpt-5-mini), lib/codex/codex-models.js (gpt-5.4-mini)',
    aliases: Object.freeze(['mini']),
  }),
  Object.freeze({
    family: 'nano',
    kind: 'class',
    verified: false,
    provider: null,
    evidence: 'lib/model-score-heuristics.js only (the tier row this replaces; no catalog row verifies this name)',
    aliases: Object.freeze(['nano']),
  }),
  Object.freeze({
    family: 'haiku',
    kind: 'class',
    verified: true,
    provider: 'anthropic',
    evidence: 'lib/claude/claude-models.js (claude-haiku-5-5), lib/chat-title-providers.js (claude-haiku-4-5-20251001)',
    aliases: Object.freeze(['haiku']),
  }),
  Object.freeze({
    family: 'max',
    kind: 'class',
    verified: true,
    provider: null,
    evidence: 'lib/qwen/qwen-models.js (qwen3.8-max)',
    aliases: Object.freeze(['max']),
  }),
  Object.freeze({
    family: 'pro',
    kind: 'class',
    verified: true,
    provider: null,
    evidence: 'lib/model-catalog.js (gemini-3.1-pro), lib/opencode/opencode-mimo-api-key.js (mimo-v2.6-pro)',
    aliases: Object.freeze(['pro']),
  }),
  // Declared tier rows that no shipped catalog verifies; they keep their tier
  // heuristics and must never grant a role by themselves.
  Object.freeze({
    family: 'fable',
    kind: 'family',
    verified: false,
    provider: null,
    evidence: 'lib/model-score-heuristics.js only (no catalog row verifies this name)',
    aliases: Object.freeze(['fable']),
  }),
  Object.freeze({
    family: 'mythos',
    kind: 'family',
    verified: false,
    provider: null,
    evidence: 'lib/model-score-heuristics.js only (no catalog row verifies this name)',
    aliases: Object.freeze(['mythos']),
  }),
]);

/** @type {Map<string, ModelAliasFamily>} */
const familyByAlias = new Map();
/** @type {Map<string, ModelAliasFamily>} */
const familyByKey = new Map();

for (const row of MODEL_ALIAS_FAMILIES) {
  familyByKey.set(row.family, row);
  for (const spec of row.aliases) {
    const alias = typeof spec === 'string' ? spec : spec.alias;
    if (!familyByAlias.has(alias)) familyByAlias.set(alias, row);
  }
}

/** @returns {Map<string, ModelAliasFamily>} alias → family row */
export function modelAliasFamilyIndex() {
  return familyByAlias;
}

/**
 * @param {string} familyKey
 * @returns {ModelAliasFamily | undefined}
 */
export function getModelAliasFamily(familyKey) {
  return familyByKey.get(String(familyKey || '').trim().toLowerCase());
}

/**
 * Lower-cased, whitespace-folded name haystack. `::`-params are stripped so a
 * variant value never decides a name match.
 *
 * @param {unknown} modelValue catalog id, stored value, or display name
 * @returns {string}
 */
export function normalizeModelNameHaystack(modelValue) {
  const raw = String(modelValue ?? '').trim().toLowerCase();
  if (!raw) return '';
  const base = decodeModelValue(raw).modelId || raw;
  return String(base).replace(/\s+/g, '-');
}

/**
 * @param {unknown} modelValue
 * @returns {string}
 */
function normalizeAliasToken(modelValue) {
  return String(modelValue ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @type {Map<string, RegExp | null>} */
const aliasRegexCache = new Map();

/**
 * Boundary-aligned regex for one alias. Separators inside the alias accept any
 * separator run; the alias may not start inside a word and may not be followed
 * by a letter (a version digit is a legal right boundary).
 *
 * @param {string} alias
 * @param {'alias' | 'exact'} mode
 * @returns {RegExp | null}
 */
function buildAliasRegex(alias, mode = 'alias') {
  const key = `${mode}:${alias}`;
  if (aliasRegexCache.has(key)) return aliasRegexCache.get(key) ?? null;
  const parts = alias.split(new RegExp(SEPARATOR_RUN, 'g')).filter(Boolean);
  if (parts.length === 0) {
    aliasRegexCache.set(key, null);
    return null;
  }
  const body = parts.map((part) => escapeRegex(part)).join(SEPARATOR_RUN);
  const regex = mode === 'exact'
    ? new RegExp(`^${body}$`)
    : new RegExp(`(?<![a-z0-9])${body}(?![a-z])`);
  aliasRegexCache.set(key, regex);
  return regex;
}

/**
 * @param {string} haystack normalized by {@link normalizeModelNameHaystack}
 * @param {string} alias
 * @param {'alias' | 'exact'} [mode]
 * @returns {boolean}
 */
function testAlias(haystack, alias, mode = 'alias') {
  if (!haystack || !alias) return false;
  if (mode === 'exact') {
    const regex = buildAliasRegex(alias, 'exact');
    return regex ? regex.test(haystack) : false;
  }
  const regex = buildAliasRegex(alias, 'alias');
  return regex ? regex.test(haystack) : false;
}

/**
 * Does this model id carry the given family/class alias?
 *
 * @param {unknown} modelValue
 * @param {string} familyKey a `family` key from {@link MODEL_ALIAS_FAMILIES}
 * @returns {boolean}
 */
export function matchesModelFamily(modelValue, familyKey) {
  const row = getModelAliasFamily(familyKey);
  if (!row) return false;
  const haystack = normalizeModelNameHaystack(modelValue);
  if (!haystack) return false;
  return row.aliases.some((spec) => {
    const alias = typeof spec === 'string' ? spec : spec.alias;
    const mode = typeof spec === 'string' ? 'alias' : (spec.mode || 'alias');
    return testAlias(haystack, alias, mode);
  });
}

/**
 * @param {unknown} modelValue
 * @param {Array<string | ModelAliasSpec>} aliases
 * @returns {string | null} the alias that matched, or null
 */
export function findMatchingAlias(modelValue, aliases) {
  const haystack = normalizeModelNameHaystack(modelValue);
  if (!haystack || !Array.isArray(aliases)) return null;
  for (const spec of aliases) {
    const alias = typeof spec === 'string' ? spec : spec.alias;
    const mode = typeof spec === 'string' ? 'alias' : (spec.mode || 'alias');
    if (testAlias(haystack, alias, mode)) return alias;
  }
  return null;
}

/**
 * Resolve the declared family of a catalog id. Exact whole-id aliases win over
 * a name alias so `gpt-5.6` is Sol while `gpt-5.6-luna` is Luna.
 *
 * @param {unknown} modelValue
 * @returns {{ family: string, kind: string, alias: string | null, mode: string, verified: boolean, provider: string | null }}
 */
export function resolveModelFamily(modelValue) {
  const haystack = normalizeModelNameHaystack(modelValue);
  if (!haystack) {
    return { ...UNKNOWN_FAMILY_FALLBACK, kind: 'none', alias: null, mode: 'none', provider: null };
  }
  /** @type {{ family: string, kind: string, alias: string, mode: string, verified: boolean, provider: string | null } | null} */
  let nameHit = null;
  for (const row of MODEL_ALIAS_FAMILIES) {
    for (const spec of row.aliases) {
      const alias = typeof spec === 'string' ? spec : spec.alias;
      const mode = typeof spec === 'string' ? 'alias' : (spec.mode || 'alias');
      if (!testAlias(haystack, alias, mode)) continue;
      if (mode === 'exact') {
        return { family: row.family, kind: row.kind, alias, mode, verified: row.verified, provider: row.provider };
      }
      if (!nameHit) {
        nameHit = { family: row.family, kind: row.kind, alias, mode, verified: row.verified, provider: row.provider };
      }
    }
  }
  if (nameHit) return nameHit;
  return {
    family: UNKNOWN_MODEL_FAMILY,
    kind: 'none',
    alias: null,
    mode: 'none',
    verified: false,
    provider: null,
  };
}

/**
 * Does the id belong to a cross-vendor tier class (flash, mini, max, ...)?
 *
 * @param {unknown} modelValue
 * @param {string} classKey
 * @returns {boolean}
 */
export function isModelNameClass(modelValue, classKey) {
  const row = getModelAliasFamily(classKey);
  return row?.kind === 'class' && matchesModelFamily(modelValue, classKey);
}

/**
 * Single-alias boundary test (no family expansion). The frozen score rows use
 * it so tier matching and role matching never disagree about what a name
 * boundary is: `astra` must not match `astronaut`, `sol` must not match
 * `resolution`, while `deepseek-flash` still covers `deepseek-v4.1-flash`.
 *
 * @param {unknown} modelValue
 * @param {string} alias
 * @returns {boolean}
 */
export function matchesModelAliasName(modelValue, alias) {
  const token = normalizeAliasToken(alias);
  if (!token) return false;
  return testAlias(normalizeModelNameHaystack(modelValue), token, 'alias');
}

/**
 * @param {unknown} modelValue
 * @returns {boolean} true when no declared alias matched the name
 */
export function isUnknownModelFamily(modelValue) {
  return resolveModelFamily(modelValue).family === UNKNOWN_MODEL_FAMILY;
}

/**
 * Compact identity tag for explanations and telemetry, e.g. `family=sol(verified)`
 * or `family=unknown(neutral fallback)`.
 *
 * @param {unknown} modelValue
 * @returns {string}
 */
export function describeModelFamilyMatch(modelValue) {
  const resolved = resolveModelFamily(modelValue);
  if (resolved.family === UNKNOWN_MODEL_FAMILY) {
    return `family=unknown(${UNKNOWN_FAMILY_FALLBACK.reason}: no role, neutral tier ${UNKNOWN_FAMILY_FALLBACK.tier})`;
  }
  return `family=${resolved.family}(${resolved.verified ? 'verified' : 'declared-unverified'} via ${resolved.mode === 'exact' ? `id:${resolved.alias}` : `alias:${resolved.alias}`})`;
}

/**
 * @param {unknown} modelValue
 * @returns {boolean} flash-class id (autonomous review skips these)
 */
export function isFlashModelFamily(modelValue) {
  return matchesModelFamily(modelValue, 'flash');
}

/**
 * Strip the documented rule prefixes from one matcher pattern.
 *
 * @param {unknown} raw a pattern string (`!sol`, `sub:sol`, `exact:gpt-5.6`)
 * @returns {{ body: string, mode: string, deny: boolean }}
 */
function parseRulePattern(raw) {
  let body = String(raw ?? '').trim().toLowerCase();
  let deny = false;
  let mode = '';
  if (body.startsWith('!')) {
    deny = true;
    body = body.slice(1).trim();
  }
  for (const prefix of ['alias:', 'sub:', 'exact:', 're:']) {
    if (!body.startsWith(prefix)) continue;
    mode = prefix.slice(0, -1);
    body = body.slice(prefix.length).trim();
    break;
  }
  return { body, mode, deny };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => normalizeAliasToken(row)).filter(Boolean);
}

/**
 * Compile one matcher row into a rule. Accepts `{ pattern }` (the shape stored
 * in `data/model-role-profiles.json`), `{ alias }`, `{ family }`, and the
 * optional `{ mode, deny, effort, variant }` narrowing fields.
 *
 * Verification is part of the compiled rule:
 * - a pattern naming a declared family inherits that family's `verified` flag;
 * - an undeclared pattern grants nothing **unless** the row is an explicit
 *   operator assertion (`operator: true`), which is the documented override;
 * - `sub:` / `exact:` / `re:` rows are explicit operator forms and count as
 *   asserted only when the row itself carries `operator: true`.
 *
 * @param {unknown} raw
 * @param {number} [fallbackPriority]
 * @returns {ModelNameRule | null}
 */
export function compileModelNameRule(raw, fallbackPriority = 0) {
  const declared = raw && typeof raw === 'object' ? raw : { pattern: raw };
  const parsed = parseRulePattern(declared.pattern ?? declared.alias ?? declared.family ?? '');
  if (!parsed.body) return null;
  const operatorAsserted = declared.operator === true;
  const requestedMode = normalizeAliasToken(declared.mode || parsed.mode) || 'alias';
  const mode = RULE_MODES.includes(requestedMode) ? requestedMode : 'alias';
  const priority = Number(declared.priority);
  const familyRow = mode === 'alias'
    ? getModelAliasFamily(parsed.body) || familyByAlias.get(parsed.body) || null
    : null;
  const families = familyRow ? [familyRow.family] : (operatorAsserted ? [parsed.body] : []);
  const verified = mode === 'alias'
    ? (familyRow ? familyRow.verified === true : operatorAsserted)
    : operatorAsserted;
  return {
    pattern: parsed.body,
    mode: /** @type {'alias' | 'sub' | 'exact' | 're'} */ (mode),
    deny: declared.deny === true ? true : parsed.deny,
    priority: Number.isFinite(priority) ? priority : fallbackPriority,
    effort: normalizeStringList(declared.effort),
    variant: normalizeStringList(declared.variant),
    families,
    declared: familyRow ? familyRow.family : null,
    verified,
    operator: operatorAsserted,
    raw: parsed.body,
  };
}

/**
 * @param {ModelNameRule} rule
 * @param {string} haystack
 * @returns {boolean}
 */
function ruleNameMatches(rule, haystack) {
  if (!haystack) return false;
  if (rule.mode === 'sub') return haystack.includes(rule.pattern);
  if (rule.mode === 'exact') return testAlias(haystack, rule.pattern, 'exact');
  if (rule.mode === 're') {
    try {
      return new RegExp(rule.pattern).test(haystack);
    } catch {
      return false;
    }
  }
  const family = getModelAliasFamily(rule.pattern) || familyByAlias.get(rule.pattern);
  if (family) {
    return family.aliases.some((spec) => {
      const alias = typeof spec === 'string' ? spec : spec.alias;
      const mode = typeof spec === 'string' ? 'alias' : (spec.mode || 'alias');
      return testAlias(haystack, alias, mode);
    });
  }
  return testAlias(haystack, rule.pattern, 'alias');
}

/**
 * @param {ModelNameRule} rule
 * @param {{ params?: Array<{ id?: string, value?: string }> }} decoded
 * @returns {boolean}
 */
function ruleEffortMatches(rule, decoded) {
  if (rule.effort.length === 0) return true;
  const params = Array.isArray(decoded?.params) ? decoded.params : [];
  for (const param of params) {
    const id = normalizeAliasToken(param?.id).replace(/-/g, '_');
    if (id !== 'effort' && id !== 'reasoning_effort') continue;
    const value = normalizeAliasToken(param?.value);
    if (rule.effort.includes(value)) return true;
  }
  return false;
}

/**
 * @param {ModelNameRule} rule
 * @param {string} haystack
 * @returns {boolean}
 */
function ruleVariantMatches(rule, haystack) {
  if (rule.variant.length === 0) return true;
  return rule.variant.some((variant) => testAlias(haystack, variant, 'alias'));
}

/**
 * Full rule evaluation: name boundary, then the optional variant/effort gates.
 * `deny` is returned so the caller keeps the revoke semantics (a deny match
 * wins over any allow), never as a silent priority number.
 *
 * @param {ModelNameRule} rule
 * @param {unknown} modelValue
 * @returns {boolean}
 */
export function matchesModelNameRule(rule, modelValue) {
  if (!rule || typeof rule !== 'object') return false;
  const haystack = normalizeModelNameHaystack(modelValue);
  if (!ruleNameMatches(rule, haystack)) return false;
  if (!ruleVariantMatches(rule, haystack)) return false;
  return ruleEffortMatches(rule, decodeModelValue(String(modelValue ?? '').trim()));
}

/**
 * @param {unknown[]} rawMatchers
 * @returns {ModelNameRule[]}
 */
export function compileModelNameRules(rawMatchers) {
  if (!Array.isArray(rawMatchers)) return [];
  /** @type {ModelNameRule[]} */
  const rules = [];
  rawMatchers.forEach((row, index) => {
    const rule = compileModelNameRule(row, index);
    if (rule) rules.push(rule);
  });
  return rules;
}

/**
 * Family keys a rule resolves to (built-in rules name verified families;
 * operator rules may name anything and resolve to themselves).
 *
 * @param {ModelNameRule} rule
 * @returns {string[]}
 */
export function modelRuleFamilies(rule) {
  if (!rule) return [];
  if (rule.families.length > 0) return [...rule.families];
  return [rule.pattern];
}
