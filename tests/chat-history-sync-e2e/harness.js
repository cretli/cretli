import { createSdkRichView } from '../../app_front/lib/sdk-rich-view.js';
import { initI18n } from '../../app_front/i18n/index.js';
import { setCsrfToken } from '../../app_front/api.js';
import {
  CHAT_PING_INTERVAL_MS,
  CHAT_RECONNECT_DELAYS,
  CHAT_RECONNECT_MAX,
  WS_PATH_AGENT_SDK,
} from '../../app_front/config.js';
import { createChatTransport } from '../../app_front/features/chat/chatTransport.js';
import {
  getViewAppliedSeq,
  replaceViewAppliedRecords,
  resetViewAppliedState,
  resolveChatHistoryConvergence,
  setChatHistorySyncInFlight,
  shouldKeepHistorySyncInFlight,
  markHistorySyncInFlightForWsReplay,
  clearHistorySyncInFlightAfterWsReplay,
} from '../../app_front/features/chat/chatHistoryConvergence.js';
import {
  applyCatchUpSdkHistoryRecords,
  applyLiveServerHistoryCards,
} from '../../app_front/features/chat/chatHistoryViewApply.js';
import { runSdkHistoryConvergence } from '../../app_front/features/chat/chatHistoryConvergenceRun.js';
import {
  beginSdkHistoryHydration,
  hasSdkHistoryRoomWatermarks,
  shouldApplySdkRoomEvent,
} from '../../app_front/features/chat/sdkEventReplayGuard.js';
import {
  acknowledgeChatHistorySeq,
  getLastAckedSeq,
  readSdkChatHistoryStateAsync,
  replaceSdkChatHistoryRecords,
  syncChatHistoryDeltaFromServer,
} from '../../app_front/lib/sdk-chat-history-store.js';

class HarnessWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {HarnessWebSocket[]} */
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = HarnessWebSocket.CONNECTING;
    this.sent = [];
    HarnessWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === HarnessWebSocket.CLOSED) return;
    this.readyState = HarnessWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

window.WebSocket = HarnessWebSocket;

const mount = document.getElementById('mount');
const store = { events: [], ackSeq: 0 };
const chat = { id: 'sync-chat', cursorSessionId: 'sess-sync', _sdkEventStreamId: 'room-sync' };
let hidden = false;
let failNextAppend = false;
let failNextApplyEvent = false;
let lastStatus = '';
let serverHeadSeq = 0;
let fetchGate = Promise.resolve();
let releaseFetchGate = () => {};
let historyFetchCount = 0;
let lastHydrationRecords = null;
let lastNotified = false;
let resumeDeferMs = 0;
let hideDuringResumeSleep = false;

const noop = () => {};
const chatTransport = createChatTransport({
  WS_PATH_AGENT_SDK,
  CHAT_RECONNECT_MAX,
  CHAT_RECONNECT_DELAYS,
  CHAT_PING_INTERVAL_MS,
  getChats: () => [chat],
  getActiveChatId: () => chat.id,
  getMaintainSessionsEnabled: () => false,
  getChatActivityAt: () => Date.now(),
  getSkipCatchUpOnResume: () => false,
  appLogger: { log() {} },
  setChatStatus: noop,
  setAgentState: noop,
  renderChatTerminalState: noop,
  buildCatchUpSignature: () => '',
  processAgentOutput: noop,
  processAgentOutputCatchUp: noop,
  updateAwaitingInput: noop,
  setLaunchCommand: noop,
  scrollChatTerminalToBottom: noop,
});

window.__chatSync = {
  ready: false,
  lastStatus: () => lastStatus,
  viewAppliedSeq: () => getViewAppliedSeq(chat.id, chat),
  texts: () => String(mount?.innerText || ''),
  html: () => String(mount?.innerHTML || ''),
  historySyncing: () => chat._historySyncInFlight === true,
  fetchCount: () => historyFetchCount,
};

function wrapView(view) {
  const originalAppend = view.appendHistoryRecords.bind(view);
  view.appendHistoryRecords = async (records, opts) => {
    if (failNextAppend) {
      failNextAppend = false;
      throw new Error('render failed');
    }
    return originalAppend(records, opts);
  };
  const originalApply = view.applyEvent.bind(view);
  view.applyEvent = (event, meta) => {
    if (failNextApplyEvent) {
      failNextApplyEvent = false;
      throw new Error('applyEvent failed');
    }
    return originalApply(event, meta);
  };
  return view;
}

function createView() {
  if (chat._sdkRichView?.destroy) chat._sdkRichView.destroy();
  mount.replaceChildren();
  chat._sdkRichView = wrapView(createSdkRichView({ id: chat.id, sdkUiMode: 'full' }, mount, {
    appendPlain() {},
  }));
}

function upsertStore(records) {
  const bySeq = new Map(store.events.map((row) => [Number(row.historySeq) || 0, row]));
  for (const record of records) {
    const seq = Number(record.historySeq) || 0;
    if (seq > 0) bySeq.set(seq, record);
    else store.events.push(record);
  }
  store.events = [...bySeq.values()].filter((row) => Number(row.historySeq) > 0)
    .sort((left, right) => Number(left.historySeq) - Number(right.historySeq));
  store.ackSeq = store.events.reduce((max, row) => Math.max(max, Number(row.historySeq) || 0), 0);
}

async function converge(fetchedRecords = []) {
  const decision = resolveChatHistoryConvergence({
    reason: 'harness',
    documentHidden: hidden,
    serverHeadSeq,
    storeAckSeq: store.ackSeq,
    viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
    viewAppliedSeqs: chat._sdkViewAppliedSeqs,
    viewAppliedOrigin: chat._sdkViewAppliedOrigin,
    fetchedRecords,
    localRecords: store.events.slice(),
  });
  lastStatus = decision.status;
  if (!decision.shouldApplyToView) {
    return {
      status: decision.status,
      seqs: decision.recordsToApply.map((row) => row.historySeq),
      viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
    };
  }
  try {
    const emptyView =
      getViewAppliedSeq(chat.id, chat) <= 0 && !hasSdkHistoryRoomWatermarks(chat);
    if (emptyView) {
      chat._sdkRichView.replayHistoryRecords(decision.recordsToApply, { instant: true });
      replaceViewAppliedRecords(chat.id, chat, decision.recordsToApply);
    } else {
      await applyCatchUpSdkHistoryRecords(chat, decision.recordsToApply);
    }
  } catch {
    lastStatus = 'error';
    return {
      status: 'error',
      seqs: decision.recordsToApply.map((row) => row.historySeq),
      viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
    };
  }
  return {
    status: lastStatus,
    seqs: decision.recordsToApply.map((row) => row.historySeq),
    viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
  };
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return response.json();
}

function toServerEvents(records) {
  return records.map((record) => ({
    seq: Number(record.historySeq) || 0,
    rec: record,
  }));
}

async function publishServerHistory(records, headSeq) {
  const events = toServerEvents(records);
  const resolvedHead = Number(headSeq) || events.reduce((max, row) => Math.max(max, row.seq), 0);
  await postJson('/__test__/history', {
    chatId: chat.id,
    cursorSessionId: chat.cursorSessionId || 'sess-sync',
    headSeq: resolvedHead,
    events,
  });
  return resolvedHead;
}

function sleepResumeDefer(ms) {
  const shouldHide = hideDuringResumeSleep === true;
  hideDuringResumeSleep = false;
  if (shouldHide) hidden = true;
  const waitMs = Number(ms) || 0;
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

async function runProductionResume(reason = 'visibility') {
  lastHydrationRecords = null;
  lastNotified = false;
  setChatHistorySyncInFlight(chat, true);
  let result;
  try {
    result = await runSdkHistoryConvergence(chat, { reason }, {
      isDocumentHidden: () => hidden,
      getResumeDeferMs: () => resumeDeferMs,
      sleep: sleepResumeDefer,
      yieldToMain: () => Promise.resolve(),
      fetchDelta: () => syncChatHistoryDeltaFromServer(chat.id, chat.cursorSessionId || ''),
      readLocal: () => readSdkChatHistoryStateAsync(chat.id),
      applyCatchUp: applyCatchUpSdkHistoryRecords,
      completeHydration: (target, records) => {
        lastHydrationRecords = records;
        chatTransport.completeSdkHistoryHydration(target, records);
      },
      notifyReachable: () => {
        lastNotified = true;
      },
      getStoreAckSeq: () => getLastAckedSeq(chat.id),
    });
  } catch (err) {
    setChatHistorySyncInFlight(chat, false);
    throw err;
  }
  setChatHistorySyncInFlight(chat, shouldKeepHistorySyncInFlight(result));
  lastStatus = result.status;
  return {
    status: result.status,
    deferReason: result.deferReason || '',
    viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
    hydrationCount: Array.isArray(lastHydrationRecords) ? lastHydrationRecords.length : -1,
    notified: lastNotified,
    storeAckSeq: getLastAckedSeq(chat.id),
    historySyncing: chat._historySyncInFlight === true,
  };
}

function installFetchGate() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    if (url.includes('/api/chats/') && url.includes('/history')) {
      historyFetchCount += 1;
      await fetchGate;
    }
    return originalFetch(input, init);
  };
}

async function boot() {
  try {
    localStorage.setItem('cretli-lang', 'en');
  } catch {
    // ignore
  }
  await initI18n();
  try {
    const auth = await fetch('/api/auth-status').then((response) => response.json());
    setCsrfToken(auth?.csrfToken || 'chat-history-sync-e2e');
  } catch {
    setCsrfToken('chat-history-sync-e2e');
  }
  installFetchGate();
  createView();
  window.__chatSync.seed = async (records) => {
    upsertStore(records);
    serverHeadSeq = store.ackSeq;
    chat._sdkRichView.replayHistoryRecords(records, { instant: true });
    replaceViewAppliedRecords(chat.id, chat, records);
    lastStatus = 'seeded';
  };
  window.__chatSync.hide = () => {
    hidden = true;
  };
  window.__chatSync.show = () => {
    hidden = false;
  };
  window.__chatSync.fetchFromServer = async (records, headSeq) => {
    upsertStore(records);
    serverHeadSeq = Number(headSeq) || store.ackSeq;
    return converge(records);
  };
  window.__chatSync.liveCard = async (record) => {
    upsertStore([record]);
    serverHeadSeq = Math.max(serverHeadSeq, Number(record.historySeq) || 0);
    await applyLiveServerHistoryCards(chat, [record]);
    return getViewAppliedSeq(chat.id, chat);
  };
  window.__chatSync.failNextAppend = () => {
    failNextAppend = true;
  };
  window.__chatSync.failNextApplyEvent = () => {
    failNextApplyEvent = true;
  };
  window.__chatSync.converge = () => converge([]);
  window.__chatSync.destroyView = () => {
    chat._sdkRichView?.destroy?.();
    chat._sdkRichView = null;
    resetViewAppliedState(chat.id, chat);
    mount.replaceChildren();
  };
  window.__chatSync.recreateView = async () => {
    createView();
    return converge(store.events.slice());
  };
  window.__chatSync.replayExisting = (records) => {
    const rows = Array.isArray(records) && records.length > 0 ? records : store.events.slice();
    chat._sdkRichView.replayHistoryRecords(rows, { instant: true });
    replaceViewAppliedRecords(chat.id, chat, rows);
  };
  window.__chatSync.productionSeed = async (records) => {
    const list = Array.isArray(records) ? records : [];
    chat.cursorSessionId = 'sess-sync';
    await replaceSdkChatHistoryRecords(chat.id, chat.cursorSessionId, list);
    const maxSeq = list.reduce((max, row) => Math.max(max, Number(row.historySeq) || 0), 0);
    acknowledgeChatHistorySeq(chat.id, maxSeq);
    await publishServerHistory(list, maxSeq);
    createView();
    chat._sdkRichView.replayHistoryRecords(list, { instant: true });
    replaceViewAppliedRecords(chat.id, chat, list);
    lastStatus = 'seeded';
    return { storeAckSeq: getLastAckedSeq(chat.id), viewAppliedSeq: getViewAppliedSeq(chat.id, chat) };
  };
  window.__chatSync.productionPublish = (records, headSeq) => publishServerHistory(records, headSeq);
  window.__chatSync.productionResume = (reason) => runProductionResume(reason);
  window.__chatSync.setResumeDeferMs = (ms) => {
    resumeDeferMs = Math.max(0, Number(ms) || 0);
    return resumeDeferMs;
  };
  window.__chatSync.hideDuringNextResumeSleep = () => {
    hideDuringResumeSleep = true;
  };
  window.__chatSync.markReplayWait = () => markHistorySyncInFlightForWsReplay(chat, true);
  window.__chatSync.finishReplayWait = (willHttpCatchUp) => (
    clearHistorySyncInFlightAfterWsReplay(chat, willHttpCatchUp === true)
  );
  window.__chatSync.holdFetch = () => {
    fetchGate = new Promise((resolve) => {
      releaseFetchGate = resolve;
    });
  };
  window.__chatSync.releaseFetch = () => {
    releaseFetchGate();
    fetchGate = Promise.resolve();
  };
  window.__chatSync.resetFetchCount = () => {
    historyFetchCount = 0;
  };
  window.__chatSync.liveSdkEvent = (event, roomEventSeq, eventStreamId = 'room-sync') => {
    const streamId = typeof eventStreamId === 'string' && eventStreamId.trim()
      ? eventStreamId.trim()
      : 'room-sync';
    const message = {
      type: 'sdkEvent',
      event,
      eventStreamId: streamId,
      roomEventSeq,
    };
    if (!shouldApplySdkRoomEvent(chat, message)) return false;
    chat._sdkRichView.applyEvent(event, { roomEventSeq, eventStreamId: streamId });
    return true;
  };
  window.__chatSync.swapView = () => {
    resetViewAppliedState(chat.id, chat);
    createView();
    return getViewAppliedSeq(chat.id, chat);
  };
  window.__chatSync.setSession = (sessionKey) => {
    chat.cursorSessionId = String(sessionKey || '');
    return chat.cursorSessionId;
  };
  window.__chatSync.connectTransport = () => {
    HarnessWebSocket.instances.length = 0;
    if (chat.ws) {
      try {
        chat.ws.onclose = null;
        chat.ws.close();
      } catch {
        // ignore
      }
      chat.ws = null;
    }
    chatTransport.ensureChatConnection(chat);
    const socket = HarnessWebSocket.instances.at(-1);
    if (!socket) return false;
    socket.readyState = HarnessWebSocket.OPEN;
    socket.onopen?.();
    return true;
  };
  window.__chatSync.beginHydration = () => {
    beginSdkHistoryHydration(chat);
    chat._sdkEventStreamId = 'room-sync';
  };
  window.__chatSync.replayViaTransport = (event, roomEventSeq) => {
    const socket = chat.ws;
    if (!socket || typeof socket.onmessage !== 'function') return false;
    socket.onmessage({
      data: JSON.stringify({ type: 'replayBatchStart', totalEvents: 1, totalBatches: 1 }),
    });
    socket.onmessage({
      data: JSON.stringify({
        type: 'replayBatch',
        batchIndex: 0,
        totalBatches: 1,
        events: [{
          type: 'sdkEvent',
          eventStreamId: 'room-sync',
          roomEventSeq,
          event,
        }],
      }),
    });
    return Array.isArray(chat._sdkPendingRoomEvents) ? chat._sdkPendingRoomEvents.length : 0;
  };
  window.__chatSync.emitViaTransport = (payload) => {
    const socket = chat.ws;
    if (!socket || typeof socket.onmessage !== 'function') return false;
    socket.onmessage({ data: JSON.stringify(payload) });
    return true;
  };
  window.__chatSync.roomSeq = () => Number(chat._sdkLastRoomEventSeq) || 0;
  window.__chatSync.hasUnrenderedRoomSeq = (seq, streamId = 'room-sync') => {
    const seqs = chat._sdkUnrenderedRoomEventSeqsByStream?.[streamId];
    return Array.isArray(seqs) && seqs.includes(Number(seq));
  };
  window.__chatSync.failNextHistory = () => postJson('/__test__/fail-next-history', {});
  window.__chatSync.partialNextHistory = () => postJson('/__test__/partial-next-history', {});
  window.__chatSync.cardOrder = () => {
    const stream = mount.querySelector('.sdk-rich-stream');
    if (!stream) return [];
    return Array.from(stream.children).map((el) => ({
      text: String(el.innerText || '').replace(/\s+/g, ' ').trim(),
      historySeq: Number(el.historySeq || el.dataset.historySeq || el.dataset.delegationHistorySeq || 0),
      roomEventSeq: Number(el.dataset.roomEventSeq || 0),
      eventStreamId: String(el.dataset.eventStreamId || ''),
    }));
  };
  window.__chatSync.setDraft = (text) => {
    const draft = document.getElementById('draft');
    if (draft) draft.value = String(text || '');
    return draft ? draft.value : '';
  };
  window.__chatSync.getDraft = () => {
    const draft = document.getElementById('draft');
    return draft ? String(draft.value || '') : '';
  };
  window.__chatSync.prepareScrollMount = () => {
    mount.style.flex = 'none';
    mount.style.height = '220px';
    mount.style.maxHeight = '220px';
    mount.style.overflow = 'auto';
    const stream = mount.querySelector('.sdk-rich-stream');
    if (stream && !stream.querySelector('[data-scroll-spacer]')) {
      const spacer = document.createElement('div');
      spacer.dataset.scrollSpacer = '1';
      spacer.style.height = '360px';
      stream.insertBefore(spacer, stream.firstChild);
    }
  };
  window.__chatSync.anchorMetrics = (needle) => {
    const stream = mount.querySelector('.sdk-rich-stream');
    if (!stream) return null;
    const match = Array.from(stream.children).find((el) => (
      String(el.innerText || '').includes(needle)
    ));
    if (!match) return null;
    const mountRect = mount.getBoundingClientRect();
    const rect = match.getBoundingClientRect();
    return {
      top: rect.top - mountRect.top,
      scrollTop: mount.scrollTop,
    };
  };
  window.__chatSync.scrollNeedleIntoView = (needle) => {
    const stream = mount.querySelector('.sdk-rich-stream');
    if (!stream) return false;
    const match = Array.from(stream.children).find((el) => (
      String(el.innerText || '').includes(needle)
    ));
    if (!match) return false;
    match.scrollIntoView({ block: 'center' });
    return true;
  };
  window.__chatSync.ready = true;
}

void boot();
