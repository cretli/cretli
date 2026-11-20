/**
 * Settings → Usage: KPI tiles, stacked chart, sortable model/harness table.
 *
 * Data comes from GET /api/usage/summary, /api/usage/timeseries and
 * /api/usage/models. Pure formatting/chart/sorting helpers live in
 * `usageCharts.js` so they can be unit-tested without a DOM.
 */

import { html, nothing } from 'lit';
import { getUsageSummary, getUsageTimeseries, getUsageModels, getDelegationStats, getUsageInsights, getUsageCacheFreshness, getUsageKeepAlive, stopUsageKeepAlive, getUsageWorkflowBreakdown, getUsageTop, getUsageLimitBurn, getChats } from '../../core/api/index.js';
import {
  applyUsageView,
  getUsageSection,
  normalizeUsageView,
  readStoredUsageView,
  refreshPlanLimitsPanel,
  storeUsageView,
  wireUsageViewTabs,
} from './usageViews.js';
import { initBillingPanel, refreshBillingPanel } from './billingPanel.js';
import {
  renderCacheFreshnessView,
  renderKeepAliveView,
  renderWorkflowBreakdownView,
  renderUsageTopView,
  renderLimitBurnView,
  sectionHint,
} from './usageInsightsView.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import './index.js';
import { usageState } from './state/usageState.js';
import { clearUsageContent, renderUsage } from './usageDom.js';
import { createDelegationStatsTokenGate } from './delegationStatsView.js';
import { renderDelegationStats, setDelegationStatsView } from './views/delegationStatsPanel.js';
import { renderInsights, renderInsightsError } from './views/usageInsightsPanel.js';
import {
  cancelLimitResumePause,
  refreshUsageSettingsPanel,
  submitLimitResumeSettings,
  submitUsageSettings,
} from './services/usageSettingsPanel.js';
import {
  renderBreakdownCardsView,
  renderBreakdownHeadView,
  renderBreakdownRowsView,
  renderChartTableHeadView,
  renderChartTableRowsView,
  renderLegendView,
  shareValue,
} from './views/usageBreakdownView.js';
import {
  buildChartModel,
  buildCsv,
  exportMetaRows,
  buildShareOfTotalPercent,
  unpricedReason,
  harnessRowsFromSummary,
  billingSourceRowsFromSummary,
  modelRowsFromPayload,
  renderStackedBarSvg,
  sortUsageRows,
  sumTokens,
} from './usageCharts.js';

export { refreshUsageSettingsPanel };

const RANGE_LABEL_KEYS = {
  today: 'usage.rangeToday',
  '24h': 'usage.range24h',
  '7d': 'usage.range7d',
  '30d': 'usage.range30d',
  month: 'usage.rangeMonth',
};

const METRIC_LABEL_KEYS = {
  tokens: 'usage.metricTokens',
  usd: 'usage.metricUsd',
  runs: 'usage.metricRuns',
};

const HARNESS_LABEL_KEYS = {
  sdk: 'usage.harnessSdk',
  claude: 'usage.harnessClaude',
  mistral: 'usage.harnessMistral',
  zai: 'usage.harnessZai',
  mimo: 'usage.harnessMimo',
  codex: 'usage.harnessCodex',
  opencode: 'usage.harnessOpencode',
  codebuddy: 'usage.harnessCodebuddy',
  deepseek: 'usage.harnessDeepseek',
  qwen: 'usage.harnessQwen',
  openrouter: 'usage.harnessOpenrouter',
  voice: 'usage.harnessVoice',
  unknown: 'usage.harnessUnknown',
};

/**
 * @param {'tokens'|'usd'|'runs'} metric
 * @returns {'tokens'|'usd'|'runs'}
 */
function defaultSortKey(metric) {
  return metric === 'usd' || metric === 'runs' ? metric : 'tokens';
}

/**
 * @param {string} harness
 * @returns {string}
 */
function harnessLabel(harness) {
  const key = HARNESS_LABEL_KEYS[String(harness || '').toLowerCase()];
  return key ? t(key) : String(harness || '');
}

/** @param {string} source @returns {string} */
function billingSourceLabel(source) {
  if (source === 'vibe_code') return t('usage.billingSourceVibeCode');
  if (source === 'api') return t('usage.billingSourceApi');
  return t('usage.billingSourceUnclassified');
}

/** @returns {string} UTC day; fallback only when Intl is unavailable. */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Calendar day in the selected IANA zone (`YYYY-MM-DD`).
 *
 * @param {Date} [date]
 * @returns {string}
 */
function zoneDayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: state.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Browser zone when it is a valid IANA name; otherwise UTC.
 *
 * @returns {string}
 */
function resolvedZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) return zone;
  } catch {
    /* fall through to UTC */
  }
  return 'UTC';
}

/**
 * Zones offered by the time-zone select. Uses the platform list when present
 * and always includes the active zone.
 *
 * @returns {string[]}
 */
function timeZoneOptions() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      const zones = Intl.supportedValuesOf('timeZone');
      if (Array.isArray(zones) && zones.length > 0) {
        return zones.includes(state.tz) ? zones : [state.tz, ...zones];
      }
    }
  } catch {
    /* fall through to a small fixed list */
  }
  const fallback = ['UTC', 'Europe/Warsaw', 'America/New_York', 'Asia/Tokyo'];
  return fallback.includes(state.tz) ? fallback : [state.tz, ...fallback];
}

const state = {
  range: '7d',
  metric: 'tokens',
  groupBy: 'model',
  sortKey: 'tokens',
  sortDir: 'desc',
  tz: resolvedZone(),
  role: '',
  origin: '',
  // Accounting scope is alternative, never additive: `own` is this instance,
  // `consolidated` adds child/cycle usage.
  scope: 'own',
  // Display subject taxonomy: chat | delegation | internal ('' = all).
  subject: '',
  // Empty means instance-wide; otherwise the active header workspace file.
  workspaceFile: '',
  rows: [],
  sortedRows: [],
  summary: null,
  insights: null,
  window: null,
};

let requestToken = 0;
const delegationStatsGate = createDelegationStatsTokenGate();
let wired = false;

/**
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function byId(id) {
  return document.getElementById(id);
}

/**
 * Active workspace scope, read from the header trigger the same way the
 * delegation center does. Without it the stats endpoint sees every chat of the
 * installation when the query is empty.
 *
 * @returns {{ workspaceFolder: string, workspaceFile: string }}
 */
function getActiveWorkspaceScope() {
  if (typeof document === 'undefined') return { workspaceFolder: '', workspaceFile: '' };
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFolder: String(trigger?.dataset?.workspaceFolder || '').trim(),
    workspaceFile: String(trigger?.dataset?.workspaceFile || '').trim(),
  };
}

/**
 * The single filter object every read endpoint receives, so the chart, table,
 * tooltips and CSV cannot diverge.
 *
 * @returns {object}
 */
function filterQuery() {
  return {
    tz: state.tz,
    role: state.role,
    origin: state.origin,
    scope: state.scope,
    subject: state.subject,
    ...(state.workspaceFile ? { workspaceFile: state.workspaceFile } : {}),
  };
}

/**
 * @param {'today'|'24h'|'7d'|'30d'|'month'} range
 * @returns {object}
 */
function rangeQuery(range) {
  return { ...filterQuery(), range };
}

/** Wide enough for both the calendar month and the last 7 days in the zone. */
function kpiQuery() {
  return { ...filterQuery(), range: 'month7d' };
}

/**
 * @param {object} summary
 * @returns {void}
 */
function renderKpis(summary) {
  // The KPI cards are rendered by <cr-usage-kpis> from the shared signals.
  usageState.zoneDay.set(zoneDayKey());
  usageState.language.set(getCurrentLang());
  usageState.summary.set(summary);
  const totalTokens = sumTokens(summary?.tokens);
  const hasAny =
    totalTokens > 0 ||
    Number(summary?.totalUsd) > 0 ||
    Number(summary?.estimatedUsd) > 0 ||
    Number(summary?.unpricedEvents) > 0 ||
    Number(summary?.runs) > 0;
  const emptyEl = byId('usage-summary-empty');
  if (emptyEl) emptyEl.hidden = hasAny;
}

/**
 * Accessible alternative to the SVG chart.
 *
 * @param {ReturnType<typeof buildChartModel>} model
 * @param {string} metric
 * @param {string} lang
 * @param {boolean} hasData
 * @returns {void}
 */
function renderChartTable(model, metric, lang, hasData) {
  const table = byId('usage-chart-table');
  if (!table) return;
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  if (!thead || !tbody) return;
  if (!hasData) {
    clearUsageContent(thead);
    clearUsageContent(tbody);
    return;
  }
  renderUsage(thead, renderChartTableHeadView(model, t));
  renderUsage(tbody, renderChartTableRowsView(model, metric, lang));
}

/**
 * @param {object} timeseries
 * @returns {void}
 */
function renderChart(timeseries) {
  const lang = getCurrentLang();
  const metric = state.metric;
  const model = buildChartModel(timeseries, {
    otherLabel: t('usage.other'),
    labelFor: state.groupBy === 'harness' ? harnessLabel : (state.groupBy === 'billingSource' ? billingSourceLabel : undefined),
  });
  const chartEl = byId('usage-chart');
  const legendEl = byId('usage-chart-legend');
  const emptyEl = byId('usage-chart-empty');
  const titleEl = byId('usage-chart-title');
  const groupLabel = t(state.groupBy === 'harness' ? 'usage.groupByHarness' : (state.groupBy === 'billingSource' ? 'usage.groupByBillingSource' : 'usage.groupByModel'));
  const metricLabel = t(METRIC_LABEL_KEYS[metric] || 'usage.metricTokens');
  if (titleEl) {
    titleEl.textContent = t('usage.chartTitleDynamic', { metric: metricLabel, group: groupLabel });
  }
  const hasData = model.series.length > 0 && Number(model.max) > 0;
  if (chartEl) {
    renderUsage(chartEl, hasData ? renderStackedBarSvg(model, { lang, metric }) : nothing);
    chartEl.setAttribute('role', 'img');
    chartEl.setAttribute(
      'aria-label',
      t('usage.chartAria', {
        metric: metricLabel,
        group: groupLabel,
        range: t(RANGE_LABEL_KEYS[state.range] || 'usage.range7d'),
      })
    );
  }
  if (legendEl) renderUsage(legendEl, hasData ? renderLegendView(model, metric, lang) : nothing);
  if (emptyEl) emptyEl.hidden = hasData;
  renderChartTable(model, metric, lang, hasData);
}

/**
 * @param {object[]} rows
 * @returns {number}
 */
function maxShare(rows) {
  return rows.reduce((peak, row) => Math.max(peak, shareValue(row, state.sortKey)), 0);
}

/**
 * Cohort total of the active metric; the share text is a percentage of this,
 * so every row's share adds up to 100% of the selected cohort.
 *
 * @param {object[]} rows
 * @returns {number}
 */
function shareTotal(rows) {
  return rows.reduce((sum, row) => sum + shareValue(row, state.sortKey), 0);
}

/**
 * @param {object} row
 * @returns {string}
 */
function rowLabel(row) {
  return row.harness ? harnessLabel(row.harness) : row.label;
}

/**
 * @returns {Array<{ key: string, labelKey: string, sortable: boolean }>}
 */
function tableColumns() {
  return [
    { key: 'label', labelKey: state.groupBy === 'harness' ? 'usage.colHarness' : (state.groupBy === 'billingSource' ? 'usage.groupByBillingSource' : 'usage.colModel'), sortable: false },
    { key: 'usd', labelKey: 'usage.colCost', sortable: true },
    { key: 'tokens', labelKey: 'usage.colTokens', sortable: true },
    { key: 'runs', labelKey: 'usage.colRuns', sortable: true },
    { key: 'successRate', labelKey: 'usage.colSuccess', sortable: true },
    { key: 'p95', labelKey: 'usage.colP95', sortable: true },
    { key: 'share', labelKey: 'usage.colShare', sortable: false },
  ];
}

/**
 * @returns {void}
 */
function renderTableHead() {
  renderUsage(byId('usage-breakdown-head'), renderBreakdownHeadView(tableColumns(), state, t));
}

/**
 * @param {object[]} rows
 * @returns {void}
 */
function renderTable(rows) {
  const lang = getCurrentLang();
  const sorted = sortUsageRows(rows, state.sortKey, state.sortDir);
  state.sortedRows = sorted;
  renderTableHead();
  const titleEl = byId('usage-table-title');
  if (titleEl) {
    titleEl.textContent = t(state.groupBy === 'harness' ? 'usage.byHarness' : (state.groupBy === 'billingSource' ? 'usage.groupByBillingSource' : 'usage.byModel'));
  }
  const body = byId('usage-breakdown-body');
  const cards = byId('usage-breakdown-cards');
  const emptyEl = byId('usage-breakdown-empty');
  const table = byId('usage-breakdown');
  const max = maxShare(sorted);
  const total = shareTotal(sorted);
  const ctx = { max, total, lang, sortKey: state.sortKey, t, label: rowLabel };
  if (body) renderUsage(body, renderBreakdownRowsView(sorted, ctx));
  if (cards) renderUsage(cards, renderBreakdownCardsView(sorted, ctx));
  const hasRows = sorted.length > 0;
  if (table) table.hidden = !hasRows;
  if (cards) cards.hidden = !hasRows;
  if (emptyEl) emptyEl.hidden = hasRows;
}

/**
 * Refresh only the delegation outcomes panel (its own endpoint) without
 * reloading the usage ledger. Used by the panel refresh/retry buttons.
 *
 * @returns {Promise<void>}
 */
export async function refreshDelegationStatsSettings() {
  if (typeof document === 'undefined') return;
  const section = document.querySelector('.settings-section[data-settings-tab="usage"]');
  if (!section) return;
  const token = delegationStatsGate.begin();
  setDelegationStatsView('loading');
  const [result] = await Promise.allSettled([getDelegationStats(getActiveWorkspaceScope())]);
  if (!delegationStatsGate.isCurrent(token)) return;
  renderDelegationStats(result);
}

/**
 * @param {'loading'|'ready'|'error'} view
 * @returns {void}
 */
function setView(view) {
  const loadingEl = byId('usage-loading');
  const errorEl = byId('usage-error');
  const errorTextEl = byId('usage-error-text');
  const contentEl = byId('usage-content');
  if (loadingEl) loadingEl.hidden = view !== 'loading';
  if (errorEl) errorEl.hidden = view !== 'error';
  if (contentEl) contentEl.hidden = view !== 'ready';
  if (view === 'error' && errorTextEl) errorTextEl.textContent = t('usage.loadFailed');
}

/**
 * Hides or shows a per-section inline error element.
 *
 * @param {string} id
 * @param {string|null} message null to hide
 * @returns {void}
 */
function setSectionError(id, message) {
  const el = byId(id);
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/**
 * Fills the chat select once (keeps the selection) and paints the cache
 * freshness of the selected chat. Local read only.
 *
 * @returns {Promise<void>}
 */
async function refreshCacheFreshness() {
  const select = byId('usage-cache-chat-select');
  const el = byId('usage-cache-freshness');
  if (!select || !el) return;
  const lang = getCurrentLang();
  try {
    if (select.options.length === 0) {
      const data = await getChats();
      const chats = Array.isArray(data?.chats) ? data.chats : [];
      renderUsage(select, chats.map((chat) => html`<option value=${chat.id}>${chat.title || chat.id}</option>`));
    }
    if (!select.value) {
      renderUsage(el, sectionHint(t('usage.cacheNoData')));
      return;
    }
    const result = await getUsageCacheFreshness(select.value);
    renderUsage(el, renderCacheFreshnessView(result?.ok ? result.freshness : null, { t, lang }));
  } catch {
    renderUsage(el, sectionHint(t('usage.sectionLoadFailed')));
  }
}

/**
 * Paints the keep-alive plans (local read; it never sends a ping).
 *
 * @returns {Promise<void>}
 */
async function refreshKeepAlive() {
  const el = byId('usage-keepalive');
  if (!el) return;
  try {
    const result = await getUsageKeepAlive();
    renderUsage(el, renderKeepAliveView(result?.ok ? result : null, { t, lang: getCurrentLang() }));
  } catch {
    renderUsage(el, sectionHint(t('usage.sectionLoadFailed')));
  }
}

/**
 * @returns {Promise<void>}
 */
async function refreshWorkflowBreakdown() {
  const el = byId('usage-workflow');
  if (!el) return;
  try {
    const result = await getUsageWorkflowBreakdown(rangeQuery(state.range));
    renderUsage(el, renderWorkflowBreakdownView(result?.ok ? result.breakdown : null, { t, lang: getCurrentLang() }));
  } catch {
    renderUsage(el, sectionHint(t('usage.sectionLoadFailed')));
  }
}

/**
 * Top consumers panel: ranked by fresh tokens along the chosen axis.
 *
 * @returns {Promise<void>}
 */
async function refreshUsageTop() {
  const el = byId('usage-top');
  if (!el) return;
  const groupBy = byId('usage-top-group')?.value || 'chat';
  const metric = byId('usage-top-metric')?.value || 'fresh';
  try {
    const result = await getUsageTop({ ...rangeQuery(state.range), groupBy, metric, limit: 25 });
    renderUsage(el, renderUsageTopView(result?.ok ? result : null, { t, lang: getCurrentLang() }));
  } catch {
    renderUsage(el, sectionHint(t('usage.sectionLoadFailed')));
  }
}

/**
 * Limit-burn panel: who consumed the harness's tokens before each limit hit.
 *
 * @returns {Promise<void>}
 */
async function refreshLimitBurn() {
  const el = byId('usage-limit-burn');
  if (!el) return;
  try {
    const result = await getUsageLimitBurn({ ...rangeQuery(state.range), limit: 8 });
    renderUsage(el, renderLimitBurnView(result?.ok ? result : null, { t, lang: getCurrentLang() }));
  } catch {
    renderUsage(el, sectionHint(t('usage.sectionLoadFailed')));
  }
}

let activeUsageView = readStoredUsageView();

/** @returns {string} */
export function getActiveUsageView() {
  return activeUsageView;
}

/**
 * Switch the Usage sub-view and load only what it shows.
 *
 * @param {string} view
 * @returns {void}
 */
export function setUsageView(view) {
  activeUsageView = normalizeUsageView(view);
  storeUsageView(activeUsageView);
  applyUsageView(activeUsageView);
  const section = getUsageSection();
  if (section && !section.hidden) void refreshUsageSettings();
}

/**
 * Reloads the active Usage sub-view. Each view fetches only its own endpoints,
 * so opening the tab no longer fires a dozen ledger scans at once (they
 * queued behind each other and timed out on a busy instance).
 *
 * @returns {Promise<void>}
 */
export async function refreshUsageSettings() {
  if (typeof document === 'undefined') return;
  if (!getUsageSection()) return;
  const view = activeUsageView;
  applyUsageView(view);
  if (view === 'billing') {
    await refreshBillingPanel();
    return;
  }
  if (view === 'limits') {
    // The auto-resume form and list are painted by the settings panel loader.
    await Promise.allSettled([refreshPlanLimitsPanel(), refreshUsageSettingsPanel()]);
    return;
  }
  if (view === 'delegations') {
    await refreshDelegationStatsSettings();
    return;
  }
  if (view === 'settings') {
    await refreshUsageSettingsPanel();
    return;
  }
  await refreshLedgerView(/** @type {'overview'|'analysis'} */ (view));
}

/**
 * Overview: KPIs, buckets, coverage, chart and table. Analysis: executed
 * choices, signals and the per-panel reads. Promise.allSettled keeps a single
 * failing request to its own section; the global error banner appears only
 * when every ledger request of the view failed.
 *
 * @param {'overview'|'analysis'} view
 * @returns {Promise<void>}
 */
async function refreshLedgerView(view) {
  const token = ++requestToken;
  setView('loading');
  const query = rangeQuery(state.range);
  if (view === 'analysis') {
    void refreshCacheFreshness();
    void refreshWorkflowBreakdown();
    void refreshUsageTop();
    void refreshLimitBurn();
    void refreshKeepAlive();
    const [insightsResult] = await Promise.allSettled([getUsageInsights(query)]);
    if (token !== requestToken) return;
    if (!applyInsightsResult(insightsResult)) {
      setView('error');
      return;
    }
    setView('ready');
    return;
  }

  const [summaryResult, chartResult, tableResult, insightsResult] = await Promise.allSettled([
    getUsageSummary(kpiQuery()),
    getUsageTimeseries({
      ...query,
      bucket: state.range === '24h' || state.range === 'today' ? 'hour' : 'day',
      groupBy: state.groupBy,
      metric: state.metric,
    }),
    state.groupBy === 'harness' || state.groupBy === 'billingSource'
      ? getUsageSummary(query)
      : getUsageModels({ ...query, metric: 'tokens' }),
    getUsageInsights(query),
  ]);

  if (token !== requestToken) return;

  const allFailed = [summaryResult, chartResult, tableResult].every(
    (r) => r.status === 'rejected' || !r.value?.ok
  );
  if (allFailed) {
    const firstReason =
      summaryResult.status === 'rejected'
        ? summaryResult.reason
        : (summaryResult.value?.error || 'all requests failed');
    console.warn('[usage] all requests failed:', firstReason);
    setView('error');
    return;
  }
  const periodEl = byId('usage-summary-period');
  if (periodEl) {
    // The summary is read over the wider KPI window (month + 7 days); the
    // period line describes the selected range, which insights is read with.
    /** @type {Record<string, any> | null} */
    const win = insightsResult.status === 'fulfilled' && insightsResult.value?.window
      ? insightsResult.value.window
      : null;
    periodEl.textContent = win
      ? t('usage.periodZone', {
        from: String(win.from_day || win.from || ''),
        to: String(win.to_day || win.to || ''),
        tz: String(win.tz || state.tz),
      })
      : '';
  }

  // KPI summary
  if (summaryResult.status === 'fulfilled' && summaryResult.value?.ok && summaryResult.value.summary) {
    state.summary = summaryResult.value.summary;
    renderKpis(state.summary);
    setSectionError('usage-kpi-error', null);
  } else {
    const reason =
      summaryResult.status === 'rejected'
        ? summaryResult.reason?.message || String(summaryResult.reason)
        : (summaryResult.value?.error || 'summary request failed');
    console.warn('[usage] summary failed:', reason);
    setSectionError('usage-kpi-error', t('usage.sectionLoadFailed'));
  }

  // Timeseries chart
  if (chartResult.status === 'fulfilled' && chartResult.value?.ok) {
    renderChart(chartResult.value);
    setSectionError('usage-chart-section-error', null);
  } else {
    const reason =
      chartResult.status === 'rejected'
        ? chartResult.reason?.message || String(chartResult.reason)
        : (chartResult.value?.error || 'timeseries request failed');
    console.warn('[usage] timeseries failed:', reason);
    setSectionError('usage-chart-section-error', t('usage.sectionLoadFailed'));
  }

  // Model/harness table
  if (tableResult.status === 'fulfilled' && tableResult.value?.ok) {
    state.rows =
      state.groupBy === 'harness'
        ? harnessRowsFromSummary(tableResult.value.summary)
        : (state.groupBy === 'billingSource'
          ? billingSourceRowsFromSummary(tableResult.value.summary)
          : modelRowsFromPayload(tableResult.value.models));
    renderTable(state.rows);
    setSectionError('usage-table-section-error', null);
  } else {
    const reason =
      tableResult.status === 'rejected'
        ? tableResult.reason?.message || String(tableResult.reason)
        : (tableResult.value?.error || 'models request failed');
    console.warn('[usage] models/table failed:', reason);
    setSectionError('usage-table-section-error', t('usage.sectionLoadFailed'));
  }

  applyInsightsResult(insightsResult);

  setView('ready');
}

/**
 * Paints buckets, coverage, executed choices and signals from one insights
 * response.
 *
 * @param {PromiseSettledResult<any>} insightsResult
 * @returns {boolean} whether the insights loaded
 */
function applyInsightsResult(insightsResult) {
  if (insightsResult.status === 'fulfilled' && insightsResult.value?.ok && insightsResult.value.insights) {
    state.insights = insightsResult.value.insights;
    state.window = insightsResult.value.window || null;
    renderInsights(state.insights);
    setSectionError('usage-choices-error', null);
    return true;
  }
  const reason =
    insightsResult.status === 'rejected'
      ? insightsResult.reason?.message || String(insightsResult.reason)
      : (insightsResult.value?.error || 'insights request failed');
  console.warn('[usage] insights failed:', reason);
  renderInsightsError();
  setSectionError('usage-choices-error', t('usage.sectionLoadFailed'));
  return false;
}

/**
 * @returns {void}
 */
function exportCsv() {
  const rows = state.sortedRows || [];
  const header = [
    t(state.groupBy === 'harness' ? 'usage.colHarness' : (state.groupBy === 'billingSource' ? 'usage.groupByBillingSource' : 'usage.colModel')),
    t('usage.colCost'),
    t('usage.colEstimated'),
    t('usage.colTokens'),
    t('usage.colRuns'),
    t('usage.colSuccess'),
    t('usage.colP95'),
    t('usage.colShare'),
  ];
  const total = shareTotal(rows);
  const data = rows.map((row) => {
    const reason = unpricedReason(row);
    const cost = reason
      ? t(reason === 'subscription' ? 'usage.subscription' : 'usage.unpriced')
      : (Number.isFinite(Number(row.usd)) && Number(row.usd) > 0 ? Number(row.usd).toFixed(6) : '0');
    const share = buildShareOfTotalPercent(shareValue(row), total);
    return [
      rowLabel(row),
      cost,
      Number(row.estimatedUsd) > 0 ? Number(row.estimatedUsd).toFixed(6) : '',
      row.totalTokens,
      row.runs,
      row.successRate == null ? '' : `${Math.round(row.successRate * 1000) / 10}%`,
      row.p95LatencyMs == null ? '' : row.p95LatencyMs,
      share == null ? '' : `${share}%`,
    ];
  });
  // Scope, zone, filters, coverage and versions travel with the numbers so an
  // exported file can never be read without its coverage context.
  const meta = exportMetaRows({
    window: state.window || {},
    filters: {
      scope: state.scope,
      subject: state.subject,
      role: state.role,
      origin: state.origin,
      workspaceFile: state.workspaceFile,
    },
    coverage: state.insights?.coverage,
    version: state.insights,
  });
  const csv = buildCsv(header, [...meta, [], ...data]);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cretli-usage-${state.groupBy}-${todayIso()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Wires controls and the language-change reload. First paint happens when the
 * tab opens.
 *
 * @returns {void}
 */
export function initUsageSettings() {
  if (typeof window === 'undefined' || wired) return;
  wired = true;
  mountUsageKpis();
  initBillingPanel();
  wireUsageViewTabs(setUsageView);
  applyUsageView(activeUsageView);
  const rangeSelect = byId('usage-range-select');
  const metricSelect = byId('usage-metric-select');
  const groupSelect = byId('usage-group-select');
  byId('usage-resume-save')?.addEventListener('click', () => { void submitLimitResumeSettings(); });
  byId('usage-resume-list')?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-limit-resume-cancel]') : null;
    if (button) void cancelLimitResumePause(button.getAttribute('data-limit-resume-cancel') || '');
  });
  byId('usage-keepalive')?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-keepalive-stop]') : null;
    if (!button) return;
    void stopUsageKeepAlive({
      controllerChatId: button.getAttribute('data-keepalive-controller') || '',
      delegationId: button.getAttribute('data-keepalive-stop') || '',
    }).finally(() => refreshKeepAlive());
  });
  byId('usage-top-group')?.addEventListener('change', () => { void refreshUsageTop(); });
  byId('usage-top-metric')?.addEventListener('change', () => { void refreshUsageTop(); });
  byId('usage-cache-chat-select')?.addEventListener('change', () => {
    void refreshCacheFreshness();
  });
  if (rangeSelect) {
    rangeSelect.value = state.range;
    rangeSelect.addEventListener('change', () => {
      state.range = rangeSelect.value;
      void refreshUsageSettings();
    });
  }
  if (metricSelect) {
    metricSelect.value = state.metric;
    metricSelect.addEventListener('change', () => {
      state.metric = metricSelect.value;
      state.sortKey = defaultSortKey(state.metric);
      state.sortDir = 'desc';
      void refreshUsageSettings();
    });
  }
  if (groupSelect) {
    groupSelect.value = state.groupBy;
    groupSelect.addEventListener('change', () => {
      state.groupBy = groupSelect.value;
      void refreshUsageSettings();
    });
  }
  const tzSelect = byId('usage-tz-select');
  if (tzSelect) {
    renderUsage(tzSelect, timeZoneOptions()
      .map((zone) => html`<option value=${zone}>${zone}</option>`));
    tzSelect.value = state.tz;
    tzSelect.addEventListener('change', () => {
      state.tz = tzSelect.value || 'UTC';
      void refreshUsageSettings();
    });
  }
  const roleSelect = byId('usage-role-select');
  if (roleSelect) {
    roleSelect.value = state.role;
    roleSelect.addEventListener('change', () => {
      state.role = roleSelect.value;
      void refreshUsageSettings();
    });
  }
  const originSelect = byId('usage-origin-select');
  if (originSelect) {
    originSelect.value = state.origin;
    originSelect.addEventListener('change', () => {
      state.origin = originSelect.value;
      void refreshUsageSettings();
    });
  }
  const scopeSelect = byId('usage-scope-select');
  if (scopeSelect) {
    scopeSelect.value = state.scope;
    scopeSelect.addEventListener('change', () => {
      state.scope = scopeSelect.value === 'consolidated' ? 'consolidated' : 'own';
      void refreshUsageSettings();
    });
  }
  const subjectSelect = byId('usage-subject-select');
  if (subjectSelect) {
    subjectSelect.value = state.subject;
    subjectSelect.addEventListener('change', () => {
      state.subject = subjectSelect.value;
      void refreshUsageSettings();
    });
  }
  const workspaceSelect = byId('usage-workspace-select');
  if (workspaceSelect) {
    const activeOption = workspaceSelect.querySelector('option[value="__active__"]');
    const scope = getActiveWorkspaceScope();
    if (activeOption && scope.workspaceFile) activeOption.textContent = scope.workspaceFile;
    workspaceSelect.value = state.workspaceFile ? '__active__' : '';
    workspaceSelect.addEventListener('change', () => {
      state.workspaceFile = workspaceSelect.value === '__active__'
        ? getActiveWorkspaceScope().workspaceFile
        : '';
      void refreshUsageSettings();
    });
  }
  byId('usage-retry')?.addEventListener('click', () => {
    void refreshUsageSettings();
  });
  byId('usage-export-csv')?.addEventListener('click', () => {
    exportCsv();
  });
  byId('delegation-stats-refresh')?.addEventListener('click', () => {
    void refreshDelegationStatsSettings();
  });
  byId('delegation-stats-retry')?.addEventListener('click', () => {
    void refreshDelegationStatsSettings();
  });
  byId('usage-breakdown-head')?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-sort-key]');
    if (!button) return;
    const key = button.getAttribute('data-sort-key');
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'desc';
    }
    renderTable(state.rows);
  });
  const refreshUsageIfVisible = () => {
    const section = document.querySelector('.settings-section[data-settings-tab="usage"]');
    if (section && !section.hidden) void refreshUsageSettings();
  };
  window.addEventListener('cr-lang-changed', () => {
    usageState.language.set(getCurrentLang());
    refreshUsageIfVisible();
  });
  // The stats endpoint is workspace-scoped, so a workspace switch (active
  // workspace or workspace configuration) must reload the whole panel instead
  // of showing the previous workspace's aggregate.
  window.addEventListener('cretli-workspace-updated', refreshUsageIfVisible);
  window.addEventListener('cretli-active-workspace-changed', refreshUsageIfVisible);
  byId('usage-settings-save')?.addEventListener('click', () => {
    void submitUsageSettings(false);
  });
  byId('usage-settings-prune')?.addEventListener('click', () => {
    void submitUsageSettings(true);
  });
  // The storage line is built in JS, so a language switch must repaint it.
  window.addEventListener('cr-lang-changed', () => {
    void refreshUsageSettingsPanel();
  });
}

/** Replace the legacy KPI children with the reactive Lit view once. */
function mountUsageKpis() {
  const host = byId('usage-kpis');
  if (!host || host.querySelector('cr-usage-kpis')) return;
  const view = document.createElement('cr-usage-kpis');
  view.state = usageState;
  host.replaceChildren(view);
}

export { harnessLabel, state as usageUiState };
