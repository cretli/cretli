/**
 * Local push preferences store (app_front/features/pwa/pushPreferencesStore.js).
 *
 * Exercises merge/round-trip ("state after restart"), endpoint isolation, the
 * device-level volume and — most importantly — that a failed write propagates
 * instead of looking like a success.
 */
import assert from 'node:assert/strict';
import {
  PUSH_IN_APP_VOLUME_DEFAULT,
  PUSH_IN_APP_VOLUME_KEY,
  PUSH_MUTED_CHATS_KEY,
  PUSH_QUIET_HOURS_KEY,
  clampPushInAppVolume,
  createPushPreferencesStore,
  resolvePushPreferencesKey,
} from '../app_front/features/pwa/pushPreferencesStore.js';

/**
 * @param {Record<string, unknown>} [initial]
 */
function createMemoryPersistence(initial = {}) {
  const map = new Map(Object.entries(initial));
  let failWrites = false;
  return {
    map,
    failNextWrite() {
      failWrites = true;
    },
    async get(key) {
      return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
    },
    async set(key, value) {
      if (failWrites) {
        failWrites = false;
        throw new Error('quota exceeded');
      }
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function newStore(persistence, legacy = '') {
  return createPushPreferencesStore(persistence, { readLegacyEnabled: () => legacy });
}

// --- volume clamping --------------------------------------------------------
assert.equal(clampPushInAppVolume(undefined), PUSH_IN_APP_VOLUME_DEFAULT);
assert.equal(clampPushInAppVolume(null), PUSH_IN_APP_VOLUME_DEFAULT);
assert.equal(clampPushInAppVolume('abc'), PUSH_IN_APP_VOLUME_DEFAULT);
assert.equal(clampPushInAppVolume(''), PUSH_IN_APP_VOLUME_DEFAULT);
assert.equal(clampPushInAppVolume(-1), 0);
assert.equal(clampPushInAppVolume(5), 1);
assert.equal(clampPushInAppVolume(0), 0);
assert.equal(clampPushInAppVolume(0.35), 0.35);

// --- key resolution falls back to a device draft ----------------------------
assert.equal(resolvePushPreferencesKey(''), 'push-preferences:device');
assert.equal(resolvePushPreferencesKey('  '), 'push-preferences:device');
assert.equal(
  resolvePushPreferencesKey('https://push.example/a'),
  'push-preferences:https://push.example/a'
);

// --- save + restart round-trip (new store over the same persistence) --------
{
  const persistence = createMemoryPersistence();
  const first = newStore(persistence);
  const saved = await first.save('https://push.example/a', {
    events: { finished: false, permission: false },
    pushVibrate: 'long',
    inAppVibrate: true,
    inAppSound: true,
  });
  // A fresh device with no legacy `cretli-push-enabled` flag never opted in, so
  // `enabled` starts false; the subscription state (not this flag) drives the UI.
  assert.deepEqual(saved, {
    schemaVersion: 1,
    enabled: false,
    events: { finished: false, question: true, permission: false, newChat: true },
    pushVibrate: 'long',
    inAppVibrate: true,
    inAppSound: true,
  });

  // A brand new store instance simulates an app restart.
  const second = newStore(persistence);
  const reloaded = await second.load('https://push.example/a');
  assert.deepEqual(reloaded, saved, 'the saved preferences survive a restart');
}

// --- two endpoints are isolated ---------------------------------------------
{
  const persistence = createMemoryPersistence();
  const store = newStore(persistence);
  await store.save('https://push.example/a', { pushVibrate: 'short' });
  await store.save('https://push.example/b', { pushVibrate: 'long' });
  assert.equal((await store.load('https://push.example/a')).pushVibrate, 'short');
  assert.equal((await store.load('https://push.example/b')).pushVibrate, 'long');
}

// --- pre-subscription drafts seed the real endpoint -------------------------
{
  const persistence = createMemoryPersistence();
  const store = newStore(persistence);
  await store.save('', { events: { question: false }, inAppSound: true });
  const seeded = await store.load('https://push.example/a');
  assert.equal(seeded.events.question, false);
  assert.equal(seeded.inAppSound, true);
}

// --- legacy flag migration --------------------------------------------------
{
  const persistence = createMemoryPersistence();
  const on = newStore(persistence, '1');
  assert.equal((await on.load('')).enabled, true);
  assert.deepEqual((await on.load('')).events, { finished: true, question: true, permission: true, newChat: true });

  const off = newStore(createMemoryPersistence(), '');
  assert.equal((await off.load('')).enabled, false);
  assert.equal((await off.load('')).pushVibrate, 'default');
  assert.equal((await off.load('')).inAppVibrate, false);
  assert.equal((await off.load('')).inAppSound, false);
}

// --- save error path: a failed write must reject and keep the old value ------
{
  const persistence = createMemoryPersistence();
  const store = newStore(persistence);
  await store.save('https://push.example/a', { pushVibrate: 'short' });
  persistence.failNextWrite();
  await assert.rejects(
    () => store.save('https://push.example/a', { pushVibrate: 'long' }),
    /quota exceeded/,
    'a failed save must reject'
  );
  assert.equal(
    (await store.load('https://push.example/a')).pushVibrate,
    'short',
    'the previous value is intact after a failed save'
  );
  // Invalid endpoint is still keyed by the device draft, never silently lost.
  const draft = await store.save('', { pushVibrate: 'off' });
  assert.equal(draft.pushVibrate, 'off');
}

// --- volume persistence -----------------------------------------------------
{
  const persistence = createMemoryPersistence();
  const store = newStore(persistence);
  assert.equal(await store.loadVolume(), PUSH_IN_APP_VOLUME_DEFAULT);
  assert.equal(await store.saveVolume(0.25), 0.25);
  assert.equal(await store.saveVolume(2), 1);
  assert.equal(await store.loadVolume(), 1);
  assert.equal(persistence.map.get(PUSH_IN_APP_VOLUME_KEY), 1);

  const restarted = newStore(persistence);
  assert.equal(await restarted.loadVolume(), 1);

  persistence.failNextWrite();
  await assert.rejects(() => store.saveVolume(0.5), /quota exceeded/);
  assert.equal(await store.loadVolume(), 1, 'a failed volume save keeps the old value');
}

// --- quiet hours + chat mute device keys ------------------------------------
{
  const persistence = createMemoryPersistence();
  const store = newStore(persistence);
  const quiet = await store.saveQuietHours({ enabled: true, start: '21:00', end: '06:30' });
  assert.equal(quiet.enabled, true);
  assert.equal(quiet.start, '21:00');
  assert.deepEqual(await store.loadQuietHours(), quiet);
  assert.ok(persistence.map.has(PUSH_QUIET_HOURS_KEY));

  const mute = await store.saveChatMuteRecord({ muted: ['c1'] });
  assert.deepEqual(mute.muted, ['c1']);
  assert.deepEqual((await store.loadChatMuteRecord()).muted, ['c1']);
  assert.ok(persistence.map.has(PUSH_MUTED_CHATS_KEY));

  persistence.failNextWrite();
  await assert.rejects(() => store.saveQuietHours({ enabled: false }), /quota exceeded/);
}

// --- bad persistence input --------------------------------------------------
assert.throws(() => createPushPreferencesStore(null), TypeError);
assert.throws(() => createPushPreferencesStore({ get: () => {} }), TypeError);

console.log('push-preferences-store.test.js: ok');
