import assert from 'node:assert/strict';
import {
  buildAgentFinishedPushData,
  buildPushInboxRecordFromNotificationPayload,
  mergePushInboxRecords,
  resolvePushInboxRecordDeviceTime,
  shouldApplyPushInboxPresenceRecord,
  shouldSyncChatHistoryFromPushInbox,
  clipPushInboxSnippet,
  trimWebPushNotificationPayload,
  PUSH_INBOX_STATE_MAX_AGE_MS,
} from '../lib/push-inbox-logic.js';
import {
  applyPushInboxRecordsToChats,
  buildPushPreviewPatch,
  clearPushPreview,
  consumePushInbox,
  shouldDeletePushInboxRecord,
} from '../app_front/features/pwa/pushInbox.js';
import { applyAgentPresenceToChats } from '../app_front/features/chat/chatHistorySyncPoll.js';

assert.equal(buildPushInboxRecordFromNotificationPayload({}), null);
assert.equal(buildPushInboxRecordFromNotificationPayload({ data: {} }), null);

const finishedPayload = {
  title: 'Cretli — agent finished',
  body: 'done',
  data: {
    type: 'agent-finished',
    chatId: 'chat-1',
    status: 'completed',
    headSeq: 42,
    title: 'My chat',
    snippet: 'Hello world',
    at: 1000,
    url: '/?chat=chat-1',
  },
};
const finishedRecord = buildPushInboxRecordFromNotificationPayload(finishedPayload);
assert.ok(Number.isFinite(finishedRecord.receivedAt), 'SW write stamps a device-clock receivedAt');
assert.deepEqual(finishedRecord, {
  chatId: 'chat-1',
  type: 'agent-finished',
  status: 'completed',
  headSeq: 42,
  title: 'My chat',
  snippet: 'Hello world',
  at: 1000,
  receivedAt: finishedRecord.receivedAt,
});

const older = { chatId: 'c', type: 'agent-finished', at: 1000, status: 'busy' };
const newer = { chatId: 'c', type: 'agent-finished', at: 2000, status: 'done' };
assert.deepEqual(mergePushInboxRecords(older, newer), newer);
assert.deepEqual(mergePushInboxRecords(newer, older), newer);

assert.equal(shouldSyncChatHistoryFromPushInbox(10, 9), true);
assert.equal(shouldSyncChatHistoryFromPushInbox(10, 10), false);
assert.equal(shouldSyncChatHistoryFromPushInbox(0, 0), false);

const longText = 'word '.repeat(100).trim();
assert.ok(clipPushInboxSnippet(longText).length <= 280);
assert.match(clipPushInboxSnippet(longText), /…$/);

const agentFinishedData = buildAgentFinishedPushData({
  chatId: 'abc',
  chatTitle: 'Title',
  status: 'done',
  headSeq: 7,
  snippet: 'Reply text',
  url: '/?source=pwa&panel=chat&chat=abc',
  at: 5000,
});
assert.equal(agentFinishedData.type, 'agent-finished');
assert.equal(agentFinishedData.chatId, 'abc');
assert.equal(agentFinishedData.headSeq, 7);
assert.equal(agentFinishedData.snippet, 'Reply text');
assert.equal(agentFinishedData.at, 5000);

const chats = [{ id: 'chat-1', _serverRunState: { state: 'busy', runId: 'r1' } }];
const freshNow = 2_000_000;
const applied = applyPushInboxRecordsToChats(
  chats,
  [{ chatId: 'chat-1', type: 'agent-finished', at: freshNow - 1000, headSeq: 20 }],
  () => 10,
  freshNow
);
assert.equal(applied.syncChatIds.includes('chat-1'), true);
assert.equal(chats[0]._serverRunState, null);
assert.equal(chats[0]._pendingRemoteHistory, true);

const waitingChats = [{ id: 'chat-2' }];
applyPushInboxRecordsToChats(
  waitingChats,
  [{ chatId: 'chat-2', type: 'agent-needs-input', kind: 'question', at: freshNow - 500 }],
  () => 0,
  freshNow
);
assert.equal(waitingChats[0]._serverRunState?.state, 'waiting');

const now = 1_000_000;
const staleServerAt = [{ id: 'chat-3', _serverRunState: { state: 'busy' }, _serverRunStateAt: 500 }];
applyPushInboxRecordsToChats(
  staleServerAt,
  [{ chatId: 'chat-3', type: 'agent-finished', at: 400 }],
  () => 0,
  now
);
assert.equal(staleServerAt[0]._serverRunState?.state, 'busy');

const agedOut = [{ id: 'chat-4', _serverRunState: { state: 'busy' } }];
const agedApplied = applyPushInboxRecordsToChats(
  agedOut,
  [{ chatId: 'chat-4', type: 'agent-finished', at: now - PUSH_INBOX_STATE_MAX_AGE_MS - 1, headSeq: 99 }],
  () => 0,
  now
);
assert.equal(agedOut[0]._serverRunState?.state, 'busy');
assert.equal(agedApplied.syncChatIds.includes('chat-4'), true);

const newerRecord = [{ id: 'chat-5', _serverRunState: { state: 'busy' }, _serverRunStateAt: 100 }];
applyPushInboxRecordsToChats(
  newerRecord,
  [{ chatId: 'chat-5', type: 'agent-finished', at: 200 }],
  () => 0,
  now
);
assert.equal(newerRecord[0]._serverRunState, null);
// (e) the inbox must never move the authoritative server watermark.
assert.equal(newerRecord[0]._serverRunStateAt, 100);
assert.equal(newerRecord[0]._inboxRunStateAt, 200);

// An older inbox record is blocked by the inbox's own watermark.
const replayedOlder = applyPushInboxRecordsToChats(
  newerRecord,
  [{ chatId: 'chat-5', type: 'agent-needs-input', at: 150 }],
  () => 0,
  now
);
assert.equal(replayedOlder.changed, false);
assert.equal(newerRecord[0]._serverRunState, null);

assert.equal(
  shouldApplyPushInboxPresenceRecord({ at: 50 }, { _serverRunStateAt: 100 }, now),
  false
);
assert.equal(
  shouldApplyPushInboxPresenceRecord({ at: 150 }, { _inboxRunStateAt: 200 }, now),
  false
);

// (d) a server presence frame with no state change still raises the server
// watermark and blocks an older inbox record.
const presenceChat = [{ id: 'chat-6', _serverRunState: { state: 'busy' } }];
const presenceResult = applyAgentPresenceToChats(presenceChat, {
  snapshot: false,
  states: { 'chat-6': { state: 'busy' } },
});
assert.equal(presenceResult.changed, false);
assert.ok(presenceChat[0]._serverRunStateAt > 0);
assert.equal(
  shouldApplyPushInboxPresenceRecord(
    { at: presenceChat[0]._serverRunStateAt - 1 },
    presenceChat[0],
    Date.now()
  ),
  false
);

// A snapshot also stamps every chat it covers (missing ids are idle).
const snapshotChat = [{ id: 'chat-7' }];
const snapshotResult = applyAgentPresenceToChats(snapshotChat, { snapshot: true, states: {} });
assert.equal(snapshotResult.changed, false);
assert.ok(snapshotChat[0]._serverRunStateAt > 0);

// (b) a record for a chat outside the list is NOT deleted and stays applicable.
const agedNow = PUSH_INBOX_STATE_MAX_AGE_MS * 4;
const freshRecordAt = agedNow - 1000;
const missingResult = applyPushInboxRecordsToChats(
  [],
  [
    { chatId: 'later-chat', type: 'agent-needs-input', at: freshRecordAt },
    { chatId: 'old-gone', type: 'agent-needs-input', at: agedNow - PUSH_INBOX_STATE_MAX_AGE_MS - 1 },
  ],
  () => 0,
  agedNow
);
assert.equal(missingResult.appliedIds.includes('later-chat'), false);
assert.equal(missingResult.expiredIds.includes('later-chat'), false);
assert.equal(missingResult.expiredIds.includes('old-gone'), true);

const laterChats = [{ id: 'later-chat' }];
const laterResult = applyPushInboxRecordsToChats(
  laterChats,
  [{ chatId: 'later-chat', type: 'agent-needs-input', at: freshRecordAt }],
  () => 0,
  agedNow
);
assert.equal(laterResult.appliedIds.includes('later-chat'), true);
assert.equal(laterChats[0]._serverRunState?.state, 'waiting');

// (c) an expired record is deleted and never changes state.
const expiredChats = [{ id: 'expired-chat', _serverRunState: { state: 'busy' } }];
const expiredResult = applyPushInboxRecordsToChats(
  expiredChats,
  [{
    chatId: 'expired-chat',
    type: 'agent-finished',
    at: agedNow - PUSH_INBOX_STATE_MAX_AGE_MS - 1,
  }],
  () => 0,
  agedNow
);
assert.equal(expiredChats[0]._serverRunState.state, 'busy');
assert.equal(expiredResult.expiredIds.includes('expired-chat'), true);
assert.equal(expiredResult.appliedIds.includes('expired-chat'), false);

const longTitle = 'ą'.repeat(200);
const hugeSnippet = 'x'.repeat(4000);
const trimmed = trimWebPushNotificationPayload({
  title: longTitle,
  body: 'body '.repeat(500),
  tag: 'cretli-chat',
  data: buildAgentFinishedPushData({
    chatId: 'c',
    chatTitle: longTitle,
    status: 'done',
    headSeq: 1,
    snippet: hugeSnippet,
    at: now,
  }),
});
assert.ok(trimmed.title.length <= 120);
assert.ok(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= 3000);

// (a) trim terminates and stays under the limit for huge url/tag/title and
// multibyte characters.
const multibyteTitle = 'ęż'.repeat(500);
const hugeUrl = `https://example.test/${'ż'.repeat(10 * 1024)}?q=${'x'.repeat(2048)}`;
const hugeTrimmed = trimWebPushNotificationPayload({
  title: multibyteTitle,
  body: '😀'.repeat(3000),
  tag: `cretli-${'ą'.repeat(2000)}`,
  data: buildAgentFinishedPushData({
    chatId: 'c',
    chatTitle: multibyteTitle,
    status: 'done',
    headSeq: 1,
    snippet: 'x'.repeat(4000),
    url: hugeUrl,
    at: now,
  }),
});
assert.ok(
  Buffer.byteLength(JSON.stringify(hugeTrimmed), 'utf8') <= 3000,
  'trimmed payload must always stay within the byte limit'
);
assert.equal(hugeTrimmed.title, 'Cretli');

// (f) consume neither loops nor refreshes when nothing was applied, and settles
// after a single applied pass even when the refresh re-enters consume.
const terminateStore = new Map([
  ['missing-now', { chatId: 'missing-now', type: 'agent-needs-input', at: Date.now() }],
]);
let refreshCount = 0;
const baseConsumeDeps = {
  getChats: () => [],
  getLastAckedSeq: () => 0,
  syncChatHistoryDelta: async () => {},
  readRecords: async () => [...terminateStore.values()],
  deleteRecords: async (ids) => {
    for (const id of ids) terminateStore.delete(id);
  },
  refreshFromServer: async () => {
    refreshCount += 1;
  },
};
await consumePushInbox(baseConsumeDeps);
assert.equal(refreshCount, 0, 'nothing applied -> no server refresh');
assert.equal(terminateStore.size, 1, 'unapplied record must survive');

const presentChats = [{ id: 'missing-now' }];
const loopDeps = {
  ...baseConsumeDeps,
  getChats: () => presentChats,
  refreshFromServer: async () => {
    refreshCount += 1;
    if (refreshCount < 5) await consumePushInbox(loopDeps);
  },
};
await consumePushInbox(loopDeps);
assert.equal(refreshCount, 1, 'consume/refresh settles after one applied pass');
assert.equal(terminateStore.size, 0, 'applied record is deleted');

// (g) receivedAt is the device clock used for watermark/age checks; the server
// `at` alone is meaningless against a client-clock watermark.
const clockNow = 10_000_000;
assert.equal(resolvePushInboxRecordDeviceTime({ at: 1, receivedAt: 9_999_000 }), 9_999_000);
assert.equal(resolvePushInboxRecordDeviceTime({ at: 123 }), 123);
assert.equal(
  shouldApplyPushInboxPresenceRecord(
    { at: 1, receivedAt: clockNow - 1000 },
    { _serverRunStateAt: clockNow - 5000 },
    clockNow
  ),
  true,
  'fresh device clock wins over an old server at'
);
assert.equal(
  shouldApplyPushInboxPresenceRecord(
    { at: clockNow, receivedAt: clockNow - PUSH_INBOX_STATE_MAX_AGE_MS - 1 },
    {},
    clockNow
  ),
  false,
  'age is computed from receivedAt'
);
assert.equal(
  shouldApplyPushInboxPresenceRecord(
    { at: clockNow, receivedAt: clockNow - 1000 },
    { _serverRunStateAt: clockNow },
    clockNow
  ),
  false,
  'device watermark still rejects an older receivedAt'
);

// (h) agent-finished preview patch: only for agent-finished with a snippet.
assert.deepEqual(
  buildPushPreviewPatch({ type: 'agent-finished', snippet: 'Hello there', at: 5, receivedAt: 7 }),
  { text: 'Hello there', at: 7 }
);
assert.equal(buildPushPreviewPatch({ type: 'agent-needs-input', snippet: 'x', at: 5 }), null);
assert.equal(buildPushPreviewPatch({ type: 'agent-finished', at: 5 }), null);

// (i) an applied agent-finished record sets `_pushPreview` in memory only, and
// clearPushPreview removes it.
const previewNow = PUSH_INBOX_STATE_MAX_AGE_MS * 2;
const previewChats = [{ id: 'preview-chat' }];
const previewResult = applyPushInboxRecordsToChats(
  previewChats,
  [{
    chatId: 'preview-chat',
    type: 'agent-finished',
    snippet: 'Latest assistant reply',
    at: previewNow,
    receivedAt: previewNow - 100,
  }],
  () => 0,
  previewNow
);
assert.equal(previewChats[0]._pushPreview.text, 'Latest assistant reply');
assert.equal(previewResult.previewIds.includes('preview-chat'), true);
assert.equal(previewResult.changed, true, 'a preview is a render-worthy change');
assert.equal(clearPushPreview(previewChats[0]), true);
assert.equal(previewChats[0]._pushPreview, undefined);
assert.equal(clearPushPreview(previewChats[0]), false);

// (j) a record rejected by the watermark is deleted but never counted applied.
const ignoredNow = PUSH_INBOX_STATE_MAX_AGE_MS * 2;
const ignoredChats = [{ id: 'ignored-chat', _serverRunStateAt: ignoredNow, _inboxRunStateAt: ignoredNow }];
const ignoredResult = applyPushInboxRecordsToChats(
  ignoredChats,
  [{
    chatId: 'ignored-chat',
    type: 'agent-needs-input',
    at: ignoredNow,
    receivedAt: ignoredNow - 100,
  }],
  () => 0,
  ignoredNow
);
assert.equal(ignoredResult.appliedIds.includes('ignored-chat'), false);
assert.equal(ignoredResult.ignoredIds.includes('ignored-chat'), true);
assert.equal(ignoredResult.changed, false);
assert.equal(ignoredResult.syncChatIds.length, 0);

// (k) delete decision only removes the exact record that was read.
assert.equal(shouldDeletePushInboxRecord({ chatId: 'c', at: 42 }, 42), true);
assert.equal(shouldDeletePushInboxRecord({ chatId: 'c', at: 43 }, 42), false, 'newer SW record survives');
assert.equal(shouldDeletePushInboxRecord(null, 42), false);
assert.equal(shouldDeletePushInboxRecord({ chatId: 'c', at: 42 }, undefined), true, 'legacy unconditional');

console.log('push-inbox-logic.test.js: ok');
