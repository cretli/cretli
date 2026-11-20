/**
 * End-to-end usage propagation: raw adapter payload -> room kernel (WS fan-out
 * and history records) -> history summary -> diagnostics occupancy. Guards that
 * provenance, scope, completeness, epoch and occupancy eligibility survive the
 * whole path, and that run totals are never read as the current prompt.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { summarizeChatHistoryUsage } from '../lib/persist/chat-history-usage.js';
import { assessHistoryCurrentPrompt } from '../lib/sdk/sdk-context-stats.ts';
import { advanceRoomContextEpoch } from '../lib/usage/context-restarts.ts';
import { stampUsageHistoryEvent } from '../lib/usage/usage-history-meta.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/usage/history/raw-usage-sdk-events.json', import.meta.url), 'utf8'));

function runThroughKernel(harness, events, roomOverrides = {}) {
  const persisted = [];
  const sent = [];
  const kernel = createAgentRoomKernel({
    transport: harness,
    persistHistory: (_room, items) => { persisted.push(...items.map((item) => item.rec)); },
    recordUsage: (partial) => partial,
    // The outgoing (post-stamp) payload is what WS clients receive.
    afterBroadcast: (_room, outgoing) => { sent.push(outgoing); },
  });
  const room = kernel.createRoomState({
    sessionKey: `${harness}-sess`, chatId: `${harness}-chat`, modelId: 'model-x', ...roomOverrides,
  });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });
  for (const event of events) {
    const apply = typeof event === 'function' ? event(room) : event;
    if (apply) kernel.broadcastRoom(room, { type: 'sdkEvent', event: apply });
  }
  return { kernel, room, persisted, sent };
}

async function historyOf(harness, events, overrides) {
  const out = runThroughKernel(harness, events, overrides);
  await out.kernel.flushPersistBuffer(out.room);
  const usage = out.persisted.filter((rec) => rec.kind === 'sdk' && /usage/.test(rec.event?.type));
  return { ...out, usage, summary: summarizeChatHistoryUsage(out.persisted.map((rec) => ({ rec }))) };
}

for (const [harness, { event, expect }] of Object.entries(fixtures.harnesses)) {
  test(`${harness}: raw usage reaches history with contract metadata`, async () => {
    const { usage, summary } = await historyOf(harness, [event]);
    assert.equal(usage.length, 1);
    const meta = usage[0].event.usageMeta;
    assert.ok(meta, 'usageMeta stamped before persistence');
    assert.equal(meta.provenance, expect.provenance);
    assert.equal(meta.granularity, expect.granularity);
    assert.equal(meta.measurementKind, expect.measurementKind);
    assert.equal(meta.accountingScope, 'own');
    assert.equal(meta.completeness, 'partial', 'a single usage event is never complete');
    assert.equal(meta.tokensPresent, true);
    assert.equal(meta.contextEpoch, 0);
    assert.equal(meta.contextEpochImplicit, true);
    assert.equal(meta.occupancy.eligible, false, 'a billing usage event is not an occupancy reading');
    assert.ok(meta.occupancy.reasons.includes('measurement_incomplete'));
    assert.deepEqual(usage[0].event.usage, event.usage, 'raw payload is not rewritten');
    assert.equal(summary.usageMeta.counts.withMeta, 1);
    assert.equal(summary.usageMeta.counts.legacy, 0);
    assert.equal(summary.usageMeta.currentPrompt, null);
    assert.equal(summary.usageMeta.lastUsageMeta.harness, harness);
  });
}

test('WS fan-out carries the same metadata as history', async () => {
  const event = fixtures.harnesses.claude.event;
  const { sent, usage } = await historyOf('claude', [event]);
  const wsEvent = sent.map((p) => p.event).find((e) => e?.type === 'usage');
  assert.ok(wsEvent, 'the usage event is fanned out to WS clients');
  assert.ok(wsEvent.usageMeta);
  assert.deepEqual(wsEvent.usageMeta, usage[0].event.usageMeta);
});

test('zero is a reported measurement, missing is not', () => {
  const room = { chatId: 'c', _runId: 'r' };
  const zero = stampUsageHistoryEvent(room, 'qwen', { type: 'usage', usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(zero.usageMeta.tokensPresent, true);
  assert.equal(zero.usageMeta.completeness, 'partial');
  const missing = stampUsageHistoryEvent(room, 'qwen', { type: 'usage', usage: null });
  assert.equal(missing.usageMeta.tokensPresent, false);
  assert.equal(missing.usageMeta.completeness, 'missing');
  const summary = summarizeChatHistoryUsage([{ rec: { kind: 'sdk', event: zero } }, { rec: { kind: 'sdk', event: missing } }]);
  assert.equal(summary.usageMeta.byScope.own.events, 2);
  assert.equal(summary.usageMeta.byScope.own.inputTokens, null, 'inputTokens never reported as a number stays null');
});

test('unsupported harness is marked unsupported with unknown provenance', () => {
  const out = stampUsageHistoryEvent({ chatId: 'c' }, 'other', { type: 'usage', usage: { inputTokens: 5 } });
  assert.equal(out.usageMeta.provenance, 'unknown');
  assert.equal(out.usageMeta.completeness, 'unsupported');
});

test('context_usage call snapshot is an eligible current prompt; session totals are ignored', async () => {
  const ctx = fixtures.contextUsage.codex;
  const { usage, summary } = await historyOf('codex', [ctx]);
  const meta = usage[0].event.usageMeta;
  assert.equal(meta.granularity, 'request');
  assert.equal(meta.occupancy.eligible, true);
  assert.equal(meta.occupancy.promptTokens, 1000, 'codex input already includes cache');
  const current = summary.usageMeta.currentPrompt;
  assert.equal(current.promptTokens, 1000);
  assert.notEqual(current.promptTokens, ctx.sessionUsage.inputTokens, 'cumulative session usage is not occupancy');
  const fresh = assessHistoryCurrentPrompt(summary.usageMeta, { now: Date.parse(ctx.observedAt) + 1000 });
  assert.equal(fresh.reliable, true);
  assert.equal(fresh.percent, Math.round((1000 / 258400) * 10000) / 100);
  const stale = assessHistoryCurrentPrompt(summary.usageMeta, { now: Date.parse(ctx.observedAt) + 60 * 60 * 1000 });
  assert.equal(stale.percent, null);
  assert.equal(stale.stale, true);
});

test('run totals after a snapshot do not become the current prompt', async () => {
  const { summary } = await historyOf('codex', [
    fixtures.contextUsage.codex,
    { ...fixtures.harnesses.codex.event },
  ]);
  assert.equal(summary.usageMeta.currentPrompt.promptTokens, 1000);
});

test('replayed events are counted once', async () => {
  const event = { ...fixtures.harnesses.deepseek.event, messageId: 'msg-1' };
  const { summary } = await historyOf('deepseek', [event, event, { ...event }]);
  assert.equal(summary.usageMeta.counts.total, 3);
  assert.equal(summary.usageMeta.counts.duplicates, 2);
  assert.equal(summary.usageMeta.byScope.own.events, 1);
  assert.equal(summary.usageMeta.byScope.own.inputTokens, 400);
});

test('consolidated child usage stays separate from own', async () => {
  const own = { ...fixtures.harnesses.deepseek.event, messageId: 'm-own' };
  const child = { ...fixtures.harnesses.deepseek.event, messageId: 'm-child', consolidated: true, childSessionId: 'child-1', model: 'child-model' };
  const { summary } = await historyOf('deepseek', [own, child]);
  assert.equal(summary.usageMeta.byScope.own.inputTokens, 400);
  assert.equal(summary.usageMeta.byScope.consolidated.inputTokens, 400);
  assert.equal(summary.usageMeta.byScope.consolidated.events, 1);
});

test('real path: epoch advance invalidates the snapshot; an event carrying an old epoch is late', async () => {
  const ctx = fixtures.contextUsage.codex;
  const { summary, room, usage } = await historyOf('codex', [
    ctx,
    (r) => { advanceRoomContextEpoch(r, 'compaction'); return null; },
    { ...ctx, measurementId: 'resp_fixture_2', usage: { ...ctx.usage, inputTokens: 300 } },
    // Delivered after the bump but explicitly measured in epoch 0.
    { ...ctx, measurementId: 'resp_late', contextEpoch: 0, usage: { ...ctx.usage, inputTokens: 777 } },
  ]);
  assert.equal(room._contextEpoch, 1);
  const metas = usage.map((rec) => rec.event.usageMeta);
  assert.equal(metas[0].contextEpochSource, 'room_implicit_zero');
  assert.equal(metas[1].contextEpoch, 1);
  assert.equal(metas[1].contextEpochSource, 'room_at_observation');
  assert.equal(metas[2].contextEpoch, 0, 'event epoch wins over the room epoch');
  assert.equal(metas[2].contextEpochSource, 'event');
  assert.equal(metas[2].occupancy.eligible, false);
  assert.ok(metas[2].occupancy.reasons.includes('context_epoch_old'));
  assert.equal(summary.usageMeta.latestContextEpoch, 1);
  assert.equal(summary.usageMeta.counts.lateEpoch, 1);
  assert.equal(summary.usageMeta.currentPrompt.promptTokens, 300);
  assert.equal(summary.usageMeta.currentPrompt.contextEpoch, 1);
});

test('a room-stamped epoch never claims lateness', () => {
  const ctx = fixtures.contextUsage.codex;
  const a = stampUsageHistoryEvent({ chatId: 'c', _contextEpoch: 2 }, 'codex', { ...ctx, measurementId: 'a' });
  const b = stampUsageHistoryEvent({ chatId: 'c', _contextEpoch: 1 }, 'codex', { ...ctx, measurementId: 'b' });
  const summary = summarizeChatHistoryUsage([a, b].map((event) => ({ rec: { kind: 'sdk', harness: 'codex', event } })));
  assert.equal(summary.usageMeta.counts.lateEpoch, 0);
});

test('own session and model changes clear the earlier current prompt', () => {
  const ctx = fixtures.contextUsage.codex;
  const stamp = (room, event) => ({ rec: { kind: 'sdk', harness: 'codex', event: stampUsageHistoryEvent(room, 'codex', event) } });
  const base = summarizeChatHistoryUsage([stamp({ chatId: 'c', _runId: 'r', sourceSessionId: 's1' }, ctx)]);
  assert.ok(base.usageMeta.currentPrompt);
  const model = summarizeChatHistoryUsage([
    stamp({ chatId: 'c', _runId: 'r', sourceSessionId: 's1' }, ctx),
    stamp({ chatId: 'c', _runId: 'r', sourceSessionId: 's1' }, { ...ctx, measurementId: 'm2', model: 'other-model', usage: { ...ctx.usage, inputTokens: 5 } }),
  ]);
  assert.equal(model.usageMeta.counts.modelChanges, 1);
  assert.equal(model.usageMeta.currentPrompt.model, 'other-model');
});

test('an own session change clears the earlier current prompt', () => {
  const ctx = fixtures.contextUsage.codex;
  const stamp = (session, id) => ({ rec: { kind: 'sdk', harness: 'codex', event: stampUsageHistoryEvent({ chatId: 'c', _runId: 'r', sourceSessionId: session }, 'codex', { ...ctx, measurementId: id }) } });
  const summary = summarizeChatHistoryUsage([stamp('s1', 'a'), stamp('s2', 'b')]);
  assert.equal(summary.usageMeta.counts.sessionChanges, 1);
  assert.equal(summary.usageMeta.currentPrompt.sourceSessionId, 's2');
  const only = summarizeChatHistoryUsage([stamp('s1', 'a')]);
  assert.equal(only.usageMeta.currentPrompt.sourceSessionId, 's1');
});

test('child (consolidated), late and billing events do not clear the parent prompt or inflate change counters', async () => {
  const ctx = fixtures.contextUsage.codex;
  const { summary } = await historyOf('codex', [
    ctx,
    (r) => { advanceRoomContextEpoch(r, 'compaction'); return null; },
    { ...ctx, measurementId: 'own-2' },
    { ...ctx, measurementId: 'child-1', consolidated: true, model: 'child-model', usage: { ...ctx.usage, inputTokens: 50 } },
    { ...ctx, measurementId: 'late-1', contextEpoch: 0, model: 'old-model' },
    { type: 'usage', usage: { input_tokens: 9, output_tokens: 1 }, lastCallModel: 'billing-model', final: true },
  ]);
  const meta = summary.usageMeta;
  assert.equal(meta.counts.lateEpoch, 1);
  assert.equal(meta.counts.modelChanges, 0);
  assert.equal(meta.counts.sessionChanges, 0);
  assert.equal(meta.currentPrompt.contextEpoch, 1);
  assert.equal(meta.currentPrompt.promptTokens, 1000, 'parent snapshot survives');
  assert.equal(meta.currentPrompt.model, 'codex-model-x');
  assert.equal(meta.lastUsageMeta.accountingScope, 'own');
});

test('late event from an old session/model does not clear the parent prompt', () => {
  const ctx = fixtures.contextUsage.codex;
  const own = stampUsageHistoryEvent({ chatId: 'c', _contextEpoch: 1, sourceSessionId: 's2' }, 'codex', { ...ctx, measurementId: 'x1' });
  const late = stampUsageHistoryEvent({ chatId: 'c', _contextEpoch: 1, sourceSessionId: 's1' }, 'codex', { ...ctx, measurementId: 'x2', contextEpoch: 0, model: 'old-model' });
  const summary = summarizeChatHistoryUsage([own, late].map((event) => ({ rec: { kind: 'sdk', harness: 'codex', event } })));
  assert.equal(summary.usageMeta.counts.lateEpoch, 1);
  assert.equal(summary.usageMeta.counts.sessionChanges, 0);
  assert.equal(summary.usageMeta.counts.modelChanges, 0);
  assert.ok(summary.usageMeta.currentPrompt);
});

test('replay dedupe is limited to usageMeta; legacy summary fields still see every event', async () => {
  const a = { ...fixtures.harnesses.deepseek.event, messageId: 'msg-1' };
  const b = { type: 'usage', usage: { inputTokens: 900, outputTokens: 5, cacheReadTokens: 0 }, messageId: 'msg-2' };
  const { summary } = await historyOf('deepseek', [a, b, a]);
  assert.equal(summary.usageMeta.counts.duplicates, 1);
  assert.equal(summary.usageMeta.byScope.own.events, 2);
  assert.equal(summary.lastUsageInputTokens, 400, 'the replay is still the last usage event');
  assert.equal(summary.maxUsageInputTokens, 900);
});

test('several usage events sharing one turn id are not collapsed (message granularity)', async () => {
  const mk = (n) => ({ type: 'usage', turnId: 'turn-1', usage: { inputTokens: n, outputTokens: 1, cacheReadTokens: 0 } });
  const { summary, usage } = await historyOf('deepseek', [mk(100), mk(200), mk(300)]);
  assert.equal(usage[0].event.usageMeta.identityClass, 'none');
  assert.equal(summary.usageMeta.counts.duplicates, 0);
  assert.equal(summary.usageMeta.byScope.own.events, 3);
  assert.equal(summary.usageMeta.byScope.own.inputTokens, 600);
  assert.equal(summary.lastUsageInputTokens, 300);
});

test('a turn-granularity harness keeps the turn id as identity', () => {
  const out = stampUsageHistoryEvent({ chatId: 'c', _runId: 'r', sourceSessionId: 's' }, 'codex', { type: 'usage', turnId: 't-1', usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(out.usageMeta.identityClass, 'durable_sequence');
});

test('claude context observations are not persisted as usage history (no sdkEvent context_usage shape)', async () => {
  const out = runThroughKernel('claude', []);
  out.kernel.broadcastRoom(out.room, { type: 'sdkContextUsage', usage: { inputTokens: 10 }, model: 'claude-model-x' });
  await out.kernel.flushPersistBuffer(out.room);
  assert.equal(out.persisted.filter((rec) => /usage/.test(rec.event?.type || '')).length, 0);
});

test('legacy events are labelled from the metadata actually available', () => {
  const summary = summarizeChatHistoryUsage([
    { rec: { kind: 'sdk', harness: 'qwen', createdAt: '2025-12-01T00:00:00.000Z', event: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } } } },
  ]);
  assert.equal(summary.usageMeta.counts.legacy, 1);
  const meta = summary.usageMeta.lastUsageMeta;
  assert.equal(meta.legacy, true);
  assert.equal(meta.harness, 'qwen');
  assert.equal(meta.observedAt, '2025-12-01T00:00:00.000Z');
  assert.equal(meta.provenance, null, 'no provenance is invented');
  assert.equal(meta.contextEpoch, null);
  assert.deepEqual(meta.occupancy.reasons, ['legacy_no_metadata']);
  assert.equal(summary.usageMeta.currentPrompt, null);
  assert.equal(summary.lastUsageInputTokens, 7, 'legacy numeric summary fields keep working');
});

test('stamping is idempotent for a replayed, already stamped event', () => {
  const once = stampUsageHistoryEvent({ chatId: 'c' }, 'qwen', { type: 'usage', usage: { input_tokens: 1 } });
  assert.equal(stampUsageHistoryEvent({ chatId: 'c', _contextEpoch: 9 }, 'qwen', once), once);
});
