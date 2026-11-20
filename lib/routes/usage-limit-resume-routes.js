/**
 * Read + cancel API for usage-limit auto-resume records (`kind:
 * 'usage_limit_resume'` view of the generic wake-up store).
 */

import { cancelWakeup, listWakeups } from '../persist/wakeups-persist.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { USAGE_LIMIT_RESUME_KIND } from '../usage-limit-paused.js';
import { normalizeUsageLimitResumeSettings, readUsageLimitResumeSettings } from '../usage-limit-resume-settings.js';

/**
 * Public shape of one auto-resume record (REST and MCP).
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function toLimitResumeApiRow(row) {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    harness: row.harness,
    model: row.model,
    subjectModel: row.subjectModel,
    resetAt: row.resetAt,
    resetSource: row.resetSource,
    state: row.state,
    reason: row.reason,
    attempts: row.attempts,
    chain: row.chain,
  };
}

/**
 * Validates a settings PATCH: unknown keys are dropped and numbers are clamped
 * by the shared normalizer; omitted keys keep their stored value.
 *
 * @param {unknown} stored current `usageLimitResume` block
 * @param {unknown} patch request body
 * @returns {{ ok: true, value: Record<string, any> }|{ ok: false, error: string }}
 */
export function applyUsageLimitResumePatch(stored, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Invalid settings patch' };
  const current = normalizeUsageLimitResumeSettings(stored);
  return { ok: true, value: normalizeUsageLimitResumeSettings({ ...current, ...patch }) };
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string, loadSettings?: Function, saveSettings?: Function }} [ctx]
 */
export function registerUsageLimitResumeRoutes(app, ctx = {}) {
  const options = { dataDir: ctx.dataDir };
  const readConfig = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
  const writeConfig = typeof ctx.saveSettings === 'function' ? ctx.saveSettings : saveSettings;
  app.get('/api/usage/limit-resume/settings', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    return res.json({ ok: true, settings: readUsageLimitResumeSettings(readConfig()) });
  });
  app.patch('/api/usage/limit-resume/settings', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const config = readConfig();
    /** @type {Record<string, any>} */
    const result = applyUsageLimitResumePatch(config.usageLimitResume, req.body);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    config.usageLimitResume = result.value;
    writeConfig(config);
    return res.json({ ok: true, settings: result.value });
  });
  app.get('/api/usage/limit-resume', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const state = String(req.query?.state || '').trim();
    const items = listWakeups({ kind: USAGE_LIMIT_RESUME_KIND, ...(state ? { state } : {}) }, options);
    return res.json({ ok: true, items: items.map(toLimitResumeApiRow) });
  });
  app.post('/api/usage/limit-resume/:id/cancel', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const id = String(req.params.id || '');
    const existing = listWakeups({ kind: USAGE_LIMIT_RESUME_KIND }, options).find((row) => row.id === id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found', code: 'not_found' });
    const result = cancelWakeup(id, 'cancelled_by_user', options);
    return res.json({ ok: true, changed: result.changed, item: toLimitResumeApiRow(result.record || existing) });
  });
}
