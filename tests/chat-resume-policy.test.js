import assert from 'node:assert/strict';
import {
  ACTIVE_CHAT_HISTORY_POLL_SKIP_GAP,
  RESUME_FORCE_WS_RECONNECT_MS,
  RESUME_HISTORY_SYNC_MIN_MS,
  getResumeHistorySyncDeferMs,
  shouldDeferResumeHistorySyncReason,
  shouldRecycleActiveChatSocketOnResume,
  shouldRunResumeChatHistorySync,
  shouldSkipActiveChatHistoryPollSync,
  shouldSkipHttpHistorySyncForMobileWsReplay,
  shouldSyncActiveChatHistoryOnResume,
} from '../app_front/features/chat/chatResumePolicy.js';
import {
  getLastAckedSeq,
  resetLastAckedSeqMemoryForTests,
} from '../app_front/lib/sdk-chat-history-store.js';

assert.equal(shouldRecycleActiveChatSocketOnResume(5000, false, WebSocket.OPEN), false);
assert.equal(shouldRecycleActiveChatSocketOnResume(5000, true, WebSocket.OPEN), true);
assert.equal(
  shouldRecycleActiveChatSocketOnResume(RESUME_FORCE_WS_RECONNECT_MS, false, WebSocket.OPEN),
  true
);
assert.equal(shouldRecycleActiveChatSocketOnResume(120000, false, WebSocket.CONNECTING), false);

assert.equal(shouldSyncActiveChatHistoryOnResume(2000, false, WebSocket.OPEN), false);
assert.equal(shouldSyncActiveChatHistoryOnResume(2000, false, WebSocket.CLOSED), true);
assert.equal(
  shouldSyncActiveChatHistoryOnResume(RESUME_HISTORY_SYNC_MIN_MS, false, WebSocket.OPEN),
  true
);
assert.equal(shouldSyncActiveChatHistoryOnResume(2000, true, WebSocket.OPEN), true);

assert.equal(shouldDeferResumeHistorySyncReason('cross_device_poll'), true);
assert.equal(shouldDeferResumeHistorySyncReason('room_state_gap'), true);
assert.equal(shouldDeferResumeHistorySyncReason('selectChat'), false);

assert.equal(
  shouldRunResumeChatHistorySync('pageshow', 0, false, false),
  false,
  'Initial pageshow must not trigger resume history sync'
);
assert.equal(shouldRunResumeChatHistorySync('pageshow', 0, true, false), true);
assert.equal(shouldRunResumeChatHistorySync('pageshow', 5000, false, false), true);
assert.equal(shouldRunResumeChatHistorySync('visibility', 0, false, true), true);
assert.equal(shouldRunResumeChatHistorySync('online', 0, false, false), true);
assert.equal(shouldRunResumeChatHistorySync('backend_recovery', 0, false, false), true);

assert.equal(shouldSkipHttpHistorySyncForMobileWsReplay(true, true), true);
assert.equal(shouldSkipHttpHistorySyncForMobileWsReplay(true, false), false);
assert.equal(shouldSkipHttpHistorySyncForMobileWsReplay(false, true), false);
assert.equal(shouldDeferResumeHistorySyncReason('replay_fallback'), true);

assert.equal(getResumeHistorySyncDeferMs('visibility', true, 0) > 0, true);
assert.equal(
  getResumeHistorySyncDeferMs('cross_device_poll', true, 0) >
    getResumeHistorySyncDeferMs('visibility', true, 0),
  true
);

assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 100,
    localAck: 100 - ACTIVE_CHAT_HISTORY_POLL_SKIP_GAP,
    wsOpen: true,
    now: 100000,
  }),
  true
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 100,
    localAck: 100 - ACTIVE_CHAT_HISTORY_POLL_SKIP_GAP,
    wsOpen: true,
    now: 100000,
    hasPendingDelegation: true,
  }),
  false,
  'Pending delegation card must pull even when the socket is open'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 100,
    wsOpen: true,
    hydrating: true,
    now: 100000,
  }),
  false,
  'Hydrating active chat with large gap should not skip poll sync'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 100,
    wsOpen: false,
    now: 100000,
  }),
  false,
  'Large gap without WS should not skip'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 100,
    wsOpen: false,
    lastSyncAt: 95000,
    now: 100000,
  }),
  true,
  'Recent sync within cooldown should skip even with large gap'
);

resetLastAckedSeqMemoryForTests();
const originalLocalStorage = globalThis.localStorage;
/** @type {Map<string, string>} */
const storageMap = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storageMap.has(String(key)) ? storageMap.get(String(key)) : null;
  },
  setItem(key, value) {
    storageMap.set(String(key), String(value));
  },
  removeItem(key) {
    storageMap.delete(String(key));
  },
};
storageMap.set('cretli-chat-history-ackedseq-chat-a', '42');
assert.equal(getLastAckedSeq('chat-a'), 42);
globalThis.localStorage = {
  getItem() {
    throw new Error('storage blocked');
  },
  setItem() {
    throw new Error('storage blocked');
  },
  removeItem() {
    throw new Error('storage blocked');
  },
};
assert.equal(getLastAckedSeq('chat-a'), 42);
globalThis.localStorage = originalLocalStorage;
resetLastAckedSeqMemoryForTests();

console.log('All chat-resume-policy tests passed.');
