import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsConversationContent, resolveUsageContract } from '../lib/usage/usage-contract.js';
import { fromClaudeUsage } from '../lib/usage/usage-normalize.js';
import {
  createClaudeEventNormalizer,
  readClaudeModelContextWindow,
  resolveClaudeResultUsage,
  resolveClaudeUsageBag,
} from '../lib/agent-harness/claude-event-normalizer.ts';

/** Guards the Claude usage/context audit (docs/usage-audits/claude.md). Fixtures are sanitized shapes. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'claude');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

function runRecords(records) {
  const n = createClaudeEventNormalizer();
  return records.flatMap((r) => n.normalize(r));
}

test('every claude fixture is free of conversation content, secrets and private paths', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret|\/home\/|192\.168\./i, name);
  }
});

test('fixture transform: raw usage -> resolved bag (cache ADDED to input) -> disjoint token bag', () => {
  const fx = read('raw-stream-usage.json');
  const expected = read('normalized-token-bag.json');
  const result = fx.records.at(-1);
  assert.deepEqual(resolveClaudeResultUsage(result), expected.resolved.resultUsage);
  assert.deepEqual(resolveClaudeUsageBag(fx.records[3].message.usage), expected.resolved.secondCall);
  assert.deepEqual(fromClaudeUsage(expected.resolved.resultUsage), expected.tokens.resultUsage);
  const c = resolveUsageContract('claude');
  assert.equal(c.payloadInputIncludesCache, true);
  assert.equal(c.reasoningReported, false);
});

test('per-call context_usage events track the newest call; the largest output per message id wins', () => {
  const fx = read('raw-stream-usage.json');
  const expected = read('normalized-token-bag.json');
  const events = runRecords(fx.records).filter((e) => e.kind === 'context_usage');
  assert.deepEqual(events, expected.contextEvents);
});

test('result usage is final, carries last-call usage and the modelUsage context window; first call is exposed', () => {
  const fx = read('raw-stream-usage.json');
  const events = runRecords(fx.records.filter((r) => r.subtype !== 'compact_boundary'));
  const usage = events.find((e) => e.kind === 'usage');
  assert.equal(usage.final, true);
  assert.equal(usage.totalCostUsd, 0.01);
  assert.equal(usage.lastCallContextWindowTokens, 200000);
  assert.equal(usage.lastCallUsage.cacheReadTokens, 900);
  assert.equal(usage.firstApiCallUsage.cacheWriteTokens, 900);
  assert.equal(events.filter((e) => e.kind === 'api_call_usage').length, 1);
  assert.equal(readClaudeModelContextWindow(fx.records.at(-1).modelUsage, 'claude-model-x'), 200000);
  assert.equal(readClaudeModelContextWindow(fx.records.at(-1).modelUsage, 'other'), null);
});

test('compact_boundary emits a notice with pre/post tokens and clears the last-call context', () => {
  const fx = read('raw-stream-usage.json');
  const events = runRecords(fx.records);
  const notice = events.find((e) => e.kind === 'notice' && e.noticeType === 'compact');
  assert.equal(notice.preTokens, 5000);
  assert.equal(notice.postTokens, 800);
  assert.equal(notice.trigger, 'auto');
  const usage = events.find((e) => e.kind === 'usage');
  assert.equal(usage.lastCallUsage, undefined);
});

test('subagent (parent_tool_use_id) assistant usage never becomes main-thread context', () => {
  const events = runRecords([{ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'msg_s', model: 'claude-model-x', usage: { input_tokens: 5, output_tokens: 5 } } }]);
  assert.equal(events.filter((e) => e.kind === 'context_usage' || e.kind === 'api_call_usage').length, 0);
});

test('audit document exists and records the required sections', () => {
  const doc = path.join(root, 'docs', 'usage-audits', 'claude.md');
  assert.ok(existsSync(doc));
  const text = readFileSync(doc, 'utf8');
  for (const needle of ['[UNCONFIRMED]', 'resolveClaudeUsageBag', 'fromClaudeUsage', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'contextWindow', 'compact_boundary', '@anthropic-ai/claude-agent-sdk', '0.3.300', '2.1.300', 'getContextUsage', 'modelUsage', 'forkSession', 'granularity']) {
    assert.ok(text.includes(needle), needle);
  }
});
