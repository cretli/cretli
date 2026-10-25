/**
 * Drives the real WebSocket router for chats of an optional plugin (mistral):
 * disabled -> read-only socket answering prompts with a stable sdkError, history
 * untouched; enabled -> the plugin's own handler runs and no read-only socket is attached.
 */
import './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { createSession, setPassword } from '../lib/auth.js';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { getBuiltinHarnessProvider } from '../lib/agent-harness/builtin-harness-providers.ts';
import { resetOptionalHarnessStateForTests, setLoadedOptionalHarnessIds } from '../lib/agent-harness/optional-harness-state.ts';
import { HARNESS_PLUGIN_DISABLED_CODE } from '../lib/agent-harness/disabled-optional-harness.ts';
import { attachWebSocketHandlers } from '../lib/ws/ws-router.ts';

function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

setPassword('test-password-123');
const sessionToken = createSession();
const wss = new EventEmitter();
attachWebSocketHandlers(/** @type {any} */ (wss), /** @type {any} */ ({
  frontHotFallbackEnabled: false,
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  dataDir: ISOLATED_DATA_DIR,
  widgetChatAccessScope: () => true,
}));

/** Sockets opened by the tests; closed at the end so keepalive timers are released. */
const openSockets = [];

/** Connect a fake socket to /ws-agent-sdk the way the server does. */
function connect(sessionKey) {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    closed: null,
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
    ping() {},
    terminate() {},
  });
  openSockets.push(ws);
  wss.emit('connection', ws, {
    url: `/ws-agent-sdk?session=${encodeURIComponent(sessionKey)}`,
    headers: { cookie: `cr_session=${encodeURIComponent(sessionToken)}`, host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return ws;
}

const frame = (type) => Buffer.from(JSON.stringify({ type, text: 'hi' }));

after(() => {
  // A real close tears down the per-socket keepalive interval and the handler's listeners.
  for (const ws of openSockets) ws.emit('close');
  removeIsolatedDataDir();
});

test('disabled plugin chat: prompt frames get sdkError harness_plugin_disabled, nothing throws, nothing is written', async () => {
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds([]);
  const chat = addChat('sess-ws-off', 'Mistral off', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'mistral' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = snapshotTree(ISOLATED_DATA_DIR);

  const ws = connect(chat.cursorSessionId);
  assert.equal(ws.closed, null, 'the socket stays open for read-only use');
  for (const type of ['send', 'queueForceSend']) {
    assert.doesNotThrow(() => ws.emit('message', frame(type)), type);
  }
  ws.emit('message', frame('ping'));
  assert.equal(ws.sent.length, 2);
  assert.ok(ws.sent.every((f) => f.type === 'sdkError' && f.code === HARNESS_PLUGIN_DISABLED_CODE && f.pluginId === 'mistral'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.notDeepEqual(before, {}, 'sanity: snapshot is not empty');
  assert.deepEqual(snapshotTree(ISOLATED_DATA_DIR), before, 'disabled-plugin prompts write nothing');

  // An archived chat of the same disabled plugin still answers with the plugin code.
  updateChat(chat.id, { archived: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const archivedBefore = snapshotTree(ISOLATED_DATA_DIR);
  const ws2 = connect(chat.cursorSessionId);
  assert.doesNotThrow(() => ws2.emit('message', frame('send')));
  assert.equal(ws2.sent[0]?.type, 'sdkError');
  assert.ok(['chat_archived', HARNESS_PLUGIN_DISABLED_CODE].includes(ws2.sent[0]?.code));
  assert.deepEqual(snapshotTree(ISOLATED_DATA_DIR), archivedBefore, 'refused prompts write nothing');
});

test('enabled plugin chat: the plugin handler serves the socket, no read-only socket is attached', async () => {
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds(['mistral']);
  assert.ok(getBuiltinHarnessProvider('mistral'), 'mistral provider is registered by the default load');
  const chat = addChat('sess-ws-on', 'Mistral on', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'mistral' });
  const ws = connect(chat.cursorSessionId);
  ws.emit('message', frame('send'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ws.sent.some((f) => f.code === HARNESS_PLUGIN_DISABLED_CODE), false);
  assert.ok(ws.sent.length > 0, 'the real plugin handler answered the prompt');
});
