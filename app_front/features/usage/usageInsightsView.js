/**
 * Settings → Usage: DOM-free Lit templates for the stage-8 panels (disjoint
 * token buckets, coverage, executed choices, acceptance signals and cost
 * provenance).
 *
 * The caller owns translation via `t()`; every number comes from the pure
 * view helpers in `usageCharts.js`, so the tooltip, table and CSV share the
 * same values. Templates are rendered with lit `render()`; Lit escapes text.
 */

import { html, nothing } from 'lit';
import {
  choiceGroupRows,
  choicesView,
  costProvenanceView,
  coverageBreakdownRows,
  coverageViewRows,
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
 * @param {Function} t
 * @param {string} key
 */
/** @param {string} message */
export const sectionHint = (message) => html`<p class="settings-hint">${message}</p>`;

const hint = (t, key) => html`<p class="settings-hint">${t(key)}</p>`;

/**
 * @param {object} buckets
 * @param {{ t: Function, lang?: string }} options
 */
export function renderTokenBucketsView(buckets, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const view = tokenBucketRows(buckets);
  if (view.totalTokens <= 0 && view.diagnosticRows.length === 0) return hint(t, 'usage.bucketsEmpty');
  const items = view.rows
    .filter((row) => row.value > 0)
    .map((row) => html`<li class="settings-usage-bucket">
      <span class="settings-usage-bucket-label">${t(row.labelKey)}</span>
      <span class="settings-usage-bucket-value">${formatCompactNumber(row.value, lang)}</span>
      <span class="settings-usage-bucket-share">${row.share_percent == null ? '—' : `${row.share_percent}%`}</span>
    </li>`);
  // Diagnostic reasoning is already inside output: it is shown beside the
  // disjoint rows, never as a share of the total.
  const diagnosticItems = view.diagnosticRows
    .map((row) => html`<li class="settings-usage-bucket settings-usage-bucket-diagnostic">
      <span class="settings-usage-bucket-label">${t(row.labelKey)}</span>
      <span class="settings-usage-bucket-value">${formatCompactNumber(row.value, lang)}</span>
      <span class="settings-usage-bucket-share">${t('usage.bucketDiagnosticTag')}</span>
    </li>`);
  return html`<p class="settings-hint">${t('usage.bucketsTotal', { value: formatCompactNumber(view.totalTokens, lang) })} · ${t('usage.bucketsCache', { value: formatCompactNumber(view.cacheTokens, lang) })}</p>
    <ul class="settings-usage-buckets">${items}${diagnosticItems}</ul>
    ${view.diagnosticRows.length > 0 ? hint(t, 'usage.bucketsDiagnosticHint') : nothing}`;
}

/**
 * @param {object} coverage
 * @param {{ t: Function, lang?: string }} options
 */
export function renderCoverageView(coverage, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const ratios = coverageViewRows(coverage)
    .map((row) => html`<li class="settings-usage-coverage-ratio">
      <span class="settings-usage-bucket-label">${t(row.labelKey)}</span>
      <span class="settings-usage-bucket-value">${`${formatInteger(row.n, lang)}/${formatInteger(row.denominator, lang)}`}</span>
      <span class="settings-usage-bucket-share">${ratioText(row.ratio, lang)}</span>
    </li>`);
  const breakdown = coverageBreakdownRows(coverage)
    .filter((row) => row.n > 0)
    .map((row) => html`<li><span>${t(row.labelKey)}</span> <strong>${formatInteger(row.n, lang)}</strong></li>`);
  return html`<ul class="settings-usage-coverage-ratios">${ratios}</ul>
    ${breakdown.length ? html`<ul class="settings-usage-coverage-breakdown">${breakdown}</ul>` : nothing}
    ${hint(t, 'usage.coverageNote')}`;
}

/**
 * @param {object} choices
 * @param {{ t: Function, lang?: string }} options
 */
export function renderChoicesView(choices, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const view = choicesView(choices);
  const proposals = view.proposals == null
    ? t('usage.choicesProposalsUnknown')
    : formatInteger(view.proposals, lang);
  const diagnostic = view.diagnosticPicks == null
    ? t('usage.choicesProposalsUnknown')
    : formatInteger(view.diagnosticPicks, lang);
  const origins = view.originRows
    .map((row) => html`<li class="settings-usage-choice-origin">
      <span class="settings-usage-bucket-label">${t(row.labelKey)}</span>
      <span class="settings-usage-bucket-value">${formatInteger(row.value, lang)}</span>
      <span class="settings-usage-bucket-share">${row.share_percent == null ? '—' : `${row.share_percent}%`}</span>
    </li>`);
  const tag = (row) => html`<span class="settings-usage-tag">${row.labelKey ? t(row.labelKey) : row.key}: ${formatInteger(row.value, lang)}</span>`;
  const details = view.originDetails.filter((row) => row.value > 0).map(tag);
  const links = view.linkStatuses.filter((row) => row.value > 0).map(tag);
  const groups = choiceGroupRows(view.groups);
  const rows = groups.length === 0
    ? html`<tr><td colspan="6">${t('usage.choicesEmpty')}</td></tr>`
    : groups.map((row) => html`<tr>
        <th scope="row" class="settings-usage-row-label">${row.key}</th>
        <td>${formatInteger(row.executed, lang)}</td>
        <td>${formatInteger(row.auto, lang)}</td>
        <td>${formatInteger(row.manual, lang)}</td>
        <td>${formatInteger(row.unknown, lang)}</td>
        <td>${ratioText(row.technicalSuccessRate, lang)}</td>
      </tr>`);
  return html`<p class="settings-hint">${t('usage.choicesMeta', {
      executed: formatInteger(view.executed, lang),
      proposals,
      diagnostic,
    })}</p>
    <ul class="settings-usage-choice-origins">${origins}</ul>
    ${details.length ? html`<p class="settings-usage-choice-details">${details}</p>` : nothing}
    ${links.length ? html`<p class="settings-usage-choice-links">${links}</p>` : nothing}
    <div class="settings-usage-table-scroll">
      <table class="settings-usage-table settings-usage-breakdown">
        <thead id="usage-choices-head"><tr>
          <th scope="col">${t('usage.colModel')}</th>
          <th scope="col">${t('usage.colChoicesExecuted')}</th>
          <th scope="col">${t('usage.colChoicesAuto')}</th>
          <th scope="col">${t('usage.colChoicesManual')}</th>
          <th scope="col">${t('usage.colChoicesUnknown')}</th>
          <th scope="col">${t('usage.colTechnicalSuccess')}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * @param {object} signals
 * @param {{ t: Function, lang?: string }} options
 */
export function renderSignalsView(signals, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const rows = signalRows(signals)
    .map((row) => html`<li class="settings-usage-signal">
      <span class="settings-usage-bucket-label">${t(row.labelKey)}</span>
      <span class="settings-usage-bucket-value">${`${formatInteger(row.n, lang)}/${formatInteger(row.denominator, lang)}`}</span>
      <span class="settings-usage-bucket-share">${ratioText(row.ratio, lang)}</span>
    </li>`);
  const cost = costProvenanceView(signals?.cost);
  const costText = t('usage.costProvenance', {
    actual: formatUsd(cost.actualUsd),
    estimated: formatUsd(cost.estimatedUsd),
    subscription: formatInteger(cost.subscriptionEvents, lang),
    unpriced: formatInteger(cost.unpricedEvents, lang),
  });
  return html`<ul class="settings-usage-signals">${rows}</ul><p class="settings-hint">${costText}</p>${cost.partial
    ? html`<p class="settings-usage-cost-partial" data-tone="warning">${t('usage.costPartial')}</p>`
    : nothing}`;
}

/**
 * Cache freshness block. Shows exact token counts, keeps the context fill as a
 * separate row, and prints an estimate only when the TTL is known. The list is
 * focusable so the TTL caveat (title) is reachable from the keyboard.
 *
 * @param {object|null} view `getCacheFreshness` result
 * @param {{ t: Function, lang?: string }} options
 */
export function renderCacheFreshnessView(view, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  if (!view || !view.cache) return hint(t, 'usage.cacheNoData');
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
  ].map(([key, value]) => html`<li class="settings-usage-bucket">
      <span class="settings-usage-bucket-label">${t(key)}</span>
      <span class="settings-usage-bucket-value">${value}</span>
    </li>`);
  return html`<ul class="settings-usage-buckets" tabindex="0" title=${t('usage.cacheTtlCaveat')}>${rows}</ul>
    ${hint(t, 'usage.cacheTtlCaveat')}`;
}

/**
 * @param {Function} t
 * @param {string[]} keys
 */
const headCells = (t, keys) => keys.map((key) => html`<th scope="col">${t(key)}</th>`);

/**
 * Usage per delegation leaf and round. Token totals are exact; the cost origin
 * (measured vs estimated vs unpriced) is shown per row, never merged.
 *
 * @param {object|null} breakdown `buildWorkflowBreakdown` result
 * @param {{ t: Function, lang?: string }} options
 */
export function renderWorkflowBreakdownView(breakdown, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const rows = Array.isArray(breakdown?.rows) ? breakdown.rows : [];
  if (rows.length === 0) return hint(t, 'usage.workflowEmpty');
  const body = rows.map((row) => {
    const cost = row.cost || {};
    const origin = t('usage.workflowCostOrigin', {
      actual: formatUsd(cost.actualUsd),
      estimated: formatUsd(cost.estimatedUsd),
      unpriced: formatInteger(cost.unpricedEvents, lang),
    });
    return html`<tr>
      <th scope="row">${String(row.leafId || '').slice(0, 8)}</th>
      <td>${row.round == null ? '—' : formatInteger(row.round, lang)}</td>
      <td>${row.role || '—'}</td>
      <td>${formatInteger(row.tokens?.totalTokens ?? 0, lang)}</td>
      <td>${formatInteger(row.tokens?.cacheRead ?? 0, lang)}</td>
      <td>${origin}</td>
    </tr>`;
  });
  const head = headCells(t, ['usage.workflowLeaf', 'usage.workflowRound', 'usage.workflowRole', 'usage.workflowTokens', 'usage.cacheSessionRead', 'usage.workflowCost']);
  return html`<div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label=${t('usage.workflowTitle')}>
    <table class="settings-usage-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${Number(breakdown?.unmatched?.events) > 0
    ? html`<p class="settings-hint">${t('usage.workflowUnmatched', { count: formatInteger(breakdown.unmatched.events, lang) })}</p>`
    : nothing}`;
}

/**
 * "Top consumers" table: rows ranked by fresh tokens (cache reads excluded),
 * with cache share, limit hits and fresh tokens per attempt.
 *
 * @param {object|null} top `/api/usage/top` payload
 * @param {{ t: Function, lang?: string }} options
 */
export function renderUsageTopView(top, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const rows = Array.isArray(top?.rows) ? top.rows : [];
  if (rows.length === 0) return hint(t, 'usage.topEmpty');
  const body = rows.map((row) => {
    const key = String(row.key || '');
    const shortKey = key.length > 36 ? `${key.slice(0, 8)}…` : key;
    const heavy = Array.isArray(row.flags) && row.flags.includes('heavy_context');
    return html`<tr>
      <th scope="row" title=${key}>${row.label ? `${row.label}` : shortKey}${heavy ? html` <span class="settings-usage-flag" title=${t('usage.topHeavyContextHint')}>${t('usage.topHeavyContext')}</span>` : nothing}</th>
      <td>${formatCompactNumber(row.fresh ?? 0, lang)}</td>
      <td>${ratioText(row.shareOfFresh, lang)}</td>
      <td>${formatCompactNumber(row.cacheRead ?? 0, lang)}</td>
      <td>${row.cacheShare == null ? '—' : formatPercent(row.cacheShare, lang)}</td>
      <td>${formatInteger(row.limitHits ?? 0, lang)}</td>
      <td>${row.freshPerAttempt == null ? '—' : formatCompactNumber(row.freshPerAttempt, lang)}</td>
      <td>${formatUsd(row.usd)}</td>
    </tr>`;
  });
  const head = headCells(t, ['usage.topName', 'usage.topFresh', 'usage.topShare', 'usage.topCacheRead', 'usage.topCacheShare', 'usage.topLimitHits', 'usage.topPerAttempt', 'usage.topUsd']);
  return html`<div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label=${t('usage.topTitle')}>
    <table class="settings-usage-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${top?.truncated
    ? html`<p class="settings-hint">${t('usage.topTruncated', { shown: formatInteger(rows.length, lang), total: formatInteger(top.groups ?? rows.length, lang) })}</p>`
    : nothing}`;
}

/**
 * Limit-burn table: the chats blamed most often across limit hits, then the
 * latest hits with their top same-harness consumers in the look-back.
 *
 * @param {object|null} burn `/api/usage/limit-burn` payload
 * @param {{ t: Function, lang?: string }} options
 */
export function renderLimitBurnView(burn, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  if (!burn || !(burn.clusters > 0)) return hint(t, 'usage.limitBurnEmpty');
  const culprits = (burn.culprits || []).map((c) => html`<tr>
      <th scope="row" title=${c.chatId}>${c.label || String(c.chatId).slice(0, 8)}</th>
      <td>${c.harness}</td>
      <td>${formatCompactNumber(c.fresh, lang)}</td>
      <td>${formatInteger(c.hitsBlamed, lang)}</td>
    </tr>`);
  const recent = (burn.recent || []).slice(0, 8).map((r) => html`<tr>
      <th scope="row">${String(r.at).replace('T', ' ').slice(0, 16)}</th>
      <td>${`${r.harness}/${r.model}`}</td>
      <td>${formatCompactNumber(r.freshInLookback, lang)}</td>
      <td>${(r.topChats || []).map((c) => `${c.label || String(c.chatId).slice(0, 8)} (${c.share == null ? '—' : formatPercent(c.share, lang)})`).join(', ') || '—'}</td>
    </tr>`);
  const hours = Math.round((burn.lookbackMs || 0) / 3_600_000);
  return html`<p class="settings-hint">${t('usage.limitBurnSummary', { clusters: formatInteger(burn.clusters, lang), hits: formatInteger(burn.rawHits, lang), hours: formatInteger(hours, lang) })}</p>
    <div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label=${t('usage.limitBurnTitle')}>
    <table class="settings-usage-table"><thead><tr>${headCells(t, ['usage.topName', 'usage.limitBurnHarness', 'usage.topFresh', 'usage.limitBurnBlamed'])}</tr></thead><tbody>${culprits}</tbody></table></div>
    <div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label=${t('usage.limitBurnRecent')}>
    <table class="settings-usage-table"><thead><tr>${headCells(t, ['usage.limitBurnAt', 'usage.limitBurnModel', 'usage.limitBurnFresh', 'usage.limitBurnTop'])}</tr></thead><tbody>${recent}</tbody></table></div>`;
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
 */
export function renderKeepAliveView(view, options = {}) {
  const t = options.t;
  const lang = options.lang || 'en';
  const gate = view?.gate || {};
  const gateReasons = Array.isArray(gate.reasons) ? gate.reasons : [];
  const gateLine = gate.decision === 'go'
    ? t('usage.keepAliveGateGo')
    : t('usage.keepAliveGateNoGo', { reasons: gateReasons.join(', ') || '—' });
  const plans = Array.isArray(view?.plans) ? view.plans : [];
  const head = html`<p class="settings-hint">${t('usage.keepAliveDefaultOff')} ${gateLine}</p>`;
  if (plans.length === 0) return html`${head}${hint(t, 'usage.keepAliveEmpty')}`;
  const body = plans.map((plan) => {
    const budget = plan.budget || {};
    const remaining = budget.remainingUsd == null
      ? t('usage.keepAliveUnknown')
      : formatUsd(budget.remainingUsd);
    const state = plan.status === 'active'
      ? t('usage.keepAliveActive')
      : t('usage.keepAliveStopped', { reason: keepAliveStopReasonLabel(plan.stopReason, t) });
    return html`<tr>
      <th scope="row">${String(plan.delegationId || '').slice(0, 8)}</th>
      <td>${plan.mode}</td>
      <td>${state}${plan.lastDefer?.reason ? ` · ${t('usage.keepAliveDeferred', { reason: plan.lastDefer.reason })}` : nothing}</td>
      <td>${formatInteger(budget.pingsRemaining ?? 0, lang)}</td>
      <td>${remaining}</td>
      <td>${formatUsd(budget.spentUsd)}${budget.costComplete === false ? ` (${t('usage.keepAliveUnmeasured', { count: formatInteger(budget.unknownCostPings, lang) })})` : nothing}</td>
      <td>${plan.status === 'active'
    ? html`<button type="button" class="settings-usage-btn" data-keepalive-stop=${plan.delegationId} data-keepalive-controller=${plan.controllerChatId}>${t('usage.keepAliveStop')}</button>`
    : nothing}</td>
    </tr>`;
  });
  const cols = headCells(t, ['usage.keepAliveDelegation', 'usage.keepAliveMode', 'usage.keepAliveState', 'usage.keepAlivePingsLeft', 'usage.keepAliveBudgetLeft', 'usage.keepAliveSpent', 'usage.keepAliveActions']);
  return html`${head}<div class="settings-usage-table-wrap" tabindex="0" role="group" aria-label=${t('usage.keepAliveTitle')}>
    <table class="settings-usage-table"><thead><tr>${cols}</tr></thead><tbody>${body}</tbody></table></div>`;
}
