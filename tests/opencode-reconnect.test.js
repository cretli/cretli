/**
 * OpenCode reconnect — replay guard accepts interactive skill events without duplication.
 */
import assert from 'node:assert/strict';
import {
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

const chat = {};
syncSdkEventStream(chat, 'opencode-stream-1');

const questionReplay = {
  type: 'sdkEvent',
  eventStreamId: 'opencode-stream-1',
  roomEventSeq: 1,
  event: { type: 'opencode_question', requestId: 'q1', questions: [] },
};
const permissionReplay = {
  type: 'sdkEvent',
  eventStreamId: 'opencode-stream-1',
  roomEventSeq: 2,
  event: { type: 'opencode_permission', requestId: 'p1', action: 'write' },
};

assert.equal(shouldApplySdkRoomEvent(chat, questionReplay), true);
assert.equal(shouldApplySdkRoomEvent(chat, permissionReplay), true);
assert.equal(shouldApplySdkRoomEvent(chat, questionReplay), false);
assert.equal(shouldApplySdkRoomEvent(chat, permissionReplay), false);

console.log('opencode-reconnect.test.js OK');
