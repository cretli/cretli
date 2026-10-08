/**
 * Settings → Usage: KPI tiles, stacked chart, sortable model/harness table.
 *
 * Data comes from GET /api/usage/summary, /api/usage/timeseries and
 * /api/usage/models. Pure formatting/chart/sorting helpers live in
 * `usageCharts.js` so they can be unit-tested without a DOM.
 */

import { getUsagePlanLimits, getUsageSummary, getUsageTimeseries, getUsageModels, getDelegationStats } from '../../api.js';
import { renderPlanLimitsHtml } from './planLimitsView.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import { formatUsd } from '../../../lib/usage/usage-rates.js';
import {
  createDelegationStatsTokenGate,
  delegationStatsRows,
  delegationStatsUnused,
  delegationStatsUnusedState,
  delegationStatsViewState,
  renderDelegationStatsCardsHtml,
  renderDelegationStatsHeadHtml,
  renderDelegationStatsMetaHtml,
  renderDelegationStatsRowsHtml,
  renderDelegationUnusedHtml,
  delegationLoopLeaves,
  delegationLoopViewState,
  renderDelegationLoopCardsHtml,
  renderDelegationLoopHeadHtml,
  renderDelegationLoopRowsHtml,
} from './delegationStatsView.js';
import {
  addDaysIso,
  buildChartModel,
  buildCsv,
  buildSharePercent,
  escapeHtml,
  formatChartValue,
  formatCompactNumber,
  formatInteger,
  formatPercent,
  harnessRowsFromSummary,
  modelRowsFromPayload,
  renderStackedBarSvg,
  sortUsageRows,
  sumDayWindow,
  sumTokens,
  unpricedReason,
  usageSortValue,
} from './usageCharts.js';

const RANGE_LABEL_KEYS = {
  '24h': 'usage.range24h',
  '7d': 'usage.range7d',
  '30d': 'usage.range30d',
};

const METRIC_LABEL_KEYS = {
  tokens: 'usage.metricTokens',
  usd: 'usage.metricUsd',
  runs: 'usage.metricRuns',
};

const HARNESS_LABEL_KEYS = {
  sdk: 'usage.harnessSdk',
  claude: 'usage.harnessClaude',
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

/** @returns {string} UTC day, matching the backend default. */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {string} iso
 * @returns {string}
 */
function monthStartIso(iso) {
  return `${String(iso || '').slice(0, 7)}-01`;
}

const state = {
  range: '7d',
  metric: 'tokens',
  groupBy: 'model',
  sortKey: 'tokens',
  sortDir: 'desc',
  rows: [],
  sortedRows: [],
  summary: null,
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
 * @param {'24h'|'7d'|'30d'} range
 * @returns {{ from: string, to: string }}
 */
function rangeQuery(range) {
  const to = todayIso();
  if (range === '24h') return { from: to, to };
  if (range === '30d') return { from: addDaysIso(to, -29), to };
  return { from: addDaysIso(to, -6), to };
}

/** Range that still contains both the calendar month and the 7-day window. */
function kpiQuery() {
  const to = todayIso();
  const monthStart = monthStartIso(to);
  const weekStart = addDaysIso(to, -6);
  return { from: monthStart < weekStart ? monthStart : weekStart, to };
}

/**
 * @param {object} data
 * @returns {string}
 */
function costText(data) {
  const usd = Number(data?.usd);
  if (Number.isFinite(usd) && usd > 0) return formatUsd(usd);
  if (Number(data?.estimatedUsd) > 0) return '—';
  if (Number(data?.unpricedEvents) > 0) return t('usage.unpriced');
  return '$0.00';
}

/**
 * @param {string} id today|week|month
 * @param {object} data
 * @param {string} lang
 * @returns {void}
 */
function paintKpi(id, data, lang) {
  const costEl = byId(`usage-kpi-${id}-cost`);
  const estEl = byId(`usage-kpi-${id}-est`);
  const metaEl = byId(`usage-kpi-${id}-meta`);
  if (costEl) costEl.textContent = costText(data);
  if (estEl) {
    const hasEstimate = Number(data.estimatedUsd) > 0;
    estEl.hidden = !hasEstimate;
    estEl.textContent = hasEstimate ? t('usage.estimated', { usd: formatUsd(data.estimatedUsd) }) : '';
  }
  if (metaEl) {
    const runs = Number(data.runs) || 0;
    const parts = [t('usage.kpiTokens', { value: formatCompactNumber(data.tokens, lang) })];
    if (runs > 0) {
      parts.push(t('usage.kpiRuns', { value: formatInteger(runs, lang) }));
      parts.push(t('usage.kpiSuccess', { value: formatPercent(data.successRate, lang) }));
    } else {
      parts.push(t('usage.kpiNoRunData'));
    }
    metaEl.textContent = parts.join(' · ');
  }
}

/**
 * @param {object} summary
 * @returns {void}
 */
function renderKpis(summary) {
  const lang = getCurrentLang();
  const today = todayIso();
  const byDay = summary?.byDay || {};
  paintKpi('today', sumDayWindow(byDay, today, today), lang);
  paintKpi('week', sumDayWindow(byDay, addDaysIso(today, -6), today), lang);
  paintKpi('month', sumDayWindow(byDay, monthStartIso(today), today), lang);
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
 * @param {ReturnType<typeof buildChartModel>} model
 * @param {string} metric
 * @param {string} lang
 * @returns {string}
 */
function renderLegend(model, metric, lang) {
  return model.series
    .map(
      (entry) => `<span class="settings-usage-legend-item">
        <span class="settings-usage-legend-swatch settings-usage-series-${entry.colorIndex}" aria-hidden="true"></span>
        <span class="settings-usage-legend-label">${escapeHtml(entry.label)}</span>
        <span class="settings-usage-legend-value">${escapeHtml(formatChartValue(entry.total, metric, lang))}</span>
      </span>`
    )
    .join('');
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
    thead.innerHTML = '';
    tbody.innerHTML = '';
    return;
  }
  thead.innerHTML = `<tr><th scope="col">${escapeHtml(t('usage.chartBucket'))}</th>${model.series
    .map((entry) => `<th scope="col">${escapeHtml(entry.label)}</th>`)
    .join('')}<th scope="col">${escapeHtml(t('usage.chartTotal'))}</th></tr>`;
  tbody.innerHTML = model.buckets
    .map((bucket, index) => {
      const cells = model.series
        .map((entry) => `<td>${escapeHtml(formatChartValue(entry.values[index], metric, lang))}</td>`)
        .join('');
      return `<tr><th scope="row">${escapeHtml(bucket)}</th>${cells}<td>${escapeHtml(formatChartValue(model.bucketTotals[index], metric, lang))}</td></tr>`;
    })
    .join('');
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
    labelFor: state.groupBy === 'harness' ? harnessLabel : undefined,
  });
  const chartEl = byId('usage-chart');
  const legendEl = byId('usage-chart-legend');
  const emptyEl = byId('usage-chart-empty');
  const titleEl = byId('usage-chart-title');
  const groupLabel = t(state.groupBy === 'harness' ? 'usage.groupByHarness' : 'usage.groupByModel');
  const metricLabel = t(METRIC_LABEL_KEYS[metric] || 'usage.metricTokens');
  if (titleEl) {
    titleEl.textContent = t('usage.chartTitleDynamic', { metric: metricLabel, group: groupLabel });
  }
  const hasData = model.series.length > 0 && Number(model.max) > 0;
  if (chartEl) {
    chartEl.innerHTML = hasData ? renderStackedBarSvg(model, { lang, metric }) : '';
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
  if (legendEl) legendEl.innerHTML = hasData ? renderLegend(model, metric, lang) : '';
  if (emptyEl) emptyEl.hidden = hasData;
  renderChartTable(model, metric, lang, hasData);
}

/**
 * @param {object} row
 * @returns {string}
 */
function costCell(row) {
  const estimate = Number(row.estimatedUsd) > 0
    ? `<span class="settings-usage-est">${escapeHtml(t('usage.estimated', { usd: formatUsd(row.estimatedUsd) }))}</span>`
    : '';
  const reason = unpricedReason(row);
  if (reason === 'subscription') {
    return `<span class="settings-usage-tag">${escapeHtml(t('usage.subscription'))}</span>${estimate}`;
  }
  if (reason === 'unpriced') {
    return `<span class="settings-usage-tag">${escapeHtml(t('usage.unpriced'))}</span>${estimate}`;
  }
  const usd = Number(row.usd);
  const main = Number.isFinite(usd) && usd > 0
    ? formatUsd(usd)
    : (Number(row.estimatedUsd) > 0 ? '—' : '$0.00');
  return `${escapeHtml(main)}${estimate}`;
}

/**
 * @param {object} row
 * @returns {number}
 */
function shareValue(row) {
  const key = ['usd', 'tokens', 'runs'].includes(state.sortKey) ? state.sortKey : 'tokens';
  return Number(usageSortValue(row, key)) || 0;
}

/**
 * @param {object[]} rows
 * @returns {number}
 */
function maxShare(rows) {
  return rows.reduce((peak, row) => Math.max(peak, shareValue(row)), 0);
}

/**
 * @param {object} row
 * @param {number} max
 * @returns {string}
 */
function shareCell(row, max) {
  const percent = buildSharePercent(shareValue(row), max);
  return `<div class="settings-usage-share" title="${percent}%"><span class="settings-usage-share-fill" style="width:${percent}%"></span></div><span class="settings-usage-share-text">${percent}%</span>`;
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
    { key: 'label', labelKey: state.groupBy === 'harness' ? 'usage.colHarness' : 'usage.colModel', sortable: false },
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
  const head = byId('usage-breakdown-head');
  if (!head) return;
  head.innerHTML = `<tr>${tableColumns()
    .map((column) => {
      if (!column.sortable) {
        return `<th scope="col">${escapeHtml(t(column.labelKey))}</th>`;
      }
      const active = state.sortKey === column.key;
      const ariaSort = active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
      const arrow = active ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
      return `<th scope="col" aria-sort="${ariaSort}"><button type="button" class="settings-usage-sort${active ? ' is-active' : ''}" data-sort-key="${column.key}">${escapeHtml(t(column.labelKey))}<span class="settings-usage-sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
    })
    .join('')}</tr>`;
}

/**
 * @param {object[]} rows
 * @param {number} max
 * @param {string} lang
 * @returns {string}
 */
function tableRowsHtml(rows, max, lang) {
  return rows
    .map((row) => {
      const runsTitle = t('usage.runsTitle', {
        total: formatInteger(row.runs, lang),
        ok: formatInteger(row.okRuns, lang),
        errors: formatInteger(row.errorRuns, lang),
      });
      const p95 = row.p95LatencyMs == null ? '—' : `${formatInteger(row.p95LatencyMs, lang)} ms`;
      return `<tr>
        <th scope="row" class="settings-usage-row-label">${escapeHtml(rowLabel(row))}</th>
        <td>${costCell(row)}</td>
        <td title="${escapeHtml(formatInteger(row.totalTokens, lang))}">${escapeHtml(formatCompactNumber(row.totalTokens, lang))}</td>
        <td title="${escapeHtml(runsTitle)}">${escapeHtml(formatInteger(row.runs, lang))}</td>
        <td>${escapeHtml(formatPercent(row.successRate, lang))}</td>
        <td>${escapeHtml(p95)}</td>
        <td>${shareCell(row, max)}</td>
      </tr>`;
    })
    .join('');
}

/**
 * Card layout for narrow screens (<600px).
 *
 * @param {object[]} rows
 * @param {number} max
 * @param {string} lang
 * @returns {string}
 */
function tableCardsHtml(rows, max, lang) {
  return rows
    .map((row) => {
      const runsTitle = t('usage.runsTitle', {
        total: formatInteger(row.runs, lang),
        ok: formatInteger(row.okRuns, lang),
        errors: formatInteger(row.errorRuns, lang),
      });
      const p95 = row.p95LatencyMs == null ? '—' : `${formatInteger(row.p95LatencyMs, lang)} ms`;
      return `<article class="settings-usage-card">
        <h5 class="settings-usage-card-title">${escapeHtml(rowLabel(row))}</h5>
        <dl class="settings-usage-card-stats">
          <div><dt>${escapeHtml(t('usage.colCost'))}</dt><dd>${costCell(row)}</dd></div>
          <div><dt>${escapeHtml(t('usage.colTokens'))}</dt><dd title="${escapeHtml(formatInteger(row.totalTokens, lang))}">${escapeHtml(formatCompactNumber(row.totalTokens, lang))}</dd></div>
          <div><dt>${escapeHtml(t('usage.colRuns'))}</dt><dd title="${escapeHtml(runsTitle)}">${escapeHtml(formatInteger(row.runs, lang))}</dd></div>
          <div><dt>${escapeHtml(t('usage.colSuccess'))}</dt><dd>${escapeHtml(formatPercent(row.successRate, lang))}</dd></div>
          <div><dt>${escapeHtml(t('usage.colP95'))}</dt><dd>${escapeHtml(p95)}</dd></div>
        </dl>
        <div class="settings-usage-card-share">${shareCell(row, max)}</div>
      </article>`;
    })
    .join('');
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
    titleEl.textContent = t(state.groupBy === 'harness' ? 'usage.byHarness' : 'usage.byModel');
  }
  const body = byId('usage-breakdown-body');
  const cards = byId('usage-breakdown-cards');
  const emptyEl = byId('usage-breakdown-empty');
  const table = byId('usage-breakdown');
  const max = maxShare(sorted);
  if (body) body.innerHTML = tableRowsHtml(sorted, max, lang);
  if (cards) cards.innerHTML = tableCardsHtml(sorted, max, lang);
  const hasRows = sorted.length > 0;
  if (table) table.hidden = !hasRows;
  if (cards) cards.hidden = !hasRows;
  if (emptyEl) emptyEl.hidden = hasRows;
}

/**
 * Per-section loading/error/content toggle for the delegation model × role
 * panel. The panel lives inside the Usage tab but has its own endpoint, so it
 * keeps its own state instead of hiding the whole tab.
 *
 * @param {'loading'|'ready'|'error'} view
 * @returns {void}
 */
function setDelegationStatsView(view) {
  const loadingEl = byId('delegation-stats-loading');
  const errorEl = byId('delegation-stats-error');
  const errorTextEl = byId('delegation-stats-error-text');
  const contentEl = byId('delegation-stats-content');
  if (loadingEl) loadingEl.hidden = view !== 'loading';
  if (errorEl) errorEl.hidden = view !== 'error';
  if (contentEl) contentEl.hidden = view !== 'ready';
  if (view === 'error' && errorTextEl) errorTextEl.textContent = t('delegationStats.loadFailed');
}

/**
 * @param {PromiseSettledResult<object>} result
 * @returns {void}
 */
function renderDelegationStats(result) {
  if (result.status === 'rejected' || result.value?.ok !== true) {
    const reason = result.status === 'rejected'
      ? result.reason?.message || String(result.reason)
      : (result.value?.error || 'delegations stats request failed');
    console.warn('[usage] delegation stats failed:', reason);
    setDelegationStatsView('error');
    return;
  }
  const payload = result.value;
  const rows = delegationStatsRows(payload);
  const hasRows = delegationStatsViewState(payload) === 'ready';
  const lang = getCurrentLang();
  const metaEl = byId('delegation-stats-meta');
  if (metaEl) metaEl.textContent = renderDelegationStatsMetaHtml(payload, t);
  const head = byId('delegation-stats-head');
  if (head) head.innerHTML = renderDelegationStatsHeadHtml(t);
  const body = byId('delegation-stats-body');
  if (body) body.innerHTML = renderDelegationStatsRowsHtml(rows, t, lang);
  const cards = byId('delegation-stats-cards');
  if (cards) cards.innerHTML = renderDelegationStatsCardsHtml(rows, t, lang);
  const unusedEl = byId('delegation-stats-unused-list');
  if (unusedEl) {
    unusedEl.innerHTML = renderDelegationUnusedHtml(
      delegationStatsUnused(payload),
      t,
      delegationStatsUnusedState(payload),
    );
  }
  const table = byId('delegation-stats-table');
  if (table) table.hidden = !hasRows;
  if (cards) cards.hidden = !hasRows;
  const emptyEl = byId('delegation-stats-empty');
  if (emptyEl) emptyEl.hidden = hasRows;
  const loopLeaves = delegationLoopLeaves(payload);
  const hasLoop = delegationLoopViewState(payload) === 'ready';
  const loopHead = byId('delegation-loop-head');
  if (loopHead) loopHead.innerHTML = renderDelegationLoopHeadHtml(t);
  const loopBody = byId('delegation-loop-body');
  if (loopBody) loopBody.innerHTML = renderDelegationLoopRowsHtml(loopLeaves, t, lang);
  const loopCards = byId('delegation-loop-cards');
  if (loopCards) loopCards.innerHTML = renderDelegationLoopCardsHtml(loopLeaves, t, lang);
  const loopTable = byId('delegation-loop-table');
  if (loopTable) loopTable.hidden = !hasLoop;
  if (loopCards) loopCards.hidden = !hasLoop;
  const loopEmpty = byId('delegation-loop-empty');
  if (loopEmpty) loopEmpty.hidden = hasLoop;
  setDelegationStatsView('ready');
}

/**
 * Renders a settled stats result only while its token is still the newest.
 * A full-tab reload whose stats response settled before a newer panel-only
 * refresh must not repaint the stale snapshot.
 *
 * @param {number} token
 * @param {PromiseSettledResult<object>} result
 * @returns {void}
 */
function renderDelegationStatsIfCurrent(token, result) {
  if (!delegationStatsGate.isCurrent(token)) return;
  renderDelegationStats(result);
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
 * Reloads the ledger and repaints the Usage tab.
 * Uses Promise.allSettled so a single failing request only hides that section,
 * not the whole view. The global error banner appears only when all three fail.
 * The delegation panel has its own endpoint and state, so it is painted before
 * that early return and stays visible when the ledger is entirely down.
 *
 * @returns {Promise<void>}
 */
export async function refreshUsageSettings() {
  if (typeof document === 'undefined') return;
  const section = document.querySelector('.settings-section[data-settings-tab="usage"]');
  if (!section) return;
  const token = ++requestToken;
  const statsToken = delegationStatsGate.begin();
  setView('loading');
  setDelegationStatsView('loading');
  const planEl = byId('usage-plan-limits');
  if (planEl) planEl.textContent = t('usage.loading');
  const query = rangeQuery(state.range);

  const [summaryResult, chartResult, tableResult, delegationStatsResult, planResult] = await Promise.allSettled([
    getUsageSummary(kpiQuery()),
    getUsageTimeseries({
      ...query,
      bucket: state.range === '24h' ? 'hour' : 'day',
      groupBy: state.groupBy,
      metric: state.metric,
    }),
    state.groupBy === 'harness'
      ? getUsageSummary(query)
      : getUsageModels({ ...query, metric: 'tokens' }),
    getDelegationStats(getActiveWorkspaceScope()),
    getUsagePlanLimits(),
  ]);

  if (token !== requestToken) return;

  if (planEl) planEl.innerHTML = planResult.status === 'fulfilled' && planResult.value?.ok
    ? renderPlanLimitsHtml(planResult.value, { t, lang: getCurrentLang() })
    : escapeHtml(t('usage.sectionLoadFailed'));

  // The panel is independent of the ledger: paint its own result even when all
  // three ledger requests failed, so a ledger outage cannot hide it.
  renderDelegationStatsIfCurrent(statsToken, delegationStatsResult);

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
    periodEl.textContent = t('usage.period', {
      from: String(query.from || '').slice(0, 10),
      to: String(query.to || '').slice(0, 10),
    });
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
        : modelRowsFromPayload(tableResult.value.models);
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

  // The delegation panel was already painted above (independent endpoint and
  // scope), before the all-failed early return.
  setView('ready');
}

/**
 * @returns {void}
 */
function exportCsv() {
  const rows = state.sortedRows || [];
  const header = [
    t(state.groupBy === 'harness' ? 'usage.colHarness' : 'usage.colModel'),
    t('usage.colCost'),
    t('usage.colEstimated'),
    t('usage.colTokens'),
    t('usage.colRuns'),
    t('usage.colSuccess'),
    t('usage.colP95'),
    t('usage.colShare'),
  ];
  const max = maxShare(rows);
  const data = rows.map((row) => {
    const reason = unpricedReason(row);
    const cost = reason
      ? t(reason === 'subscription' ? 'usage.subscription' : 'usage.unpriced')
      : (Number.isFinite(Number(row.usd)) && Number(row.usd) > 0 ? Number(row.usd).toFixed(6) : '0');
    return [
      rowLabel(row),
      cost,
      Number(row.estimatedUsd) > 0 ? Number(row.estimatedUsd).toFixed(6) : '',
      row.totalTokens,
      row.runs,
      row.successRate == null ? '' : `${Math.round(row.successRate * 1000) / 10}%`,
      row.p95LatencyMs == null ? '' : row.p95LatencyMs,
      `${buildSharePercent(shareValue(row), max)}%`,
    ];
  });
  const csv = buildCsv(header, data);
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
  const rangeSelect = byId('usage-range-select');
  const metricSelect = byId('usage-metric-select');
  const groupSelect = byId('usage-group-select');
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
  window.addEventListener('cr-lang-changed', refreshUsageIfVisible);
  // The stats endpoint is workspace-scoped, so a workspace switch (active
  // workspace or workspace configuration) must reload the whole panel instead
  // of showing the previous workspace's aggregate.
  window.addEventListener('cretli-workspace-updated', refreshUsageIfVisible);
  window.addEventListener('cretli-active-workspace-changed', refreshUsageIfVisible);
}

export { harnessLabel, state as usageUiState };
