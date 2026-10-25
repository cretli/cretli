/**
 * Diagnostics read path: raw usage payload -> room kernel -> durable chat history
 * -> collectChatHistoryContextStats (the data behind GET /api/chats/:id/diag).
 * Paths resolve at import time, so the scratch data dir is set before any import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-usage-diag-'));
process.env.CRETLI_DATA_DIR = dataDir;

const { createAgentRoomKernel } = await import('../lib/agent-harness/room-kernel.ts');
const { appendChatHistoryEvents } = await import('../lib/persist/chat-history-persist.js');
const { loadChatHistory } = await import('../lib/persist/chat-history-service.js');
const { collectChatHistoryContextStats } = await import('../lib/sdk/sdk-context-stats.ts');
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/usage/history/raw-usage-sdk-events.json', import.meta.url), 'utf8'));

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('diag stats carry usageMeta and re-assess the current prompt at read time', async () => {
  const persisted = [];
  const kernel = createAgentRoomKernel({
    transport: 'codex',
    persistHistory: (_room, items) => { persisted.push(...items.map((item) => item.rec)); },
    recordUsage: (partial) => partial,
  });
  const room = kernel.createRoomState({ sessionKey: 'codex-sess', chatId: 'diag-chat', modelId: 'model-x' });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });
  kernel.broadcastRoom(room, { type: 'sdkEvent', event: fixtures.contextUsage.codex });
  await kernel.flushPersistBuffer(room);
  appendChatHistoryEvents('diag-chat', 'codex-sess', persisted.map((rec) => ({ rec })));

  const stats = await collectChatHistoryContextStats('diag-chat');
  assert.equal(stats.usageMeta.currentPrompt.promptTokens, 1000);
  assert.equal(stats.usageMeta.counts.withMeta, 1);
  assert.equal(stats.usageMeta.currentPrompt.provenance, 'reported');
  // Observed in 2026 and read now: stale, so no percent but a last-known value.
  assert.equal(stats.currentPromptOccupancy.percent, null);
  assert.equal(stats.currentPromptOccupancy.stale, true);
  assert.equal(stats.currentPromptOccupancy.lastKnown.promptTokens, 1000);
});

test('diag stats for an unknown chat have no usageMeta', async () => {
  const stats = await collectChatHistoryContextStats('missing-chat');
  assert.equal(stats.usageMeta, null);
  assert.equal(stats.currentPromptOccupancy, null);
});

test('diag stats from the read model match the full-history derivation', async () => {
  appendChatHistoryEvents('cmp-chat', 'cmp-sess', [
    { rec: { type: 'localUser', text: 'hi' } },
    { rec: { type: 'sdkEvent', event: { type: 'assistant' } } },
    { rec: { type: 'sdkEvent', event: { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } } } },
  ]);
  const doc = await loadChatHistory('cmp-chat');
  const stats = await collectChatHistoryContextStats('cmp-chat');
  assert.equal(stats.storedEvents, doc.events.length);
  assert.equal(stats.headSeq, doc.headSeq);
  assert.equal(stats.updatedAt, doc.updatedAt);
  assert.equal(stats.localUserCount, doc.usageSummary.localUserCount);
  assert.equal(stats.sdkEventCount, doc.usageSummary.sdkEventCount);
  assert.equal(stats.lastUsageInputTokens, doc.usageSummary.lastUsageInputTokens ?? null);
});
