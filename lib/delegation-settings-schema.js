/**
 * Schema of the delegation options that Settings → Delegations exposes.
 *
 * One entry per option: the `CRETLI_DELEGATION_*` env var it maps to, the
 * default, the scope (`workspace` = saveable per workspace, `server` = read-only
 * process-wide view of the env) and a strict parser. A parser returns
 * `{ ok: true, value }` or `{ ok: false }`; it never throws.
 *
 * `CRETLI_DELEGATION_STORE` is deliberately absent: it selects the persistence
 * backend at boot and stays env-only.
 */

import {
  PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT,
  PLAN_WINDOW_HARD_FREE_PERCENT_MAX,
  PLAN_WINDOW_HARD_FREE_PERCENT_MIN,
} from './model-pick-plan-window.js';

/**
 * @param {number} min
 * @param {number} [max]
 * @returns {(raw: unknown) => { ok: boolean, value?: number }}
 */
function intParser(min, max = Number.MAX_SAFE_INTEGER) {
  return (raw) => {
    const text = String(raw ?? '').trim();
    if (!/^-?\d+$/.test(text)) return { ok: false };
    const value = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(value) || value < min || value > max) return { ok: false };
    return { ok: true, value };
  };
}

/**
 * Lenient env-layer integer: the legacy readers used `parseInt`, so trailing
 * junk (`5abc`) still reads as 5. Values below `min` are rejected (the legacy
 * reader fell back to its default); values above `max` clamp instead.
 *
 * @param {number} min
 * @param {number} [max]
 * @returns {(raw: unknown) => { ok: boolean, value?: number }}
 */
function lenientIntParser(min, max = Number.MAX_SAFE_INTEGER) {
  return (raw) => {
    const value = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isSafeInteger(value) || value < min) return { ok: false };
    return { ok: true, value: Math.min(value, max) };
  };
}

/**
 * Legacy `Number()` reader of the closure cap: any finite value >= 0, floored.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: number }}
 */
function lenientClosuresParser(raw) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value: Math.floor(value) };
}

/**
 * Legacy fanout readers: `1` means 1, everything else means 2.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: number }}
 */
function fanoutEnvParser(raw) {
  const text = String(raw ?? '').trim();
  if (text === '1') return { ok: true, value: 1 };
  if (text === '2') return { ok: true, value: 2 };
  return { ok: false };
}

/**
 * Legacy code-review-phase reader: only 0/false/off disable it.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: boolean }}
 */
function codeReviewPhaseEnvParser(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (['0', 'false', 'off'].includes(text)) return { ok: true, value: false };
  if (['1', 'true', 'on'].includes(text)) return { ok: true, value: true };
  return { ok: false };
}

/**
 * Legacy allow-uncertified reader: only the literal `1` enables it.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: boolean }}
 */
function strictOneEnvParser(raw) {
  return String(raw ?? '').trim() === '1' ? { ok: true, value: true } : { ok: false };
}

/**
 * @param {string[]} allowed
 * @returns {(raw: unknown) => { ok: boolean, value?: string }}
 */
function enumParser(allowed) {
  return (raw) => {
    const text = String(raw ?? '').trim().toLowerCase();
    return allowed.includes(text) ? { ok: true, value: text } : { ok: false };
  };
}

/**
 * Booleans accept real booleans plus the usual env spellings.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: boolean }}
 */
function boolParser(raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  const text = String(raw ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(text)) return { ok: true, value: true };
  if (['0', 'false', 'off', 'no'].includes(text)) return { ok: true, value: false };
  return { ok: false };
}

/**
 * Reviewer pair members: an empty list or exactly two `{ harness, model }` pairs.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value?: Array<{ harness: string, model: string }> }}
 */
function pairMembersParser(raw) {
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.length !== 0 && raw.length !== 2) return { ok: false };
  const members = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
    const harness = typeof item.harness === 'string' ? item.harness.trim() : '';
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (!harness || !model) return { ok: false };
    members.push({ harness, model });
  }
  return { ok: true, value: members };
}

/**
 * @typedef {{
 *   field: string,
 *   env: string,
 *   scope: 'workspace' | 'server',
 *   type: 'int' | 'enum' | 'bool' | 'pairs',
 *   default: unknown,
 *   parse: (raw: unknown) => { ok: boolean, value?: unknown },
 *   envParse?: (raw: unknown) => { ok: boolean, value?: unknown },
 * }} DelegationSettingDef
 */

/**
 * `parse` is the strict validator used for saved values and PUT bodies;
 * `envParse` mirrors the legacy, lenient env reader of the same option.
 *
 * @type {readonly DelegationSettingDef[]}
 */
export const DELEGATION_SETTING_DEFS = Object.freeze([
  { field: 'run_deadline_review_fix_ms', env: 'CRETLI_DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS', scope: 'workspace', type: 'int', default: 20 * 60 * 1000, parse: intParser(0), envParse: lenientIntParser(0) },
  { field: 'run_deadline_implement_ms', env: 'CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS', scope: 'workspace', type: 'int', default: 40 * 60 * 1000, parse: intParser(0), envParse: lenientIntParser(0) },
  { field: 'cancelling_timeout_ms', env: 'CRETLI_DELEGATION_CANCELLING_TIMEOUT_MS', scope: 'workspace', type: 'int', default: 120000, parse: intParser(1), envParse: lenientIntParser(1) },
  { field: 'review_fanout', env: 'CRETLI_DELEGATION_REVIEW_FANOUT', scope: 'workspace', type: 'int', default: 2, parse: intParser(1, 2), envParse: fanoutEnvParser },
  { field: 'parallel_implement_fanout', env: 'CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT', scope: 'workspace', type: 'int', default: 2, parse: intParser(1, 2), envParse: fanoutEnvParser },
  { field: 'tree_slot_limit', env: 'CRETLI_DELEGATION_TREE_SLOT_LIMIT', scope: 'workspace', type: 'int', default: 0, parse: intParser(0), envParse: lenientIntParser(0) },
  { field: 'max_depth', env: 'CRETLI_DELEGATION_MAX_DEPTH', scope: 'workspace', type: 'int', default: 1, parse: intParser(1, 8), envParse: lenientIntParser(1, 8) },
  { field: 'code_review_phase', env: 'CRETLI_DELEGATION_CODE_REVIEW_PHASE', scope: 'workspace', type: 'bool', default: true, parse: boolParser, envParse: codeReviewPhaseEnvParser },
  { field: 'code_review_max_closures', env: 'CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES', scope: 'workspace', type: 'int', default: 2, parse: intParser(0), envParse: lenientClosuresParser },
  { field: 'empty_favorites', env: 'CRETLI_DELEGATION_EMPTY_FAVORITES', scope: 'workspace', type: 'enum', default: 'deny', parse: enumParser(['deny', 'all']), envParse: enumParser(['deny', 'all']) },
  { field: 'review_allow_uncertified', env: 'CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED', scope: 'workspace', type: 'bool', default: false, parse: boolParser, envParse: strictOneEnvParser },
  // Process-wide limits: the queue cap is counted per parent in
  // delegation-width.js and the global cap spans every workspace, so neither
  // has a meaningful per-workspace value. Read-only preview of the env.
  { field: 'global_limit', env: 'CRETLI_DELEGATION_GLOBAL_LIMIT', scope: 'server', type: 'int', default: 0, parse: intParser(0), envParse: lenientIntParser(0) },
  { field: 'queue_max', env: 'CRETLI_DELEGATION_QUEUE_MAX', scope: 'server', type: 'int', default: 8, parse: intParser(0), envParse: lenientIntParser(0) },
  // Stored only; the reviewer-pair behavior lands in a later leaf. No env var.
  { field: 'reviewer_pair_enabled', env: '', scope: 'workspace', type: 'bool', default: false, parse: boolParser },
  { field: 'reviewer_pair_members', env: '', scope: 'workspace', type: 'pairs', default: [], parse: pairMembersParser },
  // Strict pair: the first two reviewers an orchestrator gets stay its pair
  // until the orchestrator finishes (see reviewer-pairs-persist.js); a member
  // whose subchat errors is replaced. Explicit `reviewer_pair_members` win.
  { field: 'reviewer_pair_strict', env: '', scope: 'workspace', type: 'bool', default: false, parse: boolParser },
  // model_pick plan-window mode: soft 5h headroom bonus + hard weekly threshold.
  // Defaults mirror the picker constants; off restores the legacy penalties.
  { field: 'plan_window_enabled', env: '', scope: 'workspace', type: 'bool', default: true, parse: boolParser },
  { field: 'plan_window_hard_free_percent', env: '', scope: 'workspace', type: 'int', default: PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT, parse: intParser(PLAN_WINDOW_HARD_FREE_PERCENT_MIN, PLAN_WINDOW_HARD_FREE_PERCENT_MAX) },
]);

export const DELEGATION_SETTING_FIELDS = Object.freeze(DELEGATION_SETTING_DEFS.map((def) => def.field));

/**
 * @param {string} field
 * @returns {DelegationSettingDef | null}
 */
export function getDelegationSettingDef(field) {
  return DELEGATION_SETTING_DEFS.find((def) => def.field === field) || null;
}
