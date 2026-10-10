/**
 * Unit tests for the in-memory context-restart ledger.
 */

// Keep the compact console line out of the test output (read at call time).
process.env.CRETLI_TEST_DATA_DIR ||= 'context-restarts-test';

import assert from 'node:assert/strict';
import {
  CONTEXT_RESTART_LIMITS,
  CONTEXT_RESTART_REASON,
  getContextRestartForChat,
  getContextRestartSummary,
  recordContextRestart,
  resetContextRestartsForTests,
} from '../lib/usage/context-restarts.js';

resetContextRestartsForTests();

recordContextRestart({
  chatId: 'chat-a',
  harness: 'sdk',
  reason: CONTEXT_RESTART_REASON.MCP_REVISION,
  at: 1000,
});
recordContextRestart({
  chatId: 'chat-a',
  harness: 'sdk',
  reason: CONTEXT_RESTART_REASON.MCP_REVISION,
  at: 2000,
});
recordContextRestart({
  chatId: 'chat-a',
  harness: 'sdk',
  reason: CONTEXT_RESTART_REASON.MODEL_CHANGE,
  at: 3000,
});
recordContextRestart({
  chatId: 'chat-b',
  harness: 'claude',
  reason: CONTEXT_RESTART_REASON.MCP_REVISION,
  at: 4000,
});

const chatA = getContextRestartForChat('chat-a');
assert.equal(chatA.count, 3);
assert.equal(chatA.byReason.mcp_revision, 2);
assert.equal(chatA.byReason.model_change, 1);
assert.equal(chatA.events.length, 3);
assert.equal(chatA.lastAt, 3000);
assert.deepEqual(chatA.events[0], {
  chatId: 'chat-a',
  harness: 'sdk',
  reason: 'mcp_revision',
  at: 1000,
});

const summary = getContextRestartSummary();
assert.equal(summary.total, 4);
assert.equal(summary.chats.length, 2);
assert.equal(
  summary.byHarnessReason.find((row) => row.harness === 'sdk' && row.reason === 'mcp_revision').count,
  2,
);
assert.equal(
  summary.byHarnessReason.find((row) => row.harness === 'claude' && row.reason === 'mcp_revision').count,
  1,
);

// Unknown reasons are normalized so counters stay groupable.
recordContextRestart({ chatId: 'chat-a', harness: 'sdk', reason: 'not-a-real-reason' });
assert.equal(getContextRestartForChat('chat-a').byReason.unknown, 1);

// Per-chat event history is capped while the count keeps growing.
const overflow = CONTEXT_RESTART_LIMITS.maxEventsPerChat + 5;
for (let i = 0; i < overflow; i += 1) {
  recordContextRestart({
    chatId: 'chat-cap',
    harness: 'opencode',
    reason: CONTEXT_RESTART_REASON.MODE_CHANGE,
  });
}
const capped = getContextRestartForChat('chat-cap');
assert.equal(capped.count, overflow);
assert.equal(capped.events.length, CONTEXT_RESTART_LIMITS.maxEventsPerChat);

// The number of tracked chats is capped; the oldest first-seen entry is evicted.
for (let i = 0; i < CONTEXT_RESTART_LIMITS.maxTrackedChats + 2; i += 1) {
  recordContextRestart({
    chatId: `bulk-${i}`,
    harness: 'sdk',
    reason: CONTEXT_RESTART_REASON.SESSION_DROP,
  });
}
assert.equal(getContextRestartSummary().chats.length, CONTEXT_RESTART_LIMITS.maxTrackedChats);
assert.equal(getContextRestartForChat('chat-a'), null);

assert.equal(getContextRestartForChat('missing-chat'), null);

resetContextRestartsForTests();
const empty = getContextRestartSummary();
assert.equal(empty.total, 0);
assert.equal(empty.chats.length, 0);
assert.equal(empty.byHarnessReason.length, 0);

console.log('context-restarts.test.js OK');
