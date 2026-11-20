/** Global usage-limit recovery notices; no provider requests or automatic runs. */
import { createHash } from 'node:crypto';
import { listHarnessRecoveryNotices, acknowledgeHarnessRecoveryNotice } from '../harness-usage-limits.js';
import { getNotificationCenterPreferences } from './notification-preferences.ts';
import { publishNotification } from './notification-store.ts';
import { broadcastPush } from '../push.js';

interface HarnessRecoveryRow {
  harness: string;
  model?: string;
  resetAt: unknown;
  resetSource?: string;
}

type PublishFn = (input: Record<string, unknown>) => Promise<{ created?: boolean }>;
type PushFn = (payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Fingerprints identify a reset window, so retries and duplicate error events
 * cannot create another notice for the same harness/model window.
 */
function fingerprintRecovery(row: HarnessRecoveryRow): string {
  const hash = createHash('sha256').update(JSON.stringify([
    row.harness, row.model || '', row.resetAt,
  ])).digest('hex');
  return `harness:recovery:${hash}`;
}

/**
 * Consume expired lockouts, including those that expired while the server was off.
 * Disabled notices are consumed too, preventing a backlog when re-enabled.
 */
export async function publishHarnessRecoveryNotices(
  options: { dataDir?: string; now?: number; preferences?: { harnessRecovery?: boolean }; publish?: PublishFn; push?: PushFn } = {},
): Promise<number> {
  const preferences = options.preferences || getNotificationCenterPreferences();
  const publish = options.publish || publishNotification;
  const push = options.push || broadcastPush;
  let published = 0;
  for (const row of listHarnessRecoveryNotices(options) as HarnessRecoveryRow[]) {
    if (preferences.harnessRecovery === false) {
      acknowledgeHarnessRecoveryNotice(row, options.dataDir);
      continue;
    }
    const providerReset = ['provider', 'provider-message'].includes(row.resetSource as string);
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
        console.warn('[notifications] harness recovery push failed:', (error as Error | undefined)?.message || error);
      }
    }
    acknowledgeHarnessRecoveryNotice(row, options.dataDir);
  }
  return published;
}

/**
 * Run once at startup and every 30 seconds, without overlapping slow deliveries.
 * @returns stop callback
 */
export function startHarnessRecoveryNotifications(options: { dataDir?: string } = {}): () => void {
  let running = false;
  const refresh = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await publishHarnessRecoveryNotices(options);
    } catch (error) {
      console.warn('[notifications] harness recovery failed:', (error as Error | undefined)?.message || error);
    } finally {
      running = false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
