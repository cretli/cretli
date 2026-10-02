/**
 * Behavior tests for the shared "agent finished" push used by the Cursor SDK
 * path and by room-kernel harnesses.
 */
import assert from 'node:assert/strict';
import {
  AGENT_FINISHED_SKIPPED_STATUSES,
  isSkippedAgentFinishedStatus,
  notifyAgentFinished,
} from '../lib/agent-finished-push.js';
import { beginHarnessRun } from '../lib/usage/harness-usage.js';
import { shouldSuppressAgentFinishedPush } from '../lib/agent-harness/room-kernel.js';

/**
 * @returns {{ broadcasts: object[], historyLoads: string[], deps: object }}
 */
function makeDeps(overrides = {}) {
  const broadcasts = [];
  const historyLoads = [];
  const deps = {
    isPushAvailable: () => true,
    hasPushSubscriptions: () => true,
    broadcastPush: async (payload) => {
      broadcasts.push(payload);
    },
    loadChatHistory: (chatId) => {
      historyLoads.push(chatId);
      return { headSeq: 12, records: [] };
    },
    extractLatestAssistantText: () => 'the assistant reply',
    resolveChatTitle: async (_chatId, roomTitle) => roomTitle || 'Persisted title',
    ...overrides,
  };
  return { broadcasts, historyLoads, deps };
}

// Availability is checked before any history work.
{
  const { broadcasts, historyLoads, deps } = makeDeps({ isPushAvailable: () => false });
  assert.equal(notifyAgentFinished({ chatId: 'c1', status: 'completed' }, deps), false);
  assert.equal(broadcasts.length, 0);
  assert.equal(historyLoads.length, 0);
}

// No subscription: also skip history entirely.
{
  const { broadcasts, historyLoads, deps } = makeDeps({ hasPushSubscriptions: () => false });
  assert.equal(notifyAgentFinished({ chatId: 'c1', status: 'completed' }, deps), false);
  assert.equal(broadcasts.length, 0);
  assert.equal(historyLoads.length, 0);
}

// Cancelled plan-guard runs are not "finished".
{
  assert.deepEqual(AGENT_FINISHED_SKIPPED_STATUSES, ['plan_guard_cancelled']);
  assert.equal(isSkippedAgentFinishedStatus('plan_guard_cancelled'), true);
  const { broadcasts, deps } = makeDeps();
  assert.equal(
    notifyAgentFinished({ chatId: 'c1', status: 'plan_guard_cancelled' }, deps),
    false
  );
  assert.equal(broadcasts.length, 0);
}

// A real finish loads history once and pushes the snippet.
{
  const { broadcasts, historyLoads, deps } = makeDeps();
  const room = { chatId: 'c1', chatTitle: 'Room title' };
  assert.equal(notifyAgentFinished({ status: 'completed', room }, deps), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyLoads.length, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].data.type, 'agent-finished');
  assert.equal(broadcasts[0].data.snippet, 'the assistant reply');
  assert.equal(broadcasts[0].data.headSeq, 12);
  assert.equal(broadcasts[0].data.title, 'Room title');
  assert.match(broadcasts[0].body, /Room title/);
}

// Two finish paths observing one run push exactly once; a new run resets.
{
  const { broadcasts, deps } = makeDeps();
  const room = { chatId: 'c1', chatTitle: 'Room title' };
  assert.equal(notifyAgentFinished({ status: 'completed', room }, deps), true);
  assert.equal(notifyAgentFinished({ status: 'completed', room }, deps), false, 'same run dedupes');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broadcasts.length, 1);
  beginHarnessRun(room);
  assert.equal(room._agentFinishedPushNotified, false, 'beginHarnessRun re-arms the badge');
  assert.equal(notifyAgentFinished({ status: 'completed', room }, deps), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broadcasts.length, 2);
}

// Server-started runs (delegation/headless/mailbox) are suppressed because they
// never attach an interactive client; parity with the SDK path, where only a WS
// handler arms `onRunFinished`.
{
  assert.equal(shouldSuppressAgentFinishedPush(null), true);
  assert.equal(shouldSuppressAgentFinishedPush({ delegationId: 'd-1' }), true);
  assert.equal(shouldSuppressAgentFinishedPush({ serverHold: true }), true);
  assert.equal(shouldSuppressAgentFinishedPush({ _interactiveClientSeen: true }), false);
  // Sticky flag: a client that already left still arms the push.
  assert.equal(
    shouldSuppressAgentFinishedPush({ _interactiveClientSeen: true, delegationId: 'd-1' }),
    false
  );
  assert.equal(shouldSuppressAgentFinishedPush({}), true);
}

console.log('agent-finished-push.test.js: ok');
