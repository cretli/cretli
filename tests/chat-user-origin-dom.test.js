import assert from 'node:assert/strict';
import { installUserBlocks } from '../app_front/features/chat/history/views/userBlocks.js';

class FakeNode {
  constructor(tag = 'div') {
    this.localName = tag;
    this.children = [];
    this.classList = { values: new Set(), add: (value) => this.classList.values.add(value) };
    this.childElementCount = 0;
  }
  appendChild(child) { this.children.push(child); this.childElementCount = this.children.length; return child; }
  addEventListener() {}
}

const priorDocument = globalThis.document;
const priorHTMLElement = globalThis.HTMLElement;
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
globalThis.HTMLElement = FakeNode;
try {
  const nodes = [];
  const rv = {
    chat: { id: 'origin-test', delegationParentChatId: 'parent-chat', pickPurpose: 'watcher-orchestrator' },
    hooks: {},
    stream: { children: nodes },
    renderedRecordHistorySeq: 12,
    renderedRecordCreatedAt: '2026-11-04T10:00:00.000Z',
    uiMode: 'full',
    compactStatusLines: new Set(),
    appendStreamChild(node) { nodes.push(node); },
    scrollToBottom() {},
    applyMessageSourceActions() {},
  };
  installUserBlocks(rv);
  rv.renderUserTurn('hello', '', { kind: 'operator', clientName: 'Claude' }, 'request-1');
  const block = nodes.find((node) => node.localName === 'cr-sdk-block');
  assert.ok(block, 'the origin message is rendered as a DOM block');
  assert.equal(block.label, 'Operator · Claude');
  assert.equal(block.originRequestId, 'request-1');
  assert.ok(block.classList.values.has('sdk-rich-block--origin-operator'));
  rv.renderUserTurn('hello', '', { kind: 'operator', clientName: 'Claude' });
  assert.equal(nodes.filter((node) => node.localName === 'cr-sdk-block').length, 2, 'equal operator messages remain separate turns');
  rv.renderUserTurn('ordinary text');
  const ordinary = nodes.filter((node) => node.localName === 'cr-sdk-block')[2];
  assert.equal(ordinary.label, 'You');
  assert.equal(ordinary.classList.values.size, 0);
  rv.renderUserTurn('delegated task', '', {
    kind: 'delegation', sourceChatId: 'parent-1', sourceChatTitle: 'Parent task',
  });
  const delegated = nodes.filter((node) => node.localName === 'cr-sdk-block')[3];
  assert.equal(delegated.label, 'Parent chat · Parent task');
  assert.equal(delegated.labelHref, '?chat=parent-1');
  assert.ok(delegated.classList.values.has('sdk-rich-block--origin-delegation'));
  rv.renderUserTurn('Child reply', '', { kind: 'mailbox', sourceChatId: 'child-1', sourceChatTitle: 'Executor' });
  const reply = nodes.filter((node) => node.localName === 'cr-sdk-block')[4];
  assert.equal(reply.label, 'Child chat · Executor');
  rv.renderUserTurn('scheduled', '', { kind: 'system', subtype: 'wakeup' });
  const wakeup = nodes.filter((node) => node.localName === 'cr-sdk-block')[5];
  assert.equal(wakeup.label, 'Cretli wake-up');
  for (const phrase of ['Child reply', 'Task from parent', '[Watcher maintenance]', '[AUTO-RESUME] continue', '[AUTO-WAKEUP] check']) {
    rv.renderUserTurn(phrase);
    const human = nodes.filter((node) => node.localName === 'cr-sdk-block').at(-1);
    assert.equal(human.label, 'You');
    assert.equal(human.children[0].innerHTML, phrase);
  }
  rv.renderUserTurn('seeded task', '', { kind: 'delegation', sourceChatId: 'parent-chat' });
  assert.equal(nodes.filter((node) => node.localName === 'cr-sdk-block').at(-1).label, 'Parent chat');
  rv.renderUserTurn('watcher task', '', { kind: 'watcher' });
  assert.equal(nodes.filter((node) => node.localName === 'cr-sdk-block').at(-1).label, 'Watcher');
} finally {
  if (priorDocument === undefined) delete globalThis.document;
  else globalThis.document = priorDocument;
  if (priorHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = priorHTMLElement;
}
