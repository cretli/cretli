import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWatcherAutomation } from '../app_front/features/watcher/watcherAutomationView.js';

test('summarizeWatcherAutomation reports defaults as off and empty', () => {
  const s = summarizeWatcherAutomation({ watcher: { policy: {} } });
  assert.equal(s.anyOn, false);
  assert.equal(s.pending, 0);
  assert.equal(s.last, null);
});

test('summarizeWatcherAutomation counts commits, pending and returned entries', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const s = summarizeWatcherAutomation({ watcher: {
    paused: true,
    policy: { autoIntegrate: true, autoRestart: false },
    automaticIntegrations: [
      { todoId: 'a', at: '2026-10-24T09:00:00Z', ok: true, reason: '' },
      { todoId: 'b', at: '2026-10-24T11:30:00Z', ok: true, reason: '' },
      { todoId: 'c', at: '2026-10-24T11:40:00Z', ok: false, reason: 'confirmation_pending' },
      { todoId: 'd', at: '2026-10-24T11:50:00Z', ok: false, reason: 'patch_invalid' },
    ],
  } }, now);
  assert.deepEqual([s.anyOn, s.paused, s.pending, s.commitsLastHour, s.returned], [true, true, 1, 1, 1]);
  assert.equal(s.last.todoId, 'd');
});
