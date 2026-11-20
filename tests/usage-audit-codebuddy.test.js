import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { containsConversationContent, resolveUsageContract } from '../lib/usage/usage-contract.js';
import { fromClaudeUsage } from '../lib/usage/usage-normalize.js';
import { resolveClaudeResultUsage } from '../lib/agent-harness/claude-event-normalizer.ts';
import { createCodeBuddyUsageState, normalizeCodeBuddyMessage } from '../harnesses/codebuddy/codebuddy-event-normalizer.js';

/**
 * Guards the CodeBuddy usage/context audit (docs/usage-audits/codebuddy.md).
 * Fixtures are sanitized shapes, not live captures.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'codebuddy');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

test('every codebuddy fixture is free of conversation content and secrets', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret/i, name);
  }
});

test('stream records: partial + completed snapshots of one message count once; result ignored after measured usage', () => {
  const fx = read('raw-stream-usage.json');
  const state = createCodeBuddyUsageState();
  const usages = fx.records
    .flatMap((rec) => normalizeCodeBuddyMessage(rec, state))
    .filter((e) => e.kind === 'usage')
    .map((e) => e.usage);
  assert.deepEqual(usages, fx.expectedUsageEvents);
});

test('result.usage is the fallback only when no message usage arrived', () => {
  const state = createCodeBuddyUsageState();
  const events = normalizeCodeBuddyMessage({ type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: 3 } }, state);
  assert.deepEqual(events.find((e) => e.kind === 'usage').usage, { input_tokens: 7, output_tokens: 3 });
});

test('fixture transform: raw usage -> resolved (cache added to input) -> disjoint bag', () => {
  const fx = read('raw-stream-usage.json');
  const expected = read('normalized-token-bag.json');
  const raw = fx.records[2].message.usage;
  const resolved = resolveClaudeResultUsage({ usage: raw });
  assert.equal(resolved.inputTokens, 120);
  assert.equal(resolved.cacheReadTokens, 20);
  assert.deepEqual(fromClaudeUsage(resolved), expected.tokens);
  const contract = resolveUsageContract('codebuddy');
  assert.equal(contract.measurementKind, 'delta');
  assert.equal(contract.granularity, 'message');
});

test('compact_boundary surfaces a compact notice with pre_tokens', () => {
  const events = normalizeCodeBuddyMessage({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 5000 } });
  const notice = events.find((e) => e.kind === 'notice');
  assert.equal(notice.noticeType, 'compact');
  assert.equal(notice.preTokens, 5000);
});

test('audit document exists and records the required sections', () => {
  const doc = path.join(root, 'docs', 'usage-audits', 'codebuddy.md');
  assert.ok(existsSync(doc));
  const text = readFileSync(doc, 'utf8');
  for (const needle of ['[UNCONFIRMED]', 'readMessageUsage', 'cache_creation_input_tokens', 'maxInputTokens', 'compact_boundary', '@tencent-ai/agent-sdk']) {
    assert.ok(text.includes(needle), needle);
  }
});
