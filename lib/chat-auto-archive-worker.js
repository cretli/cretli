/**
 * Automatic chat archiving. Registered as a periodic job at delegation runtime
 * boot so only the owner process sweeps the shared store.
 *
 * Archiving is best-effort: a failing sweep must never take down the worker.
 */

import { sweepIdleChats } from './chat-auto-archive.js';
import { getChatAutoArchiveSettings, loadSettings } from './persist/settings.js';
import { publishNotification } from './notifications/notification-store.ts';

/**
 * One-minute cadence so a "minutes" idle window actually fires close to its
 * deadline. When the feature is off the tick only reads the small config file
 * (`sweepIdleChats` returns before loading chats).
 */
export const CHAT_AUTO_ARCHIVE_INTERVAL_MS = 60 * 1000;

/** Titles listed in a notification body before the rest is summarised. */
const NOTIFICATION_TITLE_LIMIT = 5;

/**
 * Log the archived chats and publish one notification for the sweep.
 * Fire-and-forget: a failing notification store never affects archiving.
 *
 * @param {ReturnType<typeof sweepIdleChats>} summary
 * @param {{ now?: number, publish?: Function, log?: (line: string) => void }} [options]
 * @returns {Promise<void> | undefined}
 */
export function reportChatAutoArchive(summary, options = {}) {
  const ids = Array.isArray(summary?.archived) ? summary.archived : [];
  if (!ids.length) return undefined;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const log = options.log || ((line) => console.log(line));
  const publish = options.publish || publishNotification;
  const titles = Array.isArray(summary.archivedTitles) ? summary.archivedTitles : ids;
  log(`[chat-auto-archive] archived ${ids.length} chat(s) idle >${summary.idleValue} ${summary.idleUnit}: ${ids.join(', ')}`);
  const shown = titles.slice(0, NOTIFICATION_TITLE_LIMIT).map((title) => `• ${title}`);
  const rest = titles.length - shown.length;
  if (rest > 0) shown.push(`+${rest}`);
  return Promise.resolve()
    .then(() => publish({
      category: 'system',
      severity: 'info',
      title: ids.length === 1 ? 'Archived 1 idle chat' : `Archived ${ids.length} idle chats`,
      body: shown.join('\n'),
      actionUrl: '',
      fingerprint: `chat-auto-archive#${now}#${ids[0]}`,
    }))
    .catch((error) => {
      console.warn('[chat-auto-archive] notification failed:', error?.message || error);
    });
}

/**
 * One sweep that can never throw.
 *
 * @param {Parameters<typeof sweepIdleChats>[0] & { report?: Function }} [options]
 * @returns {ReturnType<typeof sweepIdleChats> | null}
 */
export function runChatAutoArchiveSweep(options = {}) {
  try {
    const summary = sweepIdleChats(options);
    const report = typeof options.report === 'function' ? options.report : reportChatAutoArchive;
    void report(summary, { now: options.now });
    return summary;
  } catch {
    // A corrupt chat store is handled by the store itself; auto-archive is
    // optional and must stay silent instead of crashing the runtime worker.
    return null;
  }
}

/**
 * Periodic job for the shared runner (`lib/periodic-job-runner.js`). The
 * summary only carries counts, never chat titles or ids.
 */
export const chatAutoArchiveJob = Object.freeze({
  id: 'chat_auto_archive',
  label: 'Idle chat auto-archive',
  settingKey: 'chatAutoArchive',
  intervalMs: CHAT_AUTO_ARCHIVE_INTERVAL_MS,
  runOnStart: true,
  // Spread the first run (and interval phase) so it does not start in the same
  // second as the watcher heartbeat passes.
  jitterMs: 5000,
  isEnabled: () => getChatAutoArchiveSettings(loadSettings()).enabled,
  run: () => {
    const summary = runChatAutoArchiveSweep();
    return summary
      ? { archived: summary.archived.length, scanned: summary.considered }
      : null;
  },
});
