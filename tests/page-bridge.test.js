import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  bindChatToPageSession,
  executePageCommandForChat,
  getPageSessionForChat,
  registerPageBridge,
  unbindChatPageSession,
  unregisterPageBridge,
} from '../lib/page-bridge.js';
import { buildPageCustomTools, buildChatHostCustomTools } from '../lib/sdk/cursor-agent-sdk-ws.js';

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  onSend = null;

  send(data, callback) {
    this.sent.push(data);
    callback?.();
    this.onSend?.(JSON.parse(data));
  }

  receive(message) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  disconnect() {
    this.readyState = 3;
    this.emit('close');
  }
}

function register(ws, id, permissions) {
  return registerPageBridge(ws, {
    pageSessionId: id,
    permissions,
    url: 'https://docs.example.com/page',
  });
}

test('registers state and binds an active page session to a chat', () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-state', ['context']);
  ws.receive({ type: 'pageState', state: { title: 'Docs', revision: 3 } });

  bindChatToPageSession('chat-state', 'page-state');
  const session = getPageSessionForChat('chat-state');
  assert.equal(session.pageSessionId, 'page-state');
  assert.equal(session.url, 'https://docs.example.com/page');
  assert.deepEqual(session.permissions, ['context']);
  assert.deepEqual(session.latestState, { title: 'Docs', revision: 3 });

  assert.equal(unbindChatPageSession('chat-state'), true);
  assert.equal(getPageSessionForChat('chat-state'), null);
  assert.equal(unregisterPageBridge(ws), true);
  assert.equal(unregisterPageBridge(ws), false);
});

test('enforces command and permission allowlists', () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-permissions', ['context']);
  bindChatToPageSession('chat-permissions', 'page-permissions');

  assert.throws(
    () => executePageCommandForChat('chat-permissions', 'click', { selector: '#save' }),
    /requires permission "interact"/,
  );
  assert.throws(
    () => executePageCommandForChat('chat-permissions', 'readFile', {}),
    /Unsupported page command/,
  );
  assert.throws(
    () => register(new FakeWebSocket(), 'bad-page', ['filesystem']),
    /Unsupported page permission/,
  );

  unregisterPageBridge(ws);
});

test('exposes only permitted tools and blocks mutations in plan mode', () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-tools', ['context', 'dom', 'interact', 'navigate']);
  bindChatToPageSession('chat-tools', 'page-tools');

  const agentTools = buildPageCustomTools('chat-tools', 'agent');
  assert.ok(agentTools.page_get_context);
  assert.ok(agentTools.page_get_dom);
  assert.ok(agentTools.page_click);
  assert.ok(agentTools.page_navigate);
  assert.ok(agentTools.page_press_key);
  assert.ok(agentTools.page_copy_text);
  assert.ok(agentTools.page_highlight);
  assert.ok(agentTools.page_hover);
  assert.ok(agentTools.page_fill_form);
  assert.equal(agentTools.page_get_console, undefined);
  assert.equal(agentTools.page_read_storage, undefined);

  const planTools = buildPageCustomTools('chat-tools', 'plan');
  assert.ok(planTools.page_get_context);
  assert.ok(planTools.page_get_dom);
  assert.equal(planTools.page_click, undefined);
  assert.equal(planTools.page_navigate, undefined);
  assert.equal(planTools.page_press_key, undefined);

  unregisterPageBridge(ws);
});

test('exposes storage read tools in plan mode', () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-storage', ['storage', 'interact']);
  bindChatToPageSession('chat-storage', 'page-storage');

  const planTools = buildPageCustomTools('chat-storage', 'plan');
  assert.ok(planTools.page_read_storage);
  assert.equal(planTools.page_press_key, undefined);
  assert.equal(planTools.page_copy_text, undefined);

  unregisterPageBridge(ws);
});

test('requires storage permission for readStorage command', () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-no-storage', ['context']);
  bindChatToPageSession('chat-no-storage', 'page-no-storage');

  assert.throws(
    () => executePageCommandForChat('chat-no-storage', 'readStorage', { kind: 'local' }),
    /requires permission "storage"/,
  );

  unregisterPageBridge(ws);
});

test('returns an explicit error when chat binding is denied', () => {
  const ws = new FakeWebSocket();
  registerPageBridge(ws, {
    pageSessionId: 'page-denied-bind',
    permissions: ['context'],
    onBindChat: () => {
      throw new Error('workspace mismatch');
    },
  });

  ws.receive({ type: 'bindChat', chatSessionKey: 'chat-denied-bind' });
  const result = JSON.parse(ws.sent.at(-1));
  assert.deepEqual(result, {
    type: 'bindChatResult',
    ok: false,
    chatSessionKey: 'chat-denied-bind',
    error: 'workspace mismatch',
  });
  assert.equal(getPageSessionForChat('chat-denied-bind'), null);

  unregisterPageBridge(ws);
});

test('round-trips a page command result', async () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-roundtrip', ['dom']);
  bindChatToPageSession('chat-roundtrip', 'page-roundtrip');
  ws.onSend = (command) => {
    assert.equal(command.type, 'command');
    assert.equal(command.command, 'queryElements');
    assert.deepEqual(command.args, { selector: '.item' });
    queueMicrotask(() => ws.receive({
      type: 'commandResult',
      id: command.id,
      result: [{ text: 'First' }, { text: 'Second' }],
    }));
  };

  const result = await executePageCommandForChat(
    'chat-roundtrip',
    'queryElements',
    { selector: '.item' },
  );
  assert.deepEqual(result, [{ text: 'First' }, { text: 'Second' }]);

  unregisterPageBridge(ws);
});

test('rejects a command after its timeout', async () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-timeout', ['context']);
  bindChatToPageSession('chat-timeout', 'page-timeout');

  await assert.rejects(
    executePageCommandForChat('chat-timeout', 'getContext', {}, { timeoutMs: 20 }),
    /timed out/,
  );

  unregisterPageBridge(ws);
});

test('rejects pending commands and removes bindings on disconnect', async () => {
  const ws = new FakeWebSocket();
  register(ws, 'page-disconnect', ['navigate']);
  bindChatToPageSession('chat-disconnect', 'page-disconnect');

  const pending = executePageCommandForChat('chat-disconnect', 'reload');
  ws.disconnect();

  await assert.rejects(pending, /disconnected/);
  assert.equal(getPageSessionForChat('chat-disconnect'), null);
  assert.throws(
    () => executePageCommandForChat('chat-disconnect', 'reload'),
    /No page session is bound/,
  );
});

test('buildChatHostCustomTools exposes chat_pin_url in agent mode only', () => {
  const agentTools = buildChatHostCustomTools('chat-pin', 'agent');
  assert.ok(agentTools.chat_pin_url);
  assert.equal(Object.keys(buildChatHostCustomTools('chat-pin', 'plan')).length, 0);
});
