/**
 * Async twins of the shared archive gate (lib/chat-archive-policy.js): same contract as the sync functions, with
 * sync or async injected collaborators.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_ARCHIVE_GRACE_MS,
  archiveChatFamilyAsync,
  archiveFamilyMembersAsync,
} from '../lib/chat-archive-policy.js';

const NOW = Date.parse('2026-03-03T12:00:00.000Z');
const OLD_AT = new Date(NOW - CHAT_ARCHIVE_GRACE_MS - 1000).toISOString();
const row = (id, extra = {}) => ({ id, workspaceFolder: '/tmp/cr', updatedAt: OLD_AT, ...extra });

function deps(archived, over = {}) {
  return {
    loadChats: async () => [row('orch'), row('child', { pickPurpose: 'implement' })],
    updateChat: async (id) => { archived.push(id); },
    listDelegationsForController: (id) => (id === 'orch' ? [{ parentChatId: 'orch', childChatId: 'child', status: 'completed' }] : []),
    isChatRunConfirmedIdle: () => true,
    isDelegationSlotOccupied: () => false,
    hasActiveWorkspaceWatcherCycleChildren: () => false,
    ...over,
  };
}

test('archiveChatFamilyAsync archives the child before the orchestrator through async collaborators', async () => {
  const archived = [];
  const out = await archiveChatFamilyAsync('orch', { now: NOW, deps: deps(archived) });
  assert.deepEqual(archived, ['child', 'orch']);
  assert.deepEqual(out, { archived: ['child', 'orch'], skipped: 0, reason: 'archived' });
});

test('archiveChatFamilyAsync keeps the whole family while a cycle child is active, and rejects blank/missing roots', async () => {
  const archived = [];
  const held = await archiveChatFamilyAsync('orch', { now: NOW, deps: deps(archived, { hasActiveWorkspaceWatcherCycleChildren: () => true }) });
  assert.equal(held.reason, 'cycle_children_active');
  assert.deepEqual(archived, []);
  assert.equal((await archiveChatFamilyAsync('', { now: NOW, deps: deps(archived) })).reason, 'no_chat');
  assert.equal((await archiveChatFamilyAsync('ghost', { now: NOW, deps: deps(archived) })).reason, 'chat_missing');
});

test('archiveChatFamilyAsync reports load_failed when the chat read rejects', async () => {
  const out = await archiveChatFamilyAsync('orch', { now: NOW, deps: deps([], { loadChats: async () => { throw new Error('boom'); } }) });
  assert.equal(out.reason, 'load_failed');
  assert.equal(out.skipped, 1);
});

test('archiveFamilyMembersAsync stops before the ancestors when a child write fails', async () => {
  const seen = [];
  const out = await archiveFamilyMembersAsync([row('parent'), row('child')], {
    updateChat: async (id) => { seen.push(id); if (id === 'child') throw new Error('write failed'); },
  });
  assert.deepEqual(seen, ['child']);
  assert.deepEqual(out, { archived: [], skipped: 1 });
});
