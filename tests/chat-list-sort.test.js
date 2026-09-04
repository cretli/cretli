import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getChatCreatedAtMs,
  getChatUpdatedAtMs,
  sortChatsByDate,
} from '../app_front/features/chat/chatListSort.js';

test('getChatUpdatedAtMs prefers updatedAt over createdAt', () => {
  const chat = {
    id: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  assert.equal(getChatUpdatedAtMs(chat), new Date('2026-01-02T00:00:00.000Z').getTime());
});

test('sortChatsByDate orders by updatedAt then createdAt without favorites bias', () => {
  const chats = [
    {
      id: 'old-favorite',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T12:00:00.000Z',
    },
    {
      id: 'new-chat',
      createdAt: '2026-01-03T08:00:00.000Z',
      updatedAt: '2026-01-03T08:00:00.000Z',
    },
    {
      id: 'recent-activity',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T18:00:00.000Z',
    },
  ];
  const sorted = sortChatsByDate(chats);
  assert.deepEqual(sorted.map((chat) => chat.id), ['new-chat', 'recent-activity', 'old-favorite']);
});

test('getChatCreatedAtMs returns 0 for invalid values', () => {
  assert.equal(getChatCreatedAtMs({ createdAt: 'invalid' }), 0);
  assert.equal(getChatCreatedAtMs(null), 0);
});
