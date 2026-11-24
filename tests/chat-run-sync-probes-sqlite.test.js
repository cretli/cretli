/**
 * The synchronous run probes (watcher, delegation, keep-alive, update gate) must work while the SQLite chats runtime
 * is active: they read the in-process row index fed by the facade, never the legacy chats store, so they never
 * throw `chats_sync_api_unavailable`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runOnChatsBackends } from './helpers/chats-backends.js';
import { addChatAsync, removeChatAsync } from '../lib/persist/chats-persist.js';
import {
  countActiveChatRuns,
  getChatRunState,
  lookupChatRunRequest,
  probeChatRunLiveness,
  registerChatRunAdapter,
  unregisterChatRunAdapter,
} from '../lib/chat-run-service.js';

test('sync run probes work on legacy and sqlite runtimes without a sync store read', async () => {
  registerChatRunAdapter({
    transport: 'codex',
    getState: ({ chat }) => ({ busy: chat.title === 'Busy chat', runId: 'run-1' }),
    lookupRequest: ({ requestId }) => (requestId === 'req-1' ? { accepted: true, runId: 'run-1' } : null),
  });
  try {
    await runOnChatsBackends(async (kind) => {
      const busy = await addChatAsync(`sess-busy-${kind}`, 'Busy chat', undefined, undefined, undefined, { agentTransport: 'codex' });
      const idle = await addChatAsync(`sess-idle-${kind}`, 'Idle chat', undefined, undefined, undefined, { agentTransport: 'codex' });
      assert.deepEqual(probeChatRunLiveness({ chatId: busy.id, runId: 'run-1' }), { known: true, busy: true, reason: 'busy', errorCode: '' });
      assert.equal(probeChatRunLiveness({ chatId: idle.id }).busy, false);
      assert.equal(getChatRunState({ chatId: busy.id })?.busy, true);
      assert.deepEqual(lookupChatRunRequest({ chatId: busy.id, requestId: 'req-1' }), { accepted: true, runId: 'run-1' });
      assert.ok(countActiveChatRuns() >= 1, kind);
      assert.equal(probeChatRunLiveness({ chatId: 'never-seen' }).reason, 'chat_missing');
      await removeChatAsync(busy.id);
      assert.equal(probeChatRunLiveness({ chatId: busy.id }).reason, 'chat_missing');
    });
  } finally {
    unregisterChatRunAdapter('codex');
  }
});
