import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  billedTotalTokens,
  containsConversationContent,
  partitionUsageTokens,
  promptTokensForWindow,
  resolveUsageContract,
} from '../lib/usage/usage-contract.js';
import { fromOpenRouterUsage } from '../lib/usage/usage-normalize.js';
import { parseOpenRouterSseDataLine } from '../lib/providers/openrouter/openrouter-client.ts';

/**
 * Guards the OpenRouter usage/context audit (docs/usage-audits/openrouter.md).
 * Fixtures are sanitized shapes, not live captures.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'openrouter');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

test('every openrouter fixture is free of conversation content and secrets', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret/i, name);
  }
});

test('SSE parser extracts usage from the final chunk only', () => {
  const fx = read('raw-sse-usage-chunk.json');
  const chunks = fx.lines.map(parseOpenRouterSseDataLine);
  assert.equal(chunks[0].usage, undefined);
  assert.deepEqual(chunks[1].usage, fx.expectedUsage);
  assert.equal(chunks[1].finishReason, 'stop');
  assert.equal(chunks[2].usage, undefined);
});

test('usage-only chunk without choices is still surfaced', () => {
  const line = 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}';
  assert.deepEqual(parseOpenRouterSseDataLine(line).usage, { prompt_tokens: 5, completion_tokens: 1 });
});

test('fixture transform: raw usage -> disjoint bag -> contract buckets', () => {
  const fx = read('raw-sse-usage-chunk.json');
  const expected = read('normalized-token-bag.json');
  const bag = fromOpenRouterUsage(fx.expectedUsage);
  assert.deepEqual(bag, expected.tokens);
  const contract = resolveUsageContract('openrouter');
  assert.equal(contract.measurementKind, 'delta');
  assert.equal(contract.granularity, 'request');
  assert.equal(contract.payloadInputIncludesCache, true);
  const buckets = partitionUsageTokens(bag, contract);
  for (const [key, value] of Object.entries(expected.buckets)) assert.equal(buckets[key], value, key);
  assert.equal(promptTokensForWindow(bag, contract), expected.promptTokensForWindow);
  assert.equal(billedTotalTokens(bag, contract), expected.billedTotalTokens);
});

test('reasoning_tokens is not read by the normalizer (reported=false)', () => {
  const bag = fromOpenRouterUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } });
  assert.equal(bag.reasoning, 0);
  assert.equal(bag.textOutput, 5);
});

test('audit document exists and records the required sections', () => {
  const doc = path.join(root, 'docs', 'usage-audits', 'openrouter.md');
  assert.ok(existsSync(doc));
  const text = readFileSync(doc, 'utf8');
  for (const needle of ['[UNCONFIRMED]', 'streamOpenRouterChatCompletion', 'prompt_tokens_details', 'context_length']) {
    assert.ok(text.includes(needle), needle);
  }
});
