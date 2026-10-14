import { escapeHtml, formatPercent } from './usageCharts.js';
import { formatErrorTime } from '../harness-health/harnessHealthModel.js';

/** @type {Record<string, string>} */
const WINDOW_TYPE_I18N = Object.freeze({
  five_hour: 'harnessHealth.windowFiveHour',
  seven_day: 'harnessHealth.windowSevenDay',
  seven_day_opus: 'harnessHealth.windowSevenDayOpus',
  seven_day_sonnet: 'harnessHealth.windowSevenDaySonnet',
  seven_day_overage_included: 'harnessHealth.windowSevenDay',
  session: 'harnessHealth.windowSession',
  overage: 'harnessHealth.windowOverage',
});

/** @type {Record<string, string>} */
const STATUS_I18N = Object.freeze({
  allowed: 'harnessHealth.windowAllowed',
  allowed_warning: 'harnessHealth.windowWarning',
  rejected: 'harnessHealth.windowRejected',
});

/** @type {Record<string, string>} */
const SOURCE_I18N = Object.freeze({
  'claude-sdk-rate-limit-event': 'usage.planSourceSdkRateLimit',
  'rate-limit-event': 'usage.planSourceSdkRateLimit',
  'codex-app-server': 'usage.planSourceCodex',
  'error-text': 'usage.planSourceErrorText',
});

/**
 * @param {unknown} rateLimitType
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function resolvePlanWindowTypeLabel(rateLimitType, t) {
  const raw = String(rateLimitType || '').trim();
  if (!raw) return t('usage.planWindowUnspecified');
  const key = WINDOW_TYPE_I18N[raw];
  if (key) return t(key);
  return t('usage.planWindowUnknown', { type: raw });
}

/**
 * @param {unknown} source
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
function resolvePlanSourceLabel(source, t) {
  const raw = String(source || '').trim();
  if (!raw) return '';
  const key = SOURCE_I18N[raw];
  return key ? t(key) : t('usage.planSourceOther', { source: raw });
}

/**
 * Provider-confirmed resets only; TTL fallbacks and legacy rows without
 * provenance stay unconfirmed (see harness health card).
 *
 * @param {unknown} resetSource
 * @returns {boolean}
 */
export function isPlanLockoutResetConfirmed(resetSource) {
  const source = String(resetSource || '').trim();
  return source === 'provider' || source === 'provider-message';
}

/**
 * @param {object} row
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
function resolvePlanStatusLabel(row, t) {
  if (row.expired === true) return t('harnessHealth.windowExpired');
  const status = String(row.status || '').trim();
  const key = STATUS_I18N[status];
  return key ? t(key) : status;
}

/**
 * @param {object} row
 * @param {(value: unknown) => string} time
 * @param {(key: string, vars?: object) => string} t
 * @param {string} lang
 * @returns {string}
 */
function renderPlanLimitCard(row, time, t, lang) {
  const text = [];
  if (row.scopeMismatch === true) text.push(t('usage.planScopeMismatch'));
  if (row.expired) text.push(t('usage.planExpired'));
  else {
    if (row.remainingPercent != null) {
      text.push(t('usage.planRemaining', { percent: formatPercent(row.remainingPercent / 100, lang) }));
    }
    if (row.resetsAt) {
      text.push(t('usage.planReset', { time: time(row.resetsAt), minutes: Math.ceil(row.resetInMs / 60000) }));
    } else if (!row.expired && row.status === 'rejected') {
      text.push(t('usage.planNoReset'));
    }
    if (row.stale) text.push(t('harnessHealth.planLimitStaleShort'));
    else if (row.forecast) {
      text.push(row.forecast.beforeReset
        ? t('usage.planForecast', { time: time(row.forecast.exhaustsAt) })
        : t('usage.planSafeForecast'));
    } else if (!row.expired) text.push(t('usage.planNoForecast'));
  }
  text.push(t('usage.planObserved', { time: time(row.observedAt) }));
  const utilizationObservedAt = String(row.utilizationObservedAt || '').trim();
  const observedAt = String(row.observedAt || '').trim();
  if (utilizationObservedAt && utilizationObservedAt !== observedAt) {
    text.push(t('usage.planUtilizationObserved', { time: time(utilizationObservedAt) }));
  }
  const sourceLabel = resolvePlanSourceLabel(row.source, t);
  if (sourceLabel) text.push(t('usage.planSource', { label: sourceLabel }));
  const known = !row.expired && row.utilization != null && Number.isFinite(Number(row.utilization));
  const percent = known ? Math.max(0, Math.min(100, Number(row.utilization))) : null;
  const windowLabel = resolvePlanWindowTypeLabel(row.rateLimitType, t);
  const statusLabel = resolvePlanStatusLabel(row, t);
  const title = `${String(row.harness || '').trim() || '—'} · ${windowLabel}`;
  const noPercent = percent == null && row.expired !== true
    ? `<p class="settings-hint">${escapeHtml(t('harnessHealth.planNoPercentage'))}</p>`
    : '';
  const bar = percent == null
    ? ''
    : `<p class="settings-hint"><progress max="100" value="${percent}" aria-label="${escapeHtml(t('harnessHealth.planLimitUsageAria', { percent: formatPercent(percent / 100, lang) }))}"></progress> ${escapeHtml(t('usage.planUtilization', { percent: formatPercent(percent / 100, lang) }))}</p>`;
  return `<article class="settings-usage-card"><h5 class="settings-usage-card-title">${escapeHtml(title)}</h5>`
    + (statusLabel ? `<p>${escapeHtml(statusLabel)}</p>` : '')
    + bar + noPercent
    + text.map((value) => `<p class="settings-hint">${escapeHtml(value)}</p>`).join('')
    + '</article>';
}

/**
 * @param {object} lock
 * @param {(value: unknown) => string} time
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
function renderLockoutCard(lock, time, t) {
  const model = lock.model || '—';
  const resetConfirmed = isPlanLockoutResetConfirmed(lock.resetSource);
  const windowPart = lock.rateLimitType
    ? ` · ${resolvePlanWindowTypeLabel(lock.rateLimitType, t)}`
    : '';
  const title = `${String(lock.harness || '').trim() || '—'}${windowPart}`;
  const body = resetConfirmed && lock.resetAt
    ? t('usage.planLocked', { model, time: time(lock.resetAt) })
    : t('usage.planLockedUnconfirmed', { model });
  return `<article class="settings-usage-card"><h5 class="settings-usage-card-title">${escapeHtml(title)}</h5><p>${escapeHtml(body)}</p></article>`;
}

/** Latest plan state is independent of the selected ledger date range. */
export function renderPlanLimitsHtml(payload, { t, lang = 'en' }) {
  const time = (value) => formatErrorTime(value, { lang }) || '—';
  const rows = Array.isArray(payload?.planLimits) ? payload.planLimits : [];
  const locks = Array.isArray(payload?.lockouts) ? payload.lockouts : [];
  const html = rows.map((row) => renderPlanLimitCard(row, time, t, lang));
  for (const lock of locks) html.push(renderLockoutCard(lock, time, t));
  if (payload?.codex?.available) {
    const codex = payload.codex;
    const details = [];
    if (codex.credits?.balance != null) details.push(t('usage.planCodexCredits', { balance: codex.credits.balance }));
    if (codex.resetCreditsAvailable != null) details.push(t('usage.planCodexResets', { count: codex.resetCreditsAvailable }));
    if (details.length) html.push(`<article class="settings-usage-card"><h5 class="settings-usage-card-title">Codex</h5>${details.map((text) => `<p class="settings-hint">${escapeHtml(text)}</p>`).join('')}</article>`);
  } else if (payload?.codex?.reason === 'read-failed') {
    html.push(`<p class="settings-hint">${escapeHtml(t('usage.planCodexReadFailed'))}</p>`);
  }
  return html.join('') || `<p class="settings-hint">${escapeHtml(t('usage.planEmpty'))}</p>`;
}
