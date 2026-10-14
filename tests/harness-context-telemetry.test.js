import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recordHarnessContextSample, readHarnessContextSamples, summarizeHarnessContextSamples } from '../lib/usage/harness-context-telemetry.js';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { buildHarnessHealth } from '../lib/usage/harness-health.js';
import { fromCodexUsage } from '../lib/usage/usage-normalize.js';

const room = { chatId: 'test-chat', _runId: 'test-run', cwd: 'example-workspace', modelId: 'test-model' };
const event = { type: 'context_usage', observedAt: new Date().toISOString(), model: 'test-model', usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 800 }, contextWindowTokens: 10000, breakdown: { complete: true, rows: [{ id: 'messages', tokens: 900, count: 3, estimated: true, text: 'private-text' }] } };

test('global context store persists identity and numeric breakdown without raw text or duplicate samples', () => {
  recordHarnessContextSample({ room, harness: 'codex', event });
  recordHarnessContextSample({ room, harness: 'codex', event });
  const samples = readHarnessContextSamples({ harness: 'codex', chatId: room.chatId });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].runId, 'test-run');
  assert.equal(samples[0].cacheReadTokens, 800);
  assert.equal(samples[0].breakdown.rows[0].text, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(ISOLATED_DATA_DIR, 'usage/context-samples.jsonl'), 'utf8'), /private-text/);
  assert.equal(readHarnessContextSamples({ harness: 'qwen' }).length, 0);
  assert.equal(readHarnessContextSamples({ model: 'other' }).length, 0);
});

test('refined readings replace the same observation; new epochs and harnesses remain separate', () => {
  const update = { ...event, breakdown: { complete: false, rows: [] } };
  recordHarnessContextSample({ room, harness: 'codex', event: update });
  assert.equal(readHarnessContextSamples({ harness: 'codex' }).length, 1);
  recordHarnessContextSample({ room: { ...room, _contextEpoch: 1 }, harness: 'codex', event });
  recordHarnessContextSample({ room, harness: 'qwen', event });
  assert.equal(readHarnessContextSamples({ harness: 'codex' }).length, 2);
  assert.equal(readHarnessContextSamples({ harness: 'qwen' }).length, 1);
  assert.equal(recordHarnessContextSample({ room: { ...room, _runStartedAt: Date.parse(event.observedAt) + 1000 }, harness: 'codex', event }), null);
  assert.equal(recordHarnessContextSample({ room, harness: 'codex', event: { reset: true } }), null);
});

test('occupancy summaries average/peak samples while ledger cache totals remain independently counted', () => {
  const summary = summarizeHarnessContextSamples([{ chatId: 'a', totalTokens: 1000, contextWindowTokens: 10000, observedAt: 'a' }, { chatId: 'b', totalTokens: 3000, contextWindowTokens: 10000, observedAt: 'b' }]);
  assert.equal(summary.averageFillPercent, 20);
  assert.equal(summary.peakFillPercent, 30);
  assert.equal(summary.chats, 2);
  const tokens = fromCodexUsage({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 });
  const health = buildHarnessHealth({ harness: 'codex', events: [{ at: new Date().toISOString(), eventType: 'delta', harness: 'codex', tokens }], contextSamples: [] });
  assert.equal(health.tokenUsage.inputTokens, 1000);
  assert.equal(health.tokenUsage.cacheReadTokens, 800);
  assert.equal(health.tokenUsage.cacheHitPercent, 80);
});

test('kernel records context samples without generating billing deltas', () => {
  const billed = [];
  const kernel = createAgentRoomKernel({ transport: 'codex', recordUsage: (row) => billed.push(row), persistHistory: () => {} });
  const kernelRoom = kernel.createRoomState({ ...room, chatId: 'kernel-chat', sessionKey: 'session' });
  kernel.broadcastRoom(kernelRoom, { type: 'sdkEvent', event });
  kernel.flushPersistBuffer(kernelRoom);
  assert.equal(readHarnessContextSamples({ chatId: 'kernel-chat' }).length, 1);
  assert.equal(billed.length, 0);
});


test('a torn journal tail cannot swallow the next valid sample', () => {
  const file = path.join(ISOLATED_DATA_DIR, 'usage/context-samples.jsonl');
  fs.appendFileSync(file, '{"broken":');
  const later = { ...event, observedAt: new Date(Date.parse(event.observedAt) + 2000).toISOString() };
  recordHarnessContextSample({ room: { ...room, chatId: 'recovery-chat' }, harness: 'codex', event: later });
  const validRows = fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.ok(validRows.some((row) => row.chatId === 'recovery-chat'));
});


test('response identity replaces repeated reports and cumulative/session counters remain a separate plane', () => {
  const current = { ...event, measurementId: 'unique-response', turnId: 'turn-1', sessionUsage: { inputTokens: 999000, cacheReadTokens: 900000 }, usage: { ...event.usage, cacheWriteTokens: 100, reasoningTokens: 50 } };
  recordHarnessContextSample({ room: { ...room, chatId: 'response-chat' }, harness: 'codex', event: current });
  recordHarnessContextSample({ room: { ...room, chatId: 'response-chat' }, harness: 'codex', event: { ...current, observedAt: new Date(Date.parse(current.observedAt) + 1000).toISOString() } });
  const rows = readHarnessContextSamples({ chatId: 'response-chat' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turnId, 'turn-1');
  assert.equal(rows[0].sessionUsage.inputTokens, 999000);
  assert.equal(rows[0].inputTokens, 1000);
  assert.equal(rows[0].cacheWriteTokens, 100);
  assert.equal(rows[0].reasoningTokens, 50);
});
