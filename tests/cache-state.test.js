/**
 * Unit tests for the bounded per-chat prompt-cache state and its TTL-aware
 * warm/cold estimation. Every estimate uses an injected clock (`now`) so the
 * suite is deterministic and never sleeps.
 */

// Keep the cache-miss console line out of the suite output unless a test
// temporarily removes this marker to observe the log.
process.env.CRETLI_TEST_DATA_DIR ||= 'cache-state-test';

import assert from 'node:assert/strict';
import {
  CACHE_STATE,
  CACHE_STATE_LIMITS,
  CACHE_STATE_REASON,
  DEFAULT_CACHE_MISS_PAUSE_MS,
  estimateCacheState,
  getCacheStateForChat,
  noteHarnessCacheState,
  resetCacheStateForTests,
  resolveCacheTtl,
} from '../lib/usage/cache-state.js';
import {
  CONTEXT_RESTART_REASON,
  advanceRoomContextEpoch,
  recordContextRestart,
  resetContextRestartsForTests,
} from '../lib/usage/context-restarts.js';
import { recordHarnessUsageDelta } from '../lib/usage/harness-usage.js';

const T0 = 1_000_000_000_000;
const MINUTE = 60 * 1000;

resetCacheStateForTests();
resetContextRestartsForTests();

// --- TTL table: documented defaults, extended tiers, honest unknowns --------

const claudeTtl = resolveCacheTtl({ harness: 'claude' });
assert.equal(claudeTtl.known, true);
assert.equal(claudeTtl.defaultTtlMs, 5 * MINUTE);
assert.equal(claudeTtl.extendedTtlMs, 60 * MINUTE);
assert.equal(claudeTtl.refreshOnHit, true);
assert.equal(resolveCacheTtl({ harness: 'claude', retention: 'extended' }).ttlMs, 60 * MINUTE);
// Provider aliases resolve to the same row.
assert.equal(resolveCacheTtl({ provider: 'anthropic' }).harness, 'claude');
assert.equal(resolveCacheTtl({ provider: 'openai' }).harness, 'codex');

const codexTtl = resolveCacheTtl({ harness: 'codex' });
assert.equal(codexTtl.known, true);
assert.equal(codexTtl.defaultTtlMs, 5 * MINUTE);
assert.equal(codexTtl.extendedTtlMs, 24 * 60 * MINUTE);
assert.equal(codexTtl.refreshOnHit, false);

// qwen has no 1 h tier: an extended request still resolves the 5 min default.
const qwenTtl = resolveCacheTtl({ harness: 'qwen' });
assert.equal(qwenTtl.defaultTtlMs, 5 * MINUTE);
assert.equal(qwenTtl.extendedTtlMs, null);
assert.equal(resolveCacheTtl({ harness: 'qwen', retention: 'extended' }).ttlMs, 5 * MINUTE);

// Automatic caches without a documented idle TTL stay unknown, not invented.
assert.equal(resolveCacheTtl({ harness: 'deepseek' }).known, false);
assert.equal(resolveCacheTtl({ harness: 'sdk' }).known, false);
assert.equal(resolveCacheTtl({ harness: 'opencode' }).known, false);
assert.equal(
  resolveCacheTtl({ harness: 'mystery' }).reasonUnknown,
  CACHE_STATE_REASON.UNKNOWN_HARNESS
);

// --- Warm within TTL --------------------------------------------------------

noteHarnessCacheState({
  chatId: 'warm-chat',
  harness: 'claude',
  model: 'claude-sonnet-4',
  tokens: { cachedInput: 1200, cacheWrite: 40 },
  contextEpoch: 0,
  now: T0,
});
const warm = estimateCacheState('warm-chat', {
  now: T0 + MINUTE,
  harness: 'claude',
  contextEpoch: 0,
});
assert.equal(warm.state, CACHE_STATE.WARM);
assert.equal(warm.reason, CACHE_STATE_REASON.WITHIN_TTL);
assert.equal(warm.ttlMs, 5 * MINUTE);
assert.equal(warm.ageMinutes, 1);
assert.equal(warm.lastCachedInputTokens, 1200);
assert.equal(warm.lastCacheWriteTokens, 40);
assert.equal(warm.expiresInMs, 4 * MINUTE);

// --- Cold after the TTL expires --------------------------------------------

const expired = estimateCacheState('warm-chat', {
  now: T0 + 6 * MINUTE,
  harness: 'claude',
  contextEpoch: 0,
});
assert.equal(expired.state, CACHE_STATE.COLD);
assert.equal(expired.reason, CACHE_STATE_REASON.TTL_EXPIRED);
assert.equal(expired.ageMinutes, 6);

// A cache hit refreshes the TTL: the age is measured from the latest hit.
noteHarnessCacheState({
  chatId: 'warm-chat',
  harness: 'claude',
  tokens: { cachedInput: 1300 },
  contextEpoch: 0,
  now: T0 + 5 * MINUTE,
});
assert.equal(
  estimateCacheState('warm-chat', { now: T0 + 8 * MINUTE, harness: 'claude', contextEpoch: 0 }).state,
  CACHE_STATE.WARM
);

// --- Cold after a context epoch change (compaction) -------------------------

noteHarnessCacheState({
  chatId: 'epoch-chat',
  harness: 'claude',
  tokens: { cachedInput: 500 },
  contextEpoch: 0,
  now: T0,
});
const epochChanged = estimateCacheState('epoch-chat', {
  now: T0 + MINUTE,
  harness: 'claude',
  contextEpoch: 1,
});
assert.equal(epochChanged.state, CACHE_STATE.COLD);
assert.equal(epochChanged.reason, CACHE_STATE_REASON.CONTEXT_EPOCH_CHANGED);

// A compaction bumps the room epoch and invalidates the tracked state even
// before an estimate passes the new epoch explicitly.
const compactRoom = { chatId: 'compact-chat', transport: 'claude' };
noteHarnessCacheState({
  chatId: 'compact-chat',
  harness: 'claude',
  tokens: { cachedInput: 700 },
  contextEpoch: 0,
  now: T0,
});
assert.equal(advanceRoomContextEpoch(compactRoom, 'compact_boundary'), 1);
assert.equal(getCacheStateForChat('compact-chat').lastCachedInputTokens, 0);
assert.equal(
  estimateCacheState('compact-chat', { now: T0 + 1000, harness: 'claude' }).reason,
  CACHE_STATE_REASON.SESSION_RESTARTED
);

// --- Cold after a recorded session restart ---------------------------------

noteHarnessCacheState({
  chatId: 'restart-chat',
  harness: 'claude',
  tokens: { cachedInput: 800, cacheWrite: 10 },
  contextEpoch: 0,
  now: T0,
});
recordContextRestart({
  chatId: 'restart-chat',
  harness: 'claude',
  reason: CONTEXT_RESTART_REASON.SESSION_DROP,
  at: T0 + 30_000,
});
const restarted = estimateCacheState('restart-chat', {
  now: T0 + 40_000,
  harness: 'claude',
  contextEpoch: 0,
});
assert.equal(restarted.state, CACHE_STATE.COLD);
assert.equal(restarted.reason, CACHE_STATE_REASON.SESSION_RESTARTED);
assert.equal(restarted.invalidationReason, CONTEXT_RESTART_REASON.SESSION_DROP);

// A real hit after the restart clears the invalidation and warms the state.
noteHarnessCacheState({
  chatId: 'restart-chat',
  harness: 'claude',
  tokens: { cachedInput: 850 },
  contextEpoch: 0,
  now: T0 + 50_000,
});
assert.equal(
  estimateCacheState('restart-chat', { now: T0 + 55_000, harness: 'claude', contextEpoch: 0 }).state,
  CACHE_STATE.WARM
);

// --- Unknown harness / unknown TTL / no cached turn -------------------------

noteHarnessCacheState({
  chatId: 'mystery-chat',
  harness: 'mystery',
  tokens: { cachedInput: 100 },
  now: T0,
});
const unknownHarness = estimateCacheState('mystery-chat', { now: T0 + 1000 });
assert.equal(unknownHarness.state, CACHE_STATE.UNKNOWN);
assert.equal(unknownHarness.reason, CACHE_STATE_REASON.UNKNOWN_HARNESS);

noteHarnessCacheState({
  chatId: 'deepseek-chat',
  harness: 'deepseek',
  tokens: { cachedInput: 100 },
  now: T0,
});
const unknownTtl = estimateCacheState('deepseek-chat', { now: T0 + 1000 });
assert.equal(unknownTtl.state, CACHE_STATE.UNKNOWN);
assert.equal(unknownTtl.reason, CACHE_STATE_REASON.UNKNOWN_TTL);

assert.equal(getCacheStateForChat('never-seen'), null);
const noTurn = estimateCacheState('never-seen', { now: T0 });
assert.equal(noTurn.state, CACHE_STATE.UNKNOWN);
assert.equal(noTurn.reason, CACHE_STATE_REASON.NO_CACHED_TURN);

// --- Miss-after-pause is logged once per pause -----------------------------

const originalInfo = console.info;
const missLines = [];
delete process.env.CRETLI_TEST_DATA_DIR;
console.info = (...args) => {
  if (args[0] === '[cache-state]') missLines.push(args[1]);
};
try {
  noteHarnessCacheState({
    chatId: 'miss-chat',
    harness: 'claude',
    model: 'claude-sonnet-4',
    tokens: { cachedInput: 900 },
    now: T0,
  });

  const firstMiss = noteHarnessCacheState({
    chatId: 'miss-chat',
    harness: 'claude',
    model: 'claude-sonnet-4',
    tokens: { cachedInput: 0 },
    now: T0 + 10 * MINUTE,
  });
  assert.equal(firstMiss.missLogged, true);
  assert.equal(firstMiss.pauseMs, 10 * MINUTE);

  // The next zero-cache turn within the same pause must not log again.
  const secondMiss = noteHarnessCacheState({
    chatId: 'miss-chat',
    harness: 'claude',
    tokens: { cachedInput: 0 },
    now: T0 + 11 * MINUTE,
  });
  assert.equal(secondMiss.missLogged, false);

  // A fresh hit ends the pause episode...
  noteHarnessCacheState({
    chatId: 'miss-chat',
    harness: 'claude',
    tokens: { cachedInput: 950 },
    now: T0 + 12 * MINUTE,
  });
  // ...so the next long pause logs a new miss.
  const thirdMiss = noteHarnessCacheState({
    chatId: 'miss-chat',
    harness: 'claude',
    tokens: { cachedInput: 0 },
    now: T0 + 25 * MINUTE,
  });
  assert.equal(thirdMiss.missLogged, true);
} finally {
  console.info = originalInfo;
  process.env.CRETLI_TEST_DATA_DIR = 'cache-state-test';
}

assert.equal(missLines.length, 2);
const firstLog = JSON.parse(missLines[0]);
assert.equal(firstLog.event, 'cache_miss_after_pause');
assert.equal(firstLog.chatId, 'miss-chat');
assert.equal(firstLog.harness, 'claude');
assert.equal(firstLog.model, 'claude-sonnet-4');
assert.equal(firstLog.pauseMinutes, 10);
// No prompt content or secrets in the calibration event.
assert.deepEqual(
  Object.keys(firstLog).sort(),
  ['at', 'chatId', 'event', 'harness', 'model', 'pauseMinutes', 'ttlMs'].sort()
);

// A short pause below the threshold does not log even with zero cache reads.
assert.ok(DEFAULT_CACHE_MISS_PAUSE_MS >= 5 * MINUTE);
const countBefore = missLines.length;
const originalInfo2 = console.info;
delete process.env.CRETLI_TEST_DATA_DIR;
console.info = (...args) => {
  if (args[0] === '[cache-state]') missLines.push(args[1]);
};
try {
  noteHarnessCacheState({
    chatId: 'short-pause-chat',
    harness: 'claude',
    tokens: { cachedInput: 400 },
    now: T0,
  });
  const shortPause = noteHarnessCacheState({
    chatId: 'short-pause-chat',
    harness: 'claude',
    tokens: { cachedInput: 0 },
    now: T0 + MINUTE,
  });
  assert.equal(shortPause.missLogged, false);
} finally {
  console.info = originalInfo2;
  process.env.CRETLI_TEST_DATA_DIR = 'cache-state-test';
}
assert.equal(missLines.length, countBefore);

// --- Bounded eviction -------------------------------------------------------

resetCacheStateForTests();
const totalChats = CACHE_STATE_LIMITS.maxTrackedChats + 3;
for (let i = 0; i < totalChats; i += 1) {
  noteHarnessCacheState({
    chatId: `evict-${i}`,
    harness: 'claude',
    tokens: { cachedInput: 10 },
    now: T0 + i,
  });
}
assert.equal(getCacheStateForChat('evict-0'), null);
assert.equal(getCacheStateForChat('evict-2'), null);
assert.ok(getCacheStateForChat(`evict-${totalChats - 1}`));
assert.equal(estimateCacheState('evict-0', { now: T0 }).reason, CACHE_STATE_REASON.NO_CACHED_TURN);

// --- The usage ingest path stamps the cache state ---------------------------

resetCacheStateForTests();
const partial = recordHarnessUsageDelta(
  { chatId: 'ingest-chat', modelId: 'claude-sonnet-4' },
  'claude',
  {
    usage: {
      inputTokens: 1200,
      outputTokens: 10,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    },
  },
  (row) => row
);
// Existing ledger output is unchanged by the cache-state side channel.
assert.equal(partial.tokens.cachedInput, 900);
assert.equal(partial.tokens.cacheWrite, 50);
const ingested = getCacheStateForChat('ingest-chat');
assert.ok(ingested);
assert.equal(ingested.harness, 'claude');
assert.equal(ingested.lastCachedInputTokens, 900);
assert.equal(ingested.lastCacheWriteTokens, 50);
assert.ok(ingested.lastCachedTurnAt > 0);

// A turn with no cache read advances lastTurnAt but must not claim a cached turn.
recordHarnessUsageDelta(
  { chatId: 'ingest-cold', modelId: 'deepseek-chat' },
  'deepseek',
  { usage: { inputTokens: 100, outputTokens: 5 } },
  (row) => row
);
const coldIngest = getCacheStateForChat('ingest-cold');
assert.ok(coldIngest);
assert.equal(coldIngest.lastCachedTurnAt, null);
assert.equal(coldIngest.lastCachedInputTokens, 0);
assert.ok(coldIngest.lastTurnAt > 0);

console.log('cache-state.test.js OK');
