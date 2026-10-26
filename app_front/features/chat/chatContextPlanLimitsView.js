import { escapeHtml } from './chatHtmlUtils.js';

const HOUR_MS = 3600000;

/** A stored plan reading older than this is flagged as possibly out of date. */
const STALE_READING_MS = HOUR_MS;

function formatAge(ageMs, t) {
  const hours = Math.floor(ageMs / HOUR_MS);
  return hours >= 48 ? t('chat.contextPlanAgeDays', { n: Math.floor(hours / 24) }) : t('chat.contextPlanAgeHours', { n: hours });
}

/** Window length by `rateLimitType` suffix (Codex prefixes non-default buckets with `<id>:`). */
function windowLengthMs(type) {
  const suffix = String(type || '').toLowerCase().split(':').pop();
  if (suffix === 'five_hour') return 5 * HOUR_MS;
  if (suffix.startsWith('seven_day')) return 7 * 24 * HOUR_MS;
  return null;
}

/**
 * Pace of a quota window: used share vs. share of the window time that has
 * already passed. `slack` > 0 means usage is behind an even burn rate.
 */
function computePace({ type, resetMs, now, used }) {
  const length = windowLengthMs(type);
  if (!length || !Number.isFinite(resetMs) || !Number.isFinite(used)) return null;
  const elapsed = Math.min(100, Math.max(0, ((length - (resetMs - now)) / length) * 100));
  const unitMs = length <= 5 * HOUR_MS ? HOUR_MS : 24 * HOUR_MS;
  const elapsedUnits = (elapsed / 100) * (length / unitMs);
  return {
    elapsed,
    slack: elapsed - used,
    ticks: Math.round(length / unitMs),
    unit: unitMs === HOUR_MS ? 'h' : 'd',
    rate: elapsedUnits > 0.05 ? used / elapsedUnits : null,
    even: 100 / (length / unitMs),
  };
}

function paceState(pace) {
  return Math.abs(pace.slack) < 2 ? 'even' : pace.slack > 0 ? 'ahead' : 'behind';
}

/** Quota bar with a time-left layer and hour/day ticks on the same track. */
function renderQuotaBarHtml({ remaining, pace, ariaLabel }) {
  const ticks = pace ? Array.from({ length: pace.ticks - 1 }, (_, i) => `<i style="left:${(((i + 1) / pace.ticks) * 100).toFixed(2)}%"></i>`).join('') : '';
  const timeWidth = pace ? 100 - pace.elapsed : 0;
  // The longer layer goes underneath so the shorter one stays visible on top.
  const timeLeft = pace ? `<b style="width:${timeWidth.toFixed(2)}%;z-index:${timeWidth > remaining ? 0 : 1}"></b>` : '';
  return `<div class="chat-context-quota-bar"${pace ? ` data-pace="${paceState(pace)}"` : ''} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}" aria-label="${escapeHtml(ariaLabel)}">${timeLeft}<span style="width:${remaining}%;z-index:${pace && timeWidth > remaining ? 1 : 0}"></span>${ticks}</div>`;
}

function renderPaceTextHtml(pace, { t, lang }) {
  const fmt = (n) => n.toLocaleString(lang, { maximumFractionDigits: 1 });
  const state = paceState(pace);
  const text = t(`chat.contextPlanPace_${state}`, { points: fmt(Math.abs(pace.slack)) });
  const rate = pace.rate == null ? '' : ' · ' + t('chat.contextPlanPaceRate', { rate: fmt(pace.rate), even: fmt(pace.even), unit: pace.unit });
  return `<p class="settings-hint chat-context-quota-pace" data-pace="${state}">${escapeHtml(text + rate)}</p>`;
}

/** Show account quotas separately from the context window of the current chat. */
export function renderChatContextPlanLimitsHtml(payload, { t, lang = 'en', now = Date.now(), harness = 'codex' }) {
  const titleKey = harness === 'claude' ? 'chat.contextPlanLimitsTitleClaude' : 'chat.contextPlanLimitsTitle';
  const heading = `<h3>${escapeHtml(t(titleKey))}</h3>`;
  if (!payload) return heading + `<p class="settings-hint">${escapeHtml(t('usage.loading'))}</p>`;
  if (!payload.available) {
    const key = payload.reason === 'api-key' ? 'chat.contextPlanLimitsApiKey'
      : payload.reason === 'login-required' ? 'chat.contextPlanLimitsLogin'
      : payload.reason === 'no-data' ? 'chat.contextPlanLimitsNoData'
      : 'usage.planCodexReadFailed';
    return heading + `<p class="settings-hint">${escapeHtml(t(key))}</p>`;
  }
  const rows = [];
  for (const window of Array.isArray(payload.windows) ? payload.windows : []) {
    const type = window.rateLimitType;
    const label = type === 'five_hour' ? t('harnessHealth.windowFiveHour')
      : type === 'seven_day' ? t('harnessHealth.windowSevenDay')
        : type === 'seven_day_opus' ? t('chat.contextPlanWindowOpus')
          : type === 'seven_day_sonnet' ? t('chat.contextPlanWindowSonnet') : String(type || '—');
    const resetMs = Date.parse(window.resetsAt);
    const expired = Number.isFinite(resetMs) && resetMs <= now;
    const percent = window.utilization;
    const remaining = !expired && typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? 100 - percent : null;
    const value = remaining == null ? '—' : `${remaining.toLocaleString(lang, { maximumFractionDigits: 1 })}%`;
    // A window can be known (status, reset time) without a reported percentage.
    const statusKey = `chat.contextPlanStatus_${window.status}`;
    const statusText = remaining == null && !expired && window.status ? t(statusKey) : '';
    const headline = statusText && statusText !== statusKey ? statusText : t('chat.contextPlanRemaining', { percent: value });
    const pace = !expired && remaining != null ? computePace({ type, resetMs, now, used: percent }) : null;
    // A stored reading older than an hour can lag the real quota; say how old it is.
    const observedMs = Date.parse(window.observedAt);
    const ageMs = payload.stored === true && Number.isFinite(observedMs) ? now - observedMs : 0;
    const staleHint = remaining != null && ageMs > STALE_READING_MS
      ? `<p class="settings-hint" data-stale="true">${escapeHtml(t('chat.contextPlanStaleReading', { age: formatAge(ageMs, t) }))}</p>` : '';
    const reset = Number.isFinite(resetMs) ? new Date(resetMs).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) : '—';
    rows.push(`<article class="chat-context-quota"><div class="chat-context-quota-heading"><span>${escapeHtml(label)}</span><strong>${escapeHtml(headline)}</strong></div>`
      + (remaining == null ? '' : renderQuotaBarHtml({ remaining, pace, ariaLabel: label + ': ' + value }))
      + (pace ? renderPaceTextHtml(pace, { t, lang }) : '')
      + staleHint
      + `<p class="settings-hint">${escapeHtml(expired ? t('chat.contextPlanResetPending') : t('chat.contextPlanRenews', { time: reset }))}</p>`
      + (remaining == null && !expired ? `<p class="settings-hint">${escapeHtml(t('chat.contextPlanNoPercent'))}</p>` : '')
      + '</article>');
  }
  const stored = payload.stored === true && payload.observedAt
    ? `<p class="settings-hint">${escapeHtml(t('chat.contextPlanStoredAt', { time: new Date(payload.observedAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) }))}</p>` : '';
  return heading + stored + `<p class="chat-context-breakdown-note">${escapeHtml(t('chat.contextPlanLimitsShared'))}</p><div class="chat-context-quota-grid">${rows.join('') || `<p class="settings-hint">${escapeHtml(t('usage.planEmpty'))}</p>`}</div>`;
}
