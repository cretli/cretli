import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getChatCreatedAtMs,
  getChatUpdatedAtMs,
  sortChatsByDate,
  sortChatsByFavoriteThenDate,
} from '../app_front/features/chat/chatListSort.js';

test('getChatUpdatedAtMs prefers updatedAt over createdAt', () => {
  const chat = {
    id: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  assert.equal(getChatUpdatedAtMs(chat), new Date('2026-01-02T00:00:00.000Z').getTime());
});

test('getChatUpdatedAtMs prefers later local activity over older updatedAt', () => {
  const chat = {
    id: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    _lastOutputAt: new Date('2026-01-04T00:00:00.000Z').getTime(),
  };
  assert.equal(getChatUpdatedAtMs(chat), new Date('2026-01-04T00:00:00.000Z').getTime());
});

test('sortChatsByDate orders by creation date and ignores later activity', () => {
  const chats = [
    {
      id: 'old-but-active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-05T12:00:00.000Z',
      _lastOutputAt: new Date('2026-01-06T00:00:00.000Z').getTime(),
    },
    {
      id: 'new-chat',
      createdAt: '2026-01-03T08:00:00.000Z',
      updatedAt: '2026-01-03T08:00:00.000Z',
    },
    {
      id: 'mid-chat',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T18:00:00.000Z',
    },
  ];
  const sorted = sortChatsByDate(chats);
  assert.deepEqual(sorted.map((chat) => chat.id), ['new-chat', 'mid-chat', 'old-but-active']);
});

test('opening a chat (bumped updatedAt/activity) does not move it to the top', () => {
  const before = [
    {
      id: 'newest',
      createdAt: '2026-01-03T08:00:00.000Z',
      updatedAt: '2026-01-03T08:00:00.000Z',
    },
    {
      id: 'clicked',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  ];
  // Simulate clicking the older chat: local activity and server updatedAt jump to now.
  const after = before.map((chat) =>
    chat.id === 'clicked'
      ? { ...chat, updatedAt: '2026-01-04T00:00:00.000Z', _lastOutputAt: Date.now() }
      : chat
  );
  assert.deepEqual(sortChatsByDate(after).map((chat) => chat.id), ['newest', 'clicked']);
});

test('sortChatsByFavoriteThenDate puts favorites first then creation order', () => {
  const chats = [
    {
      id: 'old-favorite',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-05T12:00:00.000Z',
    },
    {
      id: 'recent',
      createdAt: '2026-01-03T08:00:00.000Z',
      updatedAt: '2026-01-03T08:00:00.000Z',
    },
    {
      id: 'mid-favorite',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T18:00:00.000Z',
    },
  ];
  const favorites = new Set(['old-favorite', 'mid-favorite']);
  const sorted = sortChatsByFavoriteThenDate(chats, (chat) => favorites.has(chat.id));
  assert.deepEqual(sorted.map((chat) => chat.id), ['mid-favorite', 'old-favorite', 'recent']);
});

test('getChatCreatedAtMs returns 0 for invalid values', () => {
  assert.equal(getChatCreatedAtMs({ createdAt: 'invalid' }), 0);
  assert.equal(getChatCreatedAtMs(null), 0);
});
