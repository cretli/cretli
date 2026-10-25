/**
 * Live context-measurement matrix: one fixture per harness (11) through the real
 * room kernel -> history summary path. Guards that occupancy is the latest prompt
 * snapshot (never summed), out-of-order measurements are rejected by epoch and by
 * adapter time, reset/resume/model change invalidate the measurement, and a
 * harness without a snapshot is marked `estimated`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { summarizeChatHistoryUsage } from '../lib/persist/chat-history-usage.js';
import { recordContextRestart } from '../lib/usage/context-restarts.ts';
import { resolveWindowSemantics } from '../lib/usage/usage-contract.js';
import { buildUsageHistoryMeta } from '../lib/usage/usage-history-meta.ts';

const HARNESSES = ['sdk', 'claude', 'codex', 'deepseek', 'qwen', 'opencode', 'codebuddy', 'openrouter', 'mistral', 'zai', 'mimo'];

/** Raw `context_usage` fixture of one harness; cache is reported so semantics matter. */
function snapshot(harness, id, inputTokens, extra = {}) {
  return {
    type: 'context_usage',
    source: `${harness}-fixture`,
    model: 'model-a',
    usage: { inputTokens, outputTokens: 5, totalTokens: inputTokens + 5, cacheReadTokens: 20 },
    contextWindowTokens: 200000,
    measurementId: `${harness}-${id}`,
    sessionUsage: { inputTokens: 999999, outputTokens: 9999 },
    ...extra,
  };
}

/** Prompt size the contract assigns to `inputTokens` with the fixture's 20 cached tokens. */
function expectedPrompt(harness, inputTokens) {
  return resolveWindowSemantics(harness) === 'disjoint' ? inputTokens + 20 : inputTokens;
}

async function run(harness, steps, roomOverrides = {}) {
  const persisted = [];
  const kernel = createAgentRoomKernel({
    transport: harness,
    persistHistory: (_room, items) => { persisted.push(...items.map((item) => item.rec)); },
    recordUsage: (partial) => partial,
  });
  const room = kernel.createRoomState({
    sessionKey: `${harness}-sess`, chatId: `${harness}-chat`, modelId: 'model-a', sourceSessionId: 's1', ...roomOverrides,
  });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });
  for (const step of steps) {
    const event = typeof step === 'function' ? step(room) : step;
    if (event) kernel.broadcastRoom(room, { type: 'sdkEvent', event });
  }
  await kernel.flushPersistBuffer(room);
  const summary = summarizeChatHistoryUsage(persisted.map((rec) => ({ rec })));
  return { room, summary, current: summary.usageMeta.currentPrompt, counts: summary.usageMeta.counts };
}

for (const harness of HARNESSES) {
  test(`${harness}: occupancy is the latest prompt snapshot, never a sum`, async () => {
    const { current } = await run(harness, [snapshot(harness, 'a', 100), snapshot(harness, 'b', 250)]);
    assert.ok(current, 'eligible snapshot becomes currentPrompt');
    assert.equal(current.promptTokens, expectedPrompt(harness, 250));
    assert.equal(current.limitTokens, 200000);
  });

  test(`${harness}: out-of-order snapshots are rejected by epoch and by adapter time`, async () => {
    const byEpoch = await run(harness, [
      snapshot(harness, 'a', 100),
      (room) => { room._contextEpoch = 2; return snapshot(harness, 'b', 300); },
      snapshot(harness, 'late', 777, { contextEpoch: 1 }),
    ]);
    assert.equal(byEpoch.counts.lateEpoch, 1);
    assert.equal(byEpoch.current.promptTokens, expectedPrompt(harness, 300));

    const byTime = await run(harness, [
      snapshot(harness, 'a', 100, { sourceObservedAt: '2026-01-01T00:00:10.000Z' }),
      snapshot(harness, 'b', 300, { sourceObservedAt: '2026-01-01T00:00:20.000Z' }),
      snapshot(harness, 'late', 777, { sourceObservedAt: '2026-01-01T00:00:05.000Z' }),
    ]);
    assert.equal(byTime.counts.lateTime, 1);
    assert.equal(byTime.current.promptTokens, expectedPrompt(harness, 300));
  });

  test(`${harness}: reset, resume and model change invalidate the earlier measurement`, async () => {
    const reset = await run(harness, [
      snapshot(harness, 'a', 100),
      (room) => { recordContextRestart({ chatId: room.chatId, harness, reason: 'session_drop', room }); return null; },
      snapshot(harness, 'b', 40),
      // Delivered after the reset but measured before it.
      snapshot(harness, 'late', 777, { contextEpoch: 0 }),
    ]);
    assert.equal(reset.room._contextEpoch, 1, 'a dropped session advances the epoch');
    assert.equal(reset.counts.lateEpoch, 1);
    assert.equal(reset.current.contextEpoch, 1, 'the pre-reset snapshot is superseded');
    assert.equal(reset.current.promptTokens, expectedPrompt(harness, 40));

    const model = await run(harness, [
      snapshot(harness, 'a', 100),
      snapshot(harness, 'b', 150, { model: 'model-b' }),
    ]);
    assert.equal(model.room._contextEpoch, 1, 'model change advances the epoch');
    assert.equal(model.current.promptTokens, expectedPrompt(harness, 150));
    assert.equal(model.current.contextEpoch, 1);

    const resume = await run(harness, [
      snapshot(harness, 'a', 100),
      (room) => { room._runSourceSessionId = 's2'; return snapshot(harness, 'b', 90); },
    ]);
    assert.equal(resume.room._contextEpoch, 1, 'a resumed (new) session advances the epoch');
    assert.equal(resume.current.promptTokens, expectedPrompt(harness, 90));
  });

  test(`${harness}: a model change seen only on a billing usage event still advances the epoch`, async () => {
    const { room } = await run(harness, [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 }, model: 'model-a' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 }, model: 'model-b' },
    ]);
    assert.equal(room._contextEpoch, 1);
  });

  test(`${harness}: no snapshot means estimated, never occupancy`, async () => {
    const billing = await run(harness, [{ type: 'usage', usage: { inputTokens: 500, outputTokens: 5 } }]);
    assert.equal(billing.current, null);
    assert.equal(billing.summary.usageMeta.occupancySource, 'estimated');

    const meta = buildUsageHistoryMeta({ chatId: 'c' }, harness, { type: 'usage' });
    assert.equal(meta.occupancy.source, 'estimated');
    assert.equal(meta.occupancy.eligible, false);
    assert.equal(meta.tokensPresent, false);
  });
}

// Harnesses whose adapter emits only billing-shaped `usage` events (no per-call
// `context_usage`): their raw per-harness shapes come from the shared fixture.
const rawFixtures = JSON.parse(readFileSync(new URL('./fixtures/usage/history/raw-usage-sdk-events.json', import.meta.url), 'utf8'));
const NO_SNAPSHOT_HARNESSES = ['sdk', 'deepseek', 'qwen', 'opencode', 'codebuddy', 'openrouter', 'mistral', 'zai', 'mimo'];

for (const harness of NO_SNAPSHOT_HARNESSES) {
  test(`${harness}: adapter usage fixture is estimated, never eligible, never currentPrompt, deltas not summed`, async () => {
    const raw = rawFixtures.harnesses[harness].event;
    const out = await run(harness, [
      { ...raw, usage: { ...raw.usage } },
      { ...raw, usage: { ...raw.usage }, lastCallModel: undefined },
    ]);
    const metas = out.summary.usageMeta;
    assert.equal(metas.counts.total, 2);
    assert.equal(metas.currentPrompt, null, 'billing usage never becomes the current prompt');
    assert.equal(metas.occupancySource, 'estimated');
    assert.equal(metas.lastUsageMeta.occupancy.source, 'estimated');
    assert.equal(metas.lastUsageMeta.occupancy.eligible, false);
    assert.equal(metas.lastUsageMeta.tokensPresent, true, 'the fixture really carries tokens');

    // Two identical events must not accumulate into the estimate.
    const first = buildUsageHistoryMeta({ chatId: 'c' }, harness, raw);
    assert.equal(first.occupancy.source, 'estimated');
    assert.equal(first.occupancy.eligible, false);
    assert.equal(metas.lastUsageMeta.occupancy.promptTokens, first.occupancy.promptTokens);
  });
}
