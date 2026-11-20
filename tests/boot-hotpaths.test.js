import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatArchiveIdleProbe } from '../lib/chat-archive-idle.js';

test('fingerprint is read once per TTL window across many cold chats', () => {
  let fp = 0;
  let now = 1000;
  const probe = createChatArchiveIdleProbe({
    probeChatRunLiveness: () => ({ known: false, reason: 'state_missing' }),
    listRuns: () => [],
    getRunsFingerprint: () => { fp += 1; return 'v1'; },
    nowMs: () => now,
    fingerprintTtlMs: 250,
  });
  for (let i = 0; i < 500; i += 1) assert.equal(probe({ chatId: `c${i}` }), true);
  assert.equal(fp, 1);
  now += 1000;
  probe({ chatId: 'late' });
  assert.equal(fp, 2);
});
