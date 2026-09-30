/**
 * Usage ledger HTTP API. The client may report raw tokens; it may not set usd.
 */

import {
  loadUsageSummary,
  recordUsage,
  summarizeUsage,
  summarizeUsageTimeseries,
  USAGE_TIMESERIES_BUCKETS,
  USAGE_TIMESERIES_GROUPS,
  USAGE_TIMESERIES_METRICS,
} from '../usage/usage-ledger.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { fromOpenAiRealtimeUsage } from '../usage/usage-normalize.js';

export const USAGE_MAX_RANGE_DAYS = 92;
export const USAGE_MODEL_RANK_METRICS = Object.freeze(['tokens', 'usd', 'events', 'runs']);
const DEFAULT_MODEL_LIMIT = 50;
const MAX_MODEL_LIMIT = 200;

/**
 * @param {string} iso
 * @returns {string}
 */
export function monthStartIso(iso) {
  const raw = String(iso || new Date().toISOString());
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Date().toISOString().slice(0, 8) + '01';
  return `${day.slice(0, 7)}-01`;
}

/**
 * @param {unknown} value
 * @returns {string}
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
 * Inclusive range, defaulting to the current month.
 *
 * @param {{ from?: unknown, to?: unknown }|undefined} query
 * @returns {{ from: string, to: string, days: number }|{ error: string }}
 */
export function parseUsageRange(query) {
  const rawTo = String(query?.to || '').trim();
  const rawFrom = String(query?.from || '').trim();
  if (rawTo && !isoDay(rawTo)) return { error: 'Invalid to (expected YYYY-MM-DD)' };
  if (rawFrom && !isoDay(rawFrom)) return { error: 'Invalid from (expected YYYY-MM-DD)' };
  const to = isoDay(rawTo) || new Date().toISOString().slice(0, 10);
  const from = isoDay(rawFrom) || monthStartIso(to);
  if (from > to) return { error: 'from must not be after to' };
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days > USAGE_MAX_RANGE_DAYS) {
    return { error: `Range must not exceed ${USAGE_MAX_RANGE_DAYS} days` };
  }
  return { from, to, days };
}

/**
 * @param {object} row
 * @returns {number}
 */
function sumGroupTokens(row) {
  let total = 0;
  for (const value of Object.values(row?.tokens || {})) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string }} [ctx]
 */
export function registerUsageRoutes(app, ctx = {}) {
  app.get('/api/usage/summary', (req, res) => {
    const range = parseUsageRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    const summary = loadUsageSummary({ from: range.from, to: range.to, dataDir: ctx.dataDir });
    return res.json({ ok: true, from: range.from, to: range.to, summary });
  });

  app.get('/api/usage/timeseries', (req, res) => {
    const range = parseUsageRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    const bucket = String(req.query?.bucket || 'day').trim() || 'day';
    if (!USAGE_TIMESERIES_BUCKETS.includes(bucket)) {
      return res.status(400).json({ ok: false, error: `Invalid bucket (${USAGE_TIMESERIES_BUCKETS.join('|')})` });
    }
    const groupBy = String(req.query?.groupBy || 'model').trim() || 'model';
    if (!USAGE_TIMESERIES_GROUPS.includes(groupBy)) {
      return res.status(400).json({ ok: false, error: `Invalid groupBy (${USAGE_TIMESERIES_GROUPS.join('|')})` });
    }
    const metric = String(req.query?.metric || 'usd').trim() || 'usd';
    if (!USAGE_TIMESERIES_METRICS.includes(metric)) {
      return res.status(400).json({ ok: false, error: `Invalid metric (${USAGE_TIMESERIES_METRICS.join('|')})` });
    }
    const events = readUsageEvents({
      from: range.from,
      to: `${range.to}T23:59:59.999Z`,
      dataDir: ctx.dataDir,
    });
    const timeseries = summarizeUsageTimeseries(events, {
      bucket,
      groupBy,
      metric,
      from: range.from,
      to: range.to,
    });
    return res.json({ ok: true, from: range.from, to: range.to, ...timeseries });
  });

  app.get('/api/usage/models', (req, res) => {
    const range = parseUsageRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    const metric = String(req.query?.metric || 'tokens').trim() || 'tokens';
    if (!USAGE_MODEL_RANK_METRICS.includes(metric)) {
      return res.status(400).json({ ok: false, error: `Invalid metric (${USAGE_MODEL_RANK_METRICS.join('|')})` });
    }
    const requestedLimit = Number.parseInt(String(req.query?.limit ?? ''), 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_MODEL_LIMIT)
      : DEFAULT_MODEL_LIMIT;
    const events = readUsageEvents({
      from: range.from,
      to: `${range.to}T23:59:59.999Z`,
      dataDir: ctx.dataDir,
    });
    const summary = summarizeUsage(events);
    const models = Object.entries(summary.byModel)
      .map(([model, row]) => {
        const harnesses = Array.isArray(row.harnesses) ? row.harnesses : [];
        return {
          model,
          harness: row.harness ?? harnesses[0] ?? null,
          harnesses,
          usd: row.usd,
          estimatedUsd: row.estimatedUsd,
          unpricedEvents: row.unpricedEvents,
          events: row.events,
          runs: row.runs,
          okRuns: row.okRuns,
          errorRuns: row.errorRuns,
          limitHits: row.limitHits,
          p50LatencyMs: row.p50LatencyMs ?? null,
          p95LatencyMs: row.p95LatencyMs ?? null,
          tokens: row.tokens,
          totalTokens: sumGroupTokens(row),
        };
      })
      .sort((a, b) => {
        const primary = rankValue(b, metric) - rankValue(a, metric);
        if (primary !== 0) return primary;
        return b.totalTokens - a.totalTokens || a.model.localeCompare(b.model);
      })
      .slice(0, limit);
    return res.json({ ok: true, from: range.from, to: range.to, metric, models });
  });

  app.post('/api/usage/events', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.usd != null) {
      return res.status(400).json({ ok: false, error: 'Client must not send usd' });
    }
    const provider = String(body.provider || '').trim();
    if (!provider) {
      return res.status(400).json({ ok: false, error: 'Missing provider' });
    }
    const tokens = body.usage
      ? fromOpenAiRealtimeUsage(body.usage)
      : body.tokens && typeof body.tokens === 'object'
        ? body.tokens
        : null;
    if (!tokens) {
      return res.status(400).json({ ok: false, error: 'Missing usage' });
    }
    const event = recordUsage(
      {
        provider,
        feature: body.feature || 'voice-live',
        model: body.model,
        tokens,
        source: 'client',
        chatId: body.chatId,
        workspaceFile: body.workspaceFile,
      },
      ctx
    );
    return res.json({
      ok: true,
      event: { id: event.id, usd: event.usd, tokens: event.tokens },
    });
  });
}

/**
 * @param {object} row
 * @param {string} metric
 * @returns {number}
 */
function rankValue(row, metric) {
  if (metric === 'usd') return Number.isFinite(row?.usd) ? row.usd : 0;
  if (metric === 'events') return Number(row?.events) || 0;
  if (metric === 'runs') return Number(row?.runs) || 0;
  return sumGroupTokens(row);
}
