import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  billedTotalTokens,
  containsConversationContent,
  partitionUsageTokens,
  promptTokensForWindow,
  resolveUsageContract,
  resolveWindowSemantics,
} from '../lib/usage/usage-contract.js';
import { fromOpenCodeUsage } from '../lib/usage/usage-normalize.js';
import {
  resolveOpenCodeUsageFromStreamEvent,
} from '../harnesses/opencode/opencode-usage.js';

/**
 * Guards the OpenCode usage/context audit (docs/usage-audits/opencode.md).
 * Fixtures are sanitized shapes, not live captures.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests', 'fixtures', 'usage', 'opencode');
const docPath = path.join(root, 'docs', 'usage-audits', 'opencode.md');
const read = (name) => JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));

test('every opencode fixture is free of conversation content and secrets', () => {
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith('.json'));
  assert.ok(files.length >= 3);
  for (const name of files) {
    const fixture = read(name);
    assert.equal(containsConversationContent(fixture), false, name);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-|api[_-]?key|bearer|password|secret/i, name);
  }
});

test('message.updated snapshots transform to per-message deltas', () => {
  const fx = read('raw-message-updated-sequence.json');
  const seen = new Map();
  const deltas = fx.sequence.map((ev) => resolveOpenCodeUsageFromStreamEvent(ev, seen)?.delta);
  assert.deepEqual(deltas, fx.expectedDeltas);
  // Replaying an identical snapshot yields nothing (no double counting).
  assert.equal(resolveOpenCodeUsageFromStreamEvent(fx.sequence[1], seen), null);
});

test('a snapshot that shrinks (compaction/reset of the message) is clamped to zero', () => {
  const seen = new Map();
  const mk = (out) => ({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', tokens: { input: 10, output: out, reasoning: 0, cache: { read: 0, write: 0 } } } } });
  resolveOpenCodeUsageFromStreamEvent(mk(50), seen);
  assert.equal(resolveOpenCodeUsageFromStreamEvent(mk(20), seen), null);
  // The baseline was overwritten with the lower value, so a later rise
  // re-counts the difference from 20, not from 50.
  const regrown = resolveOpenCodeUsageFromStreamEvent(mk(35), seen);
  assert.equal(regrown.delta.output, 15);
});

test('user-role messages and events without tokens are ignored', () => {
  const seen = new Map();
  assert.equal(resolveOpenCodeUsageFromStreamEvent({ type: 'message.updated', properties: { info: { id: 'u1', role: 'user' } } }, seen), null);
  assert.equal(resolveOpenCodeUsageFromStreamEvent({ type: 'session.idle', properties: {} }, seen), null);
});

test('v2 sync-wrapped step.ended is unwrapped and diffed per assistant message', () => {
  const fx = read('raw-step-ended-v2.json');
  const seen = new Map();
  const resolved = resolveOpenCodeUsageFromStreamEvent(fx.event, seen);
  assert.equal(resolved.messageId, 'msg_fixture_0002');
  assert.deepEqual(resolved.delta, fx.expectedDelta);
  assert.deepEqual(resolved.sdkEvent.usage.tokens, {
    input: 800, output: 40, reasoning: 10, cache: { read: 600, write: 0 },
  });
});

test('normalized bag and contract buckets match the documented values', () => {
  const fx = read('normalized-token-bag.json');
  const last = read('raw-message-updated-sequence.json').sequence[1].properties.info.tokens;
  const bag = fromOpenCodeUsage(last);
  assert.deepEqual(bag, fx.tokens);
  assert.equal(resolveWindowSemantics('opencode'), 'disjoint');
  assert.deepEqual(partitionUsageTokens(bag, 'opencode'), {
    ...fx.buckets, reasoningDiagnostic: false, audioInput: 0, audioOutput: 0,
  });
  assert.equal(promptTokensForWindow(bag, 'opencode'), fx.promptTokensForWindow);
  assert.equal(billedTotalTokens(bag, 'opencode'), fx.billedTotalTokens);
  const c = resolveUsageContract('opencode');
  assert.equal(c.measurementKind, 'snapshot');
  assert.equal(c.granularity, 'message');
  assert.equal(c.payloadInputIncludesCache, false);
  assert.deepEqual(c.identityFields, ['sourceSessionId', 'messageId']);
});

test('the audit document exists and names version, sources and evidence tags', () => {
  assert.equal(existsSync(docPath), true);
  const doc = readFileSync(docPath, 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', '@opencode-ai', 'sdk', 'package.json'), 'utf8'));
  const v = pkg.version.replace(/\./g, '\\.');
  assert.match(doc, new RegExp(`@opencode-ai/sdk[^\\n]*(?<!\\^)\\b${v}\\b`));
  for (const needle of [
    'https://opencode.ai/docs', 'harnesses/opencode/opencode-usage.js',
    'readOpenCodeTokenSnapshot', 'fromOpenCodeUsage', 'message.updated',
    'session.next.step.ended', 'session.compacted', 'limit.context',
    'noteOpenCodeUsageFromEvent', 'opencode-compaction-config.js',
  ]) assert.ok(doc.includes(needle), `doc must reference ${needle}`);
  for (const tag of ['[OBSERVED]', '[DECLARED]', '[DOC]', '[UNCONFIRMED]']) {
    assert.ok(doc.includes(tag), `doc must use ${tag}`);
  }
});
