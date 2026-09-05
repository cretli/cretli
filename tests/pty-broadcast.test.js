import assert from 'node:assert/strict';
import { broadcastToClients, flushPtyOutput, queuePtyOutput } from '../lib/pty-broadcast.js';
import { WS_BACKPRESSURE_THRESHOLD_BYTES } from '../lib/sdk/sdk-ws-transport.js';

const sent = [];
const readyClient = {
  readyState: 1,
  bufferedAmount: 0,
  send(msg) {
    sent.push(msg);
  },
};
const backedUpClient = {
  readyState: 1,
  bufferedAmount: WS_BACKPRESSURE_THRESHOLD_BYTES + 1,
  send() {
    throw new Error('should not send under backpressure');
  },
};

broadcastToClients(new Set([readyClient, backedUpClient]), { type: 'output', data: 'x' });
assert.equal(sent.length, 1);
assert.match(sent[0], /"data":"x"/);

const state = { buffer: '' };
queuePtyOutput(new Set([readyClient]), state, 'hello');
assert.equal(state.buffer.endsWith('hello'), true);
flushPtyOutput(new Set([readyClient]), state);
assert.equal(state._flushScheduled, false);
assert.equal(Object.hasOwn(state, '_pendingOutput'), false);

console.log('All pty-broadcast tests passed.');
