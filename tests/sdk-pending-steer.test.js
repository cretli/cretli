import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSteerSdkChat,
  consumePendingSdkSteer,
  rememberPendingSdkSteer,
  settleDeliveredSdkSteer,
  settleRefusedSdkSteer,
} from '../app_front/features/chat/services/sdkPendingSteer.js';
import { handleQueueControlMessage } from '../lib/agent-harness/queue-controls.ts';

function fakeChat() {
  const promoted = [];
  const removed = [];
  return {
    promoted,
    removed,
    _sdkOptimisticSentQueued: [],
    _sdkRichView: {
      promoteQueuedPrompt: (text) => promoted.push(text),
      removeQueuedPrompt: (text) => removed.push(text),
    },
  };
}

test('delivered steer promotes its queued echo once instead of rendering a copy', () => {
  const chat = fakeChat();
  rememberPendingSdkSteer(chat, '  status? ');
  chat._sdkOptimisticSentQueued.push('status?');

  assert.equal(settleDeliveredSdkSteer(chat, 'status?'), true);
  assert.deepEqual(chat.promoted, ['status?']);
  assert.deepEqual(chat._sdkOptimisticSentQueued, []);
  // The ack after the user event (Claude, Codex) must not promote twice.
  assert.equal(settleDeliveredSdkSteer(chat, 'status?'), false);
  assert.deepEqual(chat.promoted, ['status?']);
});

test('a user event that is not a pending steer is left to the normal render path', () => {
  const chat = fakeChat();
  assert.equal(settleDeliveredSdkSteer(chat, 'unrelated'), false);
  assert.deepEqual(chat.promoted, []);
});

test('reverted steer drops the pending entry and keeps the queued echo', () => {
  const chat = fakeChat();
  rememberPendingSdkSteer(chat, 'later');
  chat._sdkOptimisticSentQueued.push('later');

  assert.equal(consumePendingSdkSteer(chat, 'later')?.source, 'direct');
  assert.deepEqual(chat._sdkOptimisticSentQueued, ['later']);
  assert.equal(settleDeliveredSdkSteer(chat, 'later'), false);
  assert.deepEqual(chat.promoted, []);
});

test('refused direct steer removes its queued echo and returns the text', () => {
  const chat = fakeChat();
  rememberPendingSdkSteer(chat, 'go left', 'direct');
  chat._sdkOptimisticSentQueued.push('go left');

  assert.equal(settleRefusedSdkSteer(chat, 'go left'), 'go left');
  assert.deepEqual(chat.removed, ['go left']);
  assert.deepEqual(chat._sdkOptimisticSentQueued, []);
});

test('refused steer from a queued block keeps the block (the server re-queues it)', () => {
  const chat = fakeChat();
  rememberPendingSdkSteer(chat, 'queued text', 'queue');

  assert.equal(settleRefusedSdkSteer(chat, 'queued text'), '');
  assert.deepEqual(chat.removed, []);
  assert.equal(consumePendingSdkSteer(chat, 'queued text'), null);
});

test('steering needs a steer-capable transport with a running turn', () => {
  assert.equal(canSteerSdkChat({ agentTransport: 'codex', _sdkSteerSupported: true, _sdkServerBusy: true }), true);
  assert.equal(canSteerSdkChat({ agentTransport: 'claude', _sdkSteerSupported: true, _sdkServerBusy: false }), false);
  assert.equal(canSteerSdkChat({ agentTransport: 'opencode', _sdkSteerSupported: true, _sdkServerBusy: true }), false);
});

test('queueSteer takes the prompt out of the queue and steers it', () => {
  const steered = [];
  const sent = [];
  const room = {
    busy: true,
    pendingPrompts: [{ text: 'first', mode: 'agent' }, { text: 'second', mode: 'agent' }],
    steerQueuedItem: (item) => steered.push(item.text),
  };
  const handled = handleQueueControlMessage(room, { type: 'queueSteer', text: 'second' }, {
    broadcast: (_room, payload) => sent.push(payload),
  });
  assert.equal(handled, true);
  assert.deepEqual(steered, ['second']);
  assert.deepEqual(room.pendingPrompts.map((item) => item.text), ['first']);
  assert.deepEqual(sent, []);
});

test('queueSteer without a running turn keeps the prompt queued and reports a steer error', () => {
  const sent = [];
  const room = {
    busy: false,
    pendingPrompts: [{ text: 'wait', mode: 'agent' }],
    steerQueuedItem: () => assert.fail('must not steer'),
  };
  handleQueueControlMessage(room, { type: 'queueSteer', text: 'wait' }, {
    broadcast: (_room, payload) => sent.push(payload),
  });
  assert.equal(room.pendingPrompts.length, 1);
  assert.equal(sent[0]?.type, 'sdkSteerError');
  assert.equal(sent[0]?.code, 'steer_no_active_run');
  assert.equal(sent[0]?.text, 'wait');
});
