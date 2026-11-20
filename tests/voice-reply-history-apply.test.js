/**
 * Hydration of a stored `voiceReply` record through the real historyApply:
 * no block is rendered, nothing is spoken, and nothing is handed to the speaker.
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
localStorage.setItem('cretli-voice-read-mode', 'agent');

const { installUserBlocks } = await import('../app_front/features/chat/history/views/userBlocks.js');
const { installHistoryApply } = await import('../app_front/features/chat/history/services/historyApply.js');
const { installSdkEventApply } = await import('../app_front/features/chat/history/services/sdkEventApply.js');
const { createChatSpeaker, setChatSpeakerForTests, getChatSpeaker } = await import('../app_front/features/voice/chatSpeaker.js');

class FakeNode {
  constructor(tag = 'div') {
    this.localName = tag;
    this.children = [];
    this.classList = { values: new Set(), add: (v) => this.classList.values.add(v), remove: (v) => this.classList.values.delete(v) };
    this.childElementCount = 0;
  }
  appendChild(child) { this.children.push(child); this.childElementCount = this.children.length; return child; }
  addEventListener() {}
}
const priorDocument = globalThis.document;
const priorHTMLElement = globalThis.HTMLElement;
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
globalThis.HTMLElement = FakeNode;

const spoken = [];
const speaker = createChatSpeaker({ queue: { enqueue: (t) => spoken.push(t), cancel() {}, isBusy: () => false } });
const handed = [];
const original = speaker.handleVoiceReply;
speaker.handleVoiceReply = (...args) => { handed.push(args); return original.apply(speaker, args); };
setChatSpeakerForTests(speaker);

function makeRv(suppressHistoryPersist) {
  const nodes = [];
  const lines = [];
  const rv = {
    chat: { id: 'hydrate' },
    hooks: { appendPlain() {} },
    stream: { children: nodes },
    queuedUserBlocks: [],
    uiMode: 'full',
    compactStatusLines: new Set(),
    suppressHistoryPersist,
    appendStreamChild(node) { nodes.push(node); },
    lineMeta(...args) { lines.push(args); },
    stopTimeoutProgressSeries() {},
    openLiveTurn() {},
    clearSegmentPointers() {},
    scrollToBottom() {},
    persistThisSdkEvent() {},
    applyMessageSourceActions() {},
    stampElementOrderKey() {},
    findStreamChildByOrderKey: () => null,
    findInsertBeforeChild: () => null,
    mountedHistoryRecordRegistry: { isMounted: () => false, has: () => false, note() {} },
    cloneHistoryRecordForParking: (r) => r,
  };
  installUserBlocks(rv);
  installHistoryApply(rv);
  installSdkEventApply(rv);
  return { rv, nodes, lines };
}

try {
  const record = {
    kind: 'meta',
    variant: 'voiceReply',
    payload: JSON.stringify({ text: 'Stored short version.', turn: 'v1' }),
    historySeq: 42,
  };
  for (const suppress of [true, false]) {
    const { rv, nodes, lines } = makeRv(suppress);
    speaker.issueVoiceTurn('hydrate', 'v1');
    rv.applyHistoryRecord(record);
    assert.equal(nodes.length, 0, `suppress=${suppress}: no block is rendered`);
    assert.equal(lines.length, 0, `suppress=${suppress}: no meta line is rendered`);
  }
  speaker.endAnswer('hydrate');
  assert.deepEqual(spoken, [], 'hydration never speaks a stored reply');
  assert.deepEqual(handed, [], 'hydration never hands a record to the speaker');
} finally {
  setChatSpeakerForTests(null);
  void getChatSpeaker;
  globalThis.document = priorDocument;
  globalThis.HTMLElement = priorHTMLElement;
}

console.log('voice-reply-history-apply: ok');
