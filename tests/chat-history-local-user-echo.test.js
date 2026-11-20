import assert from 'node:assert/strict';
import { installUserBlocks } from '../app_front/features/chat/history/views/userBlocks.js';
import { installHistoryApply } from '../app_front/features/chat/history/services/historyApply.js';
import { installSdkEventApply } from '../app_front/features/chat/history/services/sdkEventApply.js';

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

/** View scope with the real user-block renderer, history apply and SDK event apply. */
function makeRv() {
  const nodes = [];
  const rv = {
    chat: { id: 'echo-test' },
    hooks: { appendPlain() {} },
    stream: { children: nodes },
    queuedUserBlocks: [],
    uiMode: 'full',
    compactStatusLines: new Set(),
    suppressHistoryPersist: true,
    appendStreamChild(node) { nodes.push(node); },
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
  const count = () => nodes.filter((n) => n.localName === 'cr-sdk-block').length;
  return { rv, count };
}

const userEvent = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const local = (text, historySeq) => ({ kind: 'localUser', text, historySeq });
const sdk = (text, historySeq) => ({ kind: 'sdk', event: userEvent(text), historySeq });

try {
  {
    const { rv, count } = makeRv();
    rv.chat._sdkLastLocalUserEcho = 'live';
    rv.renderUserTurn('live');
    rv.applyHistoryRecord(sdk('live', 120));
    const block = rv.stream.children[0];
    const createdAt = '2026-11-05T16:17:11.000Z';
    rv.applyHistoryRecord({ ...local('live', 119), createdAt });
    assert.equal(count(), 1, 'delayed server history adopts the live echo after the SDK echo');
    assert.equal(block.historySeq, 119, 'the original card gets its durable message reference');
    assert.equal(block.createdAt, createdAt);
    rv.applyHistoryRecord(local('live', 119));
    assert.equal(count(), 1, 'repeated catch-up stays idempotent');
    rv.applyHistoryRecord(local('live', 121));
    assert.equal(count(), 2, 'a later saved turn with identical text is preserved');
  }
  {
    const { rv, count } = makeRv();
    rv.chat._sdkLastLocalUserEcho = 'live';
    rv.renderUserTurn('live');
    rv.applyHistoryRecord(local('live', 1));
    rv.applyHistoryRecord(sdk('live', 2));
    assert.equal(count(), 1, 'server history before the SDK echo also keeps one card');
  }
  {
    const { rv, count } = makeRv();
    rv.applyHistoryRecord(local('hello', 1));
    rv.applyHistoryRecord(sdk('hello', 2));
    assert.equal(count(), 1, 'localUser + matching SDK user renders once');
    rv.applyHistoryRecord(sdk('hello', 3));
    assert.equal(count(), 2, 'echo is one-shot');
  }
  {
    const { rv, count } = makeRv();
    rv.applyHistoryRecord(local('hello', 1));
    rv.applyHistoryRecord(sdk('other', 2));
    assert.equal(count(), 2, 'mismatched SDK user renders');
    rv.applyHistoryRecord(sdk('hello', 3));
    assert.equal(count(), 3, 'mismatch clears the echo; later same-text turn renders');
  }
  {
    const { rv, count } = makeRv();
    rv.applyHistoryRecord(local('again', 1));
    rv.applyHistoryRecord(local('again', 2));
    assert.equal(count(), 2, 'distinct localUser records with equal text both render');
    rv.applyHistoryRecord(local('again', 2));
    assert.equal(count(), 2, 'replay of the same record identity does not duplicate');
  }
  {
    // Live path: appendSdkUserPromptLine arms the echo, then appendUserPrompt -> renderUserTurn.
    const { rv, count } = makeRv();
    rv.chat._sdkLastLocalUserEcho = 'live';
    rv.renderUserTurn('live', '', null, '');
    assert.equal(count(), 1, 'live human prompt renders a block even with the echo armed');
    rv.applyHistoryRecord(sdk('live', 1));
    assert.equal(count(), 1, 'matching SDK user event does not add a second block');
    rv.applyHistoryRecord(sdk('live', 2));
    assert.equal(count(), 2, 'echo stays one-shot');
  }
} finally {
  if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  if (priorHTMLElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = priorHTMLElement;
}
console.log('ok');
