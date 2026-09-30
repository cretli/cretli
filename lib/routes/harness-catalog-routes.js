/**
 * HTTP catalog for harnesses and cached/fallback models (password clients).
 *
 * Also exposes the harness health view: run outcomes/latency, lockout history
 * and the last known plan rate-limit snapshot, plus a manual unlock endpoint.
 */

import { listHarnessCatalog, listHarnessModelsIncludingLocal } from '../harness-catalog.js';
import { clearHarnessUsageLimit } from '../harness-usage-limits.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { buildHarnessHealth } from '../usage/harness-health.js';
import { parseUsageRange } from './usage-routes.js';
import { msg } from '../messages.js';

/** Health defaults to the last week even though /api/usage defaults to the month. */
export const HARNESS_HEALTH_DEFAULT_RANGE_DAYS = 7;

/** Harness ids that must never become keys of the health response object. */
const UNSAFE_HARNESS_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} value
 * @returns {string} YYYY-MM-DD or ''
 */
function isoDay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return '';
  return day;
}

/**
 * Same validation as /api/usage, but an absent `from` means "last 7 days".
 *
 * @param {{ from?: unknown, to?: unknown }|undefined} query
 * @returns {{ from: string, to: string, days: number }|{ error: string }}
 */
export function parseHarnessHealthRange(query) {
  const rawTo = String(query?.to || '').trim();
  const rawFrom = String(query?.from || '').trim();
  if (rawTo && !isoDay(rawTo)) return { error: 'Invalid to (expected YYYY-MM-DD)' };
  if (rawFrom && !isoDay(rawFrom)) return { error: 'Invalid from (expected YYYY-MM-DD)' };
  const to = isoDay(rawTo) || new Date().toISOString().slice(0, 10);
  let from = isoDay(rawFrom);
  if (!from) {
    const start = new Date(`${to}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - (HARNESS_HEALTH_DEFAULT_RANGE_DAYS - 1));
    from = start.toISOString().slice(0, 10);
  }
  return parseUsageRange({ from, to });
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * Builds one health entry per catalog harness. A null-prototype object keeps a
 * rogue `__proto__`/`constructor` id from touching the prototype chain, and the
 * unsafe ids are skipped outright.
 *
 * @param {unknown} catalog
 * @param {{ from?: string, to?: string, dataDir?: string, events?: object[] }} [options]
 * @returns {Record<string, object|null>}
 */
export function buildHarnessHealthMap(catalog, options = {}) {
  const harnesses = Object.create(null);
  for (const item of Array.isArray(catalog) ? catalog : []) {
    const id = String(item?.id || '').trim().toLowerCase();
    if (!id || UNSAFE_HARNESS_IDS.has(id)) continue;
    if (Object.prototype.hasOwnProperty.call(harnesses, id)) continue;
    harnesses[id] = buildHarnessHealth({
      harness: id,
      from: options.from,
      to: options.to,
      dataDir: options.dataDir,
      events: options.events,
    });
  }
  return harnesses;
}

/**
 * @param {import('express').Express} app
 */
export function registerHarnessCatalogRoutes(app) {
  app.get('/api/harness-catalog/harnesses', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const items = await listHarnessCatalog();
      return res.json({ ok: true, items });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/harness-catalog/models', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const listed = await listHarnessModelsIncludingLocal({
        harness: req.query.harness,
        query: req.query.query,
        enabledOnly: req.query.enabled_only === '1' || req.query.enabledOnly === '1',
      });
      return res.json({ ok: true, ...listed });
    } catch (err) {
      const status = err?.code === 'VALIDATION' ? 400 : 500;
      return res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  });

  app.get('/api/harnesses/health', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const range = parseHarnessHealthRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    try {
      const catalog = await listHarnessCatalog();
      // One ledger read for the whole response instead of one per harness.
      const events = readUsageEvents({ from: range.from, to: `${range.to}T23:59:59.999Z` });
      const harnesses = buildHarnessHealthMap(catalog, {
        from: range.from,
        to: range.to,
        events,
      });
      return res.json({ ok: true, from: range.from, to: range.to, harnesses });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/harnesses/:id/usage-limit/clear', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const harness = String(req.params?.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(harness)) {
      return res.status(400).json({ ok: false, error: 'Invalid harness id' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (model.length > 200) {
      return res.status(400).json({ ok: false, error: 'Invalid model (max 200 characters)' });
    }
    try {
      const catalog = await listHarnessCatalog();
      const known = (Array.isArray(catalog) ? catalog : [])
        .some((item) => String(item?.id || '').trim().toLowerCase() === harness);
      if (!known) return res.status(404).json({ ok: false, error: 'Unknown harness' });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    const removed = clearHarnessUsageLimit(harness, model);
    return res.json({ ok: true, harness, model: model || null, removed });
  });
}
