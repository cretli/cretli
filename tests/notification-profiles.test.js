import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  buildPushNotificationOptions,
  mergePushPreferences,
  normalizePushPreferences,
  resolveNotificationProfile,
  resolveNotificationScope,
  validatePushPreferences,
} from '../lib/push-preferences.js';
import { trimWebPushNotificationPayload } from '../lib/push-inbox-logic.js';
import { formatQuietTime } from '../lib/push-quiet-hours.js';
import { createInAppSignalController, createInAppSignalPlayer } from '../app_front/features/pwa/inAppSignals.js';
import { createPushPreferencesStore } from '../app_front/features/pwa/pushPreferencesStore.js';

const legacy = { inAppSound: true, inAppVibrate: true, pushVibrate: 'short' };
assert.deepEqual(resolveNotificationProfile(legacy, {}), resolveNotificationProfile(legacy, { notificationScope: 'subchat' }));
assert.equal(resolveNotificationScope({ delegationParentChatId: 'parent' }), 'subchat');
assert.equal(resolveNotificationScope({ forkParentChatId: 'parent' }), 'subchat');
assert.equal(resolveNotificationScope({}), 'chat');

const preferences = mergePushPreferences(legacy, {
  profiles: {
    chat: { soundPreset: 'low', vibratePreset: 'short', volume: 0.25 },
    subchat: { soundPreset: 'double', vibratePreset: 'long', pushVibrate: 'long', volume: 0.75 },
  },
});
assert.equal(validatePushPreferences(preferences).ok, true);
assert.deepEqual(normalizePushPreferences(JSON.parse(JSON.stringify(preferences))), preferences);
const changed = mergePushPreferences(preferences, { profiles: { subchat: { inAppSound: false } } });
assert.deepEqual(changed.profiles.chat, preferences.profiles.chat);
assert.equal(changed.profiles.subchat.inAppSound, false);
assert.equal(changed.profiles.subchat.soundPreset, 'double');
for (const profile of [
  { soundPreset: 'unknown' }, { vibratePreset: 'unknown' }, { pushVibrate: 'unknown' },
  { inAppSound: 'yes' }, { inAppVibrate: 1 }, { volume: -1 }, { volume: Infinity }, { volume: '0.5' },
]) {
  assert.equal(validatePushPreferences({ profiles: { subchat: profile } }).ok, false);
  assert.deepEqual(mergePushPreferences(preferences, { profiles: { subchat: profile } }), preferences);
}
assert.equal(validatePushPreferences({ profiles: [] }).ok, false);
assert.equal(validatePushPreferences({ profiles: { unknown: {} } }).ok, false);

// Both profiles survive concurrent edits, subscription creation and app restart.
const records = new Map();
const persistence = {
  get: async (key) => structuredClone(records.get(key)),
  set: async (key, value) => { records.set(key, structuredClone(value)); },
};
const store = createPushPreferencesStore(persistence);
await Promise.all([
  store.save('', { profiles: { chat: { soundPreset: 'bell', volume: 0.2 } } }),
  store.save('', { profiles: { subchat: { soundPreset: 'double', volume: 0.8 } } }),
]);
const restarted = createPushPreferencesStore(persistence);
const draft = await restarted.load('https://push.example/device');
assert.equal(draft.profiles.chat.soundPreset, 'bell');
assert.equal(draft.profiles.subchat.soundPreset, 'double');
assert.equal(draft.profiles.chat.volume, 0.2);
assert.equal(draft.profiles.subchat.volume, 0.8);

// Live events and SW delegation select the same profile; dedupe and quiet hours remain active.
const vibrations = [];
const sounds = [];
const controller = createInAppSignalController({
  preferences,
  storage: null,
  broadcastChannel: null,
  player: {
    isVibrationSupported: () => true,
    isSoundSupported: () => true,
    vibrate: (pattern) => { vibrations.push(pattern); },
    playSound: (options) => { sounds.push(options); },
  },
});
assert.equal(controller.handleEvent({ eventType: 'finished', eventId: 'chat-run', chatId: 'chat' }).emit, true);
const childMessage = {
  type: 'cretli-in-app-signal', eventType: 'question', eventId: 'child-question', chatId: 'child', notificationScope: 'subchat',
};
assert.equal(controller.handleServiceWorkerMessage(childMessage).emit, true);
assert.deepEqual(vibrations, [[80], [200, 100, 200]]);
assert.equal(sounds[0].soundPreset, 'low');
assert.equal(sounds[1].soundPreset, 'double');
assert.equal(sounds[0].gain, 0.25 * 0.18);
assert.equal(sounds[1].gain, 0.75 * 0.18);
assert.equal(controller.handleServiceWorkerMessage(childMessage).emit, false);
const clock = new Date();
const clockMinutes = clock.getHours() * 60 + clock.getMinutes();
controller.setQuietHours({ enabled: true, start: formatQuietTime(clockMinutes - 1), end: formatQuietTime(clockMinutes + 60) });
assert.equal(controller.handleEvent({ eventType: 'finished', eventId: 'quiet', notificationScope: 'subchat' }).emit, false);
controller.setQuietHours({ enabled: false });
controller.setPreferences(mergePushPreferences(preferences, { profiles: { subchat: { inAppSound: false, vibratePreset: 'off' } } }));
assert.equal(controller.handleEvent({ eventType: 'finished', eventId: 'off', notificationScope: 'subchat' }).emit, false);
assert.equal(sounds.length, 2);
controller.dispose();

// Verify the actual synthesized melody (including pulse scheduling) and preview parity.
const oscillators = [];
class FakeAudioContext {
  state = 'running';
  currentTime = 5;
  destination = {};
  createOscillator() {
    const oscillator = {
      frequency: { value: 0 }, connect() {},
      start(time) { this.startAt = time; }, stop(time) { this.stopAt = time; },
    };
    oscillators.push(oscillator);
    return oscillator;
  }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
}
const player = createInAppSignalPlayer({ AudioContext: FakeAudioContext });
assert.equal((await player.playSound({ soundPreset: 'double' })).ok, true);
assert.deepEqual(oscillators.map((oscillator) => oscillator.frequency.value), [660, 660]);
assert.equal(oscillators[0].startAt, 5);
assert.equal(oscillators[1].startAt, 5.2);
globalThis.window = { AudioContext: FakeAudioContext };
const { playTestTone, getPushSubscription } = await import('../app_front/features/pwa/pushSubscription.js');
assert.equal((await playTestTone(0.5, 'bell')).ok, true);
assert.equal(oscillators.at(-1).frequency.value, 1175);
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
globalThis.window.PushManager = function PushManager() {};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { serviceWorker: { getRegistration: async () => undefined, ready: new Promise(() => {}) } },
});
assert.equal(await getPushSubscription(), null, 'in-app settings must not wait for an inactive worker');
if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
else delete globalThis.navigator;
delete globalThis.window;

// Push patterns and compacted SW messages retain the owning chat scope.
assert.deepEqual(buildPushNotificationOptions({ data: { notificationScope: 'subchat' } }, preferences), { vibrate: [200, 100, 200] });
assert.deepEqual(buildPushNotificationOptions({}, preferences), { vibrate: [80] });
assert.deepEqual(buildPushNotificationOptions({ silent: true }, preferences), { silent: true });
const trimmed = trimWebPushNotificationPayload({
  title: 'done', data: { notificationScope: 'subchat', chatId: 'child', url: 'x'.repeat(10000), eventId: 'child-run', extra: 'x'.repeat(10000) },
});
assert.equal(trimmed.data.notificationScope, 'subchat');
const swContext = { self: {}, URL };
vm.runInNewContext(readFileSync(new URL('../public/sw-in-app-signal.js', import.meta.url), 'utf8'), swContext);
assert.equal(swContext.self.cretliInAppSignal.buildClientMessage(trimmed).notificationScope, 'subchat');

// The server identifies persisted child chats before resolving each endpoint's pattern.
const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-notification-profiles-'));
process.env.CRETLI_DATA_DIR = dataDir;
const webPush = (await import('web-push')).default;
const originalSend = webPush.sendNotification;
const pushes = [];
webPush.sendNotification = async (_subscription, payload) => { pushes.push(JSON.parse(payload)); };
try {
  const { saveChats } = await import('../lib/persist/chats-persist.js');
  saveChats([{ id: 'child', delegationParentChatId: 'parent' }, { id: 'fork', forkParentChatId: 'parent' }, { id: 'parent' }]);
  const { addSubscription, broadcastPush } = await import('../lib/push.js');
  addSubscription({ endpoint: 'https://push.example/device', keys: { p256dh: 'key', auth: 'auth' } }, preferences);
  for (const chatId of ['child', 'fork', 'parent']) {
    const result = await broadcastPush({ data: { type: 'agent-finished', chatId, eventId: `${chatId}-run` } });
    assert.equal(result.sent, 1);
  }
  assert.deepEqual(pushes.map((push) => push.vibrate), [[200, 100, 200], [200, 100, 200], [80]]);
  assert.deepEqual(pushes.map((push) => push.data.notificationScope), ['subchat', 'subchat', 'chat']);
} finally {
  webPush.sendNotification = originalSend;
  rmSync(dataDir, { recursive: true, force: true });
}
console.log('notification-profiles tests passed');
