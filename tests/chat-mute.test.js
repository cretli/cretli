/**
 * lib/chat-mute.js — per-chat mute and alert throttle.
 */
import assert from 'node:assert/strict';
import {
  CHAT_ALERT_COOLDOWN_MS,
  isChatMuted,
  normalizeChatMuteRecord,
  resolveChatAlertThrottle,
  setChatMuted,
} from '../lib/chat-mute.js';

assert.deepEqual(normalizeChatMuteRecord([' chat-a ', 'chat-b', '', 'chat-a']), {
  schemaVersion: 1,
  muted: ['chat-a', 'chat-b'],
  alerts: {},
});

const base = normalizeChatMuteRecord({ muted: ['a'], alerts: {} });
const mutedA = setChatMuted(base, 'a', true);
const mutedB = setChatMuted(mutedA, 'b', true);
assert.equal(isChatMuted(mutedB, 'a'), true);
assert.equal(isChatMuted(mutedB, 'b'), true);
assert.equal(isChatMuted(mutedB, 'c'), false);
assert.equal(base.muted.length, 1, 'setChatMuted must not mutate input');

const unmuted = setChatMuted(mutedB, 'a', false);
assert.equal(isChatMuted(unmuted, 'a'), false);
assert.equal(isChatMuted(unmuted, 'b'), true);

let record = normalizeChatMuteRecord(null);
const allow = resolveChatAlertThrottle({
  record,
  chatId: 'c1',
  eventId: 'evt-1',
  now: 1000,
  cooldownMs: CHAT_ALERT_COOLDOWN_MS,
});
assert.equal(allow.allow, true);
assert.equal(allow.reason, 'allowed');
record = allow.record;

const dup = resolveChatAlertThrottle({
  record,
  chatId: 'c1',
  eventId: 'evt-1',
  now: 2000,
  cooldownMs: CHAT_ALERT_COOLDOWN_MS,
});
assert.equal(dup.allow, false);
assert.equal(dup.reason, 'duplicate');

const cooldown = resolveChatAlertThrottle({
  record,
  chatId: 'c1',
  eventId: 'evt-2',
  now: 2000,
  cooldownMs: CHAT_ALERT_COOLDOWN_MS,
});
assert.equal(cooldown.allow, false);
assert.equal(cooldown.reason, 'cooldown');

const later = resolveChatAlertThrottle({
  record,
  chatId: 'c1',
  eventId: 'evt-2',
  now: 1000 + CHAT_ALERT_COOLDOWN_MS + 1,
  cooldownMs: CHAT_ALERT_COOLDOWN_MS,
});
assert.equal(later.allow, true);

const noChat = resolveChatAlertThrottle({ record, chatId: '', eventId: 'x', now: 1 });
assert.equal(noChat.allow, true);
assert.equal(noChat.reason, 'no-chat');

console.log('chat-mute.test.js: ok');
