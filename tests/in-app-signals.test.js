/**
 * app_front/features/pwa/inAppSignals.js — pure decision, cross-card dedupe,
 * foreground/background policy and soft-failure player behaviour.
 *
 * Acceptance for in-app vibration and sound signals:
 * one new event => at most one application signal, even with several cards.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IN_APP_SIGNAL_HANDLED,
  IN_APP_SIGNAL_MESSAGE,
  createEventIdClaimStore,
  createInAppSignalController,
  createInAppSignalPlayer,
  getInAppSignalController,
  initInAppSignals,
  noteLiveInAppSignal,
  resetInAppSignals,
  resolveInAppSignalDecision,
  resolveSignalEventType,
} from '../app_front/features/pwa/inAppSignals.js';

/** Minimal localStorage-like backend shared by "cards". */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    get length() {
      return map.size;
    },
  };
}

/** Player stub that records calls instead of touching device APIs. */
function fakePlayer() {
  const calls = { vibrate: [], sound: [] };
  return {
    calls,
    isVibrationSupported: () => true,
    isSoundSupported: () => true,
    vibrate: (pattern) => {
      calls.vibrate.push(pattern || []);
      return { ok: true, reason: '' };
    },
    playSound: async (options) => {
      calls.sound.push(options || {});
      return { ok: true, reason: '' };
    },
    ensureUnlocked: async () => ({ ok: true, reason: '' }),
    getState: () => ({ vibrateSupported: true, soundSupported: true, unlocked: true, blocked: false, error: '' }),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- resolveSignalEventType maps transport spellings -------------------------
assert.equal(resolveSignalEventType('agent-finished'), 'finished');
assert.equal(resolveSignalEventType('run-finished'), 'finished');
assert.equal(resolveSignalEventType('agent-needs-input'), 'question');
assert.equal(resolveSignalEventType('opencode_permission'), 'permission');
assert.equal(resolveSignalEventType('opencode_question'), 'question');
assert.equal(resolveSignalEventType('chat-created'), 'newChat');
assert.equal(resolveSignalEventType('newChat'), 'newChat');
assert.equal(resolveSignalEventType('nonsense'), '');

// --- decision: both channels off by default ---------------------------------
const off = resolveInAppSignalDecision({ eventType: 'finished', eventId: 'run-1' });
assert.equal(off.emit, false);
assert.equal(off.reason, 'disabled');

// --- decision: push OFF must not block the in-app sound ----------------------
const soundWithPushOff = resolveInAppSignalDecision({
  preferences: { enabled: false, inAppSound: true },
  eventType: 'finished',
  eventId: 'run-sound-push-off',
});
assert.equal(soundWithPushOff.emit, true, 'sound works while push is disabled');
assert.equal(soundWithPushOff.sound, true);

// --- decision: channels gated by preferences --------------------------------
const vibrateOnly = resolveInAppSignalDecision({
  preferences: { inAppVibrate: true },
  eventType: 'finished',
  eventId: 'run-2',
});
assert.equal(vibrateOnly.emit, true);
assert.equal(vibrateOnly.vibrate, true);
assert.equal(vibrateOnly.sound, false);

const soundOnly = resolveInAppSignalDecision({
  preferences: { inAppSound: true },
  eventType: 'question',
  eventId: 'q-1',
});
assert.equal(soundOnly.emit, true);
assert.equal(soundOnly.vibrate, false);
assert.equal(soundOnly.sound, true);

// --- decision: dedupe, stale sources, background and per-event toggles -------
assert.equal(
  resolveInAppSignalDecision({
    preferences: { inAppVibrate: true },
    eventType: 'finished',
    eventId: 'run-3',
    seenEventIds: new Set(['run-3']),
  }).reason,
  'duplicate'
);
for (const source of ['history', 'replay', 'resume', 'reconnect', 'inbox']) {
  assert.equal(
    resolveInAppSignalDecision({
      preferences: { inAppVibrate: true },
      eventType: 'finished',
      eventId: `run-${source}`,
      source,
    }).reason,
    'stale-source',
    `${source} must not re-signal`
  );
}
assert.equal(
  resolveInAppSignalDecision({
    preferences: { inAppVibrate: true },
    eventType: 'finished',
    eventId: 'run-bg',
    source: 'live',
    foreground: false,
  }).reason,
  'background'
);
assert.equal(
  resolveInAppSignalDecision({
    preferences: { inAppVibrate: true, events: { finished: false } },
    eventType: 'finished',
    eventId: 'run-off',
  }).reason,
  'event-disabled'
);
// The new-chat event has its own toggle, independent of the agent events.
assert.equal(
  resolveInAppSignalDecision({
    preferences: { inAppVibrate: true, events: { newChat: false } },
    eventType: 'chat-created',
    eventId: 'chat-created:c1',
  }).reason,
  'event-disabled'
);
assert.equal(
  resolveInAppSignalDecision({
    preferences: { inAppVibrate: true },
    eventType: 'chat-created',
    eventId: 'chat-created:c2',
  }).emit,
  true
);
assert.equal(
  resolveInAppSignalDecision({ eventType: 'finished', eventId: '' }).reason,
  'missing-event-id'
);
assert.equal(
  resolveInAppSignalDecision({ eventType: 'nope', eventId: 'x' }).reason,
  'unknown-event'
);
assert.equal(
  resolveInAppSignalDecision({
    preferences: { inAppVibrate: true },
    eventType: 'finished',
    eventId: 'run-unsupported',
    vibrateSupported: false,
  }).reason,
  'unsupported'
);

// --- quiet hours and per-chat mute gate vibration/sound only -----------------
const quietDecision = resolveInAppSignalDecision({
  preferences: { inAppVibrate: true, inAppSound: true },
  eventType: 'finished',
  eventId: 'run-quiet',
  quietActive: true,
});
assert.equal(quietDecision.emit, false);
assert.equal(quietDecision.reason, 'quiet-hours');
assert.equal(quietDecision.vibrate, false);
assert.equal(quietDecision.sound, false);

const mutedDecision = resolveInAppSignalDecision({
  preferences: { inAppVibrate: true, inAppSound: true },
  eventType: 'finished',
  eventId: 'run-muted',
  chatMuted: true,
});
assert.equal(mutedDecision.emit, false);
assert.equal(mutedDecision.reason, 'chat-muted');

const mutedCtrl = createInAppSignalController({
  broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppVibrate: true },
  chatMuteRecord: { muted: ['chat-muted-only'] },
});
assert.equal(
  mutedCtrl.handleEvent({ eventType: 'finished', eventId: 'm1', chatId: 'chat-muted-only' }).reason,
  'chat-muted',
);
assert.equal(
  mutedCtrl.handleEvent({ eventType: 'finished', eventId: 'm2', chatId: 'other-chat' }).emit,
  true,
);

// --- claim store: first claim wins, TTL expires ------------------------------
const sharedStorage = fakeStorage();
const claimA = createEventIdClaimStore({ storage: sharedStorage, now: () => 1000 });
const claimB = createEventIdClaimStore({ storage: sharedStorage, now: () => 1000 });
assert.equal(claimA.claim('evt-1'), true);
assert.equal(claimB.claim('evt-1'), false);
assert.equal(claimB.isClaimed('evt-1'), true);

let clock = 0;
const ttlStore = createEventIdClaimStore({ storage: fakeStorage(), now: () => clock, ttlMs: 100 });
assert.equal(ttlStore.claim('evt-2'), true);
clock = 50;
assert.equal(ttlStore.isClaimed('evt-2'), true);
clock = 150;
assert.equal(ttlStore.isClaimed('evt-2'), false);
assert.equal(ttlStore.claim('evt-2'), true);

// --- controller: several cards, one event => one signal ----------------------
const storage = fakeStorage();
const playerA = fakePlayer();
const cardA = createInAppSignalController({ broadcastChannel: null,
  player: playerA,
  storage,
  preferences: { inAppVibrate: true },
  foregroundProvider: () => true,
});
const playerB = fakePlayer();
const cardB = createInAppSignalController({ broadcastChannel: null,
  player: playerB,
  storage,
  preferences: { inAppVibrate: true },
  foregroundProvider: () => true,
});
const first = cardA.handleEvent({ eventType: 'finished', eventId: 'run-shared', source: 'live' });
const second = cardB.handleEvent({ eventType: 'finished', eventId: 'run-shared', source: 'live' });
assert.equal(first.emit, true);
assert.equal(second.emit, false);
assert.equal(second.reason, 'duplicate');
assert.equal(playerA.calls.vibrate.length, 1);
assert.equal(playerB.calls.vibrate.length, 0);
assert.equal(
  playerA.calls.vibrate.length + playerB.calls.vibrate.length,
  1,
  'one new event must yield at most one application signal'
);

// --- controller: sound path actually plays -----------------------------------
const soundPlayer = fakePlayer();
const soundCard = createInAppSignalController({ broadcastChannel: null,
  player: soundPlayer,
  storage: fakeStorage(),
  preferences: { inAppSound: true },
  volume: 0.5,
});
assert.equal(soundCard.handleEvent({ eventType: 'question', eventId: 'q-live' }).emit, true);
await flush();
assert.equal(soundPlayer.calls.sound.length, 1);

// --- controller: background live is skipped, SW message is accepted ----------
const bgCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppVibrate: true },
  foregroundProvider: () => false,
});
assert.equal(bgCard.handleEvent({ eventType: 'finished', eventId: 'bg-live' }).reason, 'background');
assert.equal(
  bgCard.handleEvent({ eventType: 'finished', eventId: 'bg-sw', source: 'sw' }).emit,
  true
);

// --- controller: SW message mapping + dedupe with the live path --------------
const swCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppSound: true },
});
assert.equal(swCard.handleServiceWorkerMessage({ type: 'open-chat' }), null);
const swFirst = swCard.handleServiceWorkerMessage({
  type: IN_APP_SIGNAL_MESSAGE,
  eventType: 'permission',
  eventId: 'per-1',
});
assert.equal(swFirst.emit, true);
assert.equal(swFirst.sound, true);
assert.equal(
  swCard.handleEvent({ eventType: 'permission', eventId: 'per-1', source: 'live' }).reason,
  'duplicate'
);

// --- controller: replied "handled" only when the page actually signals -------
const replies = [];
const replyPort = { postMessage: (message) => replies.push(message) };
const replyCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppSound: true },
});
replyCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'sw-reply' },
  [replyPort]
);
assert.equal(replies[0].type, IN_APP_SIGNAL_HANDLED);
assert.equal(replies[0].handled, true);
// Same event again: the app already produced the signal, so still "handled"
// (the OS notification must not vibrate a second time).
replyCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'sw-reply' },
  [replyPort]
);
assert.equal(replies[1].handled, true, 'duplicate still counts as handled');

// A muted chat / quiet hour / throttled series is a deliberate page-side
// suppression: the SW must treat it as handled and not vibrate a second time.
const muteReplies = [];
const muteCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppVibrate: true },
  chatMuteRecord: { muted: ['mute-chat'] },
});
muteCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'sw-mute', chatId: 'mute-chat' },
  [{ postMessage: (message) => muteReplies.push(message) }]
);
assert.equal(muteReplies[0].handled, true, 'muted chat counts as handled');

const throttleReplies = [];
const throttleCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppVibrate: true },
  now: () => 1000,
});
throttleCard.handleEvent({ eventType: 'finished', eventId: 'throttle-1', chatId: 'chat-1', source: 'live' });
throttleCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'throttle-2', chatId: 'chat-1' },
  [{ postMessage: (message) => throttleReplies.push(message) }]
);
assert.equal(throttleReplies[0].handled, true, 'alert-throttled counts as handled');

// N1 regression: a live event that emitted NOTHING must not consume the series
// slot, otherwise the SW delegation becomes "handled" and the user gets no
// signal at all (vibration, sound and OS notification sound all suppressed).
const offChatReplies = [];
const offChatCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
});
offChatCard.handleEvent({ eventType: 'finished', eventId: 'off-1', chatId: 'off-chat', source: 'live' });
offChatCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'off-1', chatId: 'off-chat' },
  [{ postMessage: (message) => offChatReplies.push(message) }]
);
assert.equal(offChatReplies[0].handled, false, 'channels off with chatId keeps the OS vibration');

// A real emit with a chatId still makes the SW delegation handled (no double).
const emitReplies = [];
const emitCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
  preferences: { inAppVibrate: true },
});
emitCard.handleEvent({ eventType: 'finished', eventId: 'emit-1', chatId: 'emit-chat', source: 'live' });
emitCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'emit-1', chatId: 'emit-chat' },
  [{ postMessage: (message) => emitReplies.push(message) }]
);
assert.equal(emitReplies[0].handled, true, 'a real emit makes the SW delegation handled');

const offReplies = [];
const offReplyCard = createInAppSignalController({ broadcastChannel: null,
  player: fakePlayer(),
  storage: fakeStorage(),
});
offReplyCard.handleServiceWorkerMessage(
  { type: IN_APP_SIGNAL_MESSAGE, eventType: 'finished', eventId: 'sw-off' },
  [{ postMessage: (message) => offReplies.push(message) }]
);
assert.equal(offReplies[0].handled, false, 'channels off => SW keeps the OS vibration');

// --- player: unsupported APIs and blocked autoplay fail soft -----------------
const noApi = createInAppSignalPlayer({ navigator: {}, AudioContext: null });
assert.equal(noApi.isVibrationSupported(), false);
assert.equal(noApi.isSoundSupported(), false);
assert.deepEqual(noApi.vibrate(), { ok: false, reason: 'unsupported' });
assert.equal((await noApi.playSound()).ok, false);

const blockedVibrate = createInAppSignalPlayer({ navigator: { vibrate: () => false }, AudioContext: null });
assert.deepEqual(blockedVibrate.vibrate(), { ok: false, reason: 'blocked' });

function BlockedAudioContext() {
  this.state = 'suspended';
  this.resume = () => Promise.reject(new Error('autoplay blocked'));
}
const blockedSound = createInAppSignalPlayer({ navigator: {}, AudioContext: BlockedAudioContext });
const blockedResult = await blockedSound.playSound();
assert.equal(blockedResult.ok, false);
assert.equal(blockedResult.reason, 'blocked');
assert.equal(blockedSound.getState().blocked, true);

function WorkingAudioContext() {
  this.state = 'suspended';
  this.currentTime = 0;
  this.destination = {};
  this.resume = async () => {
    this.state = 'running';
  };
  this.createOscillator = () => ({ type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} });
  this.createGain = () => ({ gain: { value: 0 }, connect() {} });
}
const okSound = createInAppSignalPlayer({ navigator: {}, AudioContext: WorkingAudioContext });
assert.equal((await okSound.playSound({ gain: 0.1 })).ok, true);
assert.equal(okSound.getState().unlocked, true);

// --- claim store: markSeen (cross-card broadcast) blocks a later claim --------
const seenStorage = fakeStorage();
const seenStore = createEventIdClaimStore({ storage: seenStorage, now: () => 1000 });
seenStore.markSeen('seen-1');
assert.equal(seenStore.claim('seen-1'), false, 'a broadcast seen id cannot be claimed again');

// --- noteLiveInAppSignal preserves an explicit stale source ------------------
resetInAppSignals();
initInAppSignals({ player: fakePlayer(), storage: fakeStorage(), store: null, win: null, navigatorRef: null, broadcastChannel: null });
getInAppSignalController().setPreferences({ inAppVibrate: true });
assert.equal(
  noteLiveInAppSignal({ eventType: 'finished', eventId: 'r-replay', source: 'replay' }).reason,
  'stale-source',
  'a caller-supplied stale source must not be forced to live'
);
assert.equal(noteLiveInAppSignal({ eventType: 'finished', eventId: 'r-live' }).emit, true);
resetInAppSignals();

// --- chatTransport only signals live frames (replay: true is rejected) -------
const transportSource = readFileSync(
  new URL('../app_front/features/chat/chatTransport.js', import.meta.url),
  'utf8'
);
assert.match(transportSource, /function noteInAppSignalIfLive\(msg, eventType, eventId, chat\)/);
assert.match(transportSource, /if \(!msg \|\| msg\.replay === true\) return;/);
// The owning chat id must reach the controller so per-chat mute/throttle applies.
assert.match(transportSource, /chatId: chat\?\.id \|\| ''/);
assert.match(transportSource, /noteInAppSignalIfLive\(msg, 'finished', msg\.runId, chat\)/);
assert.match(transportSource, /noteInAppSignalIfLive\(msg, 'question', msg\.event\.requestId, chat\)/);
assert.match(transportSource, /noteInAppSignalIfLive\(msg, 'permission', msg\.event\.requestId, chat\)/);

console.log('in-app-signals tests passed');
