import { escapeHtml } from './chatHtmlUtils.js';

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
    const reset = Number.isFinite(resetMs) ? new Date(resetMs).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) : '—';
    rows.push(`<article class="chat-context-quota"><div class="chat-context-quota-heading"><span>${escapeHtml(label)}</span><strong>${escapeHtml(headline)}</strong></div>`
      + (remaining == null ? '' : `<progress max="100" value="${remaining}" aria-label="${escapeHtml(label + ': ' + value)}"></progress>`)
      + `<p class="settings-hint">${escapeHtml(expired ? t('chat.contextPlanResetPending') : t('chat.contextPlanRenews', { time: reset }))}</p>`
      + (remaining == null && !expired ? `<p class="settings-hint">${escapeHtml(t('chat.contextPlanNoPercent'))}</p>` : '')
      + '</article>');
  }
  const stored = payload.stored === true && payload.observedAt
    ? `<p class="settings-hint">${escapeHtml(t('chat.contextPlanStoredAt', { time: new Date(payload.observedAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) }))}</p>` : '';
  return heading + stored + `<p class="chat-context-breakdown-note">${escapeHtml(t('chat.contextPlanLimitsShared'))}</p><div class="chat-context-quota-grid">${rows.join('') || `<p class="settings-hint">${escapeHtml(t('usage.planEmpty'))}</p>`}</div>`;
}
