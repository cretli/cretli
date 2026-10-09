/**
 * Read-only inspector for the operator model-role config file
 * (`data/model-role-profiles.json`).
 *
 * The runtime loaders (`loadModelRoleProfiles`, `loadRoleScoreWeights`,
 * `loadRotationConfig`, `loadAdaptiveConfig`) deliberately swallow I/O and
 * parse errors and fall back to the built-in defaults, so an operator never
 * breaks picking by writing a bad file. That behavior stays unchanged; this
 * module is the diagnostic counterpart that *reports* the difference between
 * "no file", "valid file", and "unreadable/invalid file" without writing
 * anything and without changing what the picker loads.
 */

import fs from 'node:fs';
import { resolveDataPath } from './runtime-paths.js';
import {
  MODEL_PICK_ROLES,
  normalizeAdaptiveConfig,
  normalizeModelRoleProfiles,
  normalizeRoleScoreWeights,
  normalizeRotationConfig,
} from './model-role-profiles.js';

/** States a reader must distinguish; `invalid` is never silently `missing`. */
export const MODEL_ROLE_CONFIG_STATES = Object.freeze(['missing', 'valid', 'invalid']);

/**
 * Structural gate on top of JSON.parse: a valid config is an object, and every
 * known section that is present has the documented shape. Anything else is
 * reported as `invalid` instead of being normalized away.
 *
 * @param {object} parsed
 * @returns {string} empty when the document is structurally valid
 */
function validateModelRoleConfigShape(parsed) {
  if (Array.isArray(parsed)) return 'config root must be a JSON object';
  const roles = parsed.roles !== undefined ? parsed.roles : null;
  if (roles !== null && (typeof roles !== 'object' || Array.isArray(roles))) {
    return '"roles" must be an object';
  }
  if (roles) {
    for (const role of MODEL_PICK_ROLES) {
      if (!Object.prototype.hasOwnProperty.call(roles, role)) continue;
      if (!Array.isArray(roles[role])) return `roles.${role} must be an array`;
    }
  }
  if (parsed.rolesDelta !== undefined) {
    if (typeof parsed.rolesDelta !== 'object' || parsed.rolesDelta === null || Array.isArray(parsed.rolesDelta)) {
      return '"rolesDelta" must be an object';
    }
    for (const role of MODEL_PICK_ROLES) {
      if (!Object.prototype.hasOwnProperty.call(parsed.rolesDelta, role)) continue;
      const entry = parsed.rolesDelta[role];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return `rolesDelta.${role} must be an object`;
      }
      if (entry.set !== undefined
        && (typeof entry.set !== 'object' || entry.set === null || Array.isArray(entry.set))) {
        return `rolesDelta.${role}.set must be an object`;
      }
      if (entry.remove !== undefined && !Array.isArray(entry.remove)) {
        return `rolesDelta.${role}.remove must be an array`;
      }
    }
  }
  if (parsed.weights !== undefined && (typeof parsed.weights !== 'object' || Array.isArray(parsed.weights))) {
    return '"weights" must be an object';
  }
  if (parsed.rotation !== undefined
    && typeof parsed.rotation !== 'string'
    && (typeof parsed.rotation !== 'object' || parsed.rotation === null || Array.isArray(parsed.rotation))) {
    return '"rotation" must be a string or an object';
  }
  if (parsed.adaptive !== undefined
    && typeof parsed.adaptive !== 'boolean'
    && (typeof parsed.adaptive !== 'object' || parsed.adaptive === null || Array.isArray(parsed.adaptive))) {
    return '"adaptive" must be a boolean or an object';
  }
  return '';
}

/**
 * Inspect the operator config without applying it.
 *
 * @param {{
 *   filePath?: string,
 *   readFile?: (filePath: string) => string,
 * }} [input]
 * @returns {{
 *   path: string,
 *   state: 'missing' | 'valid' | 'invalid',
 *   error: string | null,
 *   bytes: number,
 *   roles: Record<string, { configured: boolean, matcherCount: number }> | null,
 *   delta: { roles: string[], set: number, remove: number } | null,
 *   weights: object | null,
 *   rotation: object | null,
 *   adaptive: object | null,
 *   matcherSources: { policy: number, operator: number } | null,
 * }}
 */
export function inspectModelRoleProfilesConfig(input = {}) {
  const path = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  const readFile = typeof input.readFile === 'function'
    ? input.readFile
    : (filePath) => fs.readFileSync(filePath, 'utf8');
  let raw = '';
  try {
    raw = String(readFile(path));
  } catch (err) {
    const code = err && typeof err === 'object' ? /** @type {{ code?: unknown }} */ (err).code : '';
    if (code === 'ENOENT') {
      return emptyInspection(path, 'missing', null);
    }
    return emptyInspection(path, 'invalid', errorMessage(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return emptyInspection(path, 'invalid', `invalid JSON: ${errorMessage(err)}`, raw.length);
  }
  if (!parsed || typeof parsed !== 'object') {
    return emptyInspection(path, 'invalid', 'config root must be a JSON object', raw.length);
  }
  const shapeError = validateModelRoleConfigShape(parsed);
  if (shapeError) return emptyInspection(path, 'invalid', shapeError, raw.length);

  // Only reached for a structurally valid document, so the normalizers cannot
  // throw here; they still only describe the file, they are not applied.
  const profiles = normalizeModelRoleProfiles(parsed);
  /** @type {Record<string, { configured: boolean, matcherCount: number }>} */
  const roles = {};
  let policyMatchers = 0;
  let operatorMatchers = 0;
  const rolesSection = parsed.roles && typeof parsed.roles === 'object' ? parsed.roles : null;
  for (const role of MODEL_PICK_ROLES) {
    const configured = Boolean(rolesSection && Object.prototype.hasOwnProperty.call(rolesSection, role));
    const matchers = profiles[/** @type {import('./model-role-profiles.js').ModelPickRole} */ (role)] || [];
    roles[role] = { configured, matcherCount: matchers.length };
    for (const matcher of matchers) {
      if (matcher.operator === true) operatorMatchers += 1;
      else policyMatchers += 1;
    }
  }
  return {
    path,
    state: 'valid',
    error: null,
    bytes: raw.length,
    roles,
    delta: summarizeRoleDelta(parsed.rolesDelta),
    weights: normalizeRoleScoreWeights(parsed),
    rotation: normalizeRotationConfig(parsed),
    adaptive: normalizeAdaptiveConfig(parsed),
    matcherSources: { policy: policyMatchers, operator: operatorMatchers },
  };
}

/**
 * Compact summary of the delta section: which roles carry one and how many
 * `set` / `remove` entries they hold. No matching is done here.
 *
 * @param {unknown} rawDelta
 * @returns {{ roles: string[], set: number, remove: number } | null}
 */
function summarizeRoleDelta(rawDelta) {
  if (!rawDelta || typeof rawDelta !== 'object' || Array.isArray(rawDelta)) return null;
  /** @type {string[]} */
  const roleList = [];
  let setCount = 0;
  let removeCount = 0;
  for (const role of MODEL_PICK_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(rawDelta, role)) continue;
    roleList.push(role);
    const entry = /** @type {{ set?: unknown, remove?: unknown }} */ (rawDelta[role]);
    if (entry && typeof entry.set === 'object' && entry.set !== null && !Array.isArray(entry.set)) {
      setCount += Object.keys(entry.set).length;
    }
    if (Array.isArray(entry?.remove)) removeCount += entry.remove.length;
  }
  if (roleList.length === 0) return null;
  return { roles: roleList, set: setCount, remove: removeCount };
}

/**
 * @param {string} path
 * @param {'missing' | 'invalid'} state
 * @param {string | null} error
 * @param {number} [bytes]
 * @returns {ReturnType<typeof inspectModelRoleProfilesConfig>}
 */
function emptyInspection(path, state, error, bytes = 0) {
  return {
    path,
    state,
    error,
    bytes,
    roles: null,
    delta: null,
    weights: null,
    rotation: null,
    adaptive: null,
    matcherSources: null,
  };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
