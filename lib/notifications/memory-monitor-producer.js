/**
 * Publishes memory/orphan monitor alarms (written by
 * `scripts/memory-orphan-monitor.js` into `data/memory-monitor-alerts-*.jsonl`)
 * into the in-app notification centre.
 *
 * The notification store dedupes by fingerprint, so re-reading the same JSONL
 * on every server start is safe: an alarm written while the server was dead
 * becomes one visible row after the next start, and a replay creates nothing.
 * Triggered again periodically `server.js` surfaces alerts written while the
 * server is already running.
 */

import { readMemoryMonitorAlerts } from '../memory-monitor.js';
import { publishNotification, validatePublishInput } from './notification-store.js';

/** Category used for machine-level alerts; matches NOTIFICATION_CATEGORIES. */
export const MEMORY_MONITOR_NOTIFICATION_CATEGORY = 'system';

const SEVERITY_BY_ALERT = Object.freeze({
  error: 'error',
  important: 'important',
  warning: 'warning',
  info: 'info',
});

/**
 * Keep only the rows worth publishing from a newest-first list.
 *
 * Recurring episode alerts (fingerprints carrying `#episode:`) collapse to the
 * newest episode per type: after a long server stop the JSONL can hold many
 * repeats of the same threshold breach, and replaying all of them would flood
 * the notification centre. Discrete journal events (no `#episode:`) are one row
 * each, because every kill is a separate occurrence. Rows with an empty
 * fingerprint are kept and rejected later by `validatePublishInput`, so a lost
 * alarm is logged instead of silently dropped.
 *
 * @param {object[]} rows newest-first
 * @returns {object[]}
 */
export function selectPublishableAlerts(rows) {
  const seenEpisodeTypes = new Set();
  const selected = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.alert !== true) continue;
    const fingerprint = String(row.fingerprint || '').trim();
    if (fingerprint.includes('#episode:')) {
      const type = String(row.type || '');
      if (seenEpisodeTypes.has(type)) continue;
      seenEpisodeTypes.add(type);
    }
    selected.push(row);
  }
  return selected;
}

/**
 * @param {{ dataDir?: string, limit?: number, storePath?: string, broadcast?: boolean }} [options]
 * @returns {Promise<{ scanned: number, published: number, suppressed: number, invalid: number }>}
 */
export async function publishMemoryMonitorAlerts(options = {}) {
  const dataDir = String(options.dataDir || '').trim();
  if (!dataDir) return { scanned: 0, published: 0, suppressed: 0, invalid: 0 };
  const limit = Number.isFinite(options.limit) ? options.limit : 200;
  let rows = [];
  try {
    rows = readMemoryMonitorAlerts({ dataDir, limit });
  } catch {
    return { scanned: 0, published: 0, suppressed: 0, invalid: 0 };
  }
  const alertRows = rows.filter((row) => row && row.alert === true);
  const candidates = selectPublishableAlerts(rows);
  let published = 0;
  let invalid = 0;
  for (const row of candidates) {
    const fingerprint = String(row.fingerprint || '').trim();
    const input = {
      category: MEMORY_MONITOR_NOTIFICATION_CATEGORY,
      severity: SEVERITY_BY_ALERT[String(row.severity || '')] || 'warning',
      title: String(row.title || '').trim(),
      body: String(row.message || ''),
      actionUrl: '',
      fingerprint,
    };
    const checked = validatePublishInput(input);
    if (!checked.ok) {
      // A rejected fingerprint (over 512 characters, empty, bad severity/title)
      // used to disappear silently and be retried every minute. Make the loss
      // visible instead of pretending the alert was published.
      invalid += 1;
      console.warn('[notifications] memory-monitor alert skipped: invalid publish input', {
        type: String(row.type || ''),
        error: checked.error,
        fingerprintLength: fingerprint.length,
      });
      continue;
    }
    const result = await publishNotification(input, { storePath: options.storePath, broadcast: options.broadcast });
    if (result.created) published += 1;
  }
  return { scanned: rows.length, published, suppressed: alertRows.length - candidates.length, invalid };
}
