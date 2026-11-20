import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsConversationContent, resolveUsageContract } from '../lib/usage/usage-contract.js';
import { fromQwenUsage } from '../lib/usage/usage-normalize.js';
import { createQwenEventNormalizer, normalizeQwenMessage } from '../harnesses/qwen/qwen-event-normalizer.js';

/** Guards the Qwen usage/context audit (docs/usage-audits/qwen.md). Fixtures are sanitized shapes. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'qwen');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

test('every qwen fixture is free of conversation content, secrets and private paths', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret|\/home\/|192\.168\./i, name);
  }
});

test('per-assistant usage events are emitted; result.usage is ignored once they were seen', () => {
  const fx = read('raw-stream-usage.json');
  const n = createQwenEventNormalizer();
  const usages = fx.records.flatMap((r) => n.normalize(r)).filter((e) => e.kind === 'usage');
  assert.equal(usages.length, 2);
  assert.deepEqual(usages.map((e) => e.usage), [fx.records[0].message.usage, fx.records[1].message.usage]);
});

test('result.usage is the fallback (with durationMs) only when no assistant usage arrived', () => {
  const fx = read('raw-stream-usage.json');
  const events = normalizeQwenMessage(fx.resultOnlyRecord);
  const usage = events.find((e) => e.kind === 'usage');
  assert.deepEqual(usage.usage, fx.resultOnlyRecord.usage);
  assert.equal(usage.durationMs, 900);
});

test('fixture transform: raw usage -> disjoint token bag (cache subtracted from input)', () => {
  const fx = read('raw-stream-usage.json');
  const expected = read('normalized-token-bag.json');
  assert.deepEqual(fromQwenUsage(fx.records[0].message.usage), expected.tokens[0]);
  assert.deepEqual(fromQwenUsage(fx.records[1].message.usage), expected.tokens[1]);
  assert.deepEqual(fromQwenUsage(expected.ephemeralBreakdown.raw), expected.ephemeralBreakdown.tokens);
  const c = resolveUsageContract('qwen');
  assert.equal(c.measurementKind, 'delta');
  assert.equal(c.payloadInputIncludesCache, true);
  assert.equal(c.reasoningReported, false);
});

test('compact_boundary surfaces a compact notice with pre_tokens', () => {
  const events = normalizeQwenMessage({ type: 'system', subtype: 'compact_boundary', session_id: 'qwen-sess-1', compact_metadata: { trigger: 'auto', pre_tokens: 5000 } });
  const notice = events.find((e) => e.kind === 'notice');
  assert.equal(notice.noticeType, 'compact');
  assert.equal(notice.preTokens, 5000);
});

test('audit document exists and records the required sections', () => {
  const doc = path.join(root, 'docs', 'usage-audits', 'qwen.md');
  assert.ok(existsSync(doc));
  const text = readFileSync(doc, 'utf8');
  for (const needle of ['[UNCONFIRMED]', 'fromQwenUsage', 'cache_read_input_tokens', 'contextWindow', 'compact_boundary', '@qwen-code/sdk', 'sawAssistantUsage', 'qwenlm.github.io', 'ephemeral_1h_input_tokens', 'service_tier', 'web_search_requests']) {
    assert.ok(text.includes(needle), needle);
  }
});
