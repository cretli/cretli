/** Shared constants and pure validation of the initiatives domain (docs/development-plans.md). */

export const INITIATIVE_KINDS = Object.freeze(['goal', 'initiative']);
export const INITIATIVE_STATUSES = Object.freeze(['draft', 'exploring', 'planned', 'active', 'paused', 'achieved', 'dropped']);
export const INITIATIVE_HORIZONS = Object.freeze(['now', 'next', 'later']);
export const INITIATIVE_SCOPE_SIZES = Object.freeze(['unknown', 'S', 'M', 'L', 'XL']);
export const INITIATIVE_PRIORITIES = Object.freeze(['unknown', 'low', 'normal', 'high', 'urgent']);
export const RELATION_TYPES = Object.freeze(['contributes_to', 'requires', 'supports', 'alternative_to']);
/** Relation types whose graph must stay acyclic. */
export const ACYCLIC_RELATION_TYPES = Object.freeze(['contributes_to', 'requires']);
export const LINK_KINDS = Object.freeze(['todo', 'decision', 'research', 'git']);
export const RESEARCH_KINDS = Object.freeze(['observed', 'hypothesis', 'unknown']);
export const ACTORS = Object.freeze(['human', 'agent', 'system']);
/** Statuses an agent may set; the rest are strategic decisions reserved for a human. */
export const AGENT_STATUSES = Object.freeze(['draft', 'exploring']);
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const GRAPH_MAX_NODES = 100;
export const GRAPH_MAX_EDGES = 300;

const MAX_TEXT = 8000;
const MAX_TITLE = 300;
const MAX_LIST = 50;

/** Fields a human or agent may edit through update (the rest are server-owned). */
export const EDITABLE_FIELDS = Object.freeze([
  'kind', 'title', 'desiredOutcome', 'rationale', 'baseline', 'successCriteria', 'openQuestions',
  'scopeSize', 'priority', 'horizon', 'status', 'targetDate',
]);

/** Strategic fields an agent may not change once an initiative left draft/exploring. */
export const STRATEGIC_FIELDS = Object.freeze(EDITABLE_FIELDS.filter((f) => f !== 'openQuestions'));

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** @param {unknown} value */
function textList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => text(v, MAX_TEXT)).filter(Boolean).slice(0, MAX_LIST);
}

export class InitiativeError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InitiativeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalizes the editable fields present in `input`; `full` requires title + desiredOutcome and fills defaults
 * (missing data is `unknown`, never an invented value).
 *
 * @param {Record<string, any>} input
 * @param {{ full: boolean }} options
 */
export function normalizeInitiativeFields(input, { full }) {
  const src = input && typeof input === 'object' ? input : {};
  const out = /** @type {Record<string, any>} */ ({});
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
  const pickEnum = (key, values, fallback) => {
    if (!has(key)) { if (full) out[key] = fallback; return; }
    if (!values.includes(src[key])) throw new InitiativeError('validation', `Invalid ${key}`, { field: key });
    out[key] = src[key];
  };
  if (has('title') || full) {
    out.title = text(src.title, MAX_TITLE);
    if (!out.title) throw new InitiativeError('validation', 'title is required', { field: 'title' });
  }
  if (has('desiredOutcome') || full) {
    out.desiredOutcome = text(src.desiredOutcome, MAX_TEXT);
    if (!out.desiredOutcome) throw new InitiativeError('validation', 'desiredOutcome is required', { field: 'desiredOutcome' });
  }
  for (const key of ['rationale', 'baseline']) {
    if (has(key)) out[key] = text(src[key], MAX_TEXT); else if (full) out[key] = '';
  }
  for (const key of ['successCriteria', 'openQuestions']) {
    if (has(key)) out[key] = textList(src[key]); else if (full) out[key] = [];
  }
  pickEnum('kind', INITIATIVE_KINDS, 'initiative');
  pickEnum('scopeSize', INITIATIVE_SCOPE_SIZES, 'unknown');
  pickEnum('priority', INITIATIVE_PRIORITIES, 'unknown');
  pickEnum('horizon', INITIATIVE_HORIZONS, 'later');
  pickEnum('status', INITIATIVE_STATUSES, 'draft');
  if (has('targetDate')) {
    const d = text(src.targetDate, 40);
    if (d && Number.isNaN(Date.parse(d))) throw new InitiativeError('validation', 'Invalid targetDate', { field: 'targetDate' });
    out.targetDate = d;
  } else if (full) out.targetDate = '';
  return out;
}

/**
 * Signal of `A requires B` for planning (never a Todo scheduler gate).
 *
 * @param {Array<{ status: string, archivedAt?: string } | null | undefined>} requirements
 * @returns {'clear' | 'waiting' | 'waiting_paused' | 'blocked_abandoned' | 'blocked_archived' | 'unknown'}
 */
export function requiresSignal(requirements) {
  if (!requirements.length) return 'clear';
  let unknown = false;
  let waiting = false;
  let paused = false;
  let archived = false;
  let dropped = false;
  for (const dep of requirements) {
    if (!dep || !INITIATIVE_STATUSES.includes(dep.status)) { unknown = true; continue; }
    if (dep.status === 'achieved') continue;
    if (dep.status === 'dropped') dropped = true;
    else if (dep.archivedAt) archived = true;
    else if (dep.status === 'paused') paused = true;
    else waiting = true;
  }
  if (dropped) return 'blocked_abandoned';
  if (archived) return 'blocked_archived';
  if (unknown) return 'unknown';
  if (paused) return 'waiting_paused';
  return waiting ? 'waiting' : 'clear';
}
