import { escapeHtml } from './chatHtmlUtils.js';

/** @param {number} ms @returns {string} m:ss or h:mm:ss */
export function formatCacheCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function formatTtl(ms, t) {
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? t('chat.cacheTtlHours', { value: String(minutes / 60) }) : t('chat.cacheTtlMinutes', { value: String(minutes) });
}

/**
 * Countdown to prompt-cache expiry. The remaining time is rendered from the
 * absolute `expiresAt`, so the live ticker only has to re-run this function.
 * @param {object|null} countdown `countdown` of `/api/usage/cache-freshness`
 * @param {(key: string, params?: object) => string} t
 * @param {number} [now]
 */
export function renderChatContextCacheCountdownHtml(countdown, t, now = Date.now()) {
  if (!countdown) return '';
  const heading = `<h3>${escapeHtml(t('chat.cacheCountdownTitle'))}</h3>`;
  if (countdown.state === 'unknown') {
    return heading + `<p class="settings-hint">${escapeHtml(t('chat.cacheCountdownUnknown'))}</p>`;
  }
  const ttlKey = countdown.ttlSource === 'observed' ? 'chat.cacheCountdownTtlObserved'
    : countdown.ttlApproximate ? 'chat.cacheCountdownTtlApprox' : 'chat.cacheCountdownTtl';
  const ttl = countdown.ttlMs ? ` ${escapeHtml(t(ttlKey, { ttl: formatTtl(countdown.ttlMs, t) }))}` : '';
  const estimated = countdown.source === 'samples' ? ` <span class="settings-hint">${escapeHtml(t('chat.cacheCountdownEstimated'))}</span>` : '';
  if (countdown.state === 'warm' && countdown.expiresAt) {
    const remaining = countdown.expiresAt - now;
    if (remaining > 0) {
      const ttlMs = countdown.ttlMs || 0;
      const level = resolveCountdownLevel(remaining, ttlMs);
      const percent = resolveCountdownPercent(remaining, ttlMs);
      const at = new Date(countdown.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return heading + `<div class="chat-context-countdown-card" data-cache-expires-at="${countdown.expiresAt}" data-cache-ttl-ms="${ttlMs}" data-level="${level}">`
        + `<div class="chat-context-cache-stats"><span>${escapeHtml(t(countdown.ttlApproximate ? 'chat.cacheCountdownExpiresInApprox' : 'chat.cacheCountdownExpiresIn'))}</span>`
        + `<strong class="chat-context-countdown" data-cache-countdown-text>${escapeHtml(formatCacheCountdown(remaining))}</strong></div>`
        + `<div class="chat-context-countdown-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}" aria-label="${escapeHtml(t('chat.cacheCountdownTitle'))}">`
        + `<span data-cache-countdown-bar style="width:${percent.toFixed(1)}%"></span></div>`
        + `<p class="settings-hint">${escapeHtml(t('chat.cacheCountdownExpiresAt', { time: at }))}${ttl}${estimated}</p>`
        + `<p class="settings-hint">${escapeHtml(t(countdown.refreshOnHit ? 'chat.cacheCountdownRefresh' : 'chat.cacheCountdownNoRefresh'))}</p></div>`;
    }
  }
  return heading + `<div class="chat-context-countdown-card" data-level="expired"><div class="chat-context-cache-stats"><span>${escapeHtml(t('chat.cacheCountdownExpired'))}</span>`
    + `<strong class="chat-context-countdown">0:00</strong></div>`
    + `<div class="chat-context-countdown-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div>`
    + `<p class="settings-hint">${escapeHtml(t('chat.cacheCountdownColdHint'))}${ttl}${estimated}</p></div>`;
}

/** Share of the cache lifetime that is left, 0-100. */
export function resolveCountdownPercent(remainingMs, ttlMs) {
  if (!(ttlMs > 0)) return 100;
  return Math.max(0, Math.min(100, remainingMs / ttlMs * 100));
}

/** Colour level of the bar: it drains from calm to urgent as the cache nears expiry. */
export function resolveCountdownLevel(remainingMs, ttlMs) {
  const percent = resolveCountdownPercent(remainingMs, ttlMs);
  if (percent > 40) return 'ok';
  if (percent > 15) return 'warn';
  return 'urgent';
}

/** Update every live countdown card in place; returns true while one is still running. */
export function tickCacheCountdowns(root, now = Date.now()) {
  let running = false;
  root.querySelectorAll('[data-cache-expires-at]').forEach((card) => {
    const remaining = Number(card.dataset.cacheExpiresAt) - now;
    const ttlMs = Number(card.dataset.cacheTtlMs) || 0;
    const text = card.querySelector('[data-cache-countdown-text]');
    const bar = card.querySelector('[data-cache-countdown-bar]');
    if (remaining <= 0) {
      if (text) text.textContent = '0:00';
      if (bar) bar.style.width = '0%';
      card.dataset.level = 'expired';
      return;
    }
    running = true;
    const percent = resolveCountdownPercent(remaining, ttlMs);
    if (text) text.textContent = formatCacheCountdown(remaining);
    if (bar) bar.style.width = `${percent.toFixed(1)}%`;
    card.dataset.level = resolveCountdownLevel(remaining, ttlMs);
  });
  return running;
}
