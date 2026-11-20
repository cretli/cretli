import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBrowserSessionBinding,
  isBrowserSessionVisibleToChat,
  listBrowserFamilyChatIds,
  resolveChatBindingOnFamily,
} from '../lib/browser/chat-browser-scope.js';

const chats = [
  { id: 'root' },
  { id: 'parent', forkParentChatId: 'root' },
  { id: 'child', forkParentChatId: 'parent' },
  { id: 'sibling', forkParentChatId: 'root' },
];

test('listBrowserFamilyChatIds walks forkParentChatId upward', () => {
  assert.deepEqual(listBrowserFamilyChatIds('child', chats), ['child', 'parent', 'root']);
});

test('isBrowserSessionVisibleToChat allows ancestor-bound sessions only', () => {
  assert.equal(isBrowserSessionVisibleToChat('child', 'parent', chats), true);
  assert.equal(isBrowserSessionVisibleToChat('child', 'child', chats), true);
  assert.equal(isBrowserSessionVisibleToChat('child', 'sibling', chats), false);
  assert.equal(isBrowserSessionVisibleToChat('child', '', chats), true);
});

test('classifyBrowserSessionBinding labels own, ancestor and unbound', () => {
  assert.deepEqual(classifyBrowserSessionBinding('child', 'child', chats), {
    binding: 'own',
    ancestorChatId: null,
  });
  assert.deepEqual(classifyBrowserSessionBinding('child', 'parent', chats), {
    binding: 'ancestor',
    ancestorChatId: 'parent',
  });
  assert.deepEqual(classifyBrowserSessionBinding('child', null, chats), {
    binding: 'unbound',
    ancestorChatId: null,
  });
  assert.equal(classifyBrowserSessionBinding('child', 'sibling', chats), null);
});

test('resolveChatBindingOnFamily prefers the nearest bound ancestor', () => {
  const manager = {
    resolveChatBinding(chatId) {
      if (chatId === 'parent') return { browserSessionId: 'sess-parent', chatId: 'parent' };
      return null;
    },
  };
  const resolved = resolveChatBindingOnFamily(manager, 'child', chats);
  assert.equal(resolved?.browserSessionId, 'sess-parent');
  assert.equal(resolved?.fromChatId, 'parent');
});
