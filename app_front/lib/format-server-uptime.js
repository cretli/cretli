const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats elapsed server uptime for the connection status dialog.
 * @param {number} startedAt
 * @param {number} [now]
 * @returns {string}
 */
export function formatServerUptime(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '';
  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs < MINUTE_MS) return `${Math.floor(elapsedMs / 1000)}s`;
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  const hours = Math.floor(elapsedMs / HOUR_MS);
  const minutes = Math.floor((elapsedMs % HOUR_MS) / MINUTE_MS);
  if (elapsedMs < DAY_MS) return `${hours}h ${minutes}m`;
  const days = Math.floor(elapsedMs / DAY_MS);
  return `${days}d ${hours % 24}h`;
}
