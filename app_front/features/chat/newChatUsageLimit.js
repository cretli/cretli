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
