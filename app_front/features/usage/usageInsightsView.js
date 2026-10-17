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

/**
 * Cache freshness block. Shows exact token counts, keeps the context fill as a
 * separate row, and prints an estimate only when the TTL is known. The list is
 * focusable so the TTL caveat (title) is reachable from the keyboard.
 *
 * @param {object|null} view `getCacheFreshness` result
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderCacheFreshnessHtml(view, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  if (!view || !view.cache) return `<p class="settings-hint">${escapeHtml(t('usage.cacheNoData'))}</p>`;
  const { cache, session, context } = view;
  let status = t('usage.cacheNoData');
  if (cache.state === 'warm' && cache.expiresInMs != null) {
    status = t('usage.cacheEstimated', { minutes: String(Math.max(1, Math.ceil(cache.expiresInMs / 60000))) });
  } else if (cache.state === 'cold') {
    status = t('usage.cacheLikelyExpired');
  }
  const exact = (value) => (value == null ? '—' : formatInteger(value, lang));
  const rows = [
    ['usage.cacheStatus', status],
    ['usage.cacheGeneration', exact(session?.generation)],
    ['usage.cacheSessionRead', exact(session?.cachedInputTokens)],
    ['usage.cacheSessionWrite', exact(session?.cacheWriteTokens)],
    ['usage.cacheContextFill', exact(context?.inputTokens)],
  ].map(([key, value]) => `<li class="settings-usage-bucket">
      <span class="settings-usage-bucket-label">${escapeHtml(t(key))}</span>
      <span class="settings-usage-bucket-value">${escapeHtml(value)}</span>
    </li>`).join('');
  return `<ul class="settings-usage-buckets" tabindex="0" title="${escapeHtml(t('usage.cacheTtlCaveat'))}">${rows}</ul>`
    + `<p class="settings-hint">${escapeHtml(t('usage.cacheTtlCaveat'))}</p>`;
}

/**
 * Usage per delegation leaf and round. Token totals are exact; the cost origin
 * (measured vs estimated vs unpriced) is shown per row, never merged.
 *
 * @param {object|null} breakdown `buildWorkflowBreakdown` result
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderWorkflowBreakdownHtml(breakdown, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const rows = Array.isArray(breakdown?.rows) ? breakdown.rows : [];
  if (rows.length === 0) return `<p class="settings-hint">${escapeHtml(t('usage.workflowEmpty'))}</p>`;
  const body = rows.map((row) => {
    const cost = row.cost || {};
    const origin = t('usage.workflowCostOrigin', {
      actual: formatUsd(cost.actualUsd),
      estimated: formatUsd(cost.estimatedUsd),
      unpriced: formatInteger(cost.unpricedEvents, lang),
    });
    return `<tr>
      <th scope="row">${escapeHtml(String(row.leafId || '').slice(0, 8))}</th>
      <td>${escapeHtml(row.round == null ? '—' : formatInteger(row.round, lang))}</td>
      <td>${escapeHtml(row.role || '—')}</td>
      <td>${escapeHtml(formatInteger(row.tokens?.totalTokens ?? 0, lang))}</td>
      <td>${escapeHtml(formatInteger(row.tokens?.cacheRead ?? 0, lang))}</td>
      <td>${escapeHtml(origin)}</td>
    </tr>`;
  }).join('');
  const head = ['usage.workflowLeaf', 'usage.workflowRound', 'usage.workflowRole', 'usage.workflowTokens', 'usage.cacheSessionRead', 'usage.workflowCost']
    .map((key) => `<th scope="col">${escapeHtml(t(key))}</th>`).join('');
  const unmatched = Number(breakdown?.unmatched?.events) > 0
    ? `<p class="settings-hint">${escapeHtml(t('usage.workflowUnmatched', { count: formatInteger(breakdown.unmatched.events, lang) }))}</p>`
    : '';
  return `<div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label="${escapeHtml(t('usage.workflowTitle'))}">`
    + `<table class="settings-usage-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${unmatched}`;
}

/** Stop reason codes that have a translated label (`usage.keepAliveStopReason_<code>`). */
export const KEEP_ALIVE_STOP_REASON_LABELED = Object.freeze([
  'user_stopped', 'cancelled', 'workflow_ended', 'session_reset', 'chat_missing', 'budget_exhausted',
  'cost_unknown', 'ping_limit', 'deadline', 'provider_limit', 'ineffective', 'error', 'not_needed',
  'cache_expired', 'not_economic', 'server_restart', 'unavailable',
]);

/**
 * Human label of a keep-alive stop reason; an unknown code falls back to itself.
 *
 * @param {string|null|undefined} reason
 * @param {Function} t
 * @returns {string}
 */
export function keepAliveStopReasonLabel(reason, t) {
  const code = String(reason || '');
  if (!code) return '—';
  return KEEP_ALIVE_STOP_REASON_LABELED.includes(code) ? t(`usage.keepAliveStopReason_${code}`) : code;
}

/**
 * Keep-alive plans: mode, stop reason, remaining pings and budget, next attempt
 * and the benchmark gate. An unmeasured ping makes the remaining budget
 * "unknown" instead of a number. Stop buttons carry `data-keepalive-*`
 * attributes handled by the caller.
 *
 * @param {{ plans?: object[], gate?: object, defaultMode?: string }|null} view
 * @param {{ t: Function, lang?: string }} options
 * @returns {string}
 */
export function renderKeepAliveHtml(view, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const gate = view?.gate || {};
  const gateReasons = Array.isArray(gate.reasons) ? gate.reasons : [];
  const gateLine = gate.decision === 'go'
    ? t('usage.keepAliveGateGo')
    : t('usage.keepAliveGateNoGo', { reasons: gateReasons.join(', ') || '—' });
  const plans = Array.isArray(view?.plans) ? view.plans : [];
  const head = `<p class="settings-hint">${escapeHtml(t('usage.keepAliveDefaultOff'))} ${escapeHtml(gateLine)}</p>`;
  if (plans.length === 0) return `${head}<p class="settings-hint">${escapeHtml(t('usage.keepAliveEmpty'))}</p>`;
  const body = plans.map((plan) => {
    const budget = plan.budget || {};
    const remaining = budget.remainingUsd == null
      ? t('usage.keepAliveUnknown')
      : formatUsd(budget.remainingUsd);
    const state = plan.status === 'active'
      ? t('usage.keepAliveActive')
      : t('usage.keepAliveStopped', { reason: keepAliveStopReasonLabel(plan.stopReason, t) });
    const defer = plan.lastDefer?.reason ? ` · ${escapeHtml(t('usage.keepAliveDeferred', { reason: plan.lastDefer.reason }))}` : '';
    const stop = plan.status === 'active'
      ? `<button type="button" class="settings-usage-btn" data-keepalive-stop="${escapeHtml(plan.delegationId)}" data-keepalive-controller="${escapeHtml(plan.controllerChatId)}">${escapeHtml(t('usage.keepAliveStop'))}</button>`
      : '';
    return `<tr>
      <th scope="row">${escapeHtml(String(plan.delegationId || '').slice(0, 8))}</th>
      <td>${escapeHtml(plan.mode)}</td>
      <td>${escapeHtml(state)}${defer}</td>
      <td>${escapeHtml(formatInteger(budget.pingsRemaining ?? 0, lang))}</td>
      <td>${escapeHtml(remaining)}</td>
      <td>${escapeHtml(formatUsd(budget.spentUsd))}${budget.costComplete === false ? ` (${escapeHtml(t('usage.keepAliveUnmeasured', { count: formatInteger(budget.unknownCostPings, lang) }))})` : ''}</td>
      <td>${stop}</td>
    </tr>`;
  }).join('');
  const cols = ['usage.keepAliveDelegation', 'usage.keepAliveMode', 'usage.keepAliveState', 'usage.keepAlivePingsLeft', 'usage.keepAliveBudgetLeft', 'usage.keepAliveSpent', 'usage.keepAliveActions']
    .map((key) => `<th scope="col">${escapeHtml(t(key))}</th>`).join('');
  return `${head}<div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label="${escapeHtml(t('usage.keepAliveTitle'))}">`
    + `<table class="settings-usage-table"><thead><tr>${cols}</tr></thead><tbody>${body}</tbody></table></div>`;
}
