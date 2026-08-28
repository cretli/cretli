/**
 * OpenCode WS protocol helpers — queue control and room state (no live OpenCode).
 */
import assert from 'node:assert/strict';
import { normalizeSdkMode } from '../lib/sdk/sdk-mode.js';
import { buildSdkRoomStatePayload } from '../lib/sdk/sdk-room-state.js';

/**
 * @param {Array<{ text: string, mode: string }>} pendingPrompts
 * @param {string} target
 * @param {string} sdkMode
 */
function prioritizeQueuedPrompt(pendingPrompts, target, sdkMode) {
  let idx = pendingPrompts.findIndex((item) => item.text === target);
  if (idx < 0) {
    pendingPrompts.push({ text: target, mode: sdkMode });
    idx = pendingPrompts.length - 1;
  }
  const [item] = pendingPrompts.splice(idx, 1);
  pendingPrompts.unshift(item);
}

/**
 * @param {Array<{ text: string, mode: string }>} pendingPrompts
 * @param {string} target
 * @returns {boolean}
 */
function removeQueuedPrompt(pendingPrompts, target) {
  const idx = pendingPrompts.findIndex((item) => item.text === target);
  if (idx < 0) return false;
  pendingPrompts.splice(idx, 1);
  return true;
}

assert.equal(normalizeSdkMode('plan'), 'plan');
assert.equal(normalizeSdkMode('agent'), 'agent');
assert.equal(normalizeSdkMode('invalid'), 'agent');

const queue = [
  { text: 'first', mode: 'agent' },
  { text: 'second', mode: 'agent' },
];
assert.equal(removeQueuedPrompt(queue, 'first'), true);
assert.equal(queue.length, 1);
assert.equal(queue[0].text, 'second');
assert.equal(removeQueuedPrompt(queue, 'missing'), false);

const forceQueue = [{ text: 'a', mode: 'agent' }, { text: 'b', mode: 'agent' }];
prioritizeQueuedPrompt(forceQueue, 'b', 'agent');
assert.equal(forceQueue[0].text, 'b');
assert.equal(forceQueue.length, 2);

prioritizeQueuedPrompt(forceQueue, 'new prompt', 'plan');
assert.equal(forceQueue[0].text, 'new prompt');
assert.equal(forceQueue[0].mode, 'plan');

const roomLike = {
  eventStreamId: 'stream-oc',
  eventSeq: 7,
  busy: false,
  pendingPrompts: forceQueue,
  clients: new Set([{}]),
  transport: 'opencode',
  _pendingOpenCodeQuestions: new Map([['q1', {}]]),
  _pendingOpenCodePermissions: new Map([['p1', {}], ['p2', {}]]),
  lastEventAt: 1234567890,
};
const state = buildSdkRoomStatePayload(roomLike);
assert.equal(state.pendingQuestionCount, 1);
assert.equal(state.pendingPermissionCount, 2);
assert.equal(state.transport, 'opencode');
assert.equal(state.lastEventAt, 1234567890);
assert.equal(state.queuedCount, 3);

console.log('opencode-ws-protocol.test.js OK');
