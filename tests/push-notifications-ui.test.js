/**
 * Notifications settings section: device state derivation, static markup wiring
 * and i18n coverage. No DOM is created here — the markup is inspected as text,
 * the state helper is pure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  PUSH_STATES,
  derivePushState,
  vibrateWithPattern,
} from '../app_front/features/pwa/pushSubscription.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// --- state is derived from permission + subscription, not a legacy flag -----
assert.deepEqual(Object.values(PUSH_STATES).sort(), [
  'active',
  'blocked',
  'inactive',
  'permission-required',
  'unsupported',
]);
assert.equal(derivePushState(undefined), PUSH_STATES.UNSUPPORTED);
assert.equal(derivePushState({ supported: false, permission: 'granted' }), PUSH_STATES.UNSUPPORTED);
assert.equal(
  derivePushState({ supported: true, permission: 'denied', hasSubscription: true }),
  PUSH_STATES.BLOCKED
);
assert.equal(
  derivePushState({ supported: true, permission: 'default', hasSubscription: false }),
  PUSH_STATES.PERMISSION_REQUIRED
);
assert.equal(
  derivePushState({ supported: true, permission: 'granted', hasSubscription: false }),
  PUSH_STATES.INACTIVE
);
assert.equal(
  derivePushState({ supported: true, permission: 'granted', hasSubscription: true }),
  PUSH_STATES.ACTIVE
);

// --- vibrate test helper fails softly ---------------------------------------
assert.deepEqual(vibrateWithPattern('off'), { ok: true, reason: 'off', skipped: true });
// Node has no navigator.vibrate, so a real preset reports unsupported instead of throwing.
assert.equal(vibrateWithPattern('default').ok, false);

// --- static markup ----------------------------------------------------------
const sectionMatch = indexHtml.match(
  /<section class="settings-section settings-notifications" data-settings-tab="interface-notifications"[^>]*>/
);
assert.ok(sectionMatch, 'the notifications section must use its own App subtab');

for (const id of [
  'pwa-push-checkbox',
  'pwa-push-state',
  'pwa-push-status',
  'pwa-push-event-finished',
  'pwa-push-event-question',
  'pwa-push-event-permission',
  'pwa-push-event-new-chat',
  'pwa-push-vibrate-select',
  'pwa-inapp-vibrate-checkbox',
  'pwa-inapp-sound-checkbox',
  'pwa-inapp-volume-range',
  'pwa-inapp-volume-value',
  'pwa-push-vibrate-test-btn',
  'pwa-push-sound-preview-btn',
  'pwa-push-test-btn',
  'pwa-push-test-status',
  'pwa-inapp-vibrate-select',
  'pwa-inapp-sound-select',
  'pwa-subchat-options',
  'pwa-subchat-push-vibrate-select',
  'pwa-subchat-vibrate-checkbox',
  'pwa-subchat-sound-checkbox',
  'pwa-subchat-vibrate-select',
  'pwa-subchat-sound-select',
  'pwa-subchat-volume-range',
  'pwa-subchat-volume-value',
  'pwa-subchat-vibrate-test-btn',
  'pwa-subchat-sound-preview-btn',
]) {
  assert.equal(indexHtml.includes(`id="${id}"`), true, `missing element #${id}`);
}
assert.match(indexHtml, /id="pwa-inapp-volume-range"[^>]*min="0"[^>]*max="100"/);
assert.match(
  indexHtml,
  /data-i18n="settings\.notificationsTestPush"[^>]*>Send test push</,
  'the test-push button must be present in the notifications section'
);

// Notifications have their own subtab inside App settings.
const appearanceIndex = indexHtml.indexOf('data-i18n="settings.appearance"');
const notificationsIndex = indexHtml.indexOf('data-i18n="settings.notifications"');
assert.ok(appearanceIndex >= 0 && notificationsIndex > appearanceIndex, 'notifications follow appearance');
assert.equal(
  /data-settings-tab="notifications"/.test(indexHtml),
  false,
  'notifications must not create a new top-level settings tab'
);
assert.match(indexHtml, /data-settings-tab="interface-notifications"[^>]*role="tab"[^>]*data-i18n="settings\.tabsInterfaceNotifications"/);

// --- hints never point at a server file -------------------------------------
for (const [lang, dict] of [['en', en], ['pl', pl]]) {
  assert.equal(
    /data\/push-subscriptions\.json/.test(dict.settings.notificationsHint),
    false,
    `${lang} notificationsHint must not reference data/push-subscriptions.json`
  );
}
assert.equal(en.settings.enablePush, 'Enable notifications on this device');
assert.equal(pl.settings.enablePush, 'Włącz powiadomienia na tym urządzeniu');
assert.equal(en.settings.tabsInterfaceNotifications, 'Notifications');
assert.equal(pl.settings.tabsInterfaceNotifications, 'Powiadomienia');

for (const key of [
  'notificationsEventsTitle',
  'notificationsEventFinished',
  'notificationsEventQuestion',
  'notificationsEventPermission',
  'notificationsEventNewChat',
  'notificationsVibrate',
  'notificationsVibrateOff',
  'notificationsVibrateShort',
  'notificationsVibrateDefault',
  'notificationsVibrateLong',
  'notificationsInAppTitle',
  'notificationsChats',
  'notificationsSubchats',
  'notificationsVibrationPattern',
  'notificationsSound',
  'notificationsSoundHint',
  'notificationsSoundDefault',
  'notificationsSoundLow',
  'notificationsSoundBell',
  'notificationsSoundDouble',
  'notificationsInAppVibrate',
  'notificationsInAppSound',
  'notificationsInAppVolume',
  'notificationsTestTitle',
  'notificationsTestVibrate',
  'notificationsTestSound',
  'notificationsTestPush',
  'notificationsTestHint',
  'notificationsConsentHint',
  'notificationsIosHint',
  'notificationsSystemHint',
]) {
  assert.equal(typeof en.settings[key], 'string', `en settings.${key}`);
  assert.equal(typeof pl.settings[key], 'string', `pl settings.${key}`);
}
for (const key of [
  'pushPermissionRequired',
  'pushOffFailed',
  'pushSaveFailed',
  'pushPrefsSaved',
  'pushStateUnsupported',
  'pushStateBlocked',
  'pushStatePermissionRequired',
  'pushStateInactive',
  'pushStateActive',
  'pushVibrateTested',
  'pushVibrateOff',
  'pushVibrateUnsupported',
  'pushSoundTested',
  'pushSoundUnsupported',
  'pushSoundBlocked',
  'pushTestSending',
  'pushTestSent',
  'pushTestFailed',
  'pushTestNoSubscription',
]) {
  assert.equal(typeof en.pwa[key], 'string', `en pwa.${key}`);
  assert.equal(typeof pl.pwa[key], 'string', `pl pwa.${key}`);
}

console.log('push-notifications-ui.test.js: ok');
