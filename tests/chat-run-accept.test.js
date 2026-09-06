import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import { acceptRoomPrompt, registerKernelChatRunAdapter } from '../lib/chat-run/kernel-adapter.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
  getMockChatRun,
} from '../lib/chat-run/mock-adapter.js';
import { startChatRun, unregisterChatRunAdapter } from '../lib/chat-run-service.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const chat = addChat('sess-accept', 'Accept chat', null, '/tmp', 'm', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const started = await startChatRun({ chatId: chat.id, prompt: 'hello', mode: 'agent' });
assert.equal(started.accepted, true);
assert.ok(started.runId);
assert.equal(getMockChatRun(chat.id)?.busy, true);

let busyCode = '';
try {
  await startChatRun({ chatId: chat.id, prompt: 'second', mode: 'agent' });
} catch (err) {
  busyCode = err?.code || '';
}
assert.equal(busyCode, 'recipient_busy');

const rooms = new Map();
const room = {
  busy: false,
  currentRun: null,
  startPrompt(prompt, mode) {
    this.busy = true;
    this.currentRun = { id: 'run-1' };
    this.prompt = prompt;
    this.mode = mode;
  },
};
rooms.set('sess-kernel', room);
unregisterChatRunAdapter('codex');
registerKernelChatRunAdapter({
  transport: 'codex',
  rooms,
  ensureRoom: async () => ({ room, chat }),
  waitingForInput: () => false,
});
const accepted = acceptRoomPrompt(room, { prompt: 'p', mode: 'agent', displayText: 'd' }, () => false);
assert.equal(accepted.accepted, true);
assert.equal(accepted.runId, 'run-1');

room.busy = true;
let kernelBusy = '';
try {
  acceptRoomPrompt(room, { prompt: 'x', mode: 'agent' }, () => false);
} catch (err) {
  kernelBusy = err?.code || '';
}
assert.equal(kernelBusy, 'recipient_busy');

console.log('chat-run-accept.test.js OK');
