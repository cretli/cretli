import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOpenCodePromptRunWaiter,
  resolveOpenCodePromptRunFromEvent,
  settleOpenCodePromptRunAfterAbort,
} from '../opencode-prompt-run.js';

test('idle event alone cannot end a run with an open tool or pending input', () => {
  const idle = { type: 'session.idle', properties: { sessionID: 's1' } };
  assert.equal(resolveOpenCodePromptRunFromEvent(idle, { opencodeSessionId: 's1', hasOpenTools: true }), null);
  assert.equal(resolveOpenCodePromptRunFromEvent(idle, { opencodeSessionId: 's1', hasPendingUserInput: true }), null);
});

test('settle after acknowledged abort ends the waiter as cancelled and clears pending input', async () => {
  const room = {
    _pendingOpenCodeQuestions: new Map([['q1', {}]]),
    _pendingOpenCodePermissions: new Map([['p1', {}], ['p2', {}]]),
  };
  const waiter = createOpenCodePromptRunWaiter(room, 60_000, 60_000);
  const settled = settleOpenCodePromptRunAfterAbort(room);
  assert.deepEqual(await waiter, { status: 'cancelled' });
  assert.equal(settled.settledWaiter, true);
  assert.deepEqual(settled.questionIds, ['q1']);
  assert.deepEqual(settled.permissionIds, ['p1', 'p2']);
  assert.equal(room._pendingOpenCodeQuestions.size, 0);
  assert.equal(room._pendingOpenCodePermissions.size, 0);
  assert.equal(room._promptRunWaiter, null);
});

test('settle without a waiter is a harmless no-op', () => {
  const room = {};
  const settled = settleOpenCodePromptRunAfterAbort(room);
  assert.deepEqual(settled, { questionIds: [], permissionIds: [], settledWaiter: false });
});
