/**
 * Generic wake-up API: lists rows of every kind in `data/wakeups.json`, the
 * registered kinds with their settings, the scheduler status, and cancels an
 * armed row. Kind-specific settings are delegated to the kind's own module.
 */

import { cancelWakeup, listWakeups } from '../persist/wakeups-persist.js';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { USAGE_LIMIT_RESUME_KIND } from '../usage-limit-paused.js';
import { applyUsageLimitResumePatch } from './usage-limit-resume-routes.js';
import { CONDITION_CHECK_KIND } from '../wakeup-condition-check.js';
import { applyConditionCheckPatch } from '../condition-check-settings.js';

const EMPTY_STATUS = Object.freeze({ running: false, tickMs: 60_000, lastTickAt: null, kinds: [], jobs: [] });

/** Per-kind settings persistence: config key + validating patch function. */
const KIND_SETTINGS = Object.freeze({
  [USAGE_LIMIT_RESUME_KIND]: Object.freeze({ configKey: 'usageLimitResume', apply: applyUsageLimitResumePatch }),
  [CONDITION_CHECK_KIND]: Object.freeze({ configKey: 'conditionCheck', apply: applyConditionCheckPatch }),
});

function isForbidden(req) {
  return Boolean(req.widgetAccess || req.mcpIntegration);
}

function toApiRow(row, scheduler) {
  const described = scheduler?.describeRow?.(row);
  return {
    id: row.id,
    kind: row.kind,
    subjectType: row.subjectType ?? null,
    subjectId: row.subjectId ?? null,
    state: row.state,
    reason: row.reason ?? '',
    attempts: Number(row.attempts) || 0,
    dueAt: described?.dueAt || null,
    ...(described?.details ? { details: described.details } : {}),
    createdAt: row.createdAt ?? null,
    pausedAt: row.pausedAt ?? null,
  };
}

function toApiKind(definition) {
  let settings = {};
  try {
    settings = definition.getSettings?.() || {};
  } catch {
    // One broken kind must not break the whole list.
  }
  return {
    kind: definition.kind,
    label: definition.label || definition.kind,
    description: definition.description || '',
    enabled: Boolean(settings.enabled),
    settings,
    settingsSchema: definition.settingsSchema || {},
  };
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   dataDir?: string,
 *   getScheduler?: () => Record<string, any>|null,
 *   getPeriodicJobRunner?: () => Record<string, any>|null,
 *   conditionCheck?: ReturnType<typeof import('../wakeup-condition-check-service.js').createConditionCheckService>,
 *   getCurrentCwd?: () => string,
 *   loadSettings?: Function,
 *   saveSettings?: Function,
 * }} [ctx] `getScheduler` is read per request: the scheduler boots after the routes are registered
 */
export function registerWakeupsRoutes(app, ctx = {}) {
  const options = { dataDir: ctx.dataDir };
  const readConfig = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
  const writeConfig = typeof ctx.saveSettings === 'function' ? ctx.saveSettings : saveSettings;
  const scheduler = () => (typeof ctx.getScheduler === 'function' ? ctx.getScheduler() : null);
  const definitions = () => scheduler()?.listKindDefinitions?.() || [];
  const forbid = (res) => res.status(403).json({ ok: false, error: 'Forbidden' });

  app.get('/api/wakeups', (req, res) => {
    if (isForbidden(req)) return forbid(res);
    const kind = String(req.query?.kind || '').trim();
    const state = String(req.query?.state || '').trim();
    const items = listWakeups({ ...(kind ? { kind } : {}), ...(state ? { state } : {}) }, options);
    return res.json({ ok: true, items: items.map((row) => toApiRow(row, scheduler())) });
  });

  app.get('/api/wakeups/kinds', (req, res) => {
    if (isForbidden(req)) return forbid(res);
    return res.json({ ok: true, kinds: definitions().map(toApiKind) });
  });

  app.get('/api/wakeups/status', (req, res) => {
    if (isForbidden(req)) return forbid(res);
    const jobs = (typeof ctx.getPeriodicJobRunner === 'function' ? ctx.getPeriodicJobRunner() : null)?.getJobsStatus?.() || [];
    return res.json({ ok: true, ...(scheduler()?.getStatus?.() || EMPTY_STATUS), jobs });
  });

  app.patch('/api/wakeups/kinds/:kind/settings', (req, res) => {
    if (isForbidden(req)) return forbid(res);
    const definition = definitions().find((item) => item.kind === req.params.kind);
    if (!definition) return res.status(404).json({ ok: false, error: 'Not found', code: 'not_found' });
    const binding = KIND_SETTINGS[definition.kind];
    if (!binding) return res.status(400).json({ ok: false, error: 'Settings are not editable for this kind', code: 'unsupported_settings' });
    const config = readConfig();
    const result = binding.apply(config[binding.configKey], req.body);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error, code: 'invalid_settings' });
    config[binding.configKey] = result.value;
    writeConfig(config);
    return res.json({ ok: true, settings: result.value });
  });

  const sendFailure = (res, result) => {
    const { status, ...body } = result;
    return res.status(status).json({ ...body, ok: false });
  };

  app.post('/api/wakeups/condition-check', (req, res) => {
    if (isForbidden(req)) return forbid(res);
    if (!ctx.conditionCheck) return res.status(503).json({ ok: false, error: 'Scheduled checks are unavailable', code: 'unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const workspaceFolder = String(body.workspaceFolder || '').trim()
      || (typeof ctx.getCurrentCwd === 'function' ? ctx.getCurrentCwd() : '');
    const result = ctx.conditionCheck.create({ ...body, workspaceFolder });
    return result.ok ? res.status(201).json({ ok: true, item: result.item }) : sendFailure(res, result);
  });

  app.post('/api/wakeups/:id/run-now', async (req, res) => {
    if (isForbidden(req)) return forbid(res);
    if (!ctx.conditionCheck) return res.status(503).json({ ok: false, error: 'Scheduled checks are unavailable', code: 'unavailable' });
    /** @type {Record<string, any>} */
    const result = await ctx.conditionCheck.runNow(String(req.params.id || ''));
    return result.ok ? res.json({ ok: true, item: result.item }) : sendFailure(res, result);
  });

  app.post('/api/wakeups/:id/cancel', (req, res) => {
    if (isForbidden(req)) return forbid(res);
    const id = String(req.params.id || '');
    const existing = listWakeups({}, options).find((row) => row.id === id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Not found', code: 'not_found' });
    if (existing.state !== 'armed') return res.status(409).json({ ok: false, error: 'Only an armed wake-up can be cancelled', code: 'not_armed' });
    const result = cancelWakeup(id, 'cancelled_by_user', options);
    return res.json({ ok: true, item: toApiRow(result.record || existing, scheduler()) });
  });
}
