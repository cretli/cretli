import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQueueControlMessage } from '../lib/agent-harness/queue-controls.js';

function mkRoom(extra = {}) {
  const calls = { cancel: 0, drain: 0 };
  const room = {
    busy: false,
    sdkMode: 'agent',
    pendingPrompts: [{ text: 'a' }, { text: 'b', displayText: 'B' }],
    cancelCurrentRun: async () => { calls.cancel += 1; },
    drainQueue: () => { calls.drain += 1; },
    ...extra,
  };
  return { room, calls };
}

test('queueRemove drops item and broadcasts', () => {
  const { room } = mkRoom();
  const sent = [];
  assert.equal(handleQueueControlMessage(room, { type: 'queueRemove', text: 'B' }, { broadcast: (_r, p) => sent.push(p) }), true);
  assert.deepEqual(room.pendingPrompts.map((i) => i.text), ['a']);
  assert.deepEqual(sent, [{ type: 'sdkQueueRemoved', text: 'B' }]);
});

test('queueForceSend while busy prioritizes and cancels', () => {
  const { room, calls } = mkRoom({ busy: true });
  handleQueueControlMessage(room, { type: 'queueForceSend', text: 'B' }, { broadcast() {} });
  assert.equal(room.pendingPrompts[0].text, 'b');
  assert.equal(calls.cancel, 1);
  assert.equal(calls.drain, 0);
});

test('queueForceSend while idle drains; unknown text is queued first', () => {
  const { room, calls } = mkRoom();
  handleQueueControlMessage(room, { type: 'queueForceSend', text: 'zzz' }, { broadcast() {} });
  assert.equal(room.pendingPrompts[0].text, 'zzz');
  assert.equal(calls.drain, 1);
});

test('ignores other messages', () => {
  const { room } = mkRoom();
  assert.equal(handleQueueControlMessage(room, { type: 'send', text: 'x' }, { broadcast() {} }), false);
});
