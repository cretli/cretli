/**
 * Canonical model identity shared by reviewer matching, learned-pair
 * persistence and the session-resume config gate.
 *
 * A Claude moving alias (`sonnet`) must compare equal to the numbered id it
 * resolves to (`claude-sonnet-5-5`), so `claude/sonnet` and
 * `claude/claude-sonnet-5-5` are one reviewer, not two. Other harnesses keep a
 * plain case-insensitive comparison.
 */

import { canonicalizeClaudeModelId } from './claude/claude-models.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Model-id equality: Claude aliases equal the numbered id they resolve to.
 *
 * @param {string} transport
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameCanonicalModel(transport, a, b) {
  if (transport === 'claude') return canonicalizeClaudeModelId(a) === canonicalizeClaudeModelId(b);
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/**
 * Base model id with the `::params` suffix stripped and lower-cased. Effort
 * never makes a second reviewer.
 *
 * @param {unknown} model
 * @returns {string}
 */
export function baseModelId(model) {
  return text(model).split('::')[0].toLowerCase();
}

/**
 * Canonical base model id for one harness: effort is already stripped and a
 * Claude moving alias is mapped to the numbered id it resolves to, so two
 * aliases of one model produce the SAME string. Other harnesses keep the plain
 * lower-cased base id.
 *
 * @param {unknown} transport
 * @param {unknown} model
 * @returns {string}
 */
export function canonicalBaseModelId(transport, model) {
  const base = baseModelId(model);
  if (!base) return '';
  return text(transport).toLowerCase() === 'claude' ? canonicalizeClaudeModelId(base) : base;
}

/**
 * Stable reviewer identity key (`harness/canonical-model`). Two rows with the
 * same identity are one reviewer: an effort suffix and a Claude alias never
 * create a second one. Returns `''` when the harness or model is missing.
 *
 * @param {unknown} transport
 * @param {unknown} model
 * @returns {string}
 */
export function canonicalReviewerIdentity(transport, model) {
  const harness = text(transport).toLowerCase();
  const base = canonicalBaseModelId(harness, model);
  if (!harness || !base) return '';
  return `${harness}/${base}`;
}

/**
 * Same base model of the same harness, with Claude aliases canonicalized.
 *
 * @param {unknown} transport
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameCanonicalBaseModel(transport, a, b) {
  return sameCanonicalModel(text(transport).toLowerCase(), baseModelId(a), baseModelId(b));
}
