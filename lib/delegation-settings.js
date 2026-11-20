/**
 * Effective delegation settings for one workspace.
 *
 * Precedence per field: saved workspace value > `CRETLI_DELEGATION_*` env >
 * built-in default. `scope=server` fields only mirror env/default. A saved or
 * env value that fails validation is ignored and the next layer wins, so a bad
 * file or env var can never break the runtime.
 *
 * The result also carries `env`: a copy of the process env with the workspace
 * layer overlaid under the original `CRETLI_DELEGATION_*` names. Delegation
 * helpers that already take an `env` argument can be handed `resolved.env`
 * without learning about workspaces; callers without a workspace keep passing
 * nothing and read `process.env` as before.
 */

import { resolveStartupFailureLockoutMs, resolveStartupFailureExtendedLockoutMs, resolveStartupFailureEscalationWindowMs, resolveStartupRetryCount, resolveStartupRetryDelayMs } from './delegation-startup-lockout-policy.js';
import { readReviewerPairMembers } from './persist/reviewer-pairs-persist.js';
import { buildReviewerPolicyView, isSameReviewer, resolveReviewerPolicy } from './reviewer-policy.js';
import { getDelegationSettings } from './persist/delegation-settings-persist.js';
import { normalizeReviewerPair } from './persist/todos-persist.js';
import { listTodos } from './persist/todos-store.js';
import { resolveDataPath } from './runtime-paths.js';
import { DELEGATION_SETTING_DEFS } from './delegation-settings-schema.js';
import { WORK_SWITCH_FIELDS } from './delegation-work-role.js';
import { PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT } from './model-pick-plan-window.js';

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function envString(value) {
  if (Array.isArray(value)) return value;
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

/**
 * @param {{
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   env?: Record<string, string | undefined>,
 * }} [input]
 * @returns {{
 *   effective: Record<string, unknown>,
 *   saved: Record<string, unknown> | null,
 *   source: Record<string, 'workspace' | 'env' | 'default'>,
 *   envDefault: Record<string, unknown>,
 *   scope: Record<string, 'workspace' | 'server'>,
 *   env: Record<string, string | undefined>,
 * }}
 */
export function resolveDelegationSettings(input = {}) {
  const baseEnv = input.env && typeof input.env === 'object' ? input.env : process.env;
  let saved = null;
  const folder = String(input.workspaceFolder ?? '').trim();
  if (folder) {
    try {
      saved = getDelegationSettings(folder, input.dataDir ? { dataDir: input.dataDir } : {});
    } catch {
      saved = null;
    }
  }
  const effective = {};
  const source = {};
  const envDefault = {};
  const scope = {};
  const overlay = { ...baseEnv };
  for (const def of DELEGATION_SETTING_DEFS) {
    scope[def.field] = def.scope;
    let fromEnv = { ok: false };
    if (def.env) {
      const raw = baseEnv[def.env];
      if (typeof raw === 'string' && raw.trim() !== '') fromEnv = (def.envParse || def.parse)(raw);
    }
    // envDefault is what the field would be with no workspace record.
    envDefault[def.field] = fromEnv.ok ? fromEnv.value : def.default;
    const hasSaved = def.scope === 'workspace' && saved && def.field in saved;
    if (hasSaved) {
      effective[def.field] = saved[def.field];
      source[def.field] = 'workspace';
      if (def.env) overlay[def.env] = /** @type {string} */ (envString(saved[def.field]));
    } else {
      effective[def.field] = envDefault[def.field];
      source[def.field] = fromEnv.ok ? 'env' : 'default';
    }
  }
  const savedView = saved ? { ...saved } : null;
  return { effective, saved: savedView, source, envDefault, scope, env: overlay };
}

/**
 * GET/PUT response body for the settings API.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, env?: Record<string, string | undefined> }} input
 * @returns {{ effective: Record<string, any>, saved: Record<string, any> | null, source: Record<string, any>, envDefault: Record<string, any>, scope: Record<string, any>, reviewerPolicy: Record<string, any> }}
 */
export function resolveDelegationSettingsView(input) {
  const { effective, saved, source, envDefault, scope } = resolveDelegationSettings(input);
  return {
    effective, saved, source, envDefault, scope,
    // Per-subject reviewer policy as the server enforces it (migrated from the
    // legacy reviewer_pair_* fields until a policy is saved).
    reviewerPolicy: buildReviewerPolicyView(effective),
    recovery: {
      startupLockoutMs: resolveStartupFailureLockoutMs(),
      extendedLockoutMs: resolveStartupFailureExtendedLockoutMs(),
      escalationWindowMs: resolveStartupFailureEscalationWindowMs(),
      startupFailureRetries: resolveStartupRetryCount(),
      startupFailureRetryDelayMs: resolveStartupRetryDelayMs(),
    },
  };
}

/**
 * Resolve the one server-enforced continuation switch for a work role. Plan /
 * implement / fix read their own boolean and `<role>_session_scope`; review roles read
 * `reviewer_policy.<subject>.session` (no parallel gate). `review_other` stays
 * legacy-only. Unknown roles fail closed to a fresh chat.
 *
 * @param {{ workspaceFolder?: string, dataDir?: string, workRole?: string, env?: Record<string, string | undefined> }} input
 * @returns {{ enabled: boolean, field: string, source: string, scope: string, reason: string }}
 */
export function resolveDelegationContinuationPolicy(input = {}) {
  const role = String(input.workRole || '').trim().toLowerCase();
  const resolved = resolveDelegationSettings({
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    ...(input.env ? { env: input.env } : {}),
  });
  if (role === 'review_plan' || role === 'review_code') {
    const subject = role === 'review_plan' ? 'plan' : 'code';
    const entry = /** @type {Record<string, any>} */ (buildReviewerPolicyView(resolved.effective)[subject]);
    const session = String(entry?.session || 'fresh');
    return {
      enabled: session !== 'fresh',
      field: `reviewer_policy.${subject}.session`,
      source: entry?.source === 'policy' ? (resolved.source.reviewer_policy || 'workspace') : 'legacy',
      scope: session,
      reason: session === 'fresh' ? 'disabled' : 'enabled',
    };
  }
  const field = WORK_SWITCH_FIELDS[role] || '';
  if (!field) return { enabled: false, field: '', source: 'default', scope: 'fresh', reason: role === 'review_other' ? 'legacy_only' : 'unclassified_role' };
  const enabled = resolved.effective[field] === true;
  return { enabled, field, source: resolved.source[field] || 'default', scope: enabled ? resolved.effective[`${role}_session_scope`] : 'fresh', reason: enabled ? 'enabled' : 'disabled' };
}

/**
 * Opt-in cross-role chat reuse (code review <-> implement/fix). It only widens
 * the source set: each start still needs its own per-role switch.
 *
 * @param {{ workspaceFolder?: string, dataDir?: string, env?: Record<string, string | undefined> }} [input]
 * @returns {boolean}
 */
export function resolveCrossRoleContinuation(input = {}) {
  const resolved = resolveDelegationSettings({
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    ...(input.env ? { env: input.env } : {}),
  });
  return resolved.effective.continue_cross_role_sessions === true;
}

/**
 * Optional round cap for resumed chats (`resume_context_cap_rounds`). 0 = off.
 *
 * @param {{ workspaceFolder?: string, dataDir?: string, env?: Record<string, string | undefined> }} [input]
 * @returns {number}
 */
export function resolveResumeContextCapRounds(input = {}) {
  const resolved = resolveDelegationSettings({
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    ...(input.env ? { env: input.env } : {}),
  });
  const value = Number(resolved.effective.resume_context_cap_rounds);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

const ENV_CACHE_TTL_MS = 1000;
/** @type {Map<string, { at: number, env: Record<string, string | undefined> }>} */
const envCache = new Map();

/**
 * Drop cached workspace envs (called after a save so changes apply at once).
 */
export function clearDelegationEnvCache() {
  envCache.clear();
}

/**
 * Env to hand to the delegation readers for one workspace: `process.env` with
 * the saved workspace layer overlaid. Without a workspace (or with nothing
 * saved) this is `process.env` itself, so behavior stays env-only. Short-lived
 * cache keeps the runtime tick from re-reading the settings file per row.
 *
 * @param {unknown} workspaceFolder
 * @returns {Record<string, string | undefined>}
 */
export function resolveDelegationEnv(workspaceFolder) {
  const folder = String(workspaceFolder ?? '').trim();
  if (!folder) return process.env;
  const now = Date.now();
  const cached = envCache.get(folder);
  if (cached && now - cached.at < ENV_CACHE_TTL_MS) return cached.env;
  let env = process.env;
  try {
    const resolved = resolveDelegationSettings({ workspaceFolder: folder, dataDir: resolveDataPath() });
    if (resolved.saved) env = resolved.env;
  } catch {
    env = process.env;
  }
  envCache.set(folder, { at: now, env });
  if (envCache.size > 256) envCache.delete(envCache.keys().next().value);
  return env;
}

/**
 * Per-todo reviewer-pair override of a leaf. Unknown, ambiguous or unreadable
 * todos leave the workspace policy untouched.
 *
 * @param {unknown} dataDir
 * @param {unknown} workspaceFolder
 * @param {unknown} leafId
 * @returns {Promise<{ enabled?: boolean, members?: Array<{ harness: string, model: string }> } | undefined>}
 */
export async function readLeafTodoReviewerPair(dataDir, workspaceFolder, leafId) {
  const id = String(leafId ?? '').trim().toLowerCase();
  const folder = String(workspaceFolder ?? '').trim();
  if (!id || !folder) return undefined;
  try {
    const items = (await listTodos(String(dataDir || '').trim() || resolveDataPath(), folder)).items;
    const exact = items.find((row) => String(row?.id || '').toLowerCase() === id);
    const matches = exact ? [exact] : items.filter((row) => String(row?.id || '').toLowerCase().startsWith(id));
    return matches.length === 1 ? normalizeReviewerPair(matches[0].reviewerPair) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a review policy with an optional per-todo pair taking precedence.
 *
 * @param {unknown} workspaceFolder
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function resolveTodoReviewerPolicy(workspaceFolder, options = {}) {
  const policy = resolveReviewerPolicy(workspaceFolder, options);
  const override = normalizeReviewerPair(options.todoReviewerPair);
  if (override?.enabled === false) {
    return {
      ...policy,
      selection: 'auto', membersSource: 'learned', configured: [], learned: [], known: [], members: [],
      active: false, learning: false, reuse: false, revision: `${policy.revision}:todo-off`,
    };
  }
  if (override?.enabled !== true || override.members?.length !== 2) return policy;
  const members = override.members.map((member) => ({ harness: member.harness, model: member.model }));
  return {
    ...policy,
    source: 'todo', selection: 'fixed_pair', membersSource: 'todo', configured: members,
    learned: [], known: members, members, active: true, learning: false,
    revision: `${policy.revision}:todo:${members.map((member) => `${member.harness}/${member.model}`).join('|')}`,
  };
}

/**
 * Prompt-facing policies with a todo override applied to both review subjects.
 *
 * @param {unknown} workspaceFolder
 * @param {Record<string, any>} [options]
 * @returns {{ policies: Record<string, any>[], workPolicies: Record<string, any>[], reviewerPool: Array<{ harness: string, model: string }>, reviewerPoolStrict: boolean }}
 */
export function resolveTodoReviewerPoliciesForPrompt(workspaceFolder, options = {}) {
  const policies = ['plan', 'code'].map((subject) => resolveTodoReviewerPolicy(workspaceFolder, { ...options, subject }));
  const workPolicies = ['plan', 'implement', 'fix'].map((workRole) => ({
    role: workRole,
    ...resolveDelegationContinuationPolicy({
      workspaceFolder,
      dataDir: options.dataDir,
      env: options.env,
      workRole,
    }),
  }));
  const reviewerPool = [];
  for (const policy of policies) {
    for (const member of policy.known || []) {
      if (!reviewerPool.some((candidate) => isSameReviewer(candidate, member))) reviewerPool.push({ harness: member.harness, model: member.model });
    }
  }
  return { policies, workPolicies, reviewerPool, reviewerPoolStrict: policies.some((policy) => policy.reuse) };
}

/**
 * Reviewer pool for one workspace, optionally overridden by one todo's pair.
 * Without an override, it is active only when `reviewer_pair_enabled` is on
 * AND `reviewer_pair_members` holds a complete pair; otherwise `members` is
 * empty so callers keep the unchanged (pool-less) behavior. The parent passes
 * `members` to `model_pick` as `prefer_models`; the picker never reads settings.
 *
 * With `options.subject` = `plan` | `code` the per-subject reviewer policy
 * decides (see reviewer-policy.js) and the result carries it as `policy`;
 * without a subject (or `other`) the legacy `reviewer_pair_*` behavior is kept.
 * `incomplete` marks a `fixed_pair` selection whose pair is still being learned
 * (fewer than two known members): callers that require two reviewers must treat
 * the round as open, not as a single-reviewer legacy round.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string, env?: Record<string, string | undefined>, parentChatId?: string, delegations?: Record<string, any>[], subject?: string, todoReviewerPair?: Record<string, any> | null }} [options]
 * @returns {{ active: boolean, incomplete?: boolean, strict?: boolean, learned?: Array<{ harness: string, model: string }>, members: Array<{ harness: string, model: string }>, policy?: Record<string, any> }}
 */
export function resolveReviewerPool(workspaceFolder, options = {}) {
  const folder = String(workspaceFolder ?? '').trim();
  if (!folder) return { active: false, members: [] };
  const todoOverride = normalizeReviewerPair(options.todoReviewerPair);
  if (todoOverride?.enabled === false) return { active: false, strict: false, learned: [], members: [] };
  if (todoOverride?.enabled === true && todoOverride.members?.length === 2) {
    return {
      active: true,
      strict: false,
      learned: [],
      members: todoOverride.members.map((member) => ({ harness: member.harness, model: member.model })),
    };
  }
  if (options.subject === 'plan' || options.subject === 'code') {
    const policy = resolveTodoReviewerPolicy(folder, options);
    return {
      active: policy.active,
      // A fixed pair that is still being learned is a two-reviewer round that
      // cannot start both members yet: report it as incomplete, not as "off".
      incomplete: policy.selection === 'fixed_pair' && !policy.active,
      strict: policy.reuse,
      learned: policy.learned,
      members: policy.members,
      policy,
    };
  }
  try {
    const { effective } = resolveDelegationSettings({
      workspaceFolder: folder,
      dataDir: options.dataDir || resolveDataPath(),
      ...(options.env ? { env: options.env } : {}),
    });
    const strict = effective.reviewer_pair_strict === true;
    const configured = Array.isArray(effective.reviewer_pair_members) ? effective.reviewer_pair_members : [];
    // Strict mode needs no configured pair: the orchestrator's own pair is used.
    const learned = strict && options.parentChatId
      ? readReviewerPairMembers(options.parentChatId, options.delegations)
      : [];
    const members = configured.length === 2 && (effective.reviewer_pair_enabled === true || strict)
      ? configured
      : learned.length === 2 ? learned : [];
    if (members.length !== 2) return { active: false, strict, learned, members: [] };
    return { active: true, strict, learned, members: members.map((m) => ({ harness: m.harness, model: m.model })) };
  } catch {
    return { active: false, members: [] };
  }
}

/**
 * Plan-window config for `model_pick` in one workspace. Without a workspace (or
 * on a read failure) it returns the defaults, which equal the picker's own.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ enabled: boolean, hardFreePercent: number }}
 */
export function resolvePlanWindowSettings(workspaceFolder, options = {}) {
  const folder = String(workspaceFolder ?? '').trim();
  const fallback = { enabled: true, hardFreePercent: PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT };
  if (!folder) return fallback;
  try {
    const { effective } = resolveDelegationSettings({
      workspaceFolder: folder,
      dataDir: options.dataDir || resolveDataPath(),
      ...(options.env ? { env: options.env } : {}),
    });
    return {
      enabled: effective.plan_window_enabled !== false,
      hardFreePercent: Number(effective.plan_window_hard_free_percent) || PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT,
    };
  } catch {
    return fallback;
  }
}
