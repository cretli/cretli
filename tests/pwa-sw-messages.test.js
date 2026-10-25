import assert from 'node:assert/strict';
import {
  SW_OPEN_CHAT_MESSAGE,
  parseServiceWorkerOpenChatMessage,
  readNotificationBootInfo,
} from '../app_front/features/pwa/swMessages.js';

assert.equal(SW_OPEN_CHAT_MESSAGE, 'open-chat');

assert.deepEqual(
  parseServiceWorkerOpenChatMessage({
    type: 'open-chat',
    chatId: 'chat-1',
    url: '/?source=pwa&panel=chat&chat=chat-1',
  }),
  { chatId: 'chat-1', url: '/?source=pwa&panel=chat&chat=chat-1' }
);
assert.deepEqual(
  parseServiceWorkerOpenChatMessage({ type: 'open-chat', chatId: '  chat-2  ' }),
  { chatId: 'chat-2', url: '' }
);
assert.equal(parseServiceWorkerOpenChatMessage({ type: 'SW_UPDATED' }), null);
assert.equal(parseServiceWorkerOpenChatMessage({ type: 'open-chat' }), null);
assert.equal(parseServiceWorkerOpenChatMessage({ type: 'open-chat', chatId: '   ' }), null);
assert.equal(parseServiceWorkerOpenChatMessage(null), null);
assert.equal(parseServiceWorkerOpenChatMessage('open-chat'), null);

assert.deepEqual(
  readNotificationBootInfo('?source=pwa&panel=chat&chat=chat-9'),
  { notification: true, chatId: 'chat-9' }
);
assert.deepEqual(readNotificationBootInfo('?source=pwa&panel=chat'), {
  notification: true,
  chatId: '',
});
assert.equal(readNotificationBootInfo('?panel=chat&chat=chat-9'), null);
assert.equal(readNotificationBootInfo(''), null);

console.log('All pwa-sw-messages tests passed.');
