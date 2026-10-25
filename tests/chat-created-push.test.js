/**
 * Behavior tests for the shared "new chat created" push and for the single
 * `addChat` hook that fires it (temporary fork chats must stay silent).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyChatCreated } from '../lib/chat-created-push.js';
import { buildChatCreatedPushData } from '../lib/push-inbox-logic.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatsPersistSource = readFileSync(path.join(root, 'lib', 'persist', 'chats-persist.js'), 'utf8');

/**
 * @returns {{ broadcasts: object[], deps: object }}
 */
function makeDeps(overrides = {}) {
  const broadcasts = [];
  const deps = {
    isPushAvailable: () => true,
    hasPushSubscriptions: () => true,
    broadcastPush: async (payload) => {
      broadcasts.push(payload);
    },
    ...overrides,
  };
  return { broadcasts, deps };
}

// A missing chat id never schedules anything.
{
  const { broadcasts, deps } = makeDeps();
  assert.equal(notifyChatCreated({}, deps), false);
  assert.equal(notifyChatCreated({ chatId: '   ' }, deps), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broadcasts.length, 0);
}

// Availability is checked before touching subscriptions.
{
  const { broadcasts, deps } = makeDeps({ isPushAvailable: () => false });
  assert.equal(notifyChatCreated({ chatId: 'c1' }, deps), false);
  assert.equal(broadcasts.length, 0);
}

// No subscription: no broadcast.
{
  const { broadcasts, deps } = makeDeps({ hasPushSubscriptions: () => false });
  assert.equal(notifyChatCreated({ chatId: 'c1' }, deps), false);
  assert.equal(broadcasts.length, 0);
}

// A real new chat broadcasts one payload with a stable per-chat event id.
{
  const { broadcasts, deps } = makeDeps();
  assert.equal(notifyChatCreated({ chatId: 'c1', chatTitle: 'My chat' }, deps), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broadcasts.length, 1);
  const payload = broadcasts[0];
  assert.equal(payload.data.type, 'chat-created');
  assert.equal(payload.data.chatId, 'c1');
  assert.equal(payload.data.title, 'My chat');
  assert.equal(payload.data.eventId, 'chat-created:c1');
  assert.equal(payload.tag, 'cretli-new-chat-c1');
  assert.match(payload.data.url, /panel=chat&chat=c1/);
  assert.match(payload.body, /My chat/);
}

// A throwing broadcast never escapes into chat creation.
{
  const { deps } = makeDeps({
    broadcastPush: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(notifyChatCreated({ chatId: 'c1' }, deps), true);
  await new Promise((resolve) => setImmediate(resolve));
}

// The URL falls back to the chat id when no title was provided.
assert.equal(
  buildChatCreatedPushData({ chatId: 'c9' }).url,
  '/?source=pwa&panel=chat&chat=c9'
);
assert.equal(buildChatCreatedPushData({ chatId: 'c9' }).title, 'c9');

// The creation hook lives in addChat and skips temporary fork chats.
assert.match(chatsPersistSource, /import \{ notifyChatCreated \} from '\.\.\/chat-created-push\.js'/);
assert.match(chatsPersistSource, /notifyChatCreated\(\{ chatId: entry\.id, chatTitle: entry\.title \}\)/);
assert.match(chatsPersistSource, /entry\.isTemporary !== true/);

console.log('chat-created-push.test.js: ok');
