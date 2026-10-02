import { escapeHtml, formatPercent } from './usageCharts.js';
import { formatErrorTime } from '../harness-health/harnessHealthModel.js';

/** Latest plan state is independent of the selected ledger date range. */
export function renderPlanLimitsHtml(payload, { t, lang = 'en' }) {
  const time = (value) => formatErrorTime(value, { lang }) || '—';
  const rows = Array.isArray(payload?.planLimits) ? payload.planLimits : [];
  const locks = Array.isArray(payload?.lockouts) ? payload.lockouts : [];
  const html = rows.map((row) => {
    const text = [];
    if (row.expired) text.push(t('usage.planExpired'));
    else {
      if (row.remainingPercent != null) text.push(t('usage.planRemaining', { percent: formatPercent(row.remainingPercent / 100, lang) }));
      if (row.resetsAt) text.push(t('usage.planReset', { time: time(row.resetsAt), minutes: Math.ceil(row.resetInMs / 60000) }));
      if (row.stale) text.push(t('harnessHealth.planLimitStaleShort'));
      else if (row.forecast) text.push(row.forecast.beforeReset
        ? t('usage.planForecast', { time: time(row.forecast.exhaustsAt) })
        : t('usage.planSafeForecast'));
      else text.push(t('usage.planNoForecast'));
    }
    text.push(t('usage.planObserved', { time: time(row.observedAt) }));
    const known = !row.expired && row.utilization != null && Number.isFinite(Number(row.utilization));
    const percent = known ? Math.max(0, Math.min(100, Number(row.utilization))) : null;
    return `<article class="settings-usage-card"><h5 class="settings-usage-card-title">${escapeHtml(row.harness)} · ${escapeHtml(row.rateLimitType || '—')}</h5>`
      + (row.status ? `<p>${escapeHtml(row.status)}</p>` : '')
      + (percent == null ? '' : `<progress max="100" value="${percent}" aria-label="${escapeHtml(t('harnessHealth.planLimitUsageAria', { percent: formatPercent(percent / 100, lang) }))}"></progress>`)
      + text.map((value) => `<p class="settings-hint">${escapeHtml(value)}</p>`).join('') + '</article>';
  });
  for (const lock of locks) html.push(`<article class="settings-usage-card"><h5 class="settings-usage-card-title">${escapeHtml(lock.harness)}</h5><p>${escapeHtml(t('usage.planLocked', { model: lock.model || '—', time: time(lock.resetAt) }))}</p></article>`);
  return html.join('') || `<p class="settings-hint">${escapeHtml(t('usage.planEmpty'))}</p>`;
}
