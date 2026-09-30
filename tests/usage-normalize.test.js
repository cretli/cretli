import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyUsageTokens } from '../lib/usage/usage-event.js';
import {
  deltaTokens,
  fromClaudeUsage,
  fromCodexUsage,
  fromGeminiLiveUsage,
  fromOpenAiRealtimeUsage,
  fromOpenRouterUsage,
  fromSdkUsage,
  mapProviderToHarness,
  readGeminiLiveCumulative,
} from '../lib/usage/usage-normalize.js';

function makeRealtimeUsage(counts) {
  return {
    input_token_details: {
      audio_tokens: counts.audioIn || 0,
      text_tokens: counts.textIn || 0,
      cached_tokens: counts.cached || 0,
      cached_tokens_details: { audio_tokens: counts.cachedAudio || 0, text_tokens: 0 },
    },
    output_token_details: {
      audio_tokens: counts.audioOut || 0,
      text_tokens: counts.textOut || 0,
    },
  };
}

test('maps OpenAI realtime audio input', () => {
  const actual = fromOpenAiRealtimeUsage(makeRealtimeUsage({ audioIn: 1_000_000 }));
  assert.equal(actual.audioInput, 1_000_000);
  assert.equal(actual.textInput, 0);
});

test('subtracts cached audio so it is not billed twice', () => {
  const actual = fromOpenAiRealtimeUsage(
    makeRealtimeUsage({ audioIn: 1_000_000, cached: 1_000_000, cachedAudio: 1_000_000 })
  );
  assert.equal(actual.cachedInput, 1_000_000);
  assert.equal(actual.audioInput, 0);
});

test('Gemini usageMetadata is a delta against the last snapshot', () => {
  const first = {
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
    candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 20 }],
  };
  const second = {
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 250 }],
    candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 50 }],
  };
  const firstDelta = fromGeminiLiveUsage(first);
  assert.equal(firstDelta.audioInput, 100);
  assert.equal(firstDelta.textOutput, 20);
  const previous = readGeminiLiveCumulative(first);
  const secondDelta = fromGeminiLiveUsage(second, previous);
  assert.equal(secondDelta.audioInput, 150);
  assert.equal(secondDelta.textOutput, 30);
});

test('maps OpenRouter prompt and completion tokens', () => {
  const actual = fromOpenRouterUsage({ prompt_tokens: 40, completion_tokens: 12 });
  assert.equal(actual.textInput, 40);
  assert.equal(actual.textOutput, 12);
});

test('maps Cursor SDK usage including cache and reasoning', () => {
  const actual = fromSdkUsage({
    inputTokens: 1000,
    outputTokens: 80,
    cacheReadTokens: 200,
    reasoningTokens: 15,
  });
  assert.equal(actual.textInput, 1000);
  assert.equal(actual.textOutput, 80);
  assert.equal(actual.cachedInput, 200);
  assert.equal(actual.reasoning, 15);
});

test('deltaTokens never goes negative', () => {
  const actual = deltaTokens(
    { ...emptyUsageTokens(), textInput: 5 },
    { ...emptyUsageTokens(), textInput: 9 }
  );
  assert.equal(actual.textInput, 0);
});

test('maps Codex turn usage without double-counting cached input', () => {
  const actual = fromCodexUsage({
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 250,
    reasoning_output_tokens: 30,
  });
  assert.equal(actual.textInput, 600);
  assert.equal(actual.cachedInput, 400);
  assert.equal(actual.textOutput, 250);
  assert.equal(actual.reasoning, 30);
});

test('maps resolved Claude usage without double-counting cache reads', () => {
  const actual = fromClaudeUsage({
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
  });
  assert.equal(actual.textInput, 400);
  assert.equal(actual.cachedInput, 600);
  assert.equal(actual.textOutput, 200);
});

test('maps legacy providers to harnesses and falls back to unknown', () => {
  assert.equal(mapProviderToHarness('cursor'), 'sdk');
  assert.equal(mapProviderToHarness('openrouter'), 'openrouter');
  assert.equal(mapProviderToHarness('openai'), 'voice');
  assert.equal(mapProviderToHarness('anthropic'), 'unknown');
  assert.equal(mapProviderToHarness(''), 'unknown');
});
