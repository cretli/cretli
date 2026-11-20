/**
 * Pure view helpers for the Settings → Usage "model × role" delegation panel
 * fed by GET /api/delegations/stats.
 *
 * Everything here is DOM-free so the row normalization, view-state resolution
 * and Lit templates can be unit-tested without a browser.
 */

import { html } from 'lit';
import { formatInteger, formatPercent } from './usageCharts.js';

export const DELEGATION_STATS_ROLES = Object.freeze(['plan', 'implement', 'review']);

/**
 * Monotonic request-token gate for the delegation stats panel.
 *
 * Every `begin()` invalidates older tokens, so a slow full-tab reload whose
 * stats request settled earlier can never repaint an older snapshot after a
 * newer panel-only refresh won the race. Extracted as pure logic so the
 * ordering guarantee is unit-testable without a DOM.
 *
 * @returns {{ begin: () => number, isCurrent: (token: number) => boolean, invalidate: () => number }}
 */
export function createDelegationStatsTokenGate() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    invalidate() {
      current += 1;
      return current;
    },
  };
}

const ROLE_LABEL_KEYS = Object.freeze({
  plan: 'delegationStats.rolePlan',
  implement: 'delegationStats.roleImplement',
  review: 'delegationStats.roleReview',
});

/**
 * @param {string} role
 * @returns {string} i18n key, or '' for an unknown role.
 */
export function delegationStatsRoleLabelKey(role) {
  return ROLE_LABEL_KEYS[String(role || '')] || '';
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * One API row -> typed view row. Invalid/missing identity is dropped.
 *
 * @param {object} row
 * @returns {object|null}
 */
export function normalizeDelegationStatsRow(row) {
  const harness = String(row?.harness || '').trim();
  const model = String(row?.model || '').trim();
  const role = String(row?.role || '').trim();
  if (!harness || !model || !DELEGATION_STATS_ROLES.includes(role)) return null;
  return {
    harness,
    model,
    role,
    n: Number(row?.n) || 0,
    passRate: finiteOrNull(row?.pass_rate),
    infraFailRate: finiteOrNull(row?.infra_fail_rate),
    medianMin: finiteOrNull(row?.median_min),
    p95Min: finiteOrNull(row?.p95_min),
    quality: finiteOrNull(row?.quality),
    verdictFailRate: finiteOrNull(row?.verdict_fail_rate),
    usefulRate: finiteOrNull(row?.useful_rate),
    // Weighted 1..5 star mean (user = 2, parent = 1) + raw rating count.
    ratingAvg: finiteOrNull(row?.rating_avg),
    ratingN: Number.isFinite(Number(row?.rating_n)) ? Math.max(0, Number(row?.rating_n)) : 0,
    lastUsedAt: String(row?.last_used_at || '').trim(),
  };
}

/**
 * Normalize + sort the API `list` (most jobs first, then stable identity).
 *
 * @param {object} payload
 * @returns {object[]}
 */
export function delegationStatsRows(payload) {
  const list = Array.isArray(payload?.list) ? payload.list : [];
  return list
    .map(normalizeDelegationStatsRow)
    .filter(Boolean)
    .sort((left, right) => (right.n - left.n)
      || left.role.localeCompare(right.role)
      || left.harness.localeCompare(right.harness)
      || left.model.localeCompare(right.model));
}

/**
 * Resolve the section view state from a settled fetch result.
 *
 * @param {unknown} payload
 * @returns {'ready'|'empty'|'error'}
 */
export function delegationStatsViewState(payload) {
  if (!payload || typeof payload !== 'object' || payload.ok !== true) return 'error';
  return delegationStatsRows(payload).length > 0 ? 'ready' : 'empty';
}

/**
 * @param {object} payload
 * @returns {string[]}
 */
export function delegationStatsUnused(payload) {
  const list = Array.isArray(payload?.unused_14d) ? payload.unused_14d : [];
  return [...new Set(list
    .map((row) => String(row || '').trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Distinguishes "catalog could not be read" from "catalog says nothing is
 * unused". The backend sets `unused_14d_error: true` when the harness catalog
 * lookup failed; rendering `[]` as success would falsely claim every enabled
 * harness had recent traffic.
 *
 * @param {unknown} payload
 * @returns {'ready'|'error'}
 */
export function delegationStatsUnusedState(payload) {
  return payload && typeof payload === 'object' && payload.unused_14d_error === true
    ? 'error'
    : 'ready';
}

/**
 * @param {number|null} value
 * @param {string} [lang]
 * @returns {string}
 */
export function formatDelegationRate(value, lang = 'en') {
  return formatPercent(value, lang);
}

/**
 * Number + localized minute unit. The unit comes from
 * `delegationStats.unitMinutes`; without a translator the bare number is
 * returned so no English unit is hardcoded outside i18n.
 *
 * @param {number|null} value
 * @param {string} [lang]
 * @param {(key: string, params?: object) => string} [t]
 * @returns {string}
 */
export function formatDelegationMinutes(value, lang = 'en', t) {
  if (value == null) return '—';
  const formatted = formatInteger(value, lang);
  return typeof t === 'function'
    ? t('delegationStats.unitMinutes', { n: formatted })
    : formatted;
}

/**
 * Observed quality on the 1–5 tier scale, one decimal.
 *
 * @param {number|null} value
 * @returns {string}
 */
export function formatDelegationQuality(value) {
  if (value == null) return '—';
  return Number(value).toFixed(1);
}

/**
 * Weighted 1–5 star mean with its record count, e.g. `4.5 (n=2)`. Without any
 * rating in the window the cell stays an em dash.
 *
 * @param {number|null} value
 * @param {number} [count]
 * @param {string} [lang]
 * @returns {string}
 */
export function formatDelegationRating(value, count, lang = 'en') {
  if (value == null || !Number(count)) return '—';
  return `${Number(value).toFixed(1)} (n=${formatInteger(Number(count), lang)})`;
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function formatDelegationLastUsed(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return '—';
  return Number.isFinite(Date.parse(raw)) ? raw.slice(0, 10) : '—';
}

/**
 * @param {number} windowMs
 * @returns {number|null}
 */
export function delegationStatsWindowDays(windowMs) {
  const ms = Number(windowMs);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / (24 * 60 * 60 * 1000)) : null;
}

/**
 * @param {(key: string, params?: object) => string} t
 */
export function renderDelegationStatsHeadView(t) {
  const columns = [
    'delegationStats.colHarness',
    'delegationStats.colModel',
    'delegationStats.colRole',
    'delegationStats.colN',
    'delegationStats.colPassRate',
    'delegationStats.colInfraFail',
    'delegationStats.colMedian',
    'delegationStats.colQuality',
    'delegationStats.colRating',
    'delegationStats.colLastUsed',
  ];
  return html`<tr>${columns.map((key) => html`<th scope="col">${t(key)}</th>`)}</tr>`;
}

/**
 * @param {string} role
 * @param {(key: string, params?: object) => string} t
 * @returns {string}
 */
function roleCell(role, t) {
  const key = delegationStatsRoleLabelKey(role);
  return key ? t(key) : role;
}

/**
 * @param {object[]} rows
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 */
export function renderDelegationStatsRowsView(rows, t, lang = 'en') {
  return rows.map((row) => html`<tr>
      <th scope="row" class="settings-usage-row-label">${row.harness}</th>
      <td class="settings-usage-row-label">${row.model}</td>
      <td>${roleCell(row.role, t)}</td>
      <td>${formatInteger(row.n, lang)}</td>
      <td>${formatDelegationRate(row.passRate, lang)}</td>
      <td>${formatDelegationRate(row.infraFailRate, lang)}</td>
      <td>${formatDelegationMinutes(row.medianMin, lang, t)}</td>
      <td>${formatDelegationQuality(row.quality)}</td>
      <td>${formatDelegationRating(row.ratingAvg, row.ratingN, lang)}</td>
      <td>${formatDelegationLastUsed(row.lastUsedAt)}</td>
    </tr>`);
}

/**
 * Narrow-screen card layout (<600px), mirroring the KPI table cards.
 *
 * @param {object[]} rows
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 */
export function renderDelegationStatsCardsView(rows, t, lang = 'en') {
  return rows.map((row) => html`<article class="settings-usage-card">
      <h5 class="settings-usage-card-title">${row.harness} · ${row.model}</h5>
      <dl class="settings-usage-card-stats">
        <div><dt>${t('delegationStats.colRole')}</dt><dd>${roleCell(row.role, t)}</dd></div>
        <div><dt>${t('delegationStats.colN')}</dt><dd>${formatInteger(row.n, lang)}</dd></div>
        <div><dt>${t('delegationStats.colPassRate')}</dt><dd>${formatDelegationRate(row.passRate, lang)}</dd></div>
        <div><dt>${t('delegationStats.colInfraFail')}</dt><dd>${formatDelegationRate(row.infraFailRate, lang)}</dd></div>
        <div><dt>${t('delegationStats.colMedian')}</dt><dd>${formatDelegationMinutes(row.medianMin, lang, t)}</dd></div>
        <div><dt>${t('delegationStats.colQuality')}</dt><dd>${formatDelegationQuality(row.quality)}</dd></div>
        <div><dt>${t('delegationStats.colRating')}</dt><dd>${formatDelegationRating(row.ratingAvg, row.ratingN, lang)}</dd></div>
        <div><dt>${t('delegationStats.colLastUsed')}</dt><dd>${formatDelegationLastUsed(row.lastUsedAt)}</dd></div>
      </dl>
    </article>`);
}

/**
 * @param {string[]} unused
 * @param {(key: string, params?: object) => string} t
 * @param {'ready'|'error'} [state]
 */
export function renderDelegationUnusedView(unused, t, state = 'ready') {
  if (state === 'error') {
    return html`<p class="settings-hint settings-usage-unused-error">${t('delegationStats.unusedUnavailable')}</p>`;
  }
  if (!Array.isArray(unused) || unused.length === 0) {
    return html`<p class="settings-hint">${t('delegationStats.noUnused')}</p>`;
  }
  return html`${unused.map((id) => html`<span class="settings-usage-tag">${id}</span> `)}`;
}

/**
 * Window + generated_at + min_jobs line.
 *
 * @param {object} payload
 * @param {(key: string, params?: object) => string} t
 * @returns {string}
 */
export function delegationStatsMetaText(payload, t) {
  const parts = [];
  const days = delegationStatsWindowDays(payload?.window_ms);
  if (days != null) parts.push(t('delegationStats.metaWindow', { days: String(days) }));
  const generatedAt = String(payload?.generated_at || '').trim();
  if (generatedAt) parts.push(t('delegationStats.metaGenerated', { at: generatedAt }));
  const minJobs = Number(payload?.min_jobs);
  if (Number.isFinite(minJobs)) parts.push(t('delegationStats.metaMinJobs', { n: String(minJobs) }));
  return parts.join(' · ');
}

/**
 * @param {object} payload
 * @returns {object[]}
 */
export function delegationLoopLeaves(payload) {
  const list = payload?.loop?.leaves;
  return Array.isArray(list) ? list : [];
}

/**
 * @param {object} payload
 * @returns {'ready'|'empty'|'error'}
 */
export function delegationLoopViewState(payload) {
  if (!payload || typeof payload !== 'object' || payload.ok !== true) return 'error';
  return delegationLoopLeaves(payload).length > 0 ? 'ready' : 'empty';
}

/**
 * @param {object} leaf
 * @returns {string}
 */
export function formatDelegationLoopLeafLabel(leaf) {
  const id = String(leaf?.leafId || '').trim();
  return id || 'chat';
}

/**
 * @param {object} leaf
 * @returns {string}
 */
export function summarizeDelegationLoopModels(leaf) {
  const roles = leaf?.roles && typeof leaf.roles === 'object' ? leaf.roles : {};
  const models = new Set();
  for (const bucket of Object.values(roles)) {
    if (!Array.isArray(bucket)) continue;
    for (const job of bucket) {
      const model = String(job?.model || '').trim();
      if (model) models.add(model);
    }
  }
  return [...models].sort((left, right) => left.localeCompare(right)).join(', ');
}

/**
 * @param {object} leaf
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function formatDelegationLoopVerify(leaf, t) {
  const verify = leaf?.verify;
  if (!verify || typeof verify !== 'object') return '—';
  if (verify.passed === true) return t('delegationStats.loopVerifyPassed');
  if (verify.required === true) return t('delegationStats.loopVerifyRequired');
  if (verify.recorded === true) return t('delegationStats.loopVerifyFailed');
  return t('delegationStats.loopVerifyNone');
}

/**
 * @param {number|null} wallTimeMs
 * @param {string} [lang]
 * @param {(key: string, params?: object) => string} [tr]
 * @returns {string}
 */
export function formatDelegationLoopWallMinutes(wallTimeMs, lang = 'en', tr) {
  if (!Number.isFinite(Number(wallTimeMs)) || Number(wallTimeMs) <= 0) return '—';
  return formatDelegationMinutes(Math.round(Number(wallTimeMs) / 60000), lang, tr);
}

/**
 * @param {object} leaf
 * @param {string} [lang]
 * @returns {string}
 */
export function formatDelegationLoopCost(leaf, _lang = 'en') {
  const cost = leaf?.cost;
  if (!cost || cost.costKnown !== true || cost.costUsd == null) return '—';
  return Number(cost.costUsd).toFixed(2);
}

/**
 * @param {(key: string) => string} t
 */
export function renderDelegationLoopHeadView(t) {
  const columns = [
    'delegationStats.loopColLeaf',
    'delegationStats.loopColRounds',
    'delegationStats.loopColModels',
    'delegationStats.loopColVerdicts',
    'delegationStats.loopColVerify',
    'delegationStats.loopColStop',
    'delegationStats.loopColWall',
    'delegationStats.loopColCost',
  ];
  return html`<tr>${columns.map((key) => html`<th scope="col">${t(key)}</th>`)}</tr>`;
}

/**
 * @param {object[]} leaves
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 */
export function renderDelegationLoopRowsView(leaves, t, lang = 'en') {
  return leaves.map((leaf) => {
    const verdicts = Array.isArray(leaf.verdicts) ? leaf.verdicts.join(', ') : '—';
    const stop = String(leaf.stopReason || '').trim() || '—';
    return html`<tr>
      <th scope="row" class="settings-usage-row-label">${formatDelegationLoopLeafLabel(leaf)}</th>
      <td>${formatInteger(Number(leaf.rounds) || 0, lang)}</td>
      <td class="settings-usage-row-label">${summarizeDelegationLoopModels(leaf)}</td>
      <td>${verdicts}</td>
      <td>${formatDelegationLoopVerify(leaf, t)}</td>
      <td>${stop}</td>
      <td>${formatDelegationLoopWallMinutes(leaf.cost?.wallTimeMs, lang, t)}</td>
      <td>${formatDelegationLoopCost(leaf, lang)}</td>
    </tr>`;
  });
}

/**
 * @param {object[]} leaves
 * @param {(key: string, params?: object) => string} t
 * @param {string} [lang]
 */
export function renderDelegationLoopCardsView(leaves, t, lang = 'en') {
  return leaves.map((leaf) => {
    const verdicts = Array.isArray(leaf.verdicts) ? leaf.verdicts.join(', ') : '—';
    const stop = String(leaf.stopReason || '').trim() || '—';
    return html`<article class="settings-usage-card">
      <h5 class="settings-usage-card-title">${formatDelegationLoopLeafLabel(leaf)}</h5>
      <dl class="settings-usage-card-stats">
        <div><dt>${t('delegationStats.loopColRounds')}</dt><dd>${formatInteger(Number(leaf.rounds) || 0, lang)}</dd></div>
        <div><dt>${t('delegationStats.loopColModels')}</dt><dd>${summarizeDelegationLoopModels(leaf)}</dd></div>
        <div><dt>${t('delegationStats.loopColVerdicts')}</dt><dd>${verdicts}</dd></div>
        <div><dt>${t('delegationStats.loopColVerify')}</dt><dd>${formatDelegationLoopVerify(leaf, t)}</dd></div>
        <div><dt>${t('delegationStats.loopColStop')}</dt><dd>${stop}</dd></div>
        <div><dt>${t('delegationStats.loopColWall')}</dt><dd>${formatDelegationLoopWallMinutes(leaf.cost?.wallTimeMs, lang, t)}</dd></div>
        <div><dt>${t('delegationStats.loopColCost')}</dt><dd>${formatDelegationLoopCost(leaf, lang)}</dd></div>
      </dl>
    </article>`;
  });
}
