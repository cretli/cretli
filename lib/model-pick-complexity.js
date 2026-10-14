/**
 * Task complexity signal for `model_pick` (shadow only).
 *
 * The classifier turns a role, a leaf body and a little leaf history into a
 * coarse `level` plus a list of reason codes. The result is journaled and
 * returned in the pick response; it does not influence candidate selection.
 * Only closed-list codes leave this module: the leaf body is read in memory
 * and never persisted or echoed.
 */

import { LEAF_SIZE_LARGE, LEAF_SIZE_SMALL, listExistingFilePathsInLeafBody } from './model-pick-leaf-size.js';

/** @typedef {'trivial' | 'standard' | 'demanding'} ComplexityLevel */

export const COMPLEXITY_LEVELS = Object.freeze(['trivial', 'standard', 'demanding']);

/** Closed list of signal codes; anything else is dropped before it is stored. */
export const COMPLEXITY_SIGNALS = Object.freeze([
  'explicit_heavy',
  'explicit_level',
  'review_fail_history',
  'leaf_size_small',
  'leaf_size_large',
  'few_files',
  'many_files',
  'risk_keywords',
  'role_floor_standard',
  'no_leaf_context',
]);

/** Leaf body mentioning more files than this counts as `many_files`. */
export const COMPLEXITY_MANY_FILES = 6;

/** Review FAIL count at which a leaf is `demanding`. */
export const COMPLEXITY_REVIEW_FAIL_DEMANDING = 2;

const RISK_KEYWORD_PATTERN = /\b(security|auth(?:entication|orization)?|migration|migracja|schema|concurren\w*|race condition|encryption|secret|credential|data loss|breaking change|kontrakt|bezpiecze\w*)\b/i;

/**
 * @param {unknown} value
 * @returns {ComplexityLevel | ''}
 */
function normalizeLevel(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /** @type {ComplexityLevel | ''} */ (COMPLEXITY_LEVELS.includes(raw) ? raw : '');
}

/**
 * Keep only closed-list codes, de-duplicated, in the canonical list order.
 *
 * @param {unknown} signals
 * @returns {string[]}
 */
export function sanitizeComplexitySignals(signals) {
  const wanted = new Set(Array.isArray(signals) ? signals.map((s) => String(s || '').trim()) : []);
  return COMPLEXITY_SIGNALS.filter((code) => wanted.has(code));
}

/**
 * Normalize a stored/returned complexity block to `{ level, signals }` only.
 *
 * @param {unknown} input
 * @returns {{ level: ComplexityLevel, signals: string[] } | null}
 */
export function normalizeComplexity(input) {
  if (!input || typeof input !== 'object') return null;
  const level = normalizeLevel(/** @type {any} */ (input).level);
  if (!level) return null;
  return { level, signals: sanitizeComplexitySignals(/** @type {any} */ (input).signals) };
}

/**
 * @param {unknown} history
 * @returns {number}
 */
function readReviewFailCount(history) {
  const h = history && typeof history === 'object' ? /** @type {any} */ (history) : {};
  const raw = h.reviewFailCount ?? h.review_fail_count ?? h.leafReviewFails;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * @param {{
 *   role?: string,
 *   leafBody?: string,
 *   leafSize?: string | null,
 *   heavy?: boolean,
 *   complexity?: string,
 *   history?: object | null,
 *   sourceKind?: string,
 *   exists?: (relativePath: string) => boolean,
 * }} [input]
 * @returns {{ level: ComplexityLevel, signals: string[] }}
 */
export function classifyTaskComplexity(input = {}) {
  const role = String(input.role || '').trim().toLowerCase();
  const sourceKind = String(input.sourceKind || '').trim().toLowerCase();
  const body = String(input.leafBody || '');
  const leafSize = String(input.leafSize || '').trim().toLowerCase();
  /** @type {Set<string>} */
  const signals = new Set();
  const hasBody = body.trim().length > 0;
  if (!hasBody && !leafSize) signals.add('no_leaf_context');

  /** @type {number} 0 trivial, 1 standard, 2 demanding */
  let rank = hasBody || leafSize ? 0 : 1;
  const raise = (to) => { rank = Math.max(rank, to); };

  if (leafSize === LEAF_SIZE_LARGE) {
    signals.add('leaf_size_large');
    raise(1);
  } else if (leafSize === LEAF_SIZE_SMALL) {
    signals.add('leaf_size_small');
  }
  if (hasBody) {
    const files = listExistingFilePathsInLeafBody(body, { exists: input.exists }).length;
    if (files > COMPLEXITY_MANY_FILES) {
      signals.add('many_files');
      raise(2);
    } else if (files > 0) {
      signals.add('few_files');
    }
    if (RISK_KEYWORD_PATTERN.test(body)) {
      signals.add('risk_keywords');
      raise(1);
    }
  }
  if (readReviewFailCount(input.history) >= COMPLEXITY_REVIEW_FAIL_DEMANDING) {
    signals.add('review_fail_history');
    raise(2);
  }
  // Reviewing or planning code is never trivial work.
  if ((role === 'review' || role === 'plan' || sourceKind === 'plan') && rank < 1) {
    signals.add('role_floor_standard');
    raise(1);
  }
  if (input.heavy === true) {
    signals.add('explicit_heavy');
    raise(2);
  }
  // An explicit level (`complexity` parameter) overrides the heuristics.
  const explicit = normalizeLevel(input.complexity);
  let level = /** @type {ComplexityLevel} */ (COMPLEXITY_LEVELS[rank]);
  if (explicit) {
    signals.add('explicit_level');
    level = explicit;
  }
  return { level, signals: sanitizeComplexitySignals([...signals]) };
}
