/**
 * Settings → Usage: DOM-free renderers for the stage-8 panels (disjoint token
 * buckets, coverage, executed choices, acceptance signals and cost provenance).
 *
 * The caller owns translation via `t()`; every number comes from the pure
 * view helpers in `usageCharts.js`, so the tooltip, table and CSV share the
 * same values.
 */

import {
  choiceGroupRows,
  choicesView,
  costProvenanceView,
  coverageBreakdownRows,
  coverageViewRows,
  escapeHtml,
  formatCompactNumber,
  formatInteger,
  formatPercent,
  formatUsd,
  signalRows,
  tokenBucketRows,
} from './usageCharts.js';

/**
 * @param {number|null} ratio
 * @param {string} lang
 * @returns {string}
 */
function ratioText(ratio, lang) {
  return ratio == null ? '—' : formatPercent(ratio, lang);
}

/**
 * @param {object} buckets
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderTokenBucketsHtml(buckets, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const view = tokenBucketRows(buckets);
  if (view.totalTokens <= 0 && view.diagnosticRows.length === 0) {
    return `<p class="settings-hint">${escapeHtml(t('usage.bucketsEmpty'))}</p>`;
  }
  const items = view.rows
    .filter((row) => row.value > 0)
    .map((row) => `<li class="settings-usage-bucket">
      <span class="settings-usage-bucket-label">${escapeHtml(t(row.labelKey))}</span>
      <span class="settings-usage-bucket-value">${escapeHtml(formatCompactNumber(row.value, lang))}</span>
      <span class="settings-usage-bucket-share">${escapeHtml(row.share_percent == null ? '—' : `${row.share_percent}%`)}</span>
    </li>`)
    .join('');
  // Diagnostic reasoning is already inside output: it is shown beside the
  // disjoint rows, never as a share of the total.
  const diagnosticItems = view.diagnosticRows
    .map((row) => `<li class="settings-usage-bucket settings-usage-bucket-diagnostic">
      <span class="settings-usage-bucket-label">${escapeHtml(t(row.labelKey))}</span>
      <span class="settings-usage-bucket-value">${escapeHtml(formatCompactNumber(row.value, lang))}</span>
      <span class="settings-usage-bucket-share">${escapeHtml(t('usage.bucketDiagnosticTag'))}</span>
    </li>`)
    .join('');
  const diagnosticHint = view.diagnosticRows.length > 0
    ? `<p class="settings-hint">${escapeHtml(t('usage.bucketsDiagnosticHint'))}</p>`
    : '';
  return `<p class="settings-hint">${escapeHtml(t('usage.bucketsTotal', { value: formatCompactNumber(view.totalTokens, lang) }))} · ${escapeHtml(t('usage.bucketsCache', { value: formatCompactNumber(view.cacheTokens, lang) }))}</p>`
    + `<ul class="settings-usage-buckets">${items}${diagnosticItems}</ul>`
    + diagnosticHint;
}

/**
 * @param {object} coverage
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderCoverageHtml(coverage, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const ratios = coverageViewRows(coverage)
    .map((row) => `<li class="settings-usage-coverage-ratio">
      <span class="settings-usage-bucket-label">${escapeHtml(t(row.labelKey))}</span>
      <span class="settings-usage-bucket-value">${escapeHtml(`${formatInteger(row.n, lang)}/${formatInteger(row.denominator, lang)}`)}</span>
      <span class="settings-usage-bucket-share">${escapeHtml(ratioText(row.ratio, lang))}</span>
    </li>`)
    .join('');
  const breakdown = coverageBreakdownRows(coverage)
    .filter((row) => row.n > 0)
    .map((row) => `<li><span>${escapeHtml(t(row.labelKey))}</span> <strong>${escapeHtml(formatInteger(row.n, lang))}</strong></li>`)
    .join('');
  return `<ul class="settings-usage-coverage-ratios">${ratios}</ul>`
    + (breakdown ? `<ul class="settings-usage-coverage-breakdown">${breakdown}</ul>` : '')
    + `<p class="settings-hint">${escapeHtml(t('usage.coverageNote'))}</p>`;
}

/**
 * @param {object} choices
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderChoicesHtml(choices, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const view = choicesView(choices);
  const proposals = view.proposals == null
    ? t('usage.choicesProposalsUnknown')
    : formatInteger(view.proposals, lang);
  const diagnostic = view.diagnosticPicks == null
    ? t('usage.choicesProposalsUnknown')
    : formatInteger(view.diagnosticPicks, lang);
  const meta = `<p class="settings-hint">${escapeHtml(t('usage.choicesMeta', {
    executed: formatInteger(view.executed, lang),
    proposals,
    diagnostic,
  }))}</p>`;
  const origins = view.originRows
    .map((row) => `<li class="settings-usage-choice-origin">
      <span class="settings-usage-bucket-label">${escapeHtml(t(row.labelKey))}</span>
      <span class="settings-usage-bucket-value">${escapeHtml(formatInteger(row.value, lang))}</span>
      <span class="settings-usage-bucket-share">${escapeHtml(row.share_percent == null ? '—' : `${row.share_percent}%`)}</span>
    </li>`)
    .join('');
  const details = view.originDetails
    .filter((row) => row.value > 0)
    .map((row) => `<span class="settings-usage-tag">${escapeHtml(row.labelKey ? t(row.labelKey) : row.key)}: ${escapeHtml(formatInteger(row.value, lang))}</span>`)
    .join(' ');
  const links = view.linkStatuses
    .filter((row) => row.value > 0)
    .map((row) => `<span class="settings-usage-tag">${escapeHtml(row.labelKey ? t(row.labelKey) : row.key)}: ${escapeHtml(formatInteger(row.value, lang))}</span>`)
    .join(' ');
  const groups = choiceGroupRows(view.groups);
  const rowsHtml = groups.length === 0
    ? `<tr><td colspan="6">${escapeHtml(t('usage.choicesEmpty'))}</td></tr>`
    : groups.map((row) => `<tr>
        <th scope="row" class="settings-usage-row-label">${escapeHtml(row.key)}</th>
        <td>${escapeHtml(formatInteger(row.executed, lang))}</td>
        <td>${escapeHtml(formatInteger(row.auto, lang))}</td>
        <td>${escapeHtml(formatInteger(row.manual, lang))}</td>
        <td>${escapeHtml(formatInteger(row.unknown, lang))}</td>
        <td>${escapeHtml(ratioText(row.technicalSuccessRate, lang))}</td>
      </tr>`).join('');
  return `${meta}
    <ul class="settings-usage-choice-origins">${origins}</ul>
    ${details ? `<p class="settings-usage-choice-details">${details}</p>` : ''}
    ${links ? `<p class="settings-usage-choice-links">${links}</p>` : ''}
    <div class="settings-usage-table-scroll">
      <table class="settings-usage-table settings-usage-breakdown">
        <thead id="usage-choices-head"><tr>
          <th scope="col">${escapeHtml(t('usage.colModel'))}</th>
          <th scope="col">${escapeHtml(t('usage.colChoicesExecuted'))}</th>
          <th scope="col">${escapeHtml(t('usage.colChoicesAuto'))}</th>
          <th scope="col">${escapeHtml(t('usage.colChoicesManual'))}</th>
          <th scope="col">${escapeHtml(t('usage.colChoicesUnknown'))}</th>
          <th scope="col">${escapeHtml(t('usage.colTechnicalSuccess'))}</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

/**
 * @param {object} signals
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderSignalsHtml(signals, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const rows = signalRows(signals)
    .map((row) => `<li class="settings-usage-signal">
      <span class="settings-usage-bucket-label">${escapeHtml(t(row.labelKey))}</span>
      <span class="settings-usage-bucket-value">${escapeHtml(`${formatInteger(row.n, lang)}/${formatInteger(row.denominator, lang)}`)}</span>
      <span class="settings-usage-bucket-share">${escapeHtml(ratioText(row.ratio, lang))}</span>
    </li>`)
    .join('');
  const cost = costProvenanceView(signals?.cost);
  const costText = t('usage.costProvenance', {
    actual: formatUsd(cost.actualUsd),
    estimated: formatUsd(cost.estimatedUsd),
    subscription: formatInteger(cost.subscriptionEvents, lang),
    unpriced: formatInteger(cost.unpricedEvents, lang),
  });
  const partial = cost.partial
    ? `<p class="settings-usage-cost-partial" data-tone="warning">${escapeHtml(t('usage.costPartial'))}</p>`
    : '';
  return `<ul class="settings-usage-signals">${rows}</ul>`
    + `<p class="settings-hint">${escapeHtml(costText)}</p>${partial}`;
}
