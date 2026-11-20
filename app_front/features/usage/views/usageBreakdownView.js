/**
 * Settings → Usage: Lit templates for the chart legend, the accessible chart
 * table and the model/harness breakdown (table rows and narrow-screen cards).
 * Pure functions of their arguments; the caller renders them with
 * `renderUsage`.
 */

import { html, nothing } from 'lit';
import { formatUsd } from '../../../../lib/usage/usage-rates.js';
import {
  buildSharePercent,
  buildShareOfTotalPercent,
  formatChartValue,
  formatCompactNumber,
  formatInteger,
  formatPercent,
  unpricedReason,
  usageSortValue,
} from '../usageCharts.js';

/**
 * @param {{ series: Array<{ colorIndex: number, label: string, total: number }> }} model
 * @param {any} metric
 * @param {string} lang
 * @returns {import('lit').TemplateResult[]}
 */
export function renderLegendView(model, metric, lang) {
  return model.series.map((entry) => html`<span class="settings-usage-legend-item">
        <span class="settings-usage-legend-swatch settings-usage-series-${entry.colorIndex}" aria-hidden="true"></span>
        <span class="settings-usage-legend-label">${entry.label}</span>
        <span class="settings-usage-legend-value">${formatChartValue(entry.total, metric, lang)}</span>
      </span>`);
}

/**
 * @param {any} model chart model from `buildChartModel`
 * @param {(key: string) => string} t
 * @returns {import('lit').TemplateResult}
 */
export function renderChartTableHeadView(model, t) {
  return html`<tr><th scope="col">${t('usage.chartBucket')}</th>${model.series
    .map((entry) => html`<th scope="col">${entry.label}</th>`)}<th scope="col">${t('usage.chartTotal')}</th></tr>`;
}

/**
 * @param {any} model chart model from `buildChartModel`
 * @param {any} metric
 * @param {string} lang
 * @returns {import('lit').TemplateResult[]}
 */
export function renderChartTableRowsView(model, metric, lang) {
  return model.buckets.map((bucket, index) => html`<tr><th scope="row">${bucket}</th>${model.series
    .map((entry) => html`<td>${formatChartValue(entry.values[index], metric, lang)}</td>`)}<td>${formatChartValue(model.bucketTotals[index], metric, lang)}</td></tr>`);
}

/**
 * @param {any} row
 * @param {(key: string, vars?: any) => string} t
 * @returns {import('lit').TemplateResult}
 */
export function costCellView(row, t) {
  const estimate = Number(row.estimatedUsd) > 0
    ? html`<span class="settings-usage-est">${t('usage.estimated', { usd: formatUsd(row.estimatedUsd) })}</span>`
    : nothing;
  const reason = unpricedReason(row);
  if (reason === 'subscription') {
    return html`<span class="settings-usage-tag">${t('usage.subscription')}</span>${estimate}`;
  }
  if (reason === 'unpriced') {
    return html`<span class="settings-usage-tag">${t('usage.unpriced')}</span>${estimate}`;
  }
  const usd = Number(row.usd);
  const main = Number.isFinite(usd) && usd > 0
    ? formatUsd(usd)
    : (Number(row.estimatedUsd) > 0 ? '—' : '$0.00');
  return html`${main}${estimate}`;
}

/**
 * @param {any} row
 * @param {string} sortKey
 * @returns {number}
 */
export function shareValue(row, sortKey) {
  const key = sortKey === 'usd' || sortKey === 'runs' ? sortKey : 'tokens';
  return Number(usageSortValue(row, key)) || 0;
}

/**
 * @param {number} value metric value of the row
 * @param {number} max leader value, only used for the bar length
 * @param {number} total cohort total used for the visible percentage
 * @param {(key: string, vars?: any) => string} t
 * @returns {import('lit').TemplateResult}
 */
function shareCellView(value, max, total, t) {
  const percent = buildSharePercent(value, max);
  const shareOfTotal = buildShareOfTotalPercent(value, total);
  const text = shareOfTotal == null ? '—' : `${shareOfTotal}%`;
  const title = t('usage.shareTitle', { percent: text, leader: `${percent}%` });
  return html`<div class="settings-usage-share" title=${title} aria-label=${title}><span class="settings-usage-share-fill" style="width:${percent}%"></span></div><span class="settings-usage-share-text">${text}</span>`;
}

/**
 * @param {Array<{ key: string, labelKey: string, sortable: boolean }>} columns
 * @param {{ sortKey: string, sortDir: string }} sort
 * @param {(key: string) => string} t
 * @returns {import('lit').TemplateResult}
 */
export function renderBreakdownHeadView(columns, sort, t) {
  return html`<tr>${columns.map((column) => {
    if (!column.sortable) return html`<th scope="col">${t(column.labelKey)}</th>`;
    const active = sort.sortKey === column.key;
    const ariaSort = active ? (sort.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    const arrow = active ? (sort.sortDir === 'asc' ? '▲' : '▼') : '';
    return html`<th scope="col" aria-sort=${ariaSort}><button type="button" class="settings-usage-sort${active ? ' is-active' : ''}" data-sort-key=${column.key}>${t(column.labelKey)}<span class="settings-usage-sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
  })}</tr>`;
}

/**
 * @param {any} row
 * @param {string} lang
 * @param {(key: string, vars?: any) => string} t
 */
function rowFigures(row, lang, t) {
  return {
    runsTitle: t('usage.runsTitle', {
      total: formatInteger(row.runs, lang),
      ok: formatInteger(row.okRuns, lang),
      errors: formatInteger(row.errorRuns, lang),
    }),
    p95: row.p95LatencyMs == null ? '—' : `${formatInteger(row.p95LatencyMs, lang)} ms`,
  };
}

/**
 * @param {any[]} rows
 * @param {{ max: number, total: number, lang: string, sortKey: string, t: (key: string, vars?: any) => string, label: (row: object) => string }} ctx
 * @returns {import('lit').TemplateResult[]}
 */
export function renderBreakdownRowsView(rows, ctx) {
  const { t, lang } = ctx;
  return rows.map((row) => {
    const { runsTitle, p95 } = rowFigures(row, lang, t);
    return html`<tr>
        <th scope="row" class="settings-usage-row-label">${ctx.label(row)}</th>
        <td>${costCellView(row, t)}</td>
        <td title=${formatInteger(row.totalTokens, lang)}>${formatCompactNumber(row.totalTokens, lang)}</td>
        <td title=${runsTitle}>${formatInteger(row.runs, lang)}</td>
        <td>${formatPercent(row.successRate, lang)}</td>
        <td>${p95}</td>
        <td>${shareCellView(shareValue(row, ctx.sortKey), ctx.max, ctx.total, t)}</td>
      </tr>`;
  });
}

/**
 * Card layout for narrow screens (<600px).
 *
 * @param {any[]} rows
 * @param {Parameters<typeof renderBreakdownRowsView>[1]} ctx
 * @returns {import('lit').TemplateResult[]}
 */
export function renderBreakdownCardsView(rows, ctx) {
  const { t, lang } = ctx;
  return rows.map((row) => {
    const { runsTitle, p95 } = rowFigures(row, lang, t);
    return html`<article class="settings-usage-card">
        <h5 class="settings-usage-card-title">${ctx.label(row)}</h5>
        <dl class="settings-usage-card-stats">
          <div><dt>${t('usage.colCost')}</dt><dd>${costCellView(row, t)}</dd></div>
          <div><dt>${t('usage.colTokens')}</dt><dd title=${formatInteger(row.totalTokens, lang)}>${formatCompactNumber(row.totalTokens, lang)}</dd></div>
          <div><dt>${t('usage.colRuns')}</dt><dd title=${runsTitle}>${formatInteger(row.runs, lang)}</dd></div>
          <div><dt>${t('usage.colSuccess')}</dt><dd>${formatPercent(row.successRate, lang)}</dd></div>
          <div><dt>${t('usage.colP95')}</dt><dd>${p95}</dd></div>
        </dl>
        <div class="settings-usage-card-share">${shareCellView(shareValue(row, ctx.sortKey), ctx.max, ctx.total, t)}</div>
      </article>`;
  });
}
