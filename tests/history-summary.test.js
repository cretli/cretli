/**
 * Unit tests for the pure history-summary module.
 *
 * No network and no LLM: the model call is an injected seam, so this suite runs
 * as a plain assert script. `CRETLI_TEST_DATA_DIR` keeps the cache-state console
 * line out of the output (it is read at call time, not import time).
 */

process.env.CRETLI_TEST_DATA_DIR ||= 'history-summary-test';

import assert from 'node:assert/strict';
import {
  ARCHIVE_ACCESS_HINT,
  ARCHIVE_CALL_CAP_PER_TURN,
  SUMMARY_GATE_REASON,
  SUMMARY_KIND,
  SUMMARY_SECTIONS,
  SUMMARY_TARGET,
  assertNewSessionOnlySummary,
  assertSummaryEpochFresh,
  buildNewSessionSeedPrompt,
  buildSummaryPromptFromHistory,
  createHistorySummarizer,
  extractDurableFacts,
  parseSummaryResult,
  resolveSummaryEpochGuard,
  resolveSummaryGate,
  shouldSummarize,
  summarizeHistoryFromOriginals,
} from '../lib/context/history-summary.js';
import { buildStubTrimmedHistory } from '../lib/context/stub-trim.js';

const CHAT_ID = '33333333-3333-4333-8333-333333333333';

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

// --- shared fixtures ---------------------------------------------------------

const history = [
  localUser(1, 'first question'),
  assistant(2, 'first answer'),
  localUser(3, 'second question'),
  assistant(4, 'second answer'),
  localUser(5, 'third question'),
  assistant(6, 'third answer'),
  localUser(7, 'fourth question'),
  assistant(8, 'fourth answer'),
];
const historySnapshot = JSON.parse(JSON.stringify(history));

const VALID_SUMMARY = [
  `## ${SUMMARY_SECTIONS.GOAL}`,
  `Implement the pure summarizer with pointers. cretli-ref chat=${CHAT_ID} seq=1`,
  '',
  `## ${SUMMARY_SECTIONS.DECISIONS}`,
  `- Reuse the existing cheap provider seam instead of adding a provider. cretli-ref chat=${CHAT_ID} seq=2`,
  `- Keep the last N turns verbatim so the new session sees fresh output. cretli-ref chat=${CHAT_ID} seq=3`,
  '',
  `## ${SUMMARY_SECTIONS.FILE_STATE_CHANGES}`,
  `- lib/context/history-summary.js is new. cretli-ref chat=${CHAT_ID} seq=4`,
  '',
  `## ${SUMMARY_SECTIONS.OPEN_ITEMS}`,
  `- Wire the concrete summarize seam into the prompt path. cretli-ref chat=${CHAT_ID} seq=5`,
  '',
  `## ${SUMMARY_SECTIONS.EXACT_IDENTIFIERS}`,
  `- lib/context/history-summary.js. cretli-ref chat=${CHAT_ID} seq=6`,
].join('\n');

// --- 1. prompt is built from original events only, last N turns excluded -----

const built = buildSummaryPromptFromHistory(history, { chatId: CHAT_ID, keepsLastN: 2 });

assert.equal(typeof built.prompt, 'string');
assert.equal(built.kind, SUMMARY_KIND);
assert.equal(built.target, SUMMARY_TARGET);
assert.equal(built.chatId, CHAT_ID);
assert.equal(built.keepsLastN, 2);
assert.deepEqual([...built.summarizedSeqs], [1, 2, 3, 4]);
assert.deepEqual([...built.keptSeqs], [5, 6, 7, 8]);

// The older events are present, the last two turns are not.
for (const seq of [1, 2, 3, 4]) {
  assert.equal(built.prompt.includes(`[seq=${seq}]`), true, `summarized seq ${seq}`);
}
for (const seq of [5, 6, 7, 8]) {
  assert.equal(built.prompt.includes(`[seq=${seq}]`), false, `kept seq ${seq} must be excluded`);
}
assert.equal(built.prompt.includes('first question'), true);
assert.equal(built.prompt.includes('fourth answer'), false);
assert.equal(built.prompt.includes('Never summarize a previous summary'), true);
assert.equal(built.prompt.includes(`cretli-ref chat=${CHAT_ID} seq=<n>`), true);
for (const heading of Object.values(SUMMARY_SECTIONS)) {
  assert.equal(built.prompt.includes(`## ${heading}`), true, heading);
}

// The input is never mutated.
assert.deepEqual(history, historySnapshot);

// A saved contextSeed is a summary, so it is neither re-summarized nor shown.
const withSeed = [
  localUser(1, 'hello'),
  { seq: 2, rec: { kind: 'meta', variant: 'contextSeed', payload: 'PRIOR-SUMMARY-SECRET' } },
  assistant(3, 'hi'),
  localUser(4, 'next'),
  assistant(5, 'done'),
];
const seeded = buildSummaryPromptFromHistory(withSeed, { chatId: CHAT_ID, keepsLastN: 1 });
assert.equal(seeded.prompt.includes('PRIOR-SUMMARY-SECRET'), false);
assert.equal([...seeded.summarizedSeqs].includes(2), false);

// --- 2. never summarize a summary -------------------------------------------

const parsedValid = parseSummaryResult(VALID_SUMMARY);
assert.throws(() => buildSummaryPromptFromHistory(parsedValid), TypeError);
assert.throws(() => buildSummaryPromptFromHistory([parsedValid]), TypeError);
assert.throws(
  () => buildSummaryPromptFromHistory([{ seq: 1, rec: { kind: SUMMARY_KIND, sections: { goal: 'x' } } }]),
  TypeError,
);
assert.throws(() => buildSummaryPromptFromHistory('not-an-array'), TypeError);
assert.throws(() => parseSummaryResult(parsedValid), TypeError);
assert.throws(() => parseSummaryResult({ kind: SUMMARY_KIND, sections: { goal: 'x' }, items: [] }), TypeError);
assert.throws(() => parseSummaryResult(42), TypeError);

// --- 3. parser validates structure and extracts seq pointers -----------------

assert.equal(parsedValid.valid, true);
assert.equal(parsedValid.kind, SUMMARY_KIND);
assert.deepEqual([...parsedValid.missingSections], []);
assert.deepEqual([...parsedValid.missingPointerItems], []);
assert.equal(parsedValid.itemCount, 6);
assert.equal(parsedValid.pointerCount, 6);
assert.equal(parsedValid.sections.decisions.includes('Reuse the existing cheap provider'), true);

const goalItem = parsedValid.items.find((item) => item.section === 'goal');
assert.deepEqual(goalItem.ref, { chatId: CHAT_ID, seq: 1 });
const decisionItems = parsedValid.items.filter((item) => item.section === 'decisions');
assert.equal(decisionItems.length, 2);
assert.deepEqual(decisionItems.map((item) => item.ref.seq), [2, 3]);

// An item without a pointer is flagged and the summary is invalid.
const missingPointer = VALID_SUMMARY.replace(
  `- Keep the last N turns verbatim so the new session sees fresh output. cretli-ref chat=${CHAT_ID} seq=3`,
  `- Keep the last N turns verbatim so the new session sees fresh output. cretli-ref chat=${CHAT_ID} seq=3
- Extra decision without a source.`,
);
const parsedMissing = parseSummaryResult(missingPointer);
assert.equal(parsedMissing.valid, false);
assert.equal(parsedMissing.missingPointerItems.length, 1);
assert.equal(parsedMissing.missingPointerItems[0].section, 'decisions');

// A missing section is flagged.
const noOpenItems = VALID_SUMMARY.replace(`## ${SUMMARY_SECTIONS.OPEN_ITEMS}\n`, '').replace(
  `- Wire the concrete summarize seam into the prompt path. cretli-ref chat=${CHAT_ID} seq=5\n`,
  '',
);
const parsedNoSection = parseSummaryResult(noOpenItems);
assert.equal(parsedNoSection.missingSections.includes('openItems'), true);
assert.equal(parsedNoSection.valid, false);

// Tolerant headings/code fences are normalized.
const fenced = parseSummaryResult(`\`\`\`markdown\n${VALID_SUMMARY}\n\`\`\``);
assert.equal(fenced.valid, true);

// --- 4. deterministic seed: summary + stub trim + hint + last turns ----------

const stubHistory = [
  localUser(1, 'run it'),
  toolCall(2, 'bash', 'x'.repeat(5000)),
  toolCall(3, 'read', 'small'),
  assistant(4, 'done'),
];
const stubTrimmed = buildStubTrimmedHistory(stubHistory, { chatId: CHAT_ID, keepRecentToolResults: 1 });
assert.equal(stubTrimmed.target, 'new_session_first_prompt');
assert.equal(stubTrimmed.promptText.includes('[trimmed tool result: bash'), true);

const seedInput = {
  summary: parsedValid,
  stubTrimmed,
  lastTurns: [localUser(7, 'fourth question'), assistant(8, 'fourth answer')],
  chatId: CHAT_ID,
  contextEpoch: 5,
};
const seed = buildNewSessionSeedPrompt(seedInput);
const seedAgain = buildNewSessionSeedPrompt(seedInput);

assert.equal(seed.kind, SUMMARY_KIND);
assert.equal(seed.target, SUMMARY_TARGET);
assert.equal(seed.persisted, false);
assert.equal(seed.chatId, CHAT_ID);
assert.equal(seed.contextEpoch, 5);
assert.equal(seed.archiveCallCap, ARCHIVE_CALL_CAP_PER_TURN);
assert.equal(seed.prompt.includes(ARCHIVE_ACCESS_HINT), true);
assert.equal(seed.prompt.includes(`Cap archive calls (chat_event / chat_search) at ${ARCHIVE_CALL_CAP_PER_TURN} per turn.`), true);
assert.equal(seed.prompt.includes('wmem_add'), true);
assert.equal(seed.prompt.includes('TODO'), true);
assert.equal(seed.prompt.includes(`## ${SUMMARY_SECTIONS.GOAL}`), true);
assert.equal(seed.prompt.includes('Implement the pure summarizer with pointers.'), true);
assert.equal(seed.prompt.includes('## Trimmed history (deterministic stubs)'), true);
assert.equal(seed.prompt.includes('[trimmed tool result: bash'), true);
assert.equal(seed.prompt.includes('## Last turns (verbatim)'), true);
assert.equal(seed.prompt.includes('fourth answer'), true);
assert.equal(seed.prompt === seedAgain.prompt, true, 'seed assembly is deterministic');

// A summary string is accepted too and re-rendered deterministically.
const seedFromString = buildNewSessionSeedPrompt({ ...seedInput, summary: VALID_SUMMARY });
assert.equal(seedFromString.prompt.includes('Implement the pure summarizer with pointers.'), true);

// --- 5. new-session-only safeguard -------------------------------------------

assertNewSessionOnlySummary(seed);
assert.throws(() => assertNewSessionOnlySummary({ ...seed, target: 'live_session' }), TypeError);
assert.throws(() => assertNewSessionOnlySummary({ ...seed, persisted: true }), TypeError);
assert.throws(() => assertNewSessionOnlySummary(null), TypeError);

// A live-session stub-trim object cannot be embedded in a seed.
assert.throws(
  () => buildNewSessionSeedPrompt({ ...seedInput, stubTrimmed: { ...stubTrimmed, target: 'live_session' } }),
  TypeError,
);

// --- 6. gate: cold OR over threshold; unknown is not cold --------------------

const gateBase = { contextTokenThreshold: 1000, estimatedContextTokens: 10 };
assert.equal(shouldSummarize({ cacheState: { state: 'cold' }, ...gateBase }), true);
assert.equal(resolveSummaryGate({ cacheState: { state: 'cold' }, ...gateBase }).reason, SUMMARY_GATE_REASON.CACHE_COLD);
assert.equal(shouldSummarize({ cacheState: { state: 'warm' }, ...gateBase }), false);
assert.equal(resolveSummaryGate({ cacheState: { state: 'warm' }, ...gateBase }).reason, SUMMARY_GATE_REASON.CACHE_WARM);
assert.equal(
  shouldSummarize({ cacheState: { state: 'warm' }, contextTokenThreshold: 1000, estimatedContextTokens: 1000 }),
  true,
);
assert.equal(
  shouldSummarize({ cacheState: { state: 'unknown' }, ...gateBase }),
  false,
  'unknown is not cold',
);
assert.equal(
  shouldSummarize({ cacheState: { state: 'unknown' }, contextTokenThreshold: 1000, estimatedContextTokens: 5000 }),
  true,
);
// A string cache state is accepted and normalized.
assert.equal(shouldSummarize({ cacheState: 'cold', ...gateBase }), true);
assert.equal(shouldSummarize({ cacheState: 'warm', ...gateBase }), false);

// --- 7. epoch guard ----------------------------------------------------------

assert.equal(resolveSummaryEpochGuard({ summaryContextEpoch: 1, currentContextEpoch: 1 }).ok, true);
assert.equal(resolveSummaryEpochGuard({ summaryContextEpoch: 1, currentContextEpoch: 2 }).stale, true);
assert.equal(
  resolveSummaryEpochGuard({ summaryContextEpoch: 1, currentContextEpoch: 2 }).reason,
  'context_epoch_changed',
);
assert.equal(resolveSummaryEpochGuard({ summaryContextEpoch: 1 }).stale, false, 'unknown current is not stale');
assert.equal(
  assertSummaryEpochFresh({ contextEpoch: 4 }, { currentContextEpoch: 4 }).ok,
  true,
);
assert.throws(() => assertSummaryEpochFresh({ contextEpoch: 4 }, { currentContextEpoch: 5 }), TypeError);
assert.throws(() => assertSummaryEpochFresh(seed, { currentContextEpoch: 6 }), TypeError);

// --- 8. injected summarize seam ----------------------------------------------

let summarizeCalls = 0;
let capturedPrompt = '';
const fakeSummarize = async (prompt) => {
  summarizeCalls += 1;
  capturedPrompt = prompt;
  return VALID_SUMMARY;
};

const result = await summarizeHistoryFromOriginals({
  events: history,
  chatId: CHAT_ID,
  keepsLastN: 2,
  contextEpoch: 5,
  summarize: fakeSummarize,
});
assert.equal(result.kind, SUMMARY_KIND);
assert.equal(result.target, SUMMARY_TARGET);
assert.equal(result.persisted, false);
assert.equal(result.ok, true);
assert.equal(result.parsed.valid, true);
assert.equal(result.contextEpoch, 5);
assert.equal(capturedPrompt, result.promptMeta.prompt);
assert.equal(result.promptMeta.prompt.includes('[seq=4]'), true);
assert.equal(result.promptMeta.prompt.includes('[seq=5]'), false);
assert.equal(summarizeCalls, 1);

// The seam is required.
await assert.rejects(
  () => summarizeHistoryFromOriginals({ events: history, chatId: CHAT_ID }),
  TypeError,
);
assert.throws(() => createHistorySummarizer({}), TypeError);

const summarizer = createHistorySummarizer({ summarize: fakeSummarize });
const viaFactory = await summarizer.summarizeHistory({ events: history, chatId: CHAT_ID, keepsLastN: 2 });
assert.equal(viaFactory.ok, true);

// Nothing to summarize => the model is never called.
let nothingCalls = 0;
const nothing = await summarizeHistoryFromOriginals({
  events: [localUser(1, 'only turn'), assistant(2, 'only answer')],
  chatId: CHAT_ID,
  keepsLastN: 3,
  summarize: async () => {
    nothingCalls += 1;
    return VALID_SUMMARY;
  },
});
assert.equal(nothing.ok, false);
assert.equal(nothing.reason, 'nothing_to_summarize');
assert.equal(nothingCalls, 0);

// --- 9. durable facts extraction ---------------------------------------------

const facts = extractDurableFacts(parsedValid);
assert.equal(facts.length, 4);
assert.deepEqual(
  facts.map((fact) => fact.type),
  ['decision', 'decision', 'open_item', 'identifier'],
);
assert.deepEqual(facts[0].ref, { chatId: CHAT_ID, seq: 2 });
assert.equal(facts[0].text.startsWith('- '), false, 'bullet marker is stripped from the label');
assert.equal(extractDurableFacts(VALID_SUMMARY).length, 4);

console.log('history-summary tests passed');
