import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildSdkHelloPayload,
  scheduleSdkWsEventLogReplay,
} from '../lib/sdk/sdk-ws-handshake.js';

/**
 * @param {number} port
 * @returns {Promise<{ socket: WebSocket, buffer: Record<string, unknown>[] }>}
 */
function connectCollectingClient(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    /** @type {Record<string, unknown>[]} */
    const buffer = [];
    socket.on('message', (raw) => {
      try {
        buffer.push(JSON.parse(String(raw)));
      } catch {
        // ignore malformed frames in this harness
      }
    });
    socket.once('open', () => resolve({ socket, buffer }));
    socket.once('error', reject);
  });
}

/**
 * @param {Record<string, unknown>[]} buffer
 * @param {(payload: Record<string, unknown>) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, unknown>>}
 */
function waitInBuffer(buffer, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const hit = buffer.find(predicate);
      if (hit) {
        resolve(hit);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for WebSocket message'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => wss.once('listening', resolve));
const port = /** @type {import('net').AddressInfo} */ (wss.address()).port;
const sessionKey = 'e2e-session-key';
const eventLog = Array.from({ length: 12 }, (_, index) => ({
  seq: index + 1,
  at: Date.now(),
  payload: {
    type: 'sdkEvent',
    roomEventSeq: index + 1,
    event: { type: 'assistant', message: { content: [{ text: `evt-${index + 1}` }] } },
  },
}));

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify(
      buildSdkHelloPayload({
        sessionKey,
        agentId: 'agent-e2e',
        modelId: 'composer-2',
        sdkMode: 'agent',
        eventStreamId: 'stream-e2e',
        busy: false,
        queuedPrompts: [],
      })
    )
  );
  scheduleSdkWsEventLogReplay({
    entries: eventLog,
    send: (payload) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    },
    batchDelayMs: 0,
  });
});

const { socket: client, buffer } = await connectCollectingClient(port);

const hello = await waitInBuffer(buffer, (payload) => payload.type === 'hello');
assert.equal(hello.sessionKey, sessionKey);
assert.equal(hello.transport, 'cursor-sdk');

const replayStart = await waitInBuffer(buffer, (payload) => payload.type === 'replayBatchStart');
assert.equal(replayStart.totalEvents, 12);

const replayBatch = await waitInBuffer(buffer, (payload) => payload.type === 'replayBatch');
assert.equal(replayBatch.batchIndex, 0);
assert.ok(Array.isArray(replayBatch.events));
assert.ok(replayBatch.events.length > 0);

const replayEnd = await waitInBuffer(buffer, (payload) => payload.type === 'replayBatchEnd');
assert.equal(replayEnd.totalEvents, 12);

client.close();
await new Promise((resolve) => wss.close(resolve));

console.log('All sdk-ws-handshake-e2e tests passed.');
