import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsConversationContent, resolveUsageContract } from '../lib/usage/usage-contract.js';
import { fromDeepSeekUsage } from '../lib/usage/usage-normalize.js';
import { normalizeDeepSeekNotification } from '../harnesses/deepseek/deepseek-event-normalizer.js';

/**
 * Guards the DeepSeek usage/context audit (docs/usage-audits/deepseek.md).
 * Fixtures are sanitized shapes, not live captures.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'deepseek');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

test('every deepseek fixture is free of conversation content and secrets', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret/i, name);
  }
});

test('fixture transform: DSH session.event -> synthetic usage event -> disjoint bag', () => {
  const fx = read('dsh-session-events.json');
  const events = normalizeDeepSeekNotification(fx.rootEvent);
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage, 'assistant/message surfaces a usage event');
  assert.notEqual(usage.consolidated, true);
  assert.deepEqual(fromDeepSeekUsage(usage.usage), fx.expectedBag);
});

test('fixture transform: raw wire usage subtracts cache hits from prompt_tokens', () => {
  const fx = read('raw-wire-usage.json');
  const wire = fromDeepSeekUsage(fx.wireUsage);
  assert.equal(wire.cachedInput, 600);
  assert.equal(wire.textInput, 400);
  assert.equal(wire.textOutput, 50);
  assert.equal(wire.reasoning, 10);
  // The DSH camelCase form of the same call yields the same disjoint input/cache split.
  const dsh = fromDeepSeekUsage(fx.dshTokenUsage);
  assert.equal(dsh.textInput, wire.textInput);
  assert.equal(dsh.cachedInput, wire.cachedInput);
});

test('prompt occupancy of one call is input + cacheRead, not the billed total', () => {
  const fx = read('dsh-session-events.json');
  const u = fx.rootEvent.params.event.data.usage;
  assert.equal(u.inputTokens + u.cacheReadTokens, fx.promptTokensForWindow);
  assert.equal(u.inputTokens + u.cacheReadTokens + u.outputTokens, fx.billedTotalTokens);
});

test('usage contract: delta per message, cache-disjoint payload', () => {
  const c = resolveUsageContract('deepseek');
  assert.equal(c.measurementKind, 'delta');
  assert.equal(c.granularity, 'message');
  assert.equal(c.payloadInputIncludesCache, false);
});

test('audit document exists and records the required sections', () => {
  const doc = path.join(root, 'docs', 'usage-audits', 'deepseek.md');
  assert.ok(existsSync(doc));
  const text = readFileSync(doc, 'utf8');
  for (const needle of ['[UNCONFIRMED]', 'fromDeepSeekUsage', 'prompt_cache_hit_tokens', 'contextWindow', 'thresholdRatio', '@deepseek-ai/dsh', '0.1.2-alpha.5']) {
    assert.ok(text.includes(needle), needle);
  }
});
