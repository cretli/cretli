import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadChatsAsync } from '../lib/persist/chats-persist.js';
import { archiveChatFamily, isChatAlreadyArchived } from '../lib/chat-archive-policy.js';
import { sweepIdleChats } from '../lib/chat-auto-archive.js';
import { applyChatRetention } from '../lib/chat-retention.js';
import { runOnChatsBackends, seedChatRows } from './helpers/chats-backends.js';

async function verifyBothAdapters(action, title = 'ordinary') {
  await runOnChatsBackends(async () => {
    const now = Date.now() + 40 * 86400000;
    await seedChatRows([{ id: 'target', title, updatedAt: new Date(Date.now() - 86400000).toISOString() }]);
    const sharedDeps = {
      isChatRunConfirmedIdle: () => true,
      listDelegationsForController: () => [],
      listDelegationsForChat: () => [],
      isDelegationSlotOccupied: () => false,
      isTerminalDelegationStatus: () => true,
    };
    if (action === 'archive') {
      const result = await archiveChatFamily('target', {
        now,
        deps: { ...sharedDeps, hasActiveWorkspaceWatcherCycleChildren: () => false },
      });
      assert.deepEqual(result.archived, ['target']);
    } else if (action === 'auto-archive') {
      const result = await sweepIdleChats({
        now,
        settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days', skipFavorites: false } },
        deps: { ...sharedDeps, loadFavoriteChatIds: () => new Set() },
      });
      assert.deepEqual(result.archived, ['target']);
    } else {
      const result = await applyChatRetention({
        now,
        config: { idleDays: 7, batchLimit: 50 },
        deps: { ...sharedDeps, listTodos: async () => ({ items: [] }), dataDir: '/tmp' },
      });
      assert.equal(result.archived, 1);
    }
    assert.equal(isChatAlreadyArchived((await loadChatsAsync()).find((row) => row.id === 'target')), true);
  });
}

test('archive policy writes through both chat adapters', () => verifyBothAdapters('archive'));
test('automatic archive writes through both chat adapters', () => verifyBothAdapters('auto-archive'));
test('retention writes through both chat adapters', () => verifyBothAdapters('retention', '[Watcher] old run'));
