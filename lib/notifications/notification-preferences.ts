/**
 * In-app notification centre preferences (server-side, separate from web-push toggles).
 * Stored on the server settings document (`config.json` → `notificationCenter`).
 */

import { loadSettings } from '../persist/settings.js';

export const NOTIFICATION_CENTER_PRESET_IDS: readonly string[] = Object.freeze(['all', 'important', 'custom']);

export const NOTIFICATION_CATEGORIES: readonly string[] = Object.freeze(['chat', 'models', 'cli', 'system']);

export type NotificationCenterPreset = 'all' | 'important' | 'custom';

export interface NotificationCenterPreferences {
  preset: NotificationCenterPreset;
  categories: { chat: boolean; models: boolean; cli: boolean; system: boolean };
  harnessRecovery: boolean;
  usageLimitResume: boolean;
  showBadge: boolean;
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_CENTER_PREFERENCES: NotificationCenterPreferences = Object.freeze({
  preset: 'all',
  categories: Object.freeze({
    chat: true,
    models: true,
    cli: true,
    system: true,
  }),
  harnessRecovery: true,
  usageLimitResume: true,
  showBadge: true,
  sound: true,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeNotificationCenterPreferences(raw: unknown): NotificationCenterPreferences {
  const source = isPlainObject(raw) ? raw : {};
  const preset = NOTIFICATION_CENTER_PRESET_IDS.includes(source.preset as string)
    ? (source.preset as NotificationCenterPreset)
    : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.preset;
  const categoriesIn = isPlainObject(source.categories) ? source.categories : {};
  const categories: Record<string, boolean> = {};
  for (const id of NOTIFICATION_CATEGORIES) {
    categories[id] = typeof categoriesIn[id] === 'boolean'
      ? (categoriesIn[id] as boolean)
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.categories[id as keyof NotificationCenterPreferences['categories']];
  }
  return {
    preset,
    categories: categories as unknown as NotificationCenterPreferences['categories'],
    harnessRecovery: typeof source.harnessRecovery === 'boolean' ? source.harnessRecovery : true,
    usageLimitResume: typeof source.usageLimitResume === 'boolean' ? source.usageLimitResume : true,
    showBadge: typeof source.showBadge === 'boolean'
      ? source.showBadge
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.showBadge,
    sound: typeof source.sound === 'boolean'
      ? source.sound
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.sound,
  };
}

export function getNotificationCenterPreferences(settings: Record<string, unknown> | null | undefined = null): NotificationCenterPreferences {
  const cfg = settings || loadSettings();
  return normalizeNotificationCenterPreferences((cfg as Record<string, unknown>).notificationCenter);
}

/**
 * Whether a notification row counts toward the unread badge and list filters.
 *
 */
export function notificationMatchesPreferences(preferences: NotificationCenterPreferences, item: { category: string; severity: string }): boolean {
  const prefs = normalizeNotificationCenterPreferences(preferences);
  const category = String(item?.category || '').trim();
  if (!NOTIFICATION_CATEGORIES.includes(category)) return false;
  if (prefs.preset === 'custom' && prefs.categories[category as keyof NotificationCenterPreferences['categories']] !== true) return false;
  const severity = String(item?.severity || '').trim();
  if (prefs.preset === 'important') {
    return severity === 'important' || severity === 'warning' || severity === 'error';
  }
  return true;
}

export function validateNotificationCenterPreferencesPatch(patch: unknown): { ok: true; value: NotificationCenterPreferences } | { ok: false } {
  if (!isPlainObject(patch)) return { ok: false };
  return { ok: true, value: normalizeNotificationCenterPreferences(patch) };
}
