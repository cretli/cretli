import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSdkPromptLifecycleMessage } from '../app_front/features/chat/transport/sdkPromptLifecycle.js';

test('room state hydration restores the prompt suggestion chip', () => {
  const received = [];
  const chat = { _promptSuggestionChip: { set: (suggestion) => received.push(suggestion) } };
  const handled = handleSdkPromptLifecycleMessage(chat, {
    type: 'sdkRoomState',
    promptSuggestion: { text: 'Continue with a test', turnRunId: 'run-2' },
  }, {});
  assert.equal(handled, false);
  assert.deepEqual(received, [{ text: 'Continue with a test', turnRunId: 'run-2' }]);
});

test('live origin prompt carries its identity to the rich history view', () => {
  const chat = { id: 'chat-1' };
  const calls = [];
  const helpers = {
    appendSdkUserPromptLine: (...args) => calls.push(['append', ...args]),
    consumeOptimisticSdkPrompt: () => false,
    consumeOptimisticSdkQueuedPrompt: () => false,
    logSdkVerbose: () => {},
    setAgentState: (...args) => calls.push(['state', ...args]),
  };
  const origin = { kind: 'operator', clientId: 'mcp-1', clientName: 'Claude' };
  const handled = handleSdkPromptLifecycleMessage(chat, {
    type: 'sdkPromptStarted',
    text: 'shown prompt',
    origin,
    requestId: 'request-1',
    remaining: 0,
  }, helpers);

  assert.equal(handled, true);
  assert.deepEqual(calls[0], ['append', chat, 'shown prompt', { origin, requestId: 'request-1' }]);
  assert.equal(chat._sdkServerBusy, true);
});

test('ordinary optimistic prompts still use the existing dedupe path', () => {
  const chat = { id: 'chat-2' };
  const calls = [];
  const helpers = {
    appendSdkUserPromptLine: (...args) => calls.push(['append', ...args]),
    consumeOptimisticSdkPrompt: () => true,
    consumeOptimisticSdkQueuedPrompt: () => false,
    logSdkVerbose: () => {},
    setAgentState: (...args) => calls.push(['state', ...args]),
  };
  assert.equal(handleSdkPromptLifecycleMessage(chat, { type: 'sdkPromptStarted', text: 'ordinary' }, helpers), true);
  assert.deepEqual(calls, [['state', chat, 'active']]);
});

test('queued origin prompt is promoted with its origin and request id, leaving one card', async () => {
  const { installUserBlocks } = await import('../app_front/features/chat/history/views/userBlocks.js');
  const { installViewApiHead } = await import('../app_front/features/chat/history/services/viewApiHead.js');
  class FakeNode {
    constructor(tag = 'div') {
      this.localName = tag;
      this.children = [];
      this.classList = { values: new Set(), add: (v) => this.classList.values.add(v), remove: (v) => this.classList.values.delete(v) };
    }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener() {}
  }
  const priorDocument = globalThis.document;
  const priorHTMLElement = globalThis.HTMLElement;
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  globalThis.HTMLElement = FakeNode;
  try {
    const nodes = [];
    const chat = { id: 'queue-seq' };
    const rv = {
      chat,
      mountEl: new FakeNode(),
      hooks: { appendPlain() {} },
      stream: { children: nodes },
      uiMode: 'full',
      compactStatusLines: new Set(),
      appendStreamChild(node) { nodes.push(node); },
      scrollToBottom() {},
      applyMessageSourceActions() {},
      attachQueuedBlockActions(block) { block.classList.add('sdk-rich-block--queued'); block.queued = true; },
    };
    installUserBlocks(rv);
    const view = installViewApiHead(rv) || rv;
    const api = rv.viewPublicApi || view.viewPublicApi || view;
    const origin = { kind: 'operator', clientName: 'Claude' };
    api.appendQueuedPrompt('queued task', 1, { silent: true });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].label.startsWith('You'), true);
    chat._sdkRichView = api;
    const helpers = {
      appendSdkUserPromptLine: () => assert.fail('queued promotion must not append a second card'),
      consumeOptimisticSdkPrompt: () => false,
      consumeOptimisticSdkQueuedPrompt: () => false,
      promoteSdkQueuedPromptLine: (c, text, opts) => c._sdkRichView.promoteQueuedPrompt(text, opts),
      logSdkVerbose: () => {},
      setAgentState: () => {},
    };
    handleSdkPromptLifecycleMessage(chat, {
      type: 'sdkPromptStarted', text: 'queued task', fromQueue: true, origin, requestId: 'req-q', remaining: 0,
    }, helpers);
    assert.equal(nodes.length, 1, 'still exactly one card');
    assert.equal(nodes[0].label, 'Operator · Claude');
    assert.equal(nodes[0].originRequestId, 'req-q');
    assert.ok(nodes[0].classList.values.has('sdk-rich-block--origin-operator'));
    // The later localUser record matches this card by requestId (historyApply liveMatch), so no duplicate is rendered.
    assert.equal(nodes.find((n) => n?.originRequestId === 'req-q'), nodes[0]);
  } finally {
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    if (priorHTMLElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = priorHTMLElement;
  }
});
