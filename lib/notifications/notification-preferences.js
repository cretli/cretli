/**
 * In-app notification centre preferences (server-side, separate from web-push toggles).
 * Stored on the server settings document (`config.json` → `notificationCenter`).
 */

import { loadSettings } from '../persist/settings.js';

export const NOTIFICATION_CENTER_PRESET_IDS = Object.freeze(['all', 'important', 'custom']);

export const NOTIFICATION_CATEGORIES = Object.freeze(['chat', 'models', 'cli', 'system']);

/** @typedef {'all' | 'important' | 'custom'} NotificationCenterPreset */

/**
 * @typedef {{
 *   preset: NotificationCenterPreset,
 *   categories: { chat: boolean, models: boolean, cli: boolean, system: boolean },
 *   showBadge: boolean,
 *   sound: boolean,
 * }} NotificationCenterPreferences
 */

/** @type {NotificationCenterPreferences} */
export const DEFAULT_NOTIFICATION_CENTER_PREFERENCES = Object.freeze({
  preset: 'all',
  categories: Object.freeze({
    chat: true,
    models: true,
    cli: true,
    system: true,
  }),
  showBadge: true,
  sound: true,
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} raw
 * @returns {NotificationCenterPreferences}
 */
export function normalizeNotificationCenterPreferences(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const preset = NOTIFICATION_CENTER_PRESET_IDS.includes(source.preset)
    ? /** @type {NotificationCenterPreset} */ (source.preset)
    : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.preset;
  const categoriesIn = isPlainObject(source.categories) ? source.categories : {};
  /** @type {Record<string, boolean>} */
  const categories = {};
  for (const id of NOTIFICATION_CATEGORIES) {
    categories[id] = typeof categoriesIn[id] === 'boolean'
      ? categoriesIn[id]
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.categories[id];
  }
  return {
    preset,
    categories: /** @type {NotificationCenterPreferences['categories']} */ (categories),
    showBadge: typeof source.showBadge === 'boolean'
      ? source.showBadge
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.showBadge,
    sound: typeof source.sound === 'boolean'
      ? source.sound
      : DEFAULT_NOTIFICATION_CENTER_PREFERENCES.sound,
  };
}

/**
 * @param {object | null | undefined} [settings]
 * @returns {NotificationCenterPreferences}
 */
export function getNotificationCenterPreferences(settings = null) {
  const cfg = settings || loadSettings();
  return normalizeNotificationCenterPreferences(cfg.notificationCenter);
}

/**
 * Whether a notification row counts toward the unread badge and list filters.
 *
 * @param {NotificationCenterPreferences} preferences
 * @param {{ category: string, severity: string }} item
 * @returns {boolean}
 */
export function notificationMatchesPreferences(preferences, item) {
  const prefs = normalizeNotificationCenterPreferences(preferences);
  const category = String(item?.category || '').trim();
  if (!NOTIFICATION_CATEGORIES.includes(category)) return false;
  if (prefs.preset === 'custom' && prefs.categories[category] !== true) return false;
  const severity = String(item?.severity || '').trim();
  if (prefs.preset === 'important') {
    return severity === 'important' || severity === 'warning' || severity === 'error';
  }
  return true;
}

/**
 * @param {unknown} patch
 * @returns {{ ok: true, value: NotificationCenterPreferences } | { ok: false }}
 */
export function validateNotificationCenterPreferencesPatch(patch) {
  if (!isPlainObject(patch)) return { ok: false };
  return { ok: true, value: normalizeNotificationCenterPreferences(patch) };
}
