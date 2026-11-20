import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordHarnessContextSample, readHarnessContextSamples, summarizeHarnessContextSamples } from '../lib/usage/harness-context-telemetry.ts';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { buildHarnessHealth } from '../lib/usage/harness-health.ts';
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

// --- store maintenance (isolated data dirs; the cache is keyed by file path) ---
function makeStoreDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-telemetry-'));
  fs.mkdirSync(path.join(dir, 'usage'), { recursive: true });
  return { dir, file: path.join(dir, 'usage', 'context-samples.jsonl') };
}
function seedRow(id, observedAt, extra = {}) {
  return { v: 1, id, harness: 'codex', chatId: `chat-${id}`, runId: '', observedAt, inputTokens: 10, totalTokens: 11, ...extra };
}
function seedFile(file, rows) { fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n'); }
function recordAt(dir, chatId, observedAt, extra = {}) {
  return recordHarnessContextSample({ room: { chatId, _runId: 'r', cwd: 'example-workspace' }, harness: 'codex', event: { ...event, observedAt, ...extra }, dataDir: dir });
}
const fileRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const isSorted = (rows) => rows.every((row, i) => i === 0 || rows[i - 1].observedAt <= row.observedAt);

test('an identical sample returns the stored row and does not append a second line', () => {
  const { dir, file } = makeStoreDir();
  // One timestamp for both calls: two isoAgo() calls can straddle a millisecond
  // under load and stop being identical samples.
  const sampledAt = isoAgo(1000);
  const first = recordAt(dir, 'dup-chat', sampledAt);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  const second = recordAt(dir, 'dup-chat', sampledAt);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, lines);
});

test('rows older than the 92 day retention disappear after the next write', () => {
  const { dir, file } = makeStoreDir();
  seedFile(file, [seedRow('old', isoAgo(93 * 86400000)), seedRow('fresh', isoAgo(86400000))]);
  assert.equal(readHarnessContextSamples({ dataDir: dir }).length, 2);
  recordAt(dir, 'retention-chat', isoAgo(1000));
  const ids = readHarnessContextSamples({ dataDir: dir }).map((row) => row.id);
  assert.equal(ids.includes('old'), false);
  assert.equal(ids.length, 2);
});

test('the store keeps at most MAX_SAMPLES rows and drops the oldest', () => {
  const { dir, file } = makeStoreDir();
  const MAX_SAMPLES = 5000; // mirrors MAX_SAMPLES in harness-context-telemetry.ts
  const base = Date.now() - 2 * 86400000;
  seedFile(file, Array.from({ length: MAX_SAMPLES }, (_, i) => seedRow(`s${i}`, new Date(base + i * 1000).toISOString())));
  recordAt(dir, 'limit-chat', isoAgo(1000));
  const rows = readHarnessContextSamples({ dataDir: dir });
  assert.equal(rows.length, MAX_SAMPLES);
  assert.equal(rows.some((row) => row.id === 's0'), false);
  assert.equal(rows.some((row) => row.chatId === 'limit-chat'), true);
});

test('out-of-order writes keep the read model sorted, including middle and head inserts', () => {
  const { dir } = makeStoreDir();
  const t = Date.now() - 86400000;
  [5000, 1000, 3000, 9000, 3000, 0].forEach((offset, i) => recordAt(dir, `ooo-${i}`, new Date(t + offset).toISOString()));
  const rows = readHarnessContextSamples({ dataDir: dir });
  assert.equal(rows.length, 6);
  assert.ok(isSorted(rows));
  assert.equal(rows[0].observedAt, new Date(t).toISOString());
});

test('compaction leaves one sorted line per id and a fully parseable file', () => {
  const { dir, file } = makeStoreDir();
  const t = Date.now() - 86400000;
  recordAt(dir, 'replaced-chat', new Date(t + 500).toISOString(), { measurementId: 'same' });
  for (let i = 0; i < 130; i++) recordAt(dir, `compact-${i}`, new Date(t + (i % 2 ? 100000 - i : i * 10)).toISOString());
  // Refine the first observation (same identity, different payload) after a compaction has run.
  recordAt(dir, 'replaced-chat', new Date(t + 500).toISOString(), { measurementId: 'same', usage: { inputTokens: 2000, totalTokens: 2200 } });
  for (let i = 0; i < 100; i++) recordAt(dir, `tail-${i}`, new Date(t + 200000 + i).toISOString());
  const rows = fileRows(file);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.ok(isSorted(rows));
  assert.equal(rows.filter((row) => row.chatId === 'replaced-chat').length, 1);
  assert.equal(rows.find((row) => row.chatId === 'replaced-chat').inputTokens, 2000);
  assert.deepEqual(readHarnessContextSamples({ dataDir: dir }).map((row) => row.id), rows.map((row) => row.id));
});

test('a duplicate id in a seeded file resolves to the last line, positioned by its own observedAt', () => {
  const { dir, file } = makeStoreDir();
  const t = Date.now() - 86400000;
  const at = (ms) => new Date(t + ms).toISOString();
  seedFile(file, [seedRow('dup', at(1000), { inputTokens: 1 }), seedRow('mid', at(2000)), seedRow('dup', at(3000), { inputTokens: 2 }), seedRow('low', at(500))]);
  const rows = readHarnessContextSamples({ dataDir: dir });
  assert.deepEqual(rows.map((row) => row.id), ['low', 'mid', 'dup']);
  assert.equal(rows[2].inputTokens, 2);
  assert.equal(rows[2].observedAt, at(3000));
});

test('an unsorted seeded file reads sorted (ties keep file order) and later writes land in the right place', () => {
  const { dir, file } = makeStoreDir();
  const t = Date.now() - 86400000;
  const at = (ms) => new Date(t + ms).toISOString();
  seedFile(file, [seedRow('c', at(3000)), seedRow('a', at(1000)), seedRow('t1', at(2000)), seedRow('t2', at(2000)), seedRow('b', at(1500))]);
  assert.deepEqual(readHarnessContextSamples({ dataDir: dir }).map((row) => row.id), ['a', 'b', 't1', 't2', 'c']);
  recordAt(dir, 'head', at(10));
  recordAt(dir, 'middle', at(2500));
  recordAt(dir, 'tie', at(2000));
  const rows = readHarnessContextSamples({ dataDir: dir });
  assert.ok(isSorted(rows));
  assert.equal(rows[0].chatId, 'head');
  const tieIndex = rows.findIndex((row) => row.chatId === 'tie');
  assert.equal(rows[tieIndex - 1].id, 't2'); // a new sample ends the group of equal timestamps
  assert.equal(rows[tieIndex + 1].chatId, 'middle');
});

test('a torn tail is repaired by the next write and survives compaction', () => {
  const { dir, file } = makeStoreDir();
  const t = Date.now() - 86400000;
  seedFile(file, [seedRow('keep', new Date(t).toISOString())]);
  fs.appendFileSync(file, '{"broken":');
  recordAt(dir, 'torn-a', new Date(t + 1000).toISOString());
  for (let i = 0; i < 100; i++) recordAt(dir, `torn-b-${i}`, new Date(t + 2000 + i).toISOString());
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.every((line) => { try { JSON.parse(line); return true; } catch { return false; } }));
  assert.ok(fileRows(file).some((row) => row.chatId === 'torn-a'));
});
