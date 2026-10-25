/**
 * Deterministic selection of active review lessons for a delegation prompt.
 *
 * Pure (no I/O, no LLM): the caller lists the lessons from the store and passes
 * them in. Only `active` lessons of the requested audience are ever returned;
 * `candidate` and `retired` lessons are never injected.
 */

import { scoutGlobMatchesPath } from './workspace-scout-glob.js';

export const REVIEW_LESSONS_ENV = 'CRETLI_REVIEW_LESSONS';
/**
 * Optional per-audience switches. A master flag of off disables every audience;
 * otherwise an explicit audience value applies and an unset one falls back to
 * the rollout default (see isReviewLessonsEnabled).
 */
export const REVIEW_LESSONS_AUDIENCE_ENV = Object.freeze({
  implementer: 'CRETLI_REVIEW_LESSONS_IMPLEMENT',
  reviewer: 'CRETLI_REVIEW_LESSONS_REVIEW',
  planner: 'CRETLI_REVIEW_LESSONS_PLAN',
});

/** Modelled on WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET: the block is capped as a whole. */
export const REVIEW_LESSONS_PROMPT_CHAR_BUDGET = 1500;
export const REVIEW_LESSONS_PROMPT_MAX = 6;
/** Rendering overhead per lesson line (label, separators). */
const LESSON_LINE_OVERHEAD = 10;

/** Kinds that may be injected per audience. */
const AUDIENCE_KINDS = Object.freeze({
  implementer: ['do', 'avoid'],
  reviewer: ['suppress'],
  planner: ['do', 'avoid'],
});

const CATEGORY_KEYWORDS = Object.freeze({
  'missing-test': ['test', 'tests', 'coverage', 'regression'],
  'test-weak': ['test', 'assert', 'assertion', 'mock'],
  'docs-not-updated': ['docs', 'documentation', 'readme', 'changelog'],
  'caller-not-updated': ['caller', 'callers', 'rename', 'signature', 'refactor'],
  'contract-violation': ['contract', 'schema', 'api', 'interface', 'acceptance'],
  'error-handling': ['error', 'errors', 'catch', 'throw', 'fallback'],
  'concurrency-race': ['race', 'concurrent', 'lock', 'async', 'parallel'],
  security: ['security', 'auth', 'token', 'secret', 'permission'],
  i18n: ['i18n', 'translation', 'locale', 'label'],
  'style-convention': ['style', 'naming', 'lint', 'convention', 'comment'],
  'scope-creep': ['scope', 'unrelated'],
  perf: ['performance', 'perf', 'cache', 'slow'],
});

const FLAG_ON = ['1', 'true', 'on', 'yes'];
const FLAG_OFF = ['0', 'false', 'off', 'no'];

/**
 * Rollout defaults per audience when the flag is unset: implementers are on,
 * planners and reviewers (`suppress`) stay opt-in until evaluated.
 */
export const REVIEW_LESSONS_AUDIENCE_DEFAULT = Object.freeze({
  implementer: true,
  planner: false,
  reviewer: false,
});

/**
 * Resolution order: the master flag set to off disables every audience; an
 * explicit per-audience value wins next; an explicit truthy master enables every
 * audience; otherwise the rollout default of the audience applies.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} [audience]
 * @returns {boolean}
 */
export function isReviewLessonsEnabled(env = process.env, audience = '') {
  const read = (/** @type {any} */ key) => String(env?.[key] ?? '').trim().toLowerCase();
  const master = read(REVIEW_LESSONS_ENV);
  if (FLAG_OFF.includes(master)) return false;
  const key = /** @type {Record<string, any>} */ (REVIEW_LESSONS_AUDIENCE_ENV)[audience];
  if (!key) return FLAG_ON.includes(master);
  const own = read(key);
  if (FLAG_OFF.includes(own)) return false;
  if (FLAG_ON.includes(own) || FLAG_ON.includes(master)) return true;
  return /** @type {Record<string, any>} */ (REVIEW_LESSONS_AUDIENCE_DEFAULT)[audience] === true;
}

const PATH_TOKEN = /(?:^|[\s`'"([,])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+|[\w@-]+\.(?:js|mjs|cjs|ts|scss|css|md|json|html))(?=$|[\s`'"),:;\].])/g;

/**
 * @param {string} text
 * @returns {string[]} workspace-relative path-like tokens named in free text
 */
export function extractPathsFromText(text) {
  const out = new Set();
  for (const match of String(text || '').matchAll(PATH_TOKEN)) out.add(match[1]);
  return [...out];
}

function baseModel(/** @type {any} */ model) {
  return String(model || '').split('::')[0].trim().toLowerCase();
}

function wordsOf(/** @type {any} */ text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

/**
 * Smoothed share of injections that were followed by a clean round; a lesson
 * with no measurements sits at the neutral 0.5.
 *
 * @param {any} lesson
 * @returns {number} rounded to two decimals so tiny differences never reorder
 */
export function lessonEffectiveness(lesson) {
  const injected = Number(lesson?.stats?.injected) || 0;
  const clean = Number(lesson?.stats?.cleanAfterInjection) || 0;
  return Math.round(((clean + 1) / (injected + 2)) * 100) / 100;
}

/**
 * @param {any} lesson
 * @param {string[]} paths
 * @returns {boolean}
 */
function lessonMatchesAnyPath(lesson, paths) {
  return (lesson.pathGlobs || []).some((/** @type {any} */ glob) => paths.some((file) => scoutGlobMatchesPath(file, glob)));
}

/**
 * @param {{
 *   lessons?: any[],
 *   audience: 'implementer' | 'reviewer' | 'planner',
 *   leafText?: string,
 *   candidatePaths?: string[],
 *   executorModel?: string,
 *   charBudget?: number,
 *   maxLessons?: number,
 * }} input
 * @returns {any[]} ranked lessons within the budget (possibly empty)
 */
export function selectReviewLessons(input) {
  const audience = String(input?.audience || '');
  const kinds = /** @type {Record<string, any>} */ (AUDIENCE_KINDS)[audience];
  if (!kinds) return [];
  const charBudget = Number(input?.charBudget) > 0 ? Number(input.charBudget) : REVIEW_LESSONS_PROMPT_CHAR_BUDGET;
  const maxLessons = Number(input?.maxLessons) > 0 ? Number(input.maxLessons) : REVIEW_LESSONS_PROMPT_MAX;
  const leafText = String(input?.leafText || '');
  const paths = [...new Set([...(input?.candidatePaths || []), ...extractPathsFromText(leafText)])];
  const words = wordsOf(leafText);
  const model = baseModel(input?.executorModel);
  const scored = [];
  for (const lesson of Array.isArray(input?.lessons) ? input.lessons : []) {
    if (!lesson || lesson.status !== 'active' || lesson.audience !== audience || !kinds.includes(lesson.kind)) continue;
    // A suppression must never hide a security finding.
    if (audience === 'reviewer' && lesson.category === 'security') continue;
    const models = (lesson.appliesToModels || []).map(baseModel).filter(Boolean);
    if (models.length && (!model || !models.includes(model))) continue;
    const hasGlobs = Array.isArray(lesson.pathGlobs) && lesson.pathGlobs.length > 0;
    const globHit = hasGlobs && lessonMatchesAnyPath(lesson, paths);
    if (hasGlobs && paths.length && !globHit) continue;
    const keywordHits = (/** @type {Record<string, any>} */ (CATEGORY_KEYWORDS)[lesson.category] || []).filter((/** @type {any} */ word) => words.has(word)).length;
    const evidence = Array.isArray(lesson.evidence) ? lesson.evidence.length : 0;
    const recency = Date.parse(lesson.lastEvidenceAt || lesson.updatedAt || lesson.createdAt || '') || 0;
    scored.push({ lesson, globHit: globHit ? 1 : 0, keywordHits, effectiveness: lessonEffectiveness(lesson), evidence, recency });
  }
  scored.sort((a, b) => (b.globHit - a.globHit)
    || (b.keywordHits - a.keywordHits)
    || (b.effectiveness - a.effectiveness)
    || (b.evidence - a.evidence)
    || (b.recency - a.recency)
    || String(a.lesson.id).localeCompare(String(b.lesson.id)));
  const out = [];
  let used = 0;
  for (const row of scored) {
    if (out.length >= maxLessons) break;
    const cost = String(row.lesson.text || '').length + LESSON_LINE_OVERHEAD;
    if (used + cost > charBudget) continue;
    used += cost;
    out.push(row.lesson);
  }
  return out;
}
