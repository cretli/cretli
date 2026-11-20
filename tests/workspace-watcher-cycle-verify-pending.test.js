import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  hasActiveWorkspaceWatcherCycleChildren,
  WORKSPACE_WATCHER_VERIFY_PENDING_MAX_MS,
} from '../lib/workspace-watcher-cycle-close.js';

after(() => removeIsolatedDataDir());

const CYCLE_CHAT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-22T12:00:00.000Z');

/** @param {object} patch */
function child(patch) {
  return { id: 'd1', parentChatId: CYCLE_CHAT, status: 'completed', ...patch };
}

test('a finished implement whose automatic host verify is running keeps the cycle alive', () => {
  const pending = child({ verifyPending: { since: new Date(NOW - 5 * 60 * 1000).toISOString(), revision: 'r1' } });
  assert.equal(hasActiveWorkspaceWatcherCycleChildren(CYCLE_CHAT, [pending], NOW), true);
});

test('a finished child without a pending verify does not keep the cycle alive', () => {
  assert.equal(hasActiveWorkspaceWatcherCycleChildren(CYCLE_CHAT, [child({ verifyPending: null })], NOW), false);
});

test('a verify marker orphaned past the bound (crash mid-verify) no longer counts', () => {
  const orphaned = child({
    verifyPending: { since: new Date(NOW - WORKSPACE_WATCHER_VERIFY_PENDING_MAX_MS - 1000).toISOString(), revision: 'r1' },
  });
  assert.equal(hasActiveWorkspaceWatcherCycleChildren(CYCLE_CHAT, [orphaned], NOW), false);
});

test('a pending verify of another chat does not count for this cycle', () => {
  const foreign = child({
    parentChatId: '22222222-2222-4222-8222-222222222222',
    verifyPending: { since: new Date(NOW - 1000).toISOString(), revision: 'r1' },
  });
  assert.equal(hasActiveWorkspaceWatcherCycleChildren(CYCLE_CHAT, [foreign], NOW), false);
});

test('a running child still counts as before', () => {
  assert.equal(hasActiveWorkspaceWatcherCycleChildren(CYCLE_CHAT, [child({ status: 'running' })], NOW), true);
});
