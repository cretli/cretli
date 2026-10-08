/**
 * app_front/features/pwa/chatMuteStore.js — the device mute must be a fresh
 * read-modify-write so two cards/tabs cannot erase each other's mutes, and the
 * persisted record must not carry volatile throttle alerts.
 */
import assert from 'node:assert/strict';
import {
  createChatMuteStore,
  resetChatMuteStoreForTests,
} from '../app_front/features/pwa/chatMuteStore.js';

resetChatMuteStoreForTests();

/**
 * @param {unknown} initial
 */
function fakePersistence(initial) {
  const state = { value: initial };
  return {
    state,
    get: async () => state.value,
    set: async (_key, value) => {
      state.value = value;
    },
  };
}

const persistence = fakePersistence({ schemaVersion: 1, muted: ['other-tab-chat'] });
const store = createChatMuteStore({ persistence });
await store.load();
assert.equal(store.isMuted('other-tab-chat'), true, 'loads the stored mute');

await store.setMuted('my-chat', true);
assert.equal(store.isMuted('my-chat'), true);
assert.equal(store.isMuted('other-tab-chat'), true, 'a concurrent mute survives setMuted');
assert.deepEqual(
  [...persistence.state.value.muted].sort(),
  ['my-chat', 'other-tab-chat'],
  'both mutes are persisted'
);
assert.deepEqual(
  persistence.state.value.alerts,
  {},
  'volatile throttle alerts must not be persisted with the mute list'
);

await store.setMuted('my-chat', false);
assert.equal(store.isMuted('my-chat'), false);
assert.equal(store.isMuted('other-tab-chat'), true);

// A mute added by another tab AFTER this card loaded must still survive.
persistence.state.value = { schemaVersion: 1, muted: ['other-tab-chat', 'third-chat'] };
await store.setMuted('fourth-chat', true);
assert.deepEqual(
  [...persistence.state.value.muted].sort(),
  ['fourth-chat', 'other-tab-chat', 'third-chat'],
  'fresh read-modify-write keeps another tab additions'
);

let notified = 0;
const unsubscribe = store.subscribe(() => {
  notified += 1;
});
await store.setMuted('fifth-chat', true);
assert.equal(notified, 1, 'subscribers are notified after a change');
unsubscribe();
await store.setMuted('fifth-chat', false);
assert.equal(notified, 1, 'unsubscribe stops notifications');

resetChatMuteStoreForTests();
console.log('chat-mute-store.test.js: ok');
