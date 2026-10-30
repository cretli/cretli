/**
 * Housekeeping hook for chat retention. Registered as a periodic job; it only
 * does work when `chatRetention.enabled` is true (default: disabled).
 */
import { applyChatRetention, getChatRetentionSettings } from './chat-retention.js';
import { loadSettings } from './persist/settings.js';

/** Hourly: retention is measured in days, so a fast cadence adds nothing. */
export const CHAT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export const chatRetentionJob = Object.freeze({
  id: 'chat_retention',
  label: 'Technical chat retention',
  settingKey: 'chatRetention',
  intervalMs: CHAT_RETENTION_INTERVAL_MS,
  runOnStart: false,
  jitterMs: 30_000,
  isEnabled: () => getChatRetentionSettings(loadSettings()).enabled,
  run: async () => {
    try {
      const result = await applyChatRetention();
      if (result.archived) console.log(`[chat-retention] archived ${result.archived} technical chat(s)`);
      return { archived: result.archived, skipped: result.skippedTotal };
    } catch (error) {
      console.warn('[chat-retention] sweep failed:', error?.message || error);
      return null;
    }
  },
});
