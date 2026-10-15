/** Global usage-limit recovery notices; no provider requests or automatic runs. */
import { createHash } from 'node:crypto';
import { listHarnessRecoveryNotices, acknowledgeHarnessRecoveryNotice } from '../harness-usage-limits.js';
import { getNotificationCenterPreferences } from './notification-preferences.js';
import { publishNotification } from './notification-store.js';
import { broadcastPush } from '../push.js';

/**
 * Fingerprints identify a reset window, so retries and duplicate error events
 * cannot create another notice for the same harness/model window.
 * @param {object} row
 * @returns {string}
 */
function fingerprintRecovery(row) {
  const hash = createHash('sha256').update(JSON.stringify([
    row.harness, row.model || '', row.resetAt,
  ])).digest('hex');
  return `harness:recovery:${hash}`;
}

/**
 * Consume expired lockouts, including those that expired while the server was off.
 * Disabled notices are consumed too, preventing a backlog when re-enabled.
 * @param {{ dataDir?: string, now?: number, preferences?: object, publish?: Function, push?: Function }} [options]
 * @returns {Promise<number>}
 */
export async function publishHarnessRecoveryNotices(options = {}) {
  const preferences = options.preferences || getNotificationCenterPreferences();
  const publish = options.publish || publishNotification;
  const push = options.push || broadcastPush;
  let published = 0;
  for (const row of listHarnessRecoveryNotices(options)) {
    if (preferences.harnessRecovery === false) {
      acknowledgeHarnessRecoveryNotice(row, options.dataDir);
      continue;
    }
    const providerReset = ['provider', 'provider-message'].includes(row.resetSource);
    const label = row.model ? `${row.harness} (${row.model})` : row.harness;
    const title = providerReset ? 'Harness usage limit reset' : 'Harness retry available';
    const body = providerReset
      ? `${label}: the provider's stated reset time has passed. You can try again.`
      : `${label}: the estimated retry time has passed. Availability has not been confirmed.`;
    const fingerprint = fingerprintRecovery(row);
    const actionUrl = '/?panel=settings&tab=harness';
    const result = await publish({ category: 'system', severity: 'important', title, body, actionUrl, fingerprint });
    if (result.created) {
      published += 1;
      // Push is best effort; a transient delivery error must not replay an episode.
      try {
        await push({ title, body, tag: fingerprint, data: {
          type: 'harness-recovery', eventId: fingerprint, url: actionUrl,
        } });
      } catch (error) {
        console.warn('[notifications] harness recovery push failed:', error?.message || error);
      }
    }
    acknowledgeHarnessRecoveryNotice(row, options.dataDir);
  }
  return published;
}

/**
 * Run once at startup and every 30 seconds, without overlapping slow deliveries.
 * @param {{ dataDir?: string }} [options]
 * @returns {() => void} stop callback
 */
export function startHarnessRecoveryNotifications(options = {}) {
  let running = false;
  const refresh = async () => {
    if (running) return;
    running = true;
    try {
      await publishHarnessRecoveryNotices(options);
    } catch (error) {
      console.warn('[notifications] harness recovery failed:', error?.message || error);
    } finally {
      running = false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
