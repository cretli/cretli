/**
 * Task 1.1 — common pending setter and net-change publisher.
 *
 * Covers the pure batching semantics (net difference, `undefined === false`,
 * `true -> false` inside one batch, coalescing, explicit flush) and the three
 * writers that must share the setter: the history revision poll (with
 * viewAppliedSeq/ACK/grace/retry), the push inbox and the convergence run.
 *
 * The poll integration needs a `document`; the fetch stub returns authoritative
 * responses for every chat id it is given, so no real network is used.
 */
import assert from 'node:assert/strict';

import {
  __resetChatPendingRemoteHistoryForTest,
  beginPendingRemoteHistoryBatch,
  configureChatPendingRemoteHistoryPublisher,
  endPendingRemoteHistoryBatch,
  flushPendingRemoteHistoryPublish,
  setChatPendingRemoteHistoryFlag,
} from '../app_front/features/chat/chatPendingRemoteHistoryFlag.js';
import { applyPushInboxRecordsToChats } from '../app_front/features/pwa/pushInbox.js';
import { runSdkHistoryConvergence } from '../app_front/features/chat/chatHistoryConvergenceRun.js';
import {
  resetViewAppliedSeqMemoryForTests,
  setViewAppliedSeq,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import {
  initChatHistorySyncPoll,
  runChatHistoryRevisionPoll,
  stopChatHistorySyncPoll,
} from '../app_front/features/chat/chatHistorySyncPoll.js';

if (typeof globalThis.document === 'undefined') {
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
}

/** @type {Array<{ chats: object[], meta: { ids: string[], addedIds: string[], removedIds: string[] } }>} */
let publishes = [];

/** @param {object[]} chats @param {{ ids: string[], addedIds: string[], removedIds: string[] }} meta */
function recordPublisher(chats, meta) {
  publishes.push({ chats, meta });
}

function resetPublisher() {
  __resetChatPendingRemoteHistoryForTest();
  publishes = [];
  configureChatPendingRemoteHistoryPublisher(recordPublisher);
}

/** @param {unknown} payload */
function jsonResponse(payload) {
  return { status: 200, ok: true, json: async () => payload };
}

const flushFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalFetch = globalThis.fetch;

// --- A. pure setter/publisher semantics ---------------------------------------------
{
  // true -> false inside one batch is a net zero: nothing is published.
  resetPublisher();
  const chat = { id: 'a' };
  beginPendingRemoteHistoryBatch();
  assert.equal(setChatPendingRemoteHistoryFlag(chat, true), true, 'false -> true flips');
  assert.equal(setChatPendingRemoteHistoryFlag(chat, false), true, 'true -> false flips');
  endPendingRemoteHistoryBatch();
  assert.equal(publishes.length, 0, 'true -> false in one batch publishes nothing');
}
{
  // Hundreds of real changes collapse into exactly one publish.
  resetPublisher();
  const chats = Array.from({ length: 300 }, (_, index) => ({ id: `bulk-${index}` }));
  beginPendingRemoteHistoryBatch();
  for (const item of chats) setChatPendingRemoteHistoryFlag(item, true);
  endPendingRemoteHistoryBatch();
  assert.equal(publishes.length, 1, 'hundreds of changes -> one refresh');
  assert.equal(publishes[0].chats.length, 300);
  assert.equal(publishes[0].meta.addedIds.length, 300);
  // An identical second batch changes nothing and must stay silent.
  beginPendingRemoteHistoryBatch();
  for (const item of chats) setChatPendingRemoteHistoryFlag(item, true);
  endPendingRemoteHistoryBatch();
  assert.equal(publishes.length, 1, 'identical batch after publish adds no refresh');
}
{
  // true -> false -> true within a batch is a net zero for an already pending chat.
  resetPublisher();
  const chat = { id: 'round-trip', _pendingRemoteHistory: true };
  beginPendingRemoteHistoryBatch();
  setChatPendingRemoteHistoryFlag(chat, false);
  setChatPendingRemoteHistoryFlag(chat, true);
  endPendingRemoteHistoryBatch();
  assert.equal(publishes.length, 0, 'round trip back to the baseline publishes nothing');
}
{
  // A real removal is published once.
  resetPublisher();
  const chat = { id: 'removed', _pendingRemoteHistory: true };
  beginPendingRemoteHistoryBatch();
  setChatPendingRemoteHistoryFlag(chat, false);
  endPendingRemoteHistoryBatch();
  assert.equal(publishes.length, 1);
  assert.deepEqual(publishes[0].meta.removedIds, ['removed']);
  assert.deepEqual(publishes[0].meta.addedIds, []);
}
{
  // undefined and false are equivalent; undefined -> false is not a change.
  resetPublisher();
  const chat = { id: 'undefined-eq-false' };
  assert.equal(setChatPendingRemoteHistoryFlag(chat, false), false, 'undefined -> false is no-op');
  assert.equal(setChatPendingRemoteHistoryFlag(chat, undefined), false, 'undefined -> undefined is no-op');
  beginPendingRemoteHistoryBatch();
  setChatPendingRemoteHistoryFlag(chat, true);
  setChatPendingRemoteHistoryFlag(chat, false);
  endPendingRemoteHistoryBatch();
  assert.equal(publishes.length, 0);
}
{
  // Outside an explicit batch the two synchronous changes coalesce in one frame.
  resetPublisher();
  const first = { id: 'frame-a' };
  const second = { id: 'frame-b' };
  setChatPendingRemoteHistoryFlag(first, true);
  setChatPendingRemoteHistoryFlag(second, true);
  assert.equal(publishes.length, 0, 'not published synchronously');
  await flushFrame();
  assert.equal(publishes.length, 1, 'one coalesced publish per frame');
  assert.equal(publishes[0].meta.addedIds.length, 2);
}
{
  // An explicit flush publishes now and cancels the armed frame.
  resetPublisher();
  const chat = { id: 'flush' };
  setChatPendingRemoteHistoryFlag(chat, true);
  flushPendingRemoteHistoryPublish();
  assert.equal(publishes.length, 1, 'flush publishes immediately');
  await flushFrame();
  assert.equal(publishes.length, 1, 'the armed frame does not double-publish');
}

// --- B. push inbox source -----------------------------------------------------------
{
  resetPublisher();
  const now = 2_000_000;
  const chats = Array.from({ length: 200 }, (_, index) => ({ id: `push-${index}` }));
  const records = chats.map((chat, index) => ({
    chatId: chat.id,
    type: 'agent-finished',
    at: now - 1000,
    headSeq: index + 1,
  }));
  applyPushInboxRecordsToChats(chats, records, () => 0, now);
  await flushFrame();
  assert.equal(publishes.length, 1, 'push inbox coalesces to one refresh');
  assert.equal(publishes[0].meta.addedIds.length, 200);
  assert.equal(chats.every((chat) => chat._pendingRemoteHistory === true), true);
  // Replaying the same records must not publish again: the flag is already true.
  applyPushInboxRecordsToChats(chats, records, () => 0, now);
  flushPendingRemoteHistoryPublish();
  assert.equal(publishes.length, 1, 'replayed inbox records publish nothing');
}

// --- C. convergence run source ------------------------------------------------------
{
  resetPublisher();
  resetViewAppliedSeqMemoryForTests();
  const chat = { id: 'convergence', cursorSessionId: 'sess-c', _sdkRichView: {}, _pendingRemoteHistory: true };
  setViewAppliedSeq(chat.id, chat, 10);
  /** @type {import('../app_front/features/chat/chatHistoryConvergenceRun.js')} */
  const deps = {
    isDocumentHidden: () => false,
    getResumeDeferMs: () => 0,
    fetchDelta: async () => ({ headSeq: 5, ackSeq: 5, events: [] }),
    readLocal: async () => ({ events: [] }),
    getStoreAckSeq: () => 5,
  };
  const result = await runSdkHistoryConvergence(chat, { reason: 'test' }, deps);
  assert.equal(result.shouldClearPending, true, 'viewAppliedSeq >= headSeq clears pending');
  assert.equal(chat._pendingRemoteHistory, false);
  await flushFrame();
  assert.equal(publishes.length, 1, 'convergence removal publishes once');
  assert.deepEqual(publishes[0].meta.removedIds, ['convergence']);
  // A second identical run is a no-op.
  await runSdkHistoryConvergence(chat, { reason: 'test' }, deps);
  flushPendingRemoteHistoryPublish();
  assert.equal(publishes.length, 1, 'identical convergence run publishes nothing');
  resetViewAppliedSeqMemoryForTests();
}

// --- D. poll source: hundreds -> one refresh, identical poll -> zero ----------------
{
  resetPublisher();
  const pollChats = Array.from({ length: 300 }, (_, index) => ({
    id: `background-${index}`,
    cursorSessionId: `sess-bg-${index}`,
    agentTransport: 'sdk',
    _serverRunState: { state: 'attention', delegationId: `deleg-${index}`, attention: false },
  }));
  /** @type {Record<string, object>} */
  const statesById = {};
  /** @type {Record<string, object>} */
  const revisions = {};
  for (const chat of pollChats) {
    statesById[chat.id] = { ...chat._serverRunState };
    revisions[chat.id] = { headSeq: 5, hasPendingDelegation: false };
  }
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/chats/agent-states')) return jsonResponse({ ok: true, states: statesById });
    if (href.includes('/api/chats/history-revisions')) return jsonResponse({ ok: true, revisions });
    if (href.includes('/api/chats/history-batch')) return jsonResponse({ ok: true, histories: {} });
    return jsonResponse({ ok: true });
  };
  initChatHistorySyncPoll({
    getChats: () => pollChats,
    getActiveChatId: () => 'other',
    syncSdkHistoryOnResume: async () => ({ status: 'success' }),
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => false,
    onPendingHistoryChange: recordPublisher,
  });
  await runChatHistoryRevisionPoll();
  assert.equal(publishes.length, 1, 'hundreds of pending changes -> one refresh per poll pass');
  assert.equal(publishes[0].meta.addedIds.length, 300);
  assert.equal(
    pollChats.filter((chat) => chat._pendingRemoteHistory === true).length,
    300,
    'all models updated immediately'
  );
  await runChatHistoryRevisionPoll();
  flushPendingRemoteHistoryPublish();
  assert.equal(publishes.length, 1, 'identical next poll adds no refresh');
  stopChatHistorySyncPoll();
}

// --- D2. poll source: ACK/viewAppliedSeq clears pending once ------------------------
{
  resetPublisher();
  const activeChat = {
    id: 'active-ack',
    cursorSessionId: 'sess-a',
    agentTransport: 'sdk',
    _pendingRemoteHistory: true,
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/chats/agent-states')) return jsonResponse({ ok: true, states: {} });
    if (href.includes('/api/chats/history-revisions')) {
      return jsonResponse({
        ok: true,
        revisions: { [activeChat.id]: { headSeq: 9, hasPendingDelegation: false } },
      });
    }
    return jsonResponse({ ok: true });
  };
  initChatHistorySyncPoll({
    getChats: () => [activeChat],
    getActiveChatId: () => activeChat.id,
    syncSdkHistoryOnResume: async (chat) => {
      chat._sdkViewAppliedSeq = 9;
      return { status: 'success' };
    },
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => false,
    onPendingHistoryChange: recordPublisher,
  });
  await runChatHistoryRevisionPoll();
  assert.equal(activeChat._pendingRemoteHistory, false, 'ACK + viewAppliedSeq clears pending');
  assert.equal(publishes.length, 1, 'the removal is published exactly once');
  assert.deepEqual(publishes[0].meta.removedIds, [activeChat.id]);
  stopChatHistorySyncPoll();
}

// --- D3. poll source: WS grace keeps pending without extra refreshes ---------------
{
  resetPublisher();
  const graceChat = {
    id: 'active-grace',
    cursorSessionId: 'sess-g',
    agentTransport: 'sdk',
    ws: { readyState: WebSocket.OPEN },
  };
  let syncCalls = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/chats/agent-states')) return jsonResponse({ ok: true, states: {} });
    if (href.includes('/api/chats/history-revisions')) {
      return jsonResponse({
        ok: true,
        revisions: { [graceChat.id]: { headSeq: 9, hasPendingDelegation: false } },
      });
    }
    return jsonResponse({ ok: true });
  };
  initChatHistorySyncPoll({
    getChats: () => [graceChat],
    getActiveChatId: () => graceChat.id,
    syncSdkHistoryOnResume: async () => {
      syncCalls += 1;
      return { status: 'success' };
    },
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => true,
    onPendingHistoryChange: recordPublisher,
  });
  await runChatHistoryRevisionPoll();
  assert.equal(syncCalls, 0, 'an open WS inside the grace window skips the resume sync');
  assert.equal(graceChat._pendingRemoteHistory, true, 'grace keeps pending');
  assert.equal(publishes.length, 1, 'the pending flag is published once');
  assert.deepEqual(publishes[0].meta.addedIds, [graceChat.id]);
  await runChatHistoryRevisionPoll();
  flushPendingRemoteHistoryPublish();
  assert.equal(publishes.length, 1, 'a second poll inside grace publishes nothing new');
  stopChatHistorySyncPoll();
}

// --- D4. poll source: retry keeps pending without extra refreshes ------------------
{
  resetPublisher();
  const retryChat = {
    id: 'active-retry',
    cursorSessionId: 'sess-r',
    agentTransport: 'sdk',
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/chats/agent-states')) return jsonResponse({ ok: true, states: {} });
    if (href.includes('/api/chats/history-revisions')) {
      return jsonResponse({
        ok: true,
        revisions: { [retryChat.id]: { headSeq: 9, hasPendingDelegation: false } },
      });
    }
    return jsonResponse({ ok: true });
  };
  initChatHistorySyncPoll({
    getChats: () => [retryChat],
    getActiveChatId: () => retryChat.id,
    syncSdkHistoryOnResume: async () => ({ status: 'error' }),
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => false,
    onPendingHistoryChange: recordPublisher,
  });
  await runChatHistoryRevisionPoll();
  assert.equal(retryChat._pendingRemoteHistory, true, 'an error keeps pending for retry');
  assert.equal(publishes.length, 1, 'the retry state is published once');
  assert.deepEqual(publishes[0].meta.addedIds, [retryChat.id]);
  await runChatHistoryRevisionPoll();
  flushPendingRemoteHistoryPublish();
  assert.equal(publishes.length, 1, 'a repeated retry publishes nothing new');
  stopChatHistorySyncPoll();
}

// --- D5. poll async gap: push inbox publishes before poll finishes -----------
{
  resetPublisher();
  /** @type {(() => void) | null} */
  let releaseRevisions = null;
  const revisionsGate = new Promise((resolve) => {
    releaseRevisions = () => resolve(undefined);
  });
  const blockedPollChat = {
    id: 'poll-blocked',
    cursorSessionId: 'sess-block',
    agentTransport: 'sdk',
    _serverRunState: { state: 'attention', delegationId: 'd-block', attention: false },
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/chats/agent-states')) {
      return jsonResponse({
        ok: true,
        states: { [blockedPollChat.id]: blockedPollChat._serverRunState },
      });
    }
    if (href.includes('/api/chats/history-revisions')) {
      await revisionsGate;
      return jsonResponse({
        ok: true,
        revisions: { [blockedPollChat.id]: { headSeq: 9, hasPendingDelegation: false } },
      });
    }
    return jsonResponse({ ok: true });
  };
  initChatHistorySyncPoll({
    getChats: () => [blockedPollChat],
    getActiveChatId: () => 'other',
    syncSdkHistoryOnResume: async () => ({ status: 'success' }),
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => false,
    onPendingHistoryChange: recordPublisher,
  });
  const pollPromise = runChatHistoryRevisionPoll();
  const inboxChat = { id: 'inbox-during-poll' };
  applyPushInboxRecordsToChats(
    [inboxChat],
    [{ chatId: inboxChat.id, type: 'agent-finished', at: 1, headSeq: 2 }],
    () => 0,
    5000
  );
  await flushFrame();
  assert.equal(publishes.length, 1, 'push inbox during poll await publishes in one frame');
  assert.deepEqual(publishes[0].meta.addedIds, [inboxChat.id]);
  releaseRevisions?.();
  await pollPromise;
  flushPendingRemoteHistoryPublish();
  assert.equal(
    publishes.length,
    2,
    'poll finishes with a separate coalesced refresh for its own pending flips'
  );
  stopChatHistorySyncPoll();
}

__resetChatPendingRemoteHistoryForTest();
globalThis.fetch = originalFetch;
console.log('chat-pending-remote-history.test.js OK');
