/**
 * Web Push notification preferences — the per-endpoint preferences contract.
 *
 * This module is intentionally PURE and browser/Service-Worker safe:
 * - no `node:` imports, no fs, no Buffer, no localStorage access;
 * - every function is deterministic and never throws for garbage input.
 *
 * Storage location (client side): the generic app preferences IndexedDB
 * `cretli-preferences` / store `kv` (same database that app_front/lib/favorites.js
 * already uses). It is deliberately NOT the push inbox database
 * (`cretli-push-inbox` / `events`), whose keyPath is `chatId`: writing a
 * preferences record keyed by endpoint into the inbox store could overwrite or
 * be confused with inbox events. This module only exposes the location constants
 * and a key builder; the actual IDB/localStorage wiring lives in later leaves.
 *
 * Server side, preferences are stored beside the web-push subscription record
 * (`{ ...subscription, preferences }`) so they are NEVER passed to
 * `webPush.sendNotification` (see `stripPushPreferences`).
 */

export const PUSH_PREFERENCES_SCHEMA_VERSION = 1;

/** Notification event types a device can opt in/out of, independently. */
export const PUSH_EVENT_TYPES = Object.freeze(['finished', 'question', 'permission', 'newChat']);

/**
 * Vibration presets. `off` intentionally maps to an empty pattern so callers can
 * omit `vibrate` entirely instead of sending an empty array.
 */
export const PUSH_VIBRATE_PRESETS = Object.freeze({
  off: Object.freeze([]),
  short: Object.freeze([80]),
  default: Object.freeze([80, 40, 80]),
  long: Object.freeze([200, 100, 200]),
});

/** Frozen list of the valid preset ids (enum values). */
export const PUSH_VIBRATE_PRESET_IDS = Object.freeze(Object.keys(PUSH_VIBRATE_PRESETS));

/** Synthesized in-app sounds, shared by previews and live notifications. */
export const NOTIFICATION_SOUND_PRESETS = Object.freeze({
  default: Object.freeze({ frequency: 880, durationMs: 180, pulses: 1 }),
  low: Object.freeze({ frequency: 440, durationMs: 240, pulses: 1 }),
  bell: Object.freeze({ frequency: 1175, durationMs: 320, pulses: 1 }),
  double: Object.freeze({ frequency: 660, durationMs: 120, pulses: 2 }),
});
export const NOTIFICATION_SCOPES = Object.freeze(['chat', 'subchat']);

/**
 * @typedef {{ pushVibrate: string, inAppVibrate: boolean, inAppSound: boolean,
 *   vibratePreset: string, soundPreset: string, volume: number | null }} NotificationProfile
 */

/**
 * Resolve the notification owner for live chat metadata or push data.
 * @param {unknown} input
 * @returns {'chat' | 'subchat'}
 */
export function resolveNotificationScope(input) {
  const source = isPlainObject(input?.data) ? input.data : input;
  return source?.notificationScope === 'subchat'
    || !!source?.delegationParentChatId || !!source?.forkParentChatId
    ? 'subchat' : 'chat';
}

/**
 * Fill a profile from legacy preferences so upgrades preserve existing signals.
 * @param {unknown} raw
 * @param {{ pushVibrate: string, inAppVibrate: boolean, inAppSound: boolean }} legacy
 * @returns {NotificationProfile}
 */
function normalizeNotificationProfile(raw, legacy) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    pushVibrate: isKnownVibratePreset(source.pushVibrate) ? source.pushVibrate : legacy.pushVibrate,
    inAppVibrate: typeof source.inAppVibrate === 'boolean' ? source.inAppVibrate : legacy.inAppVibrate,
    inAppSound: typeof source.inAppSound === 'boolean' ? source.inAppSound : legacy.inAppSound,
    vibratePreset: isKnownVibratePreset(source.vibratePreset) ? source.vibratePreset : 'default',
    soundPreset: typeof source.soundPreset === 'string' && Object.hasOwn(NOTIFICATION_SOUND_PRESETS, source.soundPreset)
      ? source.soundPreset : 'default',
    volume: typeof source.volume === 'number' && Number.isFinite(source.volume)
      ? Math.min(1, Math.max(0, source.volume)) : null,
  };
}

/**
 * Select a chat/subchat profile; old records retain their shared settings.
 * @param {unknown} preferences
 * @param {unknown} input
 * @returns {NotificationProfile}
 */
export function resolveNotificationProfile(preferences, input) {
  const prefs = normalizePushPreferences(preferences);
  return normalizeNotificationProfile(prefs.profiles?.[resolveNotificationScope(input)], prefs);
}

/**
 * The canonical v1 defaults. Deep-frozen: `normalizePushPreferences` always
 * builds fresh nested objects, so no caller can mutate this constant.
 */
export const DEFAULT_PUSH_PREFERENCES = Object.freeze({
  schemaVersion: PUSH_PREFERENCES_SCHEMA_VERSION,
  enabled: true,
  events: Object.freeze({ finished: true, question: true, permission: true, newChat: true }),
  pushVibrate: 'default',
  inAppVibrate: false,
  inAppSound: false,
});

/** Client-side storage location for this feature (see module header). */
export const PUSH_PREFERENCES_DB_NAME = 'cretli-preferences';
export const PUSH_PREFERENCES_STORE_NAME = 'kv';
export const PUSH_PREFERENCES_KEY_PREFIX = 'push-preferences:';

/** Legacy localStorage flag used by app_front/features/pwa/pushSubscription.js. */
export const LEGACY_PUSH_ENABLED_STORAGE_KEY = 'cretli-push-enabled';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isKnownVibratePreset(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PUSH_VIBRATE_PRESETS, value);
}

/**
 * Lenient normalization: always returns a full, fresh, validated object.
 * Missing fields fall back to defaults; wrong types and unknown enum ids are
 * replaced with defaults; unknown keys are ignored; `schemaVersion` is forced.
 *
 * Fresh nested objects are guaranteed on every call, so two endpoints can never
 * share (and mutate) the same `events` object.
 *
 * @param {unknown} raw
 * @returns {{ schemaVersion: number, enabled: boolean, events: { finished: boolean, question: boolean, permission: boolean, newChat: boolean }, pushVibrate: string, inAppVibrate: boolean, inAppSound: boolean, profiles?: { chat: NotificationProfile, subchat: NotificationProfile } }}
 */
export function normalizePushPreferences(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const rawEvents = isPlainObject(source.events) ? source.events : {};
  /** @type {{ finished: boolean, question: boolean, permission: boolean, newChat: boolean }} */
  const events = {
    finished: typeof rawEvents.finished === 'boolean'
      ? rawEvents.finished
      : DEFAULT_PUSH_PREFERENCES.events.finished,
    question: typeof rawEvents.question === 'boolean'
      ? rawEvents.question
      : DEFAULT_PUSH_PREFERENCES.events.question,
    permission: typeof rawEvents.permission === 'boolean'
      ? rawEvents.permission
      : DEFAULT_PUSH_PREFERENCES.events.permission,
    newChat: typeof rawEvents.newChat === 'boolean'
      ? rawEvents.newChat
      : DEFAULT_PUSH_PREFERENCES.events.newChat,
  };
  const preferences = {
    schemaVersion: PUSH_PREFERENCES_SCHEMA_VERSION,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_PUSH_PREFERENCES.enabled,
    events,
    pushVibrate: isKnownVibratePreset(source.pushVibrate)
      ? source.pushVibrate
      : DEFAULT_PUSH_PREFERENCES.pushVibrate,
    inAppVibrate: typeof source.inAppVibrate === 'boolean'
      ? source.inAppVibrate
      : DEFAULT_PUSH_PREFERENCES.inAppVibrate,
    inAppSound: typeof source.inAppSound === 'boolean'
      ? source.inAppSound
      : DEFAULT_PUSH_PREFERENCES.inAppSound,
  };
  if (isPlainObject(source.profiles)) {
    preferences.profiles = Object.fromEntries(NOTIFICATION_SCOPES.map((scope) => [
      scope, normalizeNotificationProfile(source.profiles[scope], preferences),
    ]));
  }
  return preferences;
}

/**
 * Strict validator used by the HTTP route to reject bad input. Unlike
 * `normalizePushPreferences`, a wrong type / unknown enum id / unknown event key
 * makes the whole payload invalid. Unknown top-level keys are ignored for
 * forward compatibility; `schemaVersion` must be absent or the current version.
 *
 * On success `value` is the normalized object.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: ReturnType<typeof normalizePushPreferences> } | { ok: false, error: string }}
 */
export function validatePushPreferences(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'not_an_object' };
  if (Object.hasOwn(raw, 'profiles')) {
    if (!isPlainObject(raw.profiles)) return { ok: false, error: 'invalid_profiles' };
    for (const [scope, profile] of Object.entries(raw.profiles)) {
      if (!NOTIFICATION_SCOPES.includes(scope) || !isPlainObject(profile)) {
        return { ok: false, error: 'invalid_profile' };
      }
      for (const key of ['pushVibrate', 'vibratePreset']) {
        if (Object.hasOwn(profile, key) && !isKnownVibratePreset(profile[key])) {
          return { ok: false, error: 'unknown_vibrate_preset' };
        }
      }
      for (const key of ['inAppVibrate', 'inAppSound']) {
        if (Object.hasOwn(profile, key) && typeof profile[key] !== 'boolean') {
          return { ok: false, error: 'invalid_profile_signal' };
        }
      }
      if (Object.hasOwn(profile, 'soundPreset')
        && (typeof profile.soundPreset !== 'string' || !Object.hasOwn(NOTIFICATION_SOUND_PRESETS, profile.soundPreset))) {
        return { ok: false, error: 'unknown_sound_preset' };
      }
      if (Object.hasOwn(profile, 'volume') && profile.volume !== null
        && (typeof profile.volume !== 'number' || !Number.isFinite(profile.volume) || profile.volume < 0 || profile.volume > 1)) {
        return { ok: false, error: 'invalid_profile_volume' };
      }
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, 'schemaVersion')
    && raw.schemaVersion !== PUSH_PREFERENCES_SCHEMA_VERSION
  ) {
    return { ok: false, error: 'unsupported_schema_version' };
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, 'enabled')
    && typeof raw.enabled !== 'boolean'
  ) {
    return { ok: false, error: 'invalid_enabled' };
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'events')) {
    if (!isPlainObject(raw.events)) return { ok: false, error: 'invalid_events' };
    for (const key of Object.keys(raw.events)) {
      if (!PUSH_EVENT_TYPES.includes(key)) return { ok: false, error: 'unknown_event' };
      if (typeof raw.events[key] !== 'boolean') return { ok: false, error: 'invalid_event_value' };
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, 'pushVibrate')
    && !isKnownVibratePreset(raw.pushVibrate)
  ) {
    return { ok: false, error: 'unknown_vibrate_preset' };
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, 'inAppVibrate')
    && typeof raw.inAppVibrate !== 'boolean'
  ) {
    return { ok: false, error: 'invalid_in_app_vibrate' };
  }
  if (
    Object.prototype.hasOwnProperty.call(raw, 'inAppSound')
    && typeof raw.inAppSound !== 'boolean'
  ) {
    return { ok: false, error: 'invalid_in_app_sound' };
  }
  return { ok: true, value: normalizePushPreferences(raw) };
}

/**
 * Merge a (possibly partial) patch over existing preferences. Fields omitted by
 * the patch keep their existing value, so re-POSTing a subscription does not
 * zero previously stored preferences. Invalid patch values are ignored (keep the
 * existing value) rather than reset to defaults. Unknown keys are ignored.
 *
 * @param {unknown} existing
 * @param {unknown} patch
 * @returns {ReturnType<typeof normalizePushPreferences>}
 */
export function mergePushPreferences(existing, patch) {
  const base = normalizePushPreferences(existing);
  const source = isPlainObject(patch) ? patch : {};
  const events = { ...base.events };
  if (isPlainObject(source.events)) {
    for (const type of PUSH_EVENT_TYPES) {
      if (typeof source.events[type] === 'boolean') events[type] = source.events[type];
    }
  }
  const next = {
    schemaVersion: base.schemaVersion,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    events,
    pushVibrate: isKnownVibratePreset(source.pushVibrate) ? source.pushVibrate : base.pushVibrate,
    inAppVibrate: typeof source.inAppVibrate === 'boolean' ? source.inAppVibrate : base.inAppVibrate,
    inAppSound: typeof source.inAppSound === 'boolean' ? source.inAppSound : base.inAppSound,
  };
  if (base.profiles || isPlainObject(source.profiles)) {
    next.profiles = Object.fromEntries(NOTIFICATION_SCOPES.map((scope) => {
      const profile = resolveNotificationProfile(base, { notificationScope: scope });
      const patchProfile = isPlainObject(source.profiles?.[scope]) ? source.profiles[scope] : {};
      const validPatch = Object.fromEntries(Object.entries(patchProfile).filter(([key, value]) => (
        validatePushPreferences({ profiles: { [scope]: { [key]: value } } }).ok
      )));
      return [scope, { ...profile, ...validPatch }];
    }));
  }
  return normalizePushPreferences(next);
}

/**
 * @param {unknown} presetId
 * @returns {readonly number[]} the frozen pattern for the enum id, default otherwise
 */
export function resolvePushVibratePattern(presetId) {
  if (isKnownVibratePreset(presetId)) return PUSH_VIBRATE_PRESETS[presetId];
  return PUSH_VIBRATE_PRESETS.default;
}

/**
 * Resolve a vibrate pattern carried by the notification payload, or `undefined`
 * when the payload has no vibrate-related field.
 *
 * @param {unknown} payload
 * @returns {readonly number[] | undefined}
 */
function resolvePayloadVibratePattern(payload) {
  if (!isPlainObject(payload)) return undefined;
  if (Array.isArray(payload.vibrate)) return payload.vibrate;
  if (typeof payload.vibrate === 'string') return resolvePushVibratePattern(payload.vibrate);
  if (typeof payload.vibratePreset === 'string') return resolvePushVibratePattern(payload.vibratePreset);
  if (typeof payload.pushVibrate === 'string') return resolvePushVibratePattern(payload.pushVibrate);
  return undefined;
}

/**
 * PURE builder for the `NotificationOptions` subset owned by this feature.
 *
 * Rules:
 * - `payload.silent === true` => `{ silent: true }` with NO `vibrate`;
 * - payload without any new option field => the preferences pattern
 *   (`pushVibrate`, default `[80,40,80]`) is kept;
 * - `pushVibrate: 'off'` (or an empty pattern) => `vibrate` is omitted;
 * - otherwise `vibrate` is the resolved pattern.
 *
 * Only `vibrate` / `silent` are produced here. `payload.options` (TTL/urgency)
 * are HTTP web-push options and are intentionally untouched.
 *
 * @param {unknown} payload
 * @param {unknown} preferences
 * @returns {{ silent?: true, vibrate?: number[] }}
 */
export function buildPushNotificationOptions(payload, preferences) {
  if (isPlainObject(payload) && payload.silent === true) return { silent: true };
  const prefs = resolveNotificationProfile(preferences, payload);
  const payloadPattern = resolvePayloadVibratePattern(payload);
  const pattern = payloadPattern === undefined
    ? resolvePushVibratePattern(prefs.pushVibrate)
    : payloadPattern;
  /** @type {{ silent?: true, vibrate?: number[] }} */
  const options = {};
  if (Array.isArray(pattern) && pattern.length > 0) options.vibrate = Array.from(pattern);
  return options;
}

/**
 * Stable IndexedDB key for one endpoint's preferences. Pure; empty input maps to
 * an empty key so callers can detect an invalid endpoint.
 *
 * @param {unknown} endpoint
 * @returns {string}
 */
export function buildPushPreferencesStorageKey(endpoint) {
  const value = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!value) return '';
  return `${PUSH_PREFERENCES_KEY_PREFIX}${value}`;
}

/**
 * One-time migration from the legacy `cretli-push-enabled` localStorage flag.
 *
 * - stored v1 preferences (if valid) win — migration is a no-op;
 * - otherwise `legacyValue === '1'` => defaults with `enabled: true`, all events on;
 * - otherwise => defaults with `enabled: false` (never opted in).
 *
 * Never throws for null/undefined/garbage.
 *
 * @param {unknown} legacyValue
 * @param {unknown} storedPreferences
 * @returns {ReturnType<typeof normalizePushPreferences>}
 */
export function migrateLegacyPushPreferences(legacyValue, storedPreferences) {
  if (
    isPlainObject(storedPreferences)
    && storedPreferences.schemaVersion === PUSH_PREFERENCES_SCHEMA_VERSION
  ) {
    const checked = validatePushPreferences(storedPreferences);
    if (checked.ok) return checked.value;
  }
  const base = normalizePushPreferences(DEFAULT_PUSH_PREFERENCES);
  if (legacyValue === '1') {
    return { ...base, enabled: true, events: { ...base.events } };
  }
  return { ...base, enabled: false, events: { ...base.events } };
}

/**
 * Strip per-endpoint preferences from a stored record, returning only the
 * web-push subscription fields (`endpoint`, `keys`, `expirationTime`, ...).
 * Preferences must NEVER reach `webPush.sendNotification`.
 *
 * @param {unknown} record
 * @returns {Record<string, unknown>}
 */
export function stripPushPreferences(record) {
  if (!isPlainObject(record)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(record)) {
    if (key === 'preferences') continue;
    out[key] = record[key];
  }
  return out;
}

/** Alias kept for readability at call sites that want a subscription object. */
export const toWebPushSubscription = stripPushPreferences;
