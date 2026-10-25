import assert from 'node:assert/strict';
import {
  ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
  RESUME_FORCE_WS_RECONNECT_MOBILE_MS,
  RESUME_FORCE_WS_RECONNECT_MS,
  RESUME_HISTORY_SYNC_DEFER_DESKTOP_MS,
  RESUME_HISTORY_SYNC_DEFER_MOBILE_MS,
  RESUME_HISTORY_SYNC_MIN_MS,
  RESUME_POLL_REASON_EXTRA_DEFER_MOBILE_MS,
  getResumeHistorySyncDeferMs,
  resolveResumeForceWsReconnectMs,
  shouldApplyReplayEventsToRenderedView,
  shouldDeferResumeHistorySyncReason,
  shouldHttpCatchUpAfterWsReplay,
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

assert.equal(RESUME_FORCE_WS_RECONNECT_MOBILE_MS, 15000);
assert.equal(resolveResumeForceWsReconnectMs(true), RESUME_FORCE_WS_RECONNECT_MOBILE_MS);
assert.equal(resolveResumeForceWsReconnectMs(false), RESUME_FORCE_WS_RECONNECT_MS);
assert.equal(
  shouldRecycleActiveChatSocketOnResume(5000, false, WebSocket.OPEN, true),
  false,
  'A short mobile background keeps the socket (the short probe checks it)'
);
assert.equal(
  shouldRecycleActiveChatSocketOnResume(RESUME_FORCE_WS_RECONNECT_MOBILE_MS, false, WebSocket.OPEN, true),
  true,
  'Mobile recycles an apparently-open socket after ~15s in the background'
);
assert.equal(
  shouldRecycleActiveChatSocketOnResume(16000, false, WebSocket.OPEN, false),
  false,
  'Desktop still waits the long threshold'
);

assert.equal(
  shouldSyncActiveChatHistoryOnResume(2000, false, WebSocket.OPEN),
  true,
  'A short real background interval must still check history'
);
assert.equal(shouldSyncActiveChatHistoryOnResume(10000, false, WebSocket.OPEN), true);
assert.equal(shouldSyncActiveChatHistoryOnResume(61000, false, WebSocket.OPEN), true);
assert.equal(shouldSyncActiveChatHistoryOnResume(2000, false, WebSocket.CLOSED), true);
assert.equal(shouldSyncActiveChatHistoryOnResume(0, false, WebSocket.OPEN), false);
assert.equal(shouldSyncActiveChatHistoryOnResume(2000, true, WebSocket.OPEN), true);
assert.equal(RESUME_HISTORY_SYNC_MIN_MS, 0);

assert.equal(shouldDeferResumeHistorySyncReason('cross_device_poll'), true);
assert.equal(shouldDeferResumeHistorySyncReason('room_state_gap'), true);
assert.equal(shouldDeferResumeHistorySyncReason('selectChat'), false);
assert.equal(shouldDeferResumeHistorySyncReason('replay_complete'), false);

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
assert.equal(
  shouldRunResumeChatHistorySync('notification', 0, false, false),
  true,
  'A notification click must catch the active chat up even without a measured background'
);

assert.equal(shouldSkipHttpHistorySyncForMobileWsReplay(true, true), true);
assert.equal(shouldSkipHttpHistorySyncForMobileWsReplay(true, false), false);
assert.equal(shouldSkipHttpHistorySyncForMobileWsReplay(false, true), false);
assert.equal(shouldDeferResumeHistorySyncReason('replay_fallback'), true);
assert.equal(shouldDeferResumeHistorySyncReason('notification'), false);
assert.equal(shouldHttpCatchUpAfterWsReplay(), true);
assert.equal(shouldApplyReplayEventsToRenderedView(), true);

assert.equal(RESUME_HISTORY_SYNC_DEFER_MOBILE_MS, 2500);
assert.equal(RESUME_HISTORY_SYNC_DEFER_DESKTOP_MS, 1200);
assert.equal(
  getResumeHistorySyncDeferMs('visibility', true, 0),
  0,
  'Active-chat resume sync runs immediately after open/replay'
);
assert.equal(
  getResumeHistorySyncDeferMs('replay_fallback', true, 0),
  0,
  'Active-chat replay fallback catches up immediately too'
);
assert.equal(
  getResumeHistorySyncDeferMs('cross_device_poll', true, 0) >
    getResumeHistorySyncDeferMs('visibility', true, 0),
  true,
  'Background poll syncs keep their own defer'
);
assert.equal(
  getResumeHistorySyncDeferMs('cross_device_poll', true, 0),
  RESUME_HISTORY_SYNC_DEFER_MOBILE_MS + RESUME_POLL_REASON_EXTRA_DEFER_MOBILE_MS
);

assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 101,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: true,
    now: 100000,
    gapObservedAt: 100000,
  }),
  true,
  'Open WS may wait a short grace for live events'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 101,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: true,
    now: 100000 + ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
    gapObservedAt: 100000,
  }),
  false,
  'A one-record gap must HTTP-fetch after the WS grace'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 110,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: true,
    now: 100000 + ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
    gapObservedAt: 100000,
  }),
  false
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 612,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: true,
    now: 100000 + ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
    gapObservedAt: 100000,
  }),
  false,
  'A 512-record gap must not be skipped indefinitely'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: true,
    hydrating: true,
    now: 100000,
    gapObservedAt: 100000,
  }),
  false,
  'Hydrating active chat with a remaining view gap should not skip poll sync'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: false,
    now: 100000,
  }),
  false,
  'Closed WS with a view gap should not skip'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 100,
    viewAppliedSeq: 100,
    wsOpen: false,
    lastSyncAt: 95000,
    now: 100000,
  }),
  false,
  'Cooldown must not hide a view that is still behind the server'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 700,
    localAck: 700,
    viewAppliedSeq: 700,
    wsOpen: false,
    lastSyncAt: 95000,
    now: 100000,
  }),
  true,
  'Caught-up view may use the cooldown'
);
assert.equal(
  shouldSkipActiveChatHistoryPollSync({
    headSeq: 105,
    localAck: 105,
    viewAppliedSeq: 100,
    wsOpen: true,
    now: 100000 + ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
    gapObservedAt: 100000,
  }),
  false,
  'Store ACK ahead of the view still requires applying local records'
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
