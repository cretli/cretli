/**
 * Unit tests for deterministic stub-trimming of old, large tool results.
 *
 * The module is pure, so the suite runs as a plain assert script with no clock
 * and no persistence. `CRETLI_TEST_DATA_DIR` keeps the cache-state console line
 * out of the output (it is read at call time, not import time).
 */

process.env.CRETLI_TEST_DATA_DIR ||= 'stub-trim-test';

import assert from 'node:assert/strict';
import {
  STUB_TRIM_GATE_REASON,
  STUB_TRIM_LIMITS,
  STUB_TRIM_TARGET,
  assertNewSessionOnlyStubTrim,
  buildStubTrimmedHistory,
  readStubTrimPointer,
  resolveStubTrimGate,
  shouldStubTrimForNewSession,
} from '../lib/context/stub-trim.js';
import {
  estimateCacheState,
  noteHarnessCacheState,
  resetCacheStateForTests,
} from '../lib/usage/cache-state.js';
import {
  CONTEXT_RESTART_REASON,
  recordContextRestart,
  resetContextRestartsForTests,
} from '../lib/usage/context-restarts.js';

const CHAT_ID = '11111111-1111-4111-8111-111111111111';
const LARGE = 'x'.repeat(5000);

/**
 * @param {number} seq
 * @param {string} text
 * @returns {{ seq: number, rec: Record<string, unknown> }}
 */
function localUser(seq, text) {
  return { seq, rec: { kind: 'localUser', text } };
}

/**
 * @param {number} seq
 * @param {string} text
 * @returns {{ seq: number, rec: Record<string, unknown> }}
 */
function assistant(seq, text) {
  return {
    seq,
    rec: {
      kind: 'sdk',
      event: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    },
  };
}

/**
 * @param {number} seq
 * @param {string} name
 * @param {unknown} result
 * @param {string} [status]
 * @returns {{ seq: number, rec: Record<string, unknown> }}
 */
function toolCall(seq, name, result, status = 'completed') {
  return { seq, rec: { kind: 'sdk', event: { type: 'tool_call', name, status, result } } };
}

// Four tool results: ordinals 0 and 1 are old, 2 and 3 are the newest two.
const history = [
  localUser(1, 'first question'),
  assistant(2, 'first answer'),
  toolCall(3, 'bash', LARGE),
  toolCall(4, 'read', 'small output'),
  toolCall(5, 'diff', LARGE),
  toolCall(6, 'log', LARGE),
  localUser(7, 'follow up'),
  assistant(8, 'final answer'),
];
const historySnapshot = JSON.parse(JSON.stringify(history));

const options = { chatId: CHAT_ID, keepRecentToolResults: 2 };
const trimmed = buildStubTrimmedHistory(history, options);

// --- user messages and assistant answers are always kept --------------------

assert.equal(trimmed.promptText.includes('> first question'), true);
assert.equal(trimmed.promptText.includes('> follow up'), true);
assert.equal(trimmed.promptText.includes('first answer'), true);
assert.equal(trimmed.promptText.includes('final answer'), true);
assert.equal(trimmed.events.length, history.length);
assert.deepEqual(trimmed.events[0].rec, history[0].rec);
assert.deepEqual(trimmed.events[7].rec, history[7].rec);

// --- old, large tool results are stubbed; small/recent ones are kept ---------

assert.equal(trimmed.stats.toolResults, 4);
assert.equal(trimmed.stats.stubbedToolResults, 1);
assert.equal(trimmed.stats.keptToolResults, 3);

const stubbedEvent = trimmed.events[2].rec.event;
assert.equal(typeof stubbedEvent.result, 'string');
assert.equal(stubbedEvent.result.includes('[trimmed tool result: bash'), true);
assert.equal(stubbedEvent.result.includes(`${LARGE.length} chars omitted`), true);
assert.equal(trimmed.stats.omittedChars, LARGE.length);

// The stub carries a parseable pointer to the original history event.
const expectedRef = `cretli-ref chat=${CHAT_ID} seq=3`;
assert.equal(stubbedEvent.result.includes(expectedRef), true);
assert.deepEqual(readStubTrimPointer(stubbedEvent.result), { chatId: CHAT_ID, seq: 3 });

// Old but small stays verbatim.
assert.equal(trimmed.events[3].rec.event.result, 'small output');
// Recent large stays verbatim (both the newest two).
assert.equal(trimmed.events[4].rec.event.result, LARGE);
assert.equal(trimmed.events[5].rec.event.result, LARGE);
assert.equal(trimmed.stats.truncated, false);

// A stub is short by construction.
assert.equal(stubbedEvent.result.length < 200, true);

// --- purity: the input is never mutated -------------------------------------

assert.deepEqual(history, historySnapshot);
assert.notStrictEqual(trimmed.events[2].rec, history[2].rec);
assert.notStrictEqual(trimmed.events[2].rec.event, history[2].rec.event);
assert.strictEqual(trimmed.events[3].rec, history[3].rec);
// The original large payload is untouched in the input.
assert.equal(history[2].rec.event.result, LARGE);

// --- safeguard: new-session-only target -------------------------------------

assert.equal(trimmed.target, STUB_TRIM_TARGET);
assert.equal(trimmed.persisted, false);
assert.equal(trimmed.sourceMutated, false);
assertNewSessionOnlyStubTrim(trimmed);
assert.throws(() => assertNewSessionOnlyStubTrim({ ...trimmed, target: 'live_session' }), TypeError);
assert.throws(() => assertNewSessionOnlyStubTrim({ ...trimmed, persisted: true }), TypeError);
assert.throws(() => assertNewSessionOnlyStubTrim(null), TypeError);

// A non-UUID chat id cannot produce a valid pointer, so nothing is stubbed.
const noRef = buildStubTrimmedHistory(history, { chatId: 'not-a-uuid', keepRecentToolResults: 2 });
assert.equal(noRef.stats.stubbedToolResults, 0);
assert.equal(noRef.events[2].rec.event.result, LARGE);

// --- bounded output ----------------------------------------------------------

const longHistory = [];
for (let seq = 1; seq <= 20; seq += 1) longHistory.push(localUser(seq, `message ${seq}`));
const cappedEvents = buildStubTrimmedHistory(longHistory, { chatId: CHAT_ID, maxEvents: 5 });
assert.equal(cappedEvents.events.length, 5);
assert.deepEqual(cappedEvents.events.map((row) => row.seq), [16, 17, 18, 19, 20]);
assert.equal(cappedEvents.stats.truncated, true);

const hugeHistory = [localUser(1, 'a'.repeat(50_000)), assistant(2, 'b'.repeat(50_000))];
const cappedPrompt = buildStubTrimmedHistory(hugeHistory, { chatId: CHAT_ID, maxPromptChars: 400 });
assert.equal(cappedPrompt.promptText.length <= 400, true);
assert.equal(cappedPrompt.stats.truncated, true);

// A requested bound below the head/tail marker floor is clamped up, never
// left unbounded.
const flooredPrompt = buildStubTrimmedHistory(hugeHistory, { chatId: CHAT_ID, maxPromptChars: 50 });
assert.equal(flooredPrompt.promptText.length <= 200, true);
assert.equal(flooredPrompt.stats.truncated, true);

// Default bounds stay documented and positive.
assert.equal(STUB_TRIM_LIMITS.largeResultChars > 0, true);
assert.equal(STUB_TRIM_LIMITS.keepRecentToolResults > 0, true);

// --- gate predicate ----------------------------------------------------------

const gateOptions = { contextTokenThreshold: 1000, estimatedContextTokens: 10 };

assert.equal(
  shouldStubTrimForNewSession({ cacheState: { state: 'cold' }, ...gateOptions }),
  true,
);
assert.equal(
  resolveStubTrimGate({ cacheState: { state: 'cold' }, ...gateOptions }).reason,
  STUB_TRIM_GATE_REASON.CACHE_COLD,
);
assert.equal(
  shouldStubTrimForNewSession({ cacheState: { state: 'warm' }, ...gateOptions }),
  false,
);
assert.equal(
  resolveStubTrimGate({ cacheState: { state: 'warm' }, ...gateOptions }).reason,
  STUB_TRIM_GATE_REASON.CACHE_WARM,
);
assert.equal(
  shouldStubTrimForNewSession({
    cacheState: { state: 'warm' },
    contextTokenThreshold: 1000,
    estimatedContextTokens: 1000,
  }),
  true,
);
assert.equal(
  resolveStubTrimGate({
    cacheState: { state: 'warm' },
    contextTokenThreshold: 1000,
    estimatedContextTokens: 1000,
  }).reason,
  STUB_TRIM_GATE_REASON.CONTEXT_OVER_THRESHOLD,
);
// Unknown cache state is not "cold": it needs the threshold to authorize.
assert.equal(
  shouldStubTrimForNewSession({ cacheState: { state: 'unknown' }, ...gateOptions }),
  false,
);
assert.equal(
  shouldStubTrimForNewSession({
    cacheState: { state: 'unknown' },
    contextTokenThreshold: 1000,
    estimatedContextTokens: 5000,
  }),
  true,
);
// Elapsed time fed directly to the gate does not authorize anything.
assert.equal(
  shouldStubTrimForNewSession({
    cacheState: { state: 'warm' },
    now: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ...gateOptions,
  }),
  false,
);

// --- gate reuses estimateCacheState (warm -> cold through the real module) ---

resetCacheStateForTests();
resetContextRestartsForTests();
const GATE_CHAT = '22222222-2222-4222-8222-222222222222';
const T0 = 1_700_000_000_000;
noteHarnessCacheState({
  chatId: GATE_CHAT,
  harness: 'claude',
  tokens: { cachedInput: 1000 },
  now: T0,
});

// One minute later the Claude 5-minute cache is still warm: not allowed.
assert.equal(
  estimateCacheState(GATE_CHAT, { harness: 'claude', now: T0 + 60_000 }).state,
  'warm',
);
assert.equal(
  resolveStubTrimGate({
    chatId: GATE_CHAT,
    harness: 'claude',
    now: T0 + 60_000,
    estimatedContextTokens: 10,
    contextTokenThreshold: 1000,
  }).allowed,
  false,
);

// Past the TTL the cache is cold: allowed even with a small context.
assert.equal(
  resolveStubTrimGate({
    chatId: GATE_CHAT,
    harness: 'claude',
    now: T0 + 6 * 60_000,
    estimatedContextTokens: 10,
    contextTokenThreshold: 1000,
  }).allowed,
  true,
);

// A recorded restart invalidates a still-fresh cache: allowed.
resetCacheStateForTests();
resetContextRestartsForTests();
noteHarnessCacheState({
  chatId: GATE_CHAT,
  harness: 'claude',
  tokens: { cachedInput: 1000 },
  now: T0,
});
recordContextRestart({
  chatId: GATE_CHAT,
  harness: 'claude',
  reason: CONTEXT_RESTART_REASON.SESSION_DROP,
  at: T0 + 2 * 60_000,
});
assert.equal(
  resolveStubTrimGate({
    chatId: GATE_CHAT,
    harness: 'claude',
    now: T0 + 3 * 60_000,
    estimatedContextTokens: 10,
    contextTokenThreshold: 1000,
  }).allowed,
  true,
);

console.log('stub-trim tests passed');
