/** Rebuild leaf A's counters-only contract; never retain remote free text. */
export function sanitizeFleetSummary(value) {
  function reject() { throw new Error('fleetInvalidSummary'); }
  if (!value || value.schemaVersion !== 1 || typeof value.instance?.online !== 'boolean') reject();
  const result = { schemaVersion: 1, instance: { online: value.instance.online } };
  for (const key of ['activeWatcherCycles', 'blockedTodos', 'plansAwaitingApproval']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) reject();
    result[key] = value[key];
  }
  if (!value.providerUsage || typeof value.providerUsage !== 'object' || Array.isArray(value.providerUsage)) reject();
  result.providerUsage = {};
  // Only known provider identifiers may become object keys in an API response.
  for (const provider of ['cursor', 'codex', 'claude', 'opencode', 'openrouter', 'deepseek', 'qwen', 'codebuddy', 'mistral']) {
    if (!Object.hasOwn(value.providerUsage, provider)) continue;
    const row = value.providerUsage[provider];
    if (!row || !['utilizationPercent', 'limitPercent'].every((key) => typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 100)) reject();
    result.providerUsage[provider] = { utilizationPercent: row.utilizationPercent, limitPercent: row.limitPercent };
  }
  return result;
}
