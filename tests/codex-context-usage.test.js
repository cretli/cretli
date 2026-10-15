import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCodexContextUsage, readCodexContextUsage, watchCodexContextUsage } from '../lib/codex/codex-context-usage.js';
import { applyCodexMeasuredContextUsage, buildChatContextSnapshot, resetChatContextMeterState } from '../app_front/features/chat/chatContextMeter.js';
import { createChatDiagnostics } from '../app_front/features/chat/chatDiagnostics.js';
import { buildContextPressureAssessment } from '../lib/sdk/sdk-context-advisory.js';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { summarizeChatHistoryUsage } from '../lib/persist/chat-history-persist.js';

const model = { type: 'turn_context', payload: { model: 'codex-test' } };
const measurement = (input = 40000, timestamp = '2026-10-14T12:00:00Z') => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: 9000000, total_tokens: 9500000 },
  last_token_usage: { input_tokens: input, cached_input_tokens: input - 1000, output_tokens: 1000, total_tokens: input + 1000 },
  model_context_window: 100000,
} } });
const jsonl = (...rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

test('latest call context includes cache; cumulative billing tokens are not occupancy', () => {
  const event = parseCodexContextUsage(jsonl(model, measurement()));
  assert.deepEqual(event.usage, { inputTokens: 40000, outputTokens: 1000, totalTokens: 41000, cacheReadTokens: 39000 });
  assert.equal(event.contextWindowTokens, 100000);
  const chat = { agentTransport: 'codex', model: 'codex-test', _contextFillPercent: 95, _contextPeakFillPercent: 99 };
  assert.equal(applyCodexMeasuredContextUsage(chat, event), true);
  const snapshot = buildChatContextSnapshot(chat);
  assert.equal(snapshot.fillPercent, 41);
  assert.equal(snapshot.peakFillPercent, 41);
  assert.equal(snapshot.inputTokens, 40000);
  assert.equal(snapshot.outputTokens, 1000);
  assert.equal(snapshot.totalTokens, 41000);
  assert.equal(snapshot.contextWindowTokens, 100000);
  assert.equal(snapshot.source, 'codex-measured');
  assert.equal(snapshot.isEstimated, false);
});

test('compaction clears measurement; repeated/stale readings cannot restore pre-compaction context', () => {
  const chat = { agentTransport: 'codex', _buffer: 'old conversation'.repeat(1000) };
  const first = parseCodexContextUsage(jsonl(model, measurement()));
  applyCodexMeasuredContextUsage(chat, first);
  const reset = parseCodexContextUsage(jsonl(measurement(), { type: 'compacted', timestamp: '2026-10-14T12:01:00Z' }));
  assert.equal(applyCodexMeasuredContextUsage(chat, reset), true);
  const epoch = chat._contextMeterEpoch;
  assert.equal(buildChatContextSnapshot(chat).fillProvenance, 'none');
  assert.equal(applyCodexMeasuredContextUsage(chat, reset), false);
  assert.equal(chat._contextMeterEpoch, epoch);
  assert.equal(applyCodexMeasuredContextUsage(chat, first), false);
  applyCodexMeasuredContextUsage(chat, parseCodexContextUsage(jsonl(model, measurement(8000, '2026-10-14T12:02:00Z'))));
  assert.equal(buildChatContextSnapshot(chat).fillPercent, 9);
  resetChatContextMeterState(chat, { markFreshSession: true });
  assert.equal(buildChatContextSnapshot(chat).fillProvenance, 'none');
});

test('Codex turn totals alone do not become measured context', () => {
  const chat = { agentTransport: 'codex', _contextUsageInputTokens: 9000000, _buffer: 'a'.repeat(4000) };
  const snapshot = buildChatContextSnapshot(chat);
  assert.equal(snapshot.isEstimated, true);
  assert.equal(snapshot.inputTokens, 1000);
});

test('unknown window stays unknown; invalid and missing counters are not fabricated', () => {
  const record = measurement();
  delete record.payload.info.model_context_window;
  const event = parseCodexContextUsage(jsonl(model, record));
  const chat = { agentTransport: 'codex' };
  applyCodexMeasuredContextUsage(chat, event);
  assert.equal(buildChatContextSnapshot(chat).contextWindowTokens, null);
  assert.equal(buildChatContextSnapshot(chat).fillPercent, null);
  record.payload.info.last_token_usage.input_tokens = null;
  assert.equal(parseCodexContextUsage(jsonl(record)), null);
  assert.equal(parseCodexContextUsage(jsonl({ type: 'event_msg', payload: { type: 'token_count', info: null } })), null);
});

test('bounded session tail ignores partial lines, selects root session and deduplicates polls', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codex-context-'));
  try {
    const folder = path.join(homeDir, 'sessions', '2026', '10');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'rollout-root.jsonl');
    fs.writeFileSync(file, 'x'.repeat(600000) + '\n' + jsonl(model, measurement()) + '{"type":');
    fs.writeFileSync(path.join(folder, 'rollout-child.jsonl'), jsonl(model, measurement(90000)));
    assert.equal(readCodexContextUsage({ homeDir, threadId: 'root' }).usage.totalTokens, 41000);
    const events = [];
    const watcher = watchCodexContextUsage({ homeDir, getThreadId: () => 'root', getModel: () => 'fallback', onUsage: (event) => events.push(event) });
    watcher.poll();
    watcher.poll();
    assert.equal(events.length, 1);
    fs.writeFileSync(file, jsonl(model, measurement(8000, '2026-10-14T12:02:00Z')));
    watcher.stop();
    assert.equal(events.length, 2);
    assert.equal(events[1].usage.totalTokens, 9000);
    assert.equal(readCodexContextUsage({ homeDir, threadId: 'absent' }), null);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('context telemetry survives billing events in persisted diagnostics and resets after compaction', () => {
  const event = parseCodexContextUsage(jsonl(model, measurement()));
  const events = [event, { type: 'usage', usage: { inputTokens: 9000000 } }].map((row) => ({ rec: { kind: 'sdk', harness: 'codex', event: row } }));
  const stats = summarizeChatHistoryUsage(events);
  assert.equal(stats.lastCallContextTokens, 41000);
  assert.equal(stats.lastCallContextWindowTokens, 100000);
  assert.equal(stats.lastUsageInputTokens, 9000000);
  events.push({ rec: { kind: 'sdk', harness: 'codex', event: { type: 'context_usage', reset: true } } });
  assert.equal(summarizeChatHistoryUsage(events).lastCallContextTokens, null);
});


test('root context events reach live clients and history without billing token duplication', () => {
  const persisted = [];
  const billed = [];
  const sent = [];
  const kernel = createAgentRoomKernel({ transport: 'codex', persistHistory: (_room, rows) => persisted.push(...rows), recordUsage: (row) => billed.push(row) });
  const room = kernel.createRoomState({ sessionKey: 'context-test', chatId: 'context-test' });
  room.clients.add({ readyState: 1, bufferedAmount: 0, send: (text) => sent.push(JSON.parse(text)) });
  const event = parseCodexContextUsage(jsonl(model, measurement()));
  kernel.broadcastRoom(room, { type: 'sdkEvent', event });
  kernel.flushPersistBuffer(room);
  assert.equal(sent[0].event.usage.totalTokens, 41000);
  assert.equal(persisted[0].rec.harness, 'codex');
  assert.equal(summarizeChatHistoryUsage(persisted).lastCallContextTokens, 41000);
  assert.equal(billed.length, 0);
});


test('Codex context sync hydrates measured occupancy without opening diagnostics', async () => {
  const event = parseCodexContextUsage(jsonl(model, measurement()));
  const chat = { id: 'context-test', agentTransport: 'codex' };
  let updates = 0;
  const diagnostics = createChatDiagnostics({ api: { getChatDiag: async () => ({ ok: true, contextStats: { codex: event } }) }, getActiveChatId: () => chat.id, updateChatContextMeter: () => { updates += 1; }, resolveContextMeterModelId: () => 'codex-test' });
  diagnostics.startChatContextUsageSync(chat);
  await Promise.resolve();
  diagnostics.stopChatContextUsageSync(chat);
  assert.equal(updates, 1);
  assert.equal(buildChatContextSnapshot(chat).fillPercent, 41);
});

test('pressure assessment uses the reported CLI window and measured last call', () => {
  const pressure = buildContextPressureAssessment({ modelId: 'unknown-test', contextWindowTokens: 100000, lastUsageInputTokens: 90000 });
  assert.equal(pressure.contextFillPercent, 90);
  assert.ok(pressure.warnings.includes('context_fill_high'));
});


test('provider response identity survives repeated token notices and richer counters are preserved', () => {
  const record = { type: 'token_usage_record', timestamp: '2026-10-14T12:00:00Z', payload: { response_id: 'response-1', turn_id: 'turn-1', usage: { input_tokens: 40000, cached_input_tokens: 39000, cache_write_input_tokens: 1000, output_tokens: 1000, reasoning_output_tokens: 500, total_tokens: 41000 } } };
  const notice = measurement(40000, '2026-10-14T12:01:00Z');
  const event = parseCodexContextUsage(jsonl(model, record, notice, { ...notice, timestamp: '2026-10-14T12:02:00Z' }));
  assert.equal(event.measurementId, 'response-1');
  assert.equal(event.turnId, 'turn-1');
  assert.equal(event.observedAt, record.timestamp);
  assert.equal(event.usage.cacheWriteTokens, 1000);
  assert.equal(event.usage.reasoningTokens, 500);
  assert.equal(event.contextWindowTokens, 100000);
});

test('a token_count right after a compacted record keeps the compaction marker', () => {
  const compactedAt = '2026-10-14T12:01:00Z';
  const usage = parseCodexContextUsage(jsonl(model, measurement(), { type: 'compacted', timestamp: compactedAt }, measurement(0, '2026-10-14T12:01:00.01Z')));
  assert.equal(usage.compactedAt, compactedAt);
  assert.notEqual(usage.reset, true);
});
