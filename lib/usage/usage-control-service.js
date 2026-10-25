/**
 * Usage tab operations shared by the builtin MCP tools (`usage_summary`,
 * `usage_plan_limits`, `usage_settings`, `usage_settings_set`,
 * `usage_resume_stop`). Each op reuses the same builders and
 * normalizers as the REST routes, so a chat sees and writes exactly what the
 * Settings → Usage tab shows.
 */

import { buildPlanLimitsResponse, buildUsageSummaryResponse } from '../routes/usage-routes.js';
import { applyUsageLimitResumePatch, toLimitResumeApiRow } from '../routes/usage-limit-resume-routes.js';
import { applyUsageSettingsPatch, getUsageSettings } from './usage-settings.ts';
import { summarizeUsageDataDir } from './usage-retention.ts';
import { readUsageLimitResumeSettings } from '../usage-limit-resume-settings.js';
import { USAGE_LIMIT_RESUME_KIND } from '../usage-limit-paused.js';
import { cancelWakeup, listWakeups } from '../persist/wakeups-persist.js';
import { loadSettings, saveSettings } from '../persist/settings.js';

export const USAGE_CONTROL_OPS = Object.freeze(['summary', 'plan_limits', 'settings_show', 'settings_update', 'limit_resume_cancel']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {{ dataDir?: string }} ctx
 * @param {string} [state]
 * @returns {Record<string, any>[]}
 */
function listLimitResumes(ctx, state = '') {
  return listWakeups({ kind: USAGE_LIMIT_RESUME_KIND, ...(state ? { state } : {}) }, { dataDir: ctx.dataDir }).map(toLimitResumeApiRow);
}

/**
 * @param {{ dataDir?: string, loadSettings?: Function }} ctx
 * @returns {Record<string, any>}
 */
function settingsView(ctx) {
  const config = (ctx.loadSettings || loadSettings)();
  return {
    ok: true,
    usage: getUsageSettings(config),
    limitResume: readUsageLimitResumeSettings(config),
    storage: summarizeUsageDataDir({ dataDir: ctx.dataDir }),
    pendingResumes: listLimitResumes(ctx, 'pending'),
  };
}

/**
 * @param {string} op
 * @param {Record<string, any>} args
 * @param {{ dataDir?: string, loadSettings?: Function, saveSettings?: Function }} [ctx]
 * @returns {Promise<Record<string, any>>}
 */
export async function runUsageControl(op, args = {}, ctx = {}) {
  if (op === 'summary') return buildUsageSummaryResponse(args, ctx);
  if (op === 'plan_limits') return buildPlanLimitsResponse(ctx);
  if (op === 'settings_show') return settingsView(ctx);
  if (op === 'settings_update') {
    const usagePatch = args.usage;
    const resumePatch = args.limitResume;
    if (usagePatch != null && !isPlainObject(usagePatch)) return { ok: false, error: 'usage must be an object' };
    if (resumePatch != null && !isPlainObject(resumePatch)) return { ok: false, error: 'limit_resume must be an object' };
    if (!usagePatch && !resumePatch) return { ok: false, error: 'Nothing to update: pass usage and/or limit_resume' };
    const config = (ctx.loadSettings || loadSettings)();
    if (usagePatch) config.usage = applyUsageSettingsPatch(config.usage, usagePatch);
    if (resumePatch) {
      const result = applyUsageLimitResumePatch(config.usageLimitResume, resumePatch);
      if (!result.ok) return result;
      config.usageLimitResume = result.value;
    }
    (ctx.saveSettings || saveSettings)(config);
    return settingsView(ctx);
  }
  if (op === 'limit_resume_cancel') {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, error: 'id is required' };
    const existing = listLimitResumes(ctx).find((row) => row.id === id);
    if (!existing) return { ok: false, error: 'Not found', code: 'not_found' };
    const result = cancelWakeup(id, 'cancelled_by_user', { dataDir: ctx.dataDir });
    return { ok: true, changed: result.changed, item: result.record ? toLimitResumeApiRow(result.record) : existing };
  }
  return { ok: false, error: `Unknown usage operation (${USAGE_CONTROL_OPS.join('|')})` };
}
