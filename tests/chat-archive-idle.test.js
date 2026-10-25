import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatArchiveIdleProbe } from '../lib/chat-archive-idle.js';
import { sweepIdleChats } from '../lib/chat-auto-archive.js';
import { registerChatRunAdapter, unregisterChatRunAdapter } from '../lib/chat-run-service.js';
import { openRecoveryStore, closeRecoveryStore } from '../lib/recovery/recovery-store.ts';
import { beginRunLaunch } from '../lib/recovery/recovery-lifecycle.ts';

test('auto-archive handles a cold chat after restart and protects an unfinished run', () => {
  const store = openRecoveryStore();
  registerChatRunAdapter({ transport: 'claude', getState: () => null });
  try {
    beginRunLaunch({ family: 'chat', owner: 'chat-run-service', chatId: 'pending', harness: 'claude' }, store);
    const archived = [];
    const summary = sweepIdleChats({
      settings: { chatAutoArchive: { enabled: true, idleValue: 5, idleUnit: 'hours' } },
      deps: {
        loadChats: () => ['cold', 'pending'].map((id) => ({
          id, agentTransport: 'claude', updatedAt: '2026-01-01T00:00:00Z',
        })),
        loadFavoriteChatIds: () => new Set(),
        listDelegationsForController: () => [],
        updateChat: (id) => archived.push(id),
      },
    });
    assert.deepEqual(summary.archived, ['cold']);
    assert.deepEqual(archived, ['cold']);
  } finally {
    unregisterChatRunAdapter('claude');
    closeRecoveryStore(store);
  }
});

test('missing adapters, errors and run-specific probes remain unconfirmed', () => {
  for (const reason of ['adapter_missing', 'adapter_error', 'probe_failed', 'run_mismatch', 'chat_missing']) {
    const idle = createChatArchiveIdleProbe({
      probeChatRunLiveness: () => ({ known: false, busy: false, reason }),
      listRuns: () => assert.fail('must not read recovery'),
    });
    assert.equal(idle({ chatId: 'cold' }), false);
  }
  const idle = createChatArchiveIdleProbe({
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    listRuns: () => assert.fail('must not read recovery'),
  });
  assert.equal(idle({ chatId: 'cold', runId: 'specific' }), false);
});

test('busy and waiting runs stay protected; known idle needs no recovery read', () => {
  for (const busy of [true, false]) {
    const idle = createChatArchiveIdleProbe({
      probeChatRunLiveness: () => ({ known: true, busy }),
      listRuns: () => assert.fail('must not read recovery'),
    });
    assert.equal(idle({ chatId: 'warm' }), !busy);
  }
});

test('cold chats fail closed when the recovery registry is unreadable', () => {
  let reads = 0;
  const idle = createChatArchiveIdleProbe({
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    listRuns: () => { reads++; throw new Error('unavailable'); },
  });
  assert.equal(idle({ chatId: 'cold' }), false);
  assert.equal(idle({ chatId: 'another' }), false);
  assert.equal(reads, 1);
});

test('recovery protection covers every page and all unfinished states once per sweep', () => {
  let reads = 0;
  const states = ['starting', 'running', 'waiting', 'recovering', 'unknown', 'interrupted'];
  const idle = createChatArchiveIdleProbe({
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    listRuns: ({ state, offset }) => {
      reads++;
      if (state === 'running' && offset === 0) return Array.from({ length: 1000 }, () => ({ chatId: 'first-page' }));
      return [{ chatId: state }];
    },
  });
  for (const chatId of [...states, 'first-page']) assert.equal(idle({ chatId }), false);
  assert.equal(idle({ chatId: 'cold' }), true);
  assert.equal(reads, 7);
});
