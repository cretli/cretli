import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsConversationContent, resolveUsageContract } from '../lib/usage/usage-contract.js';
import { fromCodexUsage } from '../lib/usage/usage-normalize.js';
import { normalizeCodexThreadEvent } from '../lib/agent-harness/codex-event-normalizer.ts';
import { parseCodexContextUsage } from '../lib/codex/codex-context-usage.ts';

/** Guards the Codex usage/context audit (docs/usage-audits/codex.md). Fixtures are sanitized shapes. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'codex');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
const toLines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('every codex fixture is free of conversation content, secrets and private paths', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 3);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret|\/home\/|192\.168\./i, name);
  }
});

test('fixture transform: SDK turn.completed -> usage event -> disjoint token bag (cache subtracted from input)', () => {
  const fx = read('raw-sdk-turn-completed.json');
  const expected = read('normalized-token-bag.json');
  const events = fx.events.flatMap((e) => normalizeCodexThreadEvent(e));
  const usage = events.find((e) => e.kind === 'usage');
  assert.deepEqual(usage.usage, expected.rawUsage);
  assert.deepEqual(fromCodexUsage(usage.usage), expected.tokens);
  const c = resolveUsageContract('codex');
  assert.equal(c.payloadInputIncludesCache, true);
  assert.equal(c.granularity, 'turn');
  assert.equal(c.reasoningReported, true);
});

test('fixture transform: rollout token_count -> context_usage uses last_token_usage, not the cumulative total', () => {
  const fx = read('raw-rollout-token-count.json');
  const expected = read('normalized-token-bag.json');
  const ev = parseCodexContextUsage(toLines(fx.records), 'fallback::variant');
  assert.deepEqual(ev, expected.contextUsage);
  assert.equal(ev.usage.inputTokens, 1300);
  assert.equal(ev.sessionUsage.inputTokens, 2300);
  assert.equal(ev.contextWindowTokens, 258400);
});

test('a repeated identical token_count does not become a new call; session totals stay reconciliation only', () => {
  const fx = read('raw-rollout-token-count.json');
  const ev = parseCodexContextUsage(toLines(fx.records.slice(0, 4)));
  assert.equal(ev.usage.totalTokens, 1050);
  assert.equal(ev.sessionUsage.totalTokens, 1050);
});

test('compacted marker resets occupancy and flags the next reading with compactedAt', () => {
  const fx = read('raw-rollout-token-count.json');
  const reset = parseCodexContextUsage(toLines([...fx.records, fx.afterCompaction[0]]));
  assert.equal(reset.reset, true);
  assert.equal(reset.usage, undefined);
  const after = parseCodexContextUsage(toLines([...fx.records, ...fx.afterCompaction]));
  assert.equal(after.compactedAt, '2026-01-01T00:00:05.000Z');
  assert.equal(after.usage.inputTokens, 500);
});

test('invalid counters are rejected rather than coerced to zero', () => {
  const rec = { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: -1, total_tokens: 5 } } } };
  assert.equal(parseCodexContextUsage(toLines([rec])), null);
});

test('audit document exists and records the required sections', () => {
  const doc = path.join(root, 'docs', 'usage-audits', 'codex.md');
  assert.ok(existsSync(doc));
  const text = readFileSync(doc, 'utf8');
  for (const needle of ['[UNCONFIRMED]', 'fromCodexUsage', 'parseCodexContextUsage', 'last_token_usage', 'total_token_usage', 'model_context_window', 'cached_input_tokens', 'cache_write_input_tokens', 'compacted', '@openai/codex-sdk', '0.160.0', 'resumeThread', 'thread.tokenUsage/updated', 'granularity']) {
    assert.ok(text.includes(needle), needle);
  }
});
