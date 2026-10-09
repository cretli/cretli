/**
 * Audited operator store for the model-role config (`data/model-role-profiles.json`).
 *
 * Settings → Harness uses this module to read, diff, write and reset the
 * operator role config without ever silently repairing it. The runtime loaders
 * (`lib/model-role-profiles.js`) keep their forgiving fallback behavior; this
 * store is the strict counterpart:
 *
 * - a **missing** file is a valid starting point (built-in defaults);
 * - an **invalid** file is reported and never overwritten by a delta write — the
 *   operator must run the explicit reset (which first copies a backup);
 * - writes are atomic (`writeJsonAtomic`) and guarded by a content hash
 *   (`ETag` / `If-Match`), so a concurrent edit surfaces as a conflict instead
 *   of a silent lost update;
 * - unknown top-level keys and unknown/advanced matcher rows are preserved
 *   verbatim; only verified alias rows are editable;
 * - legacy full-list role overrides are migrated to the delta form while the
 *   effective matcher list stays identical.
 *
 * The persisted delta lives under the top-level `rolesDelta` section and is
 * applied by `normalizeModelRoleProfiles` (see the header of
 * `lib/model-role-profiles.js` for the precedence contract).
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeJsonAtomic, writeTextAtomic } from './persist/atomic-write.js';
import { resolveDataPath } from './runtime-paths.js';
import { inspectModelRoleProfilesConfig } from './model-config-inspect.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_MODEL_ROLE_PROFILES,
  DEFAULT_ROLE_SCORE_WEIGHTS,
  DEFAULT_ROTATION_CONFIG,
  MODEL_PICK_ROLES,
  MODEL_ROLE_DELTA_SECTION,
  ROTATION_MODES,
  normalizeAdaptiveConfig,
  normalizeModelRoleProfiles,
  normalizeRoleScoreWeights,
  normalizeRotationConfig,
} from './model-role-profiles.js';
import { compileModelNameRule, isVerifiedModelAliasRule } from './model-alias-policy.js';
import { MODEL_PICK_EXPLORE_CONFIG_DEFAULTS, normalizeModelPickExploreConfig } from './model-pick-policy.js';

/** Top-level keys the store understands; everything else is preserved as-is. */
export const MODEL_ROLE_CONFIG_KNOWN_TOP_LEVEL_KEYS = Object.freeze([
  'roles',
  MODEL_ROLE_DELTA_SECTION,
  'weights',
  'rotation',
  'adaptive',
  'delegation',
  'explore',
]);

/** Known matcher-row fields; anything else makes the row read-only. */
const KNOWN_MATCHER_FIELDS = new Set([
  'pattern', 'family', 'priority', 'operator', 'mode', 'deny', 'variant', 'effort',
]);

/** Request delta sections accepted by the write route. */
const DELTA_SECTIONS = new Set(['roles', 'weights', 'rotation', 'adaptive']);

/**
 * Error the store throws for operator input it refuses (bad delta / read-only
 * role / invalid reset precondition). The route maps `code` to an HTTP status.
 */
export class ModelRoleConfigError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ModelRoleConfigError';
    this.code = code;
  }
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {string}
 */
export function resolveModelRoleConfigPath(input = {}) {
  return String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
}

/**
 * Content hash of the raw file (or of a stable marker when the file is
 * missing). This is the value carried in `If-Match`; comparing raw bytes means
 * any operator edit — including one this store would normalise away — is a
 * conflict.
 *
 * @param {string | null | undefined} rawText
 * @returns {string}
 */
export function computeModelRoleConfigEtag(rawText) {
  const basis = rawText == null ? 'model-role-profiles:missing' : String(rawText);
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

/**
 * Read the raw file and parse it. Non-JSON content is `invalid` with the raw
 * text kept for the backup.
 *
 * @param {string} filePath
 * @returns {{ state: 'missing' | 'valid' | 'invalid', rawText: string | null, document: object | null }}
 */
function readRawDocument(filePath) {
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT') {
      return { state: 'missing', rawText: null, document: null };
    }
    return { state: 'invalid', rawText: null, document: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { state: 'invalid', rawText, document: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', rawText, document: null };
  }
  return { state: 'valid', rawText, document: parsed };
}

/**
 * Full snapshot of the operator config: structure state, effective values,
 * the editable view, and the content ETag.
 *
 * @param {{ filePath?: string }} [input]
 * @returns {{
 *   path: string,
 *   state: 'missing' | 'valid' | 'invalid',
 *   error: string | null,
 *   etag: string,
 *   document: object | null,
 *   roles: Record<string, object[]>,
 *   editable: Record<string, object>,
 *   weights: object,
 *   rotation: object,
 *   adaptive: object,
 *   explore: object,
 *   defaultExplore: object,
 *   unknownTopLevelKeys: string[],
 * }}
 */
export function readModelRoleConfig(input = {}) {
  const filePath = resolveModelRoleConfigPath(input);
  const inspection = inspectModelRoleProfilesConfig({ filePath });
  const raw = readRawDocument(filePath);
  const document = raw.document;
  return {
    path: filePath,
    state: inspection.state,
    error: inspection.error,
    etag: computeModelRoleConfigEtag(raw.rawText),
    document,
    roles: document ? normalizeModelRoleProfiles(document) : DEFAULT_MODEL_ROLE_PROFILES,
    editable: buildEditableRoleView(document, document ? normalizeModelRoleProfiles(document) : DEFAULT_MODEL_ROLE_PROFILES),
    weights: document ? normalizeRoleScoreWeights(document) : DEFAULT_ROLE_SCORE_WEIGHTS,
    rotation: document ? normalizeRotationConfig(document) : DEFAULT_ROTATION_CONFIG,
    adaptive: document ? normalizeAdaptiveConfig(document) : DEFAULT_ADAPTIVE_CONFIG,
    // `explore` is a real section of this document; this leaf exposes it
    // read-only and preserves it. Editing it is a separate (later) task.
    explore: document ? normalizeModelPickExploreConfig(document) : MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
    defaultExplore: MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
    unknownTopLevelKeys: listUnknownTopLevelKeys(document),
  };
}

/**
 * @param {unknown} document
 * @returns {string[]}
 */
export function listUnknownTopLevelKeys(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return [];
  return Object.keys(document)
    .filter((key) => !MODEL_ROLE_CONFIG_KNOWN_TOP_LEVEL_KEYS.includes(key))
    .sort();
}

/**
 * Canonical key for a matcher row. Mirrors `matcherDeltaKey` in
 * `lib/model-role-profiles.js`: a leading `!` and `alias:` are stripped, an
 * explicit `sub:` / `exact:` / `re:` mode keeps its prefix.
 *
 * @param {unknown} matcher
 * @returns {string}
 */
function matcherKey(matcher) {
  const raw = matcher && typeof matcher === 'object'
    ? String(matcher.pattern || matcher.family || '')
    : String(matcher ?? '');
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('!')) value = value.slice(1).trim();
  if (value.startsWith('alias:')) value = value.slice('alias:'.length).trim();
  return value;
}

/**
 * Classify one matcher row as editable or preserved. A row is editable only
 * when it is a plain alias / whole-id `exact` that resolves to a **verified**
 * family, has no `sub:` / `re:` / `deny` / `variant` / `effort` narrowing, and
 * carries no unknown fields. Everything else is read-only.
 *
 * @param {unknown} matcher normalized matcher row
 * @param {unknown} [rawMatcher] original row, when only it keeps unknown fields
 * @returns {{ editable: boolean, pattern: string, mode: string, deny: boolean, reason: string | null }}
 */
export function classifyRoleMatcher(matcher, rawMatcher) {
  const pattern = matcherKey(matcher);
  if (!pattern) return { editable: false, pattern: '', mode: 'alias', deny: false, reason: 'empty' };
  const compiled = compileModelNameRule(matcher);
  const mode = compiled ? compiled.mode : 'alias';
  const deny = compiled ? compiled.deny : false;
  if (deny) return { editable: false, pattern, mode, deny: true, reason: 'deny' };
  if (compiled && (compiled.variant.length > 0 || compiled.effort.length > 0)) {
    return { editable: false, pattern, mode, deny: false, reason: 'advanced' };
  }
  if (mode !== 'alias' && mode !== 'exact') {
    return { editable: false, pattern, mode, deny: false, reason: mode };
  }
  if (!compiled || !isVerifiedModelAliasRule(compiled.pattern, mode)) {
    return { editable: false, pattern, mode, deny: false, reason: 'unverified' };
  }
  if (hasUnknownMatcherFields(rawMatcher)) {
    return { editable: false, pattern, mode, deny: false, reason: 'extra-fields' };
  }
  return { editable: true, pattern, mode, deny: false, reason: null };
}

/**
 * @param {unknown} matcher
 * @returns {boolean}
 */
function hasUnknownMatcherFields(matcher) {
  if (!matcher || typeof matcher !== 'object') return false;
  return Object.keys(matcher).some((key) => !KNOWN_MATCHER_FIELDS.has(key));
}

/**
 * Index the raw operator rows by `role:key` so classification can still see
 * unknown fields that the normalizers drop.
 *
 * @param {object | null} document
 * @returns {Map<string, unknown>}
 */
function rawMatcherIndex(document) {
  /** @type {Map<string, unknown>} */
  const index = new Map();
  if (!document || typeof document !== 'object') return index;
  const legacyRoles = document.roles && typeof document.roles === 'object' && !Array.isArray(document.roles)
    ? document.roles
    : null;
  if (legacyRoles) {
    for (const role of MODEL_PICK_ROLES) {
      const rows = legacyRoles[role];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) index.set(`${role}:${matcherKey(row)}`, row);
    }
  }
  const delta = document[MODEL_ROLE_DELTA_SECTION];
  if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
    for (const role of MODEL_PICK_ROLES) {
      const entry = delta[role];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (entry.set && typeof entry.set === 'object' && !Array.isArray(entry.set)) {
        for (const key of Object.keys(entry.set)) {
          index.set(`${role}:${matcherKey(key)}`, { pattern: key, priority: entry.set[key]?.priority });
        }
      }
    }
  }
  return index;
}

/**
 * Editable per-role view for the UI: the effective editable rules, the policy
 * baseline, the preserved (read-only) rows and the `locked` flag.
 *
 * @param {object | null} document
 * @param {Record<string, object[]>} profiles
 * @returns {Record<string, object>}
 */
export function buildEditableRoleView(document, profiles) {
  const rawIndex = rawMatcherIndex(document);
  const legacyRoles = document && document.roles && typeof document.roles === 'object' && !Array.isArray(document.roles)
    ? document.roles
    : null;
  /** @type {Record<string, object>} */
  const view = {};
  for (const role of MODEL_PICK_ROLES) {
    const matchers = profiles[role] || [];
    /** @type {object[]} */
    const rules = [];
    /** @type {object[]} */
    const preserved = [];
    for (const matcher of matchers) {
      const key = matcherKey(matcher);
      const raw = rawIndex.get(`${role}:${key}`);
      const classification = classifyRoleMatcher(matcher, raw);
      if (classification.editable) {
        rules.push({
          pattern: classification.pattern,
          priority: Number.isFinite(Number(matcher.priority)) ? Number(matcher.priority) : 0,
          source: matcher.operator === true ? 'operator' : 'policy',
        });
      } else {
        preserved.push({
          pattern: classification.pattern,
          mode: classification.mode,
          deny: classification.deny,
          reason: classification.reason,
        });
      }
    }
    view[role] = {
      locked: preserved.length > 0,
      legacyOverride: Boolean(legacyRoles && Array.isArray(legacyRoles[role]) && legacyRoles[role].length > 0),
      policy: policyPatternsFor(role),
      policyRules: policyRulesFor(role),
      rules,
      preserved,
    };
  }
  return view;
}

/**
 * @param {string} role
 * @returns {string[]}
 */
function policyPatternsFor(role) {
  const rows = DEFAULT_MODEL_ROLE_PROFILES[/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role)] || [];
  return rows.map((row) => matcherKey(row)).filter(Boolean);
}

/**
 * The policy baseline with priorities, so the UI can restore an unchecked
 * policy rule without inventing a priority.
 *
 * @param {string} role
 * @returns {Array<{ pattern: string, priority: number }>}
 */
function policyRulesFor(role) {
  const rows = DEFAULT_MODEL_ROLE_PROFILES[/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role)] || [];
  return rows.map((row) => ({
    pattern: matcherKey(row),
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 0,
  })).filter((row) => row.pattern);
}

/**
 * @param {string} role
 * @param {string} pattern
 * @returns {number | null}
 */
function policyPriorityFor(role, pattern) {
  const rows = DEFAULT_MODEL_ROLE_PROFILES[/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role)] || [];
  for (const row of rows) {
    if (matcherKey(row) === pattern) return Number.isFinite(Number(row.priority)) ? Number(row.priority) : 0;
  }
  return null;
}

/**
 * Parse a delta pattern key. Only a plain alias or a whole-id `exact:` body is
 * accepted; a deny/sub/re pattern is rejected by the caller's verified check.
 *
 * @param {unknown} raw
 * @returns {{ mode: 'alias' | 'exact', body: string, key: string } | null}
 */
function parseDeltaPattern(raw) {
  let value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('!')) return null;
  let mode = 'alias';
  if (value.startsWith('alias:')) {
    value = value.slice('alias:'.length).trim();
  } else if (value.startsWith('exact:')) {
    mode = 'exact';
    value = value.slice('exact:'.length).trim();
  }
  if (!value) return null;
  return { mode: /** @type {'alias'|'exact'} */ (mode), body: value, key: mode === 'alias' ? value : `exact:${value}` };
}

/**
 * Validate and canonicalize a delta request. Throws {@link ModelRoleConfigError}
 * (`invalid-delta`, `role-locked`) on anything the editor must not write.
 *
 * @param {unknown} raw
 * @param {{ editable?: Record<string, { locked?: boolean }> }} [options]
 * @returns {object}
 */
export function normalizeModelRoleConfigDelta(raw, options = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelRoleConfigError('invalid-delta', 'delta must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!DELTA_SECTIONS.has(key)) throw new ModelRoleConfigError('invalid-delta', `unknown delta section "${key}"`);
  }
  /** @type {{ roles?: object, weights?: object, rotation?: object, adaptive?: object }} */
  const out = {};
  if (raw.roles !== undefined) {
    if (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles)) {
      throw new ModelRoleConfigError('invalid-delta', '"roles" must be an object');
    }
    /** @type {Record<string, object>} */
    const roles = {};
    for (const [role, entry] of Object.entries(raw.roles)) {
      if (!MODEL_PICK_ROLES.includes(/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role))) {
        throw new ModelRoleConfigError('invalid-delta', `unknown role "${role}"`);
      }
      if (options.editable?.[role]?.locked) {
        throw new ModelRoleConfigError('role-locked', `role "${role}" contains preserved matchers and is read-only`);
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ModelRoleConfigError('invalid-delta', `roles.${role} must be an object`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'set' && key !== 'remove') {
          throw new ModelRoleConfigError('invalid-delta', `roles.${role}.${key} is not supported`);
        }
      }
      /** @type {Record<string, { priority: number }>} */
      const set = {};
      const setKeys = new Set();
      if (entry.set !== undefined) {
        if (!entry.set || typeof entry.set !== 'object' || Array.isArray(entry.set)) {
          throw new ModelRoleConfigError('invalid-delta', `roles.${role}.set must be an object`);
        }
        for (const [rawKey, spec] of Object.entries(entry.set)) {
          const parsed = parseDeltaPattern(rawKey);
          if (!parsed || !isVerifiedModelAliasRule(parsed.body, parsed.mode)) {
            throw new ModelRoleConfigError('invalid-delta', `roles.${role}.set key "${rawKey}" is not a verified alias`);
          }
          if (setKeys.has(parsed.key)) {
            throw new ModelRoleConfigError('invalid-delta', `roles.${role}.set key "${parsed.key}" is duplicated`);
          }
          setKeys.add(parsed.key);
          const priority = Number(spec?.priority);
          if (spec !== null && typeof spec === 'object' && spec.priority !== undefined && !Number.isFinite(priority)) {
            throw new ModelRoleConfigError('invalid-delta', `roles.${role}.set.${parsed.key}.priority must be a number`);
          }
          set[parsed.key] = { priority: Number.isFinite(priority) ? priority : 0 };
        }
      }
      /** @type {string[]} */
      const remove = [];
      const removeKeys = new Set();
      if (entry.remove !== undefined) {
        if (!Array.isArray(entry.remove)) {
          throw new ModelRoleConfigError('invalid-delta', `roles.${role}.remove must be an array`);
        }
        for (const rawKey of entry.remove) {
          const parsed = parseDeltaPattern(rawKey);
          if (!parsed || !isVerifiedModelAliasRule(parsed.body, parsed.mode)) {
            throw new ModelRoleConfigError('invalid-delta', `roles.${role}.remove value "${rawKey}" is not a verified alias`);
          }
          if (removeKeys.has(parsed.key)) {
            throw new ModelRoleConfigError('invalid-delta', `roles.${role}.remove value "${parsed.key}" is duplicated`);
          }
          if (setKeys.has(parsed.key)) {
            throw new ModelRoleConfigError('invalid-delta', `roles.${role} cannot set and remove "${parsed.key}"`);
          }
          removeKeys.add(parsed.key);
          remove.push(parsed.key);
        }
      }
      const sortedSet = Object.fromEntries(Object.keys(set).sort().map((key) => [key, set[key]]));
      const canonical = {};
      if (Object.keys(sortedSet).length > 0) canonical.set = sortedSet;
      if (remove.length > 0) canonical.remove = remove.sort();
      if (Object.keys(canonical).length > 0) roles[role] = canonical;
    }
    if (Object.keys(roles).length > 0) out.roles = roles;
  }
  if (raw.weights !== undefined) {
    if (!raw.weights || typeof raw.weights !== 'object' || Array.isArray(raw.weights)) {
      throw new ModelRoleConfigError('invalid-delta', '"weights" must be an object');
    }
    /** @type {Record<string, object>} */
    const weights = {};
    for (const [role, row] of Object.entries(raw.weights)) {
      if (!MODEL_PICK_ROLES.includes(/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role))) {
        throw new ModelRoleConfigError('invalid-delta', `unknown weights role "${role}"`);
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new ModelRoleConfigError('invalid-delta', `weights.${role} must be an object`);
      }
      const axis = {};
      for (const key of Object.keys(row)) {
        if (!['cost', 'quality', 'speed'].includes(key)) {
          throw new ModelRoleConfigError('invalid-delta', `weights.${role}.${key} is not supported`);
        }
        const value = Number(row[key]);
        if (!Number.isFinite(value) || value < 0) {
          throw new ModelRoleConfigError('invalid-delta', `weights.${role}.${key} must be a non-negative number`);
        }
        axis[key] = value;
      }
      if (Object.keys(axis).length === 0) {
        throw new ModelRoleConfigError('invalid-delta', `weights.${role} must set at least one axis`);
      }
      weights[role] = axis;
    }
    out.weights = weights;
  }
  if (raw.rotation !== undefined) {
    const rotation = raw.rotation;
    if (!rotation || typeof rotation !== 'object' || Array.isArray(rotation)) {
      throw new ModelRoleConfigError('invalid-delta', '"rotation" must be an object');
    }
    const mode = String(rotation.mode ?? '').trim().toLowerCase();
    if (mode && !ROTATION_MODES.includes(/** @type {import('./model-role-profiles.js').ModelPickRotationMode} */ (mode))) {
      throw new ModelRoleConfigError('invalid-delta', 'rotation.mode must be off, balanced or explore');
    }
    const band = Number(rotation.band);
    if (rotation.band !== undefined && (!Number.isFinite(band) || band < 0)) {
      throw new ModelRoleConfigError('invalid-delta', 'rotation.band must be a non-negative number');
    }
    out.rotation = {
      mode: mode || DEFAULT_ROTATION_CONFIG.mode,
      band: Number.isFinite(band) ? band : DEFAULT_ROTATION_CONFIG.band,
    };
  }
  if (raw.adaptive !== undefined) {
    const adaptive = raw.adaptive;
    if (typeof adaptive === 'boolean') out.adaptive = { enabled: adaptive };
    else if (adaptive && typeof adaptive === 'object' && !Array.isArray(adaptive) && typeof adaptive.enabled === 'boolean') {
      out.adaptive = { enabled: adaptive.enabled };
    } else {
      throw new ModelRoleConfigError('invalid-delta', '"adaptive" must be a boolean or { enabled: boolean }');
    }
  }
  return out;
}

/**
 * Deep-clone a JSON document (data only, no functions/dates are expected).
 *
 * @param {unknown} value
 * @returns {any}
 */
function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Move flat `{ plan: [...] }` role keys under `roles` so both documented legacy
 * shapes are handled the same way.
 *
 * @param {object} doc
 * @returns {object | null}
 */
function collectLegacyRoles(doc) {
  if (doc.roles && typeof doc.roles === 'object' && !Array.isArray(doc.roles)) return doc.roles;
  /** @type {Record<string, unknown>} */
  const found = {};
  for (const role of MODEL_PICK_ROLES) {
    if (!Array.isArray(doc[role])) continue;
    found[role] = doc[role];
    delete doc[role];
  }
  if (Object.keys(found).length === 0) return null;
  doc.roles = found;
  return found;
}

/**
 * Convert every editable legacy full-list role override into an equivalent
 * delta entry, then drop the legacy key. The resulting effective list is
 * identical: `remove` covers the policy patterns the list omitted, `set` covers
 * the remaining patterns whose priority (or existence) is not the policy one.
 * A role whose list contains any preserved row is left untouched.
 *
 * @param {object} doc
 * @returns {void}
 */
function migrateLegacyRoleOverrides(doc) {
  const legacyRoles = collectLegacyRoles(doc);
  if (!legacyRoles) return;
  const section = doc[MODEL_ROLE_DELTA_SECTION] && typeof doc[MODEL_ROLE_DELTA_SECTION] === 'object'
    && !Array.isArray(doc[MODEL_ROLE_DELTA_SECTION])
    ? doc[MODEL_ROLE_DELTA_SECTION]
    : {};
  for (const role of MODEL_PICK_ROLES) {
    const rows = legacyRoles[role];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const classifications = rows.map((row) => classifyRoleMatcher(row, row));
    if (classifications.some((row) => !row.editable)) continue;
    /** @type {Map<string, number>} */
    const kept = new Map();
    rows.forEach((row, index) => {
      const key = matcherKey(row);
      if (!key) return;
      const priority = Number(row.priority);
      // Match `normalizeMatchers`: a missing priority falls back to the row
      // index, so migration keeps the exact same eligibility data.
      kept.set(key, Number.isFinite(priority) ? priority : index);
    });
    const policyKeys = policyPatternsFor(role);
    const remove = policyKeys.filter((key) => !kept.has(key));
    /** @type {Record<string, { priority: number }>} */
    const set = {};
    for (const key of [...kept.keys()].sort()) {
      const policyPriority = policyPriorityFor(role, key);
      if (policyPriority == null || policyPriority !== kept.get(key)) set[key] = { priority: kept.get(key) ?? 0 };
    }
    const entry = {};
    if (Object.keys(set).length > 0) entry.set = set;
    if (remove.length > 0) entry.remove = [...remove].sort();
    if (Object.keys(entry).length > 0) section[role] = entry;
    delete legacyRoles[role];
  }
  if (Object.keys(section).length > 0) doc[MODEL_ROLE_DELTA_SECTION] = section;
  else delete doc[MODEL_ROLE_DELTA_SECTION];
  if (Object.keys(legacyRoles).length === 0) delete doc.roles;
}

/**
 * Apply a validated delta to a raw document and return a new document. Unknown
 * top-level keys and preserved matcher rows are copied through untouched. The
 * input document is never mutated.
 *
 * @param {object | null} document
 * @param {object} delta canonical delta from {@link normalizeModelRoleConfigDelta}
 * @param {{ migrate?: boolean }} [options]
 * @returns {object}
 */
export function applyModelRoleDelta(document, delta, options = {}) {
  const doc = document && typeof document === 'object' && !Array.isArray(document) ? cloneJson(document) : {};
  if (options.migrate !== false) migrateLegacyRoleOverrides(doc);
  if (delta?.roles && typeof delta.roles === 'object') {
    const section = doc[MODEL_ROLE_DELTA_SECTION] && typeof doc[MODEL_ROLE_DELTA_SECTION] === 'object'
      && !Array.isArray(doc[MODEL_ROLE_DELTA_SECTION])
      ? doc[MODEL_ROLE_DELTA_SECTION]
      : {};
    for (const role of MODEL_PICK_ROLES) {
      if (!Object.prototype.hasOwnProperty.call(delta.roles, role)) continue;
      const incoming = delta.roles[role];
      const target = section[role] && typeof section[role] === 'object' && !Array.isArray(section[role])
        ? section[role]
        : {};
      /** @type {Record<string, { priority: number }>} */
      const set = { ...(target.set && typeof target.set === 'object' && !Array.isArray(target.set) ? target.set : {}) };
      const removals = new Set(Array.isArray(target.remove) ? target.remove.map((row) => matcherKey(row)).filter(Boolean) : []);
      for (const [key, spec] of Object.entries(incoming.set || {})) {
        const normalized = matcherKey(key);
        if (!normalized) continue;
        const priority = Number(spec?.priority);
        set[normalized] = { priority: Number.isFinite(priority) ? priority : 0 };
        removals.delete(normalized);
      }
      for (const key of incoming.remove || []) {
        const normalized = matcherKey(key);
        if (!normalized) continue;
        delete set[normalized];
        removals.add(normalized);
      }
      const entry = {};
      const setKeys = Object.keys(set).sort();
      if (setKeys.length > 0) entry.set = Object.fromEntries(setKeys.map((key) => [key, set[key]]));
      const removeKeys = [...removals].filter(Boolean).sort();
      if (removeKeys.length > 0) entry.remove = removeKeys;
      if (Object.keys(entry).length > 0) section[role] = entry;
      else delete section[role];
    }
    if (Object.keys(section).length > 0) doc[MODEL_ROLE_DELTA_SECTION] = section;
    else delete doc[MODEL_ROLE_DELTA_SECTION];
  }
  if (delta?.weights && typeof delta.weights === 'object') {
    const existing = doc.weights && typeof doc.weights === 'object' && !Array.isArray(doc.weights) ? doc.weights : {};
    for (const [role, row] of Object.entries(delta.weights)) {
      const current = existing[role] && typeof existing[role] === 'object' && !Array.isArray(existing[role]) ? existing[role] : {};
      existing[role] = { ...current, ...row };
    }
    doc.weights = existing;
  }
  if (delta?.rotation && typeof delta.rotation === 'object') {
    const existing = doc.rotation && typeof doc.rotation === 'object' && !Array.isArray(doc.rotation) ? doc.rotation : {};
    doc.rotation = { ...existing, ...delta.rotation };
  }
  if (delta?.adaptive && typeof delta.adaptive === 'object') {
    const existing = doc.adaptive && typeof doc.adaptive === 'object' && !Array.isArray(doc.adaptive) ? doc.adaptive : {};
    doc.adaptive = { ...existing, ...delta.adaptive };
  }
  return doc;
}

/**
 * @param {Record<string, object[]>} profiles
 * @returns {Map<string, number>}
 */
function editableRuleMap(profiles) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const matcher of profiles || []) {
    const classification = classifyRoleMatcher(matcher);
    if (!classification.editable) continue;
    map.set(classification.pattern, Number.isFinite(Number(matcher.priority)) ? Number(matcher.priority) : 0);
  }
  return map;
}

/**
 * Compute what a save would change: per-role matcher add/remove/priority
 * updates, plus weights/rotation/adaptive when they differ. The comparison is
 * against the state after applying the same delta, so a no-op delta yields
 * `changed: false`.
 *
 * @param {{
 *   current: ReturnType<typeof readModelRoleConfig>,
 *   delta: object,
 * }} input
 * @returns {{ changed: boolean, roles: object, weights: object | null, rotation: object | null, adaptive: object | null, blocked: boolean }}
 */
export function computeModelRoleConfigDiff(input) {
  const current = input.current;
  const nextDocument = applyModelRoleDelta(current.document, input.delta, { migrate: true });
  return diffEffective(current, nextDocument);
}

/**
 * Compare the current effective state with the effective state of a candidate
 * document. Shared by the delta preview and the reset preview.
 *
 * @param {ReturnType<typeof readModelRoleConfig>} current
 * @param {object} nextDocument
 * @returns {{ changed: boolean, roles: object, weights: object | null, rotation: object | null, adaptive: object | null, blocked: boolean }}
 */
function diffEffective(current, nextDocument) {
  const nextRoles = normalizeModelRoleProfiles(nextDocument);
  const nextWeights = normalizeRoleScoreWeights(nextDocument);
  const nextRotation = normalizeRotationConfig(nextDocument);
  const nextAdaptive = normalizeAdaptiveConfig(nextDocument);
  /** @type {Record<string, object>} */
  const roles = {};
  for (const role of MODEL_PICK_ROLES) {
    const before = editableRuleMap(current.roles?.[role]);
    const after = editableRuleMap(nextRoles[role]);
    /** @type {object[]} */
    const added = [];
    /** @type {object[]} */
    const removed = [];
    /** @type {object[]} */
    const updated = [];
    for (const [pattern, priority] of after) {
      if (!before.has(pattern)) added.push({ pattern, priority });
      else if (before.get(pattern) !== priority) updated.push({ pattern, from: before.get(pattern), to: priority });
    }
    for (const [pattern, priority] of before) {
      if (!after.has(pattern)) removed.push({ pattern, priority });
    }
    const byPattern = (left, right) => (left.pattern < right.pattern ? -1 : left.pattern > right.pattern ? 1 : 0);
    added.sort(byPattern);
    removed.sort(byPattern);
    updated.sort(byPattern);
    if (added.length === 0 && removed.length === 0 && updated.length === 0) continue;
    roles[role] = { added, removed, updated };
  }
  const weights = diffWeights(current.weights, nextWeights);
  const rotation = diffScalar(current.rotation, nextRotation);
  const adaptive = diffScalar(current.adaptive, nextAdaptive);
  return {
    changed: Object.keys(roles).length > 0 || Boolean(weights || rotation || adaptive),
    roles,
    weights,
    rotation,
    adaptive,
    blocked: current.state === 'invalid',
  };
}

/**
 * @param {Record<string, object>} before
 * @param {Record<string, object>} after
 * @returns {object | null}
 */
function diffWeights(before, after) {
  /** @type {Record<string, object>} */
  const changed = {};
  for (const role of MODEL_PICK_ROLES) {
    const left = before?.[role] || {};
    const right = after?.[role] || {};
    if (left.cost === right.cost && left.quality === right.quality && left.speed === right.speed) continue;
    changed[role] = { from: { ...left }, to: { ...right } };
  }
  return Object.keys(changed).length > 0 ? changed : null;
}

/**
 * @param {object} before
 * @param {object} after
 * @returns {{ from: object, to: object } | null}
 */
function diffScalar(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return { from: { ...before }, to: { ...after } };
}

/**
 * Compute a delta preview without writing anything.
 *
 * @param {{ filePath?: string, delta: object }} input
 * @returns {{ state: string, error: string | null, etag: string, blocked: boolean, diff: object }}
 */
export function previewModelRoleConfig(input) {
  const current = readModelRoleConfig({ filePath: input.filePath });
  const delta = normalizeModelRoleConfigDelta(input.delta, { editable: current.editable });
  const diff = computeModelRoleConfigDiff({ current, delta });
  return { state: current.state, error: current.error, etag: current.etag, blocked: current.state === 'invalid', diff };
}

/**
 * Write a delta atomically.
 *
 * @param {{
 *   filePath?: string,
 *   delta: object,
 *   ifMatch?: string | null,
 * }} input
 * @returns {{
 *   ok: true,
 *   state: string,
 *   etag: string,
 *   diff: object,
 * } | {
 *   ok: false,
 *   state: string,
 *   error: string | null,
 *   etag: string,
 *   conflict?: boolean,
 * }}
 */
export function writeModelRoleConfig(input) {
  const filePath = resolveModelRoleConfigPath(input);
  const current = readModelRoleConfig({ filePath });
  if (current.state === 'invalid') {
    return { ok: false, state: 'invalid', error: current.error, etag: current.etag };
  }
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'config changed on disk', etag: current.etag, conflict: true };
  }
  const delta = normalizeModelRoleConfigDelta(input.delta, { editable: current.editable });
  const diff = computeModelRoleConfigDiff({ current, delta });
  const nextDocument = applyModelRoleDelta(current.document, delta, { migrate: true });
  writeJsonAtomic(filePath, nextDocument);
  const next = readModelRoleConfig({ filePath });
  return { ok: true, state: next.state, etag: next.etag, diff };
}

/**
 * Reset the operator config to the built-in defaults, keeping a byte-exact
 * backup of whatever was on disk (valid or invalid). This is the only path that
 * may replace an invalid file.
 *
 * @param {{ filePath?: string, ifMatch?: string | null, now?: number }} input
 * @returns {{
 *   ok: true,
 *   state: string,
 *   etag: string,
 *   backupPath: string | null,
 *   diff: object,
 * } | {
 *   ok: false,
 *   state: string,
 *   error: string | null,
 *   etag: string,
 *   conflict?: boolean,
 * }}
 */
export function resetModelRoleConfig(input = {}) {
  const filePath = resolveModelRoleConfigPath(input);
  const current = readModelRoleConfig({ filePath });
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'config changed on disk', etag: current.etag, conflict: true };
  }
  // Reset replaces the document with `{}` (built-in defaults); the diff is
  // computed against that candidate, not against a synthetic delta.
  const diff = diffEffective(current, {});
  let backupPath = null;
  if (current.state !== 'missing' && typeof current.document !== 'undefined') {
    const raw = readRawDocument(filePath);
    if (raw.rawText != null) {
      const stamp = new Date(Number.isFinite(input.now) ? Number(input.now) : Date.now()).toISOString().replace(/[:.]/g, '-');
      backupPath = `${filePath}.bak-${stamp}`;
      writeTextAtomic(backupPath, raw.rawText);
    }
  }
  writeJsonAtomic(filePath, {});
  const next = readModelRoleConfig({ filePath });
  return { ok: true, state: next.state, etag: next.etag, backupPath, diff };
}

/**
 * @param {string} ifMatch
 * @param {string} etag
 * @returns {boolean}
 */
export function ifMatchMatches(ifMatch, etag) {
  const value = String(ifMatch || '').trim();
  if (!value || value === '*') return value === '*';
  return value.replace(/^W\//, '').replace(/^"|"$/g, '') === String(etag);
}
