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

import { getDelegationSettings } from './persist/delegation-settings-persist.js';
import { resolveDataPath } from './runtime-paths.js';
import { DELEGATION_SETTING_DEFS } from './delegation-settings-schema.js';
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
 * @returns {{ effective: object, saved: object | null, source: object, envDefault: object, scope: object }}
 */
export function resolveDelegationSettingsView(input) {
  const { effective, saved, source, envDefault, scope } = resolveDelegationSettings(input);
  return { effective, saved, source, envDefault, scope };
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
 * Reviewer pool for one workspace. Active only when `reviewer_pair_enabled` is
 * on AND `reviewer_pair_members` holds a complete pair; otherwise `members` is
 * empty so callers keep the unchanged (pool-less) behavior. The parent passes
 * `members` to `model_pick` as `prefer_models`; the picker never reads settings.
 *
 * @param {unknown} workspaceFolder
 * @param {{ dataDir?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ active: boolean, members: Array<{ harness: string, model: string }> }}
 */
export function resolveReviewerPool(workspaceFolder, options = {}) {
  const folder = String(workspaceFolder ?? '').trim();
  if (!folder) return { active: false, members: [] };
  try {
    const { effective } = resolveDelegationSettings({
      workspaceFolder: folder,
      dataDir: options.dataDir || resolveDataPath(),
      ...(options.env ? { env: options.env } : {}),
    });
    const members = Array.isArray(effective.reviewer_pair_members) ? effective.reviewer_pair_members : [];
    if (effective.reviewer_pair_enabled !== true || members.length !== 2) return { active: false, members: [] };
    return { active: true, members: members.map((m) => ({ harness: m.harness, model: m.model })) };
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
