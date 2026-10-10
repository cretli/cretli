/**
 * Usage ledger HTTP API. The client may report raw tokens; it may not set usd.
 *
 * Since stage 8 the read endpoints accept an exact ISO 8601 `[from, to)` range
 * plus an IANA `tz` for grouping, and share one filter vocabulary (role,
 * harness, workspace, accounting scope, subject). `/api/usage/insights` is the
 * single filter-consistent payload used by the chart, table, tooltips and CSV.
 */

import {
  recordUsage,
  summarizeUsage,
  summarizeUsageTimeseries,
  USAGE_TIMESERIES_BUCKETS,
  USAGE_TIMESERIES_GROUPS,
  USAGE_TIMESERIES_METRICS,
} from '../usage/usage-ledger.js';
import { readHarnessPlanLimits } from '../usage/harness-health.js';
import { listHarnessUsageLimits } from '../harness-usage-limits.js';
import { readUsageEvents, readUsageLedgerState } from '../persist/usage-persist.js';
import { loadDelegations } from '../persist/delegations-persist.js';
import { loadModelPickRecords } from '../persist/model-pick-decisions-persist.js';
import {
  buildDelegationQualityCycles,
  summarizeDelegationCycleCostMetrics,
} from '../delegation-cycle-outcomes.js';
import { fromOpenAiRealtimeUsage } from '../usage/usage-normalize.js';
import {
  buildUsageCoverage,
  buildUsageInsights,
  buildUsageKpis,
  delegationRowMatchesFilters,
  filterUsageEvents,
  groupEventsByZoneDay,
  sumUsageCost,
  sumUsageTokenBuckets,
} from '../usage/usage-insights.js';
import {
  describeUsageWindow,
  filterEventsByWindow,
  resolveUsageWindow,
} from '../usage/usage-window.js';
import { applyUsageSettingsPatch, getUsageSettings } from '../usage/usage-settings.js';
import { pruneUsageJournal, summarizeUsageDataDir } from '../usage/usage-retention.js';
import { loadSettings, saveSettings } from '../persist/settings.js';

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
 * Legacy day-range parser kept for the harness health callers. New code should
 * use {@link resolveUsageWindow} so an exact instant range and an IANA zone are
 * possible; this wrapper keeps their `{ from, to, days }` contract.
 *
 * @param {{ from?: unknown, to?: unknown, range?: unknown, tz?: unknown }|undefined} query
 * @returns {{ from: string, to: string, days: number }|{ error: string }}
 */
export function parseUsageRange(query) {
  const window = resolveUsageWindow({ ...(query || {}), tz: 'UTC', maxDays: USAGE_MAX_RANGE_DAYS });
  if (!window.ok) return { error: window.error };
  if (window.inputKind === 'day') {
    return { from: window.legacyDayFrom, to: window.legacyDayTo, days: window.days };
  }
  return { from: window.labelFrom, to: window.labelTo, days: window.days };
}

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {string}
 */
function oneOf(value, allowed) {
  const raw = String(value || '').trim().toLowerCase();
  return allowed.includes(raw) ? raw : '';
}

/**
 * Shared filter vocabulary for every usage read endpoint.
 *
 * @param {object} [query]
 * @returns {object}
 */
export function parseUsageFilters(query = {}) {
  return {
    role: String(query.role || query.purpose || '').trim().toLowerCase(),
    harness: String(query.harness || '').trim().toLowerCase(),
    origin: oneOf(query.origin, ['auto', 'manual', 'unknown']),
    workspaceFile: String(query.workspaceFile || query.workspace || query.workspace_folder || '').trim(),
    scope: oneOf(query.scope, ['own', 'consolidated']) || 'own',
    chatId: String(query.chatId || query.chat || '').trim(),
    subject: oneOf(query.subject, ['chat', 'delegation', 'internal']),
  };
}

/**
 * @param {unknown} window
 * @returns {{ from: string, to: string }}
 */
function windowResponseFields(window) {
  if (window.inputKind === 'day') {
    return { from: window.legacyDayFrom, to: window.legacyDayTo };
  }
  if (window.range === 'today' || window.range === 'month') {
    return { from: window.labelFrom, to: window.labelTo };
  }
  return { from: window.from, to: window.to };
}

/**
 * Reads the ledger for a window and applies the instant + filter vocabulary.
 *
 * @param {object} window
 * @param {object} filters
 * @param {{ dataDir?: string }} ctx
 * @returns {{ events: object[], runs: object[], ledger: object }}
 */
function readScopedUsage(window, filters, ctx) {
  const rawEvents = readUsageEvents({
    from: window.readFrom,
    to: window.readTo,
    dataDir: ctx.dataDir,
  });
  const events = filterUsageEvents(filterEventsByWindow(rawEvents, window), filters);
  let ledger = { runs: [] };
  try {
    ledger = readUsageLedgerState({ dataDir: ctx.dataDir });
  } catch {
    // Coverage degrades to an empty run cohort rather than hiding the tab.
    ledger = { runs: [] };
  }
  return { events, runs: Array.isArray(ledger.runs) ? ledger.runs : [], ledger };
}

/**
 * Count persisted pick proposals inside the window. `null` means the store
 * could not be read, never a guessed zero.
 *
 * @param {object} window
 * @param {Function} loadRecords
 * @returns {number|null}
 */
function countProposals(window, loadRecords) {
  try {
    const records = loadRecords();
    return Object.values(records || {}).filter((record) => {
      const ms = Date.parse(String(record?.createdAt || ''));
      if (!Number.isFinite(ms)) return true;
      return ms >= window.fromMs && ms < window.toMs;
    }).length;
  } catch {
    return null;
  }
}

/**
 * Delegation rows + the review-cycle signals for the choices panel.
 *
 * The rows carry the same cohort filter as {@link summarizeExecutedChoices}:
 * role, origin, workspace and the exact `[from, to)` window. Cycle signals
 * (technical success, acceptance, manual acceptance, review verdicts) are built
 * from that already-windowed cohort, so changing Today/24h/30d moves the
 * choices and their denominators together. `proposals` is counted inside the
 * same window; a proposal store that cannot be read stays `null`.
 * Loaders are injectable so the route stays testable without touching the
 * shared delegation store.
 *
 * @param {object} filters
 * @param {object} window
 * @param {{ loadDelegations?: Function, loadModelPickRecords?: Function }} [ctx]
 * @returns {object}
 */
function buildChoicesContext(filters, window, ctx = {}) {
  const loadRows = typeof ctx.loadDelegations === 'function' ? ctx.loadDelegations : loadDelegations;
  const loadRecords = typeof ctx.loadModelPickRecords === 'function'
    ? ctx.loadModelPickRecords
    : () => loadModelPickRecords();
  let rows = [];
  try {
    rows = loadRows();
  } catch {
    rows = [];
  }
  // One cohort for every aggregate: the same fields summarizeExecutedChoices
  // uses, plus the window, so cycles can never see rows the choices dropped.
  const rowFilters = {
    role: filters.role,
    origin: filters.origin,
    workspace: filters.workspaceFile,
    fromMs: window?.fromMs,
    toMs: window?.toMs,
  };
  const scopedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => delegationRowMatchesFilters(row, rowFilters));
  let cycleMetrics = {};
  const verdicts = { pass: 0, fail: 0, blocked: 0, undecided: 0 };
  let technicalSuccess = 0;
  let technicalDenominator = 0;
  try {
    const cycles = buildDelegationQualityCycles({ rows: scopedRows, includeOpen: true });
    cycleMetrics = summarizeDelegationCycleCostMetrics(cycles, { now: Date.now() });
    for (const cycle of cycles) {
      technicalDenominator += 1;
      if (cycle.technicalSuccess === true) technicalSuccess += 1;
      const list = Array.isArray(cycle.reviewVerdicts) ? cycle.reviewVerdicts : [];
      if (list.length === 0) {
        verdicts.undecided += 1;
        continue;
      }
      for (const verdict of list) {
        const key = String(verdict || '').toLowerCase();
        if (key === 'pass') verdicts.pass += 1;
        else if (key === 'fail') verdicts.fail += 1;
        else if (key === 'blocked') verdicts.blocked += 1;
        else verdicts.undecided += 1;
      }
    }
  } catch {
    cycleMetrics = {};
  }
  return {
    rows: scopedRows,
    proposals: countProposals(window, loadRecords),
    cycleMetrics,
    verdicts,
    technicalSuccess,
    technicalDenominator,
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string }} [ctx]
 */
export function registerUsageRoutes(app, ctx = {}) {
  app.get('/api/usage/plan-limits', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    return res.json({
      ok: true, planLimits: readHarnessPlanLimits('', { dataDir: ctx.dataDir }),
      lockouts: listHarnessUsageLimits(ctx.dataDir).map(({ harness, model, resetAt, code }) => ({ harness, model, resetAt, code })),
    });
  });

  app.get('/api/usage/settings', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const readSettings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
    return res.json({
      ok: true,
      settings: getUsageSettings(readSettings()),
      storage: summarizeUsageDataDir({ dataDir: ctx.dataDir }),
    });
  });

  // The usage Settings panel writes its own slice of config.json. Writing here,
  // next to the read endpoints, keeps retention/alerts independent from the
  // generic /api/settings shape while still reusing the same persisted file.
  app.post('/api/usage/settings', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const readSettings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
    const writeSettings = typeof ctx.saveSettings === 'function' ? ctx.saveSettings : saveSettings;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = body.usage && typeof body.usage === 'object' ? body.usage : body;
    const settings = readSettings();
    const next = applyUsageSettingsPatch(settings.usage, patch);
    settings.usage = next;
    writeSettings(settings);
    let pruned = null;
    if (body.pruneNow === true) {
      try {
        pruned = pruneUsageJournal({ dataDir: ctx.dataDir, retentionDays: next.retentionDays });
      } catch (error) {
        pruned = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return res.json({
      ok: true,
      settings: next,
      storage: summarizeUsageDataDir({ dataDir: ctx.dataDir }),
      ...(pruned ? { pruned } : {}),
    });
  });

  app.get('/api/usage/summary', (req, res) => {
    const window = resolveUsageWindow({ ...req.query, now: ctx.now });
    if (!window.ok) return res.status(400).json({ ok: false, error: window.error });
    const filters = parseUsageFilters(req.query);
    const { events, runs } = readScopedUsage(window, filters, ctx);
    const summary = summarizeUsage(events);
    // Disjoint buckets, cost provenance, zone-local days and coverage are added
    // beside the legacy summary so old readers keep their exact fields.
    summary.buckets = sumUsageTokenBuckets(events);
    summary.cost = sumUsageCost(events);
    summary.byZoneDay = groupEventsByZoneDay(events, window.tz);
    summary.kpi = buildUsageKpis(summary.byZoneDay, { now: ctx.now, tz: window.tz });
    summary.coverage = buildUsageCoverage({ runs, events, window, filters });
    summary.window = describeUsageWindow(window);
    summary.filters = filters;
    return res.json({ ok: true, ...windowResponseFields(window), tz: window.tz, window: describeUsageWindow(window), summary });
  });

  app.get('/api/usage/timeseries', (req, res) => {
    const window = resolveUsageWindow({ ...req.query, now: ctx.now });
    if (!window.ok) return res.status(400).json({ ok: false, error: window.error });
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
    const filters = parseUsageFilters(req.query);
    const { events } = readScopedUsage(window, filters, ctx);
    const timeseries = summarizeUsageTimeseries(events, {
      bucket,
      groupBy,
      metric,
      scope: filters.scope,
      tz: window.tz,
      fromMs: window.fromMs,
      toMs: window.toMs,
      from: window.inputKind === 'day' ? window.legacyDayFrom : window.labelFrom,
      to: window.inputKind === 'day' ? window.legacyDayTo : window.labelTo,
    });
    return res.json({
      ok: true,
      ...windowResponseFields(window),
      tz: window.tz,
      window: describeUsageWindow(window),
      filters,
      ...timeseries,
    });
  });

  app.get('/api/usage/models', (req, res) => {
    const window = resolveUsageWindow({ ...req.query, now: ctx.now });
    if (!window.ok) return res.status(400).json({ ok: false, error: window.error });
    const metric = String(req.query?.metric || 'tokens').trim() || 'tokens';
    if (!USAGE_MODEL_RANK_METRICS.includes(metric)) {
      return res.status(400).json({ ok: false, error: `Invalid metric (${USAGE_MODEL_RANK_METRICS.join('|')})` });
    }
    const requestedLimit = Number.parseInt(String(req.query?.limit ?? ''), 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_MODEL_LIMIT)
      : DEFAULT_MODEL_LIMIT;
    const filters = parseUsageFilters(req.query);
    const { events } = readScopedUsage(window, filters, ctx);
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
      .filter((row) => row.events > 0 || row.runs > 0)
      .sort((a, b) => {
        const primary = rankValue(b, metric) - rankValue(a, metric);
        if (primary !== 0) return primary;
        return b.totalTokens - a.totalTokens || a.model.localeCompare(b.model);
      })
      .slice(0, limit);
    return res.json({
      ok: true,
      ...windowResponseFields(window),
      tz: window.tz,
      window: describeUsageWindow(window),
      filters,
      metric,
      models,
    });
  });

  app.get('/api/usage/insights', (req, res) => {
    const window = resolveUsageWindow({ ...req.query, now: ctx.now });
    if (!window.ok) return res.status(400).json({ ok: false, error: window.error });
    const filters = parseUsageFilters(req.query);
    const { events, runs } = readScopedUsage(window, filters, ctx);
    const choices = buildChoicesContext(filters, window, ctx);
    const insights = buildUsageInsights({
      events,
      runs,
      window,
      filters: { ...filters, fromMs: window.fromMs, toMs: window.toMs },
      choicesRows: choices.rows,
      proposals: choices.proposals,
      cycleMetrics: choices.cycleMetrics,
      verdicts: choices.verdicts,
    });
    // The cycle-derived technical success denominator is exposed explicitly
    // rather than inferred from the delegation-row outcome.
    insights.signals.technicalSuccess = {
      n: choices.technicalSuccess,
      denominator: choices.technicalDenominator,
      ratio: choices.technicalDenominator > 0
        ? Number((choices.technicalSuccess / choices.technicalDenominator).toFixed(6))
        : null,
    };
    return res.json({
      ok: true,
      ...windowResponseFields(window),
      tz: window.tz,
      window: describeUsageWindow(window),
      insights,
    });
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
