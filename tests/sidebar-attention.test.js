import test from 'node:test';
import assert from 'node:assert/strict';
import { countUnseenFinishedChats } from '../app_front/features/sidebar/sidebarAttention.js';

const finished = (extra = {}) => ({ lastFinishedAt: '2026-11-24T10:00:00Z', ...extra });

test('counts finished chats that were not opened since', () => {
  const chats = [
    { id: 'a', ...finished() },
    { id: 'b', ...finished({ lastSeenAt: '2026-11-24T11:00:00Z' }) },
    { id: 'c', ...finished({ lastSeenAt: '2026-11-24T09:00:00Z' }) },
    { id: 'd' },
  ];
  assert.equal(countUnseenFinishedChats(chats, null), 2);
});

test('ignores the chat on screen, delegation children and archived chats', () => {
  const chats = [
    { id: 'a', ...finished() },
    { id: 'b', ...finished({ delegationParentChatId: 'a' }) },
    { id: 'c', ...finished({ archivedAt: '2026-11-24T12:00:00Z' }) },
    { id: 'd', ...finished() },
  ];
  assert.equal(countUnseenFinishedChats(chats, 'a'), 1);
});
