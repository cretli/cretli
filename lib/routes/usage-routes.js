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
} from '../usage/usage-ledger.ts';
import { readHarnessContextSamples } from '../usage/harness-context-telemetry.ts';
import { analyzeContextCacheSeries } from '../usage/context-cache-series.ts';
import { evaluateSamplesCacheRegression } from '../usage/cache-regression-samples.ts';
import { inferObservedCacheTtlMs } from '../usage/cache-countdown.ts';
import { getCodexPlanLimits } from '../codex/codex-plan-limits.ts';
import { getKeepAliveScheduler, handleKeepAliveRequest } from '../usage/keep-alive-service.ts';
import { buildWorkflowBreakdown } from '../usage/workflow-breakdown.ts';
import { readHarnessPlanLimits } from '../usage/harness-health.ts';
import { listHarnessUsageLimits } from '../harness-usage-limits.js';
import {
  acknowledgeUnclassifiedSignature,
  listUnclassifiedSignatures,
} from '../usage/unclassified-errors.js';
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
} from '../usage/usage-insights.ts';
import {
  describeUsageWindow,
  filterEventsByWindow,
  resolveUsageWindow,
} from '../usage/usage-window.ts';
import { applyUsageSettingsPatch, getUsageSettings } from '../usage/usage-settings.ts';
import { pruneUsageJournal, summarizeUsageDataDir } from '../usage/usage-retention.ts';
import { buildChatCacheView } from '../usage/cache-freshness-view.ts';
import { buildResumeAdvice } from '../usage/resume-advice.ts';
import { getChatRunStateForChat } from '../chat-run-service.js';
import { getClaudeAuthMode } from '../claude/claude-auth-mode.ts';
import { loadSettings, saveSettings } from '../persist/settings.js';
import { loadUsageAdvice, loadUsageExplain, loadUsageLimitBurn, loadUsageTop } from '../usage/usage-top-read.ts';

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

/** How long GET /api/usage/plan-limits waits for a live Codex read. */
const PLAN_LIMITS_CODEX_WAIT_MS = 3000;

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
 * @param {Record<string, any>} [query]
 * @returns {Record<string, any>}
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
function windowResponseFields(/** @type {Record<string, any>} */ window) {
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
 * @param {Record<string, any>} window
 * @param {Record<string, any>} filters
 * @param {{ dataDir?: string }} ctx
 * @returns {{ events: Record<string, any>[], runs: Record<string, any>[], ledger: Record<string, any> }}
 */
function readScopedUsage(window, filters, ctx) {
  const rawEvents = readUsageEvents({
    from: window.readFrom,
    to: window.readTo,
    dataDir: ctx.dataDir,
  });
  const events = filterUsageEvents(filterEventsByWindow(rawEvents, window), filters);
  /** @type {Record<string, any>} */
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
 * GET /api/usage/summary payload; shared with the builtin MCP `usage_summary`.
 *
 * @param {Record<string, any>} query
 * @param {{ dataDir?: string, now?: any }} ctx
 * @returns {Record<string, any>}
 */
export function buildUsageSummaryResponse(query = {}, ctx = {}) {
  const window = resolveUsageWindow({ ...query, now: ctx.now });
  if (!window.ok) return { ok: false, error: window.error };
  const filters = parseUsageFilters(query);
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
  return { ok: true, ...windowResponseFields(window), tz: window.tz, window: describeUsageWindow(window), summary };
}

/**
 * GET /api/usage/plan-limits payload; shared with the builtin MCP
 * `usage_plan_limits`. A cold Codex read spawns the CLI and may take up to its
 * own 8 s timeout, so the stored plan limits do not wait for it: the read keeps
 * running and fills its cache (and the stored windows) for the next request.
 *
 * @param {{ dataDir?: string, readCodexPlanLimits?: Function }} ctx
 * @returns {Promise<Record<string, any>>}
 */
export async function buildPlanLimitsResponse(ctx = {}) {
  const codexRead = Promise.resolve((ctx.readCodexPlanLimits || getCodexPlanLimits)({ dataDir: ctx.dataDir }))
    .catch(() => ({ available: false, reason: 'read-failed' }));
  let codexTimer;
  const codexPending = new Promise((resolve) => {
    codexTimer = setTimeout(() => resolve({ available: false, reason: 'pending' }), PLAN_LIMITS_CODEX_WAIT_MS);
  });
  const codex = await Promise.race([codexRead, codexPending]).finally(() => clearTimeout(codexTimer));
  return {
    ok: true,
    codex,
    planLimits: readHarnessPlanLimits('', { dataDir: ctx.dataDir }),
    lockouts: listHarnessUsageLimits(ctx.dataDir).map(({ harness, model, resetAt, code, resetSource, rateLimitType }) => ({ harness, model, resetAt, code, resetSource, rateLimitType })),
  };
}

/**
 * Count persisted pick proposals inside the window. `null` means the store
 * could not be read, never a guessed zero.
 *
 * @param {Record<string, any>} window
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
 * @param {Record<string, any>} filters
 * @param {Record<string, any>} window
 * @param {Record<string, any>} [ctx]
 * @returns {Record<string, any>}
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
 * @param {{ dataDir?: string, readCodexPlanLimits?: typeof getCodexPlanLimits, [key: string]: any }} [ctx]
 */
export function registerUsageRoutes(app, ctx = {}) {
  // Unclassified provider errors: redacted signature list + "reviewed" (ACK). Session
  // access is enforced by the global requireAuth; widget/MCP callers are refused here.
  app.get('/api/usage/unclassified-errors', async (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    try {
      const items = await listUnclassifiedSignatures({
        dataDir: ctx.dataDir,
        harness: req.query?.harness,
        includeAcked: req.query?.includeAcked === '1',
      });
      return res.json({ ok: true, items });
    } catch {
      return res.status(500).json({ ok: false, error: 'Could not read unclassified errors' });
    }
  });

  app.post('/api/usage/unclassified-errors/ack', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = acknowledgeUnclassifiedSignature({ dataDir: ctx.dataDir, id: body.id, version: body.version });
    if (result.ok) return res.json({ ok: true, version: result.version });
    const status = result.reason === 'invalid_id' || result.reason === 'future_version' || result.reason === 'invalid_version' ? 400 : result.reason === 'unknown_episode' ? 404 : 409;
    return res.status(status).json({ ok: false, error: result.reason });
  });

  app.get('/api/usage/context-samples', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const range = parseUsageRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    return res.json({ ok: true, samples: readHarnessContextSamples({
      dataDir: ctx.dataDir, from: range.from, to: range.to,
      harness: req.query?.harness, chatId: req.query?.chatId,
      workspaceFile: req.query?.workspaceFile, workspaceFolder: req.query?.workspaceFolder,
      model: req.query?.model, runId: req.query?.runId, delegationId: req.query?.delegationId, role: req.query?.role,
    }) });
  });
  // Shared for every harness: one chat's context/cache time series plus detected cache breaks.
  app.get('/api/usage/context-cache-series', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const chatId = String(req.query?.chatId || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chatId is required' });
    const samples = readHarnessContextSamples({ dataDir: ctx.dataDir, chatId });
    // `regression` is the consumer of detectCacheRegression: a warm turn that lost its cache.
    return res.json({
      ok: true,
      ...analyzeContextCacheSeries(samples),
      regression: evaluateSamplesCacheRegression(samples, { ttlMs: inferObservedCacheTtlMs(samples) }),
    });
  });
  app.get('/api/usage/plan-limits', async (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    return res.json(await buildPlanLimitsResponse(ctx));
  });

  // Local read of the in-memory cache state: never issues a model request.
  app.get('/api/usage/cache-freshness', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const chatId = String(req.query?.chat_id || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chat_id is required' });
    const view = buildChatCacheView(chatId, { dataDir: ctx.dataDir });
    return res.json({ ok: true, freshness: view.freshness, countdown: view.countdown });
  });

  // Advisory only: decides from local state whether to offer a cheaper resume.
  app.get('/api/usage/resume-advice', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const chatId = String(req.query?.chat_id || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chat_id is required' });
    const view = buildChatCacheView(chatId, { dataDir: ctx.dataDir });
    const readSettings = typeof ctx.loadSettings === 'function' ? ctx.loadSettings : loadSettings;
    const runState = view.chat ? (ctx.getChatRunState || getChatRunStateForChat)(view.chat) : null;
    const advice = buildResumeAdvice({
      harness: view.harness,
      model: view.chat?.model || '',
      billingMode: view.harness === 'claude' ? getClaudeAuthMode() : '',
      freshness: view.freshness,
      countdown: view.countdown,
      samples: view.samples,
      settings: getUsageSettings(readSettings()).resumeAdvice,
      runActive: runState ? !!(runState.busy || runState.waitingForInput) : false,
    });
    return res.json({ ok: true, advice });
  });

  // Operator overview of keep-alive plans and the benchmark gate (local read).
  app.get('/api/usage/keep-alive', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    return res.json(getKeepAliveScheduler().overview());
  });

  // Optional paid cache keep-alive. `status` is a local read; `configure`,
  // `ping` and `stop` act only on a plan owned by `controllerChatId`.
  app.post('/api/usage/keep-alive', async (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await handleKeepAliveRequest({
      action: body.action,
      controllerChatId: body.controllerChatId,
      delegationId: body.delegationId,
      mode: body.mode,
      limits: body.limits,
      idempotencyKey: body.idempotencyKey,
      reason: body.reason,
    });
    return res.json(result);
  });

  // Usage per delegation leaf and round, with the cost origin kept split.
  app.get('/api/usage/workflow-breakdown', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const window = resolveUsageWindow({ ...req.query, now: ctx.now });
    if (!window.ok) return res.status(400).json({ ok: false, error: window.error });
    const filters = parseUsageFilters(req.query);
    const { events } = readScopedUsage(window, filters, ctx);
    const loadRows = typeof ctx.loadDelegations === 'function' ? ctx.loadDelegations : loadDelegations;
    let delegations = [];
    try {
      delegations = loadRows();
    } catch {
      delegations = [];
    }
    return res.json({
      ok: true,
      window: describeUsageWindow(window),
      breakdown: buildWorkflowBreakdown({
        events,
        delegations,
        keepAlivePings: getKeepAliveScheduler().listPings(),
      }),
    });
  });

  // Top consumers: ranked by fresh tokens (cache reads excluded) along one axis.
  app.get('/api/usage/top', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const result = loadUsageTop({ ...req.query, ...parseUsageFilters(req.query) }, { dataDir: ctx.dataDir, now: ctx.now });
    return res.status(result.ok ? 200 : 400).json(result);
  });

  // Which chats burned the harness's tokens in the look-back before each limit hit.
  app.get('/api/usage/limit-burn', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const result = loadUsageLimitBurn({ ...req.query, ...parseUsageFilters(req.query) }, { dataDir: ctx.dataDir, now: ctx.now });
    return res.status(result.ok ? 200 : 400).json(result);
  });

  app.get('/api/usage/advice', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const result = loadUsageAdvice({ ...req.query, ...parseUsageFilters(req.query) }, { dataDir: ctx.dataDir, now: ctx.now });
    return res.status(result.ok ? 200 : 400).json(result);
  });

  app.get('/api/usage/explain', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'Forbidden' });
    const result = loadUsageExplain({ ...req.query, ...parseUsageFilters(req.query) }, { dataDir: ctx.dataDir, now: ctx.now });
    return res.status(result.ok ? 200 : 400).json(result);
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
    const result = buildUsageSummaryResponse(req.query, ctx);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
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
 * @param {Record<string, any>} row
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
 * @param {Record<string, any>} row
 * @param {string} metric
 * @returns {number}
 */
function rankValue(row, metric) {
  if (metric === 'usd') return Number.isFinite(row?.usd) ? row.usd : 0;
  if (metric === 'events') return Number(row?.events) || 0;
  if (metric === 'runs') return Number(row?.runs) || 0;
  return sumGroupTokens(row);
}
