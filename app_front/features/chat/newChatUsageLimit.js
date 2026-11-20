import { decodeModelValue } from '../../../lib/model-catalog.js';

/** Find an active provider lockout for this selection, excluding workspace startup failures. */
export function resolveNewChatUsageLimit(lockouts, harness, model, now = Date.now()) {
  const modelId = model ? decodeModelValue(String(model)).modelId.toLowerCase() : '';
  return (Array.isArray(lockouts) ? lockouts : []).find((row) => {
    if (!row || row.harness !== harness || row.code === 'startup_failure') return false;
    if (!(Date.parse(row.resetAt) > now)) return false;
    const limitedModel = row.model ? decodeModelValue(String(row.model)).modelId.toLowerCase() : '';
    return !limitedModel || limitedModel === modelId;
  }) || null;
}

/** Only expose a reset time explicitly confirmed by the provider. */
export function getNewChatLimitResetTime(limit, locale = globalThis.document?.documentElement?.lang || undefined) {
  if (!['provider', 'provider-message'].includes(limit?.resetSource)) return '';
  const time = Date.parse(limit.resetAt);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString(locale, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Remaining time until a provider-confirmed reset as `{ hours, minutes }`, or null when unknown/past. */
export function getNewChatLimitCountdown(limit, now = Date.now()) {
  if (!['provider', 'provider-message'].includes(limit?.resetSource)) return null;
  const left = Date.parse(limit.resetAt) - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const totalMinutes = Math.max(1, Math.ceil(left / 60000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
