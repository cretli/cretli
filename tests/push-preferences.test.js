/**
 * Unit tests for the per-endpoint Web Push preferences contract
 * (lib/push-preferences.js). Pure module — no IO.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PUSH_PREFERENCES,
  LEGACY_PUSH_ENABLED_STORAGE_KEY,
  PUSH_EVENT_TYPES,
  PUSH_PREFERENCES_DB_NAME,
  PUSH_PREFERENCES_SCHEMA_VERSION,
  PUSH_PREFERENCES_STORE_NAME,
  PUSH_VIBRATE_PRESETS,
  PUSH_VIBRATE_PRESET_IDS,
  buildPushNotificationOptions,
  buildPushPreferencesStorageKey,
  mergePushPreferences,
  migrateLegacyPushPreferences,
  normalizePushPreferences,
  resolvePushVibratePattern,
  stripPushPreferences,
  toWebPushSubscription,
  validatePushPreferences,
} from '../lib/push-preferences.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'lib', 'push-preferences.js'), 'utf8');

// --- defaults -----------------------------------------------------------------
assert.equal(PUSH_PREFERENCES_SCHEMA_VERSION, 1);
assert.deepEqual(PUSH_EVENT_TYPES, ['finished', 'question', 'permission', 'newChat']);
assert.deepEqual(PUSH_VIBRATE_PRESET_IDS, ['off', 'short', 'default', 'long']);
assert.deepEqual(PUSH_VIBRATE_PRESETS.default, [80, 40, 80]);
assert.deepEqual(DEFAULT_PUSH_PREFERENCES, {
  schemaVersion: 1,
  enabled: true,
  events: { finished: true, question: true, permission: true, newChat: true },
  pushVibrate: 'default',
  inAppVibrate: false,
  inAppSound: false,
});
assert.equal(DEFAULT_PUSH_PREFERENCES.inAppVibrate, false);
assert.equal(DEFAULT_PUSH_PREFERENCES.inAppSound, false);
assert.deepEqual(normalizePushPreferences(undefined), DEFAULT_PUSH_PREFERENCES);

// Resolve enum -> frozen pattern; unknown falls back to default.
assert.deepEqual(resolvePushVibratePattern('default'), [80, 40, 80]);
assert.equal(Object.isFrozen(resolvePushVibratePattern('default')), true);
assert.deepEqual(resolvePushVibratePattern('off'), []);
assert.deepEqual(resolvePushVibratePattern('nope'), [80, 40, 80]);

// --- normalize: lenient, never throws, fresh objects --------------------------
for (const garbage of [null, undefined, 0, 'x', [], true, NaN, () => {}]) {
  assert.deepEqual(normalizePushPreferences(garbage), DEFAULT_PUSH_PREFERENCES, `garbage ${String(garbage)}`);
}
assert.deepEqual(
  normalizePushPreferences({
    schemaVersion: 99,
    enabled: 'yes',
    events: { finished: false, bogus: true },
    pushVibrate: 'bogus',
    inAppVibrate: 'yep',
    inAppSound: 1,
    unknownKey: 'ignored',
  }),
  {
    schemaVersion: 1,
    enabled: true,
    events: { finished: false, question: true, permission: true, newChat: true },
    pushVibrate: 'default',
    inAppVibrate: false,
    inAppSound: false,
  }
);
// Unknown top-level keys are dropped.
assert.equal('unknownKey' in normalizePushPreferences({ unknownKey: 1 }), false);

// Fresh nested objects per call: two endpoints must never share state.
{
  const a = normalizePushPreferences({});
  const b = normalizePushPreferences({});
  assert.notEqual(a.events, b.events);
  a.events.finished = false;
  a.pushVibrate = 'off';
  assert.equal(b.events.finished, true);
  assert.equal(b.pushVibrate, 'default');
  assert.deepEqual(normalizePushPreferences({}).events, { finished: true, question: true, permission: true, newChat: true });
}

// --- strict validator ---------------------------------------------------------
assert.equal(validatePushPreferences({ pushVibrate: 'bogus' }).ok, false);
assert.equal(validatePushPreferences({ pushVibrate: 123 }).ok, false);
assert.equal(validatePushPreferences({ enabled: 'yes' }).ok, false);
assert.equal(validatePushPreferences({ events: { bogus: true } }).ok, false);
assert.equal(validatePushPreferences({ events: { finished: 'yes' } }).ok, false);
assert.equal(validatePushPreferences({ events: 'nope' }).ok, false);
assert.equal(validatePushPreferences({ inAppVibrate: 'yes' }).ok, false);
assert.equal(validatePushPreferences({ inAppSound: 1 }).ok, false);
assert.equal(validatePushPreferences(null).ok, false);
assert.equal(validatePushPreferences('x').ok, false);
assert.equal(validatePushPreferences([]).ok, false);
assert.equal(validatePushPreferences({ schemaVersion: 2 }).ok, false);
for (const bad of [
  validatePushPreferences({ pushVibrate: 'bogus' }),
  validatePushPreferences({ enabled: 'yes' }),
  validatePushPreferences({ events: { bogus: true } }),
]) {
  assert.equal(typeof bad.error, 'string');
  assert.ok(bad.error.length > 0);
}
// Valid partial payload is normalized into a full object.
{
  const res = validatePushPreferences({ pushVibrate: 'off', events: { permission: false } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, {
    schemaVersion: 1,
    enabled: true,
    events: { finished: true, question: true, permission: false, newChat: true },
    pushVibrate: 'off',
    inAppVibrate: false,
    inAppSound: false,
  });
}
assert.deepEqual(validatePushPreferences({}).value, DEFAULT_PUSH_PREFERENCES);

// --- merge preserves omitted fields (re-POST does not zero preferences) -------
{
  const existing = {
    schemaVersion: 1,
    enabled: true,
    events: { finished: false, question: true, permission: true, newChat: true },
    pushVibrate: 'long',
    inAppVibrate: true,
    inAppSound: false,
  };
  const merged = mergePushPreferences(existing, { events: { question: false } });
  assert.deepEqual(merged, {
    schemaVersion: 1,
    enabled: true,
    events: { finished: false, question: false, permission: true, newChat: true },
    pushVibrate: 'long',
    inAppVibrate: true,
    inAppSound: false,
  });
  // Empty patch keeps everything.
  assert.deepEqual(mergePushPreferences(existing, {}), existing);
  assert.deepEqual(mergePushPreferences(existing, undefined), existing);
  // Invalid patch value keeps the existing value instead of resetting it.
  assert.equal(mergePushPreferences(existing, { pushVibrate: 'bogus' }).pushVibrate, 'long');
  assert.equal(mergePushPreferences(existing, { enabled: 'yes' }).enabled, true);
  // Unknown keys ignored.
  assert.deepEqual(mergePushPreferences(existing, { nope: 1 }), existing);
}

// --- buildPushNotificationOptions ---------------------------------------------
{
  // No new payload fields: keep the preferences pattern.
  assert.deepEqual(buildPushNotificationOptions({}, { pushVibrate: 'default' }), { vibrate: [80, 40, 80] });
  assert.deepEqual(buildPushNotificationOptions({ title: 'x' }, {}), { vibrate: [80, 40, 80] });
  // silent: true => no vibrate.
  const silent = buildPushNotificationOptions({ silent: true }, { pushVibrate: 'long' });
  assert.deepEqual(silent, { silent: true });
  assert.equal('vibrate' in silent, false);
  // pushVibrate off => omit vibrate entirely.
  assert.deepEqual(buildPushNotificationOptions({}, { pushVibrate: 'off' }), {});
  assert.equal('vibrate' in buildPushNotificationOptions({}, { pushVibrate: 'off' }), false);
  // Empty payload vibrate pattern => omit vibrate.
  assert.deepEqual(buildPushNotificationOptions({ vibrate: [] }, { pushVibrate: 'long' }), {});
  // Payload preset overrides the preference.
  assert.deepEqual(buildPushNotificationOptions({ vibrate: 'short' }, { pushVibrate: 'long' }), { vibrate: [80] });
  assert.deepEqual(
    buildPushNotificationOptions({ vibratePreset: 'long' }, { pushVibrate: 'off' }),
    { vibrate: [200, 100, 200] }
  );
  assert.deepEqual(buildPushNotificationOptions({ vibrate: [10, 20] }, {}), { vibrate: [10, 20] });
  // payload.options (TTL/urgency) are HTTP options and must not leak here.
  assert.deepEqual(buildPushNotificationOptions({ options: { TTL: 5, urgency: 'high' } }, {}), {
    vibrate: [80, 40, 80],
  });
  // Legacy silent: false is not a new option field — keep the pattern.
  assert.deepEqual(buildPushNotificationOptions({ silent: false }, {}), { vibrate: [80, 40, 80] });
}

// --- storage location is NOT the push inbox ------------------------------------
assert.notEqual(PUSH_PREFERENCES_DB_NAME, 'cretli-push-inbox');
assert.notEqual(PUSH_PREFERENCES_STORE_NAME, 'events');
assert.equal(PUSH_PREFERENCES_DB_NAME, 'cretli-preferences');
assert.equal(PUSH_PREFERENCES_STORE_NAME, 'kv');
assert.equal(buildPushPreferencesStorageKey(''), '');
assert.equal(buildPushPreferencesStorageKey(null), '');
{
  const keyA = buildPushPreferencesStorageKey('https://push.example/a');
  const keyB = buildPushPreferencesStorageKey('https://push.example/b');
  assert.notEqual(keyA, keyB);
  assert.match(keyA, /push\.example\/a/);
}

// --- legacy migration ----------------------------------------------------------
assert.equal(LEGACY_PUSH_ENABLED_STORAGE_KEY, 'cretli-push-enabled');
{
  const on = migrateLegacyPushPreferences('1', null);
  assert.equal(on.enabled, true);
  assert.deepEqual(on.events, { finished: true, question: true, permission: true, newChat: true });
  const offAbsent = migrateLegacyPushPreferences(undefined, null);
  assert.equal(offAbsent.enabled, false);
  assert.equal(migrateLegacyPushPreferences('0', null).enabled, false);
  assert.equal(migrateLegacyPushPreferences(null, null).enabled, false);
  assert.equal(migrateLegacyPushPreferences({}, []).enabled, false);
  assert.equal(migrateLegacyPushPreferences('1', 'garbage').enabled, true);
  // Stored v1 preferences win — migration is a no-op.
  const stored = {
    schemaVersion: 1,
    enabled: false,
    events: { finished: false, question: true, permission: true, newChat: true },
    pushVibrate: 'short',
    inAppVibrate: true,
    inAppSound: true,
  };
  assert.deepEqual(migrateLegacyPushPreferences('1', stored), stored);
  assert.equal(migrateLegacyPushPreferences('1', stored).enabled, false);
  // Invalid v1-shaped object does not win.
  assert.equal(migrateLegacyPushPreferences('0', { schemaVersion: 1, pushVibrate: 'bogus' }).enabled, false);
}

// --- stripPushPreferences ------------------------------------------------------
{
  const stored = {
    endpoint: 'https://push.example/a',
    keys: { p256dh: 'p', auth: 'a' },
    expirationTime: null,
    preferences: { enabled: true, pushVibrate: 'long' },
  };
  const stripped = stripPushPreferences(stored);
  assert.deepEqual(stripped, {
    endpoint: 'https://push.example/a',
    keys: { p256dh: 'p', auth: 'a' },
    expirationTime: null,
  });
  assert.equal('preferences' in stripped, false);
  assert.deepEqual(stripPushPreferences(null), {});
  assert.equal(toWebPushSubscription, stripPushPreferences);
}

// --- browser/Service-Worker safety (source guard) ------------------------------
assert.doesNotMatch(source, /from ['"]node:/);
assert.doesNotMatch(source, /require\s*\(/);
assert.doesNotMatch(source, /Buffer\s*[.(]/);
assert.doesNotMatch(source, /localStorage\s*[.[]/);
assert.doesNotMatch(source, /\b(readFileSync|writeFileSync|existsSync|createReadStream)\b/);

console.log('push-preferences.test.js: ok');
