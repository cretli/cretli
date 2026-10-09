/**
 * Room + chat-run adapter flow for the Mistral harness. The optional SDK is
 * replaced by a scripted fake module (resolved through a loader hook), so the
 * real client, tool loop and room kernel run without a key or network.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

const FAKE_SDK_SOURCE = `
export const script = { mode: 'text', requests: [] };
export class Mistral {
  constructor(options) { this.options = options; }
  chat = {
    stream: async (request, opts) => {
      script.requests.push(request);
      const signal = opts?.fetchOptions?.signal;
      return (async function* events() {
        yield { data: { choices: [{ delta: { content: 'Hello' } }] } };
        if (script.mode === 'hang') {
          await new Promise((resolve) => {
            if (signal?.aborted) resolve();
            signal?.addEventListener('abort', resolve, { once: true });
          });
          return;
        }
        yield { data: { choices: [{ delta: { content: ' world' }, finishReason: 'stop' }], usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } } };
      }());
    },
  };
}
`;
const FAKE_URL = `data:text/javascript,${encodeURIComponent(FAKE_SDK_SOURCE)}`;
const HOOKS_SOURCE = `
export async function resolve(specifier, context, next) {
  if (specifier === '@mistralai/mistralai') return { url: ${JSON.stringify(FAKE_URL)}, shortCircuit: true };
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(HOOKS_SOURCE)}`);

process.env.MISTRAL_API_KEY = 'flow-test-mistral-key-0123456789';

const { addChat } = await import('../lib/persist/chats-persist.js');
const { getChatRunAdapter } = await import('../lib/chat-run-service.js');
const {
  cancelMistralChatRun,
  disposeMistralRoom,
  ensureMistralRoom,
  getMistralRoomDiag,
  handleMistralAgentWebSocket,
  startMistralChatRun,
} = await import('../lib/mistral/mistral-agent-ws.js');
const fake = await import(FAKE_URL);

const deps = { workspaceDirForAgent: () => process.cwd() };

/**
 * @param {string} sessionKey
 * @returns {{ chat: object, sent: Array<Record<string, any>> }}
 */
function setup(sessionKey) {
  const chat = addChat(sessionKey, 'Mistral flow', null, process.cwd(), 'mistral-medium-latest', {
    agentTransport: 'mistral',
    sdkMode: 'agent',
  });
  const ensured = ensureMistralRoom(sessionKey, deps);
  assert.ok(!('error' in ensured), JSON.stringify(ensured));
  const sent = [];
  ensured.room.clients.add({ readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) });
  return { chat, sent };
}

/**
 * @param {Array<Record<string, any>>} sent
 * @param {string} type
 * @param {number} [timeoutMs]
 */
async function waitForEvent(sent, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sent.find((row) => row.type === type);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${type}; saw ${sent.map((row) => row.type).join(',')}`);
}

/**
 * @param {string} sessionKey
 * @returns {Promise<{ sent: Array<Record<string, any>>, ws: { emit: (event: string, data: object) => void } }>}
 */
async function openSocket(sessionKey) {
  addChat(sessionKey, 'Mistral queue', null, process.cwd(), 'mistral-medium-latest', {
    agentTransport: 'mistral',
    sdkMode: 'agent',
  });
  const sent = [];
  const handlers = {};
  const ws = {
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(raw)),
    close() {},
    on(event, handler) { handlers[event] = handler; },
    once(event, handler) { handlers[event] = handler; },
    emit(event, data) { handlers[event]?.(Buffer.from(JSON.stringify(data))); },
  };
  await handleMistralAgentWebSocket(ws, sessionKey, deps);
  return { sent, ws };
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

test('adapter is registered for the mistral transport', () => {
  assert.ok(getChatRunAdapter('mistral'));
});

test('ensureMistralRoom rejects an unknown session', () => {
  const result = ensureMistralRoom('no-such-session', deps);
  assert.equal(result.code, 'invalid_session');
});

test('start streams a reply and finishes with sdkBusy/sdkRunFinished', async () => {
  fake.script.mode = 'text';
  const { chat, sent } = setup('mistral-flow-ok');
  const started = await startMistralChatRun({ chat, prompt: 'hi', mode: 'agent', deps });
  assert.equal(started.accepted, true);
  const finished = await waitForEvent(sent, 'sdkRunFinished');
  assert.equal(finished.status, 'completed');
  const busy = sent.filter((row) => row.type === 'sdkBusy').map((row) => row.busy);
  assert.deepEqual(busy, [true, false]);
  assert.equal(fake.script.requests.at(-1).model, 'mistral-medium-latest');
  const adapter = getChatRunAdapter('mistral');
  assert.equal(adapter.getState({ chat }).busy, false);
  assert.equal(getMistralRoomDiag('mistral-flow-ok').busy, false);
  disposeMistralRoom('mistral-flow-ok');
});

test('cancel aborts a hanging stream and reports a cancelled run', async () => {
  fake.script.mode = 'hang';
  const { chat, sent } = setup('mistral-flow-cancel');
  const started = await startMistralChatRun({ chat, prompt: 'hang', mode: 'agent', deps });
  await waitForEvent(sent, 'sdkPromptStarted');
  const adapter = getChatRunAdapter('mistral');
  assert.equal(adapter.getState({ chat }).busy, true);
  await assert.rejects(
    () => startMistralChatRun({ chat, prompt: 'second', mode: 'agent', deps }),
    (err) => err.code === 'recipient_busy',
  );
  await cancelMistralChatRun({ chat, runId: 'other-run' });
  assert.equal(adapter.getState({ chat }).busy, true);
  await cancelMistralChatRun({ chat, runId: started.runId });
  const finished = await waitForEvent(sent, 'sdkRunFinished');
  assert.equal(finished.status, 'cancelled');
  assert.equal(adapter.getState({ chat }).busy, false);
  disposeMistralRoom('mistral-flow-cancel');
});

test('force-send cancels the running prompt and then runs the queued one', async () => {
  fake.script.mode = 'hang';
  const { sent, ws } = await openSocket('mistral-flow-force');
  ws.emit('message', { type: 'send', text: 'first' });
  await waitForEvent(sent, 'sdkPromptStarted');
  ws.emit('message', { type: 'send', text: 'second' });
  await waitForEvent(sent, 'sdkQueued');
  fake.script.mode = 'text';
  ws.emit('message', { type: 'queueForceSend', text: 'second' });
  await waitUntil(() => sent.filter((row) => row.type === 'sdkRunFinished').length === 2);
  const statuses = sent.filter((row) => row.type === 'sdkRunFinished').map((row) => row.status);
  assert.deepEqual(statuses, ['cancelled', 'completed']);
  assert.match(JSON.stringify(fake.script.requests.at(-1)), /second/);
  disposeMistralRoom('mistral-flow-force');
});

test('a queued prompt can be removed before the running prompt finishes', async () => {
  fake.script.mode = 'hang';
  const { sent, ws } = await openSocket('mistral-flow-remove');
  ws.emit('message', { type: 'send', text: 'first' });
  await waitForEvent(sent, 'sdkPromptStarted');
  ws.emit('message', { type: 'send', text: 'later' });
  await waitForEvent(sent, 'sdkQueued');
  ws.emit('message', { type: 'queueRemove', text: 'later' });
  await waitForEvent(sent, 'sdkQueueRemoved');
  ws.emit('message', { type: 'cancel' });
  await waitForEvent(sent, 'sdkRunFinished');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.filter((row) => row.type === 'sdkPromptStarted').length, 1);
  disposeMistralRoom('mistral-flow-remove');
});
