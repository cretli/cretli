/**
 * push-inbox-logic: eventId production and trim survival of eventId and the
 * collapsed NotificationOptions (vibrate/silent).
 */
import assert from 'node:assert/strict';
import {
  buildAgentFinishedPushData,
  trimWebPushNotificationPayload,
} from '../lib/push-inbox-logic.js';

// The needs-input eventId is asserted in tests/agent-needs-input-push.test.js.

// --- finished eventId comes from a string runId only ------------------------
assert.equal(buildAgentFinishedPushData({ chatId: 'c', runId: 'run-1' }).eventId, 'run-1');
assert.equal('eventId' in buildAgentFinishedPushData({ chatId: 'c', runId: 123 }), false);
assert.equal('eventId' in buildAgentFinishedPushData({ chatId: 'c' }), false);
assert.equal('eventId' in buildAgentFinishedPushData({ chatId: 'c', runId: '   ' }), false);

// --- trim keeps eventId and options -----------------------------------------
{
  const trimmed = trimWebPushNotificationPayload({
    title: 'T',
    body: 'B',
    tag: 'cretli-c',
    vibrate: [10, 20],
    silent: false,
    data: {
      type: 'agent-finished',
      chatId: 'c',
      url: '/x',
      at: 5,
      eventId: 'run-9',
      status: 'done',
    },
  });
  assert.equal(trimmed.data.eventId, 'run-9');
  assert.deepEqual(trimmed.vibrate, [10, 20]);
  assert.equal('silent' in trimmed, false, 'silent:false is not a new option');
}

// Explicit empty vibrate marker survives.
{
  const trimmed = trimWebPushNotificationPayload({
    title: 'T',
    vibrate: [],
    data: { type: 'x', chatId: 'c' },
  });
  assert.deepEqual(trimmed.vibrate, []);
}

// silent:true survives.
{
  const trimmed = trimWebPushNotificationPayload({
    title: 'T',
    silent: true,
    data: { type: 'x', chatId: 'c' },
  });
  assert.equal(trimmed.silent, true);
  assert.equal('vibrate' in trimmed, false);
}

// A non-array vibrate (e.g. a preset string) is not a NotificationOption here.
{
  const trimmed = trimWebPushNotificationPayload({
    title: 'T',
    vibrate: 'short',
    data: { type: 'x', chatId: 'c' },
  });
  assert.equal('vibrate' in trimmed, false);
}

// --- hard floor keeps eventId and options, stays <= 3000 B -------------------
{
  const hugeUrl = `https://example.test/${'ż'.repeat(20000)}`;
  const trimmed = trimWebPushNotificationPayload({
    title: 'x'.repeat(5000),
    body: 'y'.repeat(5000),
    tag: `cretli-${'ą'.repeat(2000)}`,
    vibrate: [],
    data: {
      type: 'agent-finished',
      chatId: 'chat-1',
      url: hugeUrl,
      at: 5,
      eventId: 'run-9',
      snippet: 'z'.repeat(4000),
    },
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= 3000,
    'trimmed payload must always stay within the byte limit'
  );
  assert.equal(trimmed.data.type, 'agent-finished');
  assert.equal(trimmed.data.chatId, 'chat-1');
  assert.equal(trimmed.data.eventId, 'run-9', 'eventId survives the hard floor');
  assert.deepEqual(trimmed.vibrate, []);
}

// --- hard floor terminates for a huge eventId/chatId/type --------------------
{
  const trimmed = trimWebPushNotificationPayload({
    title: 'x'.repeat(5000),
    body: 'y'.repeat(5000),
    vibrate: [],
    data: {
      type: 'agent-finished',
      chatId: 'c'.repeat(4000),
      url: `https://example.test/${'ż'.repeat(20000)}`,
      at: 5,
      eventId: `run-${'e'.repeat(4000)}`,
      snippet: 'z'.repeat(4000),
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= 3000);
  assert.equal(typeof trimmed.data.eventId, 'string');
  assert.ok(trimmed.data.eventId.length > 0, 'eventId is truncated but still present');
  assert.deepEqual(trimmed.vibrate, []);
}

console.log('push-trim-options.test.js: ok');
