import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { guardArchivedChatSocket, rejectArchivedRoomPrompt } from '../lib/chat-message-guard.js';
import { registerChatRunAdapter, startChatRun, withChatRunStartLock } from '../lib/chat-run-service.js';
import { createClaudePromptRunner } from '../lib/claude/claude-agent-ws.js';
import { registerKernelChatRunAdapter } from '../lib/chat-run/kernel-adapter.js';

const starts = [];
registerChatRunAdapter({
  transport: 'codex',
  getState: () => ({ busy: false, runId: '' }),
  cancel: async () => {},
  start: async input => { starts.push(input.prompt); return { accepted: true, runId: 'run-test' }; },
});

const chat = addChat('sess-read-only', 'Read only', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'codex' });
const socket = Object.assign(new EventEmitter(), {
  readyState: 1, sent: [], send(payload) { this.sent.push(JSON.parse(payload)); },
});
const received = [];
guardArchivedChatSocket(socket, chat.cursorSessionId);
socket.on('message', raw => received.push(JSON.parse(String(raw)).type));
const emit = type => socket.emit('message', Buffer.from(JSON.stringify({ type, text: 'Continue' })));

try {
  emit('send');
  assert.deepEqual(received, ['send']);
  updateChat(chat.id, { archived: true });
  for (const type of ['send', 'queueForceSend']) emit(type);
  assert.deepEqual(received, ['send'], 'archived prompt frames never reach harness listeners');
  assert.equal(socket.sent.length, 2);
  assert.ok(socket.sent.every(payload => payload.type === 'sdkError' && payload.code === 'chat_archived'));
  for (const type of ['ping', 'cancel', 'queueRemove']) emit(type);
  assert.deepEqual(received, ['send', 'ping', 'cancel', 'queueRemove']);

  await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'Continue' }), { code: 'chat_archived' });
  assert.deepEqual(starts, [], 'server-side starts do not reach the adapter');
  const broadcasts = [];
  const room = { sessionKey: chat.cursorSessionId, busy: false, pendingPrompts: [] };
  assert.equal(rejectArchivedRoomPrompt(room, (_room, payload) => broadcasts.push(payload)), true);
  let persistedPrompts = 0;
  const runner = createClaudePromptRunner({
    room,
    hooks: {
      broadcast: payload => broadcasts.push(payload),
      persistRoomEvent: () => { persistedPrompts += 1; },
      loadSdk: async () => { throw new Error('Archived prompts must not load a model SDK'); },
    },
  });
  await runner.startPrompt('Queued continuation', 'agent', true);
  assert.equal(persistedPrompts, 0, 'an archived queued prompt never enters history');
  assert.equal(room.busy, false);
  assert.deepEqual(room.pendingPrompts, []);

  updateChat(chat.id, { archived: false });
  emit('send');
  assert.equal(received.at(-1), 'send');
  await startChatRun({ chatId: chat.id, prompt: 'Restored' });
  assert.deepEqual(starts, ['Restored']);

  let unlock;
  let locked;
  const entered = new Promise(resolve => { locked = resolve; });
  const held = withChatRunStartLock(chat.id, async () => {
    locked();
    await new Promise(resolve => { unlock = resolve; });
  });
  await entered;
  const waiting = startChatRun({ chatId: chat.id, prompt: 'Archived while waiting' });
  const refusal = assert.rejects(waiting, { code: 'chat_archived' });
  updateChat(chat.id, { archived: true });
  unlock();
  await held;
  await refusal;
  assert.deepEqual(starts, ['Restored'], 'archive state is reloaded after the start lock');

  const initializingChat = addChat('sess-initializing', 'Initializing', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'qwen' });
  let finishInitialization;
  let notifyInitializing;
  const initializing = new Promise(resolve => { notifyInitializing = resolve; });
  let initializedStarts = 0;
  registerKernelChatRunAdapter({
    transport: 'qwen',
    rooms: new Map(),
    ensureRoom: async () => {
      notifyInitializing();
      await new Promise(resolve => { finishInitialization = resolve; });
      return { room: { sessionKey: initializingChat.cursorSessionId, startPrompt: () => { initializedStarts += 1; } } };
    },
  });
  const initializingRun = startChatRun({ chatId: initializingChat.id, prompt: 'Archived while initializing' });
  const initializingRefusal = assert.rejects(initializingRun, { code: 'chat_archived' });
  await initializing;
  updateChat(initializingChat.id, { archived: true });
  finishInitialization();
  await initializingRefusal;
  assert.equal(initializedStarts, 0, 'archive state is reloaded after asynchronous room initialization');
  console.log('chat-message-guard.test.js OK');
} finally {
  removeIsolatedDataDir();
}
