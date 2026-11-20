import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRealtimeTools } from '../lib/voice/action-registry.ts';
import { toGeminiFunctionDeclarations } from '../lib/voice/gemini-live-config.ts';
import { REALTIME_TOOLS } from '../lib/voice/realtime-session-config.ts';
import { estimateTokens, measureSchemaTokens } from '../scripts/voice-control-benchmark.mjs';

/**
 * The limits are the +25% over the §6.1 baseline from docs/voice-control-coverage.md §10.1
 * (OpenAI 2595 * 1.25 = 3244, Gemini 2278 * 1.25 = 2848), measured with the benchmark's chars/4 estimate.
 * Adding a tool must be paid for by shortening or merging others, never by raising these numbers.
 */
const OPENAI_TOOL_TOKEN_LIMIT = 3244;
const GEMINI_TOOL_TOKEN_LIMIT = 2848;

test('OpenAI Realtime tool schema stays within the token budget', () => {
  const tokens = estimateTokens(REALTIME_TOOLS);
  assert.equal(tokens, estimateTokens(buildRealtimeTools()));
  assert.ok(tokens <= OPENAI_TOOL_TOKEN_LIMIT, `OpenAI tool schema is ${tokens} tokens, limit ${OPENAI_TOOL_TOKEN_LIMIT}`);
});

test('Gemini Live function declarations stay within the token budget', () => {
  const tokens = estimateTokens(toGeminiFunctionDeclarations());
  assert.ok(tokens <= GEMINI_TOOL_TOKEN_LIMIT, `Gemini tool schema is ${tokens} tokens, limit ${GEMINI_TOOL_TOKEN_LIMIT}`);
});

test('the benchmark reports the same numbers the budget test enforces', () => {
  for (const row of measureSchemaTokens()) {
    if (row.backend === 'gemini') assert.ok(row.tools <= GEMINI_TOOL_TOKEN_LIMIT, `${row.backend} ${row.lang}`);
    else assert.ok(row.tools <= OPENAI_TOOL_TOKEN_LIMIT, `${row.backend} ${row.lang}`);
  }
});
