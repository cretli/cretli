/**
 * The run-start observer tells keep-alive pings from other turns, fires only
 * after the executor accepted the run, and never breaks a start.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { observeChatRunStarts, startChatRun } from '../lib/chat-run-service.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
const chat = addChat('sess-observer', 'Observer chat', null, '/tmp', 'm', { agentTransport: 'opencode', sdkMode: 'agent' });

const seen = [];
const off = observeChatRunStarts((event) => seen.push(event));
observeChatRunStarts(() => { throw new Error('observer failure must not break the start'); });

await startChatRun({ chatId: chat.id, prompt: 'user turn', mode: 'agent' });
assert.deepEqual(seen, [{ chatId: chat.id, origin: 'other' }]);

// A refused (busy) start is not observed: nothing was accepted.
await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'second', mode: 'agent' }), /busy/i);
assert.equal(seen.length, 1);

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
await startChatRun({ chatId: chat.id, prompt: 'ping', mode: 'agent', deps: { keepAlive: true } });
assert.deepEqual(seen[1], { chatId: chat.id, origin: 'keep_alive' });
off();
console.log('keep-alive-run-observer.test.js OK');

// ---- F1: the ping run is started in the enforced read-only mode.
{
  const { buildKeepAlivePingRun, KEEP_ALIVE_PING_MODE } = await import('../lib/usage/keep-alive-service.js');
  const run = buildKeepAlivePingRun({ chatId: 'child-1', prompt: 'ping', requestId: 'keepalive:d:n:k' });
  assert.equal(run.mode, 'plan');
  assert.equal(KEEP_ALIVE_PING_MODE, 'plan');
  assert.equal(run.chatId, 'child-1');
  assert.equal(run.requestId, 'keepalive:d:n:k');
  assert.equal(run.deps.keepAlive, true);
  assert.equal(run.deps.assignment, undefined);
}
