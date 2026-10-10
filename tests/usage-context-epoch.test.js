/**
 * A compaction destroys the provider prompt cache, so the room's context epoch
 * must advance and every following usage measurement must carry the new epoch.
 * The ledger uses that epoch to split cache epochs instead of mixing a cold
 * post-compaction measurement with the warm pre-compaction one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceRoomContextEpoch } from '../lib/usage/context-restarts.js';
import {
  buildHarnessBaselineKey,
  recordHarnessUsageDelta,
} from '../lib/usage/harness-usage.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';

test('advanceRoomContextEpoch bumps the epoch used by the snapshot baseline', () => {
  const room = { chatId: 'epoch-chat', _runId: 'run-epoch', _currentTurnId: 'turn-1' };
  assert.equal(advanceRoomContextEpoch(room, 'compact_boundary'), 1);
  assert.equal(room._contextEpoch, 1);
  assert.equal(room._contextEpochReason, 'compact_boundary');
  const before = buildHarnessBaselineKey(room, 'sdk');
  assert.equal(advanceRoomContextEpoch(room, 'compact_boundary'), 2);
  const after = buildHarnessBaselineKey(room, 'sdk');
  assert.notEqual(after, before, 'a new epoch starts a new baseline');
  assert.equal(advanceRoomContextEpoch(null), null);
});

test('a harness delta event carries the room context epoch', () => {
  const room = { chatId: 'epoch-delta', _contextEpoch: 3 };
  const partial = recordHarnessUsageDelta(
    room,
    'qwen',
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } },
    (row) => row
  );
  assert.ok(partial);
  assert.equal(partial.contextEpoch, 3);
  assert.equal(createUsageEvent(partial).contextEpoch, 3);
});

test('no contextEpoch is attached before any compaction', () => {
  const room = { chatId: 'epoch-none' };
  const partial = recordHarnessUsageDelta(
    room,
    'qwen',
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } },
    (row) => row
  );
  assert.ok(partial);
  assert.equal('contextEpoch' in partial, false);
  assert.equal(createUsageEvent(partial).contextEpoch, undefined);
});

console.log('usage-context-epoch.test.js OK');
